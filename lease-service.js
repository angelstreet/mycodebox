// Central lease service (round 10, docs/v2/LEASES-CENTRAL.md). The one writer of every lease and of the deploy queue.
// One in-memory index behind one async mutex; every change is a "fact" appended to <dir>/journal.jsonl (fsync before the
// reply) and applied by the same deterministic apply() the replay uses; <dir>/snapshot.json is the compacted state.
// Fail closed (as orchestration/lease-authority.js): a corrupt journal or snapshot, a lost state dir or a disk error is
// E_UNAVAILABLE, never "free". Every grant writes an audit line (<dir>/audit.jsonl) before the journal commit.
//
// Methods (all async, one object argument; see Appendix A of the design): claim, ticket(id, opts), cancelTicket(id, opts),
// release, renew, heartbeat, narrow, setMode, list, check, events, ownerRelease, sessionGone(session, opts),
// sessionStatus(session, status), tick(), deploy.{request,approve,cancel,start,finish,record,list,wait,last},
// shadow.{op,report,list}, importLegacy, status, close. Errors: { ok:false, code, error, ...extra }.
import fs from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

// ---------------------------------------------------------------------------------------------------------------------
// Resources and the conflict matrix (design section 3)
// ---------------------------------------------------------------------------------------------------------------------
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = NAME_RE;
const RANK = { env: 0, server: 1, frontend: 2, host: 3, device: 4 };   // broadest first
const RUNNER = 'manager:deploy';
const SCOPES = ['frontend', 'host', 'server', 'full'];
const MODES = ['exclusive', 'pin', 'observe'];
const MODE_RANK = { exclusive: 2, pin: 1, observe: 0 };
const KIND_ALIASES = { run: 'server', maintenance: 'host' };
const GENERIC = ['frontend', 'server', 'hosts'];
const MIN = 60000;

const fail = (code, error, extra) => ({ ok: false, code, error, ...extra });
const unavailable = (msg) => fail('E_UNAVAILABLE', msg);
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const secs = (ms) => (ms == null ? null : Math.floor(ms / 1000));
const nameOk = (s) => NAME_RE.test(s);

// -> { type, host?, device? } | null. Legacy spellings: '*', 'frontend', 'server', '<h>', '<h>/<d>'; typed: 'env:*',
// 'host:<h>', 'device:<h>/<d>'.
export function parseResource(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 140) return null;
  if (s === '*' || s === 'env:*') return { type: 'env' };
  if (s === 'frontend') return { type: 'frontend' };
  if (s === 'server') return { type: 'server' };
  let m = /^host:([^/:\s]+)$/.exec(s);
  if (m) return nameOk(m[1]) ? { type: 'host', host: m[1] } : null;
  m = /^device:([^/:\s]+)\/([^/:\s]+)$/.exec(s);
  if (m) return nameOk(m[1]) && nameOk(m[2]) ? { type: 'device', host: m[1], device: m[2] } : null;
  m = /^([^/:\s]+)$/.exec(s);
  if (m) return nameOk(m[1]) ? { type: 'host', host: m[1] } : null;
  m = /^([^/:\s]+)\/([^/:\s]+)$/.exec(s);
  if (m) return nameOk(m[1]) && nameOk(m[2]) ? { type: 'device', host: m[1], device: m[2] } : null;
  return null;
}
export const canonical = (r) => (r.type === 'env' ? '*' : r.type === 'host' ? `host:${r.host}` : r.type === 'device' ? `device:${r.host}/${r.device}` : r.type);
export const legacyName = (r) => (r.type === 'env' ? '*' : r.type === 'host' ? r.host : r.type === 'device' ? `${r.host}/${r.device}` : r.type);
const parsedCache = new Map();   // bounded (LRU, 1000): resources arrive from clients
const P = (c) => {
  let r = parsedCache.get(c);
  if (r !== undefined) { parsedCache.delete(c); parsedCache.set(c, r); return r; }
  r = parseResource(c);
  parsedCache.set(c, r);
  if (parsedCache.size > 1000) parsedCache.delete(parsedCache.keys().next().value);
  return r;
};
// Leases made by in-process callers (the dashboard, the deploy runner) carry this client name; no token can have it (names cannot contain ':').
export const INTERNAL = 'internal:process';
const kindOf = (l, c) => (l.resKinds && l.resKinds[c]) || l.kind;     // sensitivity per row (legacy narrow --resource)
const serverKinded = (l) => l.resources.some((c) => { const t = P(c).type; return (t === 'host' || t === 'device') && kindOf(l, c) === 'server'; });

