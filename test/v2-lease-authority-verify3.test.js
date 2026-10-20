// Independent verification round 3 (e455d0d): the <res>.break self-heal path, and the audit fallback of the
// lost-record guard. Tests marked `todo: 'defect: ...'` assert the correct behaviour and report as todo until fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes, unlink, readdir, readFile } from 'node:fs/promises';
import * as realFs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, validResource } from '../orchestration/lease-authority.js';
import { tmp as mkTmp } from './helpers-tmp.js';

const tmp = () => mkTmp('v2-lease-verify3-');
const R = 'repo:demo:integration';
const K = encodeURIComponent(R);
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const ageFile = async (f, ms = 3_600_000) => { const d = new Date(Date.now() - ms); await utimes(f, d, d); };
const DEAD_PID = 2 ** 22 + 4243;
const leftovers = async (dir) => (await readdir(dir)).filter((f) => f.includes('.break') || f.endsWith('.lock') || f.endsWith('.moved'));

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
const staleLockAndDeadBreak = async (dir) => {
  const lp = join(dir, `${K}.lock`), bp = join(dir, `${K}.break`);
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: DEAD_PID, host: hostname() }));
  await ageFile(lp);
  await writeFile(bp, JSON.stringify({ pid: DEAD_PID + 1, host: hostname() }));
  await ageFile(bp);
  return { lp, bp };
};

// --- self-heal of <res>.break -------------------------------------------------------------------------------------------

test('self-heal: many healers race on a dead .break + stale lock -> at most one holder per round, no aside files left, converges', async () => {
  for (let round = 0; round < 5; round++) {
    const dir = await tmp();
    await staleLockAndDeadBreak(dir);
    const auths = Array.from({ length: 8 }, () => createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 300, staleLockMs: 10 }) }));
    let holder = null;
    for (let attempt = 0; attempt < 4 && !holder; attempt++) {
      const rs = await Promise.all(auths.map((a, i) => a.acquire(R, opts(`h${i}`))));
      const ok = rs.filter((r) => r.ok);
      assert.ok(ok.length <= 1, `round ${round} attempt ${attempt}: ${JSON.stringify(rs.map((r) => r.code || 'ok'))}`);
      for (const r of rs) if (!r.ok) assert.ok(['E_UNAVAILABLE', 'E_HELD'].includes(r.code), r.code);
      holder = ok[0] || null;
    }
    assert.ok(holder, `round ${round}: never converged`);
    assert.equal(holder.lease.token, 1);
    assert.deepEqual(await auths[0].validate(holder.lease), { ok: true });
    const left = await leftovers(dir);
    assert.deepEqual(left, [], `round ${round}: ${left}`);
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.filter((e) => e.op === 'lock_broken').length, 1, 'the stale lock is broken exactly once');
  }
});

test('self-heal: a healer holding a stale stat must not remove a fresh .break of a live breaker (CAS), and must not leave it aside', async () => {
  const dir = await tmp();
  const { bp } = await staleLockAndDeadBreak(dir);
  const g = gate();
  const H = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 300, staleLockMs: 10, fs: hookedFs({
    rename: async (from) => { if (from === bp) await pause(g); },
  }) }) });
  const ph = H.acquire(R, opts('h'));
  await g.at;                                         // H judged the old .break dead and is about to rename it aside
  await unlink(bp);                                   // another healer already removed it...
  await writeFile(bp, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));   // ...and a live breaker took it
  g.go();
  const h = await ph;
  assert.equal(h.ok, false);
  assert.equal(h.code, 'E_UNAVAILABLE');
  assert.ok(realFs.existsSync(bp), 'the live breaker\'s .break is restored');
  assert.equal(JSON.parse(await readFile(bp, 'utf8')).pid, process.pid);
  assert.deepEqual((await readdir(dir)).filter((f) => /\.break\./.test(f)), [], 'no aside file left behind');
  assert.ok(realFs.existsSync(join(dir, `${K}.lock`)), 'the stale lock was not broken under a live breaker');
});

test('self-heal never applies to a .break whose pid is alive on this host (pid reuse) or that came from another host; manual removal recovers', async () => {
  for (const binfo of [{ pid: process.pid, host: hostname() }, { pid: 1, host: hostname() }, { pid: DEAD_PID, host: 'other-host.invalid' }, { pid: DEAD_PID }]) {
    const dir = await tmp();
    const { lp, bp } = await staleLockAndDeadBreak(dir);
    await writeFile(bp, JSON.stringify(binfo));
    await ageFile(bp);
    const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 200, staleLockMs: 10 }) });
    for (let i = 0; i < 2; i++) assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE', JSON.stringify(binfo));
    assert.ok(realFs.existsSync(bp) && realFs.existsSync(lp), JSON.stringify(binfo));
    await unlink(bp);
    assert.ok((await auth.acquire(R, opts('a'))).ok, JSON.stringify(binfo));
  }
});

