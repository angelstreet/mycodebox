// V2 lease authority (spec §12.2, docs/v2/ARCHITECTURE.md §5). The only authority for shared mutations: atomic
// conditional acquire/renew/release, a persisted per-resource generation used as the fencing token, and fail-closed
// on every doubt (an unreadable, slow, skewed or corrupt backend is E_UNAVAILABLE, never "free").
// The authority holds the rules; a backend only provides an atomic read-modify-write per resource plus an audit log.
//   backend.read(resource)                  -> record | null      (record = { resource, generation, holder })
//   backend.update(resource, mutate, ctx)   -> mutate(record|null) returns { next?, result }; next is committed atomically
//   backend.audit(entry)                    -> append-only provenance
//   backend.time?()                         -> the backend's clock, when it has its own (skew check)
// Any backend error is thrown; the authority maps it to E_UNAVAILABLE.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SEG = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
const NAMESPACES = [
  new RegExp(`^repo:${SEG}(?:/${SEG})?:(?:integration|main)$`),
  new RegExp(`^environment:${SEG}:deploy$`),
  new RegExp(`^host:${SEG}:maintenance$`),
  new RegExp(`^service:${SEG}:${SEG}$`),
  new RegExp(`^worktree:${SEG}$`),
];
export const validResource = (r) => typeof r === 'string' && !r.includes('..') && NAMESPACES.some((re) => re.test(r));
// Code-unit order, not localeCompare: every process must agree on the same order or ordered acquisition is moot.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const canonicalOrder = (resources) => [...new Set(resources)].sort(cmp);

export const MAX_TTL_MS = 24 * 3600 * 1000;
const unavailable = (msg) => Object.assign(new Error(msg), { code: 'E_UNAVAILABLE' });
const fail = (code, error) => (error ? { ok: false, code, error } : { ok: false, code });
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const optStr = (v) => v == null || (typeof v === 'string' && v.length <= 500);

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(unavailable(`backend timeout after ${ms} ms`)), ms); }),
  ]);
}

function checkOpts(resource, o) {
  if (!validResource(resource)) return 'invalid resource';
  if (!o || typeof o !== 'object') return 'missing options';
  if (!str(o.owner)) return 'owner required';
  if (!optStr(o.task_id) || !optStr(o.scope) || !optStr(o.approval_ref)) return 'invalid task_id/scope/approval_ref';
  if (!Number.isInteger(o.ttl_ms) || o.ttl_ms <= 0 || o.ttl_ms > MAX_TTL_MS) return 'ttl_ms must be an integer in (0, 24h]';
  return null;
}

const isLease = (l) => !!l && typeof l === 'object' && validResource(l.resource) && str(l.lease_id) && str(l.owner)
  && Number.isInteger(l.token) && l.token > 0;

// null = this lease is the current, unexpired holder. Generation/identity first, so a holder whose clock lies about
// expiry is still fenced as soon as anyone else acquired.
function identity(rec, lease, t) {
  const h = rec?.holder;
  if (!h || rec.generation !== lease.token || h.lease_id !== lease.lease_id || h.owner !== lease.owner) return 'E_FENCED';
  if (!(t < h.expires_at)) return 'E_EXPIRED';
  return null;
}

