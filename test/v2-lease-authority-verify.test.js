// Independent verification of orchestration/lease-authority.js (package v2/08). Adversarial cases the author's suite
// does not cover. The defect tests (F1-F4) reproduce the original defects deterministically (fs hooks instead of
// timing) and assert the correct behaviour; they were `todo` until the fixes landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, unlink, readdir } from 'node:fs/promises';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-lease-verify-'));
const R = 'repo:demo:integration';
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// A gate: `at` resolves when the hooked call arrives, `go()` lets it through.
function gate() {
  const g = {};
  g.at = new Promise((r) => { g.arrive = r; });
  g.open = new Promise((r) => { g.go = r; });
  return g;
}
const pause = async (g) => { g.arrive(); await g.open; };

// Real fs with `open`/`rename`/`link` interceptable per call (fileBackend uses fs.promises.*).
function hookedFs(hooks = {}) {
  const base = realFs.promises;
  const wrap = (name) => async (...args) => { if (hooks[name]) await hooks[name](...args); return base[name](...args); };
  return { promises: { ...base, open: wrap('open'), rename: wrap('rename'), link: wrap('link') } };
}

// --- stale-lock breaking ---------------------------------------------------------------------------------------------

test('two stale-lock breakers: the slower one moves a fresh lock, a third locker enters, two acquires commit one generation',
  async (t) => {
    const dir = await tmp();
    const lp = join(dir, `${encodeURIComponent(R)}.lock`);
    await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 1 }));          // lock left by a crashed process
    const old = new Date(Date.now() - 3_600_000);
    await utimes(lp, old, old);
    const yRename = gate(), yLink = gate(), xWrite = gate();
    const mk = (fs) => createLeaseAuthority({ backend: fileBackend({ dir, fs, staleLockMs: 1000, lockWaitMs: 300 }) });
    const Y = mk(hookedFs({ rename: async (from) => { if (from === lp) await pause(yRename); }, link: () => pause(yLink) }));
    const X = mk(hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(xWrite); } }));
    const W = mk(undefined);

    const py = Y.acquire(R, opts('y'));
    await yRename.at;                       // Y judged the crashed lock stale (stat'd it) and is about to rename it away
    await unlink(lp);                       // breaker X was faster: the crashed lock is gone...
    const px = X.acquire(R, opts('x'));     // ...X holds a fresh lock, passed its pre-commit nonce check, is writing
    await xWrite.at;
    yRename.go();                           // Y renames X's fresh lock away, sees the mismatch, goes to restore it
    await yLink.at;
    const w = await W.acquire(R, opts('w'));  // W takes the free slot, reads "no record", commits generation 1
    xWrite.go();
    const x = await px;                     // X commits generation 1 too
    yLink.go();
    const y = await py;

    assert.equal(y.ok, false);
    // observe everything first so a failure shows the whole picture, then assert the correct behaviour
    const winners = [x, w].filter((r) => r.ok);
    const locks = (await readdir(dir)).filter((f) => f.endsWith('.lock'));
    const wv = await W.validate(w.lease), xv = await X.validate(x.lease);
    const rel = x.ok ? await X.release(x.lease) : null;
    t.diagnostic(`observed: winners=${winners.map((r) => `${r.lease.owner}#${r.lease.token}`)} validate(w)=${wv.code || 'ok'} validate(x)=${xv.code || 'ok'} leftover locks=${locks.length} release(x)=${rel?.code || (rel && 'ok')}`);
    assert.equal(winners.length, 1, `exactly one acquire may succeed, got ${JSON.stringify([x, w])}`);
    // the holder must be able to release: no orphan lock file may survive the break
    assert.equal(locks.length, 0);
    assert.deepEqual(rel, { ok: true });
  });

test('stale-lock break is serialized: a breaker never touches a lock created after it judged the old one stale', async () => {
  // Benign ordering of the same race (W does not arrive in the window): the restored lock belongs to a live locker,
  // who unlocks it normally; nothing leaks. Documents the mechanism the defect test relies on.
  const dir = await tmp();
  const lp = join(dir, `${encodeURIComponent(R)}.lock`);
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 1 }));
  const old = new Date(Date.now() - 3_600_000);
  await utimes(lp, old, old);
  const yRename = gate(), xWrite = gate();
  const mk = (fs) => createLeaseAuthority({ backend: fileBackend({ dir, fs, staleLockMs: 1000, lockWaitMs: 300 }) });
  const Y = mk(hookedFs({ rename: async (from) => { if (from === lp) await pause(yRename); } }));
  const X = mk(hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(xWrite); } }));
  const py = Y.acquire(R, opts('y'));
  await yRename.at;
  await unlink(lp);
  const px = X.acquire(R, opts('x'));
  await xWrite.at;
  yRename.go();
  await nap(50);                            // Y moved X's lock and put it back (link) before anyone else arrived
  xWrite.go();
  const x = await px;
  const y = await py;
  assert.ok(x.ok);
  assert.equal(y.ok, false);
  assert.equal((await readdir(dir)).filter((f) => f.endsWith('.lock') || f.includes('.broken-')).length, 0);
  assert.deepEqual(await X.release(x.lease), { ok: true });
});

