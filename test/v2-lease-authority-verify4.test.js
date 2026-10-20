// Independent verification round 4 (lease verifier on abe580e), adapted to coordinator decision D-015: adoptOwn is
// removed; acquire() takes an optional caller-supplied lease_id (write-ahead), and crash recovery uses the existing
// adopt(attempted) with that private id. The three findings are kept as hard assertions against the new design.
import test from 'node:test';
import assert from 'node:assert/strict';


import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';
import { tmp as mkTmp } from './helpers-tmp.js';

const tmp = () => mkTmp('v2-lease-verify4-');
const R = 'repo:demo:integration';
const W = 'worktree:task-4';
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const clock = (t = 1_800_000_000_000) => { const c = () => c.t; c.t = t; return c; };

for (const kind of ['fake', 'file']) {
  test(`D-015 (${kind}): caller-supplied lease_id is validated, granted once, never reused; adopt() needs exactly it`, async () => {
    const c = clock();
    const dir = await tmp();
    const backend = kind === 'fake' ? fakeBackend({ now: c }) : fileBackend({ dir, now: c });
    const auth = createLeaseAuthority({ backend, now: c });
    const id = { owner: 'goal-loop', task_id: 'task-4' };
    assert.equal((await auth.acquire(W, { ...id, ttl_ms: 1000, lease_id: 'short' })).code, 'E_INVALID');
    assert.equal((await auth.acquire(W, { ...id, ttl_ms: 1000, lease_id: 'bad id with spaces!!' })).code, 'E_INVALID');
    const lid = 'wt-intent-0000000000000001';
    const a = await auth.acquire(W, { ...id, ttl_ms: 1000, scope: 'worktree', lease_id: lid });
    assert.ok(a.ok);
    assert.equal(a.lease.lease_id, lid);
    // recovery after a crash between acquire and persisting the lease: the persisted (private) id adopts it
    const own = await auth.adopt({ resource: W, lease_id: lid, ...id });
    assert.ok(own.ok);
    assert.deepEqual(own.lease, a.lease, 'adoption returns the very same lease (same lease_id and token)');
    assert.deepEqual(await auth.validate(own.lease), { ok: true });
    c.t += 2000;
    assert.equal((await auth.adopt({ resource: W, lease_id: lid, ...id })).code, 'E_EXPIRED');
    assert.equal((await auth.acquire(W, { ...id, ttl_ms: 1000, lease_id: lid })).code, 'E_INVALID', 'a granted lease_id is never granted again');
    const b = await auth.acquire(W, { ...id, ttl_ms: 1000, lease_id: 'wt-intent-0000000000000002' });
    assert.ok(b.ok);
    assert.equal(b.lease.token, a.lease.token + 1);
    if (kind === 'fake') {
      backend.setFail('unavailable');
      assert.equal((await auth.adopt({ resource: W, lease_id: 'wt-intent-0000000000000002', ...id })).code, 'E_UNAVAILABLE');
      backend.setFail(null);
    }
  });
}

test('finding 1: no API hands a contender a live lease from the owner/task_id that E_HELD discloses', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  assert.equal(auth.adoptOwn, undefined, 'adoptOwn is removed (D-015)');
  const held = await auth.acquire(R, opts('integration-agent'));
  assert.ok(held.ok);
  const probe = await auth.acquire(R, opts('stranger'));              // what any contender learns
  assert.equal(probe.code, 'E_HELD');
  assert.equal(probe.holder.lease_id, undefined, 'E_HELD never discloses the private lease_id');
  // adopt() needs the private lease_id: the disclosed identity plus a guessed id is fenced
  for (const guess of [undefined, 'guessed-lease-id-000001', `${probe.holder.owner}-lease-0001`]) {
    const stolen = await auth.adopt({ resource: R, owner: probe.holder.owner, task_id: probe.holder.task_id, lease_id: guess });
    assert.equal(stolen.ok, false, `adopted with lease_id ${guess}`);
  }
  assert.deepEqual(await auth.validate(held.lease), { ok: true });
  assert.equal((await auth.acquire(R, opts('stranger'))).code, 'E_HELD');
});

test('finding 2: a twin controller (same owner and task, its own write-ahead id) stays fenced; at most one handle is valid', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const A = createLeaseAuthority({ backend, now: c });
  const B = createLeaseAuthority({ backend, now: c });
  const id = { owner: 'goal-loop', task_id: 'task-4' };
  const aId = 'wt-intent-a-000000000001', bId = 'wt-intent-b-000000000001';
  const a = await A.acquire(W, { ...id, ttl_ms: 1000, scope: 'worktree', lease_id: aId });   // original controller, then it hangs
  c.t += 1500;                                                                             // its lease lapses
  const b = await B.acquire(W, { ...id, ttl_ms: 60_000, scope: 'worktree', lease_id: bId }); // replacement
  assert.ok(b.ok);
  assert.equal((await A.validate(a.lease)).code, 'E_FENCED');
  const adopted = await A.adopt({ resource: W, lease_id: aId, ...id });                    // A's persisted id
  assert.equal(adopted.ok, false, 'the original cannot adopt the twin');
  assert.equal(adopted.code, 'E_FENCED');
  const aOk = adopted.ok && (await A.validate(adopted.lease)).ok;
  const bOk = (await B.validate(b.lease)).ok;
  assert.ok(bOk && !aOk, 'exactly one executor holds a valid handle');
});

test('finding 3: rejected adopt() attempts are audited as denied with the claimed identity', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  await auth.acquire(W, { owner: 'goal-loop', task_id: 'task-4', ttl_ms: 60_000, lease_id: 'wt-intent-real-00000001' });
  await auth.adopt({ resource: W, owner: 'mallory', task_id: 'task-4', lease_id: 'wt-intent-guess-0000001' });
  const e = backend.auditLog.find((x) => x.op === 'denied' && x.action === 'adopt' && x.owner === 'mallory');
  assert.ok(e, JSON.stringify(backend.auditLog));
  assert.equal(e.task_id, 'task-4');
  assert.equal(e.code, 'E_FENCED');
  assert.ok(!JSON.stringify(backend.auditLog).includes('wt-intent-guess'), 'the claimed lease_id is not written to the audit');
});

test('adopted handle: identity-checked like any lease; releasing it frees the slot and fences the original; withLeases never adopts', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  const id = { owner: 'goal-loop', task_id: 'task-4' };
  const lid = 'wt-intent-rel-000000001';
  const a = await auth.acquire(W, { ...id, ttl_ms: 60_000, lease_id: lid });
  const own = await auth.adopt({ resource: W, lease_id: lid, ...id });
  assert.ok((await auth.release(own.lease)).ok);
  assert.equal((await auth.validate(a.lease)).code, 'E_FENCED');
  assert.equal((await auth.adopt({ resource: W, lease_id: lid, ...id })).code, 'E_FENCED', 'never a free resource');
  await auth.acquire('worktree:task-5', { owner: 'goal-loop', task_id: 'task-5', ttl_ms: 60_000 });
  const r = await auth.withLeases([W, 'worktree:task-5'], { owner: 'goal-loop', task_id: 'task-5', ttl_ms: 60_000 }, async () => 'ran');
  assert.equal(r.code, 'E_HELD');
  assert.equal(backend.records.get(W).holder, null);
  assert.ok(!backend.auditLog.some((e) => e.op === 'adopt' && e.resource === 'worktree:task-5'));
});