export function createLeaseAuthority({
  backend, now = Date.now, randomId = randomUUID, opTimeoutMs = 5000, maxSkewMs = 2000, alert = () => {},
} = {}) {
  if (!backend) throw new Error('lease authority: backend required');

  const safeAlert = (kind, detail) => { try { alert({ kind, at: now(), ...detail }); } catch {} };
  async function audit(entry) {
    try { await withTimeout(backend.audit({ at: now(), ...entry }), opTimeoutMs); }
    catch (e) { safeAlert('audit_failed', { op: entry.op, resource: entry.resource, error: String(e?.message || e) }); }
  }
  async function call(fn) {
    if (typeof backend.time === 'function') {
      const bt = await withTimeout(backend.time(), opTimeoutMs);
      if (!Number.isFinite(bt) || Math.abs(bt - now()) > maxSkewMs) throw unavailable('clock skew between authority and backend');
    }
    return withTimeout(fn(), opTimeoutMs);
  }
  const who = (x) => ({ owner: x?.owner ?? null, task_id: x?.task_id ?? null, scope: x?.scope ?? null, approval_ref: x?.approval_ref ?? null });
  const errMsg = (e) => String(e?.message || e).slice(0, 200);

  async function acquire(resource, opts = {}) {
    const bad = checkOpts(resource, opts);
    if (bad) {
      await audit({ op: 'denied', resource: String(resource).slice(0, 200), code: 'E_INVALID', reason: bad, ...who(opts) });
      return fail('E_INVALID', bad);
    }
    const lease_id = String(randomId());
    let out;
    try {
      out = await call(() => backend.update(resource, (rec) => {
        const t = now();
        if (rec?.holder && t < rec.holder.expires_at) return { result: { held: rec.holder } };
        const token = (rec ? rec.generation : 0) + 1;
        const lease = {
          resource, lease_id, owner: opts.owner, task_id: opts.task_id ?? null, token, acquired_at: t,
          expires_at: t + opts.ttl_ms, ttl_ms: opts.ttl_ms, scope: opts.scope ?? null, approval_ref: opts.approval_ref ?? null,
        };
        return { next: { resource, generation: token, holder: lease, updated_at: t }, result: { lease, previous: rec?.holder || null } };
      }, { now }));
    } catch (e) {
      await audit({ op: 'denied', resource, code: 'E_UNAVAILABLE', error: errMsg(e), ...who(opts) });
      safeAlert('lease_unavailable', { op: 'acquire', resource, owner: opts.owner, error: errMsg(e) });
      return fail('E_UNAVAILABLE', errMsg(e));
    }
    if (out.held) {
      await audit({ op: 'denied', resource, code: 'E_HELD', held_by: out.held.owner, held_token: out.held.token, ...who(opts) });
      return { ok: false, code: 'E_HELD', holder: { owner: out.held.owner, task_id: out.held.task_id, expires_at: out.held.expires_at } };
    }
    if (out.previous) await audit({ op: 'fenced', resource, code: 'E_EXPIRED', token: out.previous.token, lease_id: out.previous.lease_id, by_token: out.lease.token, ...who(out.previous) });
    await audit({ op: 'acquire', resource, lease_id, token: out.lease.token, expires_at: out.lease.expires_at, ...who(opts) });
    return { ok: true, lease: { ...out.lease } };
  }

  async function renew(lease) {
    if (!isLease(lease)) return fail('E_INVALID', 'not a lease');
    let out;
    try {
      out = await call(() => backend.update(lease.resource, (rec) => {
        const t = now();
        const code = identity(rec, lease, t);
        if (code) return { result: { code } };
        const holder = { ...rec.holder, expires_at: t + rec.holder.ttl_ms, renewed_at: t };
        return { next: { ...rec, holder, updated_at: t }, result: { lease: holder } };
      }, { now }));
    } catch (e) {
      await audit({ op: 'denied', action: 'renew', resource: lease.resource, code: 'E_UNAVAILABLE', token: lease.token, error: errMsg(e), ...who(lease) });
      safeAlert('lease_unavailable', { op: 'renew', resource: lease.resource, owner: lease.owner, error: errMsg(e) });
      return fail('E_UNAVAILABLE', errMsg(e));
    }
    if (out.code) {
      await audit({ op: out.code === 'E_FENCED' ? 'fenced' : 'denied', action: 'renew', resource: lease.resource, code: out.code, token: lease.token, lease_id: lease.lease_id, ...who(lease) });
      return fail(out.code);
    }
    await audit({ op: 'renew', resource: lease.resource, lease_id: lease.lease_id, token: lease.token, expires_at: out.lease.expires_at, ...who(lease) });
    return { ok: true, lease: { ...out.lease } };
  }

  // Identity-checked: only the current holder (same generation + lease_id + owner) can clear the record. An expired
  // holder nobody replaced may still clear its own row; the generation is kept, so its token is never reused.
  async function release(lease) {
    if (!isLease(lease)) return fail('E_INVALID', 'not a lease');
    let out;
    try {
      out = await call(() => backend.update(lease.resource, (rec) => {
        const code = identity(rec, lease, -Infinity);
        if (code) return { result: { code } };
        return { next: { ...rec, holder: null, updated_at: now() }, result: {} };
      }, { now }));
    } catch (e) {
      await audit({ op: 'denied', action: 'release', resource: lease.resource, code: 'E_UNAVAILABLE', token: lease.token, error: errMsg(e), ...who(lease) });
      safeAlert('lease_unavailable', { op: 'release', resource: lease.resource, owner: lease.owner, error: errMsg(e) });
      return fail('E_UNAVAILABLE', errMsg(e));
    }
    if (out.code) {
      await audit({ op: 'denied', action: 'release', resource: lease.resource, code: out.code, token: lease.token, lease_id: lease.lease_id, ...who(lease) });
      return fail(out.code);
    }
    await audit({ op: 'release', resource: lease.resource, lease_id: lease.lease_id, token: lease.token, ...who(lease) });
    return { ok: true };
  }

  // Re-reads authoritative state; call immediately before every protected mutation.
  async function validate(lease) {
    if (!isLease(lease)) return fail('E_FENCED', 'not a lease');
    let rec;
    try { rec = await call(() => backend.read(lease.resource)); }
    catch (e) {
      await audit({ op: 'denied', action: 'validate', resource: lease.resource, code: 'E_UNAVAILABLE', token: lease.token, error: errMsg(e), ...who(lease) });
      safeAlert('lease_unavailable', { op: 'validate', resource: lease.resource, owner: lease.owner, error: errMsg(e) });
      return fail('E_UNAVAILABLE', errMsg(e));
    }
    const code = identity(rec, lease, now());
    if (!code) return { ok: true };
    await audit({ op: 'fenced', action: 'validate', resource: lease.resource, code, token: lease.token, lease_id: lease.lease_id, current_token: rec?.generation ?? null, ...who(lease) });
    safeAlert('lease_fenced', { resource: lease.resource, owner: lease.owner, code });
    return fail(code);
  }

  // Executor handle: `await f.check()` right before each protected action; throws err.code on any failure.
  function fence(leases) {
    const held = (Array.isArray(leases) ? leases : [leases]).slice();
    return {
      get leases() { return held.slice(); },
      async check() {
        if (!held.length) throw Object.assign(new Error('lease E_FENCED: no lease'), { code: 'E_FENCED' });
        for (const l of held) {
          const r = await validate(l);
          if (!r.ok) throw Object.assign(new Error(`lease ${r.code}: ${l?.resource}`), { code: r.code, resource: l?.resource });
        }
        return true;
      },
      async renew() {
        for (let i = 0; i < held.length; i++) {
          const r = await renew(held[i]);
          if (!r.ok) throw Object.assign(new Error(`lease ${r.code}: ${held[i]?.resource}`), { code: r.code, resource: held[i]?.resource });
          held[i] = r.lease;
        }
        return held.slice();
      },
    };
  }

  // Canonical order + all-or-nothing: whoever loses the first contended resource holds nothing, so two callers
  // asking for [a,b] and [b,a] can never each hold one half.
  async function acquireAll(resources, opts = {}) {
    if (!Array.isArray(resources) || !resources.length) return fail('E_INVALID', 'resources must be a non-empty array');
    const badRes = resources.find((r) => !validResource(r));
    if (badRes !== undefined) {
      await audit({ op: 'denied', resource: String(badRes).slice(0, 200), code: 'E_INVALID', reason: 'invalid resource', ...who(opts) });
      return { ...fail('E_INVALID', 'invalid resource'), resource: badRes };
    }
    const got = [];
    for (const r of canonicalOrder(resources)) {
      const res = await acquire(r, opts);
      if (!res.ok) {
        for (const l of got.reverse()) {
          const rr = await release(l);
          if (!rr.ok) safeAlert('release_failed', { resource: l.resource, owner: l.owner, code: rr.code });
        }
        return { ...res, resource: r };
      }
      got.push(res.lease);
    }
    return { ok: true, leases: got };
  }

  async function withLeases(resources, opts, fn) {
    const a = await acquireAll(resources, opts);
    if (!a.ok) return a;
    const f = fence(a.leases);
    try {
      return { ok: true, value: await fn(f) };
    } finally {
      for (const l of f.leases.reverse()) {
        const r = await release(l);
        if (!r.ok) safeAlert('release_failed', { resource: l.resource, owner: l.owner, code: r.code });
      }
    }
  }

  return { acquire, renew, release, validate, acquireAll, withLeases, fence };
}

