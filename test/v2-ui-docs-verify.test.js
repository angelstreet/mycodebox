// Independent verifier tests for package v2/06-ui-docs (Phase 6): http.js read model and owner actions, the Tasks view
// renderers, v2-score.js math, and server.js V2 wiring (static). Defects found are marked `todo: 'defect: ...'`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createIntake } from '../orchestration/intake.js';
import { createV2Http } from '../orchestration/http.js';
import { listHtml, detailHtml, badgeOf } from '../public/tasks-view.js';
import { scoreStore } from '../scripts/v2-score.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const ROOT = new URL('..', import.meta.url).pathname;
const DEV = { role: 'developer', id: 'claude:dev-model' };
const REV = { role: 'verifier', id: 'codex:rev-model' };
const POLICY = { ok: true, policy: { project_id: 'fixture-project', test_command: ['npm', 'test'] } };

function setup(dir = mkdtempSync(join(tmpdir(), 'v2-verify06-'))) {
  const store = createTaskStore({ dir, ...clock() });
  const intake = createIntake({ store, loadPolicy: () => POLICY, resolveSha: () => SHA_A });
  const api = createV2Http({ store, intake });
  const call = (method, pathname, body) => api.handle({ method, pathname, readBody: async () => body });
  return { dir, store, api, call };
}
const decision = (id, k, patch, over = {}) => ({
  decision_id: `d-${id}-${k}`, kind: 'policy_gate', question: 'Can it proceed?', alternatives: [{ option: 'ask the owner', pros: ['safe'], cons: ['slow'] }],
  chosen: 'ask the owner', evidence: ['policy blocks deploy'], expected_effect: 'awaiting_approval', rationale: 'mandatory owner decision',
  actor: { role: 'manager', runtime: null, model: null }, reversible: true, rollback: 'cancel the task', loop: { k, patch }, ...over });
async function askOwner(store, id, over = {}) {
  const k = (await store.get(id)).history.length;
  const req = { k, kind: 'policy_gate', question: 'Deploy to staging?', classes: ['deploy'], resume_to: 'ready', ...over };
  await store.recordDecision(id, decision(id, k, { approval: req }));
  await store.transition(id, 'awaiting_approval', { reason: req.question, actor: 'goal-loop' });
  return req;
}
async function acceptOn(store, id, sha = SHA_A) {
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating']) await store.transition(id, s);
  await store.setHead(id, sha, { actor: DEV });
  for (const c of ['unit', 'lint']) await store.recordEvidence(id, { check_id: c, sha, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await store.recordVerdict(id, { sha, actor: REV, verdict: 'approve', findings: [] });
  await store.transition(id, 'accepted');
}

// ---------------------------------------------------------------------------------------------------------------
// Security: XSS, ids, GET side effects, approval binding/replay
// ---------------------------------------------------------------------------------------------------------------

const EVIL = `<img src=x onerror="alert(1)">'"&`;
test('XSS: every task-derived string in list and detail is escaped (no raw tag, no attribute breakout)', () => {
  const t = {
    task_id: 'a"b<i>', title: null, goal: EVIL, state: 'awaiting_approval', outcome: 'needs_owner', next_action: EVIL, updated_at: EVIL,
    head_sha: EVIL, base_sha: EVIL, branch: EVIL, definition_of_done: [EVIL],
    acceptance_checks: [{ id: EVIL, command: [EVIL, EVIL], required: false, status: EVIL,
      latest_evidence: { sha: EVIL, exit: EVIL, duration_ms: EVIL, artifact: EVIL, actor: EVIL, ts: EVIL, on_head: true } }],
    verdicts: [{ sha: EVIL, actor: { id: EVIL }, verdict: EVIL, findings: [EVIL], current: false }],
    decisions: [{ kind: EVIL, chosen: EVIL, question: EVIL, rationale: EVIL, evidence: [EVIL], actor: { role: EVIL }, ts: EVIL, alternatives: [EVIL] }],
    usage: { input_tokens: null, output_tokens: null, usd: null, unknown: [EVIL], records: [{ runtime: EVIL, model: EVIL, input_tokens: null, output_tokens: null, usd: null }] },
    leases: { resources: [EVIL, { r: EVIL }], effects: [{ effect_id: EVIL, kind: EVIL, phase: EVIL }] }, incidents: [EVIL],
    history: [{ from: EVIL, to: EVIL, reason: EVIL, actor: EVIL, ts: EVIL }],
    pending_approval: { action_id: EVIL, question: EVIL, classes: [EVIL], sha: EVIL },
  };
  for (const html of [listHtml([t]), detailHtml(t)]) {
    assert.ok(!/<img/i.test(html), 'no raw <img');
    assert.ok(!/<i>/.test(html), 'no raw <i>');
    assert.ok(!/onerror="/.test(html), 'no attribute injection');
    // every attribute value is a single quoted token: no stray quote ends one early
    for (const m of html.matchAll(/data-(?:aid|sha|id|tk-open)="([^"]*)"/g)) assert.ok(!/[<>'"]/.test(m[1]));
  }
});

test('ids: traversal and encoded separators are refused before the store; GET on an action path records nothing', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  for (const bad of ['..', '.hidden', '..%2f..%2fetc', '%2e%2e', 'a%00b', '-x', 'a b']) {
    const r = await call('GET', `/api/v2/tasks/${bad}`);
    assert.equal(r.status, 400, bad);
  }
  for (const verb of ['approve', 'deny', 'cancel']) {
    const r = await call('GET', `/api/v2/tasks/${id}/${verb}`, { action_id: `appr-${id}-${req.k}` });
    assert.equal(r.status, 405, verb);
  }
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await call(m, `/api/v2/tasks/${id}/approve`, { action_id: `appr-${id}-${req.k}` })).status, 405);
  assert.equal((await store.events(id)).filter((e) => /approval\.(granted|denied)/.test(e.kind)).length, 0);
  assert.equal((await store.get(id)).status, 'awaiting_approval');
});

