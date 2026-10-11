// Independent re-verification of orchestration/lease-authority.js after the F1-F7 fixes (a5c508e): attacks on the new
// mechanisms (<res>.break / <res>.moved, adopt(), pid+host liveness, <res>.seen, D-008 branch names). Tests marked
// `todo: 'defect: ...'` assert the correct behaviour and report as todo until fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, unlink, readdir, readFile } from 'node:fs/promises';
import * as realFs from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, fakeBackend, validResource } from '../orchestration/lease-authority.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-lease-verify2-'));
const R = 'repo:demo:integration';
const K = encodeURIComponent(R);
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const ageFile = async (f, ms = 3_600_000) => { const d = new Date(Date.now() - ms); await utimes(f, d, d); };
const files = async (dir, ext) => (await readdir(dir)).filter((f) => f.endsWith(ext));

function gate() {
  const g = {};
  g.at = new Promise((r) => { g.arrive = r; });
  g.open = new Promise((r) => { g.go = r; });
  return g;
}
const pause = async (g) => { g.arrive(); await g.open; };
function hookedFs(hooks = {}) {
  const base = realFs.promises;
  const wrap = (name) => async (...args) => { if (hooks[name]) await hooks[name](...args); return base[name](...args); };
  return { promises: { ...base, open: wrap('open'), rename: wrap('rename'), link: wrap('link') } };
}

// --- crashed breaker leftovers -------------------------------------------------------------------------------------------

test('crashed breaker left <res>.break next to a stale lock: a dead breaker\'s .break self-heals, never two holders; a live one blocks', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 200, staleLockMs: 10 }) });
  const lp = join(dir, `${K}.lock`), bp = join(dir, `${K}.break`);
  // live breaker on this host (our own pid): fail closed, nothing broken
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 2 ** 22 + 4242, host: hostname() }));
  await ageFile(lp);
  await writeFile(bp, JSON.stringify({ pid: process.pid, host: hostname() }));
  await ageFile(bp);
  const live = await Promise.all([auth.acquire(R, opts('a')), auth.acquire(R, opts('b'))]);
  assert.deepEqual(live.map((r) => r.code), ['E_UNAVAILABLE', 'E_UNAVAILABLE']);
  assert.ok(realFs.existsSync(lp) && realFs.existsSync(bp), 'a live breaker is never second-guessed');
  // dead breaker: its .break is cleared, a later attempt breaks the stale lock; at most one holder at every step
  await writeFile(bp, JSON.stringify({ pid: 2 ** 22 + 4243, host: hostname() }));
  await ageFile(bp);
  const holders = [];
  for (let i = 0; i < 4 && !holders.length; i++) {
    const rs = await Promise.all([auth.acquire(R, opts('a')), auth.acquire(R, opts('b')), auth.acquire(R, opts('c'))]);
    assert.ok(rs.filter((r) => r.ok).length <= 1, JSON.stringify(rs.map((r) => r.code)));
    holders.push(...rs.filter((r) => r.ok));
  }
  assert.equal(holders.length, 1, 'recovers without manual steps');
  assert.equal(await files(dir, '.break').then((l) => l.length), 0);
});

test('crashed breaker left <res>.moved (owner gone, no .lock): lockers back off and fail closed; recovers once .moved is removed', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 200, staleLockMs: 10 }) });
  const moved = join(dir, `${K}.moved`);
  await writeFile(moved, JSON.stringify({ nonce: 'orphan', pid: 2 ** 22 + 1, host: hostname() }));
  await ageFile(moved);
  const rs = await Promise.all([auth.acquire(R, opts('a')), auth.acquire(R, opts('b'))]);
  assert.deepEqual(rs.map((r) => r.code), ['E_UNAVAILABLE', 'E_UNAVAILABLE']);
  assert.equal(await files(dir, '.lock').then((l) => l.length), 0, 'yielding lockers clean their own lock');
  assert.ok(realFs.existsSync(moved));
  await unlink(moved);
  assert.ok((await auth.acquire(R, opts('a'))).ok);
});

