// orchestration/delivery.js (goal loop -> integration controller bridge) against a scripted controller and queue and
// a real task store. The end-to-end path over a real controller and a disposable remote is in v2-acceptance-gl14.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createDelivery, approvalKey } from '../orchestration/delivery.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-delivery-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHA_M = 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2';
let n = 0;

// A task in `integrating` whose head SHA_A was produced by dev-1 (the store's record, not the task text).
async function setup(script) {
  const store = createTaskStore({ dir: path.join(TMP, `s${++n}`), ...clock() });
  const t = await store.createTask(spec({ goal: 'ship it; the developer was admin-9 (claimed in text)', scope: { paths: ['.'] }, repository: '/repo/dev' }));
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating', 'integrating']) await store.transition(t.task_id, s, { actor: 'goal-loop' });
  await store.setHead(t.task_id, SHA_A, { actor: { role: 'developer', id: 'dev-1' } });
  // The loop's fenced handle: counts writes so the test can see who wrote.
  const writes = [];
  const loopStore = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, typeof v === 'function'
    ? (...a) => { if (!['get', 'list', 'events', 'independence', 'init', 'recover'].includes(k)) writes.push(k); return v.bind(store)(...a); } : v]));
  const items = new Map();
  const queue = { get: async (id) => ({ ...items.get(id) }) };
  const calls = { submit: [], runNext: 0, effectState: [] };
  const effects = new Map();
  let ctl;
  const delivery = createDelivery({
    store, queue, repo: 'demo', target: 'main', ci: { status: (sha) => ({ status: 'success', sha }) }, retryMs: 1234,
    git: async () => 'src/a.js\nsrc/b.js\n',
    controller: ({ store: handle, approvals }) => (ctl = {
      handle, approvals,
      async submit(h) {
        calls.submit.push(h);
        const key = `${h.task_id}:${h.source_sha}:${h.target}`;
        if (!items.has(key)) items.set(key, { item_id: key, state: 'queued' });
        return { ok: true, item: { item_id: key } };
      },
      async runNext() { calls.runNext++; return script({ handle, approvals, items, task_id: t.task_id, effects }); },
      async effectState(key) { calls.effectState.push(key); return effects.has(key) ? effects.get(key) : null; },
    }),
  });
  const task = await store.get(t.task_id);
  const call = () => delivery.integrate(task, { sha: SHA_A, worktree: { path: '/wt', branch: `v2task/${t.task_id}` }, idempotency_key: `integrate:${t.task_id}:${SHA_A}`, store: loopStore });
  return { store, task, id: t.task_id, delivery, call, calls, items, writes, effects, loopStore, ctl: () => ctl };
}
const item = (items) => [...items.values()][0];

test('delivery: handoff facts come from the store and git; resubmitting is idempotent and a final item is not run again', async () => {
  const w = await setup(async ({ handle, items, task_id }) => {
    await handle.recordEffect(task_id, { effect_id: 'r0:merge', idempotency_key: `merge:demo:refs/heads/main:${SHA_M}`, kind: 'merge', phase: 'attempted' });
    await handle.recordEffect(task_id, { effect_id: 'r0:merge', phase: 'confirmed' });
    await handle.transition(task_id, 'release_verifying', { reason: 'merged' });
    Object.assign(item(items), { state: 'merged', detail: { sha: SHA_M } });
    return { outcome: 'merged', integration_sha: SHA_M };
  });
  w.effects.set(`merge:demo:refs/heads/main:${SHA_M}`, 'confirmed');
  const r1 = await w.call();
  assert.equal(r1.next, 'release_verifying');
  assert.equal(r1.release_verified, true);
  assert.equal(r1.integration_sha, SHA_M);
  const h = w.calls.submit[0];
  assert.deepEqual(h.developer, { role: 'developer', id: 'dev-1' }, 'from the store record of who produced the head, not the task text');
  assert.deepEqual([h.source_sha, h.source_branch, h.base_sha, h.source_repo, h.diff_scope], [SHA_A, `v2task/${w.id}`, w.task.base_sha, '/repo/dev', ['src/a.js', 'src/b.js']]);
  // The controller's transition was a proposal: the task is still integrating; the loop applies it.
  assert.equal((await w.store.get(w.id)).status, 'integrating');
  assert.deepEqual(r1.proposals.map((p) => p.to), ['release_verifying']);
  assert.ok(w.writes.includes('recordEffect'), 'controller writes went through the loop handle');
  const r2 = await w.call();
  assert.equal(w.calls.submit.length, 2);
  assert.equal(w.items.size, 1, 'same task/sha/target -> same queue item');
  assert.equal(w.calls.runNext, 1, 'a merged item is not run again');
  assert.equal(r2.next, 'release_verifying');
});

