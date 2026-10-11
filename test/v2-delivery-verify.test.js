// Independent verification of orchestration/delivery.js (v2/11-e2e). DV1-DV4 were recorded as todo defects and fixed;
// they assert the wanted behaviour; their leading DVn token is what scripts/v2-acceptance.js DEFECT_ROWS maps to matrix
// rows. Part 1: scripted controller + real task store (as in v2-delivery.test.js). Part 2: the real integration
// controller on a disposable bare remote with a crash between the controller's merge push and its confirmation record
// (the window the single-writer design has to survive without a second push).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { createIntegrationQueue } from '../orchestration/integration-queue.js';
import { createDelivery, approvalKey } from '../orchestration/delivery.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';
import { sandbox, world, mkOrigin, makeDelivery, fakeRemoteCi, states, GOOD, APPROVE } from './fixtures/v2-world.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-delivery-verify-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHA_M = 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2';
const MKEY = `merge:demo:refs/heads/main:${SHA_M}`;
let n = 0;
const coded = (code, message) => Object.assign(new Error(message), { code });

// A task in `integrating` whose head SHA_A was produced by dev-1; a scripted controller over the bridge's handle.
async function setup(script, { queue: realQueue = null, handleWrap = (h) => h, tasks = 1 } = {}) {
  const store = createTaskStore({ dir: path.join(TMP, `s${++n}`), ...clock() });
  const ids = [];
  for (let i = 0; i < tasks; i++) {
    const t = await store.createTask(spec({ goal: `task ${i}`, scope: { paths: ['.'] }, repository: '/repo/dev' }));
    for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating', 'integrating']) await store.transition(t.task_id, s, { actor: 'goal-loop' });
    await store.setHead(t.task_id, SHA_A, { actor: { role: 'developer', id: 'dev-1' } });
    ids.push(t.task_id);
  }
  const writes = [];
  const loopStore = handleWrap(Object.fromEntries(Object.entries(store).map(([k, v]) => [k, typeof v === 'function'
    ? (...a) => { if (!['get', 'list', 'events', 'independence', 'init', 'recover'].includes(k)) writes.push(k); return v.bind(store)(...a); } : v])));
  const items = new Map();
  const queue = realQueue || { get: async (id) => ({ ...items.get(id) }) };
  const calls = { submit: [], runNext: 0 };
  const effects = new Map();
  let ctl;
  let ci = { status: (sha) => ({ status: 'success', sha }) };
  const delivery = createDelivery({
    store, queue, repo: 'demo', target: 'main', ci: { status: (sha) => ci.status(sha) }, retryMs: 1234,
    git: async () => 'src/a.js\n',
    controller: ({ store: handle, approvals }) => (ctl = {
      handle, approvals,
      async submit(h) {
        calls.submit.push(h);
        const key = `${h.task_id}:${h.source_sha}:${h.target}`;
        if (realQueue) return { ok: true, item: await realQueue.enqueue(h, { idempotencyKey: key }) };
        if (!items.has(key)) items.set(key, { item_id: key, task_id: h.task_id, state: 'queued' });
        return { ok: true, item: { item_id: key } };
      },
      async runNext() { calls.runNext++; return script({ handle, approvals, items, ids, effects, n: ++n }); },
      async effectState(key) { return effects.has(key) ? effects.get(key) : null; },
    }),
  });
  const call = async (i = 0) => delivery.integrate(await store.get(ids[i]), { sha: SHA_A, worktree: { path: '/wt', branch: `v2task/${ids[i]}` }, idempotency_key: `integrate:${ids[i]}:${SHA_A}`, store: loopStore });
  return { store, ids, id: ids[0], delivery, call, calls, items, writes, effects, loopStore, ctl: () => ctl, setCi: (s) => { ci = s; } };
}
const itemOf = (items, id) => [...items.values()].find((x) => x.task_id === id);
const refuse = async (handle, task_id, required, items) => {
  await handle.append(task_id, { event_id: `req-${++n}`, kind: 'approval.requested', payload: { required, refused: true, integration_id: `int-${n}` } });
  await handle.transition(task_id, 'awaiting_approval', {});
  Object.assign(itemOf(items, task_id), { state: 'awaiting_approval', reason: 'approval required' });
};

