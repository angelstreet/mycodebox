// V2 HTTP handlers (orchestration/http.js) driven directly, no server. T20 server-side half, GL01 (UI intake), GL09
// (approval is explicit and never blanket), T22 (unknown usage stays null).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createIntake } from '../orchestration/intake.js';
import { createV2Http } from '../orchestration/http.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const DEV = { role: 'developer', id: 'dev-1' };
const POLICY = { ok: true, policy: { project_id: 'fixture-project', test_command: ['npm', 'test'] } };

function setup() {
  const store = createTaskStore({ dir: mkdtempSync(join(tmpdir(), 'v2-http-')), ...clock() });
  const intake = createIntake({ store, loadPolicy: () => POLICY, resolveSha: () => SHA_A });
  const api = createV2Http({ store, intake });
  const call = (method, pathname, body) => api.handle({ method, pathname, readBody: async () => body });
  return { store, api, call };
}
const decision = (id, over = {}) => ({
  decision_id: `d-${id}`, kind: 'policy_gate', question: 'Can it proceed?', alternatives: [{ option: 'ask the owner', pros: ['safe'], cons: ['slow'] }],
  chosen: 'ask the owner', evidence: ['policy blocks deploy'], expected_effect: 'awaiting_approval', rationale: 'mandatory owner decision',
  actor: { role: 'manager', runtime: null, model: null }, reversible: true, rollback: 'cancel the task', ...over });
async function askOwner(store, id, over = {}) {
  const k = (await store.get(id)).history.length;
  const req = { k, kind: 'policy_gate', question: 'Deploy to staging?', classes: ['deploy'], resume_to: 'ready', ...over };
  await store.recordDecision(id, decision(id, { loop: { k, patch: { approval: req } } }));
  await store.transition(id, 'awaiting_approval', { reason: req.question, actor: 'goal-loop' });
  return req;
}

test('non-V2 paths fall through (null), unknown methods are 405, bad ids 400', async () => {
  const { call } = setup();
  assert.equal(await call('GET', '/api/sessions'), null);
  assert.equal(await call('GET', '/api/v2/other'), null);
  assert.equal((await call('DELETE', '/api/v2/tasks/x')).status, 405);
  assert.equal((await call('GET', '/api/v2/tasks/..%2fetc')).status, 400);
  assert.equal((await call('GET', '/api/v2/tasks/..')).status, 400);
  assert.equal((await call('GET', '/api/v2/tasks/nope')).status, 404);
});

test('list: state, outcome, goal summary, next action; only accepted is done', async () => {
  const { store, call } = setup();
  const a = await store.createTask(spec());
  const b = await store.createTask(spec({ goal: 'x'.repeat(500) }));
  await store.transition(b.task_id, 'waiting', { reason: 'quota' });
  const r = await call('GET', '/api/v2/tasks');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.body.tasks.map((t) => [t.task_id, t]));
  assert.deepEqual([byId[a.task_id].state, byId[a.task_id].outcome], ['created', 'not_yet_done']);
  assert.deepEqual([byId[b.task_id].state, byId[b.task_id].outcome], ['waiting', 'waiting']);
  assert.ok(byId[b.task_id].goal.length <= 200);
  assert.match(byId[a.task_id].next_action, /goal loop/);
  assert.ok(r.body.tasks.every((t) => t.outcome !== 'done'));
});