export const fence = (authority, leases) => authority.fence(leases);

// ---------------------------------------------------------------------------------------------------------------------
// File backend: one directory, shared by every process on this host.
//   <res>.lease.json  authoritative record { resource, generation, holder }, replaced by tmp+fsync+rename+fsync(dir)
//   <res>.lock        O_EXCL critical section around read-check-write; holds a random nonce
//   audit.jsonl       append-only provenance (fsync per line)
// A crashed process can leave a lock file behind. It is only broken when the resource's holder is expired (or none)
// AND the lock file is older than staleLockMs; the break is rename-to-unique, then the moved file's dev/ino/mtime must
// match what was judged stale (else a fresh lock was moved: put it back). A locker re-checks its nonce right before
// committing, so a lost lock fails closed.
export function fileBackend({ dir, fs = nodeFs, staleLockMs = 30000, lockWaitMs = 5000, randomId = randomUUID, now = Date.now } = {}) {
  if (!dir) throw new Error('fileBackend: dir required');
  const p = fs.promises || fs;
  const key = (r) => encodeURIComponent(r);
  const recPath = (r) => join(dir, `${key(r)}.lease.json`);
  const lockPath = (r) => join(dir, `${key(r)}.lock`);
  const auditPath = join(dir, 'audit.jsonl');
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const wrap = (what, e) => (e?.code === 'E_UNAVAILABLE' ? e : unavailable(`${what}: ${e?.code || e?.message || e}`));
  let ready = null;
  const ensureDir = () => (ready ||= p.mkdir(dir, { recursive: true }).catch((e) => { ready = null; throw wrap('mkdir', e); }));

  function parseRecord(txt, resource) {
    let r;
    try { r = JSON.parse(txt); } catch { throw unavailable('corrupt lease record'); }
    const h = r?.holder;
    const ok = r && r.resource === resource && Number.isInteger(r.generation) && r.generation >= 0
      && (h === null || (h && typeof h === 'object' && h.token === r.generation && str(h.lease_id) && str(h.owner)
        && Number.isFinite(h.expires_at) && Number.isInteger(h.ttl_ms)));
    if (!ok) throw unavailable('invalid lease record');
    return r;
  }

  // A missing record with audit history means state was lost: restarting the generation could reuse a token.
  async function auditHasHistory(resource) {
    let txt;
    try { txt = await p.readFile(auditPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return false; throw wrap('audit read', e); }
    for (const line of txt.split('\n')) {
      if (!line.includes(resource)) continue;
      try { const e = JSON.parse(line); if (e.resource === resource && e.op === 'acquire') return true; } catch {}   // torn tail
    }
    return false;
  }

  async function readRecord(resource) {
    let txt;
    try { txt = await p.readFile(recPath(resource), 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw wrap('read', e);
      if (await auditHasHistory(resource)) throw unavailable('lease record missing but audit has history');
      return null;
    }
    return parseRecord(txt, resource);
  }

  async function fsyncDir() {
    const dh = await p.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  }

  async function writeRecord(resource, rec) {
    const tmp = join(dir, `.${key(resource)}.${randomId()}.tmp`);
    try {
      const fh = await p.open(tmp, 'wx', 0o600);
      try { await fh.writeFile(JSON.stringify(rec)); await fh.sync(); } finally { await fh.close(); }
      await p.rename(tmp, recPath(resource));
      await fsyncDir();
    } catch (e) {
      await p.unlink(tmp).catch(() => {});
      throw wrap('write', e);
    }
  }

  const readNonce = async (lp) => { try { return JSON.parse(await p.readFile(lp, 'utf8')).nonce ?? null; } catch { return null; } };

  async function maybeBreak(resource, lp, clock) {
    let st;
    try { st = await p.stat(lp); } catch (e) { if (e.code === 'ENOENT') return; throw wrap('lock stat', e); }
    if (now() - st.mtimeMs < staleLockMs) return;
    const rec = await readRecord(resource);                         // corrupt -> throws: never break on doubt
    if (rec?.holder && clock() < rec.holder.expires_at) return;     // live holder: wait, then fail closed
    const aside = `${lp}.broken-${randomId()}`;
    try { await p.rename(lp, aside); } catch (e) { if (e.code === 'ENOENT') return; throw wrap('lock break', e); }
    let st2 = null;
    try { st2 = await p.stat(aside); } catch {}
    if (st2 && st2.dev === st.dev && st2.ino === st.ino && st2.mtimeMs === st.mtimeMs) {
      await p.unlink(aside).catch(() => {});
      await audit({ at: now(), op: 'lock_broken', resource, lock_age_ms: now() - st.mtimeMs }).catch(() => {});
      return;
    }
    // Moved somebody's fresh lock: restore it if the slot is still free; otherwise its owner's pre-commit check fails.
    await p.link(aside, lp).catch(() => {});
    await p.unlink(aside).catch(() => {});
  }

  async function lock(resource, clock) {
    const lp = lockPath(resource);
    const nonce = String(randomId());
    const deadline = performance.now() + lockWaitMs;
    for (let i = 0; ; i++) {
      let fh = null;
      try { fh = await p.open(lp, 'wx', 0o600); }
      catch (e) { if (e.code !== 'EEXIST') throw wrap('lock', e); }
      if (fh) {
        try { await fh.writeFile(JSON.stringify({ nonce, pid: process.pid, at: now() })); await fh.sync(); await fh.close(); }
        catch (e) { await fh.close().catch(() => {}); await p.unlink(lp).catch(() => {}); throw wrap('lock write', e); }
        return nonce;
      }
      await maybeBreak(resource, lp, clock);
      if (performance.now() > deadline) throw unavailable('lease lock busy');
      await nap(Math.min(50, 1 + Math.floor(Math.random() * (2 + i))));
    }
  }

  async function unlock(resource, nonce) {
    const lp = lockPath(resource);
    if ((await readNonce(lp)) === nonce) await p.unlink(lp).catch(() => {});
  }

  async function audit(entry) {
    await ensureDir();
    try {
      const fh = await p.open(auditPath, 'a', 0o600);
      try { await fh.writeFile(JSON.stringify(entry) + '\n'); await fh.sync(); } finally { await fh.close(); }
    } catch (e) { throw wrap('audit', e); }
  }

  return {
    kind: 'file', dir,
    async read(resource) { return readRecord(resource); },
    async update(resource, mutate, { now: clock = now } = {}) {
      await ensureDir();
      const nonce = await lock(resource, clock);
      try {
        const rec = await readRecord(resource);
        const { next, result } = mutate(rec);
        if (next) {
          if ((await readNonce(lockPath(resource))) !== nonce) throw unavailable('lease lock lost before commit');
          await writeRecord(resource, next);
        }
        return result;
      } finally { await unlock(resource, nonce); }
    },
    audit,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// In-memory backend with failure injection. `fail` is a mode string or (op, resource) => mode, settable later:
//   'unavailable' | 'stale' -> every op throws; 'timeout' -> ops never settle (the authority's op timeout fires);
//   'partial_write' -> a committing update leaves the record corrupt and throws; 'clock_skew' -> time() is off by skewMs.
export function fakeBackend({ fail = null, skewMs = 60000, now = Date.now } = {}) {
  const records = new Map();
  const corrupt = new Set();
  const auditLog = [];
  let mode = fail;
  const failing = (op, resource) => (typeof mode === 'function' ? mode(op, resource) : mode);
  const clone = (v) => (v == null ? v : structuredClone(v));
  async function gate(op, resource) {
    const f = failing(op, resource);
    if (f === 'unavailable') throw unavailable('injected: backend unavailable');
    if (f === 'stale') throw unavailable('injected: backend state stale');
    if (f === 'timeout') return new Promise(() => {});
    if (corrupt.has(resource)) throw unavailable('corrupt lease record');
    return f;
  }
  return {
    kind: 'fake', records, auditLog,
    setFail(f) { mode = f; },
    repair(resource) { corrupt.delete(resource); },
    time() { return now() + (failing('time') === 'clock_skew' ? skewMs : 0); },
    async read(resource) { await gate('read', resource); return clone(records.get(resource) || null); },
    async update(resource, mutate) {
      const f = await gate('update', resource);
      const { next, result } = mutate(clone(records.get(resource) || null));
      if (next) {
        if (f === 'partial_write') { corrupt.add(resource); throw unavailable('injected: partial write'); }
        records.set(resource, clone(next));
      }
      return result;
    },
    async audit(entry) { auditLog.push(clone(entry)); },
  };
}
