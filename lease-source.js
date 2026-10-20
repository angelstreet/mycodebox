// One interface for the lease data the dashboard uses (round 10, docs/v2/LEASES-CENTRAL.md section 6 and 7).
// manager.json `leaseAuthority`: "central-through-ssh" reads the registry like "legacy" in this dashboard (see AUTHORITY_LABELS), but the vpt-lease client forwards every call over ssh in that mode; "legacy" (default) reads the registry over ssh (leases.js, deploy-runner.js) as before;
// "central" asks the in-process lease service (lease-service.js, Appendix A) and never calls the registry.
// No imports: the legacy pieces and the service are injected, so this module is pure and testable with fakes.
// Rows keep the legacy shape ({id, env, resource, agent, purpose, kind, ttlLeftMin}) so every old consumer works unchanged;
// the richer `view()` (modes, tickets, idle minutes, shadow reports) feeds the Leases view, the manager and the voice digest.

export const LEGACY_REFUSAL = 'legacy registry: release it on the registry host';
export const IDLE_MIN = 10;   // an exclusive hold with no control activity for this long counts as idle in the spoken line

// --- shapes ------------------------------------------------------------------------------------------------------
// ms from a service timestamp: ISO string, epoch ms or epoch seconds; null when unknown
export function tms(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}
// A time that may also be given as minutes from now (an ETA): small numbers are minutes
export function etaMs(v, now) {
  if (typeof v === 'number' && v >= 0 && v < 1e9) return now + v * 60000;
  return tms(v);
}
// typed resource -> the legacy spelling the old consumers know (`<env>/*` -> `*`, `host:h` -> `h`, `device:h/d` -> `h/d`)
export function legacyResource(env, r) {
  let s = String(r ?? '*');
  if (env && s.startsWith(`${env}/`)) s = s.slice(env.length + 1);
  if (s === '*' || s === 'frontend' || s === 'server') return s;
  if (s.startsWith('host:')) return s.slice(5);
  if (s.startsWith('device:')) return s.slice(7);
  return s;
}
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// a service lease -> the rich record
export function normLease(l, now) {
  const env = l.env || '';
  const resources = Array.isArray(l.legacy) && l.legacy.length ? l.legacy : asList(l.resources ?? l.resource).map((r) => legacyResource(env, r));
  const sinceMs = tms(l.since ?? l.since_ms);
  const expiresMs = tms(l.expires_at ?? l.expires);
  const ttl = Number.isFinite(l.ttlLeftMin) ? l.ttlLeftMin : expiresMs ? Math.max(0, Math.floor((expiresMs - now) / 60000)) : null;
  return {
    id: String(l.id), env, resources, mode: l.mode || 'exclusive', kind: l.kind || 'host', agent: l.agent || '', session: l.session || '', purpose: l.purpose || '',
    deployId: l.deploy_id || null, sinceMs, ttlLeftMin: ttl, lastHeartbeatMs: tms(l.lastHeartbeatAt ?? l.last_heartbeat_at), idleMin: Number.isFinite(l.idleMin) ? l.idleMin : null, heartbeatS: l.heartbeat_s ?? null,
    expectMin: Number.isFinite(l.expect_min) ? l.expect_min : null,   // the holder's own stated hold time (lease-nudge.js)
  };
}
export function normTicket(t, now) {
  const env = t.env || '';
  return {
    id: String(t.id), env, resources: asList(t.resources ?? t.resource).map((r) => legacyResource(env, r)), agent: t.agent || '', session: t.session || '', purpose: t.purpose || '',
    position: t.position ?? null, etaMs: etaMs(t.eta ?? t.eta_ms ?? t.etaMin, now), holders: asList(t.holders).map((h) => (typeof h === 'string' ? h : h?.agent || '')).filter(Boolean),
    holderIds: asList(t.holders).map((h) => (h && typeof h === 'object' ? String(h.id || '') : '')).filter(Boolean), createdMs: tms(t.created),
  };
}
// legacy-shaped rows of the exclusive leases (one per resource): what leaseFor / leasesOfSession / park / triage read
export function legacyRows(leases) {
  return leases.filter((l) => l.mode === 'exclusive').flatMap((l) => l.resources.map((resource) => ({ id: l.id, env: l.env, resource, agent: l.agent, purpose: l.purpose, kind: l.kind, ttlLeftMin: l.ttlLeftMin })));
}
// `vpt-lease list --json` rows (legacy store) -> the same rich records, grouped by lease id
export function fromLegacyRows(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const e = by.get(r.id) || { id: String(r.id), env: r.env || '', resources: [], mode: r.mode || 'exclusive', kind: r.kind || 'host', agent: r.agent || '', session: r.session || '', purpose: r.purpose || '', deployId: r.deploy_id || null, sinceMs: tms(r.since), ttlLeftMin: r.ttlLeftMin ?? null,
      lastHeartbeatMs: tms(r.lastHeartbeatAt), idleMin: Number.isFinite(r.idleMin) ? r.idleMin : null, heartbeatS: r.heartbeat_s ?? null, expectMin: Number.isFinite(r.expect_min) ? r.expect_min : null };
    e.resources.push(r.resource || '*'); by.set(r.id, e);
  }
  return [...by.values()];
}

