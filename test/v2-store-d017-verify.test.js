// Verification of D-017 (2cf2855): the implicit store open is read-only; tasks that need reconciliation refuse
// writes and read as `recovery_pending` until an explicit recover(). `todo` tests record open findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'v2-d017-'));
// The smallest loop the factory accepts: no adapters, no leases, stub worktrees/verifier (never reached here).
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [{ runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'strong',
  capabilities: ['text', 'code', 'tools'], efforts: ['low'], context_tokens: 1000, latency_ms: 1, test_only: true }] };
const loopOver = (store) => createGoalLoop({ store, registry: createRegistry(REGISTRY), adapters: {}, worktrees: {}, worktreeRoot: tmp(),
  verifier: {}, reviewRoot: tmp(), allowFake: true, ...clock() });
const open = (dir, fs = realFs) => createTaskStore({ dir, fs, ...clock() });
const PATH = ['clarified', 'planned', 'ready', 'executing'];
const logOf = (dir, id) => readFileSync(join(dir, 'tasks', id, 'events.jsonl'), 'utf8');
async function executingWithEffect(dir) {
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  for (const x of PATH) await s.transition(id, x);
  await s.recordEffect(id, { effect_id: 'fx', idempotency_key: 'k', kind: 'push', phase: 'attempted' });
  return id;
}
// Every fs call that could modify the store dir.
const WRITING = /^(write|append|truncate|rename|unlink|rm|mkdir|ftruncate|fsync)/;
const spyFs = (calls) => new Proxy(realFs, { get(t, k) {
  const f = t[k];
  if (typeof f !== 'function') return f;
  return (...a) => { if (WRITING.test(k) || (k === 'openSync' && a[1] && a[1] !== 'r')) calls.push(k); return f.apply(t, a); };
} });

test('D-017: reads on a torn log with an unconfirmed effect write nothing and never read as done', async () => {
  const dir = tmp();
  const id = await executingWithEffect(dir);
  appendFileSync(join(dir, 'tasks', id, 'events.jsonl'), '{"event_id":"half","kind":"task.compl');
  writeFileSync(join(dir, 'index.json.1.tmp'), 'x');
  const before = logOf(dir, id);
  const calls = [];
  const s = open(dir, spyFs(calls));
  const v = await s.get(id);
  await s.list();
  await s.independence(id, SHA_A);
  await s.events(id);
  assert.deepEqual(calls, []);
  assert.equal(logOf(dir, id), before);
  assert.ok(existsSync(join(dir, 'index.json.1.tmp')));   // nothing cleaned either
  assert.deepEqual([v.status, v.outcome, v.recovery_pending], ['executing', 'not_yet_done', 'torn tail']);
  assert.equal((await s.list())[0].recovery_pending, 'torn tail');
});

test('D-017: a crash that cut only the newline off task.completed still reads as evaluating, before and after recover()', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  for (const x of [...PATH, 'evaluating']) await s.transition(id, x);
  await s.setHead(id, SHA_A, { actor: 'dev' });
  await s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['x'], exit: 0, actor: 'runner' });
  await s.recordVerdict(id, { sha: SHA_A, actor: 'ver', verdict: 'approve', findings: [] });
  const line = JSON.stringify({ event_id: 'done', task_id: id, run_id: null, attempt_id: null, seq: 10, schema_version: 1, timestamp: '2026-01-01T00:00:00Z',
    runtime: null, provider: null, model: null, kind: 'task.completed', payload: { from: 'evaluating', to: 'accepted' }, causation_id: null });
  appendFileSync(join(dir, 'tasks', id, 'events.jsonl'), line);
  const s2 = open(dir);
  let v = await s2.get(id);
  assert.deepEqual([v.status, v.outcome, v.recovery_pending], ['evaluating', 'not_yet_done', 'torn tail']);
  await assert.rejects(s2.transition(id, 'accepted'), { code: 'E_STORE_FAILED' });
  await s2.recover();
  v = await s2.get(id);
  assert.deepEqual([v.status, v.outcome, v.recovery_pending], ['evaluating', 'not_yet_done', null]);
});

test('D-017: every write path on a recovery_pending task fails E_STORE_FAILED and leaves the log untouched', async () => {
  const dir = tmp();
  const id = await executingWithEffect(dir);
  const before = logOf(dir, id);
  const s = open(dir);
  assert.equal((await s.get(id)).recovery_pending, 'unconfirmed effect');
  const F = { code: 'E_STORE_FAILED' };
  await assert.rejects(s.transition(id, 'cancelled', { actor: 'owner' }), F);
  await assert.rejects(s.append(id, { event_id: 'x', kind: 'task.started' }), F);
  await assert.rejects(s.append(id, { event_id: 'effect:fx:attempted', kind: 'task.started' }), F);   // dedup does not short-circuit the guard
  await assert.rejects(s.recordEffect(id, { effect_id: 'fx', phase: 'confirmed' }), F);
  await assert.rejects(s.recordEffect(id, { effect_id: 'fx2', idempotency_key: 'k', kind: 'push', phase: 'attempted' }), F);
  await assert.rejects(s.setHead(id, SHA_A, { actor: 'dev' }), F);
  await assert.rejects(s.recordUsage(id, { runtime: 'fake' }), F);
  await assert.rejects(s.snapshotPolicy(id, { v: 1 }, { run_id: 'r' }), F);
  assert.equal(logOf(dir, id), before);
});

