// Wake sessions when their own job ends (round 9, item 11). A session that ends its turn with `STATUS: blocked|waiting: <its own long job>`
// (a pid, a log file, a run id, a deploy id, or just "waiting on the final score_matrix run") is not asking the owner anything; nothing
// would wake it when the job finishes. The manager identifies the job, watches it and, when it ends, types "your <job> finished at <time>,
// continue" into the session (text, then Enter as a separate tmux call: server.js sendKeys pastes, waits, then sends Enter).
//   (a) a deploy id        -> the deploy runner's queue state
//   (b) a pid in the line, or the child processes of the pane's agent (other than the agent itself) -> /proc/<pid>
//   (c) a log file in the line -> its mtime stops changing for `stableMin` minutes (sooner when a completion marker is in its tail)
// A job started detached (nohup, setsid, disown, a trailing &) cannot be seen by the harness: the session is flagged in the feed.
import { stat, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { sensitivePath } from './merge-policy.js';
import { jobRefs, hasRef, waitsOnOwnJob, DETACHED_RE } from './job-refs.js';
import { integrationText, isFinal, normRequest } from './integration-notify.js';
import { waitIds, runState } from './wait-ids.js';
import { forbiddenMatch } from './stall.js';
export { jobRefs, hasRef, waitsOnOwnJob };

// Descendants of `pid` in a ps table { children: Map<ppid, pid[]>, args: Map<pid, string> }, nearest first, the agent itself excluded.
export function descendants(pid, table, limit = 40) {
  const out = [], seen = new Set([pid]);
  let level = [pid];
  for (let depth = 0; level.length && depth < 6 && out.length < limit; depth++) {
    const next = [];
    for (const p of level) for (const c of table.children?.get(p) || []) { if (seen.has(c)) continue; seen.add(c); out.push(c); next.push(c); }
    level = next;
  }
  return out;
}
// A shell or a short-lived helper the agent's own tools run is not "the job": only children whose command line is not a bare shell / sleep / ps.
// The agent runtime's own permanent process-group guard is infrastructure, not session work: minimax-code spawns
// `node --input-type=module --eval` at startup to kill its group when it disconnects, and a STATUS word that happens to sit inside that
// command line ("live" in "keepalive", "table" in "system32") pinned the session to `running` for ever (2026-11-13, bug-d2023d2f).
// An inline node module is the node twin of the `node -e` helper above: it is a script the runtime wrote, never the session's job.
const HELPER_RE = /^(?:\S*\/)?(?:bash|zsh|sh|fish|dash|sleep|ps|tmux|cat|tail|head|grep|git|node -e|node --input-type=module --eval|python3? -c)(?:\s|$)/;
export const jobPids = (pid, table) => descendants(pid, table).filter((c) => !HELPER_RE.test(String(table.args?.get(c) || '').trim()));

const COMPLETION_RE = /\b(?:done|finished|complete[d]?|all (?:tests )?passed|exit(?:ed)?(?: code)? \d+|exit status \d+|Traceback \(most recent|error summary|\d+ passed|saved to)\b/i;
const GENERIC_WORDS = new Set(['waiting', 'blocked', 'final', 'run', 'runs', 'job', 'jobs', 'process', 'finish', 'finishes', 'finished', 'complete', 'completes', 'completed', 'running', 'progress', 'until', 'tests', 'test', 'build', 'task', 'script', 'with', 'that', 'this', 'from', 'then', 'before', 'after', 'done', 'still', 'status', 'ends', 'end']);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

// ---- Parked-session wake (harness review 2026-11-11, Q5 item 5; docs/REFERENCE.md "Parked-session wake") ----
// A stop on STATUS blocked / waiting that the own-job watch does not follow is "parked": what its line names is read at park time and re-read
// every parkPollMs; one wake when a dependency changed (and still holds after the grace) or at the stop's maximum age.
const INT_IDS = /\bint-[0-9a-z]{6,40}\b/gi;
const BUG_IDS = /\bbug-[0-9a-f]{8}\b/gi;
const HOST_DEVICE = /\b([a-z][a-z0-9-]*[a-z0-9])\/(device\d+)\b/gi;
const AT_TIME = /\b(?:until|after|from)\s+~?(\d{1,2}):(\d{2})\s*UTC\b/i;
// the done-line tail (`bugs: reported bug-x`, `closing review: ...`) names what was filed, not what the session waits on
export const dependencyText = (text) => String(text || '').split(/\s[·|]\s|\bbugs?:|\bclosing review:/i)[0];
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pure. STATUS text (+ the lease view, for the resource names it knows) -> [{ kind, id, label }].
export function parkedDeps(text, view = null, { now = Date.now() } = {}) {
  const t = dependencyText(text), deps = [], seen = new Set();
  const add = (kind, id, label) => { const k = `${kind}:${id}`; if (id && !seen.has(k)) { seen.add(k); deps.push({ kind, id, label }); } };
  for (const m of t.matchAll(INT_IDS)) add('integration', m[0].toLowerCase(), `integration ${m[0]}`);
  const w = waitIds(t);
  if (w.ticket) add('ticket', w.ticket, `lease ticket ${w.ticket}`);
  if (w.lease) add('lease', w.lease, `lease ${w.lease}`);
  if (w.script) add('script', w.script, `run ${w.script}`);
  const r = jobRefs(t);
  if (r.deploy) add('deploy', r.deploy, `queue entry ${r.deploy}`);
  for (const m of t.matchAll(BUG_IDS)) add('bug', m[0].toLowerCase(), m[0].toLowerCase());
  for (const m of t.matchAll(HOST_DEVICE)) add('resource', `${m[1]}/${m[2]}`.toLowerCase(), `${m[1]}/${m[2]}`);
  const known = new Set([...(view?.leases || []), ...(view?.tickets || [])].flatMap((x) => x.resources || []).filter((x) => x && x.length >= 4 && !['*', 'server', 'frontend'].includes(x)));
  for (const res of known) if (new RegExp(`(?:^|[^\\w/-])${esc(res)}(?![\\w/-])`, 'i').test(t)) add('resource', res.toLowerCase(), res);
  const at = AT_TIME.exec(t);
  if (at && Number(at[1]) < 24) { const d = new Date(now); d.setUTCHours(Number(at[1]), Number(at[2]), 0, 0); let ms = d.getTime(); if (ms < now - 3600e3) ms += 86400e3; add('time', String(ms), `${at[1].padStart(2, '0')}:${at[2]} UTC`); }
  return deps;
}

// Pure. May a STATUS blocked / waiting stop be parked? Never with an open owner ask, never on a hard-floor status; a forbidden-topic status only
// when it names a system id (integration, ticket, lease, run, queue entry, bug): then its words describe a queue, not an ask.
const SYSTEM_DEPS = new Set(['integration', 'ticket', 'lease', 'script', 'deploy', 'bug']);
export function parkGate(text, { openAsk = false, floor = () => null, forbidden = () => null } = {}) {
  const t = dependencyText(text);
  if (openAsk) return { ok: false, why: 'open owner ask' };
  const f = floor(t);
  if (f) return { ok: false, why: `hard floor: ${f}` };
  const fb = forbidden(t);
  if (fb && !parkedDeps(t).some((d) => SYSTEM_DEPS.has(d.kind))) return { ok: false, why: `forbidden topic: ${fb}` };
  return { ok: true };
}

// Pure. Is `res` held right now by a lease that is not the session's own? A host lease blocks its devices and a device lease blocks its host.
export function resourceHeld(res, view, session = '') {
  const mine = (l) => { const who = `${l.session || ''} ${l.agent || ''}`.toLowerCase(); return !!session && who.includes(String(session).toLowerCase()); };
  const r = String(res).toLowerCase();
  return (view?.leases || []).some((l) => (l.mode || 'exclusive') === 'exclusive' && !mine(l) && (l.resources || []).some((x) => {
    const y = String(x).toLowerCase();
    return y === r || r.startsWith(`${y}/`) || y.startsWith(`${r}/`);
  }));
}

// Grant notice (owner 2026-11-11: mobile-orchtnet-owner held lease 1a79f027 for 30 min without knowing its ticket was granted).
// Pure. A ticket that left the queue -> the session's own lease on the ticket's resources (the grant), or null. `res`: the ticket's resources
// read at park time; `since`: ms of the park (a lease the session already held before is not this grant).
export function grantOf(view, session, { res = [], since = 0 } = {}) {
  const s = String(session || '').toLowerCase();
  if (!s) return null;
  const mine = (l) => `${l.session || ''} ${l.agent || ''}`.toLowerCase().split(/[\s:]+/).includes(s);
  const want = res.map((x) => String(x).toLowerCase());
  const hit = (l) => !want.length || (l.resources || []).some((x) => { const y = String(x).toLowerCase(); return want.some((w) => y === w || y.startsWith(`${w}/`) || w.startsWith(`${y}/`)); });
  const l = (view?.leases || []).filter((x) => mine(x) && hit(x) && (!x.sinceMs || x.sinceMs >= since - 120e3)).sort((a, b) => (b.sinceMs || 0) - (a.sinceMs || 0))[0];
  if (!l) return null;
  const until = Number.isFinite(l.ttlLeftMin) ? Date.now() + l.ttlLeftMin * 60e3 : null;
  return { leaseId: String(l.id), resources: l.resources || [], untilMs: until };
}
export const grantText = (ticket, g, hhmmOf) => `harness: your claim ${ticket} was granted: ${(g.resources || []).join(', ') || 'the resource'}${g.untilMs ? ` until ${hhmmOf(g.untilMs)}` : ''} (lease ${g.leaseId}). It is yours now and the device sits idle: use it at once (the lease env is set by vpt-lease, check with vpt-lease validate ${g.leaseId}), release it when done. If you no longer need it, release it now.`;

// deps: { now, procRoot, table: () => ps table, agentPid: (session) => pid|null, deployState: (id) => { state, finished }|null,
//         integrationState: async (id) => lane request { state, ... } | null (GET /api/integration/requests/:id),
//         stillWaiting: (session, stopAt) => bool, send: (session, text) => Promise, record: (event) => Promise, log: (rec) => void }
// Queue-backed kinds: watched by API state (lane request / deploy queue), never by pid or log, so "detached" is meaningless for them.
const QUEUE_KINDS = new Set(['integration', 'deploy', 'script', 'lease']);

export function createOwnJobs({ now = () => Date.now(), procRoot = '/proc', table = async () => ({ children: new Map(), args: new Map() }), agentPid = async () => null,
  deployState = () => null, integrationState = async () => null, startedAt = async () => new Map(), stillWaiting = () => true, canSend = () => true, scriptRun = async () => null, leaseState = async () => null, idleMs = () => null, staleMin = 20, nudgeGapMin = 30, maxRunMin = 120, send = async () => {}, record = async () => {}, log = () => {}, stableMin = 5, maxAgeH = 12, roots = () => [],
  // parked-session wake: leaseView: async () => lease view, bugState: async (id) => 'open'|'fixed'|...|null, busy: (session) => live background work,
  // sendParked: (session, text) => Promise (by: harness), parkMode: () => 'off'|'dry'|'live'
  leaseView = async () => null, bugState = async () => null, busy = () => false, sendParked = null, parkMode = () => 'off',
  parkPollMs = 60e3, parkGraceMin = 3, parkMaxAgeMin = 180, parkPerHour = 2, grantGraceMin = 5 } = {}) {
  const watched = new Map();   // session -> { job, stopAt, since, ... }
  // a zombie is finished: /proc/<pid>/stat is "pid (comm) S ...", the state follows the last ")"
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid < 2 || !existsSync(`${procRoot}/${pid}`)) return false;
    const m = /\)\s+(\S)/.exec(readSafe(`${procRoot}/${pid}/stat`));
    return !(m && (m[1] === 'Z' || m[1] === 'X'));
  };

  async function identify(session, { text, cwd, stopAt, paneText = '' }) {
    const refs = jobRefs(text);
    const job = { text: String(text || '').slice(0, 200), refs, kind: null, pids: [], path: null, id: null, label: null };
    const detached = refs.detached || DETACHED_RE.test(String(paneText));
    if (refs.integration) { job.kind = 'integration'; job.id = refs.integration; job.label = `integration ${refs.integration}`; }
    else if (waitIds(text).script) { const id = waitIds(text).script; job.kind = 'script'; job.id = id; job.label = `run ${id}`; }
    else if (waitIds(text).ticket || waitIds(text).lease) { const w = waitIds(text); job.kind = 'lease'; job.id = w.ticket || w.lease; job.leaseKind = w.ticket ? 'ticket' : 'lease'; job.label = `lease ${w.ticket ? 'ticket' : 'id'} ${job.id}`; }
    else if (refs.deploy) { job.kind = 'deploy'; job.id = refs.deploy; job.label = `deploy ${refs.deploy}`; }
    // A bg_<id> handle is the agent harness's OWN background task (mcode "Tasks", claude bg_ jobs). The harness that
    // started it wakes the session when it ends, so ghosty has neither a pid nor a log to watch and must not flag it:
    // "the harness cannot see it" was wrong, it is the harness that owns it. Recognised here so the flag is not raised.
    else if (refs.watcher) { job.kind = 'task'; job.id = refs.watcher; job.harnessOwned = true; job.label = `harness task ${refs.watcher}`; job.detached = false; }
    else if (refs.pid) { job.kind = 'pid'; job.pids = [refs.pid]; job.label = `job (pid ${refs.pid})`; }
    else if (refs.path) {
      const abs = isAbsolute(refs.path) ? refs.path : refs.path.startsWith('~/') ? resolve(homedir(), refs.path.slice(2)) : resolve(cwd || '.', refs.path);
      const ok = !sensitivePath(abs) && [cwd, tmpdir(), '/tmp', homedir(), ...roots()].filter(Boolean).some((r) => abs === resolve(r) || abs.startsWith(resolve(r) + sep));
      if (ok && !/\.\.(?:\/|$)/.test(refs.path)) { job.kind = 'log'; job.path = abs; job.label = `job (log ${refs.path})`; }
    }
    if (!job.kind) {
      // a run id, or no reference at all: the child processes of the pane's agent
      const ap = await agentPid(session);
      const tb = ap ? await table() : null;
      let pids = ap && tb ? jobPids(ap, tb) : [];
      if (refs.run && tb) { const named = pids.filter((p) => String(tb.args.get(p) || '').includes(refs.run)); if (named.length) pids = named; }
      if (pids.length) { job.kind = 'tree'; job.pids = pids.slice(0, 20); job.label = refs.run ? `run ${refs.run}` : 'job'; if (tb && pids.some((p) => DETACHED_RE.test(String(tb.args.get(p) || '')))) job.detached = true; }
    }
    // a harness-owned task is never detached, even if the pane text happens to contain an ampersand or "tmux new-session -d"
    // a lane request or a deploy is a queue entry watched by API state, with no process to detach: the words nohup / setsid / "&" in the pane
    // (or in a reply that merely discusses them) do not make it a detached job
    job.detached = job.harnessOwned || QUEUE_KINDS.has(job.kind) ? false : (detached || job.detached || false);
    return job;
  }

  async function watch(session, { text, cwd = null, stopAt = now(), paneText = '' } = {}) {
    const job = await identify(session, { text, cwd, stopAt, paneText });
    const w = { job, stopAt, since: now(), seenRunning: false, lastMtime: null, stableSince: null, flagged: false };
    // a pid or a process tree counts as ended only after it was seen running: a pid that is not alive here (another host, already gone) is unseeable
    if (job.kind === 'pid' || job.kind === 'tree') { w.seenRunning = job.pids.some((p) => alive(p)); if (!w.seenRunning) { job.unseen = true; } }
    watched.set(session, w);
    parked.delete(session);   // the own-job watch follows this stop; a parked entry of an older stop is over
    if (job.kind === 'log') await stateOf(w);   // remembers the mtime now: quiet time counts from the stop, not from the first tick
    // a harness-owned task is not flaggable: the agent's own harness wakes it, and ghosty cannot see it either way
    if ((!job.kind || job.detached || job.unseen) && !job.harnessOwned) {
      w.flagged = true;
      await record({ key: `job:unseen:${session}`, title: `${session} waits on a job the harness cannot see`,
        body: job.detached ? `its job runs detached (nohup / setsid / disown / &), so the manager cannot tell when it ends: ${job.text}` : job.unseen ? `the pid named in its STATUS is not running on this host, so the manager cannot tell when the job ends: ${job.text}` : `STATUS names no pid, log or run id and the agent has no child process: ${job.text}`, url: `/?s=${encodeURIComponent(session)}`, priority: 'default' }).catch(() => {});
    }
    log({ type: 'own_job_watch', session, job: job.kind || 'unknown', label: job.label, detached: !!job.detached, harnessOwned: !!job.harnessOwned });
    return { kind: job.kind, label: job.label, detached: !!job.detached, unseen: !!job.unseen, harnessOwned: !!job.harnessOwned, pid: job.pids?.[0] ?? null };
  }
  const forget = (session) => { watched.delete(session); parked.delete(session); };
  const jobOf = (session) => watched.get(session)?.job || null;

  // -> { state: 'running'|'ended'|'unknown', at?: ms, summary }
  async function stateOf(w) {
    const j = w.job, t = now();
    if (j.kind === 'integration') {
      let r = null; try { r = await integrationState(j.id); } catch { /* the lane is unreachable: unknown, try again next tick */ }
      if (!r) return { state: 'unknown', summary: `integration ${j.id}: not found` };
      r = normRequest(r);   // lane fields -> session fields (deployScope -> deploy, endedAt -> finishedAt, ISO -> ms, live.tail -> tail while running)
      if (isFinal(r.state)) return { state: 'ended', at: Number(r.finishedAt || r.updatedAt) || t, summary: `integration ${j.id} ${r.state}`, text: integrationText(r) };
      return { state: 'running', summary: `integration ${j.id} is ${r.state}${r.step ? ` (${r.step})` : ''}` };
    }
    if (j.kind === 'script') {
      let row = null; try { row = await scriptRun(j.id); } catch { /* platform unreachable: unknown, try again next tick */ }
      const r = runState(row, { now: t, maxRunMin });
      if (r.state === 'unknown') return { state: 'unknown', summary: `run ${j.id}: not found on the platform` };
      if (r.state === 'running') return { state: 'running', summary: `run ${j.id} is ${r.status}` };
      return { state: 'ended', at: r.at || t, summary: `run ${j.id} ended ${r.status}`, text: `your run ${j.id} ended ${r.status} at ${hhmm(r.at || t)}${r.message ? ` (${r.message})` : ''}, continue` };
    }
    if (j.kind === 'lease') {
      let r = null; try { r = await leaseState(j.id, j.leaseKind); } catch { /* unknown */ }
      if (!r) return { state: 'unknown', summary: `${j.label}: not found` };
      if (r.state === 'waiting' || r.state === 'held') return { state: 'running', summary: `${j.label} is ${r.state}` };
      const what = r.state === 'granted' ? 'was granted' : r.state === 'released' ? 'was released' : r.state === 'gone' ? 'is no longer queued (granted or dropped)' : `was dropped (${r.state})`;
      return { state: 'ended', at: r.at || t, summary: `${j.label} ${what}`, text: `your ${j.label} ${what} at ${hhmm(r.at || t)}${r.leaseId ? ` (lease ${r.leaseId})` : ''}, continue` };
    }
    if (j.kind === 'deploy') {
      const d = deployState(j.id);
      if (!d) return { state: 'unknown', summary: `deploy ${j.id}: not in the queue` };
      if (['done', 'failed', 'cancelled', 'canceled', 'error'].includes(d.state)) return { state: 'ended', at: d.finished || t, summary: `deploy ${j.id} ${d.state}` };
      return { state: 'running', summary: `deploy ${j.id} is ${d.state}` };
    }
    if (j.kind === 'pid' || j.kind === 'tree') {
      const live = j.pids.filter((p) => alive(p));
      if (live.length) { w.seenRunning = true; return { state: 'running', summary: `${j.label} is still running (pid ${live.slice(0, 3).join(', ')})` }; }
      if (!w.seenRunning) return { state: 'unknown', summary: `${j.label}: never seen running` };
      return { state: 'ended', at: t, summary: `${j.label} has ended` };
    }
    if (j.kind === 'log') {
      let st; try { st = await stat(j.path); } catch { return { state: 'unknown', summary: `${j.label}: the file does not exist yet` }; }
      if (w.lastMtime !== st.mtimeMs) { w.lastMtime = st.mtimeMs; w.stableSince = t; }
      const quiet = (t - Math.max(st.mtimeMs, w.stableSince || 0)) / 60000;
      let marker = false;
      try { const fh = await open(j.path, 'r'); try { const len = Math.min(4096, st.size); const buf = Buffer.alloc(len); await fh.read(buf, 0, len, st.size - len); marker = COMPLETION_RE.test(buf.toString('utf8')); } finally { await fh.close(); } } catch { /* unreadable tail: the quiet time decides */ }
      if (quiet >= stableMin || (marker && quiet >= 1)) return { state: 'ended', at: st.mtimeMs, summary: `${j.label} stopped changing${marker ? ' and shows a completion marker' : ''}` };
      return { state: 'running', summary: `${j.label} was written ${Math.round(quiet)} min ago` };
    }
    return { state: 'unknown', summary: 'job not identified' };
  }


  // ---- parked sessions ----
  const parked = new Map();   // session -> { stopAt, since, status, text, deps: [{ ...dep, before, changedAt, change }], checkedAt }
  const parkedSent = new Map();   // session -> [ms] of parked wakes (dry ones too), for the per-hour cap
  // -> { state: 'open'|'changed'|'unknown', change? } of one dependency now. ctx caches the lease view for one sweep.
  async function depNow(d, session, ctx) {
    const t = now();
    try {
      if (d.kind === 'integration') { const r0 = await integrationState(d.id); if (!r0) return { state: 'unknown' }; const r = normRequest(r0); return isFinal(r.state) ? { state: 'changed', change: `${d.label} ended (${r.state})` } : { state: 'open', v: r.state }; }
      if (d.kind === 'deploy') { const x = deployState(d.id); if (!x) return { state: 'unknown' }; return ['done', 'failed', 'cancelled', 'canceled', 'error'].includes(x.state) ? { state: 'changed', change: `${d.label} ended (${x.state})` } : { state: 'open', v: x.state }; }
      if (d.kind === 'script') { const r = runState(await scriptRun(d.id), { now: t, maxRunMin }); return r.state === 'ended' ? { state: 'changed', change: `${d.label} ended ${r.status}` } : { state: r.state === 'running' ? 'open' : 'unknown' }; }
      if (d.kind === 'bug') { const st = await bugState(d.id); if (!st) return { state: 'unknown' }; return st !== 'open' ? { state: 'changed', change: `${d.label} was resolved (${st})` } : { state: 'open', v: st }; }
      if (d.kind === 'time') return Number(d.id) <= t ? { state: 'changed', change: `the time you named (${d.label}) has passed` } : { state: 'open' };
      ctx.view ??= await leaseView().catch(() => null);
      const v = ctx.view;
      if (!v) return { state: 'unknown' };
      if (d.kind === 'ticket') {
        const tk = (v.tickets || []).find((x) => String(x.id).toLowerCase() === d.id);
        if (!tk) {
          const g = grantOf(v, session, { res: d.res || [], since: d.parkedAt || 0 });
          return g ? { state: 'changed', grant: g, change: `${d.label} was granted` } : { state: 'changed', change: `${d.label} left the queue (granted or ended)` };
        }
        if (tk.state && tk.state !== 'waiting') return { state: 'changed', change: `${d.label} was ${tk.state}` };
        return { state: 'open', v: tk.position ?? null, first: tk.position === 1 };
      }
      if (d.kind === 'lease') return (v.leases || []).some((x) => String(x.id) === d.id) ? { state: 'open', v: 'held' } : { state: 'changed', change: `${d.label} was released` };
      if (d.kind === 'resource') return resourceHeld(d.id, v, session) ? { state: 'open', v: 'held' } : { state: 'open', v: 'free' };
    } catch { /* a source is unreachable: unknown, try again next sweep */ }
    return { state: 'unknown' };
  }
  // A resource is a change only from held (at park time) to free; a ticket only when it reaches position 1 from further back.
  function changeOf(d, s) {
    if (s.state === 'changed') return s.change;
    if (d.kind === 'resource' && d.before === 'held' && s.v === 'free') return `${d.label} is free (no lease holds it)`;
    if (d.kind === 'ticket' && s.first && Number(d.before) > 1) return `${d.label} reached position 1`;
    return null;
  }

  // park(session, { text, stopAt, status }) -> { deps, parked } . The caller (manager.js) has already applied the floor / ask gates.
  async function park(session, { text = '', stopAt, status = 'waiting' } = {}) {
    if (parkMode() === 'off') { parked.delete(session); return { parked: false, deps: [] }; }
    const ctx = {};
    ctx.view = await leaseView().catch(() => null);
    const deps = parkedDeps(text, ctx.view, { now: now() });
    for (const d of deps) {
      const s = await depNow(d, session, ctx); d.before = s.state === 'open' ? s.v : s.state; if (s.state === 'changed') d.before = 'changed';
      if (d.kind === 'ticket') { d.parkedAt = now(); d.res = ((ctx.view?.tickets || []).find((x) => String(x.id).toLowerCase() === d.id)?.resources || []).slice(0, 8); }
    }
    // a needs-manager / done stop is parked for its ticket grants only: the manager owns the rest of it (no age backstop, no other dependency)
    const grantOnly = !/^(?:waiting|running|blocked)$/i.test(String(status || 'waiting'));
    if (grantOnly) { for (let i = deps.length - 1; i >= 0; i--) if (deps[i].kind !== 'ticket' || deps[i].before === 'changed') deps.splice(i, 1); if (!deps.length) { parked.delete(session); return { parked: false, deps }; } }
    parked.set(session, { stopAt, since: now(), status: String(status || 'waiting').toLowerCase(), grantOnly, text: String(text).slice(0, 300), deps, checkedAt: 0, device: deps.some((d) => d.kind === 'resource' || d.kind === 'ticket') });
    log({ type: 'parked_watch', session, stopAt, status, deps: deps.map((d) => ({ kind: d.kind, id: d.id, before: d.before ?? null })) });
    return { parked: true, deps };
  }

  async function parkedTick() {
    const out = [], mode = parkMode();
    if (mode === 'off') { parked.clear(); return out; }
    const ctx = {};
    for (const [session, p] of [...parked]) {
      if (!stillWaiting(session, p.stopAt)) { parked.delete(session); continue; }
      const t = now();
      if (t - p.checkedAt < parkPollMs) continue;
      p.checkedAt = t;
      let reason = null;
      for (const d of p.deps) {
        if (d.before === 'changed') continue;   // already over at park time: the session knew it when it stopped; the age backstop covers it
        const now0 = await depNow(d, session, ctx);
        const c = changeOf(d, now0);
        // a grant waits grantGraceMin: the session's own --wait claim usually wakes it within 0-4 min (5 of 6 grants on 2026-11-11); the 6th sat 30 min
        if (now0.grant && d.kind === 'ticket') { d.grantAt ??= t; if (t - d.grantAt >= grantGraceMin * 60e3) { reason = { kind: 'grant', dep: d, grant: now0.grant, text: grantText(d.id, now0.grant, hhmm) }; break; } continue; }
        if (!c) { d.changedAt = null; continue; }   // flapped back (a freed device was taken again): the grace starts over
        d.changedAt ??= t; d.change = c;
        if (t - d.changedAt >= parkGraceMin * 60e3) { reason = { kind: 'change', dep: d, text: `${c} at ${hhmm(d.changedAt)}` }; break; }
      }
      const ageMin = (t - p.since) / 60e3;
      if (!reason && ageMin >= parkMaxAgeMin && !p.grantOnly) reason = { kind: 'age', text: null };
      if (!reason && p.grantOnly && ageMin >= parkMaxAgeMin) { parked.delete(session); continue; }
      if (!reason) continue;
      // the gates of a manager reply, re-checked right before typing
      if (!canSend(session) || (busy(session) && reason.kind !== 'grant')) continue;   // a grant is told even to a busy pane: the busy task is often the --wait claim holding the lease
      const hour = (parkedSent.get(session) || []).filter((x) => t - x < 3600e3);
      if (hour.length >= parkPerHour) { log({ type: 'parked_wake_capped', session, perHour: hour.length }); continue; }
      const st = p.status === 'blocked' ? 'blocked' : 'waiting';
      // a change detail that names a forbidden word (an integration "deployed", a ticket "dropped") falls back to the neutral form
      if (reason.kind === 'change' && forbiddenMatch(reason.text)) reason.text = `${reason.dep.label} changed at ${hhmm(reason.dep.changedAt)}`;
      const text = reason.kind === 'grant' ? reason.text : reason.kind === 'change'
        ? `harness: ${reason.text} while you were parked on STATUS ${st}. Re-check and continue; if it still blocks you, end with a STATUS that names the id you wait on.`
        : `harness: you have been parked on STATUS ${st} for ${ageMin >= 120 ? `${Math.round(ageMin / 60)} h` : `${Math.round(ageMin)} min`} and nothing you named changed. Re-check it now and continue if it no longer blocks you${p.device ? '; for a device, take a free equivalent with vpt-lease claim <env> --any <group> --wait' : ''}; otherwise end with a STATUS that names the id you wait on.`;
      if (forbiddenMatch(text)) { parked.delete(session); log({ type: 'parked_skip', session, why: 'forbidden topic in the wake text', text }); continue; }
      if (!stillWaiting(session, p.stopAt)) { parked.delete(session); continue; }
      const rec = { session, stopAt: p.stopAt, why: reason.kind, dep: reason.dep ? `${reason.dep.kind}:${reason.dep.id}` : null, parkedMin: Math.round(ageMin), text, ...(reason.grant ? { lease: reason.grant.leaseId } : {}) };
      if (mode === 'dry') { parked.delete(session); parkedSent.set(session, [...hour, t]); log({ type: 'parked_wake_dry', ...rec }); out.push({ ...rec, dry: true }); continue; }
      try { await (sendParked || send)(session, text); } catch (e) { log({ type: 'parked_wake_failed', session, error: e.message }); continue; }
      parked.delete(session); parkedSent.set(session, [...hour, t]);
      log({ type: 'parked_wake', ...rec });
      out.push(rec);
    }
    return out;
  }
  const parkedOf = (session) => parked.get(session) || null;

  // Every tick: wake the sessions whose job ended. A session that moved on, or whose pane has a draft, is dropped / left alone (stillWaiting).
  async function tick() {
    const woke = [];
    for (const [session, w] of [...watched]) {
      if (!stillWaiting(session, w.stopAt)) { watched.delete(session); continue; }
      if ((!w.job.kind || w.job.unseen) && !w.job.harnessOwned) { const n = await staleNudge(session, w); if (n) woke.push(n); continue; }
      if (w.job.harnessOwned) continue;   // the agent's own harness wakes it; ghosty has nothing to watch and must not type into it
      if (!canSend(session)) continue;   // a draft in the input box, a paused session: try again next tick
      if (now() - w.since > maxAgeH * 3600e3) { watched.delete(session); log({ type: 'own_job_giveup', session, job: w.job.label }); continue; }
      const s = await stateOf(w);
      if (s.state !== 'ended') { if (s.state === 'unknown') { const n = await staleNudge(session, w, s); if (n) woke.push(n); } continue; }
      // an integration wake carries the lane's outcome (same text as the guarded send of integration-notify.js)
      const text = s.text || `your ${w.job.label} finished at ${hhmm(s.at || now())}, continue`;
      // the session may have moved on, been paused or started a draft while the state was read: check again right before typing
      if (!stillWaiting(session, w.stopAt)) { watched.delete(session); continue; }
      if (!canSend(session)) continue;
      try { await send(session, text); } catch (e) { log({ type: 'own_job_wake_failed', session, job: w.job.label, error: e.message }); continue; }
      watched.delete(session);
      log({ type: 'own_job_wake', session, job: w.job.label, kind: w.job.kind, finishedAt: new Date(s.at || now()).toISOString(), text });
      woke.push({ session, text });
    }
    try { woke.push(...await parkedTick()); } catch (e) { log({ type: 'parked_tick_failed', error: e.message }); }
    return woke;
  }

  // Staleness sweep: STATUS waiting, pane quiet for staleMin, no live child process, nothing in the line still pending -> one nudge,
  // at most one per nudgeGapMin per session. Never to a session that moved on (stillWaiting) or has a draft (canSend); never while a job is alive.
  const nudged = new Map();   // session -> ms of the last nudge
  async function staleNudge(session, w, known = null) {
    const t = now();
    if (t - w.since < staleMin * 60000 || t - (nudged.get(session) || 0) < nudgeGapMin * 60000) return null;
    const idle = idleMs(session);
    if (idle == null || idle < staleMin * 60000 || !canSend(session)) return null;
    try {
      if (known?.state === 'running') return null;
      if (w.job.kind === 'pid' || w.job.kind === 'tree') { if (w.job.pids.some((p) => alive(p))) return null; }
      if (await hasLiveChild(session, { text: w.job.text, turnStart: w.stopAt })) return null;
      if (!stillWaiting(session, w.stopAt) || !canSend(session)) return null;
      const text = 'nothing you wait on is still running: check the result and continue';
      await send(session, text);
      nudged.set(session, t);
      log({ type: 'own_job_stale_nudge', session, job: w.job.label || 'unknown', idleMin: Math.round(idle / 60000), text });
      return { session, text };
    } catch (e) { log({ type: 'own_job_wake_failed', session, job: w.job.label, error: e.message }); return null; }
  }

  // For the manager's self-check ("is the run finished?"): what is known about the session's own job right now, or null.
  async function progressOf(session) {
    const w = watched.get(session);
    if (!w || !w.job.kind) return null;
    const s = await stateOf(w);
    return s.state === 'unknown' ? null : `${s.summary}${s.state === 'ended' ? ` (at ${hhmm(s.at || now())})` : ''}.`;
  }
  // does the agent of `session` have a live child process (a job of its own) right now?
  // A words-only STATUS ("waiting on the final score_matrix run") is the session's own job only when a child process of the agent either has a specific word
  // of the STATUS line (or the run id) in its command line, or started after the turn began (`turnStart`, ms). Any other child is someone else's.
  async function hasLiveChild(session, { text = '', turnStart = null } = {}) {
    const ap = await agentPid(session);
    if (!ap) return false;
    const tb = await table();
    const kids = jobPids(ap, tb);
    if (!kids.length) return false;
    const words = [...new Set(String(text).toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{3,}/g) || [])].filter((w) => !GENERIC_WORDS.has(w));
    if (kids.some((p) => { const a = String(tb.args.get(p) || '').toLowerCase(); return words.some((w) => a.includes(w)); })) return true;
    if (turnStart) { const at = await startedAt(kids); if (kids.some((p) => at.get(p) > turnStart)) return true; }
    return false;
  }
  return { watch, forget, tick, jobOf, progressOf, hasLiveChild, park, parkedTick, parkedOf, _watched: watched, _parked: parked };
}

function readSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