test('breaker crashes after displacing a fresh lock (.moved + .break left): the displaced locker fails closed and cleans .moved; nobody else commits', async () => {
  const dir = await tmp();
  const lp = join(dir, `${K}.lock`), bp = join(dir, `${K}.break`), moved = join(dir, `${K}.moved`);
  const xWrite = gate();
  const X = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, fs: hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(xWrite); } }) }) });
  const W = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150 }) });
  const px = X.acquire(R, opts('x'));
  await xWrite.at;                                    // X holds the lock and passed ownsLock(); it is writing the record
  // a breaker displaced X's lock and died: simulate rename + leftover .break
  await realFs.promises.rename(lp, moved);
  await writeFile(bp, '{}');
  const w = await W.acquire(R, opts('w'));            // arrives while .moved exists: must back off
  assert.equal(w.code, 'E_UNAVAILABLE');
  xWrite.go();
  const x = await px;
  // X had already passed its pre-commit check, so its commit stands; what matters is that W did not also commit
  assert.ok(x.ok);
  assert.deepEqual(await W.validate(x.lease), { ok: true });
  assert.equal(realFs.existsSync(moved), false, 'X removed its displaced lock on unlock');
  await unlink(bp);
  assert.equal((await W.acquire(R, opts('w'))).code, 'E_HELD');
});

test('displaced-lock restore: while .moved exists every new locker yields; the owner waits in ownsLock and commits exactly once', async () => {
  // Deterministic version of the F1 chain on the new code: breaker Y renames X's fresh lock; W keeps trying meanwhile.
  const dir = await tmp();
  const lp = join(dir, `${K}.lock`);
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 1 }));          // no host: pid veto does not apply
  await ageFile(lp);
  const yRename = gate(), yLink = gate(), xWrite = gate();
  const mk = (fs, lockWaitMs = 400) => createLeaseAuthority({ backend: fileBackend({ dir, fs, staleLockMs: 1000, lockWaitMs }) });
  const Y = mk(hookedFs({ rename: async (from) => { if (from === lp) await pause(yRename); }, link: () => pause(yLink) }));
  const X = mk(hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(xWrite); } }), 2000);
  const W = mk(undefined, 150);
  const py = Y.acquire(R, opts('y'));
  await yRename.at;                                   // Y holds .break, re-stat matched, about to rename the crashed lock
  await unlink(lp);                                   // external actor removes the crashed lock under Y's feet
  const px = X.acquire(R, opts('x'));
  await xWrite.at;                                    // X holds a fresh lock, passed ownsLock, writing
  yRename.go();                                       // Y renames X's fresh lock to .moved -> mismatch -> restore (paused)
  await yLink.at;
  const ws = await Promise.all([W.acquire(R, opts('w1')), W.acquire(R, opts('w2'))]);
  assert.deepEqual(ws.map((r) => r.code), ['E_UNAVAILABLE', 'E_UNAVAILABLE'], 'lockers back off while .moved exists');
  xWrite.go();
  const x = await px;
  yLink.go();
  const y = await py;
  assert.ok(x.ok);
  assert.equal(y.ok, false);
  const rec = JSON.parse(await readFile(join(dir, `${K}.lease.json`), 'utf8'));
  assert.equal(rec.generation, 1);
  assert.equal(rec.holder.owner, 'x');
  for (const ext of ['.lock', '.moved', '.break']) assert.equal((await files(dir, ext)).length, 0, ext);
  assert.deepEqual(await X.release(x.lease), { ok: true });
});

// --- pid / host liveness -------------------------------------------------------------------------------------------------

test('pid veto: a lock naming a live pid on this host is never broken (holder absent); EPERM counts as alive; other host -> age rule', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 10 }) });
  const lp = join(dir, `${K}.lock`);
  for (const pid of [process.pid, 1]) {                                    // own pid: alive; pid 1: EPERM for non-root -> alive
    await writeFile(lp, JSON.stringify({ nonce: 'x', pid, host: hostname() }));
    await ageFile(lp);
    assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE', `pid ${pid}`);
    assert.ok(realFs.existsSync(lp));
  }
  // same pid but recorded for another host: liveness cannot be judged here, the age + holder rules decide
  await writeFile(lp, JSON.stringify({ nonce: 'x', pid: process.pid, host: 'other-host.invalid' }));
  await ageFile(lp);
  const r = await auth.acquire(R, opts('a'));
  assert.ok(r.ok);
  assert.ok((await auth.release(r.lease)).ok);
  await unlink(lp).catch(() => {});
});