// --- summaries (voice, manager) -------------------------------------------------------------------------------------
export function summarize(view, now = Date.now()) {
  if (!view?.ok) return { ok: false, held: 0, pins: 0, queued: 0, idle: 0, head: null };
  const ex = (view.leases || []).filter((l) => l.mode === 'exclusive');
  const tickets = [...(view.tickets || [])].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  const h = tickets[0];
  return {
    ok: true, held: ex.length, pins: (view.leases || []).filter((l) => l.mode === 'pin').length, queued: tickets.length,
    idle: ex.filter((l) => l.idleMin != null && l.idleMin >= IDLE_MIN).length,
    head: h ? { resource: h.resources[0] || '*', env: h.env, count: tickets.filter((x) => x.env === h.env && (x.resources[0] || '*') === (h.resources[0] || '*')).length, etaMin: h.etaMs != null ? Math.max(0, Math.round((h.etaMs - now) / 60000)) : null } : null,
  };
}

// --- central deploy registry adapter ------------------------------------------------------------------------------
// deploy-runner.js talks to the registry as argv -> {code, stdout, stderr}. In central mode the same calls go to the service in-process.
const VALUE_FLAGS = new Set(['--status', '--version', '--coalesced-into', '--skipped-hosts', '--scope', '--ref', '--agent', '--hosts', '--purpose', '--ttl']);
export function parseArgs(args) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) flags[a.slice(2)] = args[++i]; else flags[a.slice(2)] = true; } else pos.push(a);
  }
  return { pos, flags };
}
const EXIT = { E_HELD: 3, E_DEPLOY_PENDING: 4, E_UNAVAILABLE: 5, E_NOT_FOUND: 1, E_INVALID: 1, E_AUTH: 1, E_FENCED: 1 };
export const exitOf = (res) => (res && res.ok === false ? EXIT[res.code] ?? 1 : 0);
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// the caller identity the service logs: a bare loopback caller is `loopback` (anyone on the box can curl it: never "owner"), a request through Serve carries its login
const ownerBy = (identity) => (!identity || identity === 'loopback' ? 'loopback' : `owner:${identity}`);

// A reverse proxy (Tailscale Serve) connects from 127.0.0.1 too. Its login header counts only on a proxied request (forwarding headers present);
// a bare loopback request is `loopback`, whatever header it may carry.
export function requestIdentity(headers = {}) {
  const proxied = ['x-forwarded-for', 'forwarded'].some((h) => headers[h] !== undefined);
  const login = headers['tailscale-user-login'];
  return proxied && typeof login === 'string' && login.trim() ? login.trim().slice(0, 80) : 'loopback';
}

