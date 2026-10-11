// Independent verification round 4: `adoptOwn(resource, { owner, task_id })` added on v2/05-goal-loop (abe580e).
// Tests marked `todo: 'defect: ...'` assert the behaviour the lease authority should have and report as todo until fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-lease-verify4-'));
const R = 'repo:demo:integration';
const W = 'worktree:task-4';
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const clock = (t = 1_800_000_000_000) => { const c = () => c.t; c.t = t; return c; };

for (const kind of ['fake', 'file']) {
  test(`adoptOwn (${kind}): only the live lease of exactly this owner+task; token unchanged; free/expired/foreign/invalid/unavailable rejected`, async () => {
    const c = clock();
    const dir = await tmp();
    const backend = kind === 'fake' ? fakeBackend({ now: c }) : fileBackend({ dir, now: c });
    const auth = createLeaseAuthority({ backend, now: c });
    const id = { owner: 'goal-loop', task_id: 'task-4' };
    assert.equal((await auth.adoptOwn(W, id)).code, 'E_FENCED', 'free resource');
    const a = await auth.acquire(W, { ...id, ttl_ms: 1000, scope: 'worktree' });
    assert.ok(a.ok);
    assert.equal((await auth.adoptOwn(W, { owner: 'someone-else', task_id: 'task-4' })).code, 'E_FENCED');
    assert.equal((await auth.adoptOwn(W, { owner: 'goal-loop', task_id: 'task-5' })).code, 'E_FENCED');
    assert.equal((await auth.adoptOwn(W, { owner: 'goal-loop' })).code, 'E_INVALID');
    assert.equal((await auth.adoptOwn('nope', id)).code, 'E_INVALID');
    const own = await auth.adoptOwn(W, id);
    assert.ok(own.ok);
    assert.deepEqual(own.lease, a.lease, 'adoption returns the very same lease (same lease_id and token)');
    assert.deepEqual(await auth.validate(own.lease), { ok: true });
    assert.ok((await auth.renew(own.lease)).ok);
    c.t += 2000;
    assert.equal((await auth.adoptOwn(W, id)).code, 'E_EXPIRED');
    if (kind === 'fake') {
      backend.setFail('unavailable');
      assert.equal((await auth.adoptOwn(W, id)).code, 'E_UNAVAILABLE');
      backend.setFail(null);
      assert.ok(backend.auditLog.some((e) => e.op === 'adopt_own' && e.lease_id === a.lease.lease_id && e.owner === 'goal-loop'));
    }
  });
}

test('adoptOwn: a lease with no task_id can never be adopted (task_id is required on both sides)', async () => {
  const auth = createLeaseAuthority({ backend: fakeBackend() });
  const a = await auth.acquire(R, { owner: 'ops', ttl_ms: 60_000 });
  assert.ok(a.ok);
  assert.equal(a.lease.task_id, null);
  assert.equal((await auth.adoptOwn(R, { owner: 'ops', task_id: 'null' })).code, 'E_FENCED');
  assert.equal((await auth.adoptOwn(R, { owner: 'ops', task_id: '' })).code, 'E_INVALID');
});

test('adoptOwn: the identity it needs is exactly what E_HELD hands to any caller -> two calls take over a live integration lease',
  { todo: 'defect (medium): adoptOwn accepts self-declared owner+task_id, which the authority itself discloses to every contender in E_HELD.holder; any caller can therefore adopt (then release, or act under) any live lease in any namespace with two calls, which plain acquire never allowed. Limit adoptOwn to worktree:<task_id> (the only namespace whose trust model is the owner name, and where task_id is part of the resource) or replace it with a write-ahead lease_id + the existing adopt(attempted)' },
  async () => {
    const backend = fakeBackend();
    const auth = createLeaseAuthority({ backend });
    const held = await auth.acquire(R, opts('integration-agent'));
    assert.ok(held.ok);
    const probe = await auth.acquire(R, opts('stranger'));              // what any contender learns
    assert.equal(probe.code, 'E_HELD');
    const stolen = await auth.adoptOwn(R, { owner: probe.holder.owner, task_id: probe.holder.task_id });
    assert.equal(stolen.ok, false, `a non-worktree lease was adopted from E_HELD data: ${JSON.stringify(stolen)}`);
    // consequences when it succeeds: the holder is fenced without anyone having acquired, and the slot is free
    assert.deepEqual(await auth.validate(held.lease), { ok: true });
    assert.equal((await auth.acquire(R, opts('stranger'))).code, 'E_HELD');
  });

