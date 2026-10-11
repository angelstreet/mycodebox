// D-020: dashboard grants are not a second store writer. POST /approve and /deny go through the goal loop's
// approve()/deny() (controller lease, fenced write, one answer per request); without a loop in this process the route
// fails closed with a clear error, and a grant while another live controller holds the lease is refused, never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createIntake } from '../orchestration/intake.js';
import { createV2Http } from '../orchestration/http.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v2-grants-'));
const POLICY = { ok: true, policy: { project_id: 'fixture-project', test_command: ['npm', 'test'] } };
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [{ runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'strong',
  capabilities: ['text', 'code', 'tools'], efforts: ['low'], context_tokens: 1000, latency_ms: 1, test_only: true }] };
const RESOURCE = 'service:local:goal-loop';
// The smallest loop the factory accepts (worktrees/verifier are never reached by approve/deny).
const loopOver = (store, over = {}) => createGoalLoop({ store, registry: createRegistry(REGISTRY), adapters: {}, worktrees: {}, worktreeRoot: tmp(),
  verifier: {}, reviewRoot: tmp(), allowFake: true, ...over });

function setup({ withLoop = true, loopOpts = {} } = {}) {
  const dir = tmp();
  const store = createTaskStore({ dir, ...clock() });
  const loop = withLoop ? loopOver(store, loopOpts) : null;
  const api = createV2Http({ store, intake: createIntake({ store, loadPolicy: () => POLICY, resolveSha: () => SHA_A }), loop, log: () => {} });
  const call = (method, pathname, body) => api.handle({ method, pathname, readBody: async () => body });
  return { dir, store, loop, call };
}
async function askOwner(store, id) {
  const k = (await store.get(id)).history.length;
  const req = { k, kind: 'policy_gate', question: 'Deploy to staging?', classes: ['deploy'], resume_to: 'ready' };
  await store.recordDecision(id, { decision_id: `d-${id}-${k}`, kind: 'policy_gate', question: 'Can it proceed?', alternatives: [{ option: 'ask the owner', pros: ['safe'], cons: ['slow'] }],
    chosen: 'ask the owner', evidence: ['policy gate'], expected_effect: 'awaiting_approval', rationale: 'owner decision',
    actor: { role: 'manager', runtime: null, model: null }, reversible: true, rollback: 'cancel the task', loop: { k, patch: { approval: req } } });
  await store.transition(id, 'awaiting_approval', { reason: req.question, actor: 'goal-loop' });
  return { ...req, action_id: `appr-${id}-${k}` };
}
const answers = async (store, id) => (await store.events(id)).filter((e) => e.kind === 'approval.granted' || e.kind === 'approval.denied');

test('concurrent writers: a dashboard grant and a loop denial of the same request record exactly one answer', async () => {
  const { store, loop, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  const [r, d] = await Promise.all([call('POST', `/api/v2/tasks/${id}/approve`, { action_id: req.action_id, sha: SHA_A }),
    loop.deny(id, { actor: 'owner', reason: 'no' }).then(() => 'ok', (e) => e.code)]);
  assert.equal((await answers(store, id)).length, 1, 'one answer per request, whichever writer came first');
  assert.ok((r.status === 200) !== (d === 'ok'), `exactly one writer wins (route ${r.status}, loop ${d})`);
});

test('an answered request is never answered the other way: route grant, then a loop denial is refused (no double write)', async () => {
  const { store, loop, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  assert.equal((await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: req.action_id, sha: SHA_A })).status, 200);
  await assert.rejects(loop.deny(id, { actor: 'owner', reason: 'late' }), (e) => e.code === 'E_ALREADY_ANSWERED');
  assert.equal((await loop.approve(id, { actor: 'owner' })).applied, false, 'a retried identical answer is a no-op (T06)');
  assert.deepEqual((await answers(store, id)).map((e) => e.kind), ['approval.granted']);
});