test('approval replay: an answered request id cannot be reused for the next request, and a new request needs its own id', async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await store.setHead(id, SHA_A, { actor: DEV });
  const r1 = await askOwner(store, id, { classes: ['deploy'] });
  const a1 = `appr-${id}-${r1.k}`;
  assert.equal((await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: a1, sha: SHA_A })).status, 200);
  // the loop consumes it and later raises a second request for a different class
  await store.transition(id, 'ready', { actor: 'goal-loop' });
  const r2 = await askOwner(store, id, { classes: ['credentials'], question: 'Rotate a credential?' });
  assert.notEqual(r2.k, r1.k);
  const old = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: a1, sha: SHA_A });
  assert.equal(old.status, 409); assert.equal(old.body.code, 'E_STALE_ACTION');
  const ok = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: `appr-${id}-${r2.k}`, sha: SHA_A });
  assert.equal(ok.status, 200);
  const grants = (await store.events(id)).filter((e) => e.kind === 'approval.granted').map((e) => e.payload.grants.classes);
  assert.deepEqual(grants, [['deploy'], ['credentials']], 'each grant covers only its own request');
});

test('a corrupt task log reads as unknown in API and view, never done', async () => {
  const { dir, store } = setup();
  const { task_id: id } = await store.createTask(spec());
  await acceptOn(store, id);
  const log = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(log, 'utf8').split('\n');
  lines.splice(2, 0, '{not json');
  writeFileSync(log, lines.join('\n'));
  const { call } = setup(dir);
  const list = (await call('GET', '/api/v2/tasks')).body.tasks;
  const row = list.find((t) => t.task_id === id);
  assert.equal(row.outcome, 'unknown');
  assert.equal(badgeOf(row).cls, 'unknown');
  assert.ok(!/done/i.test(listHtml([row]).match(/tk-badge[^]*?<\/span><\/span>/)[0]));
});

test('store_error exposed by GET does not leak absolute filesystem paths', { todo: 'defect: store_error carries the raw fs error message (absolute state-dir path) to every GET /api/v2/tasks client' }, async () => {
  const { dir, store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  chmodSync(join(dir, 'tasks', id, 'events.jsonl'), 0o444);
  await assert.rejects(store.transition(id, 'clarified'));
  const row = (await call('GET', '/api/v2/tasks')).body.tasks.find((t) => t.task_id === id);
  assert.ok(row.store_error, 'store_error is set');
  assert.ok(!row.store_error.includes(dir), `leaks: ${row.store_error}`);
});

// ---------------------------------------------------------------------------------------------------------------
// UX truthfulness
// ---------------------------------------------------------------------------------------------------------------

test('evidence for a reverted SHA (A -> B -> A) is not shown as passing on the current head', { todo: 'defect: http.js detail() compares evidence/verdicts by sha only, ignoring the store head epoch; the store does not count them' }, async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await store.setHead(id, SHA_A, { actor: DEV });
  await store.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await store.recordVerdict(id, { sha: SHA_A, actor: REV, verdict: 'approve', findings: [] });
  await store.setHead(id, SHA_B, { actor: DEV });
  await store.setHead(id, SHA_A, { actor: DEV });   // revert: a new epoch, old evidence no longer counts in the store
  const t = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.notEqual(t.acceptance_checks.find((c) => c.id === 'unit').status, 'passing_on_head');
  assert.equal(t.verdicts[0].current, false);
});