test('DV1 delivery: an approval question is bound to the block at hand, not to an earlier request on the task log', async () => {
  const pushKey = approvalKey({ action: 'push', repo: 'demo', target: 'v2int/main', sha: SHA_M });
  let round = 0;
  const w = await setup(async ({ handle, items, ids: [id] }) => {
    if (++round === 1) { await refuse(handle, id, { action: 'push', class: 'push_shared', sha: SHA_M, target: 'v2int/main' }, items); return { outcome: 'awaiting_approval' }; }
    // Round 2: the target's policy now protects a path the diff touches: the controller parks the item without a request.
    await handle.transition(id, 'awaiting_approval', {});
    Object.assign(itemOf(items, id), { state: 'awaiting_approval', reason: 'protected_path', detail: { files: ['.ai/project.json'] } });
    return { outcome: 'awaiting_approval', reason: 'protected_path' };
  });
  const r1 = await w.call();
  assert.deepEqual([r1.next, r1.keys], ['awaiting_approval', [pushKey]]);
  await w.store.append(w.id, { event_id: `grant-${++n}`, kind: 'approval.granted', payload: { k: 1, actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'r', grants: { classes: ['push_shared'], keys: [pushKey], request_kind: 'integration' } } });
  const r2 = await w.call();
  assert.equal(r2.next, 'awaiting_approval');
  assert.ok(!r2.keys.includes(pushKey), `the push of ${SHA_M.slice(0, 8)} is already granted; this block is protected_path, got: ${r2.reason}`);
  assert.match(r2.reason, /protected_path/);
});

test('DV2 delivery: a merged item always leaves the loop something to wake on', async () => {
  // F8: the source was already in the target (merged by another lane or before a crash): no merge effect on this task.
  const f8 = await setup(async ({ handle, items, ids: [id] }) => {
    await handle.transition(id, 'release_verifying', {});
    Object.assign(itemOf(items, id), { state: 'merged', reason: 'already_in_target', detail: { target_sha: SHA_M } });
    return { outcome: 'already_merged', target_sha_before: SHA_M };
  });
  f8.effects.set(MKEY, 'confirmed');
  const r = await f8.call();
  assert.ok(!(r.next === 'release_verifying' && r.release_verified !== true), `dead end: ${JSON.stringify([r.next, r.release_verified, r.reason])}`);
  // A merged item whose CI read fails once: the loop needs a retry, not a terminal idle.
  const flaky = await setup(async ({ handle, items, ids: [id] }) => {
    await handle.recordEffect(id, { effect_id: 'r0:merge', idempotency_key: MKEY, kind: 'merge', phase: 'attempted' });
    await handle.recordEffect(id, { effect_id: 'r0:merge', phase: 'confirmed' });
    await handle.transition(id, 'release_verifying', {});
    Object.assign(itemOf(items, id), { state: 'merged', detail: { sha: SHA_M } });
    return { outcome: 'merged', integration_sha: SHA_M };
  });
  flaky.effects.set(MKEY, 'confirmed');
  flaky.setCi({ status: () => { throw new Error('status API 503'); } });
  const r2 = await flaky.call();
  assert.ok(!(r2.next === 'release_verifying' && r2.release_verified !== true), `dead end: ${JSON.stringify([r2.next, r2.release_verified, r2.reason])}`);
  assert.ok(r2.next === 'waiting' ? r2.retry_after_ms > 0 : true);
});

test('delivery: a displaced goal loop cannot push through the controller: the attempted-effect record is fenced by the loop handle and fails before the remote mutation', async () => {
  let pushed = 0;
  const w = await setup(async ({ handle, items, ids: [id] }) => {
    // The controller's own protocol: record attempted, then mutate the remote (casPush).
    await handle.recordEffect(id, { effect_id: 'r0:merge', idempotency_key: MKEY, kind: 'merge', phase: 'attempted' });
    pushed++;
    return { outcome: 'merged' };
  }, { handleWrap: (h) => ({ ...h, recordEffect: async () => { throw coded('E_CONTROLLER_LOST', 'controller lease fenced: no write'); } }) });
  const r = await w.call();
  assert.equal(pushed, 0, 'no remote mutation after the fenced write failed');
  assert.equal(r.next, 'waiting', 'no effect was attempted: retryable');
  assert.deepEqual((await w.store.get(w.id)).effects, [], 'nothing written under a lost lease');
});