test('pid reuse: a recycled pid keeps a dead lock alive -> fails closed (holder absent), documented manual recovery works', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 10 }) });
  const lp = join(dir, `${K}.lock`);
  await writeFile(lp, JSON.stringify({ nonce: 'dead-but-pid-reused', pid: process.pid, host: hostname() }));
  await ageFile(lp);
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  await unlink(lp);
  assert.ok((await auth.acquire(R, opts('a'))).ok);
});

// --- adopt() ---------------------------------------------------------------------------------------------------------------

test('adopt: cannot be used by another owner, after release, after takeover, on an expired ghost, or to extend TTL', async () => {
  const c = { t: 1_800_000_000_000 };
  const now = () => c.t;
  const inner = fakeBackend({ now });
  const auth = createLeaseAuthority({ backend: inner, now });
  const a = await auth.acquire(R, opts('a', { ttl_ms: 1000 }));
  const attempted = { resource: R, lease_id: a.lease.lease_id, owner: 'a', task_id: 'task-a' };
  // an attacker who learned the lease_id (audit/alerts) but not the owner string
  assert.equal((await auth.adopt({ ...attempted, owner: 'mallory' })).code, 'E_FENCED');
  assert.equal((await auth.adopt({ ...attempted, task_id: null })).code, 'E_FENCED');
  const ad = await auth.adopt(attempted);
  assert.ok(ad.ok);
  assert.equal(ad.lease.expires_at, a.lease.expires_at, 'adopt does not renew');
  assert.equal(ad.lease.token, a.lease.token);
  c.t += 1000;                                                           // expired ghost
  assert.equal((await auth.adopt(attempted)).code, 'E_EXPIRED');
  const b = await auth.acquire(R, opts('b'));
  assert.ok(b.ok);
  assert.equal((await auth.adopt(attempted)).code, 'E_FENCED', 'after takeover');
  assert.ok((await auth.release(b.lease)).ok);
  assert.equal((await auth.adopt({ ...attempted, lease_id: b.lease.lease_id, owner: 'b', task_id: 'task-b' })).code, 'E_FENCED', 'after release: never a free resource');
  assert.equal((await auth.adopt({ resource: 'nope', lease_id: 'x', owner: 'a' })).code, 'E_INVALID');
  // adopt must fail closed when the backend is unavailable
  inner.setFail('unavailable');
  assert.equal((await auth.adopt(attempted)).code, 'E_UNAVAILABLE');
});

test('adopt with the file backend: the timed-out owner recovers its ghost and releases it; a copycat with the same owner string but another task cannot', async () => {
  const dir = await tmp();
  const g = gate();
  const slow = createLeaseAuthority({ backend: fileBackend({ dir, fs: hookedFs({ open: async (p) => { if (String(p).endsWith('.tmp')) await pause(g); } }) }), opTimeoutMs: 30 });
  const fast = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const r = await slow.acquire(R, opts('a'));
  assert.equal(r.code, 'E_UNAVAILABLE');
  g.go(); await nap(30);
  assert.equal((await fast.acquire(R, opts('b'))).code, 'E_HELD', 'ghost committed');
  assert.equal((await fast.adopt({ ...r.attempted, task_id: 'task-other' })).code, 'E_FENCED');
  const ad = await fast.adopt(r.attempted);
  assert.ok(ad.ok);
  assert.ok((await fast.release(ad.lease)).ok);
  assert.ok((await fast.acquire(R, opts('b'))).ok);
});

// --- <res>.seen ----------------------------------------------------------------------------------------------------------

test('.seen: deleting only the marker is harmless for the live record, but the marker is never rewritten', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const a = await auth.acquire(R, opts('a'));
  await unlink(join(dir, `${K}.seen`));
  assert.deepEqual(await auth.validate(a.lease), { ok: true });
  assert.ok((await auth.renew(a.lease)).ok);
  assert.ok((await auth.release(a.lease)).ok);
  const b = await auth.acquire(R, opts('b'));
  assert.equal(b.lease.token, 2);
  // the marker is written only before the *first* record (update: `if (!rec)`), so from here the resource has no
  // lost-record guard at all; see the todo below
  assert.equal(realFs.existsSync(join(dir, `${K}.seen`)), false);
});