test('D-017: recover()/init() reconcile once, are idempotent, and a failed full recovery is retried', async () => {
  const dir = tmp();
  const id = await executingWithEffect(dir);
  appendFileSync(join(dir, 'tasks', id, 'events.jsonl'), '{"half');
  const s = open(dir);
  await s.get(id);   // read-only open first
  const r1 = await s.recover();
  const r2 = await s.recover();
  const r3 = await s.init();
  assert.deepEqual([r1.torn.length, r2.torn.length, r1.pendingEffects[0].moved, r2.pendingEffects[0].moved], [1, 0, true, false]);
  assert.equal(r3, await s.init());
  const v = await s.get(id);
  assert.deepEqual([v.status, v.recovery_pending, v.effects[0].phase], ['unknown_external_effect', null, 'possibly_applied']);
  assert.deepEqual(logOf(dir, id).trim().split('\n').map((l) => JSON.parse(l).kind).slice(-3), ['recovery.torn_tail', 'action.unknown', 'task.transitioned']);
  await assert.rejects(s.recordEffect(id, { effect_id: 'fx2', idempotency_key: 'k', kind: 'push', phase: 'attempted' }), { code: 'E_EFFECT_UNRECONCILED' });
  await s.recordEffect(id, { effect_id: 'fx', phase: 'confirmed' });
  assert.equal((await s.transition(id, 'executing')).applied, true);
  // A full recovery whose repair write fails leaves the handle usable read-only and is retried by the next init().
  const dir2 = tmp();
  const id2 = await executingWithEffect(dir2);
  appendFileSync(join(dir2, 'tasks', id2, 'events.jsonl'), '{"half');
  let arm = true;
  const s2 = open(dir2, { ...realFs, truncateSync(...a) { if (arm) throw Object.assign(new Error('eio'), { code: 'EIO' }); return realFs.truncateSync(...a); } });
  await assert.rejects(s2.init(), { code: 'EIO' });
  assert.equal((await s2.get(id2)).recovery_pending, 'torn tail');
  arm = false;
  await s2.init();
  assert.equal((await s2.get(id2)).recovery_pending, null);
});

test('D-017: a second handle reading a live run neither marks it possibly_applied nor blocks the writer', async () => {
  const dir = tmp();
  const w = open(dir);
  const { task_id: id } = await w.createTask(spec());
  for (const x of PATH) await w.transition(id, x);
  await w.recordEffect(id, { effect_id: 'fx', idempotency_key: 'k', kind: 'push', phase: 'attempted' });
  const reader = open(dir);
  assert.equal((await reader.get(id)).recovery_pending, 'unconfirmed effect');
  assert.equal((await w.recordEffect(id, { effect_id: 'fx', phase: 'confirmed' })).applied, true);   // the writer's handle is unaffected
  assert.deepEqual((await reader.recover()).pendingEffects, []);
  assert.deepEqual((await reader.get(id)).effects[0].history.map((h) => h.phase), ['attempted', 'confirmed']);
});

test('D-017: the goal loop steps a recovery_pending task only after recovering under its lease', async () => {
  const dir = tmp();
  const id = await executingWithEffect(dir);
  const store = open(dir);
  const loop = loopOver(store);
  await loop.step(id).catch(() => {});   // the handler after recovery is not under test
  assert.equal((await store.get(id)).recovery_pending, null);
  assert.equal((await store.get(id)).status, 'unknown_external_effect');
  assert.equal((await store.get(id)).effects[0].phase, 'possibly_applied');
});

test('D-017: owner cancel (T14) on a recovery_pending task is honoured, not refused', async () => {
  const dir = tmp();
  const id = await executingWithEffect(dir);
  const store = open(dir);
  const loop = loopOver(store);
  await loop.cancel(id, { actor: 'owner', reason: 'stop' });
  assert.equal((await store.get(id)).status, 'cancelled');
});

test('D-017: a task a full recovery would park (possibly_applied effect in executing) reads as recovery_pending too', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  for (const x of [...PATH, 'evaluating']) await s.transition(id, x);
  await s.recordEffect(id, { effect_id: 'fx', idempotency_key: 'k', kind: 'notify', phase: 'attempted' });
  const s2 = open(dir);
  await s2.recover();   // cannot park from evaluating: effect becomes possibly_applied, state stays
  await s2.transition(id, 'repair');
  await s2.transition(id, 'executing');
  const s3 = open(dir);
  assert.ok((await s3.get(id)).recovery_pending);
});