test('grant via the route goes through the loop, carries the request binding, and the loop acts on it', async () => {
  const { store, loop, call } = setup();
  const { task_id: id } = await store.createTask(spec());
  await store.setHead(id, SHA_A, { actor: { role: 'developer', id: 'dev-1' } });
  const req = await askOwner(store, id);
  const seen = [];
  const approve = loop.approve;
  loop.approve = (...a) => { seen.push(a[0]); return approve(...a); };
  const ok = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: req.action_id, sha: SHA_A, reason: 'ok for staging' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(seen, [id], 'the route wrote through loop.approve()');
  const [ev] = await answers(store, id);
  assert.deepEqual([ev.event_id, ev.payload.actor, ev.payload.action_id, ev.payload.sha, ev.payload.reason], [req.action_id, 'owner', req.action_id, SHA_A, 'ok for staging']);
  assert.deepEqual(ev.payload.grants, { classes: ['deploy'], keys: [], request_kind: 'policy_gate' });
  const r = await loop.step(id);
  assert.deepEqual([r.from, r.state], ['awaiting_approval', 'ready'], 'the loop sees the grant and resumes');
});

test('no loop in this process: approve/deny fail closed with a clear error and write nothing', async () => {
  const { store, call } = setup({ withLoop: false });
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);
  for (const verb of ['approve', 'deny']) {
    const r = await call('POST', `/api/v2/tasks/${id}/${verb}`, { action_id: req.action_id, sha: SHA_A });
    assert.deepEqual([r.status, r.body.code], [503, 'E_NO_CONTROLLER'], verb);
    assert.match(r.body.error, /goal loop/);
  }
  assert.equal((await answers(store, id)).length, 0);
  assert.equal((await call('GET', `/api/v2/tasks/${id}`)).body.task.pending_approval.action_id, req.action_id, 'the request stays pending: not lost');
});

test('grant while another live controller holds the lease fails closed; once it is gone the grant goes through', async () => {
  const dir = tmp();
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(dir, 'leases') }) });
  // Another controller instance: holds the controller lease and keeps its heartbeat fresh (every sleep() of the
  // successor's liveness watch sees a new heartbeat) until it "dies".
  const storeDir = path.join(dir, 'v2');
  fs.mkdirSync(storeDir, { recursive: true });
  const other = { instance: 'other-instance', lease_id: 'ctl-other-00000001', alive: true, beats: 0 };
  const intentFile = path.join(storeDir, `controller.${other.instance}.intent.json`);
  const beat = () => fs.writeFileSync(intentFile, JSON.stringify({ resource: RESOURCE, lease_id: other.lease_id, owner: 'goal-loop', task_id: null,
    instance: other.instance, pid: 999999, host: 'other-host.example.invalid', started_at: Date.now(), heartbeat_at: Date.now() + ++other.beats }));
  const held = await leases.acquire(RESOURCE, { owner: 'goal-loop', ttl_ms: 600_000, scope: `controller ${other.instance}`, lease_id: other.lease_id });
  assert.ok(held.ok);
  beat();
  const store = createTaskStore({ dir: storeDir, ...clock() });
  const loop = loopOver(store, { leases, sleep: async () => { if (other.alive) beat(); } });
  const api = createV2Http({ store, intake: createIntake({ store, loadPolicy: () => POLICY, resolveSha: () => SHA_A }), loop, log: () => {} });
  const call = (method, pathname, body) => api.handle({ method, pathname, readBody: async () => body });
  // The task is set up by the live controller's own writes (raw store here).
  const { task_id: id } = await store.createTask(spec());
  const req = await askOwner(store, id);

  const r = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: req.action_id, sha: SHA_A });
  assert.deepEqual([r.status, r.body.code], [409, 'E_CONTROLLER_HELD'], JSON.stringify(r.body));
  assert.equal((await answers(store, id)).length, 0, 'nothing written behind the live controller');
  assert.deepEqual(await leases.validate(held.lease), { ok: true }, 'the live controller keeps its lease');

  other.alive = false;   // heartbeat stops: the successor takes over after watching two intervals
  const ok = await call('POST', `/api/v2/tasks/${id}/approve`, { action_id: req.action_id, sha: SHA_A });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await leases.validate(held.lease)).code, 'E_FENCED', 'the dead controller is fenced');
  assert.deepEqual((await answers(store, id)).map((e) => e.kind), ['approval.granted']);
});