test('detail: checks with latest evidence and SHA, stale evidence is not passing, usage null stays null (T22)', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await store.setHead(id, SHA_A, { actor: DEV });
  await store.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, duration_ms: 1200, actor: { role: 'tester', id: 't1' } });
  await store.setHead(id, SHA_B, { actor: DEV });   // a new head: the old evidence no longer counts
  await store.recordVerdict(id, { sha: SHA_B, actor: { role: 'verifier', id: 'rev-1' }, verdict: 'reject', findings: ['missing test'] });
  await store.recordUsage(id, { runtime: 'claude', model: 'm1', input_tokens: 10, output_tokens: null, usd: null, run_id: 'r1' });
  await store.recordDecision(id, decision(id));
  const t = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  const unit = t.acceptance_checks.find((c) => c.id === 'unit');
  assert.equal(unit.latest_evidence.sha, SHA_A);
  assert.equal(unit.latest_evidence.on_head, false);
  assert.equal(unit.status, 'stale_sha');
  assert.equal(t.acceptance_checks.find((c) => c.id === 'lint').status, 'no_evidence');
  assert.equal(t.head_sha, SHA_B);
  assert.deepEqual(t.verdicts.map((v) => [v.verdict, v.current]), [['reject', true]]);
  assert.equal(t.usage.usd, null);
  assert.equal(t.usage.output_tokens, null);
  assert.equal(t.usage.records[0].usd, null);
  assert.ok(t.usage.unknown.includes('usd'));
  assert.equal(t.decisions[0].rationale, 'mandatory owner decision');
  assert.equal(t.outcome, 'not_yet_done');
  assert.equal(JSON.stringify(t).includes('"loop"'), false, 'loop memory is internal');
  // passing on the current head
  await store.recordEvidence(id, { check_id: 'unit', sha: SHA_B, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't1' } });
  const u2 = (await call('GET', `/api/v2/tasks/${id}`)).body.task.acceptance_checks.find((c) => c.id === 'unit');
  assert.equal(u2.status, 'passing_on_head');
});

