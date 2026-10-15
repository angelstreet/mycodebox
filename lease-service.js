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
const parsedCache = new Map();
const P = (c) => { let r = parsedCache.get(c); if (!r) { r = parseResource(c); parsedCache.set(c, r); } return r; };

// A new exclusive claim of resource n against a held exclusive lease on h (design matrix). heldKind = the held lease's sensitivity.
export function resourceConflict(n, h, heldKind) {
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
const covers = (a, b) => a.type === 'env' || canonical(a) === canonical(b) || (a.type === 'host' && b.type === 'device' && a.host === b.host);
const leaseType = (l) => l.resources.map((c) => P(c).type).sort((a, b) => RANK[a] - RANK[b])[0] || 'env';
// Lease vs lease. Only exclusive leases conflict (unless ignoreModes: the pin footprint check); the same agent never
// conflicts with itself; two `shared` leases never conflict with each other (a shared exclusive lease conflicts only with non-shared ones).
function leasesConflict(a, b, ignoreModes = false) {
  if (!ignoreModes && (a.mode !== 'exclusive' || b.mode !== 'exclusive')) return false;
  if (a.agent === b.agent) return false;
  if (a.shared && b.shared) return false;
  return a.resources.some((x) => b.resources.some((y) => resourceConflict(P(x), P(y), b.kind)));
}
const defaultKind = (parsed) => (parsed.length && parsed.every((r) => r.type === 'device') ? 'host' : 'server');
// Which resources a deploy of this scope disturbs (pending deploys block new claims on these).
function scopeTouches(scope, hosts, r) {
  if (r.type === 'env' || scope === 'full') return true;
  if (scope === 'frontend') return r.type === 'frontend';
  if (scope === 'server') return r.type !== 'frontend';
  if (r.type === 'frontend' || r.type === 'server') return false;                  // host
  return !hosts?.length || hosts.includes(r.host);
}
const exempt = (agent) => agent === RUNNER || String(agent).startsWith('update_core:');
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const freshState = () => ({ seq: 0, leases: {}, gens: {}, tickets: {}, deploys: [], deployed: {}, recorded: [], events: [], evN: 0, stats: [] });
const newId = (taken) => { for (;;) { const id = randomBytes(4).toString('hex'); if (!taken(id)) return id; } };

const defaultIo = {
  async append(path, data, sync) {
    const fh = await fs.promises.open(path, 'a', 0o600);
    try { await fh.appendFile(data); if (sync) await fh.sync(); } finally { await fh.close(); }
  },
};

export function createLeaseService({ dir, now = Date.now, sessions, onEvent, config = {} } = {}) {
  if (!dir) throw new Error('lease service needs a dir');
  const cfg = {
    envs: [], ttlDefaultMin: 120, ttlMaxMin: 480, heartbeatS: 300, missFactor: 3, ticketIdleMs: 10 * MIN, goneGraceMs: 2 * MIN,
    snapshotEvery: 200, runningMaxMin: 90, keepFinished: 50, deployTtlMin: 360, maxEvents: 5000, readonly: false, io: defaultIo,
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
  const polls = new Map();          // ticket id -> last poll ms (not journaled; reset to "now" on start)
  const depWaiters = new Map();     // agent|id -> { agent, deployId, env, since, seen }
  const wakeups = new Set();

  // ---- events ------------------------------------------------------------------------------------------------------
  function ev(kind, l, at, extra = {}) {
    const e = { n: ++S.evN, at, kind, ...(l ? { id: l.id, env: l.env, resources: l.resources, agent: l.agent, session: l.session || null, mode: l.mode } : {}), ...extra };
    S.events.push(e);
    if (S.events.length > cfg.maxEvents) S.events.splice(0, S.events.length - cfg.maxEvents);
  }
  const evTicket = (tk, at, state) => ev('ticket', { env: tk.env, resources: tk.resources, agent: tk.agent, session: tk.session, mode: tk.mode }, at, { ticket: tk.id, state });

  // ---- apply: the only code that changes state (live and replay) ---------------------------------------------------
  function apply(f) {
    S.seq = f.seq;
    switch (f.t) {
      case 'grant': {
        const l = f.lease;
        S.leases[l.id] = l;
        for (const [k, g] of Object.entries(l.gens)) S.gens[k] = Math.max(S.gens[k] || 0, g);
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
          ev(f.why, l, f.at, { by: f.by, reason: f.reason, held_min: Math.round((f.at - l.since) / MIN) });
        }
        break;
      }
      case 'renew': { const l = S.leases[f.id]; if (l) { l.expires = f.expires; l.ttlMin = f.ttlMin; l.lastHb = f.at; } break; }
      case 'hb': { const l = S.leases[f.id]; if (l) { l.lastHb = f.at; if (f.active) l.lastActive = f.at; } break; }
      case 'mode': { const l = S.leases[f.id]; if (l) { const from = l.mode; l.mode = f.to; ev('downgraded', l, f.at, { from, to: f.to, by: f.by, reason: f.reason }); } break; }
      case 'narrow': {
        const l = S.leases[f.id];
        if (l) { const from = { resources: l.resources, sensitivity: l.kind }; l.resources = f.resources; l.kind = f.sensitivity; ev('narrowed', l, f.at, { from, by: f.by, reason: f.reason }); }
        break;
      }
      case 'tkt_new': S.tickets[f.ticket.id] = f.ticket; evTicket(f.ticket, f.at, 'waiting'); break;
      case 'tkt_end': { const tk = S.tickets[f.id]; if (tk) { tk.state = f.state; tk.endedAt = f.at; evTicket(tk, f.at, f.state); } break; }
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
      snapSeq = S.seq;
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
    for (const tk of Object.values(S.tickets)) if (tk.state === 'waiting') polls.set(tk.id, t);
  }
  function writeSnapshot() {
    try {
      const tmp = `${snapshotPath}.${process.pid}.tmp`;
      const cut = now() - 60 * MIN;
      for (const [id, tk] of Object.entries(S.tickets)) if (tk.state !== 'waiting' && (tk.endedAt || tk.grantedAt || 0) < cut) delete S.tickets[id];
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ version: 1, state: S })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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

  async function mutate(fn) {
    return lock(async () => {
      if (broken) return unavailable(`lease service is read-only: ${broken}`);
      if (cfg.readonly) return unavailable('lease service opened read-only');
      const before = S.evN;
      const pending = [];
      const emit = (f) => { f.seq = S.seq + 1; if (f.at == null) f.at = now(); apply(f); pending.push(f); };
      let out;
      try { housekeeping(emit); out = fn(emit); grantTickets(emit); } catch (e) { out = fail('E_UNAVAILABLE', `internal error: ${String(e.message || e).slice(0, 120)}`); }
      if (pending.length) {
        try { await persist(pending); } catch (e) {
          broken = `journal write failed: ${String(e.message || e).slice(0, 120)}`;     // memory is ahead of disk: fail closed until restart
          return unavailable(`lease service is read-only: ${broken}`);
        }
        if (S.seq - snapSeq >= cfg.snapshotEvery) writeSnapshot();
        if (onEvent) for (const e of S.events) if (e.n > before) { try { onEvent(e); } catch { /* observer errors never matter */ } }
        wake();
      }
      return out;
    });
  }
  async function read(fn) {
    return lock(async () => {
      if (broken) return unavailable(`lease service is read-only: ${broken}`);
      if (!cfg.readonly) {
        const pending = [];
        const emit = (f) => { f.seq = S.seq + 1; if (f.at == null) f.at = now(); apply(f); pending.push(f); };
        housekeeping(emit);
        if (pending.length) {
          try { await persist(pending); } catch (e) { broken = `journal write failed: ${String(e.message || e).slice(0, 120)}`; return unavailable(`lease service is read-only: ${broken}`); }
          wake();
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
      kind: l.kind, agent: l.agent, client: l.client || null, session: l.session || null, purpose: l.purpose || '', provider: l.provider || '',
      shared: !!l.shared, since: iso(l.since), expires_at: iso(l.expires), ttl_min: l.ttlMin, ttlLeftMin: Math.floor((l.expires - t) / MIN),
      long: l.ttlMin > 240, idleMin: Math.floor((t - l.lastActive) / MIN), lastHeartbeatAt: iso(l.lastHb), generation: l.generation, gens: l.gens,
      heartbeat_s: l.heartbeatS, expect_min: l.expectMin ?? null, eta: iso(expectedEnd(l)), goneAt: iso(l.goneAt), imported: !!l.imported,
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
  const expectedEnd = (l) => Math.min(l.expires, Math.max(now(), l.since + holdMs(l)));
  const waitingTickets = (env) => Object.values(S.tickets).filter((tk) => tk.state === 'waiting' && (!env || tk.env === env)).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  const inEnv = (env) => Object.values(S.leases).filter((l) => l.env === env);
  const heldConflicts = (virt) => inEnv(virt.env).filter((l) => leasesConflict(virt, l));
  function etaOf(virt, ahead) {
    const t = now();
    let end = t;
    for (const b of heldConflicts(virt)) end = Math.max(end, expectedEnd(b));
    for (const a of ahead) end += holdMs(a);
    return end;
  }
  const aheadOf = (virt, tk) => waitingTickets(virt.env).filter((o) => (!tk || o.id !== tk.id) && (!tk || o.created < tk.created || (o.created === tk.created && o.id < tk.id)) && leasesConflict(virt, o));
  function ticketView(tk) {
    const out = { id: tk.id, state: tk.state, env: tk.env, resources: tk.resources, agent: tk.agent, session: tk.session || null, created: iso(tk.created), purpose: tk.purpose || '' };
    if (tk.state === 'waiting') {
      const ahead = aheadOf(tk, tk);
      const t = etaOf(tk, ahead);
      Object.assign(out, { position: ahead.length + 1, eta: iso(t), eta_in_min: Math.max(0, Math.ceil((t - now()) / MIN)), holders: heldConflicts(tk).map(leaseView) });
    }
    if (tk.state === 'granted' && S.leases[tk.leaseId]) out.lease = leaseView(S.leases[tk.leaseId]);
    if (tk.state === 'granted') out.lease_id = tk.leaseId;
    return out;
  }

  // ---- deploys: touches / blockers ---------------------------------------------------------------------------------
  const pendingFor = (env, resources) => S.deploys.filter((d) => d.env === env && (d.state === 'queued' || d.state === 'running') && resources.some((c) => scopeTouches(d.scope, d.hosts, P(c))));
  function deployBlockers(d, { skipLeased = false, agent = '' } = {}) {
    const ls = inEnv(d.env).filter((l) => l.mode === 'exclusive' && l.agent !== RUNNER && l.agent !== agent);
    const hostOf = (l) => l.resources.map((c) => P(c)).filter((r) => r.type === 'host' || r.type === 'device').map((r) => r.host);
    const leasedHosts = [];
    for (const l of ls) for (const h of hostOf(l)) if (!leasedHosts.some((x) => x.host === h)) leasedHosts.push({ host: h, agent: l.agent });
    const hasType = (l, ...ts) => l.resources.some((c) => ts.includes(P(c).type));
    const virtual = (rs) => ({ mode: 'exclusive', agent: '\0deploy', shared: false, resources: rs, kind: 'server' });
    let blockers;
    if (d.scope === 'frontend') blockers = ls.filter((l) => leasesConflict(virtual(['frontend']), l));
    else if (d.scope === 'server') blockers = ls.filter((l) => leasesConflict(virtual(['server']), l));
    else if (d.scope === 'host' && d.hosts?.length) blockers = ls.filter((l) => leasesConflict(virtual(d.hosts.map((h) => `host:${h}`)), l));
    else if (d.scope === 'host') blockers = skipLeased ? ls.filter((l) => hasType(l, 'env')) : ls.filter((l) => hasType(l, 'env', 'host', 'device'));
    else blockers = skipLeased ? ls.filter((l) => hasType(l, 'env', 'server', 'frontend') || (hasType(l, 'host', 'device') && l.kind === 'server')) : ls;   // full
    return { blockers, leasedHosts: skipLeased ? leasedHosts : [] };
  }

  // ---- housekeeping (called inside every locked operation) ---------------------------------------------------------
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
      if (l.mode === 'exclusive' && l.heartbeatS > 0 && t - l.lastHb >= cfg.missFactor * l.heartbeatS * 1000) { rel('expired', 'no-heartbeat'); continue; }
      if (l.goneAt && t - l.goneAt >= cfg.goneGraceMs) { rel('released', 'session-gone'); continue; }
      if (l.mode === 'exclusive' && !exempt(l.agent)) {
        const limit = l.idleMin != null ? l.idleMin * MIN : cfg.idleMs[leaseType(l)];
        if (limit > 0 && t - l.lastActive >= limit) emit({ t: 'mode', id: l.id, to: 'pin', by: 'system', reason: 'idle', at: t });
      }
    }
    for (const tk of waitingTickets()) if (t - (polls.get(tk.id) ?? t) >= cfg.ticketIdleMs) emit({ t: 'tkt_end', id: tk.id, state: 'expired', at: t });
    for (const d of [...S.deploys]) {
      if ((d.state === 'awaiting-approval' || d.state === 'queued') && d.expires <= t) emit({ t: 'dep_set', deploy: { ...d, state: 'cancelled', finished: t, reason: 'expired' }, event: 'expired', at: t });
      else if (d.state === 'running' && d.started + cfg.runningMaxMin * MIN <= t) emit({ t: 'dep_set', deploy: { ...d, state: 'failed', finished: t, reason: 'runner lost (no finish)' }, event: 'expired', at: t });
    }
    for (const [k, w] of depWaiters) if (t - w.seen > 10 * MIN) depWaiters.delete(k);
  }

  function makeLease(req, t, extra = {}) {
    const gens = {};
    for (const c of req.resources) gens[`${req.env}|${c}`] = (S.gens[`${req.env}|${c}`] || 0) + 1;
    const id = newId((x) => S.leases[x] || x === extra.id);
    return {
      id, env: req.env, resources: req.resources, mode: req.mode, kind: req.kind, agent: req.agent, client: req.client || null, session: req.session || null,
      purpose: req.purpose || '', provider: req.provider || '', shared: !!req.shared, since: t, expires: t + req.ttlMin * MIN, ttlMin: req.ttlMin,
      heartbeatS: req.heartbeatS, lastHb: t, lastActive: t, expectMin: req.expectMin ?? null, idleMin: req.idleMin ?? null, gens, generation: Math.max(...Object.values(gens)), ...extra,
    };
  }
  function grantTickets(emit) {
    const earlier = [];
    for (const tk of waitingTickets()) {
      const blocked = heldConflicts(tk).length > 0 || earlier.some((e) => e.env === tk.env && leasesConflict(tk, e))
        || (!exempt(tk.agent) && pendingFor(tk.env, tk.resources).length > 0);
      if (blocked) { earlier.push(tk); continue; }
      const t = now();
      emit({ t: 'grant', lease: makeLease(tk, t), ticket: tk.id, at: t });
    }
  }

  // ---- validation --------------------------------------------------------------------------------------------------
  const envOk = (e) => typeof e === 'string' && (cfg.envs.length ? cfg.envs.includes(e.toLowerCase()) : ENV_RE.test(e.toLowerCase()));
  const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  function parseResources(v) {
    const rs = listOf(v);
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
  function validateClaim(a) {
    if (!a || typeof a !== 'object') return fail('E_INVALID', 'body must be an object');
    const bad = envCheck(a.env); if (bad) return bad;
    const rs = parseResources(a.resources); if (rs.error) return fail('E_INVALID', rs.error);
    if (!isStr(a.agent)) return fail('E_INVALID', 'agent required');
    const mode = a.mode ?? 'exclusive';
    if (!MODES.includes(mode)) return fail('E_INVALID', `mode must be ${MODES.join('|')}`);
    let kind = a.kind == null ? defaultKind(rs.parsed) : (KIND_ALIASES[a.kind] || a.kind);
    if (kind !== 'server' && kind !== 'host') return fail('E_INVALID', 'kind must be server|host');
    const ttlMin = a.ttl_min ?? cfg.ttlDefaultMin;
    if (typeof ttlMin !== 'number' || !(ttlMin > 0) || ttlMin > cfg.ttlMaxMin) return fail('E_INVALID', `ttl_min must be in (0, ${cfg.ttlMaxMin}]`);
    const heartbeatS = a.heartbeat_s ?? cfg.heartbeatS;
    if (typeof heartbeatS !== 'number' || (heartbeatS !== 0 && (heartbeatS < 10 || heartbeatS > 3600))) return fail('E_INVALID', 'heartbeat_s must be 0 or 10..3600');
    if (a.expect_min != null && (typeof a.expect_min !== 'number' || !(a.expect_min > 0) || a.expect_min > cfg.ttlMaxMin)) return fail('E_INVALID', 'expect_min must be a positive number of minutes');
    if (a.idle_min != null && (typeof a.idle_min !== 'number' || a.idle_min < 0)) return fail('E_INVALID', 'idle_min must be >= 0 (0 = never)');
    const wait = a.wait === true ? 'ticket' : a.wait || false;
    if (wait !== false && wait !== 'ticket') return fail('E_INVALID', 'wait must be false|"ticket"');
    const session = typeof a.session === 'string' && a.session ? a.session.slice(0, 200) : (/^(codebox|mac):\S+$/.test(a.agent) ? a.agent : null);
    return {
      ok: true, wait,
      req: { env: a.env.toLowerCase(), resources: rs.resources, mode, kind, agent: a.agent, client: typeof a.client === 'string' ? a.client.slice(0, 80) : null, session,
        purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 500) : '', provider: typeof a.provider === 'string' ? a.provider.slice(0, 80) : '', shared: !!a.shared,
        ttlMin, heartbeatS, expectMin: a.expect_min ?? null, idleMin: a.idle_min ?? null },
    };
  }

  // ---- claim / tickets ---------------------------------------------------------------------------------------------
  async function claim(a) {
    const v = validateClaim(a); if (!v.ok) return v;
    return mutate((emit) => {
      const req = v.req;
      const t = now();
      if (req.mode === 'exclusive') {
        if (!exempt(req.agent)) {
          const pend = pendingFor(req.env, req.resources);
          if (pend.length) {
            const d = pend[0];
            return fail('E_DEPLOY_PENDING', `deploy ${d.id} (${d.state}) on ${req.env}: scope=${d.scope} ref=${d.ref} requested by ${d.agent}; wait for it, then claim again`, { deploy: deployView(d), deploys: pend.map(deployView) });
          }
        }
        const holders = heldConflicts(req);
        const ahead = aheadOf(req, null);
        if (holders.length || ahead.length) {
          if (v.wait === 'ticket') {
            const tk = { id: `t-${newId((x) => S.tickets[`t-${x}`])}`, ...req, state: 'waiting', created: t };
            emit({ t: 'tkt_new', ticket: tk, at: t });
            polls.set(tk.id, t);
            return { ok: true, ticket: ticketView(S.tickets[tk.id]) };
          }
          const eta = etaOf(req, ahead);
          return fail('E_HELD', `${req.env}/${req.resources.join(',')} is held by ${[...new Set(holders.map((h) => h.agent))].join(', ') || 'a queued claim'}`,
            { holders: holders.map(leaseView), queued_ahead: ahead.map((x) => ({ id: x.id, agent: x.agent })), position: ahead.length + 1, eta: iso(eta), eta_in_min: Math.max(0, Math.ceil((eta - t) / MIN)) });
        }
      }
      const lease = makeLease(req, t);
      emit({ t: 'grant', lease, at: t });
      return { ok: true, lease: leaseView(S.leases[lease.id]) };
    });
  }
  async function ticket(id, opts = {}) {
    const waitMs = Math.max(0, Math.min(30000, Number(opts.waitMs ?? (opts.wait_s != null ? opts.wait_s * 1000 : 0)) || 0));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await read(() => {
        const tk = S.tickets[id];
        if (!tk) return fail('E_NOT_FOUND', 'no such ticket');
        if (tk.state === 'waiting') polls.set(id, now());
        return { ok: true, ticket: ticketView(tk) };
      });
      if (!r.ok || r.ticket.state !== 'waiting' || Date.now() >= deadline) return r;
      await sleepUntilWake(Math.min(1000, deadline - Date.now()));
    }
  }
  async function cancelTicket(id) {
    return mutate((emit) => {
      const tk = S.tickets[id];
      if (!tk) return fail('E_NOT_FOUND', 'no such ticket');
      if (tk.state === 'waiting') emit({ t: 'tkt_end', id, state: 'cancelled' });
      return { ok: true, ticket: ticketView(S.tickets[id]) };
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
        ids = l ? [l.id] : [];
      } else {
        ids = Object.values(S.leases).filter((l) => l.agent === a.agent).map((l) => l.id);
        cancelled = waitingTickets().filter((tk) => tk.agent === a.agent).map((tk) => tk.id);
      }
      const by = typeof a.by === 'string' && a.by ? a.by.slice(0, 80) : (a.agent || (S.leases[a.id]?.agent) || 'holder');
      if (ids.length) emit({ t: 'release', ids, why: 'released', by, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
      for (const id of cancelled) emit({ t: 'tkt_end', id, state: 'cancelled' });
      return { ok: true, released: ids, cancelled };
    });
  }
  async function ownerRelease(a = {}) {
    if (!isStr(a.id, 64)) return fail('E_INVALID', 'id required');
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      emit({ t: 'release', ids: [l.id], why: 'forced', by: typeof a.by === 'string' && a.by ? a.by.slice(0, 80) : 'owner', reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : 'owner force-release' });
      return { ok: true, released: [l.id] };
    });
  }
  async function renew(a = {}) {
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const ttlMin = a.ttl_min ?? l.ttlMin;
      if (typeof ttlMin !== 'number' || !(ttlMin > 0) || ttlMin > cfg.ttlMaxMin) return fail('E_INVALID', `ttl_min must be in (0, ${cfg.ttlMaxMin}]`);
      const t = now();
      emit({ t: 'renew', id: l.id, expires: t + ttlMin * MIN, ttlMin, at: t });
      return { ok: true, lease: leaseView(S.leases[l.id]) };
    });
  }
  async function heartbeat(a = {}) {
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      emit({ t: 'hb', id: l.id, active: !!a.active });
      return { ok: true, lease: leaseView(S.leases[l.id]) };
    });
  }
  async function narrow(a = {}) {
    if (a.resources == null && a.kind == null) return fail('E_INVALID', 'narrow needs resources and/or kind');
    if (a.kind != null && (KIND_ALIASES[a.kind] || a.kind) !== 'host') return fail('E_INVALID', 'a lease can only be narrowed to kind host');
    let rs = null;
    if (a.resources != null) { rs = parseResources(a.resources); if (rs.error) return fail('E_INVALID', rs.error); }
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      if (rs && !rs.parsed.every((n) => l.resources.some((o) => covers(P(o), n)))) return fail('E_INVALID', 'narrow never widens: every resource must be inside the lease');
      const resources = rs ? rs.resources : l.resources;
      const sensitivity = a.kind != null ? 'host' : l.kind;
      const changed = sensitivity !== l.kind || resources.join() !== l.resources.join();
      if (changed) emit({ t: 'narrow', id: l.id, resources, sensitivity, by: typeof a.by === 'string' ? a.by.slice(0, 80) : 'holder', reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
      return { ok: true, changed, lease: leaseView(S.leases[l.id]) };
    });
  }
  async function setMode(a = {}) {
    if (!MODES.includes(a.mode)) return fail('E_INVALID', `mode must be ${MODES.join('|')}`);
    return mutate((emit) => {
      const l = S.leases[a.id];
      if (fenced(l, a.generation)) return fail('E_FENCED', 'stale generation: the lease is no longer yours');
      if (!l) return fail('E_NOT_FOUND', 'no such active lease');
      const owner = a.by === 'owner';
      if (!owner && a.agent != null && a.agent !== l.agent) return fail('E_AUTH', 'only the holder or the owner can change the mode');
      if (MODE_RANK[a.mode] > MODE_RANK[l.mode]) return fail('E_INVALID', 'a mode can only be downgraded (exclusive -> pin -> observe)');
      if (a.mode !== l.mode) emit({ t: 'mode', id: l.id, to: a.mode, by: owner ? 'owner' : (a.agent || 'holder'), reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
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
    const rs = listOf(a.resources).length ? parseResources(a.resources) : { resources: ['*'], parsed: [{ type: 'env' }] };
    if (rs.error) return fail('E_INVALID', rs.error);
    const ignore = typeof a.ignore_agent === 'string' ? a.ignore_agent : '';
    return read(() => {
      const waiting = waitingTickets(env).length;
      const pending = pendingFor(env, rs.resources).map(deployView);
      if (a.skip_leased) {
        const has = (...ts) => rs.parsed.some((r) => ts.includes(r.type));
        const hosts = listOf(a.hosts).map((h) => h.toLowerCase());
        const scope = has('env', 'server') ? 'full' : listOf(a.resources).length ? 'frontend' : 'host';
        const { blockers, leasedHosts } = deployBlockers({ env, scope }, { skipLeased: true, agent: ignore });
        const leased = hosts.map((h) => leasedHosts.find((x) => x.host === h)).filter(Boolean);
        return { ok: true, free: blockers.length === 0, holders: blockers.map(leaseView), leased_hosts: leased, pending_deploys: pending, waiting };
      }
      const virt = { env, mode: 'exclusive', agent: ignore, shared: false, resources: rs.resources, kind: defaultKind(rs.parsed) };
      const holders = heldConflicts(virt).map(leaseView);
      return { ok: true, free: holders.length === 0, holders, pending_deploys: pending, waiting };
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
  async function sessionStatus(session, status) {
    if (!isStr(session)) return fail('E_INVALID', 'session required');
    return mutate((emit) => {
      const down = [];
      if (status === 'waiting' || status === 'blocked') {
        for (const l of ofSession(session)) if (l.mode === 'exclusive') { down.push(l.id); emit({ t: 'mode', id: l.id, to: 'pin', by: 'system', reason: `status:${status}` }); }
      }
      return { ok: true, downgraded: down };
    });
  }
  const tick = () => mutate(() => ({ ok: true }));

  // ---- deploy queue (registry semantics, vpt-lease deploy ...) -----------------------------------------------------
  const hostList = (v) => listOf(v).map((h) => String(h).toLowerCase());
  const findDeploy = (id) => S.deploys.find((d) => d.id === id);
  const depNew = () => newId((x) => S.deploys.some((d) => d.id === x));
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
        const d = { id: depNew(), env: a.env.toLowerCase(), scope: a.scope, ref: a.ref, agent: a.agent, purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 500) : '', state: a.approved ? 'queued' : 'awaiting-approval', approved: !!a.approved, created: t, expires: t + ttl * MIN };
        if (hosts.length) d.hosts = hosts;
        emit({ t: 'dep_set', deploy: d, event: 'request', at: t });
        return { ok: true, id: d.id, deploy: deployView(d) };
      });
    },
    async approve(a = {}) {
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
        if (d.state !== 'queued') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, not queued`);
        const other = S.deploys.find((x) => x.env === d.env && x.state === 'running');
        if (other) return fail('E_HELD', `deploy ${other.id} is already running on ${d.env}`, { running: deployView(other), holders: [] });
        const { blockers, leasedHosts } = deployBlockers(d, { skipLeased: !!a.skip_leased, agent });
        if (blockers.length) return fail('E_HELD', 'leases in the way', { holders: blockers.map(leaseView) });
        const t = now();
        const nd = { ...d, state: 'running', started: t, runner: agent };
        emit({ t: 'dep_set', deploy: nd, event: 'start', at: t });
        return { ok: true, state: 'running', deploy: deployView(nd), leased_hosts: leasedHosts, skipped_hosts: leasedHosts.map((x) => x.host) };
      });
    },
    async finish(a = {}) {
      if (a.status !== 'done' && a.status !== 'failed') return fail('E_INVALID', 'status must be done|failed');
      return mutate((emit) => {
        const d = findDeploy(a.id);
        if (!d) return fail('E_NOT_FOUND', `no such deploy ${a.id}`);
        if (d.state !== 'queued' && d.state !== 'running') return fail('E_INVALID', `deploy ${d.id} is ${d.state}, cannot finish`);
        const t = now();
        const nd = { ...d, state: a.status, finished: t };
        if (a.version) nd.version = String(a.version).slice(0, 200);
        if (a.coalesced_into) nd.coalescedInto = String(a.coalesced_into).slice(0, 64);
        const skipped = hostList(a.skipped_hosts);
        if (skipped.length) nd.skippedHosts = skipped;
        if (typeof a.tail === 'string') nd.tail = a.tail.slice(-6000);
        emit({ t: 'dep_set', deploy: nd, event: 'finish', at: t });
        let recorded = null;
        if (!nd.coalescedInto) {
          recorded = ledgerRecord(emit, { env: nd.env, scope: nd.scope, hosts: nd.hosts || [], ref: nd.ref, version: nd.version || '', agent: nd.agent, status: a.status, started: secs(nd.started), deployId: nd.id });
        }
        // hosts left out because they were leased: queue the catch-up deploy (the runner used to do this from SKIPPED_HOSTS)
        let catchup = null;
        if (a.status === 'done' && skipped.length && !S.deploys.some((x) => x.env === nd.env && x.scope === 'host' && x.state === 'queued' && x.ref === nd.ref && skipped.every((h) => x.hosts?.includes(h)))) {
          const c = { id: depNew(), env: nd.env, scope: 'host', ref: nd.ref, agent: RUNNER, purpose: `catch-up for ${nd.id}: skipped ${skipped.join(',')}`, state: 'queued', approved: true, created: t, expires: t + cfg.deployTtlMin * MIN, hosts: skipped };
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
    for (const tg of targets) {
      const ent = map[tg] || (map[tg] = {});
      const ok = r.status === 'done' || (failed.size > 0 && !failed.has(tg) && !(tg === 'hosts' && r.hosts.some((h) => failed.has(h))));
      if (ok) { for (const k of Object.keys(ent)) delete ent[k]; Object.assign(ent, base, { status: 'done' }); } else ent.lastAttempt = { ...base };
    }
    emit({ t: 'deployed', env: r.env, map, deployId: r.deployId || `rec-${randomBytes(4).toString('hex')}` });
    return { already: false, targets };
  }

  // ---- legacy import (lease-import.js) -----------------------------------------------------------------------------
  async function importLegacy(a = {}) {
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
        const rs = parseResources(rows.map((r) => r.resource));
        if (rs.error) { skipped.push({ id, reason: rs.error }); continue; }
        const kind = KIND_ALIASES[first.kind] || first.kind || 'server';
        const l = makeLease({ env, resources: rs.resources, mode: 'exclusive', kind: kind === 'host' ? 'host' : 'server', agent: String(first.agent || 'unknown'), session: /^(codebox|mac):\S+$/.test(first.agent || '') ? first.agent : null,
          purpose: String(first.purpose || '').slice(0, 500), provider: String(first.provider || ''), shared: !!first.shared, ttlMin: Math.max(1, Math.round((exp - t) / MIN)), heartbeatS: 0 }, t, { id, imported: true });
        l.since = (Number(first.since) || t / 1000) * 1000;
        l.expires = exp;
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
      shadowSvc ||= createLeaseService({ dir: join(dir, 'shadow'), now, config: { ...config, noShadow: true, readonly: false } });
      await shadowSvc.tick();
      const a = { ...args }; delete a.shadow;
      if (op.startsWith('deploy.')) { const f = shadowSvc.deploy[op.slice(7)]; return f ? f(a) : fail('E_INVALID', `unknown op ${op}`); }
      if (op === 'ticket' || op === 'cancelTicket') return shadowSvc[op](a.id, a);
      if (op === 'sessionGone') return shadowSvc.sessionGone(a.session, a);
      if (op === 'sessionStatus') return shadowSvc.sessionStatus(a.session, a.status);
      if (!['claim', 'release', 'renew', 'heartbeat', 'narrow', 'setMode', 'list', 'check', 'events', 'ownerRelease'].includes(op)) return fail('E_INVALID', `unknown op ${op}`);
      return shadowSvc[op](a);
    },
    async report(r = {}) {
      if (!isStr(r.machine, 80) || !isStr(r.command, 500)) return fail('E_INVALID', 'machine and command required');
      const row = { id: randomBytes(4).toString('hex'), at: iso(now()), machine: r.machine, command: r.command, legacy: r.legacy ?? null, central: r.central ?? null };
      const line = JSON.stringify(row).slice(0, 20000);
      if (line.length >= 20000) return fail('E_INVALID', 'report too large');
      try { fs.mkdirSync(join(dir, 'shadow'), { recursive: true, mode: 0o700 }); fs.appendFileSync(reportsPath, line + '\n', { mode: 0o600 }); } catch (e) { return unavailable('cannot store the report'); }
      reports.push(row);
      if (reports.length > 500) reports.shift();
      return { ok: true, id: row.id };
    },
    async list() { return { ok: true, reports: [...reports].reverse() }; },
  };

  return {
    claim, ticket, cancelTicket, release, renew, heartbeat, narrow, setMode, list, check, events, ownerRelease, sessionGone, sessionStatus, tick,
    deploy, shadow, importLegacy,
    async status() { return { ok: !broken, readOnly: !!broken || cfg.readonly, reason: broken, seq: S.seq, leases: Object.keys(S.leases).length }; },
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