test('DV3 delivery: the controller handle refuses every writing store method outside a hook call, including recover() and init()', async () => {
  const w = await setup(async () => ({ outcome: 'empty' }));
  await assert.rejects(w.ctl().handle.append(w.id, { event_id: 'x1', kind: 'task.blocked', payload: {} }), { code: 'E_NO_WRITER' });
  await assert.rejects(Promise.resolve().then(() => w.ctl().handle.recover()), { code: 'E_NO_WRITER' });
  await assert.rejects(Promise.resolve().then(() => w.ctl().handle.init()), { code: 'E_NO_WRITER' });
});

test('delivery: a batch run finishes another task\'s item; that task\'s transitions are not applied by this call, its own call maps its state from the queue item and its own log', async () => {
  const w = await setup(async ({ handle, items, ids: [a, b] }) => {
    for (const id of [a, b]) await refuse(handle, id, { action: 'merge', class: 'merge_protected', sha: SHA_M, target: 'main' }, items);
    return { outcome: 'awaiting_approval' };
  }, { tasks: 2 });
  const [a, b] = w.ids;
  // Task B is already queued when A's hook call runs the lane.
  await w.ctl().submit({ task_id: b, source_sha: SHA_A, target: 'main' });
  const ra = await w.call(0);
  assert.deepEqual(ra.proposals.map((p) => p.task_id), [a], 'only the calling task\'s proposals come back');
  assert.equal((await w.store.get(b)).status, 'integrating', 'B was not transitioned by A\'s call');
  assert.equal(itemOf(w.items, b).state, 'awaiting_approval');
  const rb = await w.call(1);
  assert.equal(w.calls.runNext, 2, 'a parked item is eligible again: B\'s call runs the lane once more (both items re-refused)');
  assert.deepEqual([rb.next, rb.keys], ['awaiting_approval', [approvalKey({ action: 'merge', repo: 'demo', target: 'main', sha: SHA_M })]]);
  assert.deepEqual(rb.proposals.map((p) => p.task_id), [b]);
  assert.equal((await w.store.get(a)).status, 'integrating', 'A is not transitioned by B\'s call either: the loop applies its own');
});

test('DV4 delivery: with the real queue (which re-queues a FINAL key on enqueue) a SHA already merged is not handed off or run again', async () => {
  const q = createIntegrationQueue({ dir: path.join(TMP, `q${++n}`) });
  const w = await setup(async ({ handle, ids: [id] }) => {
    const [it] = await q.peek('demo', 'main');
    await q.start([it.item_id], { owner: 'ctl' });
    await handle.recordEffect(id, { effect_id: 'r0:merge', idempotency_key: MKEY, kind: 'merge', phase: 'attempted' });
    await handle.recordEffect(id, { effect_id: 'r0:merge', phase: 'confirmed' });
    await q.finish(it.item_id, 'merged', { detail: { sha: SHA_M } });
    return { outcome: 'merged' };
  }, { queue: q });
  w.effects.set(MKEY, 'confirmed');
  assert.equal((await w.call()).next, 'release_verifying');
  const again = await w.call();
  assert.equal(w.calls.runNext, 1, `a merged item is not run again (second call: ${again.next}, ${again.reason})`);
  assert.equal((await q.list({ repo: 'demo' })).length, 1, 'same task/sha/target -> same queue item');
});

// ---- real controller, disposable remote: crash between the merge push and its confirmation --------------------
const sb = sandbox('v2-delivery-verify-');
const OWNER = { role: 'owner', id: 'owner-1' };
const DELIVER = { review_policy: { mode: 'goal_loop', independent_review: true, deliver: true }, scope: { paths: ['src', 'test'] } };