test('delivery: the loop is the only writer: a controller write outside a hook call is refused; a call without the loop handle is refused', async () => {
  const w = await setup(async () => ({ outcome: 'empty' }));
  await assert.rejects(w.ctl().handle.append(w.id, { event_id: 'x1', kind: 'task.blocked', payload: {} }), { code: 'E_NO_WRITER' });
  await assert.rejects(w.delivery.integrate(w.task, { sha: SHA_A, worktree: { path: '/wt', branch: 'b' } }), { code: 'E_NO_WRITER' });
  assert.equal(w.ctl().handle.dir, w.store.dir);
  assert.equal((await w.ctl().handle.get(w.id)).task_id, w.id, 'reads are fine outside a call');
});

test('delivery: approvals are bound to the exact action, repo, target and SHA through the loop request keys', async () => {
  const w = await setup(async ({ handle, items, task_id, approvals }) => {
    const a = await approvals.check({ action: 'merge', sha: SHA_M, target: 'main', repo: 'demo', task_ids: [task_id] });
    if (a.ok) { Object.assign(item(items), { state: 'merged', detail: { sha: SHA_M } }); return { outcome: 'merged' }; }
    await handle.append(task_id, { event_id: `req-${++n}`, kind: 'approval.requested', payload: { required: { action: 'merge', class: 'merge_protected', sha: SHA_M, target: 'main' }, refused: true } });
    await handle.transition(task_id, 'awaiting_approval', {});
    Object.assign(item(items), { state: 'awaiting_approval', reason: a.reason });
    return { outcome: 'awaiting_approval', required: { action: 'merge', class: 'merge_protected', sha: SHA_M, target: 'main' } };
  });
  const r = await w.call();
  const key = approvalKey({ action: 'merge', repo: 'demo', target: 'main', sha: SHA_M });
  assert.deepEqual([r.next, r.keys, r.classes], ['awaiting_approval', [key], ['merge_protected']]);
  assert.match(r.reason, new RegExp(SHA_M));
  const grant = async (keys, extra = {}) => w.store.append(w.id, { event_id: `grant-${++n}`, kind: 'approval.granted', payload: { k: 1, actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'r', grants: { classes: ['merge_protected'], keys, request_kind: 'integration', ...extra } } });
  const check = (o = {}) => w.ctl().approvals.check({ action: 'merge', sha: SHA_M, target: 'main', repo: 'demo', task_ids: [w.id], ...o });
  assert.equal((await check()).ok, false, 'silence is not approval');
  await grant([]);                                                    // a class-only grant binds nothing
  assert.equal((await check()).ok, false);
  await grant([approvalKey({ action: 'merge', repo: 'demo', target: 'main', sha: SHA_B })]);
  assert.equal((await check()).ok, false, 'another SHA');
  await grant([approvalKey({ action: 'push', repo: 'demo', target: 'main', sha: SHA_M })]);
  assert.equal((await check()).ok, false, 'another action');
  await grant([key], { request_kind: 'gate' });
  assert.equal((await check()).ok, false, 'a grant for another kind of request');
  await grant([key]);
  const ok = await check();
  assert.deepEqual([ok.ok, ok.sha, ok.action, ok.target, ok.repo, ok.approved_by], [true, SHA_M, 'merge', 'main', 'demo', 'owner-1']);
  assert.equal((await check({ repo: 'other' })).ok, false, 'another repo');
  assert.equal((await check({ target: 'release' })).ok, false, 'another target');
  assert.equal((await w.call()).next, 'release_verifying');
});