test('adoptOwn: two controllers under one owner name and task -> adoption hands the twin\'s live lease to the first, both pass validate',
  { todo: 'defect (medium): a replacement controller (same owner, same task_id) that legitimately acquired after the original\'s lease lapsed is indistinguishable from "my own lost lease"; the original adopts the twin\'s lease and both executors then pass fence.check(). Adoption should be a fenced takeover (atomic update: new lease_id, generation+1, audited from/to) so that at most one handle stays valid, or should require a write-ahead lease_id' },
  async () => {
    const c = clock();
    const backend = fakeBackend({ now: c });
    const A = createLeaseAuthority({ backend, now: c });
    const B = createLeaseAuthority({ backend, now: c });
    const id = { owner: 'goal-loop', task_id: 'task-4' };
    const a = await A.acquire(W, { ...id, ttl_ms: 1000, scope: 'worktree' });       // original controller, then it hangs
    c.t += 1500;                                                                    // its lease lapses
    const b = await B.acquire(W, { ...id, ttl_ms: 60_000, scope: 'worktree' });     // operator starts a replacement
    assert.ok(b.ok);
    assert.equal(b.lease.token, a.lease.token + 1);
    assert.equal((await A.validate(a.lease)).code, 'E_FENCED', 'the original is correctly fenced...');
    const adopted = await A.adoptOwn(W, id);                                        // ...until it adopts
    const aOk = adopted.ok && (await A.validate(adopted.lease)).ok;
    const bOk = (await B.validate(b.lease)).ok;
    assert.ok(!(aOk && bOk), 'two executors hold valid handles to one worktree lease');
  });

test('adoptOwn: rejected attempts are audited with the claimed identity',
  { todo: 'defect (low): acquire/renew/release/validate audit every denial, adoptOwn (and adopt) audit only success; failed adoptions are the spoofing signal and leave no trace' },
  async () => {
    const backend = fakeBackend();
    const auth = createLeaseAuthority({ backend });
    await auth.acquire(W, { owner: 'goal-loop', task_id: 'task-4', ttl_ms: 60_000 });
    await auth.adoptOwn(W, { owner: 'mallory', task_id: 'task-4' });
    assert.ok(backend.auditLog.some((e) => e.op === 'denied' && e.action === 'adopt_own' && e.owner === 'mallory'), JSON.stringify(backend.auditLog));
  });

test('adoptOwn handle: identity-checked like any lease; releasing it frees the slot and the original handle is fenced; withLeases unaffected', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  const id = { owner: 'goal-loop', task_id: 'task-4' };
  const a = await auth.acquire(W, { ...id, ttl_ms: 60_000 });
  const own = await auth.adoptOwn(W, id);
  assert.ok((await auth.release(own.lease)).ok);
  assert.equal((await auth.validate(a.lease)).code, 'E_FENCED');
  assert.equal((await auth.adoptOwn(W, id)).code, 'E_FENCED', 'never a free resource');
  // withLeases/acquireAll never adopt: a held later resource still rolls back and nothing is adopted on the way
  await auth.acquire('worktree:task-5', { owner: 'goal-loop', task_id: 'task-5', ttl_ms: 60_000 });
  const r = await auth.withLeases([W, 'worktree:task-5'], { owner: 'goal-loop', task_id: 'task-5', ttl_ms: 60_000 }, async () => 'ran');
  assert.equal(r.code, 'E_HELD');
  assert.equal(backend.records.get(W).holder, null);
  assert.ok(!backend.auditLog.some((e) => e.op === 'adopt_own' && e.resource === 'worktree:task-5'));
});
