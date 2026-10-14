// V2 lease authority (spec §12.2; T25-T27, GL10): exactly one holder under real concurrency (in-process and across
// processes), fail-closed on unavailable/stale/skewed/corrupt backends, fencing of expired holders even with a lying
// clock, persisted monotonic generations, ordered all-or-nothing acquisition, identity-checked renew/release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes, unlink, chmod } from 'node:fs/promises';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createLeaseAuthority, fileBackend, fakeBackend, fence, validResource, canonicalOrder } from '../orchestration/lease-authority.js';

const MOD = pathToFileURL(new URL('../orchestration/lease-authority.js', import.meta.url).pathname).href;
const tmp = () => mkdtemp(join(tmpdir(), 'v2-lease-'));
const clock = (t = 1_800_000_000_000) => { const c = () => c.t; c.t = t; return c; };
const opts = (owner, extra = {}) => ({ owner, task_id: `task-${owner}`, ttl_ms: 60_000, scope: 'merge', approval_ref: 'appr-1', ...extra });
const readAudit = async (dir) => (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const R = 'repo:demo:integration';

// --- T25: two (many) contenders race -------------------------------------------------------------------------------

test('T25: 40 parallel acquire() through one file dir -> exactly one holder, rest E_HELD', async () => {
  const dir = await tmp();
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    // separate authority+backend instances: no shared in-process state, only the directory
    createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20_000 }) }).acquire(R, opts(`agent-${i}`))));
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1);
  assert.deepEqual([...new Set(results.filter((r) => !r.ok).map((r) => r.code))], ['E_HELD']);
  assert.equal(winners[0].lease.token, 1);
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  assert.deepEqual(await auth.validate(winners[0].lease), { ok: true });
  const audit = await readAudit(dir);
  assert.equal(audit.filter((e) => e.op === 'acquire').length, 1);
  assert.equal(audit.filter((e) => e.op === 'denied' && e.code === 'E_HELD').length, 39);
  const acq = audit.find((e) => e.op === 'acquire');
  assert.equal(acq.owner, winners[0].lease.owner); assert.equal(acq.scope, 'merge'); assert.equal(acq.approval_ref, 'appr-1');
});

