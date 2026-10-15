// Intake for stops from other machines (round 9 item 1, docs/MAC-HOOK.md): the Claude Code `Stop` hook on the Mac posts the session's final
// message here, the SAME manager that watches the tmux sessions decides (stall rules, round 7/8/10 policy, countdown / cancel), and the
// hook long-polls for the answer. Routes (never public: tailnet / loopback address allowlist + bearer token of a `remote: true` client):
//   POST /api/remote/v1/stops               { machine, project, session_id, session_name?, cwd?, text, status_line?, options?, at?, stop_hook_active?,
//                                             remote_control_url?, prompt_at? } -> { ok, id, session, wait_max_s, answerable }
//   GET  /api/remote/v1/stops/<id>/answer?wait=<s>   long-poll -> { ok, state: pending|answered|none, answer?, reason? }
// Answer channel (justified in docs/MAC-HOOK.md): the hook's own long-poll, returning {"decision":"block","reason":<answer>} to Claude Code.
// The session shows on the dashboard as `mac:<session_name>`; manager.js treats it like any other session (s.remote = true, no tmux).
import fs from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CIDRS, parseCidrs, addrAllowed, readClients, clientOf, callerIdentity, readBody } from './lease-routes.js';

export const PREFIX = '/api/remote/v1';
export const MAX_BODY = 64 * 1024;
export const MAX_TEXT = 12000;                  // the tail of the final message is what matters (the question, STATUS line, options)
export const DEFAULT_WAIT_S = 45;
export const HARD_WAIT_S = 120;
const SESSION_TTL_MS = 12 * 3600e3;
const STOP_TTL_MS = 3600e3;
const RATE_PER_MIN = 30;
// Names are slugged, never rejected: "[TASK72] fix", "_proj" and non-ASCII titles arrive as they are typed on the Mac.
export const slugName = (s, fallback) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || fallback;
const GRACE_MS = 4000;          // a hook that polled and got "pending" is back within about a second; later than this it is gone
const POLL_WAIT_MS = 2500;      // an answer ready between two polls waits this long for the hook to come back
const MARGIN_MS = 5000;         // the countdown ends this long before the hook's deadline
export const HOOK_LOST = 'the Mac hook stopped waiting before the answer';
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const slug = (s) => String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
const tms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// -> { ok: true, v } | { ok: false, error }. Everything bounded; nothing here is trusted.
export function validateStop(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'body must be an object' };
  const str = (k, max, req = false) => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return req ? Error(`${k} is required`) : undefined;
    if (typeof v !== 'string' || v.length > max) return Error(`${k} must be a string of at most ${max} characters`);
    return clean(v);
  };
  const out = {};
  for (const [k, max, req] of [['machine', 80, true], ['project', 80], ['session_id', 80, true], ['session_name', 80], ['cwd', 300], ['status_line', 300], ['remote_control_url', 300]]) {
    const v = str(k, max, req);
    if (v instanceof Error) return { ok: false, error: v.message };
    if (v !== undefined) out[k] = v;
  }
  out.machine = slugName(out.machine, 'unknown-machine');
  if (out.project) out.project = slugName(out.project, 'unknown');
  if (out.session_name) { out.session_name = slugName(out.session_name, ''); if (!out.session_name) delete out.session_name; }
  if (typeof b.text !== 'string' || !b.text.trim()) return { ok: false, error: 'text is required' };
  out.text = clean(b.text).slice(-MAX_TEXT);
  if (out.remote_control_url && !/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(out.remote_control_url)) delete out.remote_control_url;
  if (b.options !== undefined) {
    if (!Array.isArray(b.options) || b.options.length > 12) return { ok: false, error: 'options must be a list of at most 12' };
    out.options = b.options.map((o, i) => ({ n: Number.isInteger(o?.n) ? o.n : i + 1, text: clean(String(o?.text ?? '')).slice(0, 200), recommended: o?.recommended === true })).filter((o) => o.text);
  }
  out.stop_hook_active = b.stop_hook_active === true;
  const at = b.at ? tms(b.at) : null;
  out.at = at != null && Math.abs(at - now) < 10 * 60e3 ? at : now;   // the Mac's clock is only believed when close to ours
  const pa = b.prompt_at ? tms(b.prompt_at) : null;
  if (pa != null && pa <= now + 60e3) out.prompt_at = pa;
  out.project = out.project || 'unknown';
  return { ok: true, v: out };
}