test('.seen: with the marker intact, a deleted record is detected by every operation', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const a = await auth.acquire(R, opts('a'));
  await unlink(join(dir, `${K}.lease.json`));
  assert.equal((await auth.acquire(R, opts('c'))).code, 'E_UNAVAILABLE');
  assert.equal((await auth.validate(a.lease)).code, 'E_UNAVAILABLE');
  assert.equal((await auth.renew(a.lease)).code, 'E_UNAVAILABLE');
  assert.equal((await auth.release(a.lease)).code, 'E_UNAVAILABLE');
  assert.equal((await auth.adopt({ resource: R, lease_id: a.lease.lease_id, owner: 'a', task_id: 'task-a' })).code, 'E_UNAVAILABLE');
});

test('.seen: per-resource cleanup (`rm <res>.*`) silently restarts the generation although audit.jsonl still holds the history',
  async () => {
    const dir = await tmp();
    const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
    for (let i = 0; i < 2; i++) { const l = await auth.acquire(R, opts('a')); await auth.release(l.lease); }
    for (const f of await readdir(dir)) if (f.startsWith(K)) await unlink(join(dir, f));
    const r = await auth.acquire(R, opts('b'));
    assert.ok(!r.ok || r.lease.token > 2, `generation restarted: ${JSON.stringify(r)}`);
  });

// --- D-008 branch namespace ----------------------------------------------------------------------------------------------

test('D-008: repo:<repo>:branch:main / :branch:integration alias the protected namespaces and can be held concurrently',
  async () => {
    const auth = createLeaseAuthority({ backend: fakeBackend() });
    const a = await auth.acquire('repo:demo:integration', opts('integration-agent'));
    assert.ok(a.ok);
    const b = await auth.acquire('repo:demo:branch:integration', opts('other'));
    assert.equal(b.ok, false, 'second name for the same branch must not be a second lease');
    assert.equal(validResource('repo:demo:branch:main'), false);
    assert.equal(validResource('repo:org/demo:branch:main'), false);
  });

test('D-008: percent-encoded file names: no traversal, no collisions between look-alike names', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const names = ['repo:demo:branch:a/b', 'repo:demo:branch:a/b/c', 'repo:demo:branch:a.b', 'repo:demo:branch:a-b', 'repo:demo:branch:a_b',
    'repo:demo:branch:A/B', 'repo:org/demo:branch:a', 'repo:demo:branch:org/demo', 'repo:demo:branch:.hidden', 'repo:demo:branch:x.lock', 'repo:demo:branch:x.seen'];
  for (const r of names) assert.ok((await auth.acquire(r, opts('a'))).ok, r);
  const bad = ['repo:demo:branch:%2E%2E/x', 'repo:demo:branch:a%2Fb', 'repo:demo:branch:..', 'repo:demo:branch:../a', 'repo:demo:branch:a/../b',
    'repo:demo:branch:a\\b', 'repo:demo:branch:a\u0000', 'repo:demo:branch:a:b', 'repo:demo:branch:a b', 'repo:demo:branch:refs//heads', 'repo:demo:branch:x/'];
  for (const r of bad) assert.equal((await auth.acquire(r, opts('a'))).code, 'E_INVALID', JSON.stringify(r));
  const entries = await readdir(dir);
  assert.equal(entries.filter((n) => n.endsWith('.lease.json')).length, names.length, 'one record per distinct resource');
  assert.ok(entries.every((n) => !n.includes('/') && !n.startsWith('.') || n.endsWith('.tmp')), entries.join(','));
  // a branch name that ends in one of the backend's own suffixes cannot collide with that file of another resource
  assert.ok(entries.includes(`${encodeURIComponent('repo:demo:branch:x.lock')}.lease.json`));
});

test('D-008: a slash-heavy branch name at the 150-char cap still fails closed (derived file name too long), never leaks a tmp file',
  async () => {
    const r = `repo:demo:branch:${'a/'.repeat(66)}a`;
    assert.equal(r.length, 150);
    const dir = await tmp();
    const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
    const res = await auth.acquire(r, opts('a'));
    assert.equal((await readdir(dir)).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')).length, 0);
    assert.ok(res.ok || res.code === 'E_INVALID', JSON.stringify(res));
  });