test('create: UI source goes through intake, same contract; strict body; idempotent', async () => {
  const { store, call } = setup();
  const r = await call('POST', '/api/v2/tasks', { goal: 'Fix the synthetic bug', repository: '/srv/fake-repo', idempotency_key: 'k-1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = await store.get(r.body.task.task_id);
  assert.deepEqual(t.created_by, { kind: 'ui', id: 'owner' });
  assert.equal(t.status, 'created');
  assert.ok(t.acceptance_checks.some((c) => c.required), 'goal contract: default required check');
  assert.ok(r.body.defaults_applied.includes('acceptance_checks'));
  const again = await call('POST', '/api/v2/tasks', { goal: 'Fix the synthetic bug', repository: '/srv/fake-repo', idempotency_key: 'k-1' });
  assert.equal(again.body.task.task_id, t.task_id);
  assert.equal((await store.list()).length, 1);
  for (const bad of [{}, { goal: '' }, { goal: 'g', status: 'accepted' }, { goal: 'g', created_by: { kind: 'api', id: 'x' } },
    { goal: 'g', repository: 'relative' }, { goal: 'g', task_id: '../x' }, { goal: 'g', base_sha: 'zz' }, { goal: 'g', template: 'nope' }, [], 'str']) {
    assert.equal((await call('POST', '/api/v2/tasks', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/api/v2/tasks', { goal: 'g'.repeat(100), repository: '/x', acceptance_checks: Array(60).fill({}) })).status, 400);
  assert.equal((await call('POST', '/api/v2/tasks', { goal: 'x'.repeat(70000), repository: '/x' })).status, 413);
  assert.equal((await store.list()).length, 1, 'nothing recorded by rejected requests');
});

test('create without repository policy and checks is refused with E_INTAKE_NEEDS_CHECKS', async () => {
  const store = createTaskStore({ dir: mkdtempSync(join(tmpdir(), 'v2-http-')), ...clock() });
  const api = createV2Http({ store, intake: createIntake({ store, loadPolicy: () => ({ ok: false }), resolveSha: () => SHA_A }) });
  const r = await api.handle({ method: 'POST', pathname: '/api/v2/tasks', readBody: async () => ({ goal: 'g', repository: '/x' }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'E_INTAKE_NEEDS_CHECKS');
});

test('readBody failures: bad JSON 400, too large 413', async () => {
  const { api } = setup();
  const h = (e) => api.handle({ method: 'POST', pathname: '/api/v2/tasks', readBody: async () => { throw e; } });
  assert.equal((await h(new SyntaxError('x'))).status, 400);
  assert.equal((await h(Object.assign(new Error('big'), { status: 413 }))).status, 413);
});

test('cancel: recorded as owner, terminal tasks refuse', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  assert.equal((await call('POST', `/api/v2/tasks/${id}/cancel`, { reason: 5 })).status, 400);
  assert.equal((await call('POST', `/api/v2/tasks/${id}/cancel`, { x: 1 })).status, 400);
  const r = await call('POST', `/api/v2/tasks/${id}/cancel`, { reason: 'no longer needed' });
  assert.deepEqual([r.status, r.body.state, r.body.outcome], [200, 'cancelled', 'cancelled']);
  assert.equal((await store.get(id)).history.at(-1).actor, 'owner');
  assert.equal((await call('POST', `/api/v2/tasks/${id}/cancel`, {})).status, 409);
  assert.equal((await call('POST', '/api/v2/tasks/missing/cancel', {})).status, 404);
});

test('approve: needs the explicit pending action_id and sha; records owner + action + sha; no blanket approve', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  assert.equal((await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: 'x' })).body.code, 'E_NO_PENDING_APPROVAL');
  await store.setHead(id, SHA_A, { actor: DEV });
  const req = await askOwner(store, id);
  const view = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.equal(view.outcome, 'needs_owner');
  const p = view.pending_approval;
  assert.equal(p.action_id, `appr-${id}-${req.k}`);
  assert.deepEqual(p.classes, ['deploy']);
  assert.match(view.next_action, /Deploy to staging/);

  for (const body of [{}, { approve: true }, { action_id: 'all' }, { action_id: p.action_id }, { action_id: p.action_id, sha: SHA_B },
    { action_id: p.action_id, sha: SHA_A, extra: 1 }]) {
    const r = await call('POST', `/api/v2/tasks/${id}/approve`, body);
    assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await store.events(id)).filter((e) => e.kind === 'approval.granted').length, 0, 'nothing recorded by rejected attempts');

  const ok = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: p.action_id, sha: SHA_A, reason: 'ok for staging' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const ev = (await store.events(id)).find((e) => e.kind === 'approval.granted');
  assert.equal(ev.payload.actor, 'owner');
  assert.equal(ev.payload.action_id, p.action_id);
  assert.equal(ev.payload.sha, SHA_A);
  assert.deepEqual(ev.payload.grants, { classes: ['deploy'] }, 'covers exactly the requested classes');
  assert.equal(ev.event_id, `appr-${id}-${req.k}`, 'same event id as the goal loop approve()');
  assert.equal((await store.get(id)).status, 'awaiting_approval', 'recording is not executing: the loop moves the task');
  assert.equal((await call('POST', `/api/v2/tasks/${id}/deny`, { action_id: p.action_id, sha: SHA_A })).body.code, 'E_NO_PENDING_APPROVAL', 'answered once');
  assert.equal((await call('GET', `/api/v2/tasks/${id}`)).body.task.pending_approval, null);
});

test('deny records the denial; concurrent approve+deny: exactly one wins', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  const aid = `appr-${id}-${req.k}`;
  const [a, d] = await Promise.all([call('POST', `/api/v2/tasks/${id}/approve`, { action_id: aid }), call('POST', `/api/v2/tasks/${id}/deny`, { action_id: aid, reason: 'no' })]);
  assert.deepEqual([a.status, d.status].sort(), [200, 409]);
  const kinds = (await store.events(id)).filter((e) => e.kind.startsWith('approval.') && e.kind !== 'approval.requested').map((e) => e.kind);
  assert.equal(kinds.length, 1);
});

test('a task with an unreadable log is unknown, not done', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const t = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.equal(t.store_error, null);
  assert.notEqual(t.outcome, 'done');
});