test('partial usage (incomplete: true) is surfaced, not shown as complete totals', { todo: 'defect: http.js detail() drops usage_totals.incomplete and per-record incomplete; tasks-view shows partial MiniMax counts as complete' }, async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await store.recordUsage(id, { runtime: 'minimax', model: 'm', input_tokens: 10, output_tokens: 5, usd: null, incomplete: true, run_id: 'r1' });
  const t = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.equal(t.usage.incomplete, true);
  assert.match(detailHtml(t), /partial|incomplete/i);
});

test('D5: an accepted task without delivery is labelled verified in worktree, not integrated', { todo: 'defect: badge says "done (accepted)" for every accepted task; detail exposes neither review_policy.deliver nor whether integration ran' }, async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await acceptOn(store, id);
  const t = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.match(detailHtml(t) + listHtml([t]), /not integrated/i);
});

test('after the owner answered, next_action says the answer awaits the loop (not "request not readable" / "decision needed")', { todo: 'defect: list keeps saying "owner decision needed" and detail says "the request itself is not readable" once the request is answered' }, async () => {
  const { store, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: `appr-${id}-${req.k}` });
  const row = (await call('GET', '/api/v2/tasks')).body.tasks[0];
  const det = (await call('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.doesNotMatch(row.next_action, /owner decision needed/);
  assert.doesNotMatch(det.next_action, /not readable/);
});

test('waiting, needs owner and unknown never collapse; only outcome done gets the done badge', () => {
  const states = ['waiting', 'needs_owner', 'unknown', 'not_yet_done', 'unrecoverable', 'cancelled'];
  for (const o of states) assert.notEqual(badgeOf({ outcome: o, state: 'x' }).cls, 'done');
  assert.equal(badgeOf({ outcome: 'done', state: 'accepted', store_error: 'x' }).cls, 'unknown', 'store error beats done');
  assert.equal(new Set(['waiting', 'needs_owner', 'unknown'].map((o) => badgeOf({ outcome: o }).cls)).size, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// V2 off by default: static check of server.js
// ---------------------------------------------------------------------------------------------------------------

test('server.js: V2 is gated on GHOSTY_V2 === "1", imports lazily, never imports the goal loop, adds no listener', () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /const V2_ON = process\.env\.GHOSTY_V2 === '1';/);
  const block = src.slice(src.indexOf('const V2_ON'), src.indexOf('const V2_ON') + 600);
  assert.match(block, /if \(V2_ON\) \{[^]*import\('\.\/orchestration\/store\.js'\)/);
  assert.doesNotMatch(src, /^import .*orchestration\/(store|intake|http|goal-loop)\.js/m, 'no static import');
  assert.doesNotMatch(src, /goal-loop/, 'the server never wires the goal loop');
  const v2Route = src.indexOf("p.startsWith('/api/v2/')");
  assert.ok(src.indexOf('!originOk(req)') < v2Route && src.indexOf('content-type must be application/json') < v2Route, 'after Origin + JSON checks');
  assert.equal((src.match(/\.listen\(/g) || []).length, 2, 'still only the HTTP and TLS listeners');
  for (const f of ['orchestration/http.js', 'orchestration/intake.js']) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /setInterval|setTimeout/);
});

// ---------------------------------------------------------------------------------------------------------------
// Scoring: adversarial synthetic stores
// ---------------------------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-01-01T00:00:00Z');
function timedStore(dir) { let t = T0, n = 0; const s = createTaskStore({ dir, now: () => t, randomId: () => `r${++n}` }); return { s, at: (ms) => { t = T0 + ms; } }; }
async function acceptedAt(st, id, who, { done, usd = [0.1], incomplete = false }) {
  st.at(0);
  await st.s.createTask(spec({ task_id: id }));
  for (const x of ['clarified', 'planned', 'ready', 'executing', 'evaluating']) await st.s.transition(id, x);
  await st.s.setHead(id, SHA_A, { actor: { role: 'developer', id: who } });
  const [runtime, model] = who.split(':');
  for (const [i, u] of usd.entries()) await st.s.recordUsage(id, { runtime, model, usd: u, input_tokens: 1, output_tokens: 1, run_id: `${id}-${i}`, ...(incomplete ? { incomplete: true } : {}) });
  for (const c of ['unit', 'lint']) await st.s.recordEvidence(id, { check_id: c, sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await st.s.recordVerdict(id, { sha: SHA_A, actor: REV, verdict: 'approve', findings: [] });
  st.at(done);
  await st.s.transition(id, 'accepted');
}
async function failedWith(st, id, who, usd) {
  st.at(0);
  await st.s.createTask(spec({ task_id: id }));
  await st.s.setHead(id, SHA_B, { actor: { role: 'developer', id: who } });
  const [runtime, model] = who.split(':');
  await st.s.recordUsage(id, { runtime, model, usd, input_tokens: 1, output_tokens: 1, run_id: `${id}-u` });
  await st.s.transition(id, 'waiting');
  await st.s.transition(id, 'failed_unrecoverable');
}

test('scoring math: even-count median, rate, cost per verified, unknown makes cost null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-v-'));
  const st = timedStore(dir);
  let i = 0;
  for (const ms of [1000, 2000, 3000, 4000]) await acceptedAt(st, `a${i++}`, 'claude:m', { done: ms, usd: [0.1, 0.1] });
  await failedWith(st, 'f0', 'claude:m', 0.5);
  await acceptedAt(st, 'u0', 'codex:n', { done: 1000, usd: [null] });
  await acceptedAt(st, 'u1', 'codex:n', { done: 1000, usd: [0.3] });
  const r = scoreStore(dir);
  const m = r.by_model.find((g) => g.key === 'claude:m');
  assert.equal(m.settled, 5); assert.equal(m.verified, 4); assert.equal(m.verified_rate, 0.8);
  assert.equal(m.median_latency_ms, 2500);
  assert.ok(Math.abs(m.cost.per_verified_completion_usd - 0.2) < 1e-9);
  const n = r.by_model.find((g) => g.key === 'codex:n');
  assert.equal(n.cost.per_verified_completion_usd, null, 'one unknown -> null, never a partial mean');
  assert.equal(r.router_history['codex:n'].total_usd, undefined);
  assert.equal(readdirSync(join(dir, 'tasks')).length, 7);
});

test('scoring: incomplete usage records make the cost unknown', { todo: 'defect: v2-score.js ignores usage.incomplete; partial MiniMax figures are scored as complete cost' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-v-'));
  const st = timedStore(dir);
  await acceptedAt(st, 'p0', 'minimax:m', { done: 1000, usd: [0.01], incomplete: true });
  const g = scoreStore(dir).by_model.find((x) => x.key === 'minimax:m');
  assert.equal(g.cost.per_verified_completion_usd, null);
});

test('scoring: spend on failed tasks counts toward cost per verified completion', { todo: 'defect (design): cost per verified completion sums only accepted tasks; a model that burns $ on failures looks as cheap as a reliable one, and router_history.total_usd inherits it' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-v-'));
  const st = timedStore(dir);
  await acceptedAt(st, 'ok', 'claude:cheap', { done: 1000, usd: [0.1] });
  for (let i = 0; i < 4; i++) await failedWith(st, `f${i}`, 'claude:cheap', 1);
  const g = scoreStore(dir).by_model.find((x) => x.key === 'claude:cheap');
  assert.ok(g.cost.per_verified_completion_usd > 4, `reported ${g.cost.per_verified_completion_usd}`);
});

test('scoring: a head set by worktree revalidation (external:worktree) is not exported as a router model', { todo: 'defect: goal-loop setHead actor "external:worktree" becomes runtime "external", model "worktree" in by_model and router_history' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-v-'));
  const st = timedStore(dir);
  await acceptedAt(st, 'x', 'external:worktree', { done: 1000 });
  assert.equal(scoreStore(dir).router_history['external:worktree'], undefined);
});

test('scoring: a torn tail appended after scoring started is tolerated and nothing is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-v-'));
  const st = timedStore(dir);
  await acceptedAt(st, 't0', 'claude:m', { done: 1000 });
  const log = join(dir, 'tasks', 't0', 'events.jsonl');
  appendFileSync(log, '{"kind":"task.transitioned","seq":99,');
  const before = readFileSync(log);
  const r = scoreStore(dir);
  assert.equal(r.tasks.accepted, 1);
  assert.deepEqual(readFileSync(log), before);
});