test('T25: separate node processes contend on the same resources -> exactly one holder per resource', async () => {
  const dir = await tmp();
  const N = 25, PROCS = 4;
  const startAt = Date.now() + 700;
  const script = `
    const { createLeaseAuthority, fileBackend } = await import(process.argv[1]);
    const [, , dir, startAt, owner, n] = process.argv;
    const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20000 }) });
    while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 2));
    const out = [];
    for (let i = 0; i < Number(n); i++) {
      const r = await auth.acquire('worktree:race-' + i, { owner, task_id: 't', ttl_ms: 60000 });
      out.push(r.ok ? { i, ok: true, token: r.lease.token } : { i, ok: false, code: r.code });
    }
    process.stdout.write(JSON.stringify(out));`;
  const run = (owner) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, MOD, dir, String(startAt), owner, String(N)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${owner} exit ${code}: ${err}`))));
  });
  const all = await Promise.all(Array.from({ length: PROCS }, (_, k) => run(`proc-${k}`)));
  for (let i = 0; i < N; i++) {
    const rows = all.map((o) => o[i]);
    assert.equal(rows.filter((r) => r.ok).length, 1, `resource ${i}: ${JSON.stringify(rows)}`);
    assert.ok(rows.filter((r) => !r.ok).every((r) => r.code === 'E_HELD'));
    assert.equal(rows.find((r) => r.ok).token, 1);
  }
});

test('T25: the losing contender never runs its protected action (withLeases)', async () => {
  const dir = await tmp();
  const mutations = [];
  const a = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20_000 }) });
  const b = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20_000 }) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const runs = [a, b].map((auth, i) => auth.withLeases([R], opts(`int-${i}`), async (f) => {
    await f.check(); mutations.push(i); await gate; return i;
  }));
  // the winner is parked on the gate, so the loser must settle first (never by a timer: a slow loser would otherwise
  // legitimately acquire after the winner released)
  const loser = await Promise.race(runs);
  assert.equal(loser.ok, false);
  release();
  const res = await Promise.all(runs);
  assert.equal(mutations.length, 1);
  assert.equal(res.filter((r) => r.ok).length, 1);
  assert.equal(res.find((r) => !r.ok).code, 'E_HELD');
});

// --- T26: backend unavailable / stale -> fail closed ---------------------------------------------------------------

for (const mode of ['unavailable', 'stale', 'timeout', 'clock_skew']) {
  test(`T26: fake backend '${mode}' -> acquire/validate E_UNAVAILABLE, mutation never runs, alert + audit`, async () => {
    const c = clock();
    const backend = fakeBackend({ now: c });
    const alerts = [];
    const auth = createLeaseAuthority({ backend, now: c, opTimeoutMs: 50, alert: (a) => alerts.push(a) });
    const held = await auth.acquire(R, opts('a'));
    assert.ok(held.ok);
    backend.setFail(mode);
    assert.equal((await auth.validate(held.lease)).code, 'E_UNAVAILABLE');
    await assert.rejects(auth.fence(held.lease).check(), { code: 'E_UNAVAILABLE' });
    let ran = false;
    const r = await auth.withLeases(['environment:staging:deploy'], opts('b'), async () => { ran = true; });
    assert.equal(r.ok, false); assert.equal(r.code, 'E_UNAVAILABLE'); assert.equal(ran, false);
    assert.equal((await auth.acquire(R, opts('c'))).code, 'E_UNAVAILABLE');
    assert.equal((await auth.renew(held.lease)).code, 'E_UNAVAILABLE');
    assert.ok(alerts.some((x) => x.kind === 'lease_unavailable' && x.op === 'acquire'));
    assert.ok(alerts.some((x) => x.kind === 'lease_unavailable' && x.op === 'validate'));
    assert.ok(backend.auditLog.some((e) => e.op === 'denied' && e.code === 'E_UNAVAILABLE' && e.owner === 'b'));
    // recovery: the original holder is still the holder; unavailability never freed it
    backend.setFail(null);
    assert.deepEqual(await auth.validate(held.lease), { ok: true });
    assert.equal((await auth.acquire(R, opts('c'))).code, 'E_HELD');
  });
}

test('T26: partial write leaves the resource unavailable (not free) until repaired', async () => {
  const backend = fakeBackend({ fail: 'partial_write' });
  const auth = createLeaseAuthority({ backend });
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  backend.setFail(null);
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
  backend.repair(R);
  assert.equal((await auth.acquire(R, opts('b'))).ok, true);
});

test('T26: file backend corrupt record -> acquire and validate E_UNAVAILABLE; torn tmp file is ignored', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 200 }) });
  const held = await auth.acquire(R, opts('a'));
  await writeFile(join(dir, `${encodeURIComponent(R)}.lease.json`), '{"resource":"repo:demo:integ');
  assert.equal((await auth.validate(held.lease)).code, 'E_UNAVAILABLE');
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
  // a crash mid-write only ever leaves a tmp file next to an intact record
  const R2 = 'host:node-a:maintenance';
  const h2 = await auth.acquire(R2, opts('a'));
  await writeFile(join(dir, `.${encodeURIComponent(R2)}.dead.tmp`), '{"torn');
  assert.deepEqual(await auth.validate(h2.lease), { ok: true });
});

test('T26: file backend record deleted while audit has history -> E_UNAVAILABLE, generation not restarted', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const l = await auth.acquire(R, opts('a'));
  await auth.release(l.lease);
  await unlink(join(dir, `${encodeURIComponent(R)}.lease.json`));
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
});

test('T26: file backend I/O error -> E_UNAVAILABLE and alert', async () => {
  const dir = await tmp();
  const eio = () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
  const fs = { promises: { ...realFs.promises, open: eio, readFile: eio } };
  const alerts = [];
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, fs }), alert: (a) => alerts.push(a) });
  const r = await auth.acquire(R, opts('a'));
  assert.equal(r.code, 'E_UNAVAILABLE');
  assert.ok(alerts.some((a) => a.kind === 'lease_unavailable'));
  assert.ok(alerts.some((a) => a.kind === 'audit_failed'));
  const forged = { resource: R, lease_id: 'x', owner: 'a', token: 1 };
  assert.equal((await auth.validate(forged)).code, 'E_UNAVAILABLE');
});

test('T26: unwritable backend dir -> E_UNAVAILABLE', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await tmp();
  await chmod(dir, 0o500);
  try {
    const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 100 }) });
    assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  } finally { await chmod(dir, 0o700); }
});

test('T26: stale lock file is never broken while its holder lease is live (fails closed)', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 1000 }) });
  assert.ok((await auth.acquire(R, opts('a'))).ok);
  const lp = join(dir, `${encodeURIComponent(R)}.lock`);
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 1 }));
  const old = new Date(Date.now() - 3_600_000);
  await utimes(lp, old, old);
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
  assert.ok(realFs.existsSync(lp));
});

test('stale-lock break: expired holder + old lock -> broken and audited; young lock -> not broken', async () => {
  const dir = await tmp();
  const c = clock(Date.now());
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 5000 }), now: c });
  const a = await auth.acquire(R, opts('a', { ttl_ms: 1000 }));
  c.t += 2000;                                                  // holder expired
  const lp = join(dir, `${encodeURIComponent(R)}.lock`);
  await writeFile(lp, JSON.stringify({ nonce: 'crashed', pid: 1 }));
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE', 'young lock must not be broken');
  const old = new Date(Date.now() - 60_000);
  await utimes(lp, old, old);
  const b = await auth.acquire(R, opts('b'));
  assert.ok(b.ok);
  assert.equal(b.lease.token, a.lease.token + 1);
  const audit = await readAudit(dir);
  assert.ok(audit.some((e) => e.op === 'lock_broken' && e.resource === R));
  assert.equal(realFs.readdirSync(dir).filter((f) => f.includes('.broken-') || f.endsWith('.lock')).length, 0);
});

// --- T27: lease expires mid-command --------------------------------------------------------------------------------

for (const kind of ['file', 'fake']) {
  test(`T27 (${kind}): lease expires mid-command -> second protected action blocked; stale token fenced despite a lying clock`, async () => {
    const dir = await tmp();
    const mk = () => (kind === 'file' ? fileBackend({ dir }) : shared);
    const t0 = 1_800_000_000_000;
    const ca = clock(t0), cb = clock(t0);
    const shared = fakeBackend({ now: cb });
    const alerts = [];
    const A = createLeaseAuthority({ backend: mk(ca), now: ca, alert: (x) => alerts.push(x), maxSkewMs: Infinity });
    const B = createLeaseAuthority({ backend: mk(cb), now: cb, maxSkewMs: Infinity });
    const actions = [];
    let staleLease, caught;
    const r = await A.withLeases([R], opts('int-a', { ttl_ms: 1000 }), async (f) => {
      staleLease = f.leases[0];
      await f.check(); actions.push('push-1');
      ca.t += 5000; cb.t += 5000;                               // command ran long; lease expired
      try { await f.check(); actions.push('push-2'); } catch (e) { caught = e.code; }
    });
    assert.equal(r.ok, true);
    assert.deepEqual(actions, ['push-1']);
    assert.equal(caught, 'E_EXPIRED');
    // withLeases' finally released A's own expired-but-unreplaced lease; the generation stays, so B gets a newer token
    const b = await B.acquire(R, opts('int-b'));
    assert.ok(b.ok);
    assert.ok(b.lease.token > staleLease.token);
    ca.t = t0;                                                  // A's clock lies: claims the lease is still fresh
    assert.equal((await A.validate(staleLease)).code, 'E_FENCED');
    await assert.rejects(A.fence(staleLease).check(), { code: 'E_FENCED' });
    assert.equal((await A.renew(staleLease)).code, 'E_FENCED');
    assert.equal((await A.release(staleLease)).code, 'E_FENCED');
    assert.deepEqual(await B.validate(b.lease), { ok: true }, 'stale release must not free the new holder');
    assert.ok(alerts.some((x) => x.kind === 'lease_fenced'));
  });
}

test('T27: expired holder is fenced (not merely stale) when a new owner takes over without release', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const auth = createLeaseAuthority({ backend, now: c });
  const a = await auth.acquire(R, opts('a', { ttl_ms: 1000 }));
  c.t += 1000;                                                  // exactly at expires_at: expired
  const b = await auth.acquire(R, opts('b'));
  assert.ok(b.ok);
  assert.equal(b.lease.token, 2);
  assert.equal((await auth.validate(a.lease)).code, 'E_FENCED');
  assert.ok(backend.auditLog.some((e) => e.op === 'fenced' && e.lease_id === a.lease.lease_id && e.by_token === 2));
});

test('withLeases: a stale holder whose lease was taken over releases nothing in finally', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const A = createLeaseAuthority({ backend, now: c });
  let bLease;
  const r = await A.withLeases([R, 'service:node-a:web'], opts('a', { ttl_ms: 1000 }), async () => {
    c.t += 2000;
    bLease = (await A.acquire(R, opts('b'))).lease;
  });
  assert.ok(r.ok);
  assert.deepEqual(await A.validate(bLease), { ok: true });
  assert.equal(backend.records.get('service:node-a:web').holder, null);
});

test('withLeases releases in finally when fn throws', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  await assert.rejects(auth.withLeases([R], opts('a'), async () => { throw new Error('boom'); }), /boom/);
  assert.equal(backend.records.get(R).holder, null);
  assert.ok((await auth.acquire(R, opts('b'))).ok);
});

// --- generations, renew, release, ordering, namespaces --------------------------------------------------------------

test('generation is monotonic across release and process restart (never reused)', async () => {
  const dir = await tmp();
  let auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const r = await auth.acquire(R, opts('a'));
    tokens.push(r.lease.token);
    assert.ok((await auth.release(r.lease)).ok);
  }
  auth = createLeaseAuthority({ backend: fileBackend({ dir }) });          // "restart": fresh instances, same dir
  tokens.push((await auth.acquire(R, opts('a'))).lease.token);
  // and a genuinely new process
  const out = await new Promise((resolve, reject) => {
    const s = `const { createLeaseAuthority, fileBackend } = await import(process.argv[1]);
      const a = createLeaseAuthority({ backend: fileBackend({ dir: process.argv[2] }) });
      const r = await a.acquire('repo:demo:main', { owner: 'p', ttl_ms: 1000 });
      process.stdout.write(String(r.lease.token));`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', s, MOD, dir]);
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', (code) => (code ? reject(new Error(`exit ${code}`)) : resolve(o)));
  });
  assert.equal(out, '1');                                      // generations are per resource
  assert.deepEqual(tokens, [1, 2, 3, 4]);
  const rec = JSON.parse(await readFile(join(dir, `${encodeURIComponent(R)}.lease.json`), 'utf8'));
  assert.equal(rec.generation, 4);
});

test('renew: owner extends TTL with the same token; non-owner and expired renew rejected', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const auth = createLeaseAuthority({ backend, now: c });
  const a = (await auth.acquire(R, opts('a', { ttl_ms: 1000 }))).lease;
  c.t += 500;
  const r = await auth.renew(a);
  assert.ok(r.ok);
  assert.equal(r.lease.token, a.token);
  assert.equal(r.lease.expires_at, c.t + 1000);
  assert.equal((await auth.renew({ ...a, owner: 'mallory' })).code, 'E_FENCED');
  assert.equal((await auth.renew({ ...a, lease_id: 'forged' })).code, 'E_FENCED');
  assert.equal((await auth.renew({ ...a, token: a.token + 1 })).code, 'E_FENCED');
  c.t += 2000;
  assert.equal((await auth.renew(r.lease)).code, 'E_EXPIRED');
  assert.ok(backend.auditLog.some((e) => e.op === 'renew' && e.owner === 'a'));
  assert.ok(backend.auditLog.some((e) => e.op === 'fenced' && e.action === 'renew' && e.owner === 'mallory'));
});

test('fence.renew keeps the executor handle current', async () => {
  const c = clock();
  const auth = createLeaseAuthority({ backend: fakeBackend({ now: c }), now: c });
  const a = (await auth.acquire(R, opts('a', { ttl_ms: 1000 }))).lease;
  const f = fence(auth, a);
  c.t += 900; await f.renew();
  c.t += 900; assert.equal(await f.check(), true);
  c.t += 200; await assert.rejects(f.check(), { code: 'E_EXPIRED' });
});

test('release by non-owner rejected and the holder keeps the lease', async () => {
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const a = (await auth.acquire(R, opts('a'))).lease;
  assert.equal((await auth.release({ ...a, owner: 'mallory' })).code, 'E_FENCED');
  assert.equal((await auth.release({ ...a, lease_id: 'other' })).code, 'E_FENCED');
  assert.equal((await auth.release({ resource: R })).code, 'E_INVALID');
  assert.deepEqual(await auth.validate(a), { ok: true });
  assert.ok((await auth.release(a)).ok);
  assert.equal((await auth.validate(a)).code, 'E_FENCED');           // released lease is no authority either
  const audit = await readAudit(dir);
  assert.ok(audit.some((e) => e.op === 'denied' && e.action === 'release' && e.owner === 'mallory'));
  assert.ok(audit.some((e) => e.op === 'release' && e.owner === 'a'));
});

test('ordered acquisition: [a,b] vs [b,a] contend without deadlock or split holdings', async () => {
  const dir = await tmp();
  const X = 'repo:demo:integration', Y = 'repo:demo:main';
  for (let round = 0; round < 15; round++) {
    const one = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20_000 }) });
    const two = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 20_000 }) });
    const res = await Promise.all([
      one.withLeases([X, Y], opts('one'), async (f) => { await f.check(); await new Promise((r) => setTimeout(r, 2)); return 'one'; }),
      two.withLeases([Y, X], opts('two'), async (f) => { await f.check(); await new Promise((r) => setTimeout(r, 2)); return 'two'; }),
    ]);
    const okN = res.filter((r) => r.ok).length;
    assert.ok(okN >= 1, `round ${round}: nobody progressed ${JSON.stringify(res)}`);
    for (const r of res) if (!r.ok) assert.equal(r.code, 'E_HELD');
    for (const res_ of [X, Y]) {
      const rec = JSON.parse(await readFile(join(dir, `${encodeURIComponent(res_)}.lease.json`), 'utf8'));
      assert.equal(rec.holder, null, 'nothing left held after the round');
    }
  }
  // the sort is canonical and stable regardless of input order
  assert.deepEqual(canonicalOrder([Y, X, Y]), [X, Y]);
});

test('acquireAll is all-or-nothing: a held later resource releases the earlier ones', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  assert.ok((await auth.acquire('repo:demo:main', opts('other'))).ok);
  const r = await auth.acquireAll(['repo:demo:main', 'repo:demo:integration'], opts('me'));
  assert.equal(r.code, 'E_HELD');
  assert.equal(r.resource, 'repo:demo:main');
  assert.equal(backend.records.get('repo:demo:integration').holder, null);
  assert.equal(backend.records.get('repo:demo:main').holder.owner, 'other');
});

test('namespace validation: §5 resources accepted, everything else E_INVALID with nothing acquired', async () => {
  for (const ok of ['repo:demo:integration', 'repo:org/demo:main', 'environment:staging:deploy', 'host:node-a:maintenance',
    'service:node-a:web', 'worktree:task-42']) assert.ok(validResource(ok), ok);
  const bad = ['', 'repo:demo', 'repo:demo:dev', 'foo:bar', 'worktree:../x', 'worktree:a/b', 'host:a b:maintenance',
    'service:node-a', 'environment:prod:restart', 'repo:demo:main:x', 'repo:..:main', 'host::maintenance', 42, null];
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  for (const r of bad) {
    assert.equal(validResource(r), false, String(r));
    assert.equal((await auth.acquire(r, opts('a'))).code, 'E_INVALID', String(r));
  }
  assert.equal((await auth.acquireAll(['repo:demo:main', 'nope'], opts('a'))).code, 'E_INVALID');
  assert.equal((await auth.acquireAll([], opts('a'))).code, 'E_INVALID');
  assert.equal(backend.records.size, 0);
  for (const o of [{ ttl_ms: 1000 }, { owner: 'a' }, { owner: 'a', ttl_ms: 0 }, { owner: 'a', ttl_ms: -5 }, { owner: 'a', ttl_ms: 1.5 },
    { owner: 'a', ttl_ms: 25 * 3600 * 1000 }, { owner: '', ttl_ms: 10 }]) {
    assert.equal((await auth.acquire(R, o)).code, 'E_INVALID', JSON.stringify(o));
  }
  let ran = false;
  const w = await auth.withLeases(['bogus'], opts('a'), async () => { ran = true; });
  assert.equal(w.code, 'E_INVALID'); assert.equal(ran, false);
  assert.ok(backend.auditLog.some((e) => e.op === 'denied' && e.code === 'E_INVALID'));
});

test('lease record carries the §5 fields', async () => {
  const c = clock();
  let n = 0;
  const auth = createLeaseAuthority({ backend: fakeBackend({ now: c }), now: c, randomId: () => `lease-${++n}` });
  const { lease } = await auth.acquire('environment:staging:deploy', opts('sysops', { ttl_ms: 5000 }));
  assert.deepEqual(lease, {
    resource: 'environment:staging:deploy', lease_id: 'lease-1', owner: 'sysops', task_id: 'task-sysops', token: 1,
    acquired_at: c.t, expires_at: c.t + 5000, ttl_ms: 5000, scope: 'merge', approval_ref: 'appr-1',
  });
});

// --- verifier fixes (F1-F6) ------------------------------------------------------------------------------------------

test('F2: a timed-out acquire that commits later can be adopted by the same owner and released; others cannot adopt', async () => {
  const inner = fakeBackend();
  let release;
  const held = new Promise((r) => { release = r; });
  const backend = { ...inner, async update(...a) { await held; return inner.update(...a); } };
  const auth = createLeaseAuthority({ backend, opTimeoutMs: 20 });
  const r = await auth.acquire(R, opts('a'));
  assert.equal(r.code, 'E_UNAVAILABLE');
  assert.deepEqual(r.attempted, { resource: R, lease_id: r.lease_id, owner: 'a', task_id: 'task-a' });
  release(); await new Promise((res) => setTimeout(res, 10));
  assert.equal((await auth.adopt({ ...r.attempted, owner: 'b' })).code, 'E_FENCED');
  assert.equal((await auth.adopt({ ...r.attempted, task_id: 'other' })).code, 'E_FENCED');
  assert.equal((await auth.adopt({ ...r.attempted, lease_id: 'forged' })).code, 'E_FENCED');
  const ad = await auth.adopt(r.attempted);
  assert.ok(ad.ok);
  assert.equal(ad.lease.lease_id, r.lease_id);
  assert.ok((await auth.release(ad.lease)).ok);
  assert.equal(inner.records.get(R).holder, null);
  assert.ok(inner.auditLog.some((e) => e.op === 'adopt'));
  // adopt never acquires a free resource
  assert.equal((await auth.adopt(r.attempted)).code, 'E_FENCED');
});

test('F2: acquireAll rollback adopts and releases a timed-out resource the backend committed', async () => {
  const inner = fakeBackend();
  let calls = 0;
  // the first update on main commits but answers too late; later ops are fast
  const backend = { ...inner, async update(res, ...a) {
    const out = await inner.update(res, ...a);
    if (res === 'repo:demo:main' && calls++ === 0) await new Promise((r) => setTimeout(r, 60));
    return out;
  } };
  const auth = createLeaseAuthority({ backend, opTimeoutMs: 20 });
  const r = await auth.acquireAll([R, 'repo:demo:main'], opts('a'));
  assert.equal(r.code, 'E_UNAVAILABLE');
  assert.equal(inner.records.get(R).holder, null);
  assert.equal(inner.records.get('repo:demo:main').holder, null, 'the ghost was adopted and released');
});

test('F3: the acquire audit line is mandatory: audit failure grants nothing (fake backend)', async () => {
  const backend = fakeBackend({ fail: 'audit_fail' });
  const auth = createLeaseAuthority({ backend });
  assert.equal((await auth.acquire(R, opts('a'))).code, 'E_UNAVAILABLE');
  assert.equal(backend.records.size, 0);
  backend.setFail(null);
  const a = await auth.acquire(R, opts('a'));
  assert.ok(a.ok);
  assert.equal(a.lease.token, 1);
  assert.ok(backend.auditLog.some((e) => e.op === 'acquire' && e.lease_id === a.lease.lease_id));
});

test('F4: non-finite clock fails closed in acquire, renew and validate', async () => {
  const backend = fakeBackend();
  const good = createLeaseAuthority({ backend });
  const a = (await good.acquire(R, opts('a'))).lease;
  for (const bad of [NaN, Infinity]) {
    const broken = createLeaseAuthority({ backend, now: () => bad });
    assert.equal((await broken.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
    assert.equal((await broken.renew(a)).code, 'E_UNAVAILABLE');
    assert.equal((await broken.validate(a)).ok, false);
  }
  assert.deepEqual(await good.validate(a), { ok: true });
});

test('F5: resource names are capped so derived file names fit', async () => {
  const long = `service:${'a'.repeat(70)}:${'b'.repeat(71)}`;
  assert.equal(long.length, 150);
  assert.ok(validResource(long));
  assert.equal(validResource(`service:${'a'.repeat(70)}:${'b'.repeat(72)}`), false);
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const l = await auth.acquire(long, opts('a'));
  assert.ok(l.ok, JSON.stringify(l));
});

test('F6: a lock whose owner is a live process on this host is never broken; lock records pid and host', async () => {
  const dir = await tmp();
  const c = clock(Date.now());
  const auth = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 150, staleLockMs: 10 }), now: c });
  await auth.acquire(R, opts('a', { ttl_ms: 1000 }));
  c.t += 5000;                                                  // holder expired
  const lp = join(dir, `${encodeURIComponent(R)}.lock`);
  const { hostname } = await import('node:os');
  await writeFile(lp, JSON.stringify({ nonce: 'alive', pid: process.pid, host: hostname() }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lp, old, old);
  assert.equal((await auth.acquire(R, opts('b'))).code, 'E_UNAVAILABLE');
  assert.equal(JSON.parse(await readFile(lp, 'utf8')).nonce, 'alive');
  // a dead pid on this host is breakable
  await writeFile(lp, JSON.stringify({ nonce: 'dead', pid: 2 ** 22 + 12345, host: hostname() }));
  await utimes(lp, old, old);
  // a longer lock wait here: under a loaded full suite, breaking the lock and acquiring can exceed 150 ms
  const auth2 = createLeaseAuthority({ backend: fileBackend({ dir, lockWaitMs: 5000, staleLockMs: 10 }), now: c });
  assert.ok((await auth2.acquire(R, opts('b'))).ok);
});

test('backend dir is created 0700 and a history marker guards lost records', async () => {
  const base = await tmp();
  const dir = join(base, 'leases');
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  assert.ok((await auth.acquire(R, opts('a'))).ok);
  assert.equal(realFs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(realFs.existsSync(join(dir, `${encodeURIComponent(R)}.seen`)));
});

test('D-008: repo:<repo>:branch:<name> namespace, validated and mapped to distinct files', async () => {
  const good = ['repo:demo:branch:feature/x', 'repo:org/demo:branch:release-1.2', 'repo:demo:branch:v2/08-lease.fix',
    'repo:demo:branch:a', 'repo:demo:branch:main-next', 'repo:demo:branch:x/y/z_1'];
  const bad = ['repo:demo:branch:', 'repo:demo:branch:-x', 'repo:demo:branch:/x', 'repo:demo:branch:x/', 'repo:demo:branch:a//b',
    'repo:demo:branch:a..b', 'repo:demo:branch:../main', 'repo:demo:branch:a b', 'repo:demo:branch:a:b', 'repo:demo:branch:a%2Fb',
    'repo:demo:branch:a~1', 'repo:demo:branches:x', 'repo:demo:branch', `repo:demo:branch:${'b'.repeat(140)}`];
  for (const r of good) assert.ok(validResource(r), r);
  for (const r of bad) assert.equal(validResource(r), false, r);
  const dir = await tmp();
  const auth = createLeaseAuthority({ backend: fileBackend({ dir }) });
  // names that a naive '/'->'_' or '/'->'-' mapping would collide
  const pair = ['repo:demo:branch:a/b', 'repo:demo:branch:a_b', 'repo:demo:branch:a-b', 'repo:demo:branch:a.b'];
  const leases = [];
  for (const r of pair) { const l = await auth.acquire(r, opts('a')); assert.ok(l.ok, r); leases.push(l.lease); }
  for (const l of leases) { assert.equal(l.token, 1); assert.deepEqual(await auth.validate(l), { ok: true }); }
  const names = realFs.readdirSync(dir).filter((n) => n.endsWith('.lease.json'));
  assert.equal(names.length, pair.length);
  assert.ok(names.every((n) => !n.includes('/')));
  assert.equal((await auth.acquire('repo:demo:branch:a/b', opts('b'))).code, 'E_HELD');
  assert.deepEqual(canonicalOrder(['repo:demo:main', 'repo:demo:branch:z', 'repo:demo:integration']),
    ['repo:demo:branch:z', 'repo:demo:integration', 'repo:demo:main']);
});