export function centralRegistry(getService, { now = Date.now } = {}) {
  return async function registry(args, { stdin } = {}) {
    const svc = getService();
    const bad = (code, msg) => ({ code, stdout: '', stderr: msg });
    if (!svc?.deploy) return bad(5, 'lease service not available');
    const { pos, flags } = parseArgs(args);
    if (pos[0] !== 'deploy') return bad(1, `unsupported registry call: ${pos[0] || ''}`);
    const [, sub, a] = pos;
    try {
      let res;
      if (sub === 'list') {
        res = await svc.deploy.list({ all: true });   // finished deploys too: the runner's lastRef and the Platforms history read them
        const rich = await svc.list({}).catch(() => null);
        const deploys = Array.isArray(res) ? res : res?.deploys || [];
        const leases = rich?.ok === false ? undefined : legacyRows((rich?.leases || []).map((l) => normLease(l, now())));
        return { code: exitOf(res), stdout: JSON.stringify({ ok: true, deploys, ...(leases ? { leases } : {}) }), stderr: res?.error || '' };
      }
      if (sub === 'last') { res = await svc.deploy.last({ env: a }); return { code: exitOf(res), stdout: JSON.stringify(res), stderr: res?.error || '' }; }
      if (sub === 'request') {
        res = await svc.deploy.request({ exempt: true, env: a, scope: flags.scope, ref: flags.ref, agent: flags.agent, approved: !!flags.approved, hosts: csv(flags.hosts), purpose: flags.purpose, ttl: flags.ttl ? Number(flags.ttl) : undefined });
        return { code: exitOf(res), stdout: res?.ok === false ? '' : `${res?.id ?? res?.deploy?.id ?? ''}\n`, stderr: res?.error || '' };
      }
      if (sub === 'approve' || sub === 'cancel') { res = await svc.deploy[sub]({ id: a, exempt: true }); return { code: exitOf(res), stdout: JSON.stringify(res), stderr: res?.error || '' }; }
      if (sub === 'start') { res = await svc.deploy.start({ exempt: true, id: a, agent: flags.agent, skip_leased: !!flags['skip-leased'] }); return { code: exitOf(res), stdout: JSON.stringify(res), stderr: res?.error || '' }; }
      if (sub === 'finish') {
        res = await svc.deploy.finish({ exempt: true, id: a, status: flags.status, version: flags.version, coalesced_into: flags['coalesced-into'], skipped_hosts: csv(flags['skipped-hosts']), tail: flags['tail-stdin'] ? String(stdin ?? '') : undefined });
        return { code: exitOf(res), stdout: JSON.stringify(res), stderr: res?.error || '' };
      }
      return bad(1, `unsupported deploy call: ${sub}`);
    } catch (e) { return bad(5, String(e?.message || e).slice(0, 200)); }
  };
}

// --- the source -------------------------------------------------------------------------------------------------------
// legacy: { store (leases.js createLeaseStore), registry (deploy-runner default registry fn) }
// getService: () => the lease service (central), or null
// manager.json `leaseAuthority` values: 'legacy' (default), 'central-through-ssh' (the registry host's one central service,
// reached through the ssh vpt-lease wrapper: behaves exactly like 'legacy', only the label differs), 'central' (the in-process service).
export const AUTHORITY_LABELS = ['legacy', 'central-through-ssh', 'central'];
export const normAuthority = (x) => (AUTHORITY_LABELS.includes(x) ? x : 'legacy');
export const NOT_AUTHORITY_NOTE = 'the in-process lease service is not the authority; the registry host service is, reached through the ssh vpt-lease wrapper';