test('self-heal: a fresh .break (younger than staleLockMs) of a dead pid is left alone; it heals once old', async () => {
  const dir = await tmp();
  const { bp } = await staleLockAndDeadBreak(dir);
  await writeFile(bp, JSON.stringify({ pid: DEAD_PID + 1, host: hostname() }));         // fresh mtime
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 60_000 }) });
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  assert.ok(realFs.existsSync(bp));
  await ageFile(bp);
  await ageFile(join(dir, `${K}.lock`));
  const fast = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 10 }) });
  let r;
  for (let i = 0; i < 3 && !(r = await fast.acquire(R, opts('a'))).ok; i++);
  assert.ok(r.ok);
  assert.deepEqual(await leftovers(dir), []);
});

test('self-heal: a healer that cannot write (rename EACCES) fails closed and leaves .break intact', async () => {
  const dir = await tmp();
  const { bp } = await staleLockAndDeadBreak(dir);
  const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 10, fs: hookedFs({ rename: async (from) => { if (from === bp) throw eacces; } }) }) });
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  assert.ok(realFs.existsSync(bp));
});

// --- lost-record guard: audit fallback ---------------------------------------------------------------------------------

test('audit fallback: `rm <res>.*` after grants is detected; a resource that was only ever denied/fenced is not blocked',
  async () => {
    const dir = await tmp();
    const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
    for (let i = 0; i < 2; i++) { const l = await auth.acquire(R, opts('a')); await auth.release(l.lease); }
    for (const f of await readdir(dir)) if (f.startsWith(K)) await unlink(join(dir, f));
    assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE', 'granted history survives in audit.jsonl');
    // a never-granted resource: someone validates (or renews/releases) a stale/forged handle first
    const fresh = 'repo:demo:main';
    const forged = { resource: fresh, lease_id: 'from-another-dir', owner: 'a', token: 7 };
    const codes = [(await auth.validate(forged)).code, (await auth.renew(forged)).code, (await auth.release(forged)).code];
    assert.ok(codes.every((c) => c === 'E_FENCED' || c === 'E_UNAVAILABLE'), codes.join());
    const first = await auth.acquire(fresh, opts('a'));
    assert.ok(first.ok, `never-granted resource bricked by a fenced handle: ${JSON.stringify(first)}`);
    assert.equal(first.lease.token, 1);
  });

test('audit fallback: a torn or unrelated audit line never counts as history', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const other = 'repo:demo:branch:x';
  await writeFile(join(dir, 'audit.jsonl'), [
    JSON.stringify({ op: 'acquire', resource: other, token: 3 }),            // another resource
    JSON.stringify({ op: 'acquire', resource: `${R}`, token: 'x' }),         // not a granted token
    `{"op":"acquire","resource":${JSON.stringify(R)},"tok`,                   // torn
    JSON.stringify({ op: 'note', text: `mentions ${R} in a string` }),
  ].join('\n') + '\n');
  const r = await auth.acquire(R, opts('a'));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.lease.token, 1);
  assert.equal((await auth.acquire(other, opts('a'))).code, 'E_UNAVAILABLE');
});

// --- D-008 follow-ups ----------------------------------------------------------------------------------------------------

test('D-008: encoded-length cap and branch aliasing rules', async () => {
  assert.equal(validResource(`repo:demo:branch:${'a/'.repeat(66)}a`), false);
  assert.equal(validResource(`repo:demo:branch:${'a/'.repeat(30)}a`), true);
  for (const r of ['repo:demo:branch:main', 'repo:demo:branch:integration', 'repo:org/demo:branch:main']) assert.equal(validResource(r), false, r);
  for (const r of ['repo:demo:branch:main-next', 'repo:demo:branch:integration/x', 'repo:demo:branch:x/main']) assert.ok(validResource(r), r);
  // branch names are short refs: refs/heads/ and heads/ spellings would alias another lease name
  for (const r of ['repo:demo:branch:refs/heads/main', 'repo:demo:branch:heads/main', 'repo:demo:branch:refs/heads/dev']) assert.equal(validResource(r), false, r);
});
