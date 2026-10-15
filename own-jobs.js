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
const HELPER_RE = /^(?:\S*\/)?(?:bash|zsh|sh|fish|dash|sleep|ps|tmux|cat|tail|head|grep|git|node -e|python3? -c)(?:\s|$)/;
export const jobPids = (pid, table) => descendants(pid, table).filter((c) => !HELPER_RE.test(String(table.args?.get(c) || '').trim()));

const COMPLETION_RE = /\b(?:done|finished|complete[d]?|all (?:tests )?passed|exit(?:ed)?(?: code)? \d+|exit status \d+|Traceback \(most recent|error summary|\d+ passed|saved to)\b/i;
const GENERIC_WORDS = new Set(['waiting', 'blocked', 'final', 'run', 'runs', 'job', 'jobs', 'process', 'finish', 'finishes', 'finished', 'complete', 'completes', 'completed', 'running', 'progress', 'until', 'tests', 'test', 'build', 'task', 'script', 'with', 'that', 'this', 'from', 'then', 'before', 'after', 'done', 'still', 'status', 'ends', 'end']);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

// deps: { now, procRoot, table: () => ps table, agentPid: (session) => pid|null, deployState: (id) => { state, finished }|null,
//         stillWaiting: (session, stopAt) => bool, send: (session, text) => Promise, record: (event) => Promise, log: (rec) => void }
export function createOwnJobs({ now = () => Date.now(), procRoot = '/proc', table = async () => ({ children: new Map(), args: new Map() }), agentPid = async () => null,
  deployState = () => null, startedAt = async () => new Map(), stillWaiting = () => true, canSend = () => true, send = async () => {}, record = async () => {}, log = () => {}, stableMin = 5, maxAgeH = 12, roots = () => [] } = {}) {
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
    if (refs.deploy) { job.kind = 'deploy'; job.id = refs.deploy; job.label = `deploy ${refs.deploy}`; }
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
    job.detached = detached || job.detached || false;
    return job;
  }

  async function watch(session, { text, cwd = null, stopAt = now(), paneText = '' } = {}) {
    const job = await identify(session, { text, cwd, stopAt, paneText });
    const w = { job, stopAt, since: now(), seenRunning: false, lastMtime: null, stableSince: null, flagged: false };
    // a pid or a process tree counts as ended only after it was seen running: a pid that is not alive here (another host, already gone) is unseeable
    if (job.kind === 'pid' || job.kind === 'tree') { w.seenRunning = job.pids.some((p) => alive(p)); if (!w.seenRunning) { job.unseen = true; } }
    watched.set(session, w);
    if (job.kind === 'log') await stateOf(w);   // remembers the mtime now: quiet time counts from the stop, not from the first tick
    if (!job.kind || job.detached || job.unseen) {
      w.flagged = true;
      await record({ key: `job:unseen:${session}`, title: `${session} waits on a job the harness cannot see`,
        body: job.detached ? `its job runs detached (nohup / setsid / disown / &), so the manager cannot tell when it ends: ${job.text}` : job.unseen ? `the pid named in its STATUS is not running on this host, so the manager cannot tell when the job ends: ${job.text}` : `STATUS names no pid, log or run id and the agent has no child process: ${job.text}`, url: `/?s=${encodeURIComponent(session)}`, priority: 'default' }).catch(() => {});
    }
    log({ type: 'own_job_watch', session, job: job.kind || 'unknown', label: job.label, detached: !!job.detached });
    return { kind: job.kind, label: job.label, detached: !!job.detached, unseen: !!job.unseen, pid: job.pids?.[0] ?? null };
  }
  const forget = (session) => { watched.delete(session); };
  const jobOf = (session) => watched.get(session)?.job || null;

  // -> { state: 'running'|'ended'|'unknown', at?: ms, summary }
  async function stateOf(w) {
    const j = w.job, t = now();
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

  // Every tick: wake the sessions whose job ended. A session that moved on, or whose pane has a draft, is dropped / left alone (stillWaiting).
  async function tick() {
    const woke = [];
    for (const [session, w] of [...watched]) {
      if (!stillWaiting(session, w.stopAt)) { watched.delete(session); continue; }
      if (!w.job.kind || w.job.unseen) continue;
      if (!canSend(session)) continue;   // a draft in the input box, a paused session: try again next tick
      if (now() - w.since > maxAgeH * 3600e3) { watched.delete(session); log({ type: 'own_job_giveup', session, job: w.job.label }); continue; }
      const s = await stateOf(w);
      if (s.state !== 'ended') continue;
      const text = `your ${w.job.label} finished at ${hhmm(s.at || now())}, continue`;
      // the session may have moved on, been paused or started a draft while the state was read: check again right before typing
      if (!stillWaiting(session, w.stopAt)) { watched.delete(session); continue; }
      if (!canSend(session)) continue;
      try { await send(session, text); } catch (e) { log({ type: 'own_job_wake_failed', session, job: w.job.label, error: e.message }); continue; }
      watched.delete(session);
      log({ type: 'own_job_wake', session, job: w.job.label, kind: w.job.kind, finishedAt: new Date(s.at || now()).toISOString(), text });
      woke.push({ session, text });
    }
    return woke;
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
  return { watch, forget, tick, jobOf, progressOf, hasLiveChild, _watched: watched };
}

function readSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