// --- timeouts ----------------------------------------------------------------------------------------------------------

test('acquire that times out but commits later: the caller holds a lease it was told it does not hold, with no handle to release it',
  async () => {
    const inner = fakeBackend();
    const g = gate();
    const backend = { ...inner, async update(...a) { await pause(g); return inner.update(...a); } };
    const auth = createLeaseAuthority({ backend, opTimeoutMs: 20 });
    const r = await auth.acquire(R, opts('a', { ttl_ms: 3_600_000 }));
    assert.equal(r.code, 'E_UNAVAILABLE');
    g.go();
    await nap(10);
    assert.equal(inner.records.get(R).holder.owner, 'a', 'the backend committed the timed-out acquire');
    // correct: either the failure carries the attempted lease_id so the owner can validate/release, or the same
    // owner+task_id can adopt its own ghost; today the owner is E_HELD by itself and has nothing to release
    const again = await auth.acquire(R, opts('a', { ttl_ms: 3_600_000 }));
    assert.ok(again.ok || r.lease_id, `owner locked out by its own ghost lease: ${JSON.stringify(again)}`);
  });

test('acquire that times out but commits later is at least fail-closed: nobody else gets the resource', async () => {
  const inner = fakeBackend();
  const g = gate();
  const backend = { ...inner, async update(...a) { await pause(g); return inner.update(...a); } };
  const auth = createLeaseAuthority({ backend, opTimeoutMs: 20 });
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  g.go();
  await nap(10);
  const b = await auth.acquire(R, opts('b'));
  assert.equal(b.code, 'E_HELD');
  assert.equal(b.holder.owner, 'a');
});

// --- audit provenance --------------------------------------------------------------------------------------------------

test('audit append fails but the lease is still granted: provenance is lost silently (alert only)',
  async () => {
    const dir = await tmp();
    const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    const fs = hookedFs({ open: async (p) => { if (String(p).endsWith('audit.jsonl')) throw enospc; } });
    const alerts = [];
    const auth = createLeaseAuthority({ backend: fileBackend({ dir, fs }), alert: (a) => alerts.push(a) });
    const r = await auth.acquire(R, opts('a'));
    assert.ok(alerts.some((a) => a.kind === 'audit_failed'));
    assert.equal(r.ok, false, 'a lease without provenance must not be granted');
    assert.equal(r.code, 'E_UNAVAILABLE');
  });

test('audit append failure: nothing is granted, so the lost-record guard cannot be bypassed', async () => {
  // Policy (F3): the acquire audit line is written inside the critical section before the record; if it cannot be
  // written the grant is refused, the resource never gets a record without provenance, and generations never restart.
  const dir = await tmp();
  const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  let broken = false;
  const fs = hookedFs({ open: async (p) => { if (broken && String(p).endsWith('audit.jsonl')) throw enospc; } });
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, fs }), alert: () => {} });
  const a = await auth.acquire(R, opts('a'));
  assert.ok(a.ok);
  assert.ok((await auth.release(a.lease)).ok);
  broken = true;
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
  broken = false;
  await unlink(join(dir, `${encodeURIComponent(R)}.lease.json`));
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE', 'record lost after history: never restart at token 1');
});

// --- clocks ------------------------------------------------------------------------------------------------------------

test('non-finite authority clock must fail closed, not displace a live holder',
  async () => {
    const backend = fakeBackend();
    const good = createLeaseAuthority({ backend });
    const held = await good.acquire(R, opts('a'));
    const broken = createLeaseAuthority({ backend, now: () => NaN });
    const r = await broken.acquire(R, opts('b'));
    assert.equal(r.ok, false, 'a broken clock took over a live lease');
    assert.deepEqual(await good.validate(held.lease), { ok: true });
  });

// --- confirmations (no defect) -----------------------------------------------------------------------------------------

