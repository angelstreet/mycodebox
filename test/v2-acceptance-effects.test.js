// T23 (external write confirmation), T07 (restart between attempted and confirmed) and T06 at the controller level
// (duplicate delivery across a restart). The ledger is the store's effect ledger; the destination is a fake external
// sink that can delay, lose or reject acknowledgements and can be queried afterwards. Synthetic data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';
import { sandbox, world, loopDecisions } from './fixtures/v2-world.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-acc-fx-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sb = sandbox('v2-acc-fx-world-');
let n = 0;
const open = (dir) => createTaskStore({ dir, ...clock() });

// A destination with its own durable record (keyed by idempotency key) and a controllable acknowledgement.
function fakeSink() {
  const applied = new Map();
  let mode = 'ack';                 // ack | lose_ack (applied, answer lost) | reject | down
  return {
    applied, setMode: (m) => { mode = m; },
    async send(key, payload) {
      if (mode === 'down') throw Object.assign(new Error('sink unreachable'), { code: 'ECONNREFUSED' });
      if (mode === 'reject') return { ok: false, reason: 'rejected by destination' };
      if (!applied.has(key)) applied.set(key, payload);   // the destination itself is idempotent by key
      if (mode === 'lose_ack') throw Object.assign(new Error('timeout waiting for ack'), { code: 'ETIMEDOUT' });
      return { ok: true };
    },
    async lookup(key) { if (mode === 'down') throw new Error('sink unreachable'); return applied.has(key); },
  };
}
// The posting protocol from spec §5: attempted -> send -> confirmed only on a positive ack; an unknown answer is
// possibly_applied; nothing is re-sent while an earlier attempt with the same key is unresolved.
async function post(store, task_id, sink, { effect_id, key, payload }) {
  await store.recordEffect(task_id, { effect_id, idempotency_key: key, kind: 'external_write', phase: 'attempted' });
  let r;
  try { r = await sink.send(key, payload); } catch { await store.recordEffect(task_id, { effect_id, phase: 'possibly_applied' }); return 'possibly_applied'; }
  await store.recordEffect(task_id, { effect_id, phase: r.ok ? 'confirmed' : 'failed' });
  return r.ok ? 'confirmed' : 'failed';
}
async function readyToAccept(store) {
  const t = await store.createTask(spec({ acceptance_checks: [{ id: 'unit', command: ['node', '--test'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] }));
  for (const s of ['clarified', 'planned', 'ready', 'executing']) await store.transition(t.task_id, s, { actor: 'controller' });
  await store.setHead(t.task_id, SHA_A, { actor: { role: 'developer', id: 'dev-1' } });
  await store.recordEvidence(t.task_id, { check_id: 'unit', sha: SHA_A, command: ['node', '--test'], exit: 0, duration_ms: 1, artifact: null, actor: 'runner' });
  await store.recordVerdict(t.task_id, { sha: SHA_A, actor: { role: 'verifier', id: 'rev-1' }, verdict: 'approve', findings: [] });
  return t.task_id;
}
const effect = async (store, id, effect_id) => (await store.get(id)).effects.find((e) => e.effect_id === effect_id);

test('T23: the ledger advances only after the destination confirms; no confirmation, no acceptance and no second send', async () => {
  const store = open(path.join(TMP, `s${++n}`));
  const id = await readyToAccept(store);
  const sink = fakeSink();
  // The answer is lost although the write landed: not confirmed, not failed.
  sink.setMode('lose_ack');
  assert.equal(await post(store, id, sink, { effect_id: 'post-1', key: 'digest:2026-10-11', payload: { n: 3 } }), 'possibly_applied');
  assert.equal((await effect(store, id, 'post-1')).phase, 'possibly_applied');
  // A retry with the same key is refused until reconciled: the ledger never re-sends blindly.
  sink.setMode('ack');
  await assert.rejects(post(store, id, sink, { effect_id: 'post-1b', key: 'digest:2026-10-11', payload: { n: 3 } }), { code: 'E_EFFECT_UNRECONCILED' });
  // Completion is blocked while an effect is unresolved, even with passing evidence and an independent approve.
  await store.transition(id, 'evaluating', { actor: 'controller' });
  await assert.rejects(store.transition(id, 'accepted', { actor: 'controller' }), { code: 'E_ACCEPTANCE_UNMET' });
  // Reconcile by asking the destination, then the ledger advances; a send after confirmation is a duplicate.
  assert.equal(await sink.lookup('digest:2026-10-11'), true);
  await store.recordEffect(id, { effect_id: 'post-1', phase: 'confirmed' });
  await assert.rejects(post(store, id, sink, { effect_id: 'post-2', key: 'digest:2026-10-11', payload: { n: 3 } }), { code: 'E_EFFECT_DUPLICATE' });
  assert.equal(sink.applied.size, 1, 'exactly one write reached the destination');
  await store.transition(id, 'accepted', { actor: 'controller' });
  assert.equal((await store.get(id)).outcome, 'done');
});

test('T23: a rejected or unreachable destination never advances the ledger; only a positive acknowledgement does', async () => {
  const store = open(path.join(TMP, `s${++n}`));
  const id = await readyToAccept(store);
  const sink = fakeSink();
  sink.setMode('reject');
  assert.equal(await post(store, id, sink, { effect_id: 'p1', key: 'k1', payload: 1 }), 'failed');
  sink.setMode('down');
  assert.equal(await post(store, id, sink, { effect_id: 'p2', key: 'k2', payload: 2 }), 'possibly_applied');
  await assert.rejects(sink.lookup('k2'), /unreachable/, 'reconciliation itself is unavailable: stays unknown');
  const v = await store.get(id);
  assert.deepEqual(v.effects.map((e) => [e.effect_id, e.phase]), [['p1', 'failed'], ['p2', 'possibly_applied']]);
  assert.equal(sink.applied.size, 0);
  // A failed attempt may be retried under the same key (it is known not to have happened); the unknown one may not.
  sink.setMode('ack');
  assert.equal(await post(store, id, sink, { effect_id: 'p1-retry', key: 'k1', payload: 1 }), 'confirmed');
  await assert.rejects(post(store, id, sink, { effect_id: 'p2-retry', key: 'k2', payload: 2 }), { code: 'E_EFFECT_UNRECONCILED' });
  assert.deepEqual([...sink.applied.keys()], ['k1']);
});

test('T07/T23: restart between attempted and confirmed -> unknown_external_effect; reconciled from the destination, never re-sent; not-applied becomes failed and may be retried once', async () => {
  const dir = path.join(TMP, `s${++n}`);
  let store = open(dir);
  const id = await readyToAccept(store);
  const sink = fakeSink();
  // Crash right after the write landed and before the confirmation was recorded; a second attempt never got sent.
  await store.recordEffect(id, { effect_id: 'w1', idempotency_key: 'kw1', kind: 'external_write', phase: 'attempted' });
  await sink.send('kw1', 'payload-1');
  await store.recordEffect(id, { effect_id: 'w2', idempotency_key: 'kw2', kind: 'external_write', phase: 'attempted' });
  store = open(dir);                                   // restart
  const rec = await store.recover();
  assert.deepEqual(rec.pendingEffects.map((e) => [e.effect_id, e.phase]).sort(), [['w1', 'possibly_applied'], ['w2', 'possibly_applied']]);
  assert.equal((await store.get(id)).status, 'unknown_external_effect');
  // Nothing may move forward until every effect is reconciled.
  await assert.rejects(store.transition(id, 'executing', { actor: 'controller' }), { code: 'E_EFFECT_UNRECONCILED' });
  for (const e of rec.pendingEffects) {
    const landed = await sink.lookup(e.idempotency_key);
    await store.recordEffect(id, { effect_id: e.effect_id, phase: landed ? 'confirmed' : 'failed' });
  }
  const v = await store.get(id);
  assert.deepEqual(v.effects.map((e) => [e.effect_id, e.phase]).sort(), [['w1', 'confirmed'], ['w2', 'failed']]);
  await store.transition(id, 'executing', { actor: 'controller' });
  // w1 is never sent again; w2 (known not applied) is retried exactly once.
  await assert.rejects(post(store, id, sink, { effect_id: 'w1-again', key: 'kw1', payload: 'payload-1' }), { code: 'E_EFFECT_DUPLICATE' });
  assert.equal(await post(store, id, sink, { effect_id: 'w2-retry', key: 'kw2', payload: 'payload-2' }), 'confirmed');
  assert.deepEqual([...sink.applied.entries()], [['kw1', 'payload-1'], ['kw2', 'payload-2']]);
  // A second restart changes nothing.
  const before = (await store.get(id)).seq;
  store = open(dir);
  const rec2 = await store.recover();
  assert.deepEqual(rec2.pendingEffects, []);
  assert.equal((await store.get(id)).seq, before);
});

test('T06: an owner decision delivered twice across a controller restart is one event and one transition', async () => {
  const env = world(sb);
  const task = await env.submit({ goal: 'Implement add(a, b) in src/math.js and then deploy it to production' });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const approve = () => env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'appr-once', grants: { classes: ['deploy'] } });
  const first = await approve();
  env.reopen();                                         // the phone retries after the controller restarted
  await env.loop.recover();
  const second = await approve();
  assert.deepEqual([first.applied, second.applied], [true, false]);
  assert.equal(env.events(task.task_id).filter((e) => e.kind === 'approval.granted').length, 1);
  const r = await env.loop.step(task.task_id);
  assert.equal(r.transitioned, true);
  env.reopen();
  await env.loop.recover();
  await assert.rejects(approve(), { code: 'E_ILLEGAL_TRANSITION' }, 'nothing awaits approval any more');
  const v = await env.view(task.task_id);
  assert.equal(v.history.filter((h) => h.from === 'awaiting_approval').length, 1, 'exactly one transition out of the approval');
  assert.equal(new Set(env.events(task.task_id).map((e) => e.event_id)).size, env.events(task.task_id).length);
  assert.ok(loopDecisions(v).length >= 1);
});