test('delivery/T30/T07: the controller process dies right after its merge push (effect still attempted): the restarted loop reconciles from the remote, never pushes again, and accepts', async () => {
  const o = mkOrigin(sb);
  const ci = fakeRemoteCi(o);
  const box = {};
  const integrate = (...a) => box.hook(...a);
  integrate.reconcile = (...a) => box.hook.reconcile(...a);
  let dead = false;
  // The controller's settle('confirmed') for the merge is the crash point: from then on the process writes nothing.
  const WRITES = ['createTask', 'append', 'transition', 'setHead', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'snapshotPolicy'];
  const crashing = (s) => ({ ...s, ...Object.fromEntries(WRITES.map((k) => [k, async (...a) => {
    if (k === 'recordEffect' && a[1]?.kind === 'merge' && a[1].phase === 'confirmed') dead = true;
    if (dead) throw coded('E_TEST_CRASH', 'process died');
    return s[k](...a);
  }])) });
  const env = world(sb, { repo: { dir: o.repo, sha: o.sha }, dev: [GOOD], rev: [APPROVE], loopOpts: { integrate }, storeWrap: crashing });
  const c = makeDelivery(sb, o, { store: env.store, ci });
  box.hook = c.integrate;
  const before = o.head();
  const id = (await env.submit(DELIVER)).task_id;
  const approve = async () => {
    const asked = (await env.view(id)).decisions.filter((d) => d.loop?.patch?.approval).at(-1).loop.patch.approval;
    const req = c.runs.filter((r) => r.outcome === 'awaiting_approval').at(-1).required;
    assert.deepEqual(asked.keys, [`integration:${req.action}:demo:${req.target}:${req.sha}`]);
    await env.loop.approve(id, { actor: OWNER, approval_ref: `ok-${req.sha.slice(0, 8)}`, grants: { classes: [req.class] } });
    return req;
  };
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  await approve();                                                   // candidate push
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  const S = (await approve()).sha;                                   // merge of S
  const crashed = await env.loop.run(id).catch((e) => e);
  assert.equal(crashed.code, 'E_TEST_CRASH', 'the merge landed, the confirmation never did');
  assert.equal(o.head(), S, 'remote main took the merge');
  const pushesBefore = sb.sh(o.dir, '--git-dir', o.origin, 'rev-list', '--count', `${before}..refs/heads/main`);

  env.reopen();                                                      // new process over the same state dir
  const rec = await env.loop.recover();
  assert.equal((await env.view(id)).status, 'unknown_external_effect');
  assert.ok(rec.pendingEffects.length >= 1);
  const r = await env.loop.run(id);
  assert.equal(r.state, 'accepted');
  const v = await env.view(id);
  const merges = v.effects.filter((e) => e.kind === 'merge');
  assert.deepEqual(merges.map((e) => e.phase), ['confirmed'], 'the open merge effect was reconciled from the remote, not repeated');
  assert.ok(v.effects.every((e) => e.phase === 'confirmed' || e.phase === 'failed'), JSON.stringify(v.effects.map((e) => [e.effect_id, e.phase])));
  assert.equal(o.head(), S, 'main did not move again');
  assert.equal(sb.sh(o.dir, '--git-dir', o.origin, 'rev-list', '--count', `${before}..refs/heads/main`), pushesBefore, 'no second push');
  assert.equal(sb.sh(o.dir, '--git-dir', o.origin, 'rev-list', '--merges', '--count', `${before}..refs/heads/main`), '1', 'exactly one merge commit');
  assert.ok(states(v).includes('unknown_external_effect') && states(v).at(-1) === 'accepted');
  const actors = [...new Set(v.history.map((h) => JSON.stringify(h.actor)))];
  assert.ok(v.history.every((h) => h.actor === 'goal-loop' || h.to === 'unknown_external_effect'), `only the store's own recovery transition has another actor: ${actors.join(' ')}`);
  assert.ok(c.runs.some((x) => x.outcome === 'already_merged' || x.item_state === 'merged'), JSON.stringify(c.runs.map((x) => x.outcome)));
  assert.equal(new Set(env.events(id).map((e) => e.event_id)).size, env.events(id).length, 'no duplicate event');
});