test('fence handle retained after withLeases returns is dead: check/renew/release all E_FENCED, re-acquire gets a new token', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  let f;
  const r = await auth.withLeases([R], opts('a'), async (fence) => { f = fence; await fence.check(); return 1; });
  assert.ok(r.ok);
  await assert.rejects(f.check(), { code: 'E_FENCED' });
  await assert.rejects(f.renew(), { code: 'E_FENCED' });
  assert.equal((await auth.release(f.leases[0])).code, 'E_FENCED');
  const again = await auth.acquire(R, opts('a'));
  assert.ok(again.ok);
  assert.equal(again.lease.token, f.leases[0].token + 1);
  await assert.rejects(f.check(), { code: 'E_FENCED' }, 'old handle stays fenced after the same owner re-acquires');
  assert.equal((await auth.release(f.leases[0])).code, 'E_FENCED', 'old handle cannot release the new lease');
  assert.deepEqual(await auth.validate(again.lease), { ok: true });
});

test('no owner-based re-entrancy: the holder itself gets E_HELD on a second acquire', async () => {
  const auth = createLeaseAuthority({ backend: fakeBackend() });
  const a = await auth.acquire(R, opts('a'));
  const b = await auth.acquire(R, opts('a'));
  assert.equal(b.code, 'E_HELD');
  assert.equal(b.holder.owner, 'a');
  assert.deepEqual(await auth.validate(a.lease), { ok: true });
});

test('fenced former owner cannot release or renew after takeover; the new holder is untouched (file backend)', async () => {
  const dir = await tmp();
  const c = { t: 1_800_000_000_000 };
  const now = () => c.t;
  const A = createLeaseAuthority({ backend: fileBackend({ dir, now }), now });
  const B = createLeaseAuthority({ backend: fileBackend({ dir, now }), now });
  const a = await A.acquire(R, opts('a', { ttl_ms: 1000 }));
  c.t += 1000;
  const b = await B.acquire(R, opts('b'));
  assert.ok(b.ok);
  for (const forged of [a.lease, { ...a.lease, token: b.lease.token }, { ...a.lease, lease_id: b.lease.lease_id }]) {
    assert.equal((await A.release(forged)).code, 'E_FENCED');
    assert.equal((await A.renew(forged)).code, 'E_FENCED');
  }
  assert.deepEqual(await B.validate(b.lease), { ok: true });
  assert.ok((await B.release(b.lease)).ok);
});

test('acquireAll: a timed-out middle resource is not left held by the caller\'s own ghost after rollback', async () => {
  // The rollback also tries adopt() on the timed-out resource; here that read times out as well, so a lease the
  // backend commits afterwards is a ghost until TTL. This pins the fail-closed half: nothing the caller was told it
  // holds survives rollback.
  const inner = fakeBackend();
  let slow = true;
  const g = gate();
  const backend = { ...inner, async update(res, ...a) { if (slow && res === 'repo:demo:main') await pause(g); return inner.update(res, ...a); } };
  const auth = createLeaseAuthority({ backend, opTimeoutMs: 20 });
  const r = await auth.acquireAll([R, 'repo:demo:main'], opts('a'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_UNAVAILABLE');
  assert.equal(r.resource, 'repo:demo:main');
  assert.equal(inner.records.get(R).holder, null, 'the first resource was rolled back');
  slow = false; g.go(); await nap(10);
  assert.equal(inner.records.get('repo:demo:main').holder?.owner, 'a', 'ghost: committed after the caller gave up');
});

test('resource names never escape the backend directory', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  for (const r of ['repo:org/demo:main', 'worktree:task.1', 'service:node-a:web', 'host:n_1:maintenance', 'environment:st-aging:deploy']) {
    assert.ok((await auth.acquire(r, opts('a'))).ok, r);
  }
  for (const r of ['repo:../x:main', 'repo:a/../b:main', 'worktree:.', 'worktree:..', 'worktree:a/b', 'repo:%2e%2e:main', 'repo:a:main\n', 'repo:a\u0000:main']) {
    assert.equal((await auth.acquire(r, opts('a'))).code, 'E_INVALID', JSON.stringify(r));
  }
  const names = await readdir(dir);
  assert.ok(names.every((n) => !n.includes('/') && !n.startsWith('..')), names.join(','));
  assert.equal(names.filter((n) => n.endsWith('.lease.json')).length, 5);
});

test('validate never takes the lock and is unaffected by a live critical section elsewhere', async () => {
  const dir = await tmp();
  const g = gate();
  const slow = createLeaseAuthority({ backend: fileBackend({ dir, fs: hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(g); } }), lockWaitMs: 200 }) });
  const fast = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 200 }) });
  const a = await fast.acquire(R, opts('a'));
  const pr = slow.renew(a.lease);          // holds the lock, stalled before the commit
  await g.at;
  assert.deepEqual(await fast.validate(a.lease), { ok: true });
  assert.equal((await fast.acquire(R, opts('b'))).code, 'E_UNAVAILABLE', 'lock busy fails closed, not free');
  g.go();
  assert.ok((await pr).ok);
});