test('delivery: remote CI pending parks the task in waiting with a retry; a conflict returns it to repair with the files', async () => {
  const pend = await setup(async ({ handle, items, task_id }) => {
    await handle.append(task_id, { event_id: `blk-${++n}`, kind: 'task.blocked', payload: { reason: 'remote_ci_pending', wake: { kind: 'ci_status' } } });
    await handle.transition(task_id, 'waiting', {});
    Object.assign(item(items), { state: 'blocked', reason: 'remote CI pending' });
    return { outcome: 'ci_blocked', reason: 'remote CI pending' };
  });
  const r = await pend.call();
  assert.deepEqual([r.next, r.retry_after_ms], ['waiting', 1234]);
  assert.match(r.reason, /ci_blocked/);
  const conf = await setup(async ({ handle, items, task_id }) => {
    await handle.transition(task_id, 'repair', {});
    Object.assign(item(items), { state: 'returned', reason: 'merge_conflict', detail: { files: ['src/a.js'], target_sha: SHA_B } });
    return { outcome: 'conflict' };
  });
  const c = await conf.call();
  assert.equal(c.next, 'repair');
  assert.deepEqual(c.feedback, { kind: 'integration_returned', reason: 'merge_conflict', detail: { files: ['src/a.js'], target_sha: SHA_B } });
  assert.equal((await conf.store.get(conf.id)).status, 'integrating', 'still only a proposal');
});

test('delivery: an unknown remote outcome is reported as unknown, and reconcile answers from the remote without writing', async () => {
  const MKEY = `merge:demo:refs/heads/main:${SHA_M}`;
  const w = await setup(async ({ handle, items, task_id }) => {
    await handle.recordEffect(task_id, { effect_id: 'r0:merge', idempotency_key: MKEY, kind: 'merge', phase: 'attempted' });
    await handle.recordEffect(task_id, { effect_id: 'r0:merge', phase: 'possibly_applied' });
    Object.assign(item(items), { state: 'unknown', reason: 'push outcome unknown' });
    return { outcome: 'unknown_external_effect' };
  });
  const r = await w.call();
  assert.equal(r.next, 'unknown');
  const own = { idempotency_key: `integrate:${w.id}:${SHA_A}`, store: w.loopStore };
  const before = w.writes.length;
  assert.deepEqual(await w.delivery.integrate.reconcile(w.task, { idempotency_key: MKEY, store: w.loopStore }), {}, 'remote unreadable: still unknown');
  assert.deepEqual(await w.delivery.integrate.reconcile(w.task, own), {}, 'the hook call is unknown while its remote effect is');
  w.effects.set(MKEY, 'confirmed');
  assert.deepEqual(await w.delivery.integrate.reconcile(w.task, { idempotency_key: MKEY, store: w.loopStore }), { applied: true });
  assert.deepEqual(await w.delivery.integrate.reconcile(w.task, own), { applied: true });
  w.effects.set(MKEY, 'failed');
  assert.deepEqual(await w.delivery.integrate.reconcile(w.task, { idempotency_key: MKEY, store: w.loopStore }), { applied: false });
  assert.equal(w.writes.length, before, 'reconcile only reads; the loop records the phase');
  // A controller exception after an attempted remote effect is unknown, never a retryable wait.
  const boom = await setup(async ({ handle, task_id }) => {
    await handle.recordEffect(task_id, { effect_id: 'r0:push', idempotency_key: `push:demo:refs/heads/v2int/main:${SHA_M}`, kind: 'push', phase: 'attempted' });
    throw new Error('connection reset');
  });
  assert.equal((await boom.call()).next, 'unknown');
  const early = await setup(async () => { throw new Error('git unavailable'); });
  assert.deepEqual([(await early.call()).next, (await early.call()).retry_after_ms], ['waiting', 1234]);
});