// A new exclusive claim of resource n against a held exclusive lease on h (design matrix). heldKind = the held lease's sensitivity.
function oneWay(n, h, heldKind) {
  if (h.type === 'env' || n.type === 'env') return true;
  switch (n.type) {
    case 'frontend': return h.type === 'frontend';
    case 'server': return h.type === 'server' || ((h.type === 'host' || h.type === 'device') && heldKind === 'server');
    case 'host': return (h.type === 'host' || h.type === 'device') && h.host === n.host;
    case 'device': return (h.type === 'host' && h.host === n.host) || (h.type === 'device' && h.host === n.host && h.device === n.device);
    default: return false;
  }
}
// Does resource a cover b (for narrowing)? env covers everything; a host covers its devices.
// The relation is symmetric: M[a][b] || M[b][a], the sensitivity read from whichever side is the host/device lease.
export function resourceConflict(n, h, nKind = 'server', hKind = 'server') { return oneWay(n, h, hKind) || oneWay(h, n, nKind); }
const covers = (a, b) => a.type === 'env' || canonical(a) === canonical(b) || (a.type === 'host' && b.type === 'device' && a.host === b.host);
const leaseType = (l) => l.resources.map((c) => P(c).type).sort((a, b) => RANK[a] - RANK[b])[0] || 'env';
// Lease vs lease. Only exclusive leases conflict (unless ignoreModes: the pin footprint check); the same agent never
// conflicts with itself; two `shared` leases never conflict with each other (a shared exclusive lease conflicts only with non-shared ones).
function leasesConflict(a, b, ignoreModes = false) {
  if (!ignoreModes && (a.mode !== 'exclusive' || b.mode !== 'exclusive')) return false;
  if (a.agent === b.agent) return false;
  if (a.deployId && a.deployId === b.deployId) return false;      // a claim that joined a running deploy's lease group
  if (a.shared && b.shared) return false;
  return a.resources.some((x) => b.resources.some((y) => resourceConflict(P(x), P(y), kindOf(a, x), kindOf(b, y))));
}
const PRIOS = ['P0', 'P1', 'P2', 'P3'];     // P3 = background (scheduled bots)
const isPrio = (p) => PRIOS.includes(p);
const prioRank = (p) => PRIOS.indexOf(p);
const defaultKind = (parsed) => (parsed.length && parsed.every((r) => r.type === 'device') ? 'host' : 'server');
// Which resources a deploy of this scope disturbs (pending deploys block new claims on these).
function scopeTouches(scope, hosts, r) {
  if (r.type === 'env' || scope === 'full') return true;
  if (scope === 'frontend') return r.type === 'frontend';
  if (scope === 'server') return r.type !== 'frontend';
  if (r.type === 'frontend' || r.type === 'server') return false;                  // host
  return !hosts?.length || hosts.includes(r.host);
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const freshState = () => ({ seq: 0, leases: {}, gens: {}, tickets: {}, deploys: [], deployed: {}, recorded: [], events: [], evN: 0, stats: [], requests: {} });
const newId = (taken) => { for (;;) { const id = randomBytes(4).toString('hex'); if (!taken(id)) return id; } };

// Start time (clock ticks since boot) of a local pid, or null when it is gone: pid + start time identifies a process even after the pid is reused.
export function procStartOf(pid) {
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}
const defaultIo = {
  async append(path, data, sync) {
    const fh = await fs.promises.open(path, 'a', 0o600);
    try { await fh.appendFile(data); if (sync) await fh.sync(); } finally { await fh.close(); }
  },
};

export function createLeaseService({ dir, now: nowIn = Date.now, sessions, onEvent, config = {} } = {}) {
  if (!dir) throw new Error('lease service needs a dir');
  const now = () => { const t = nowIn(); if (!Number.isFinite(t)) throw new Error('wall clock is not finite'); return t; };   // wall clock: TTL and display only
  const mono = config.mono || (() => performance.now());       // heartbeat-miss, idle and ticket-poll clocks never follow the wall clock
  const cfg = {
    envs: [], ttlDefaultMin: 120, ttlMaxMin: 480, ttlCapMin: 24 * 60, reserveMs: 2 * MIN, passMax: 3, strictAgeMs: 15 * MIN, requestKeepMs: 24 * 60 * MIN, missFactor: 3, holderCheckMs: 30 * 1000, holderDeadChecks: 2, ticketIdleMs: 2 * MIN, goneGraceMs: 2 * MIN,
    snapshotEvery: 200, runningMaxMin: 90, deployLeaseMin: 12,
    // Priority (owner 2026-10-20): every lease and ticket carries its holder's P0..P2 (P0 highest). A lease of priority `lowPriority` or lower is capped at
    // `lowPriorityMaxTtlMin` per claim/renew and cannot be renewed while a ticket of strictly higher priority waits on a resource it blocks (`yield`).
    defaultPriority: 'P1', lowPriority: 'P2', lowPriorityMaxTtlMin: 10,
    // Hard cap (owner 2026-10-27): no claim or renewal of a non-system lease gets more than `maxClaimMin`, and while anyone waits the continuous hold
    // (since the claim began) may not pass it either. System leases (deploy runner, `exempt`) keep their own limits.
    maxClaimMin: 60, overCapGraceMs: 10 * MIN, keepFinished: 50, deployTtlMin: 360, maxEvents: 5000, readonly: false, io: defaultIo,
    ...config,
    idleMs: { env: 20 * MIN, server: 20 * MIN, frontend: 20 * MIN, host: 20 * MIN, device: 20 * MIN, ...(config.idleMs || {}) },
  };
  const io = cfg.io;
  const journalPath = join(dir, 'journal.jsonl');
  const snapshotPath = join(dir, 'snapshot.json');
  const auditPath = join(dir, 'audit.jsonl');
  const initPath = join(dir, '.initialized');

  let S = freshState();
  let broken = null;                // reason string: corrupt / lost / write failure -> everything E_UNAVAILABLE
  let snapSeq = 0;
  const polls = new Map();          // ticket id -> last poll (monotonic ms; not journaled, reset on start)
  const clk = new Map();            // lease id -> { hb, act } monotonic ms; reset to "now" on every start (an outage is never a missed heartbeat)
  const depWaiters = new Map();     // agent|id -> { agent, deployId, env, since, seen }
  const wakeups = new Set();

  // ---- events ------------------------------------------------------------------------------------------------------
  function ev(kind, l, at, extra = {}) {
    const e = { n: ++S.evN, at, kind, ...(l ? { id: l.id, env: l.env, resources: l.resources, agent: l.agent, session: l.session || null, mode: l.mode, ...(l.id ? { purpose: l.purpose || '', leaseKind: l.kind || null, since: l.since ?? null } : {}) } : {}), ...extra };
    S.events.push(e);
    if (S.events.length > cfg.maxEvents) S.events.splice(0, S.events.length - cfg.maxEvents);
  }
  const evTicket = (tk, at, state) => ev('ticket', { env: tk.env, resources: tk.resources, agent: tk.agent, session: tk.session, mode: tk.mode }, at, { ticket: tk.id, state });

  function pruneRequests(at) { for (const [k, r] of Object.entries(S.requests)) if (r.at < at - cfg.requestKeepMs) delete S.requests[k]; }
  // ---- apply: the only code that changes state (live and replay) ---------------------------------------------------
  function apply(f) {
    S.seq = f.seq;
    switch (f.t) {
      case 'grant': {
        const l = f.lease;
        S.leases[l.id] = l;
        for (const [k, g] of Object.entries(l.gens)) S.gens[k] = Math.max(S.gens[k] || 0, g);
        clk.set(l.id, { hb: mono(), act: mono() });
        if (f.ticket) polls.delete(f.ticket);
        if (f.rkey) S.requests[f.rkey] = { kind: 'lease', ref: l.id, at: f.at };
        pruneRequests(f.at);
        if (f.ticket && S.tickets[f.ticket]) Object.assign(S.tickets[f.ticket], { state: 'granted', leaseId: l.id, grantedAt: f.at });
        if (l.mode === 'exclusive') {
          for (const p of Object.values(S.leases)) {
            if (p.mode === 'pin' && p.id !== l.id && p.env === l.env && leasesConflict(l, p, true)) ev('pin_overlap', p, f.at, { by_lease: l.id, by_agent: l.agent });
          }
        }
        ev('granted', l, f.at, f.ticket ? { ticket: f.ticket } : {});
        break;
      }
      case 'release': {
        for (const id of f.ids) {
          const l = S.leases[id];
          if (!l) continue;
          if (l.mode === 'exclusive') {
            S.stats.push({ type: leaseType(l), min: Math.max(0, (f.at - l.since) / MIN), at: f.at });
            const cut = f.at - 7 * 24 * 60 * MIN;
            if (S.stats.length > 2000 || S.stats[0].at < cut) S.stats = S.stats.filter((s) => s.at >= cut).slice(-2000);
          }
          delete S.leases[id];
          clk.delete(id);
          ev(f.why, l, f.at, { by: f.by, reason: f.reason, ...(f.detail ? { detail: f.detail } : {}), held_min: Math.round((f.at - l.since) / MIN) });
        }
        break;
      }
      case 'renew': { const l = S.leases[f.id]; if (l) { l.expires = f.expires; l.ttlMin = f.ttlMin; l.lastHb = f.lastHb ?? f.at; } break; }
      case 'hb': { const l = S.leases[f.id]; if (l) { l.lastHb = f.at; l.reservedUntil = null; const c = clk.get(l.id); if (c) { c.hb = mono(); if (f.active) c.act = mono(); } } break; }
      case 'yield': { const l = S.leases[f.id]; if (l) { if (f.clear) delete l.yieldAt; else { l.yieldAt = f.at; ev('yield', l, f.at, { priority: prioOf(l), waiting: f.waiting, reason: 'a claim of higher priority is waiting: stop at the next turn boundary and release' }); } } break; }
      case 'collect': { const l = S.leases[f.id]; if (l) l.reservedUntil = null; break; }
      case 'tkt_pass': for (const id of f.ids) if (S.tickets[id]) S.tickets[id].passed = (S.tickets[id].passed || 0) + 1; break;
      case 'flag': { const l = S.leases[f.id]; if (l) ev('flag', l, f.at, { status: f.status, text: f.text, reason: f.reason }); break; }
      case 'mode': { const l = S.leases[f.id]; if (l) { const from = l.mode; l.mode = f.to; ev('downgraded', l, f.at, { from, to: f.to, by: f.by, reason: f.reason }); } break; }
      case 'narrow': {
        const l = S.leases[f.id];
        if (l) { const from = { resources: l.resources, sensitivity: l.kind, rows: l.resKinds || null }; l.resources = f.resources; l.kind = f.sensitivity; l.resKinds = f.resKinds || null; ev('narrowed', l, f.at, { from, by: f.by, reason: f.reason, count: f.count ?? null }); }
        break;
      }
      case 'tkt_new': f.ticket.order = f.seq; S.tickets[f.ticket.id] = f.ticket; if (f.rkey) S.requests[f.rkey] = { kind: 'ticket', ref: f.ticket.id, at: f.at }; pruneRequests(f.at); evTicket(f.ticket, f.at, 'waiting'); break;
      case 'tkt_end': { polls.delete(f.id); const tk = S.tickets[f.id]; if (tk) { tk.state = f.state; tk.endedAt = f.at; evTicket(tk, f.at, f.state); } break; }
      case 'gone': for (const l of Object.values(S.leases)) if (l.session === f.session || l.agent === f.session) { if (f.clear) delete l.goneAt; else l.goneAt = l.goneAt || f.at; } break;
      case 'dep_set': {
        const i = S.deploys.findIndex((d) => d.id === f.deploy.id);
        if (i < 0) S.deploys.push(f.deploy); else S.deploys[i] = f.deploy;
        const active = S.deploys.filter((d) => ['awaiting-approval', 'queued', 'running'].includes(d.state));
        const done = S.deploys.filter((d) => !active.includes(d)).sort((a, b) => (a.finished || 0) - (b.finished || 0)).slice(-cfg.keepFinished);
        S.deploys = [...active, ...done].sort((a, b) => a.created - b.created);
        if (f.event) ev('deploy', null, f.at, { deploy: f.deploy.id, env: f.deploy.env, state: f.deploy.state, event: f.event, agent: f.deploy.agent });
        break;
      }
      case 'deployed': {
        S.deployed[f.env] = f.map;
        if (f.deployId) { S.recorded.push(f.deployId); if (S.recorded.length > 5000) S.recorded.splice(0, S.recorded.length - 5000); }
        break;
      }
      default: throw new Error(`unknown journal fact ${f.t}`);
    }
  }

  // ---- load / persist ----------------------------------------------------------------------------------------------
  function load() {
    S = freshState();
    snapSeq = 0;
    const hadSnap = fs.existsSync(snapshotPath);
    const hadJournal = fs.existsSync(journalPath);
    if (!hadSnap && !hadJournal && fs.existsSync(initPath)) throw new Error('lease state is missing (journal and snapshot gone) - restore it');
    if (hadSnap) {
      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (!snap || snap.version !== 1 || typeof snap.state !== 'object') throw new Error('snapshot unreadable');
      S = { ...freshState(), ...snap.state };
      snapSeq = Number.isInteger(snap.journal_seq) ? snap.journal_seq : S.seq;
      S.seq = snapSeq;
    }
    if (hadJournal) {
      const text = fs.readFileSync(journalPath, 'utf8');
      const lines = text.split('\n');
      const torn = !text.endsWith('\n') && text.length > 0;   // a crash mid-append: that write was never acknowledged
      let goodLen = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') { goodLen += 1; continue; }
        const last = i === lines.length - 1;
        let f;
        try { f = JSON.parse(line); } catch {
          if (last && torn) break;
          throw new Error(`journal corrupt at line ${i + 1}`);
        }
        goodLen += Buffer.byteLength(line) + 1;
        if (f.seq <= snapSeq) continue;
        if (f.seq !== S.seq + 1) throw new Error(`journal gap at line ${i + 1} (seq ${f.seq} after ${S.seq})`);
        apply(f);
      }
      if (torn && !cfg.readonly) fs.truncateSync(journalPath, Math.min(goodLen, Buffer.byteLength(text)));
    }
    const t = now();
    clk.clear();
    for (const l of Object.values(S.leases)) { clk.set(l.id, { hb: mono(), act: mono() }); if (l.reservedUntil) l.reservedUntil = t + cfg.reserveMs; }
    for (const tk of Object.values(S.tickets)) if (tk.state === 'waiting') polls.set(tk.id, mono());
  }
  function writeSnapshot() {
    try {
      const tmp = `${snapshotPath}.${process.pid}.tmp`;
      const cut = now() - 60 * MIN;
      for (const [id, tk] of Object.entries(S.tickets)) if (tk.state !== 'waiting' && (tk.endedAt || tk.grantedAt || 0) < cut) delete S.tickets[id];
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ version: 1, journal_seq: S.seq, state: S })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, snapshotPath);
      snapSeq = S.seq;
      fs.writeFileSync(`${journalPath}.tmp`, '', { mode: 0o600 });
      fs.renameSync(`${journalPath}.tmp`, journalPath);
    } catch (e) { /* the journal still holds everything; try again at the next threshold */ }
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    load();
    if (!cfg.readonly) { writeSnapshot(); fs.writeFileSync(initPath, `${iso(now())}\n`, { mode: 0o600 }); }
  } catch (e) { broken = String(e.message || e).slice(0, 200); S = freshState(); }

  const auditLine = (f) => JSON.stringify({ ts: iso(f.at), seq: f.seq, event: f.imported ? 'import-grant' : 'grant', id: f.lease.id, env: f.lease.env, resources: f.lease.resources, agent: f.lease.agent, mode: f.lease.mode, generation: f.lease.generation, ticket: f.ticket || null }) + '\n';
  async function persist(pending) {
    const grants = pending.filter((f) => f.t === 'grant');
    if (grants.length) await io.append(auditPath, grants.map(auditLine).join(''), false);    // audit before the commit
    await io.append(journalPath, pending.map((f) => JSON.stringify(f)).join('\n') + '\n', true);
  }

  // ---- mutex + operation wrappers ----------------------------------------------------------------------------------
  let chain = Promise.resolve();
  const lock = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const wake = () => { for (const w of [...wakeups]) w(); };

  // After a durable commit (writes and the housekeeping that reads trigger): snapshot, tell the observer about every new event, wake long-polls.
  function afterCommit(before) {
    if (S.seq - snapSeq >= cfg.snapshotEvery) writeSnapshot();
    if (onEvent) for (const e of S.events) if (e.n > before) { try { onEvent(e); } catch { /* observer errors never matter */ } }
    wake();
  }
  async function mutate(fn) {
    return lock(async () => {
      if (broken) return unavailable(`lease service is read-only: ${broken}`);
      if (cfg.readonly) return unavailable('lease service opened read-only');
      const before = S.evN;
      const pending = [];
      const emit = (f) => { f.seq = S.seq + 1; if (f.at == null) f.at = now(); apply(f); pending.push(f); };
      let out;
      try { housekeeping(emit); out = fn(emit); grantTickets(emit); yieldSweep(emit); } catch (e) { out = fail('E_UNAVAILABLE', `internal error: ${String(e.message || e).slice(0, 120)}`); }
      if (pending.length) {
        try { await persist(pending); } catch (e) {
          broken = `journal write failed: ${String(e.message || e).slice(0, 120)}`;     // memory is ahead of disk: fail closed until restart
          return unavailable(`lease service is read-only: ${broken}`);
        }
        afterCommit(before);
      }
      return out;
    });
  }
  async function read(fn) {
    return lock(async () => {
      if (broken) return unavailable(`lease service is read-only: ${broken}`);
      if (!cfg.readonly) {
        const before = S.evN;
        const pending = [];
        const emit = (f) => { f.seq = S.seq + 1; if (f.at == null) f.at = now(); apply(f); pending.push(f); };
        housekeeping(emit);
        if (pending.length) {
          try { await persist(pending); } catch (e) { broken = `journal write failed: ${String(e.message || e).slice(0, 120)}`; return unavailable(`lease service is read-only: ${broken}`); }
          afterCommit(before);
        }
      }
      return fn();
    });
  }
  const sleepUntilWake = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); wakeups.delete(done); resolve(); };
    const t = setTimeout(done, Math.max(0, ms));
    wakeups.add(done);
  });

  // ---- views -------------------------------------------------------------------------------------------------------
  function leaseView(l) {
    const t = now();
    return {
      id: l.id, env: l.env, resources: l.resources, legacy: l.resources.map((c) => legacyName(P(c))), type: leaseType(l), mode: l.mode,
      kind: l.kind, kinds: l.resKinds || null, agent: l.agent, client: l.client || null, session: l.session || null, purpose: l.purpose || '', provider: l.provider || '',
      shared: !!l.shared, since: iso(l.since), expires_at: iso(l.expires), ttl_min: l.ttlMin, ttlLeftMin: Math.floor((l.expires - t) / MIN),
      long: l.ttlMin > 240, idleMin: Math.floor((mono() - (clk.get(l.id)?.act ?? mono())) / MIN), lastHeartbeatAt: iso(l.lastHb), generation: l.generation, gens: l.gens,
      heartbeat_s: l.heartbeatS ?? null, holder_pid: l.holderPid ?? null, holder_host: l.holderHost ?? null, holder_src: l.holderSrc ?? null, expect_min: l.expectMin ?? null, eta: iso(expectedEnd(l)), eta_latest: iso(l.expires), eta_basis: etaBasis(l), system: !!l.system, deploy_id: l.deployId || null, reserved_until: iso(l.reservedUntil),  goneAt: iso(l.goneAt), imported: !!l.imported,
      priority: prioOf(l), priority_source: l.prioritySrc || 'default', ttl_clamped_from: l.ttlClampedFrom ?? null, yield_required: yieldWaiters(l).length > 0,
    };
  }
  function deployView(d) {
    const o = { ...d, created: secs(d.created), expires: secs(d.expires), approvedAt: secs(d.approvedAt), started: secs(d.started), finished: secs(d.finished) };
    for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
    return o;
  }

  // ---- ETA ---------------------------------------------------------------------------------------------------------
  function medianHoldMin(type) {
    const cut = now() - 7 * 24 * 60 * MIN;
    const xs = S.stats.filter((s) => s.type === type && s.at >= cut).map((s) => s.min);
    return xs.length >= 3 ? med(xs) : null;
  }
  const holdMs = (x) => (x.expectMin ?? medianHoldMin(leaseType(x)) ?? 10) * MIN;
  const samples = (type) => { const cut = now() - 7 * 24 * 60 * MIN; return S.stats.filter((x) => x.type === type && x.at >= cut).map((x) => x.min); };
  const p75 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.75))];
  // The holder's own statement (expect_min) wins; else the conditional estimate: the median remaining time of past holds
  // that lasted longer than this one already has (p75 of all holds when too few did), never past the TTL.
  function expectedEnd(l) {
    const t = now();
    if (l.expectMin != null) return Math.min(l.expires, Math.max(t, l.since + l.expectMin * MIN));
    const xs = samples(leaseType(l));
    if (xs.length < 3) return Math.min(l.expires, Math.max(t, l.since + 10 * MIN));
    const held = (t - l.since) / MIN;
    const longer = xs.filter((x) => x > held).map((x) => x - held);
    const remain = longer.length >= 2 ? med(longer) : Math.max(1, p75(xs) - held);
    return Math.min(l.expires, t + remain * MIN);
  }
  const etaBasis = (l) => (l.expectMin != null ? 'stated' : samples(leaseType(l)).length >= 3 ? 'median' : 'default');
  const byQueue = (a, b) => a.created - b.created || a.order - b.order;
  const waitingTickets = (env) => Object.values(S.tickets).filter((tk) => tk.state === 'waiting' && (!env || tk.env === env)).sort(byQueue);
  const inEnv = (env) => Object.values(S.leases).filter((l) => l.env === env);
  const heldConflicts = (virt) => inEnv(virt.env).filter((l) => leasesConflict(virt, l));
  function etaOf(virt, ahead) {
    const t = now();
    let end = t;
    for (const b of heldConflicts(virt)) end = Math.max(end, expectedEnd(b));
    for (const a of ahead) end += holdMs(a);
    return end;
  }
  const latestOf = (virt) => Math.max(now(), ...heldConflicts(virt).map((b) => b.expires));
  // A ticket that waits only on leases of `agent` itself (it has holders, and every one is that agent's) is not ahead of that
  // agent's own claim/ticket: the agent releases only after its own deploy, so queueing it behind that ticket is a deadlock.
  const waitsOnlyOn = (o, agent) => { const hs = heldConflicts(o); return hs.length > 0 && hs.every((l) => l.agent === agent); };
  const aheadOf = (virt, tk) => waitingTickets(virt.env).filter((o) => (!tk || o.id !== tk.id) && (!tk || byQueue(o, tk) < 0) && leasesConflict(virt, o) && !waitsOnlyOn(o, virt.agent));
  function ticketView(tk) {
    const out = { id: tk.id, state: tk.state, priority_since: iso(tk.created), env: tk.env, resources: tk.resources, agent: tk.agent, session: tk.session || null, created: iso(tk.created), purpose: tk.purpose || '', request_id: tk.requestId || null, kind: tk.kind, priority: prioOf(tk) };
    if (tk.state === 'waiting') {
      const ahead = aheadOf(tk, tk);
      const t = etaOf(tk, ahead);
      Object.assign(out, { behind: ahead.map((a) => a.id), position: ahead.length + 1, priority_since: iso(tk.created), eta: iso(t), eta_latest: iso(latestOf(tk)), eta_in_min: Math.max(0, Math.ceil((t - now()) / MIN)), holders: heldConflicts(tk).map(leaseView) });
    }
    if (tk.state === 'granted' && S.leases[tk.leaseId]) out.lease = leaseView(S.leases[tk.leaseId]);
    if (tk.state === 'granted') out.lease_id = tk.leaseId;
    return out;
  }

  // ---- deploys: touches / blockers ---------------------------------------------------------------------------------
  // A queued or running deploy blocks a new exclusive claim exactly where its own virtual lease would conflict (the typed matrix):
  // a queued host deploy never blocks frontend, a server deploy does not block a kind=host device claim.
  function deployTouches(d, req) {
    const v = (rs, kind = 'server') => ({ mode: 'exclusive', agent: '\0deploy', shared: false, resources: rs, kind });
    const r = { resources: req.resources, kind: req.kind, resKinds: req.resKinds, agent: req.agent, shared: req.shared, mode: 'exclusive', deployId: req.deployId };
    if (d.scope === 'frontend') return leasesConflict(v(['frontend']), r);
    if (d.scope === 'server') return leasesConflict(v(['server']), r);
    if (d.scope === 'full') return leasesConflict(v(['*']), r);
    if (d.hosts?.length) return leasesConflict(v(d.hosts.map((h) => `host:${h}`), 'host'), r);
    return r.resources.some((c) => ['env', 'host', 'device'].includes(P(c).type));       // host deploy of every host
  }
  const pendingFor = (env, req, joinId) => S.deploys.filter((d) => d.id !== joinId && d.env === env && (d.state === 'queued' || d.state === 'running') && deployTouches(d, req));
  const ownServerHosts = (env) => new Set(((cfg.ownServers || {})[env] || []).map((h) => String(h).toLowerCase()));
  // every resource of the lease is a host or device on an own-server host (so it can only be disturbed by that Pi's server)
  const ownServerOnly = (l, own) => own.size > 0 && l.resources.length > 0 && l.resources.every((c) => { const r = P(c); return (r.type === 'host' || r.type === 'device') && own.has(r.host); });
  function deployBlockers(d, { skipLeased = false, agent = '' } = {}) {
    const ls = inEnv(d.env).filter((l) => l.mode === 'exclusive' && l.agent !== agent && !(d.id && l.deployId === d.id));
    const hostOf = (l) => l.resources.map((c) => P(c)).filter((r) => r.type === 'host' || r.type === 'device').map((r) => r.host);
    const leasedHosts = [];
    for (const l of ls) for (const h of hostOf(l)) if (!leasedHosts.some((x) => x.host === h)) leasedHosts.push({ host: h, agent: l.agent });
    const hasType = (l, ...ts) => l.resources.some((c) => ts.includes(P(c).type));
    const virtual = (rs, kind = 'server') => ({ mode: 'exclusive', agent: '\0deploy', shared: false, resources: rs, kind });
    let blockers;
    if (d.scope === 'frontend') blockers = ls.filter((l) => leasesConflict(virtual(['frontend']), l));
    else if (d.scope === 'server') {
      // Own-server hosts (cfg.ownServers: a Pi that runs its own secondary server): with skipLeased, a lease that only
      // touches those hosts does not block the node's server deploy. update_core drops that Pi's server from the run and
      // the catch-up host deploy restarts it once the lease is gone.
      const own = ownServerHosts(d.env);
      blockers = ls.filter((l) => leasesConflict(virtual(['server']), l) && !(skipLeased && ownServerOnly(l, own)));
      if (skipLeased) return { blockers, leasedHosts: leasedHosts.filter((x) => own.has(x.host)) };
    }
    else if (d.scope === 'host' && d.hosts?.length) {
      // with skipLeased only a whole-host or env-wide lease keeps the deploy from starting: device leases on the host do not,
      // because update_core syncs the code at once and defers the vpt-host restart to the catch-up (TASK-129 P1f). A catch-up of a
      // deploy that already deferred (d.strict) waits for the host to be free: it is the one that restarts, and it must not loop.
      blockers = ls.filter((l) => leasesConflict(virtual(d.hosts.map((h) => `host:${h}`), 'host'), l) && (!skipLeased || d.strict || hasType(l, 'env', 'host')));
    }
    else if (d.scope === 'host') blockers = skipLeased ? ls.filter((l) => hasType(l, 'env')) : ls.filter((l) => hasType(l, 'env', 'host', 'device'));
    else blockers = skipLeased ? ls.filter((l) => hasType(l, 'env', 'server', 'frontend') || (hasType(l, 'host', 'device') && serverKinded(l))) : ls;   // full
    return { blockers, leasedHosts: skipLeased ? leasedHosts : [] };
  }

  // ---- housekeeping (called inside every locked operation) ---------------------------------------------------------
  const procStart = config.procStart || procStartOf;
  const sessionAlive = (s) => { try { return sessions?.isAlive?.(s); } catch { return undefined; } };
  function housekeeping(emit) {
    const t = now();
    if (sessions?.isAlive) {
      const seen = new Map();
      for (const l of Object.values(S.leases)) if (l.session && !seen.has(l.session)) {
        let alive; try { alive = sessions.isAlive(l.session); } catch { alive = undefined; }
        seen.set(l.session, alive);
        const gone = Object.values(S.leases).some((x) => x.session === l.session && x.goneAt);
        if (alive === false && !gone) emit({ t: 'gone', session: l.session, at: t });
        else if (alive === true && gone) emit({ t: 'gone', session: l.session, clear: true, at: t });
      }
    }
    for (const l of Object.values({ ...S.leases })) {
      const rel = (why, reason, by = 'system') => emit({ t: 'release', ids: [l.id], why, reason, by, at: t });
      if (l.expires <= t) { rel('expired', 'ttl'); continue; }
      // owner 2026-10-27 ("never 240 min"): a lease from before the cap is cut back to claim + maxClaimMin (graceMs to wrap up if that is past)
      if (!l.system && !l.deployId && l.expires > t + cfg.maxClaimMin * MIN) {
        const to = Math.max(l.since + cfg.maxClaimMin * MIN, t + cfg.overCapGraceMs);
        if (to < l.expires) emit({ t: 'renew', id: l.id, expires: to, ttlMin: Math.min(l.ttlMin, cfg.maxClaimMin), at: t, lastHb: l.lastHb });
      }
      const c = clk.get(l.id) || (clk.set(l.id, { hb: mono(), act: mono() }), clk.get(l.id));
      const m = mono();
      if (l.reservedUntil && l.reservedUntil <= t) {                       // a ticket grant nobody collected
        rel('released', 'ticket-missed');
        if (l.ticketId) emit({ t: 'tkt_end', id: l.ticketId, state: 'missed', at: t });
        continue;
      }
      if (l.deployId && l.system && !S.deploys.some((d) => d.id === l.deployId && d.state === 'running')) { rel('released', 'deploy-ended'); continue; }
      // heartbeat enforcement is opt-in: only leases that declared heartbeat_s
      if (l.mode === 'exclusive' && l.heartbeatS > 0 && m - c.hb >= cfg.missFactor * l.heartbeatS * 1000) { rel('expired', 'no-heartbeat'); continue; }
      // holder death (owner 2026-10-27): a local holder pid (claim holder_pid, or the -<pid> of a codebox:<name>-<pid> agent) that is gone, or now
      // another process (start time differs), for holderDeadChecks consecutive checks holderCheckMs apart. No pid recorded = TTL behaviour as before.
      if (l.holderPid && l.holderStart && l.mode === 'exclusive' && !l.system && !l.deployId && !(l.holderSrc === 'agent-name' && l.session && sessionAlive(l.session) === true)) {
        if (c.pAt == null || m - c.pAt >= cfg.holderCheckMs) {
          c.pAt = m;
          c.pDead = procStart(l.holderPid) === l.holderStart ? 0 : (c.pDead || 0) + 1;
        }
        if ((c.pDead || 0) >= cfg.holderDeadChecks) { emit({ t: 'release', ids: [l.id], why: 'released', reason: 'holder-gone', detail: `released stale lease ${l.id}: holder pid ${l.holderPid} is gone`, by: 'system', at: t }); continue; }
      }
      if (l.goneAt && t - l.goneAt >= cfg.goneGraceMs) { rel('released', 'session-gone'); continue; }
      // idle -> pin only where activity can be observed: a declared heartbeat, or a session the dashboard resolves. Plain claims from other machines keep TTL only.
      let observable = l.heartbeatS != null;
      if (!observable && l.session && sessions?.trackable) { try { observable = !!sessions.trackable(l.session); } catch { observable = false; } }
      if (observable && l.mode === 'exclusive' && !l.system && !l.deployId && !(l.expectMin != null && t - l.since < l.expectMin * MIN)) {
        const limit = l.idleMin != null ? l.idleMin * MIN : cfg.idleMs[leaseType(l)];
        if (limit > 0 && m - c.act >= limit) emit({ t: 'mode', id: l.id, to: 'pin', by: 'system', reason: 'idle', at: t });
      }
    }
    for (const tk of waitingTickets()) if (mono() - (polls.get(tk.id) ?? mono()) >= cfg.ticketIdleMs) emit({ t: 'tkt_end', id: tk.id, state: 'expired', at: t });
    for (const d of [...S.deploys]) {
      if ((d.state === 'awaiting-approval' || d.state === 'queued') && d.expires <= t) emit({ t: 'dep_set', deploy: { ...d, state: 'cancelled', finished: t, reason: 'expired' }, event: 'expired', at: t });
      else if (d.state === 'running' && d.started + cfg.runningMaxMin * MIN <= t) emit({ t: 'dep_set', deploy: { ...d, state: 'failed', finished: t, reason: 'runner lost (no finish)' }, event: 'expired', at: t });
    }
    for (const [k, w] of depWaiters) if (t - w.seen > 10 * MIN) depWaiters.delete(k);
  }

  // ---- priority ------------------------------------------------------------------------------------------------------
  function prioOf(x) { return isPrio(x?.priority) ? x.priority : cfg.defaultPriority; }   // a declaration: journal replay (load) runs before this line   // leases from before priorities existed (and imports) count as the default
  const isLow = (x) => !x.system && !x.deployId && prioRank(prioOf(x)) >= prioRank(cfg.lowPriority);
  // Tickets of STRICTLY higher priority waiting on something this low-priority lease blocks: while any, the holder may not extend and must yield.
  function yieldWaiters(l) {
    if (!l || l.mode !== 'exclusive' || !isLow(l)) return [];
    return waitingTickets(l.env).filter((tk) => tk.agent !== l.agent && prioRank(prioOf(tk)) < prioRank(prioOf(l)) && leasesConflict(tk, l));
  }
  // Anyone waiting on this lease: a ticket (any priority) or a queued deploy that it blocks. Drives the continuous-hold limit.
  function holdWaiters(l) {
    const w = waitingTickets(l.env).filter((tk) => tk.agent !== l.agent && leasesConflict(tk, l)).map((tk) => tk.agent);
    for (const d of S.deploys) if (d.env === l.env && (d.state === 'queued' || d.state === 'awaiting-approval') && deployBlockers(d).blockers.some((b) => b.id === l.id)) w.push(`deploy ${d.id}`);
    return w;
  }
  const yieldFail = (l, ws) => fail('E_YIELD_REQUIRED', `yield_required: a ${prioOf(ws[0])} claim (${ws.map((w) => w.agent).slice(0, 3).join(', ')}) waits on ${l.env}/${l.resources.join(',')} and this ${prioOf(l)} lease may not be extended: stop at the next turn boundary and release (vpt-lease release ${l.id})`,
    { reason: 'yield_required', lease: l.id, priority: prioOf(l), waiting: ws.map((w) => ({ id: w.id, agent: w.agent, priority: prioOf(w) })) });
  // once per lease: tell the holder (event kind `yield`) as soon as a claim that outranks it waits; cleared again when none waits
  function yieldSweep(emit) {
    for (const l of Object.values(S.leases)) {
      const ws = yieldWaiters(l);
      if (ws.length && !l.yieldAt) emit({ t: 'yield', id: l.id, waiting: ws.map((w) => w.id), at: now() });
      else if (!ws.length && l.yieldAt) emit({ t: 'yield', id: l.id, clear: true, at: now() });
    }
  }

  function makeLease(req, t, extra = {}) {
    const gens = {};
    for (const c of req.resources) gens[`${req.env}|${c}`] = (S.gens[`${req.env}|${c}`] || 0) + 1;
    const id = newId((x) => S.leases[x] || x === extra.id);
    return {
      id, env: req.env, resources: req.resources, mode: req.mode, kind: req.kind, agent: req.agent, client: req.client || null, session: req.session || null,
      purpose: req.purpose || '', provider: req.provider || '', shared: !!req.shared, since: t, expires: t + req.ttlMin * MIN, ttlMin: req.ttlMin,
      heartbeatS: req.heartbeatS ?? null, holderPid: req.holderPid ?? null, holderHost: req.holderHost ?? null, holderStart: req.holderStart ?? null, holderSrc: req.holderSrc ?? null, system: !!req.system, deployId: req.deployId || null, lastHb: t, expectMin: req.expectMin ?? null, idleMin: req.idleMin ?? null, requestId: req.requestId || null, priority: req.priority || null, prioritySrc: req.prioritySrc || null, ttlClampedFrom: req.ttlClampedFrom ?? null,
      gens, generation: Math.max(...Object.values(gens)), ...extra,
    };
  }
  function grantTickets(emit) {
    const earlier = [];
    for (const tk of waitingTickets()) {
      const blocked = heldConflicts(tk).length > 0 || earlier.some((e) => e.env === tk.env && leasesConflict(tk, e) && !waitsOnlyOn(e, tk.agent))
        || (!tk.system && pendingFor(tk.env, tk, tk.deployId).length > 0);
      if (blocked) { earlier.push(tk); continue; }
      const t = now();
      // a reservation: the holder has `reserveMs` to collect it (poll the ticket or heartbeat), else it is released and the ticket is `missed`
      emit({ t: 'grant', lease: makeLease(tk, t, { reservedUntil: t + cfg.reserveMs, ticketId: tk.id }), ticket: tk.id, at: t });
    }
  }

  // ---- validation --------------------------------------------------------------------------------------------------
  const envOk = (e) => typeof e === 'string' && (cfg.envs.length ? cfg.envs.includes(e.toLowerCase()) : ENV_RE.test(e.toLowerCase()));
  const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  // `<env>/frontend`, `<env>/server`, `<env>/*`, `<env>/host:h`, `<env>/device:h/d` are the typed spellings; everything else is legacy.
  function stripEnv(r, env) {
    const s0 = String(r).trim().toLowerCase();
    if (env && s0.startsWith(`${env}/`)) { const rest = s0.slice(env.length + 1); if (rest === 'frontend' || rest === 'server' || rest === '*' || /^(host|device):/.test(rest)) return rest; }
    return r;
  }
  function parseResources(v, env) {
    const rs = listOf(v).map((r) => stripEnv(r, env));
    if (!rs.length || rs.length > 20) return { error: 'resources: 1 to 20 required' };
    const parsed = [];
    for (const r of rs) { const p = parseResource(r); if (!p) return { error: `bad resource ${JSON.stringify(String(r).slice(0, 60))}` }; parsed.push(p); }
    const uniq = [...new Set(parsed.map(canonical))].sort();
    return { resources: uniq, parsed: uniq.map((c) => P(c)) };
  }
  function envCheck(env) {
    if (!envOk(env)) return fail('E_INVALID', `unknown env ${JSON.stringify(String(env).slice(0, 60))}${cfg.envs.length ? ` (known: ${cfg.envs.join(', ')})` : ''}`);
    return null;
  }
  // Legacy had no maximum: a long ttl is accepted with a warning (shown in amber), capped at 24 h.
  function ttlCheck(v, def) {
    const m = v ?? def;
    if (typeof m !== 'number' || !(m > 0)) return { error: 'ttl_min must be a positive number of minutes' };
    if (m > cfg.ttlCapMin) return { ttl: cfg.ttlCapMin, warnings: [`ttl capped at ${cfg.ttlCapMin / 60} h`] };
    return { ttl: m, warnings: m > cfg.ttlMaxMin ? [`ttl over ${cfg.ttlMaxMin / 60} h: shown in amber`] : [] };
  }
  function validateClaim(a) {
    if (!a || typeof a !== 'object') return fail('E_INVALID', 'body must be an object');
    const bad = envCheck(a.env); if (bad) return bad;
    const rs = parseResources(a.resources, typeof a.env === 'string' ? a.env.toLowerCase() : null); if (rs.error) return fail('E_INVALID', rs.error);
    if (!isStr(a.agent)) return fail('E_INVALID', 'agent required');
    const mode = a.mode ?? 'exclusive';
    if (!MODES.includes(mode)) return fail('E_INVALID', `mode must be ${MODES.join('|')}`);
    const kind = a.kind == null ? defaultKind(rs.parsed) : (KIND_ALIASES[a.kind] || a.kind);
    if (kind !== 'server' && kind !== 'host') return fail('E_INVALID', 'kind must be server|host');
    const tt = ttlCheck(a.ttl_min, cfg.ttlDefaultMin); if (tt.error) return fail('E_INVALID', tt.error);
    let ttlMin = tt.ttl;
    let warnings = tt.warnings;
    if (a.priority != null && !isPrio(a.priority)) return fail('E_INVALID', 'priority must be P0|P1|P2|P3');
    // opt-in: only a lease that declares heartbeat_s is released when its heartbeats stop (plain claims keep TTL and the idle rule)
    const heartbeatS = a.heartbeat_s ?? null;
    if (heartbeatS != null && (typeof heartbeatS !== 'number' || heartbeatS < 10 || heartbeatS > 3600)) return fail('E_INVALID', 'heartbeat_s must be 10..3600 when given');
    if (a.expect_min != null && (typeof a.expect_min !== 'number' || !(a.expect_min > 0) || a.expect_min > cfg.ttlMaxMin)) return fail('E_INVALID', 'expect_min must be a positive number of minutes');
    if (a.idle_min != null && (typeof a.idle_min !== 'number' || a.idle_min < 0)) return fail('E_INVALID', 'idle_min must be >= 0 (0 = never)');
    const wait = a.wait === true ? 'ticket' : a.wait || false;
    if (wait !== false && wait !== 'ticket') return fail('E_INVALID', 'wait must be false|"ticket"');
    if (a.request_id != null && !isStr(a.request_id, 100)) return fail('E_INVALID', 'request_id must be a string of at most 100 characters');
    if (a.deploy_id != null && !isStr(a.deploy_id, 64)) return fail('E_INVALID', 'bad deploy_id');
    let prioritySince = null;
    if (a.priority_since != null) { prioritySince = typeof a.priority_since === 'number' ? a.priority_since : Date.parse(a.priority_since); if (!Number.isFinite(prioritySince)) return fail('E_INVALID', 'bad priority_since'); }
    const session = typeof a.session === 'string' && a.session ? a.session.slice(0, 200) : (/^(codebox|mac):\S+$/.test(a.agent) ? a.agent : null);
    const client = typeof a.client === 'string' ? a.client.slice(0, 80) : INTERNAL;
    // priority: the claim's own field, else the holder session's (owner setting, when this process can look it up), else the default
    let priority = a.priority ?? null, prioritySrc = priority ? 'claim' : null;
    if (!priority && session && sessions?.priority) {
      let sp; try { sp = sessions.priority(session.replace(/^codebox:/, '')); } catch { sp = null; }
      if (isPrio(sp)) { priority = sp; prioritySrc = 'session-meta'; }
    }
    if (!priority) { priority = cfg.defaultPriority; prioritySrc = 'default'; }
    const system = a.exempt === true;
    // holder liveness: an explicit local holder_pid (holder_host, when given, must be this host's name), else the -<pid> of a codebox:<name>-<pid> agent.
    // Tracked only while the pid is alive now; its start time is recorded so a reused pid counts as dead.
    if (a.holder_pid != null && (!Number.isInteger(a.holder_pid) || a.holder_pid < 2)) return fail('E_INVALID', 'holder_pid must be an integer > 1');
    if (a.holder_host != null && !isStr(a.holder_host, 255)) return fail('E_INVALID', 'bad holder_host');
    // A pid on ANOTHER host (the registry runs on proxmox, the dispatchers on codebox) cannot be probed here: it is recorded with its host and the
    // lease-holder-reaper on that host releases the lease. Only a pid on this host is probed by housekeeping.
    let holderPid = null, holderSrc = null;
    const holderHost = a.holder_host ?? null;
    if (a.holder_pid != null) { holderPid = a.holder_pid; holderSrc = 'claim'; }
    else { const nm = /^codebox:.+-(\d{2,9})$/.exec(a.agent); if (nm && Number(nm[1]) > 1) { holderPid = Number(nm[1]); holderSrc = 'agent-name'; } }
    const local = holderSrc === 'agent-name' ? holderHost === os.hostname() : (holderHost == null || holderHost === os.hostname());   // an agent-name pid is probed here only when the client said it is this host's
    const holderStart = holderPid && local ? procStart(holderPid) : null;
    if (holderPid && !local && holderSrc === 'agent-name' && holderHost == null) { holderPid = null; holderSrc = null; }   // host unknown: the reaper cannot know where to look
    if (holderPid && local && !holderStart) { holderPid = null; holderSrc = null; }
    let ttlClampedFrom = null;
    if (!system && !a.deploy_id && ttlMin > cfg.maxClaimMin) {
      ttlClampedFrom = ttlMin; ttlMin = cfg.maxClaimMin;
      warnings = [`ttl clamped from ${ttlClampedFrom} to ${ttlMin} min: max ${cfg.maxClaimMin} min per claim, release when your step is done and re-queue for the next step`];
    }
    if (!system && !a.deploy_id && prioRank(priority) >= prioRank(cfg.lowPriority) && ttlMin > cfg.lowPriorityMaxTtlMin) {
      ttlClampedFrom = ttlClampedFrom ?? ttlMin; ttlMin = cfg.lowPriorityMaxTtlMin;
      warnings = [`ttl clamped from ${ttlClampedFrom} to ${ttlMin} min: a ${priority} lease is capped at ${cfg.lowPriorityMaxTtlMin} min per claim and cannot be renewed while a claim of higher priority waits`];
    }
    return {
      ok: true, wait,
      req: { env: a.env.toLowerCase(), resources: rs.resources, mode, kind, agent: a.agent, client, session,
        purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 500) : '', provider: typeof a.provider === 'string' ? a.provider.slice(0, 80) : '', shared: !!a.shared,
        ttlMin, heartbeatS, holderPid, holderHost, holderStart, holderSrc, expectMin: a.expect_min ?? null, idleMin: a.idle_min ?? null,
        system,                         // set by the caller's token (clients.json exemptAgents) or in-process, never by the request body
        deployId: a.deploy_id || null, requestId: a.request_id || null, prioritySince, warnings, priority, prioritySrc, ttlClampedFrom },
    };
  }
  // Only the holder's client (and agent, when given) or an owner identity may act on a lease by id. In-process callers (no client) are trusted.
  function holderCheck(l, a) {
    if (a.owner === true || a.client == null) return null;
    // imported leases have no client: only a caller naming the holder's agent (or an owner) may act on them
    if (l.client == null) return a.agent != null && a.agent === l.agent ? null : fail('E_AUTH', 'not the holder of this (imported) lease: pass the holder agent', { status: 403 });
    if (l.client !== a.client || (a.agent != null && a.agent !== l.agent)) return fail('E_AUTH', 'not the holder of this lease', { status: 403 });
    return null;
  }

  // ---- claim / tickets ---------------------------------------------------------------------------------------------
  // Can `req` (which would be granted at once but for waiting ticket tk) pass in front of it? Only while the ticket is not
  // strict (passed at most passMax times, younger than strictAgeMs) and the request's expected hold ends before the
  // ticket's earliest possible grant (its blockers' ETA).
  function canPass(req, tk, t) {
    if ((tk.passed || 0) >= cfg.passMax || t - tk.created > cfg.strictAgeMs) return false;
    return t + holdMs(req) < etaOf(tk, []);          // strictly before: an equal estimate does not jump the queue
  }
  async function claim(a) {
    const v = validateClaim(a); if (!v.ok) return v;
    return mutate((emit) => {
      const req = v.req;
      const t = now();
      const rkey = req.requestId ? `${req.client || ''}|${req.requestId}` : null;
      if (rkey && S.requests[rkey]) {                                  // a retry of a request whose reply was lost: same answer
        const r = S.requests[rkey];
        if (r.kind === 'lease' && S.leases[r.ref]) return { ok: true, lease: leaseView(S.leases[r.ref]), replay: true };
        if (r.kind === 'ticket' && S.tickets[r.ref]) return { ok: true, ticket: ticketView(S.tickets[r.ref]), replay: true };
        return fail('E_NOT_FOUND', 'the grant of this request_id has already ended', { state: 'gone' });
      }
      const ticketFor = () => {
        const created = req.prioritySince != null ? Math.min(t, Math.max(req.prioritySince, t - 60 * MIN)) : t;
        const tk = { id: `t-${newId((x) => S.tickets[`t-${x}`])}`, ...req, state: 'waiting', created };
        emit({ t: 'tkt_new', ticket: tk, rkey, at: t });
        polls.set(tk.id, mono());
        return { ok: true, ticket: ticketView(S.tickets[tk.id]) };
      };
      let passed = [];
      if (req.mode === 'exclusive') {
        if (req.deployId) {
          const d = findDeploy(req.deployId);
          if (!d || d.state !== 'running' || d.env !== req.env) return fail('E_INVALID', 'deploy_id is not a running deploy on this env');
          if (!req.system && req.client !== INTERNAL && req.client !== d.client && req.client !== d.runnerClient) return fail('E_AUTH', 'only the deploy runner client or the requesting client may join a deploy', { status: 403 });
        }
        const pend = req.system ? [] : pendingFor(req.env, req, req.deployId);
        if (pend.length) {
          if (v.wait === 'ticket') return ticketFor();                  // queued behind the deploy instead of a refusal
          const d = pend[0];
          return fail('E_DEPLOY_PENDING', `deploy ${d.id} (${d.state}) on ${req.env}: scope=${d.scope} ref=${d.ref} requested by ${d.agent}; wait for it, then claim again`, { deploy: deployView(d), deploys: pend.map(deployView) });
        }
        const holders = heldConflicts(req);
        const ahead = req.deployId ? [] : aheadOf(req, null);     // a joiner of the running deploy holds its resource already: tickets that waited for the deploy must not queue it behind themselves (self-deadlock)
        let blocking = ahead;
        if (!holders.length && ahead.length) {
          passed = ahead.filter((tk) => canPass(req, tk, t));
          blocking = ahead.filter((tk) => !passed.includes(tk));
        }
        if (holders.length || blocking.length) {
          if (v.wait === 'ticket') return ticketFor();
          const eta = etaOf(req, blocking);
          return fail('E_HELD', holders.length ? `${req.env}/${req.resources.join(',')} is held by ${[...new Set(holders.map((h) => h.agent))].join(', ')}` : `${req.env}/${req.resources.join(',')} is free but ${blocking.length} claim(s) are queued ahead: wait with a ticket`,
            { reason: holders.length ? 'held' : 'queued', holders: holders.map(leaseView), queued_ahead: blocking.map((x) => ({ id: x.id, agent: x.agent })), position: blocking.length + 1,
              eta: iso(eta), eta_latest: iso(latestOf(req)), eta_in_min: Math.max(0, Math.ceil((eta - t) / MIN)) });
        }
      }
      if (passed.length) emit({ t: 'tkt_pass', ids: passed.map((x) => x.id), at: t });
      const lease = makeLease(req, t);
      emit({ t: 'grant', lease, rkey, at: t });
      return { ok: true, lease: leaseView(S.leases[lease.id]), ...(req.warnings?.length ? { warnings: req.warnings } : {}) };
    });
  }
  const collect = (id) => mutate((emit) => { const tk = S.tickets[id]; const l = tk && S.leases[tk.leaseId]; if (l?.reservedUntil) emit({ t: 'collect', id: l.id }); return { ok: true }; });
  async function ticket(id, opts = {}) {
    const waitMs = Math.max(0, Math.min(30000, Number(opts.waitMs ?? (opts.wait_s != null ? opts.wait_s * 1000 : 0)) || 0));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await read(() => {
        const tk = S.tickets[id];
        if (!tk) return fail('E_NOT_FOUND', 'no such ticket');
        if (tk.state === 'waiting') polls.set(id, mono());
        return { ok: true, ticket: ticketView(tk) };
      });
      if (r.ok && r.ticket.state === 'granted' && r.ticket.lease?.reserved_until) {      // collecting the reservation
        await collect(id);
        return read(() => (S.tickets[id] ? { ok: true, ticket: ticketView(S.tickets[id]) } : fail('E_NOT_FOUND', 'no such ticket')));
      }
      if (!r.ok || r.ticket.state !== 'waiting' || Date.now() >= deadline) return r;
      await sleepUntilWake(Math.min(1000, deadline - Date.now()));
    }
  }
  async function cancelTicket(id, opts = {}) {
    return mutate((emit) => {
      const tk = S.tickets[id];
      if (!tk) return fail('E_NOT_FOUND', 'no such ticket');
      if (opts.client != null && opts.owner !== true && tk.client != null && tk.client !== opts.client) return fail('E_AUTH', 'not the holder of this ticket', { status: 403 });
      if (tk.state === 'waiting') emit({ t: 'tkt_end', id, state: 'cancelled' });
      return { ok: true, ticket: ticketView(S.tickets[id]) };
    });
  }
  async function get(a = {}) {                                         // GET /leases/:id: validate before acting
    return read(() => {
      const l = S.leases[a.id];
      if (!l) return fail('E_NOT_FOUND', 'no such active lease', { id: a.id, state: 'gone' });
      const out = { ok: true, id: l.id, agent: l.agent, mode: l.mode, generation: l.generation, state: l.reservedUntil ? 'reserved' : 'active' };   // 'active' = held; agent lets a client check the lease is its own
      if (a.generation != null && a.generation !== l.generation) out.fenced = true;
      return out;
    });
  }

  // ---- release / renew / heartbeat / narrow / mode -----------------------------------------------------------------
  const fenced = (l, generation) => generation != null && (!l || l.generation !== generation);
  async function release(a = {}) {
    if (!isStr(a.id, 64) && !isStr(a.agent)) return fail('E_INVALID', 'release needs id or agent');
    return mutate((emit) => {
      let ids;
      let cancelled = [];
      if (a.id) {
        const l = S.leases[a.id];
        if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
        const no = l && holderCheck(l, a); if (no) return no;
        ids = l ? [l.id] : [];
      } else {
        const mine = (x) => x.agent === a.agent && (a.owner === true || a.client == null || x.client == null || x.client === a.client);
        ids = Object.values(S.leases).filter(mine).map((l) => l.id);
        cancelled = waitingTickets().filter(mine).map((tk) => tk.id);
      }
      const by = typeof a.by === 'string' && a.by ? a.by.slice(0, 80) : (a.agent || (S.leases[a.id]?.agent) || 'holder');
      if (ids.length) emit({ t: 'release', ids, why: 'released', by, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
      for (const id of cancelled) emit({ t: 'tkt_end', id, state: 'cancelled' });
      return { ok: true, released: ids, cancelled };
    });
  }
  // Force-release: `by` is the real caller identity passed in (never defaulted), logged on the event.
  async function ownerRelease(a = {}) {
    if (!isStr(a.id, 64)) return fail('E_INVALID', 'id required');
    if (!isStr(a.by, 120)) return fail('E_INVALID', 'by (the caller identity) required');
    if (a.client != null && a.owner !== true) return fail('E_AUTH', 'force-release needs an owner client', { status: 403 });
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      emit({ t: 'release', ids: [l.id], why: 'forced', by: a.by, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : 'force-release' });
      return { ok: true, released: [l.id] };
    });
  }
  async function renew(a = {}) {
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const no = holderCheck(l, a); if (no) return no;
      const tt = ttlCheck(a.ttl_min, l.ttlMin); if (tt.error) return fail('E_INVALID', tt.error);
      const ws = yieldWaiters(l);
      if (ws.length) return yieldFail(l, ws);                // the yield event itself was emitted by yieldSweep
      if (isLow(l) && tt.ttl > cfg.lowPriorityMaxTtlMin) { tt.warnings = [`ttl clamped from ${tt.ttl} to ${cfg.lowPriorityMaxTtlMin} min (${prioOf(l)} lease)`]; tt.ttl = cfg.lowPriorityMaxTtlMin; }
      const t = now();
      if (!l.system && !l.deployId) {
        if (tt.ttl > cfg.maxClaimMin) { tt.warnings = [...tt.warnings, `ttl clamped from ${tt.ttl} to ${cfg.maxClaimMin} min: max ${cfg.maxClaimMin} min per claim`]; tt.ttl = cfg.maxClaimMin; }
        // continuous hold <= maxClaimMin when anyone waits (fair rotation); a lease older than that (incl. pre-cap 240 min ones) is not shortened, just not extended
        if (l.mode === 'exclusive') {
          const hw = holdWaiters(l);
          if (hw.length) {
            const left = Math.floor((l.since + cfg.maxClaimMin * MIN - t) / MIN);
            if (left <= 0) return fail('E_HOLD_CAP', `hold cap: ${hw.slice(0, 3).join(', ')} waits and this lease has been held over ${cfg.maxClaimMin} min: release (vpt-lease release ${l.id}) and queue again for the next step`, { reason: 'hold_cap', lease: l.id, waiting: hw.slice(0, 5) });
            if (tt.ttl > left) { tt.warnings = [...tt.warnings, `ttl clamped from ${tt.ttl} to ${left} min: someone waits, continuous hold is capped at ${cfg.maxClaimMin} min`]; tt.ttl = left; }
          }
        }
      }
      emit({ t: 'renew', id: l.id, expires: t + tt.ttl * MIN, ttlMin: tt.ttl, at: t });
      return { ok: true, lease: leaseView(S.leases[l.id]), ...(tt.warnings.length ? { warnings: tt.warnings } : {}) };
    });
  }
  async function heartbeat(a = {}) {
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const no = holderCheck(l, a); if (no) return no;
      emit({ t: 'hb', id: l.id, active: !!a.active });
      const ws = yieldWaiters(S.leases[l.id]);
      return { ok: true, lease: leaseView(S.leases[l.id]), ...(ws.length ? { yield_required: true, yield_message: `a claim of higher priority waits: stop at the next turn boundary and release ${l.id}` } : {}) };
    });
  }
  // Legacy `vpt-lease narrow <id> [--resource R] --kind host`: sensitivity becomes host for that row (or every row) and NOTHING is
  // released; it never widens. `restrict: true` is the new way to also drop rows (the remaining resources must lie inside the lease).
  async function narrow(a = {}) {
    if (a.resources == null && a.kind == null) return fail('E_INVALID', 'narrow needs resources and/or kind');
    if (a.kind != null && (KIND_ALIASES[a.kind] || a.kind) !== 'host') return fail('E_INVALID', 'a lease can only be narrowed to kind host');
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const no = holderCheck(l, a); if (no) return no;
      let rs = null;
      if (a.resources != null) { rs = parseResources(a.resources, l.env); if (rs.error) return fail('E_INVALID', rs.error); }
      let resources = l.resources;
      if (rs && a.restrict === true) {
        if (!rs.parsed.every((n) => l.resources.some((o) => covers(P(o), n)))) return fail('E_INVALID', 'narrow never widens: every resource must be inside the lease');
        resources = rs.resources;
      } else if (rs && !rs.resources.every((r) => l.resources.includes(r))) return fail('E_NOT_FOUND', 'no such resource on this lease');
      const rows = rs && a.restrict !== true ? rs.resources : (a.kind != null || !rs ? resources : []);
      const probe = { resources, kind: l.kind, resKinds: l.resKinds };
      let count = rows.filter((r) => kindOf(probe, r) !== 'host').length;
      const resKinds = { ...(l.resKinds || {}) };
      for (const r of rows) resKinds[r] = 'host';
      for (const k of Object.keys(resKinds)) if (!resources.includes(k)) delete resKinds[k];
      const allHost = resources.every((r) => (resKinds[r] || l.kind) === 'host');
      const kind = allHost ? 'host' : l.kind;
      const nextKinds = allHost ? null : resKinds;
      const dropped = l.resources.length - resources.length;
      count += dropped;
      if (count) emit({ t: 'narrow', id: l.id, resources, sensitivity: kind, resKinds: nextKinds, count, by: typeof a.by === 'string' ? a.by.slice(0, 80) : (a.agent || 'holder'), reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
      return { ok: true, changed: count > 0, narrowed: count, lease: leaseView(S.leases[l.id]) };
    });
  }
  async function setMode(a = {}) {
    if (!MODES.includes(a.mode)) return fail('E_INVALID', `mode must be ${MODES.join('|')}`);
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const no = holderCheck(l, a); if (no) return no;
      if (MODE_RANK[a.mode] > MODE_RANK[l.mode]) return fail('E_INVALID', 'a mode can only be downgraded (exclusive -> pin -> observe)');
      if (a.mode !== l.mode) emit({ t: 'mode', id: l.id, to: a.mode, by: typeof a.by === 'string' && a.by ? a.by.slice(0, 120) : (a.agent || 'holder'), reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
      return { ok: true, lease: leaseView(S.leases[l.id]) };
    });
  }

  // ---- list / check / events ---------------------------------------------------------------------------------------
  async function list(a = {}) {
    if (a.env) { const bad = envCheck(a.env); if (bad) return bad; }
    const env = a.env ? a.env.toLowerCase() : null;
    return read(() => {
      const t = now();
      const leases = Object.values(S.leases).filter((l) => !env || l.env === env).sort((x, y) => (x.env + x.resources[0]).localeCompare(y.env + y.resources[0]) || x.since - y.since).map(leaseView);
      const active = S.deploys.filter((d) => ['awaiting-approval', 'queued', 'running'].includes(d.state) && (!env || d.env === env));
      return {
        ok: true, now: iso(t), now_s: secs(t), leases, tickets: waitingTickets(env).map(ticketView),
        deploys: active.map((d) => deployView(d)), waiters: [...depWaiters.values()].filter((w) => !env || w.env === env), readonly: cfg.readonly,
      };
    });
  }
  async function check(a = {}) {
    const bad = envCheck(a.env); if (bad) return bad;
    const env = a.env.toLowerCase();
    const rs = listOf(a.resources).length ? parseResources(a.resources, env) : { resources: ['*'], parsed: [{ type: 'env' }] };
    if (rs.error) return fail('E_INVALID', rs.error);
    const ignore = typeof a.ignore_agent === 'string' ? a.ignore_agent : '';
    return read(() => {
      const waiting = waitingTickets(env).length;
      const virt = { env, mode: 'exclusive', agent: ignore, shared: false, resources: rs.resources, kind: defaultKind(rs.parsed) };
      const pending = pendingFor(env, virt).map(deployView);
      if (a.skip_leased) {
        const has = (...ts) => rs.parsed.some((r) => ts.includes(r.type));
        const hosts = listOf(a.hosts).map((h) => h.toLowerCase());
        const scope = !listOf(a.resources).length ? 'host' : has('env') ? 'full' : has('server') ? 'server' : 'frontend';
        const { blockers, leasedHosts } = deployBlockers({ env, scope }, { skipLeased: true, agent: ignore });
        const leased = hosts.map((h) => leasedHosts.find((x) => x.host === h)).filter(Boolean);
        return { ok: true, free: blockers.length === 0, holders: blockers.map(leaseView), leased_hosts: leased, pending_deploys: pending, pending, waiting };
      }
      const holders = heldConflicts(virt).map(leaseView);
      return { ok: true, free: holders.length === 0, holders, pending_deploys: pending, pending, waiting };
    });
  }
  async function events(a = {}) {
    const after = Math.max(0, Number(a.after) || 0);
    const limit = Math.min(1000, Math.max(1, Number(a.limit) || 200));
    return read(() => {
      const out = S.events.filter((e) => e.n > after).slice(0, limit).map((e) => ({ ...e, at: iso(e.at) }));
      return { ok: true, events: out, next: out.length ? out[out.length - 1].n : Math.min(after, S.evN), total: S.evN };
    });
  }

  // ---- sessions ----------------------------------------------------------------------------------------------------
  const ofSession = (s) => Object.values(S.leases).filter((l) => l.session === s || l.agent === s);
  async function sessionGone(session, opts = {}) {
    if (!isStr(session)) return fail('E_INVALID', 'session required');
    return mutate((emit) => {
      const ls = ofSession(session);
      if (opts.immediate) {
        if (ls.length) emit({ t: 'release', ids: ls.map((l) => l.id), why: 'released', by: 'system', reason: 'session-ended' });
        for (const tk of waitingTickets().filter((x) => x.session === session || x.agent === session)) emit({ t: 'tkt_end', id: tk.id, state: 'cancelled' });
      } else if (ls.length) emit({ t: 'gone', session });
      return { ok: true, leases: ls.map((l) => l.id), immediate: !!opts.immediate };
    });
  }
  // The idle clock also resets on observable activity (the dashboard calls this for codebox session turns and working state).
  async function activity(session) {
    let n = 0;
    for (const l of ofSession(session)) { const c = clk.get(l.id); if (c) { c.act = mono(); n++; } }
    return { ok: true, touched: n };
  }
  // A STATUS of blocked, or waiting on something the lease's resources/hosts do not name, downgrades an exclusive lease to
  // pin only when it has been inactive for idleMs and its expect_min has elapsed. Otherwise it is only flagged.
  async function sessionStatus(session, status, text = '') {
    if (!isStr(session)) return fail('E_INVALID', 'session required');
    return mutate((emit) => {
      const down = [], flagged = [];
      if (status === 'waiting' || status === 'blocked') {
        const txt = String(text || '').toLowerCase();
        for (const l of ofSession(session)) {
          if (l.mode !== 'exclusive') continue;
          const names = l.resources.flatMap((c) => { const r = P(c); return r.type === 'env' ? [l.env] : r.type === 'device' ? [r.host, r.device, `${r.host}/${r.device}`] : r.type === 'host' ? [r.host] : [r.type]; });
          if (status === 'waiting' && names.some((n) => txt.includes(n))) continue;          // waiting on its own job on the leased resource
          const t = now();
          const limit = l.idleMin != null ? l.idleMin * MIN : cfg.idleMs[leaseType(l)];
          const quiet = !clk.get(l.id) || mono() - clk.get(l.id).act >= limit;
          const expectDone = l.expectMin == null || t - l.since >= l.expectMin * MIN;
          if (quiet && expectDone && !l.system && !l.deployId) { down.push(l.id); emit({ t: 'mode', id: l.id, to: 'pin', by: 'system', reason: `status:${status}`, at: t }); }
          else { flagged.push(l.id); emit({ t: 'flag', id: l.id, status, text: String(text || '').slice(0, 200), reason: 'holds an exclusive lease while waiting', at: t }); }
        }
      }
      return { ok: true, downgraded: down, flagged };
    });
  }
  const tick = () => mutate(() => ({ ok: true }));

  // ---- deploy queue (registry semantics, vpt-lease deploy ...) -----------------------------------------------------
  const hostList = (v) => listOf(v).map((h) => String(h).toLowerCase());
  // Why a host was left out of the deploy: its restart was deferred because the host was leased. The holder is the provenance
  // of the deferral (the code was synced, the service was not restarted into it).
  const skipReason = (env, hosts) => {
    if (!hosts.length) return '';
    const holders = [];
    for (const l of Object.values(S.leases)) {
      if (l.env !== env || l.mode !== 'exclusive') continue;
      for (const c of l.resources || []) {
        const r = P(c);
        const who = l.agent || '?';
        if ((r.type === 'host' || r.type === 'device') && hosts.includes(r.host) && !holders.includes(who)) holders.push(who);
      }
    }
    return holders.length ? `restart deferred: host leased by ${holders.join(', ')}` : 'restart deferred: host leased';
  };
  const findDeploy = (id) => S.deploys.find((d) => d.id === id);
  const depNew = () => newId((x) => S.deploys.some((d) => d.id === x));
  // start / finish / cancel: the runner client (exempt), an owner, the client that requested the deploy, or an in-process caller.
  function deployAuth(d, a) {
    if (a.client == null || a.owner === true || a.exempt === true || d.client === a.client || d.runnerClient === a.client) return null;
    return fail('E_AUTH', 'not your deploy: needs the deploy runner client, an owner, or the client that requested it', { status: 403 });
  }
  const deploy = {
    async request(a = {}) {
      const bad = envCheck(a.env); if (bad) return bad;
      if (!SCOPES.includes(a.scope)) return fail('E_INVALID', `scope must be ${SCOPES.join('|')}`);
      if (!isStr(a.ref, 300) || !isStr(a.agent)) return fail('E_INVALID', 'ref and agent required');
      const hosts = hostList(a.hosts);
      if (hosts.length && a.scope !== 'host') return fail('E_INVALID', '--hosts only goes with --scope host');
      if (hosts.some((h) => !nameOk(h))) return fail('E_INVALID', 'bad host name');
      const ttl = a.ttl_min ?? cfg.deployTtlMin;
      if (typeof ttl !== 'number' || !(ttl > 0) || ttl > 24 * 60) return fail('E_INVALID', 'ttl_min must be in (0, 1440]');
      return mutate((emit) => {
        const t = now();
        const d = { id: depNew(), env: a.env.toLowerCase(), scope: a.scope, ref: a.ref, agent: a.agent, purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 500) : '', client: typeof a.client === 'string' ? a.client : INTERNAL, state: a.approved ? 'queued' : 'awaiting-approval', approved: !!a.approved, created: t, expires: t + ttl * MIN };
        if (hosts.length) d.hosts = hosts;
        emit({ t: 'dep_set', deploy: d, event: 'request', at: t });
        return { ok: true, id: d.id, deploy: deployView(d) };
      });
    },
    async approve(a = {}) {
      if (a.client != null && a.owner !== true) return fail('E_AUTH', 'approving a deploy needs an owner client', { status: 403 });
      return mutate((emit) => {
        const d = findDeploy(a.id);
        if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
        if (d.state !== 'awaiting-approval') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, not awaiting approval`);
        emit({ t: 'dep_set', deploy: { ...d, state: 'queued', approved: true, approvedAt: now() }, event: 'approve' });
        return { ok: true, deploy: deployView(findDeploy(d.id)) };
      });
    },
    async cancel(a = {}) {
      return mutate((emit) => {
        const d = findDeploy(a.id);
        if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
        const no = deployAuth(d, a); if (no) return no;
        if (d.state !== 'awaiting-approval' && d.state !== 'queued') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, cannot cancel`);
        emit({ t: 'dep_set', deploy: { ...d, state: 'cancelled', finished: now() }, event: 'cancel' });
        return { ok: true, deploy: deployView(findDeploy(d.id)) };
      });
    },
    async start(a = {}) {
      const agent = typeof a.agent === 'string' && a.agent ? a.agent : RUNNER;
      return mutate((emit) => {
        const d = findDeploy(a.id);
        if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
        const no = deployAuth(d, a); if (no) return no;
        if (d.state !== 'queued') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, not queued`);
        const other = S.deploys.find((x) => x.env === d.env && x.state === 'running');
        if (other) return fail('E_HELD', `deploy ${other.id} is already running on ${d.env}`, { running: deployView(other), holders: [] });
        const { blockers, leasedHosts } = deployBlockers(d, { skipLeased: !!a.skip_leased, agent });
        if (blockers.length) return fail('E_HELD', 'leases in the way', { holders: blockers.map(leaseView) });
        const t = now();
        const nd = { ...d, state: 'running', started: t, runner: agent, runnerClient: typeof a.client === 'string' ? a.client : INTERNAL };
        emit({ t: 'dep_set', deploy: nd, event: 'start', at: t });
        // check and claim in one step (inside the mutex): the deploy's own lease, so nothing can slip in between. Joiners claim with its deploy_id.
        const skip = new Set(leasedHosts.map((x) => x.host));
        const known = Object.keys(S.deployed[d.env] || {}).filter((k) => !GENERIC.includes(k) && !skip.has(k));
        const raw = d.scope === 'frontend' ? ['frontend'] : d.scope === 'server' ? ['server'] : d.scope === 'host' && d.hosts?.length ? d.hosts.filter((h) => !skip.has(String(h).toLowerCase())).map((h) => `host:${h}`)
          : d.scope === 'host' && known.length ? known.map((h) => `host:${h}`) : ['*'];
        const resources = [...new Set(raw.map((r) => canonical(parseResource(r))))].sort();
        // every named host is only device-leased: update_core syncs them without a lease, so the deploy holds nothing
        if (!resources.length) return { ok: true, state: 'running', deploy: deployView(nd), granted: [], leased_hosts: leasedHosts, skipped_hosts: leasedHosts.map((x) => x.host) };
        const lease = makeLease({ env: d.env, resources, mode: 'exclusive', kind: d.scope === 'host' ? 'host' : 'server', agent, client: typeof a.client === 'string' ? a.client : INTERNAL, session: null,
          purpose: `deploy ${d.id}`, provider: '', shared: false, ttlMin: cfg.deployLeaseMin, heartbeatS: null, system: true, deployId: d.id }, t);
        emit({ t: 'grant', lease, at: t });
        return { ok: true, state: 'running', deploy: deployView(nd), lease_id: lease.id, lease: leaseView(S.leases[lease.id]), granted: resources, leased_hosts: leasedHosts, skipped_hosts: leasedHosts.map((x) => x.host) };
      });
    },
    async finish(a = {}) {
      if (a.status !== 'done' && a.status !== 'failed') return fail('E_INVALID', 'status must be done|failed');
      return mutate((emit) => {
        const d = findDeploy(a.id);
        if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
        const no = deployAuth(d, a); if (no) return no;
        if (d.state !== 'queued' && d.state !== 'running') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, cannot finish`);
        const t = now();
        const nd = { ...d, state: a.status, finished: t };
        if (a.version) nd.version = String(a.version).slice(0, 200);
        if (a.coalesced_into) nd.coalescedInto = String(a.coalesced_into).slice(0, 64);
        const skipped = hostList(a.skipped_hosts);
        if (skipped.length) nd.skippedHosts = skipped;
        const failTargets = hostList(a.fail_targets);
        if (typeof a.tail === 'string') nd.tail = a.tail.slice(-6000);
        emit({ t: 'dep_set', deploy: nd, event: 'finish', at: t });
        const own = Object.values(S.leases).filter((l) => l.deployId === d.id && l.system).map((l) => l.id);
        if (own.length) emit({ t: 'release', ids: own, why: 'released', by: nd.runner || RUNNER, reason: 'deploy-finished', at: t });
        let recorded = null;
        if (!nd.coalescedInto) {
          recorded = ledgerRecord(emit, { env: nd.env, scope: nd.scope, hosts: nd.hosts || [], ref: nd.ref, version: nd.version || '', agent: nd.agent, status: a.status, started: secs(nd.started), deployId: nd.id, failTargets, skipped, skipReason: skipReason(nd.env, skipped) });
        }
        // hosts left out because they were leased: queue the catch-up deploy (the runner used to do this from SKIPPED_HOSTS)
        let catchup = null;
        if (skipped.length && !S.deploys.some((x) => x.env === nd.env && x.scope === 'host' && x.state === 'queued' && x.ref === nd.ref && skipped.every((h) => x.hosts?.includes(h)))) {
          const c = { id: depNew(), env: nd.env, scope: 'host', ref: nd.ref, agent: RUNNER, purpose: `catch-up for ${nd.id}: skipped ${skipped.join(',')}`, state: 'queued', approved: true, created: t, expires: t + cfg.deployTtlMin * MIN, hosts: skipped, ...((nd.strict || String(nd.purpose || '').startsWith('catch-up')) ? { strict: true } : {}) };
          emit({ t: 'dep_set', deploy: c, event: 'request', at: t });
          catchup = c.id;
        }
        return { ok: true, deploy: deployView(findDeploy(d.id)), recorded, catchup };
      });
    },
    async record(a = {}) {
      const bad = envCheck(a.env); if (bad) return bad;
      const scopes = listOf(a.scope);
      if (!scopes.length || scopes.some((x) => !SCOPES.includes(x))) return fail('E_INVALID', `scope must be ${SCOPES.join('|')} (comma-separated allowed)`);
      if (a.status !== 'done' && a.status !== 'failed') return fail('E_INVALID', 'status must be done|failed');
      if (!isStr(a.agent)) return fail('E_INVALID', 'agent required');
      const at = parseTs(a.at), started = parseTs(a.started);
      if (at === false || started === false) return fail('E_INVALID', 'bad timestamp (epoch seconds or ISO 8601)');
      return mutate((emit) => {
        const r = ledgerRecord(emit, {
          env: a.env.toLowerCase(), scope: scopes.join(','), hosts: hostList(a.hosts), ref: a.ref || '', commit: a.commit || '', version: a.version || '', agent: a.agent, status: a.status,
          started, at, deployId: a.deploy_id || '', source: a.source || '', note: a.note || '', failTargets: hostList(a.fail_targets), skipped: hostList(a.skipped_hosts),
        });
        return { ok: true, ...r };
      });
    },
    async list(a = {}) {
      if (a.env) { const bad = envCheck(a.env); if (bad) return bad; }
      const env = a.env ? a.env.toLowerCase() : null;
      return read(() => {
        const t = now();
        const ds = S.deploys.filter((d) => !env || d.env === env).filter((d) => a.all || ['awaiting-approval', 'queued', 'running'].includes(d.state)).map((d) => {
          const v = deployView(d);
          if (d.state === 'awaiting-approval' || d.state === 'queued') v.blocking = deployBlockers(d).blockers.map(leaseView);
          return v;
        });
        return { ok: true, now: secs(t), deploys: ds, leases: Object.values(S.leases).filter((l) => !env || l.env === env).map(leaseView), waiters: [...depWaiters.values()].filter((w) => !env || w.env === env) };
      });
    },
    async wait(a = {}) {
      if (!!a.id === !!a.env) return fail('E_INVALID', 'deploy wait needs exactly one of id or env');
      if (a.env) { const bad = envCheck(a.env); if (bad) return bad; }
      const deadline = Date.now() + Math.max(0, Math.min(30000, Number(a.timeoutMs ?? (a.timeout_s != null ? a.timeout_s * 1000 : 0)) || 0));
      const key = `${a.agent || ''}|${a.id || a.env}`;
      for (;;) {
        const r = await read(() => {
          const t = now();
          if (a.agent) depWaiters.set(key, { agent: a.agent, deployId: a.id || '', env: (a.env || findDeploy(a.id)?.env || '').toLowerCase(), since: depWaiters.get(key)?.since ?? t, seen: t });
          if (a.id) {
            const d = findDeploy(a.id);
            if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
            const final = d.state === 'done' || d.state === 'failed' || d.state === 'cancelled';
            return { ok: true, final, state: d.state, success: d.state === 'done', deploy: deployView(d) };
          }
          const pend = S.deploys.filter((d) => d.env === a.env.toLowerCase() && (d.state === 'queued' || d.state === 'running'));
          return { ok: true, final: pend.length === 0, state: pend.length ? 'pending' : 'idle', success: pend.length === 0, pending: pend.map(deployView) };
        });
        if (!r.ok || r.final || Date.now() >= deadline) { if (!r.ok || r.final) depWaiters.delete(key); return r; }
        await sleepUntilWake(Math.min(1000, deadline - Date.now()));
      }
    },
    async last(a = {}) {
      if (a.env) { const bad = envCheck(a.env); if (bad) return bad; }
      return read(() => ({ ok: true, now: secs(now()), envs: Object.fromEntries(Object.entries(S.deployed).filter(([k]) => !a.env || k === a.env.toLowerCase())) }));
    },
  };
  function parseTs(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
    const ms = Date.parse(String(v));
    return Number.isNaN(ms) ? false : Math.floor(ms / 1000);
  }
  // Ported from `vpt-lease deploy record`: only status=done moves "deployed now"; a failure is kept as lastAttempt.
  function ledgerRecord(emit, r) {
    const t = secs(now());
    const scopes = r.scope.split(',').filter(Boolean);
    let sc = scopes;
    if (['frontend', 'server', 'host'].every((x) => scopes.includes(x))) sc = ['full'];
    const map = JSON.parse(JSON.stringify(S.deployed[r.env] || {}));
    const at = r.at ?? t;
    const base = { at, started: r.started ?? at, ref: r.ref, commit: r.commit || '', version: r.version || '', agent: r.agent, status: r.status };
    if (r.deployId) base.deployId = r.deployId;
    if (r.source) base.source = r.source;
    if (r.deployId && S.recorded.includes(r.deployId)) {
      let filled = 0;
      for (const ent of Object.values(map)) for (const e of [ent, ent.lastAttempt || {}]) if (e.deployId === r.deployId) for (const k of ['commit', 'version', 'ref']) if (!e[k] && base[k]) { e[k] = base[k]; filled++; }
      if (filled) emit({ t: 'deployed', env: r.env, map, deployId: null });
      return { already: true, filled, targets: [] };
    }
    const known = Object.keys(map).filter((k) => !GENERIC.includes(k));
    const targets = [];
    const add = (x) => { if (!targets.includes(x)) targets.push(x); };
    for (const s of sc) {
      if (s === 'frontend') add('frontend');
      else if (s === 'server') add('server');
      else if (s === 'host') (r.hosts.length ? r.hosts : [...known, 'hosts']).forEach(add);
      else if (s === 'full') { add('frontend'); add('server'); (r.hosts.length ? r.hosts : [...known, ...('hosts' in map ? ['hosts'] : [])]).forEach(add); }
    }
    const failed = new Set(r.failTargets || []);
    const skipped = new Set(r.skipped || []);
    for (const h of skipped) add(h);        // a skipped host is a target too: its code was synced, only the restart was deferred
    for (const tg of targets) {
      const ent = map[tg] || (map[tg] = {});
      if (skipped.has(tg)) {
        // synced but not restarted (the host was leased): NOT deployed, with the reason and the provenance of the sync
        for (const k of Object.keys(ent)) delete ent[k];
        Object.assign(ent, base, { status: 'synced', reason: r.skipReason || 'restart deferred: host leased' });
        continue;
      }
      const ok = r.status === 'done' || (failed.size > 0 && !failed.has(tg) && !(tg === 'hosts' && r.hosts.some((h) => failed.has(h))));
      if (ok) { for (const k of Object.keys(ent)) delete ent[k]; Object.assign(ent, base, { status: 'done' }); } else ent.lastAttempt = { ...base };
    }
    emit({ t: 'deployed', env: r.env, map, deployId: r.deployId || `rec-${randomBytes(4).toString('hex')}` });
    return { already: false, targets };
  }

  // ---- legacy import (lease-import.js) -----------------------------------------------------------------------------
  async function importLegacy(a = {}) {
    if (a.client != null && a.owner !== true) return fail('E_AUTH', 'import needs an owner client', { status: 403 });
    const skipped = [];
    const byId = new Map();
    for (const row of Array.isArray(a.leases) ? a.leases : []) {
      if (!row || typeof row.id !== 'string') { skipped.push({ reason: 'no id' }); continue; }
      const g = byId.get(row.id) || []; g.push(row); byId.set(row.id, g);
    }
    return mutate((emit) => {
      const t = now();
      let leases = 0, deploys = 0;
      for (const [id, rows] of byId) {
        const first = rows[0];
        const env = String(first.env || '').toLowerCase();
        if (!envOk(env)) { skipped.push({ id, reason: `unknown env ${env}` }); continue; }
        if (S.leases[id]) { skipped.push({ id, reason: 'already imported' }); continue; }
        const exp = (Number(first.expires) || 0) * 1000;
        if (exp <= t) { skipped.push({ id, reason: 'expired' }); continue; }
        const rs = parseResources(rows.map((r) => r.resource), env);
        if (rs.error) { skipped.push({ id, reason: rs.error }); continue; }
        const rowKind = (r) => { const k = KIND_ALIASES[r.kind] || r.kind || 'server'; return k === 'host' ? 'host' : 'server'; };
        const resKinds = {};
        for (const r of rows) { const c = canonical(parseResource(stripEnv(r.resource, env))); resKinds[c] = rowKind(r); }
        const kind = Object.values(resKinds).includes('server') ? 'server' : 'host';
        const probe = { env, mode: 'exclusive', agent: String(first.agent || 'unknown'), shared: !!first.shared, resources: rs.resources, kind, resKinds };
        const clash = heldConflicts(probe);
        if (clash.length) { skipped.push({ id, reason: `conflicts with live lease ${clash.map((c) => c.id).join(',')}`, conflict: true, holders: clash.map((c) => c.id) }); continue; }
        const capped = Math.min(exp, t + cfg.ttlMaxMin * MIN);
        const l = makeLease({ env, resources: rs.resources, mode: 'exclusive', kind, agent: String(first.agent || 'unknown'), session: /^(codebox|mac):\S+$/.test(first.agent || '') ? first.agent : null,
          purpose: String(first.purpose || '').slice(0, 500), provider: String(first.provider || ''), shared: !!first.shared, ttlMin: Math.max(1, Math.round((capped - t) / MIN)), heartbeatS: null }, t, { id, imported: true, resKinds: kind === 'server' && Object.values(resKinds).includes('host') ? resKinds : null });
        l.since = (Number(first.since) || t / 1000) * 1000;
        l.expires = capped;
        emit({ t: 'grant', lease: l, imported: true, at: t });
        leases++;
      }
      for (const d of Array.isArray(a.deploys) ? a.deploys : []) {
        if (!d || typeof d.id !== 'string' || !['awaiting-approval', 'queued', 'running'].includes(d.state)) continue;
        if (findDeploy(d.id)) { skipped.push({ id: d.id, reason: 'deploy already imported' }); continue; }
        if (!envOk(String(d.env || '').toLowerCase()) || !SCOPES.includes(d.scope)) { skipped.push({ id: d.id, reason: 'bad deploy env/scope' }); continue; }
        const nd = { id: d.id, env: d.env.toLowerCase(), scope: d.scope, ref: String(d.ref || ''), agent: String(d.agent || 'unknown'), purpose: String(d.purpose || ''), state: d.state, approved: !!d.approved, created: (d.created || t / 1000) * 1000, expires: (d.expires || t / 1000 + cfg.deployTtlMin * 60) * 1000 };
        if (d.hosts?.length) nd.hosts = d.hosts;
        if (d.state === 'running') { nd.started = (d.started || t / 1000) * 1000; nd.runner = d.runner || RUNNER; }
        emit({ t: 'dep_set', deploy: nd, event: 'import', at: t });
        deploys++;
      }
      return { ok: true, leases, deploys, skipped };
    });
  }

  // ---- shadow store ------------------------------------------------------------------------------------------------
  let shadowSvc = null;
  const reports = [];
  const reportsPath = join(dir, 'shadow', 'reports.jsonl');
  if (!cfg.noShadow) {
    try { for (const ln of fs.readFileSync(reportsPath, 'utf8').split('\n')) if (ln) reports.push(JSON.parse(ln)); } catch { /* none yet */ }
    reports.splice(0, Math.max(0, reports.length - 500));
  }
  const shadow = {
    async op(op, args = {}) {
      if (cfg.noShadow) return fail('E_INVALID', 'no nested shadow');
      shadowSvc ||= createLeaseService({ dir: join(dir, 'shadow'), now, config: { ...config, noShadow: true, readonly: false, notAuthority: undefined } });
      await shadowSvc.tick();
      const a = { ...args }; delete a.shadow;
      if (op.startsWith('deploy.')) { const f = shadowSvc.deploy[op.slice(7)]; return f ? f(a) : fail('E_INVALID', `unknown op ${op}`); }
      if (op === 'ticket' || op === 'cancelTicket') return shadowSvc[op](a.id, a);
      if (op === 'sessionGone') return shadowSvc.sessionGone(a.session, a);
      if (op === 'sessionStatus') return shadowSvc.sessionStatus(a.session, a.status);
      if (!['claim', 'get', 'release', 'renew', 'heartbeat', 'narrow', 'setMode', 'list', 'check', 'events', 'ownerRelease', 'importLegacy'].includes(op)) return fail('E_INVALID', `unknown op ${op}`);
      return shadowSvc[op](a);
    },
    async report(r = {}) {
      if (!isStr(r.machine, 80) || !isStr(r.command, 500)) return fail('E_INVALID', 'machine and command required');
      const row = { id: randomBytes(4).toString('hex'), at: iso(now()), machine: r.machine, command: r.command, legacy: r.legacy ?? null, central: r.central ?? null };
      const line = JSON.stringify(row).slice(0, 20000);
      if (line.length >= 20000) return fail('E_INVALID', 'report too large');
      try { fs.mkdirSync(join(dir, 'shadow'), { recursive: true, mode: 0o700 }); try { if (fs.statSync(reportsPath).size > (cfg.reportsMaxBytes || 5 * 1024 * 1024)) fs.renameSync(reportsPath, `${reportsPath}.1`); } catch { /* none yet */ } fs.appendFileSync(reportsPath, line + '\n', { mode: 0o600 }); } catch (e) { return unavailable('cannot store the report'); }
      reports.push(row);
      if (reports.length > 500) reports.shift();
      return { ok: true, id: row.id };
    },
    async list() { return { ok: true, reports: [...reports].reverse() }; },
  };

  // config.notAuthority = { authority: '<name of the real authority>' }: this store is not the authority (the registry host service is, reached
  // through the ssh wrapper), so every write AND read (an empty store would answer "free") is refused with a clear error. Only status, tick, sessionGone/Status/activity and the shadow store stay open.
  const na = cfg.notAuthority;
  const refuse = () => fail('E_NOT_AUTHORITY', `this in-process lease service is not the authority; ${na.authority || 'the registry host service'} is: claim there (vpt-lease through the ssh wrapper)`, { status: 409 });
  const guard = (f) => (na ? async () => refuse() : f);
  const guarded = na ? {
    claim: guard(claim), ticket: guard(ticket), cancelTicket: guard(cancelTicket), release: guard(release), renew: guard(renew), heartbeat: guard(heartbeat),
    narrow: guard(narrow), setMode: guard(setMode), ownerRelease: guard(ownerRelease), importLegacy: guard(importLegacy),
    get: guard(get), list: guard(list), check: guard(check), events: guard(events),
  } : {};
  const deployApi = na ? { ...deploy, request: guard(), approve: guard(), cancel: guard(), start: guard(), finish: guard(), record: guard(), list: guard(), wait: guard(), last: guard() } : deploy;

  return {
    claim, ticket, cancelTicket, get, release, renew, heartbeat, narrow, setMode, list, check, events, ownerRelease, sessionGone, sessionStatus, activity, tick,
    deploy: deployApi, shadow, importLegacy,
    ...guarded,
    async status() { return { ok: !broken, authority: !na, ...(na ? { authorityNote: `not the authority: ${na.authority || 'the registry host service'} is` } : {}), readOnly: !!broken || cfg.readonly, reason: broken, seq: S.seq, leases: Object.keys(S.leases).length, polls: polls.size, parsed: parsedCache.size }; },
    async close() { await chain.catch(() => {}); if (shadowSvc) await shadowSvc.close(); },
  };
}

// Legacy `vpt-lease list --json` rows (one per resource, epoch seconds) from list() lease views; used by lease-export.js.
export function toLegacyRows(views) {
  const rows = [];
  for (const l of views) for (const name of l.legacy) {
    rows.push({ id: l.id, env: l.env, resource: name, agent: l.agent, purpose: l.purpose, provider: l.provider, shared: l.shared, kind: l.kind,
      since: secs(Date.parse(l.since)), expires: secs(Date.parse(l.expires_at)), ttlLeftMin: l.ttlLeftMin, mode: l.mode });
  }
  return rows;
}