// the text the stall rules read: the final message, the STATUS line when it is not in it, and the options as a menu when the text has none
export function stopText(v) {
  let t = v.text.replace(/\s+$/, '');
  if (v.status_line && !t.includes(v.status_line.trim())) t += `\n${v.status_line.trim()}`;
  if (v.options?.length >= 2 && !/^\s*\d+[.)]\s+\S/m.test(t)) t += `\n${v.options.map((o) => `  ${o.n}. ${o.text}${o.recommended && !/recommended/i.test(o.text) ? ' (recommended)' : ''}`).join('\n')}`;
  return t;
}

// manager: { observe, sessionOn, setRemoteHooks, cancelAuto, forget, stallOf, triageOf, autoOf, REMOTE_PREFIX }
export function createRemoteStops({ manager, dir, stateDir, cidrs = process.env.LEASE_ALLOW_CIDRS, viaServe = () => false, now = Date.now, graceMs = GRACE_MS, pollWaitMs = POLL_WAIT_MS } = {}) {
  const allow = parseCidrs([...DEFAULT_CIDRS, ...String(cidrs || '').split(',')].join(','));
  const clientsFile = join(dir, 'clients.json');
  const configFile = join(stateDir, 'remote.json');   // { waitS, checkouts: { "<project>": "/abs/path/of/the/local/checkout" } }
  let ccache = { key: '', clients: [] };
  const clients = () => {
    try { const st = fs.statSync(clientsFile); const key = `${st.mtimeMs}:${st.size}`; if (key !== ccache.key) ccache = { key, clients: readClients(clientsFile) }; } catch { ccache = { key: '', clients: [] }; }
    return ccache.clients;
  };
  const config = () => {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}; } catch { /* no file = defaults */ }
    const waitS = Math.min(HARD_WAIT_S, Math.max(1, Number(j.waitS) || DEFAULT_WAIT_S));
    return { waitS, checkouts: j.checkouts && typeof j.checkouts === 'object' ? j.checkouts : {} };
  };
  const checkoutOf = (project) => {
    const p = config().checkouts[project];
    try { return typeof p === 'string' && isAbsolute(p) && fs.statSync(p).isDirectory() ? p : null; } catch { return null; }
  };

  const sessions = new Map();   // name -> { name, machine, project, sessionId, client, lastSeen, open: stop|null, last: stop|null, lastSendAt, lastSendText, rcUrl }
  const stops = new Map();      // id -> stop (kept an hour)
  const byMid = new Map();      // the manager's pending id -> stop: every hook call is tied to its stop by this id
  const rate = new Map();       // client -> [ms]

  // ---- stop lifecycle ----
  const resolve = (stop, state, extra = {}) => {
    if (!stop || stop.state !== 'pending') return false;
    Object.assign(stop, { state, resolvedAt: now(), ...extra });
    clearTimeout(stop.grace);
    for (const w of stop.waiters) w();
    stop.waiters.clear();
    return true;
  };
  const answerOf = (stop) => (stop.state === 'answered' ? { ok: true, state: 'answered', answer: stop.answer } : { ok: true, state: stop.state, ...(stop.reason ? { reason: stop.reason } : {}) });
  // wait for the stop to resolve, `ms` to pass, or `signal.aborted` (the poll's connection closed)
  const waitFor = (stop, ms, signal) => new Promise((res) => {
    if (stop.state !== 'pending' || ms <= 0 || signal?.aborted) return res();
    const done = () => { clearTimeout(t); stop.waiters.delete(done); res(); };
    const t = setTimeout(done, ms);
    stop.waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
  // The hook is gone while an answer may still be pending: the stop is resolved without an answer and the manager escalates it to the owner.
  // Escalates only when the manager holds an answer for this stop (or `force`): a stop it is still deciding reaches the owner through schedule().
  const lost = (stop, reason = HOOK_LOST, force = false) => {
    if (!stop || stop.state !== 'pending') return;
    stop.hookGone = true;
    resolve(stop, 'none', { reason });
    if (force || manager.autoOf(stop.name)?.id === stop.managerId) manager.hookLost(stop.name, stop.managerId, reason);
  };
  // a hook that is not polling must come back soon; nothing pending longer than graceMs without an open poll means it is gone
  const armGrace = (stop) => { clearTimeout(stop.grace); if (stop.state === 'pending') { stop.grace = setTimeout(() => { if (!stop.openPolls) lost(stop); }, graceMs); stop.grace.unref?.(); } };

  const stopOf = (mid) => (mid ? byMid.get(mid) || null : null);
  manager.setRemoteHooks({
    // observe's decision step finished: nothing scheduled = no answer is coming (escalated to the owner, or nothing to answer)
    settled: (_name, mid, hasAuto) => { const st = stopOf(mid); if (st && !hasAuto) resolve(st, 'none', { reason: st.needsOwner ? 'escalated to the owner' : 'no answer needed' }); },
    cancelled: (_name, reason, mid) => { const st = stopOf(mid); if (st) resolve(st, 'none', { reason: String(reason || 'cancelled').slice(0, 200) }); },
    escalated: (_name, mid, reason) => { const st = stopOf(mid); if (st) { st.needsOwner = true; st.why = String(reason || '').slice(0, 300); } },
    noAnswer: (name) => !!sessions.get(name)?.open?.noAnswer,
    // ms the countdown may run, counted from now: until the hook's deadline minus a margin; <= 0 = no time left (or the hook is gone)
    maxDelayMs: (_name, mid) => { const st = stopOf(mid); if (!st) return null; return st.hookGone ? 0 : st.deadline - now() - MARGIN_MS; },
  });

  // The manager's send path for a `mac:` session lands here (server.js guardSendKeys / guardSendKey): the answer rides the hook's long-poll.
  // Delivered only to a hook that is polling; between two polls it waits a moment, and a hook that is gone makes the stop an owner stop.
  async function deliver(name, text, mid = null) {
    const s = sessions.get(name);
    const st = mid ? stopOf(mid) : s?.open;
    if (!s || !st || st.name !== name || st.state !== 'pending') throw new Error('the Stop hook is no longer waiting for an answer');
    for (const end = now() + pollWaitMs; st.state === 'pending' && !st.openPolls && now() < end;) await waitFor(st, end - now());   // a poll opening wakes this
    if (st.state !== 'pending') throw new Error('the Stop hook is no longer waiting for an answer');
    if (!st.openPolls) { lost(st, HOOK_LOST, true); throw new Error(HOOK_LOST); }
    s.lastSendAt = now(); s.lastSendText = String(text).slice(0, 300);
    resolve(st, 'answered', { answer: String(text).slice(0, 2000) });
    return { ok: true };
  }
  const deliverKey = (name, key, mid = null) => deliver(name, `Go with option ${String(key).slice(0, 8)}.`, mid);

  function ingest(v, client) {
    const t = now();
    // the title plus a fragment of the session id: two Mac sessions with the same title never share a row
    let name = `${manager.REMOTE_PREFIX}${slug(v.session_name || v.project)}-${slug(v.session_id.slice(0, 6))}`;
    const prev0 = sessions.get(name);
    if (prev0 && prev0.machine !== v.machine) name = `${name}@${slug(v.machine)}`;   // two machines using the same session name stay apart
    let s = sessions.get(name);
    const first = !s;
    if (!s) { s = { name, machine: v.machine, project: v.project, sessionId: v.session_id, client: client.name, open: null, last: null, lastSendAt: null, lastSendText: null }; sessions.set(name, s); }
    Object.assign(s, { project: v.project, lastSeen: t, client: client.name, rcUrl: v.remote_control_url || null, cwd: v.cwd || null });
    // Only the deploy topic is evaluated for a Mac session (it reads origin); merge and push escalate in manager.js (remote block). A project without a
    // configured local checkout gets a path that does not exist, so every evaluation finds no repository and escalates.
    const cwd = checkoutOf(v.project) || join(stateDir, 'remote-no-checkout');
    const base = { name, agent: 'claude', project: v.project, cwd, now: t, remote: true, machine: v.machine };

    if (s.open) resolve(s.open, 'none', { reason: 'superseded by a newer stop' });
    if (!first) {
      // the session ran again since its last stop: settle the outcome of that stop (owner reply / manager answer) like a local session
      const prevAt = s.last?.at || 0;
      const answeredAt = v.prompt_at && v.prompt_at >= prevAt ? v.prompt_at : t;
      manager.observe({ ...base, state: 'working', plain: [], raw: [], changed: true, realWork: true, lastSendAt: Math.max(s.lastSendAt || 0, v.prompt_at && v.prompt_at > prevAt ? v.prompt_at : 0) || null, lastSendText: s.lastSendText, answeredAt, rep: null });
    }
    const prevMid = manager.pendingIdOf(name);
    const id = randomUUID();
    const text = stopText(v);
    const stop = { id, name, client: client.name, at: v.at, postedAt: t, text, state: 'pending', answer: null, reason: null, waiters: new Set(), openPolls: 0, grace: null, hookGone: false, managerId: null, needsOwner: false, noAnswer: v.stop_hook_active, deadline: t + config().waitS * 1000, statusLine: v.status_line || null };
    stops.set(id, stop);
    for (const [k, o] of stops) { if (t - o.postedAt > STOP_TTL_MS) { stops.delete(k); if (o.managerId) byMid.delete(o.managerId); } else break; }
    s.open = stop; s.last = stop;
    armGrace(stop);
    if (!manager.sessionOn(name)) { resolve(stop, 'none', { reason: 'manager disabled for this session' }); }
    const lines = text.split('\n');
    const turn = { text, at: t, reason: 'end_turn', backgroundWork: 0 };
    manager.observe({ ...base, state: 'done', plain: lines, raw: [], changed: true, realWork: false, lastSendAt: s.lastSendAt, lastSendText: s.lastSendText, rep: { turnForStop: () => turn, promptSince: () => null } });
    const mid = manager.pendingIdOf(name);   // the manager's id for this stop, set synchronously by observe
    if (mid && mid !== prevMid) { stop.managerId = mid; byMid.set(mid, stop); }
    if (stop.noAnswer && stop.state === 'pending') stop.why = 'stop_hook_active: never answered automatically';
    return { id, name, answerable: !stop.noAnswer, wait_max_s: config().waitS };
  }

  // ---- dashboard rows (no tmux) ----
  function sweep() {
    const t = now();
    for (const [name, s] of sessions) if (t - s.lastSeen > SESSION_TTL_MS) { if (s.open) resolve(s.open, 'none', { reason: 'session gone' }); sessions.delete(name); manager.forget(name); }
  }
  const names = () => { sweep(); return [...sessions.keys()]; };
  function statusRows() {
    sweep();
    const t = now(), rows = {};
    for (const s of sessions.values()) {
      const open = s.open;
      const stall = manager.stallOf(s.name);
      rows[s.name] = {
        state: 'done', agent: 'claude', agentCmd: 'claude', waitReason: null, stall, triage: manager.triageOf(s.name), auto: manager.autoOf(s.name), handoffs: [],
        lastActivitySec: Math.max(0, Math.round((t - s.lastSeen) / 1000)), lastSendAt: s.lastSendAt, lastSendAck: null, workingSinceMs: null, doneAt: s.last?.postedAt || null,
        activity: null, lastMessage: (s.last?.text || '').split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(0, 300) || null, lastTurn: null, replyHash: null,
        cwd: s.cwd, repo: null, branch: null, dirty: null, project: s.project, github: false, worktree: null, contextLeft: null, model: null,
        lease: null, deployWait: null, cols: 0, rows: 0, attached: false, windows: 0, cmd: 'claude',
        remote: { machine: s.machine, waiting: !!open && open.state === 'pending', answered: s.last?.state === 'answered', needsOwner: !!s.last?.needsOwner, remoteControlUrl: s.rcUrl, stopAt: s.last?.at || null },
      };
    }
    return rows;
  }

  // ---- HTTP ----
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const rateOk = (client) => {
    const t = now(), a = (rate.get(client) || []).filter((x) => t - x < 60e3);
    if (a.length >= RATE_PER_MIN) { rate.set(client, a); return false; }
    a.push(t); rate.set(client, a); return true;
  };
  // -> true when the request belonged to the remote API (and has been answered)
  async function handle(req, res) {
    const url = new URL(req.url, 'http://remote.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!addrAllowed(req.socket?.remoteAddress, allow)) { send(res, 403, { ok: false, code: 'E_AUTH', error: 'source address not allowed' }); return true; }
    const auth = /^Bearer\s+(\S{8,512})$/i.exec(req.headers.authorization || '');
    const client = auth ? clientOf(clients(), auth[1]) : null;
    if (!client) { send(res, 401, { ok: false, code: 'E_AUTH', error: 'missing or invalid bearer token' }); return true; }
    if (!client.remote) { send(res, 403, { ok: false, code: 'E_AUTH', error: 'this client may not post remote stops (lease-token.js add <name> --remote)' }); return true; }
    const sub = url.pathname.slice(PREFIX.length) || '/';
    let served = false;
    try { served = !!viaServe(req); } catch { /* not served */ }
    const who = callerIdentity({ login: req.headers['tailscale-user-login'], viaServe: served, remoteAddress: req.socket?.remoteAddress, client: client.name });
    if (req.method === 'POST' && sub === '/stops') {
      let body;
      try { body = await readBody(req, MAX_BODY); } catch (e) { send(res, e.status || 400, { ok: false, code: 'E_INVALID', error: e.message }); return true; }
      if (!rateOk(client.name)) { send(res, 429, { ok: false, code: 'E_RATE', error: 'too many stops per minute' }); return true; }
      const v = validateStop(body, now());
      if (!v.ok) { send(res, 400, { ok: false, code: 'E_INVALID', error: v.error }); return true; }
      let r;
      try { r = ingest(v.v, client); } catch (e) { console.error('[remote] ingest', who, e.message); send(res, 500, { ok: false, code: 'E_UNAVAILABLE', error: 'could not process the stop' }); return true; }
      send(res, 200, { ok: true, id: r.id, session: r.name, wait_max_s: r.wait_max_s, answerable: r.answerable });
      return true;
    }
    const m = /^\/stops\/([0-9a-f-]{36})\/answer$/.exec(sub);
    if (req.method === 'GET' && m) {
      const stop = stops.get(m[1]);
      if (!stop || stop.client !== client.name) { send(res, 404, { ok: false, code: 'E_NOT_FOUND', error: 'unknown stop' }); return true; }
      if (stop.state === 'pending') {
        const asked = Number(url.searchParams.get('wait'));
        const want = Number.isFinite(asked) && asked > 0 ? Math.min(asked, HARD_WAIT_S) * 1000 : 0;
        // an open poll is the hook waiting; if its connection closes first, the hook stopped waiting
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        stop.openPolls += 1; clearTimeout(stop.grace);
        for (const w of [...stop.waiters]) w();   // wakes an answer that was waiting for the hook to come back
        try { await waitFor(stop, Math.min(want, Math.max(0, stop.deadline - now())), ac.signal); }
        finally { stop.openPolls -= 1; }
        if (ac.signal.aborted) { lost(stop); return true; }
        if (stop.state === 'pending' && now() >= stop.deadline - 50) lost(stop);   // the deadline passed with a pending answer: the owner gets it
        else armGrace(stop);
      }
      send(res, 200, answerOf(stop));
      return true;
    }
    const known = sub === '/stops' || /^\/stops\/[^/]+\/answer$/.test(sub);
    send(res, known ? 405 : 404, { ok: false, code: known ? 'E_INVALID' : 'E_NOT_FOUND', error: known ? 'method not allowed' : 'no such route' });
    return true;
  }
  return { handle, deliver, deliverKey, owns: (n) => String(n).startsWith(manager.REMOTE_PREFIX) && sessions.has(n), names, statusRows, config, _sessions: sessions };
}