export function createLeaseSource({ authority = 'legacy', legacy = {}, getService = () => null, now = Date.now } = {}) {
  const label = () => normAuthority(typeof authority === 'function' ? authority() : authority);
  const auth = () => (label() === 'central' ? 'central' : 'legacy');   // behaviour: central-through-ssh takes the legacy paths unchanged
  // the view says where the authority is; the in-process service is only listed (never as the authority) when it is not
  const svcNote = () => (label() === 'central' ? {} : { inProcessService: { authority: false, note: NOT_AUTHORITY_NOTE } });
  let last = null;   // last central answer (peek)
  const notReady = { ok: false, error: 'lease service not available' };

  async function central() {
    const svc = getService();
    if (!svc?.list) return notReady;
    try {
      const r = await svc.list({});
      if (r?.ok === false) return { ok: false, error: String(r.error || r.code || 'lease service error').slice(0, 200) };
      const t = now();
      const leases = (r.leases || []).map((l) => normLease(l, t));
      const tickets = (r.tickets || []).map((x) => normTicket(x, t));
      const shadow = await shadowReports();
      return { ok: true, authority: 'central', at: t, leases, tickets, deploys: r.deploys || [], waiters: r.waiters || [], shadow };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  }
  // Shadow disagreements live in the service in both authorities: during the shadow period the dashboard still reads the
  // legacy registry, and the Leases view must show what the clients reported (LEASES-CENTRAL §10 step 4).
  let shadowLast = [];
  async function shadowReports() {
    try { const s = await getService()?.shadow?.list?.({}); shadowLast = Array.isArray(s) ? s : s?.reports || s?.items || []; } catch { shadowLast = []; }
    return shadowLast;
  }
  const tickets = (v) => (v.tickets || []).map((x) => normTicket(x, now()));   // the registry client's `tickets` (live mode)
  const asLegacyShape = (v) => (v.ok ? { ok: true, leases: legacyRows(v.leases), waiters: v.waiters || [] } : { ok: false, error: v.error });

  return {
    authority: auth,
    label,
    // what GET /api/leases, the 15 s WebSocket payload, leaseFor / leasesOfSession, triage and park read: {ok, leases: legacy rows, waiters} | {ok:false, error}
    async get(force = false) {
      if (auth() === 'legacy') return legacy.store.get(force);
      last = await central();
      return asLegacyShape(last);
    },
    peek() {
      if (auth() === 'legacy') return legacy.store.peek();
      return last ? asLegacyShape(last) : null;
    },
    // the rich view for the Leases view, the manager's lease answers and the voice line
    async view(force = true) {
      if (auth() === 'central') { last = await central(); return last; }
      const v = await legacy.store.get(force);
      if (!v.ok) return { ok: false, error: v.error, authority: label() };
      return { ok: true, authority: label(), at: now(), leases: fromLegacyRows(v.leases), tickets: tickets(v), deploys: [], waiters: v.waiters || [], shadow: await shadowReports(), ...svcNote() };
    },
    peekView() {
      if (auth() === 'central') return last;
      const v = legacy.store.peek();
      return v ? (v.ok ? { ok: true, authority: label(), at: now(), leases: fromLegacyRows(v.leases), tickets: tickets(v), deploys: [], waiters: v.waiters || [], shadow: shadowLast, ...svcNote() } : { ok: false, error: v.error, authority: label() }) : null;
    },
    // deploy-runner: argv -> {code, stdout, stderr}
    deployRegistry() { return auth() === 'central' ? centralRegistry(getService, { now }) : legacy.registry; },
    // lease-watch needs to know who acts: in central mode the service narrows / releases, lease-watch only observes
    acts: () => auth() === 'legacy',
    // owner actions (central only)
    async ownerRelease(id, identity = 'loopback') {
      if (auth() !== 'central') return { ok: false, status: 409, error: LEGACY_REFUSAL };
      const svc = getService(); if (!svc?.ownerRelease) return { ok: false, status: 503, error: notReady.error };
      try { const r = await svc.ownerRelease({ id, by: ownerBy(identity), identity }); return r?.ok === false ? { ok: false, status: r.code === 'E_NOT_FOUND' ? 404 : r.code === 'E_INVALID' ? 400 : 502, error: r.error || r.code } : { ok: true, ...(r || {}) }; }
      catch (e) { return { ok: false, status: 503, error: String(e?.message || e).slice(0, 200) }; }
    },
    async ownerMode(id, mode, identity = 'loopback') {
      if (auth() !== 'central') return { ok: false, status: 409, error: LEGACY_REFUSAL };
      if (mode !== 'pin') return { ok: false, status: 400, error: 'mode must be pin (downgrade only)' };
      const svc = getService(); if (!svc?.setMode) return { ok: false, status: 503, error: notReady.error };
      try { const r = await svc.setMode({ id, mode, by: ownerBy(identity), owner: true, identity }); return r?.ok === false ? { ok: false, status: r.code === 'E_NOT_FOUND' ? 404 : r.code === 'E_INVALID' ? 400 : 502, error: r.error || r.code } : { ok: true, ...(r || {}) }; }
      catch (e) { return { ok: false, status: 503, error: String(e?.message || e).slice(0, 200) }; }
    },
    // session liveness and STATUS into the service (central only; legacy: nothing)
    // opts.immediate: the name came back as a different tmux session, so the old one's leases go at once instead of after the grace
    async sessionGone(name, opts) { if (auth() !== 'central') return false; try { await getService()?.sessionGone?.(`codebox:${name}`, opts); return true; } catch { return false; } },
    // `text`: the STATUS text, so the service can tell "waiting on my own script on this device" from "waiting on something else"
    async sessionStatus(name, status, text = '') { if (auth() !== 'central') return false; try { await getService()?.sessionStatus?.(`codebox:${name}`, status, text); return true; } catch { return false; } },
    // control activity of a codebox session (a working turn, a recent turn end) resets the idle clock of the exclusive leases it holds
    // `session` is the lease's own session / agent string (`codebox:<x>` as the holder wrote it), not a resolved tmux name; a bare name gets the prefix
    async activity(session) { if (auth() !== 'central') return 0; try { const r = await getService()?.activity?.(String(session).includes(':') ? String(session) : `codebox:${session}`); return r?.touched ?? 0; } catch { return 0; } },
  };
}

// Which tmux sessions vanished since the last tick -> sessionGone for each (central). The first tick only learns the set
// (no sessionGone before the first successful listing). `sessions`: Map name -> token (tmux #{session_created}); a name that
// came back with another token is a different session: the old one is gone, it must not inherit its leases.
export function createSessionTracker({ source, isListOk = () => true } = {}) {
  let prev = null;
  return {
    async observe(sessions) {
      if (!isListOk()) return [];   // never judge sessions gone from a failed tmux listing
      const cur = sessions instanceof Map ? sessions : new Map([...sessions].map((n) => [n, null]));
      const replaced = (n, t) => cur.has(n) && t != null && cur.get(n) != null && cur.get(n) !== t;
      const gone = prev ? [...prev].filter(([n, t]) => !cur.has(n) || replaced(n, t)) : [];
      prev = cur;
      for (const [n, t] of gone) await source.sessionGone(n, replaced(n, t) ? { immediate: true } : undefined);
      return gone.map(([n]) => n);
    },
  };
}

// STATUS of a stop -> service (central) / feed flag (legacy). Only waiting / blocked matter.
export const WAITING_STATUS = /^(?:waiting|blocked)$/;

// A `pin_overlap` event (about the pin: id, env, resources, agent; by_lease = the exclusive lease that was granted over it) -> the line for that
// deploy's log, when the granting lease is a deploy's (view.leases carry deployId). null otherwise.
export function pinOverrideNote(ev, view) {
  if (String(ev?.kind || '').replace(/_/g, '-') !== 'pin-overlap' || !ev.by_lease) return null;
  const by = (view?.leases || []).find((l) => l.id === ev.by_lease);
  if (!by?.deployId) return null;
  const where = `${ev.env ? `${ev.env}/` : ''}${asList(ev.resources).join(',') || '*'}`;
  return { deployId: by.deployId, line: `pin overridden: ${where} pinned by ${ev.agent || '?'} (lease ${ev.id || '?'})` };
}

// --- service events -> feed records, and the one-line note to a codebox session ---------------------------------------------
const EVENT_KIND = /^(downgraded|pin[-_]?overlap|yield)$/i;
export const isNoteEvent = (ev) => EVENT_KIND.test(String(ev?.kind || ev?.event || ''));
const where = (ev) => `${ev.env ? `${ev.env}/` : ''}${asList(ev.resources ?? ev.resource).join(',') || '*'}`;
export function eventRecord(ev) {
  const kind = String(ev?.kind || ev?.event || '').toLowerCase().replace(/_/g, '-');
  if (!kind || kind === 'granted' || kind === 'ticket') return null;
  const w = where(ev);
  const title = kind === 'released' ? `lease released: ${w} (${ev.agent || '?'})` : kind === 'expired' ? `lease expired: ${w} (${ev.agent || '?'})`
    : kind === 'downgraded' ? `lease became a pin: ${w} (${ev.agent || '?'})` : kind === 'forced' ? `lease force-released: ${w} (${ev.agent || '?'})`
    : kind === 'narrowed' ? `lease narrowed to host: ${w} (${ev.agent || '?'})` : kind === 'yield' ? `lease:yield ${ev.priority || 'P2'} holder must release: ${w} (${ev.agent || '?'})` : `lease ${kind}: ${w} (${ev.agent || '?'})`;
  const key = kind === 'pin-overlap' ? 'lease:pin-overlap' : `lease:${kind}`;
  return { key, title, body: `lease ${ev.id || ev.lease || '?'}${ev.by ? ` by ${ev.by}` : ''}${ev.reason ? ` (${ev.reason})` : ''}; purpose: ${ev.purpose || '-'}`, url: '/?leases=1', priority: 'default',
    at: new Date(tms(ev.at) || Date.now()).toISOString(), leaseId: ev.id || ev.lease, agent: ev.agent, env: ev.env, resources: asList(ev.resources ?? ev.resource) };
}
// the one line a session gets; null for events that need no note
export function eventNote(ev) {
  const kind = String(ev?.kind || ev?.event || '').toLowerCase().replace(/_/g, '-');
  const w = where(ev);
  if (kind === 'downgraded') return `Your exclusive lease on ${w} became a pin (${ev.reason || 'no control activity for 20 min'}). Claim again with vpt-lease claim ... --wait when you drive it.`;
  if (kind === 'yield') return `Your ${ev.priority || 'P2'} lease ${ev.id || ''} on ${w} cannot be renewed: a claim of higher or equal priority is waiting. Stop at the next turn boundary and release it (vpt-lease release ${ev.id || '<id>'}); claim again with --wait when you need it.`;
  if (kind === 'pin-overlap') return `Someone else was granted an exclusive lease that overlaps your pin on ${w}${ev.by_agent || ev.by || ev.holder ? ` (${ev.by_agent || ev.by || ev.holder})` : ''}. Your pin does not block them; claim again with vpt-lease claim ... --wait if you need to drive it.`;
  return null;
}
// the codebox session an event is about, or null (`resolve(agent)` maps an agent id to a live session name)
export const eventSession = (ev, resolve) => { const a = ev?.session || ev?.agent; return a ? resolve(a) || null : null; };
// a session may get the note only when it is stopped on a finished turn with nothing typed: a live menu would take free text as an answer
export function noteAllowed(st) {
  if (!st || st.state !== 'done') return false;
  const s = st.stall || {};
  return !s.draft && !(s.options?.length);
}

// Liveness for the service (sessions.isAlive / sessions.trackable). `resolve(session)` maps a holder string (`codebox:<x>`) to a live tmux session
// with the tolerant matcher the rest of the dashboard uses, or null. true = resolves now; false ONLY for a holder this process has seen alive and
// no longer sees; undefined (never releases anything) for everything else: a never-seen name, a cron script with no session, a failed listing.
// `maybe(session)`: some session could still be the holder (an ambiguous name): then the answer is "unknown", never "gone".
export function createLiveness({ resolve, ready = () => true, maybe = () => false } = {}) {
  const seen = new Set();
  return {
    isAlive(session) {
      if (!ready()) return undefined;
      if (resolve(session)) { if (seen.size > 2000) seen.clear(); seen.add(session); return true; }
      if (!seen.has(session)) return undefined;
      return maybe(session) ? undefined : false;
    },
    trackable: (session) => !!ready() && !!resolve(session),
  };
}

// Exclusive leases a codebox session holds that its activity keeps alive: the session works now, or finished a turn within `windowMs`.
export function activeHolds({ leases, sessionOf, activityOf, now, windowMs = 120000 }) {
  const by = new Map();
  for (const l of leases || []) {
    if (l.mode !== 'exclusive') continue;
    const s = sessionOf(l);
    if (!s) continue;
    const a = activityOf(s);
    if (!a || !(a.working || (a.turnAt && now - a.turnAt <= windowMs) || (a.promptAt && now - a.promptAt <= windowMs))) continue;
    const key = l.session || l.agent;   // what the service knows the holder as
    by.set(key, [...(by.get(key) || []), l.id]);
  }
  return by;
}
