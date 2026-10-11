// V2 lease authority (spec §12.2, docs/v2/ARCHITECTURE.md §5). The only authority for shared mutations: atomic
// conditional acquire/renew/release, a persisted per-resource generation used as the fencing token, and fail-closed
// on every doubt (an unreadable, slow, skewed or corrupt backend is E_UNAVAILABLE, never "free").
// The authority holds the rules; a backend only provides an atomic read-modify-write per resource plus an audit log.
//   backend.read(resource)                  -> record | null      (record = { resource, generation, holder })
//   backend.update(resource, mutate, ctx)   -> mutate(record|null) returns { next?, audit?, result }; `audit` lines are
//                                              persisted before `next`, and `next` is committed atomically, or neither
//   backend.audit(entry)                    -> append-only provenance (best effort for non-grant events)
//   backend.time?()                         -> the backend's clock, when it has its own (skew check)
// Any backend error is thrown; the authority maps it to E_UNAVAILABLE.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SEG = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
// File names use encodeURIComponent: '/' and ':' become %2F / %3A and '%' is never valid in a resource, so the
// mapping is injective (no two resources share files).
const NAMESPACES = [
  new RegExp(`^repo:${SEG}(?:/${SEG})?:(?:integration|main)$`),
  // D-008: non-main target branches. Git-like names; no leading '-' or '/', no trailing '/', no '//' or '..'.
  new RegExp(`^repo:${SEG}(?:/${SEG})?:branch:(?![-/])(?!.*//)[A-Za-z0-9._/-]+(?<!/)$`),
  new RegExp(`^environment:${SEG}:deploy$`),
  new RegExp(`^host:${SEG}:maintenance$`),
  new RegExp(`^service:${SEG}:${SEG}$`),
  new RegExp(`^worktree:${SEG}$`),
];
// Length cap keeps every derived file name (`.<encoded>.<uuid>.tmp`) under the 255-byte name limit.
export const MAX_RESOURCE_LEN = 150;
export const validResource = (r) => typeof r === 'string' && r.length <= MAX_RESOURCE_LEN && !r.includes('..')
  && NAMESPACES.some((re) => re.test(r));
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

  // A broken clock (NaN, Infinity) would read every holder as expired: fail closed instead.
  const clockNow = () => { const t = now(); if (!Number.isFinite(t)) throw unavailable('authority clock is not finite'); return t; };
  const safeAlert = (kind, detail) => { try { alert({ kind, at: now(), ...detail }); } catch {} };
  async function audit(entry) {
    try { await withTimeout(backend.audit({ at: now(), ...entry }), opTimeoutMs); }
    catch (e) { safeAlert('audit_failed', { op: entry.op, resource: entry.resource, error: String(e?.message || e) }); }
  }
  async function call(fn) {
    clockNow();
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
        const t = clockNow();
        if (rec?.holder && t < rec.holder.expires_at) return { result: { held: rec.holder } };
        const token = (rec ? rec.generation : 0) + 1;
        const lease = {
          resource, lease_id, owner: opts.owner, task_id: opts.task_id ?? null, token, acquired_at: t,
          expires_at: t + opts.ttl_ms, ttl_ms: opts.ttl_ms, scope: opts.scope ?? null, approval_ref: opts.approval_ref ?? null,
        };
        const prev = rec?.holder || null;
        // Provenance is part of the grant: the backend persists these lines before the record, or commits nothing.
        const lines = [
          ...(prev ? [{ at: t, op: 'fenced', resource, code: 'E_EXPIRED', token: prev.token, lease_id: prev.lease_id, by_token: token, ...who(prev) }] : []),
          { at: t, op: 'acquire', resource, lease_id, token, expires_at: lease.expires_at, ...who(opts) },
        ];
        return { next: { resource, generation: token, holder: lease, updated_at: t }, audit: lines, result: { lease } };
      }, { now }));
    } catch (e) {
      await audit({ op: 'denied', resource, code: 'E_UNAVAILABLE', lease_id, error: errMsg(e), ...who(opts) });
      safeAlert('lease_unavailable', { op: 'acquire', resource, owner: opts.owner, lease_id, error: errMsg(e) });
      // The backend may still commit after a timeout: hand back the identity so the caller can adopt() and release it.
      return { ...fail('E_UNAVAILABLE', errMsg(e)), lease_id, attempted: { resource, lease_id, owner: opts.owner, task_id: opts.task_id ?? null } };
    }
    if (out.held) {
      await audit({ op: 'denied', resource, code: 'E_HELD', held_by: out.held.owner, held_token: out.held.token, ...who(opts) });
      return { ok: false, code: 'E_HELD', holder: { owner: out.held.owner, task_id: out.held.task_id, expires_at: out.held.expires_at } };
    }
    return { ok: true, lease: { ...out.lease } };
  }

  // Re-claims a lease whose acquire reported E_UNAVAILABLE but committed anyway: only the exact attempted identity
  // (resource, lease_id, owner, task_id) of the current unexpired holder. Never acquires a free resource.
  async function adopt(attempted) {
    const a = attempted || {};
    if (!validResource(a.resource) || !str(a.lease_id) || !str(a.owner)) return fail('E_INVALID', 'not an attempted lease');
    let out;
    try {
      out = await call(() => backend.read(a.resource));
    } catch (e) {
      safeAlert('lease_unavailable', { op: 'adopt', resource: a.resource, owner: a.owner, lease_id: a.lease_id, error: errMsg(e) });
      return fail('E_UNAVAILABLE', errMsg(e));
    }
    const h = out?.holder;
    if (!h || h.lease_id !== a.lease_id || h.owner !== a.owner || h.task_id !== (a.task_id ?? null) || out.generation !== h.token) return fail('E_FENCED');
    if (!(clockNowSafe() < h.expires_at)) return fail('E_EXPIRED');
    await audit({ op: 'adopt', resource: a.resource, lease_id: h.lease_id, token: h.token, ...who(h) });
    return { ok: true, lease: { ...h } };
  }
  const clockNowSafe = () => { try { return clockNow(); } catch { return NaN; } };

  async function renew(lease) {
    if (!isLease(lease)) return fail('E_INVALID', 'not a lease');
    let out;
    try {
      out = await call(() => backend.update(lease.resource, (rec) => {
        const t = clockNow();
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
    const code = identity(rec, lease, clockNowSafe());   // NaN reads as expired: fail closed
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
        // A timed-out acquire may have committed: adopt it so the rollback releases it too.
        if (res.attempted) {
          const ad = await adopt(res.attempted);
          if (ad.ok) got.push(ad.lease);
          else if (ad.code === 'E_UNAVAILABLE') safeAlert('ghost_lease_possible', { resource: r, owner: opts.owner, lease_id: res.lease_id });
        }
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

  return { acquire, adopt, renew, release, validate, acquireAll, withLeases, fence };
}

export const fence = (authority, leases) => authority.fence(leases);

// ---------------------------------------------------------------------------------------------------------------------
// File backend: one directory on a local filesystem, shared by every process on this host. Per resource <r>:
//   <r>.lease.json  authoritative record { resource, generation, holder }; tmp+fsync+rename+fsync(dir)
//   <r>.seen        history marker written before the first record: a missing record with a marker is lost state
//   <r>.lock        O_EXCL critical section around read-check-write: { nonce, pid, host, at }
//   <r>.break       O_EXCL: serializes stale-lock breakers
//   <r>.moved       a lock a breaker has displaced; while it exists new lockers back off
//   audit.jsonl     append-only provenance (fsync per append); grant lines are written inside the critical section
// A lock is broken only if its owner is not a live process on this host, the resource's holder is expired or absent,
// and the lock file is older than staleLockMs. The breaker holds <r>.break, re-stats the lock, renames it to <r>.moved
// and checks dev/ino/mtime. On a mismatch it displaced a fresh lock: lockers that arrive meanwhile see <r>.moved and
// back off, so the slot stays free until the breaker links the lock back (or its owner, finishing, removes <r>.moved).
// A crashed breaker leaves <r>.break / <r>.moved behind: the resource then fails closed until manual recovery
// (docs/v2/LEASES.md).
export function fileBackend({ dir, fs = nodeFs, staleLockMs = 30000, lockWaitMs = 5000, randomId = randomUUID, now = Date.now } = {}) {
  if (!dir) throw new Error('fileBackend: dir required');
  const p = fs.promises || fs;
  const host = hostname();
  const key = (r) => encodeURIComponent(r);
  const path = (r, ext) => join(dir, `${key(r)}.${ext}`);
  const auditPath = join(dir, 'audit.jsonl');
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const wrap = (what, e) => (e?.code === 'E_UNAVAILABLE' ? e : unavailable(`${what}: ${e?.code || e?.message || e}`));
  const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
  const statOrNull = async (f) => { try { return await p.stat(f); } catch (e) { if (e.code === 'ENOENT') return null; throw wrap('stat', e); } };
  const readJson = async (f) => { try { return JSON.parse(await p.readFile(f, 'utf8')); } catch { return null; } };
  const readNonce = async (f) => (await readJson(f))?.nonce ?? null;
  const pidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  let ready = null;
  const ensureDir = () => (ready ||= p.mkdir(dir, { recursive: true, mode: 0o700 }).catch((e) => { ready = null; throw wrap('mkdir', e); }));

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

  async function readRecord(resource) {
    let txt;
    try { txt = await p.readFile(path(resource, 'lease.json'), 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw wrap('read', e);
      // O(1) lost-state guard: restarting the generation after a lost record could reuse a token.
      if (await statOrNull(path(resource, 'seen'))) throw unavailable('lease record missing but resource has history');
      return null;
    }
    return parseRecord(txt, resource);
  }

  async function fsyncDir() {
    const dh = await p.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  }

  async function writeDurable(file, text, flags) {
    const fh = await p.open(file, flags, 0o600);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  }

  async function writeRecord(resource, rec) {
    const tmp = join(dir, `.${key(resource)}.${randomId()}.tmp`);
    try {
      await writeDurable(tmp, JSON.stringify(rec), 'wx');
      await p.rename(tmp, path(resource, 'lease.json'));
      await fsyncDir();
    } catch (e) {
      await p.unlink(tmp).catch(() => {});
      throw wrap('write', e);
    }
  }

  async function appendAudit(entries) {
    try { await writeDurable(auditPath, entries.map((e) => JSON.stringify(e) + '\n').join(''), 'a'); }
    catch (e) { throw wrap('audit', e); }
  }

  async function maybeBreak(resource, clock) {
    const lp = path(resource, 'lock'), moved = path(resource, 'moved'), bp = path(resource, 'break');
    const st = await statOrNull(lp);
    if (!st || now() - st.mtimeMs < staleLockMs) return;
    const info = await readJson(lp);
    if (info?.host === host && pidAlive(info.pid)) return;          // owner still running here: never break
    const rec = await readRecord(resource);                         // corrupt -> throws: never break on doubt
    if (rec?.holder && clock() < rec.holder.expires_at) return;     // live holder: wait, then fail closed
    let bh;
    try { bh = await p.open(bp, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return; throw wrap('break lock', e); }
    try {
      try { await bh.writeFile(JSON.stringify({ pid: process.pid, host, at: now() })); } finally { await bh.close(); }
      if (!sameFile(st, await statOrNull(lp))) return;              // changed since judged: not ours to break
      try { await p.rename(lp, moved); } catch (e) { if (e.code === 'ENOENT') return; throw wrap('lock break', e); }
      if (sameFile(st, await statOrNull(moved))) {
        await p.unlink(moved).catch(() => {});
        await appendAudit([{ at: now(), op: 'lock_broken', resource, lock_age_ms: now() - st.mtimeMs, lock_pid: info?.pid ?? null }]).catch(() => {});
        return;
      }
      // Displaced a fresh lock. New lockers back off while <r>.moved exists, so the slot frees up for the restore.
      const deadline = performance.now() + Math.max(lockWaitMs, 1000) * 4;
      for (;;) {
        try { await p.link(moved, lp); break; }
        catch (e) {
          if (e.code === 'ENOENT') return;                          // its owner finished and removed it
          if (e.code !== 'EEXIST') throw wrap('lock restore', e);
        }
        if (performance.now() > deadline) throw unavailable('lock restore timed out; manual recovery needed');
        await nap(2);
      }
      await p.unlink(moved).catch(() => {});
    } finally { await p.unlink(bp).catch(() => {}); }
  }

  async function lock(resource, clock) {
    const lp = path(resource, 'lock'), moved = path(resource, 'moved');
    const nonce = String(randomId());
    const deadline = performance.now() + lockWaitMs;
    for (let i = 0; ; i++) {
      let fh = null;
      try { fh = await p.open(lp, 'wx', 0o600); }
      catch (e) { if (e.code !== 'EEXIST') throw wrap('lock', e); }
      if (fh) {
        try { await fh.writeFile(JSON.stringify({ nonce, pid: process.pid, host, at: now() })); await fh.sync(); await fh.close(); }
        catch (e) { await fh.close().catch(() => {}); await p.unlink(lp).catch(() => {}); throw wrap('lock write', e); }
        let displaced;
        try { displaced = await statOrNull(moved); } catch (e) { await unlock(resource, nonce); throw e; }
        if (!displaced) return nonce;
        await unlock(resource, nonce);                              // a breaker is restoring someone's lock: yield
      } else {
        await maybeBreak(resource, clock);
      }
      if (performance.now() > deadline) throw unavailable('lease lock busy');
      await nap(Math.min(50, 1 + Math.floor(Math.random() * (2 + i))));
    }
  }

  // Our lock may sit at <r>.moved while a breaker restores it: wait (bounded) for it to come back.
  async function ownsLock(resource, nonce) {
    const deadline = performance.now() + lockWaitMs;
    for (;;) {
      if ((await readNonce(path(resource, 'lock'))) === nonce) return true;
      if ((await readNonce(path(resource, 'moved'))) !== nonce || performance.now() > deadline) return false;
      await nap(2);
    }
  }

  async function unlock(resource, nonce) {
    const lp = path(resource, 'lock'), moved = path(resource, 'moved');
    if ((await readNonce(lp)) === nonce) { await p.unlink(lp).catch(() => {}); return; }
    if ((await readNonce(moved)) !== nonce) return;
    await p.unlink(moved).catch(() => {});                          // the breaker's restore then finds nothing to link
    if ((await readNonce(lp)) === nonce) await p.unlink(lp).catch(() => {});   // ...unless it linked first
  }

  return {
    kind: 'file', dir,
    async read(resource) { return readRecord(resource); },
    async update(resource, mutate, { now: clock = now } = {}) {
      await ensureDir();
      const nonce = await lock(resource, clock);
      try {
        const rec = await readRecord(resource);
        const { next, audit: lines, result } = mutate(rec);
        if (next) {
          if (!(await ownsLock(resource, nonce))) throw unavailable('lease lock lost before commit');
          if (lines?.length) await appendAudit(lines);
          if (!rec) await writeDurable(path(resource, 'seen'), JSON.stringify({ resource }), 'w').then(fsyncDir).catch((e) => { throw wrap('history marker', e); });
          await writeRecord(resource, next);
        }
        return result;
      } finally { await unlock(resource, nonce); }
    },
    async audit(entry) { await ensureDir(); await appendAudit([entry]); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// In-memory backend with failure injection. `fail` is a mode string or (op, resource) => mode, settable later:
//   'unavailable' | 'stale' -> every op throws; 'timeout' -> ops never settle (the authority's op timeout fires);
//   'partial_write' -> a committing update leaves the record corrupt and throws; 'clock_skew' -> time() is off by skewMs;
//   'audit_fail' -> audit appends throw (a grant then commits nothing).
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
  const append = (entries) => {
    if (failing('audit') === 'audit_fail') throw unavailable('injected: audit append failed');
    for (const e of entries) auditLog.push(clone(e));
  };
  return {
    kind: 'fake', records, auditLog,
    setFail(f) { mode = f; },
    repair(resource) { corrupt.delete(resource); },
    time() { return now() + (failing('time') === 'clock_skew' ? skewMs : 0); },
    async read(resource) { await gate('read', resource); return clone(records.get(resource) || null); },
    async update(resource, mutate) {
      const f = await gate('update', resource);
      const { next, audit: lines, result } = mutate(clone(records.get(resource) || null));
      if (next) {
        if (lines?.length) append(lines);
        if (f === 'partial_write') { corrupt.add(resource); throw unavailable('injected: partial write'); }
        records.set(resource, clone(next));
      }
      return result;
    },
    async audit(entry) { append([entry]); },
  };
}
