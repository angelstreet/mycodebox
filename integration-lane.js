// The integration lane (round 13, docs/v2/INTEGRATION-LANE.md): sessions hand a pushed branch to the server; one worker per
// repository merges it into the current remote target in a fresh worktree of the lane's OWN clone, runs the repo's tests,
// pushes with a compare-and-swap, waits for CI on that exact commit and queues the deploy when asked. Every transition goes
// to notify(request, event). Everything outside (git, the shell, CI, the deploy queue, the merge floor) is injected.
//
// Final states: merged | deployed | returned (reason + tail) | merged_ci_red | deploy_failed | cancelled.
// A merge that reached the target is never reverted here: CI red / deploy failed are reported and the manager decides.
// Durable: <state>/integration/requests.jsonl, one full snapshot per line (last wins). A request found `running` at start is
// resumed from its recorded progress: fetch / merge / test are idempotent (fresh worktree), the push is re-checked by reading
// the remote, CI and the deploy continue where they were.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { gitFacts, mergeFloor, isConvention, migrationReasons, migrationAttestedCheck } from './merge-policy.js';
import { attribute, readLedgerTail, rowCwdMatchesWorktree } from './usage-window.js';

export const FINAL = Object.freeze(['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled']);
export const STATES = Object.freeze(['queued', 'running', ...FINAL]);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPES = new Set(['frontend', 'server', 'host', 'full']);   // the deploy queue's scopes
// How wide a deploy scope reaches, so a coalesce keeps the wider of two (`--deploy frontend` then `--deploy full` deploys).
const SCOPE_WIDTH = Object.freeze({ frontend: 1, server: 2, host: 3, full: 4 });
// A queued request waits this long without changing before the lane picks it: a session that pushes commit after commit and
// re-requests must not restart the target's CI once per commit (2026-10-20: three merges of one branch in three minutes).
export const DEFAULT_SETTLE_MS = 60_000;
const MAX_SETTLE_MS = 3_600_000;
const MAX_PUSH_TRIES = 3;
const MIGRATION_REASON = /^touches a migration: /;   // the path-based floor line the effect-based migration reasons replace
export const INSTALL_CMD = 'npm ci --no-audit --no-fund';
const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
// Remote URLs may carry credentials: never let them into a tail, a reason or a notice.
const redact = (t) => String(t ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@');
export const tailOf = (text, lines = 60, chars = 6000) => redact(String(text ?? '')).split('\n').slice(-lines).join('\n').slice(-chars).trim();
// Red tests: the node test runner's `✖ failing tests:` block (names, assertions, own stack frames) matters more than the
// last lines, which a long block or trailing npm noise pushes out. -> { tail, failing: [names] }; plain tail without one.
export function testFailure(text, chars = 6000) {
  const t = redact(String(text ?? ''));
  const i = t.lastIndexOf('✖ failing tests:');
  if (i < 0) return { tail: tailOf(t), failing: [] };
  const block = t.slice(i).split('\n').filter((l) => !/^\s+at .*\bnode:/.test(l));   // runtime-internal frames say nothing
  const failing = [...new Set(block.map((l) => /^\s*✖ (.+?) \([\d.]+m?s\)\s*$/.exec(l)?.[1]).filter(Boolean))];
  const summary = t.slice(0, i).split('\n').filter((l) => /^ℹ (tests|pass|fail|cancelled) /.test(l)).slice(-4);
  let body = block.join('\n').trim();
  const room = chars - summary.join('\n').length - 4;
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return { tail: [body, ...summary].join('\n'), failing };
}

// ---- config ------------------------------------------------------------------------------------------------------------
// `settleMs`: whole milliseconds from 0 to an hour, or null when absent/invalid. 0 means "pick a queued request at once".
export function parseSettleMs(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SETTLE_MS ? n : null;
}
// -> { repos: {key: normalized}, settleMs, errors: [] }. Unknown keys are ignored; an invalid repo is dropped and reported.
// The global settleMs (top level) is the fallback for every repo without its own.
export function validateConfig(raw) {
  const repos = {}, errors = [];
  const globalSettle = parseSettleMs(raw?.settleMs);
  if (raw?.settleMs != null && globalSettle == null) errors.push(`settleMs: must be an integer from 0 to ${MAX_SETTLE_MS} ms`);
  for (const [key, c] of Object.entries(raw?.repos && typeof raw.repos === 'object' ? raw.repos : {})) {
    const bad = (m) => errors.push(`${key}: ${m}`);
    if (!KEY_RE.test(key)) { bad('invalid repo key'); continue; }
    if (!c || typeof c !== 'object') { bad('not an object'); continue; }
    if (typeof c.clone !== 'string' || !path.isAbsolute(c.clone)) { bad('clone must be an absolute path'); continue; }
    const remote = c.remote ?? 'origin', target = c.target ?? 'main';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) { bad('invalid remote'); continue; }
    if (!BRANCH_RE.test(target)) { bad('invalid target'); continue; }
    if (c.test != null && (typeof c.test !== 'string' || !c.test.trim())) { bad('test must be a command string or null'); continue; }
    if (c.ci != null && c.ci !== 'github') { bad("ci must be 'github' or null"); continue; }
    const conventionResolver = c.conventionResolver ?? 'take-target';
    if (!['take-target', 'max-plus-one'].includes(conventionResolver)) { bad('invalid conventionResolver'); continue; }
    let deploy = null;
    if (c.deploy?.kind === 'self') {
      // the repo of this very service: pull its live checkout and restart it (selfDeploy below), after every merge
      const raw = typeof c.deploy.liveCheckout === 'string' ? c.deploy.liveCheckout.trim() : '';
      const live = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
      if (!path.isAbsolute(live) || /[#'\n\r]/.test(live)) { bad('deploy.liveCheckout must be an absolute or ~/ path without # or quotes'); continue; }
      const w = c.deploy.restartWaitMin ?? 10;
      if (!Number.isInteger(w) || w < 0 || w > 60) { bad('deploy.restartWaitMin must be an integer from 0 to 60'); continue; }
      deploy = { kind: 'self', liveCheckout: path.normalize(live).replace(/\/+$/, ''), restartWaitMin: w };
    } else if (c.deploy != null) {
      if (typeof c.deploy !== 'object' || typeof c.deploy.env !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(c.deploy.env)) { bad('deploy.env required'); continue; }
      const defaultScope = c.deploy.defaultScope ?? 'full';
      if (!SCOPES.has(defaultScope)) { bad(`deploy.defaultScope must be one of ${[...SCOPES].join(', ')}`); continue; }
      deploy = { env: c.deploy.env, defaultScope };
    }
    const conventions = Array.isArray(c.conventions) ? c.conventions.filter((x) => typeof x === 'string' && x) : ['VERSION.txt'];
    // Shared files that every merge edits collide on: `unionFiles` keeps both sides' added lines, `regenerate` takes the
    // target's file and lets the repo's own generator rewrite it. Absent = today (only VERSION.txt resolves).
    const safePath = (x) => typeof x === 'string' && !!x.trim() && !path.isAbsolute(x) && !x.split('/').includes('..') && !/[\0\n\r]/.test(x);
    const unionFiles = [];
    if (c.unionFiles != null) {
      if (!Array.isArray(c.unionFiles)) bad('unionFiles must be an array of paths');
      else for (const f of c.unionFiles) { if (safePath(f)) unionFiles.push(f.trim()); else bad(`unionFiles: invalid path ${JSON.stringify(f)}`); }
    }
    const regenerate = [];
    if (c.regenerate != null) {
      if (!Array.isArray(c.regenerate)) bad('regenerate must be an array of { files, cmd }');
      else for (const g of c.regenerate) {
        const files = Array.isArray(g?.files) ? g.files.filter(safePath).map((f) => f.trim()) : [];
        const cmd = typeof g?.cmd === 'string' ? g.cmd.trim() : '';
        // a malformed entry is dropped, not fatal: the file then behaves like any other conflict (the request returns)
        if (!files.length || !cmd || /[\0\n\r]/.test(cmd)) bad('regenerate entries need files: [...] and a non-empty cmd');
        else regenerate.push({ files, cmd });
      }
    }
    const mins = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    let settle = null;
    if (c.settleMs != null) {
      settle = parseSettleMs(c.settleMs);
      if (settle == null) { bad(`settleMs must be an integer from 0 to ${MAX_SETTLE_MS} ms`); continue; }
    }
    repos[key] = { key, clone: c.clone, remote, target, test: c.test ? c.test.trim() : null, testTimeoutMin: mins(c.testTimeoutMin, 30),
      ci: c.ci ?? null, ciTimeoutMin: mins(c.ciTimeoutMin, 60), deploy, conventions, conventionResolver, unionFiles, regenerate,
      ...(settle == null ? {} : { settleMs: settle }) };
  }
  return { repos, settleMs: globalSettle, errors };
}
export function loadConfig(stateDir) {
  try { return validateConfig(JSON.parse(fs.readFileSync(path.join(stateDir, 'integration.json'), 'utf8'))); } catch { return { repos: {}, settleMs: null, errors: [] }; }
}

// Normalized remote identity so https/ssh/credentialed spellings of one repository compare equal.
export function normalizeRemoteUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '');
  return s.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

// ---- default injected pieces -------------------------------------------------------------------------------------------
// git(args, { cwd, timeoutMs }) -> { code, out, err, timedOut? }; never throws on a non-zero exit.
export function createDefaultGit() {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' };   // own runner: orchestration/ must not load at server startup
  return (args, { cwd, timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
    const child = spawn('git', ['-c', 'pack.threads=2', ...args], { cwd, env: base, stdio: ['ignore', 'pipe', 'pipe'] });   // few pack threads: the box is memory- and pid-tight
    let out = '', err = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve(timedOut ? { code: -1, out, err: 'git timed out', timedOut: true } : { code: code ?? -1, out, err }); });
  });
}
// A branch's tests must not see the service's environment (Langfuse / Jev keys, tokens): an allowlist, not a denylist.
const ENV_KEEP = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'CI', 'GHOSTY_STATE_DIR',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']);
// NODE_TEST_CONTEXT would turn a nested `node --test` into a child reporter of ours (exit 0 on red): never pass it on.
export const scrubEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k, v]) => v != null && k !== 'NODE_TEST_CONTEXT' && (ENV_KEEP.has(k) || /^(LC_|NODE_)/.test(k))));
// run(cmd, { cwd, timeoutMs, env, onData }) -> { code, out, timedOut }. `sh -c`, own process group so a timeout kills the tree.
export function createDefaultRun() {
  return (cmd, { cwd, timeoutMs = 30 * 60_000, env, onData } = {}) => new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: { ...scrubEnv(), ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '', timedOut = false;
    const take = (d) => { const s = d.toString('utf8'); out = (out + s).slice(-200_000); try { onData?.(s); } catch { /* observer */ } };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const t = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: `${out}\n${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out, timedOut }); });
  });
}
// 'github' CI: check-runs of the exact commit through `gh api`. status(sha, { clone, remote }) -> success|failure|pending|missing|unknown
export function createGithubCi({ exec = (argv, o) => new Promise((resolve) => {
  const c = spawn(argv[0], argv.slice(1), { cwd: o?.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => c.kill('SIGKILL'), 30_000);
  c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
  c.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out, err }); });
}), git = createDefaultGit() } = {}) {
  return {
    async status(sha, { clone, remote = 'origin' } = {}) {
      const u = await git(['remote', 'get-url', remote], { cwd: clone });
      const slug = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(u.out.trim())?.[1];
      if (u.code !== 0 || !slug || !/^[0-9a-f]{40,64}$/.test(sha)) return 'unknown';
      const r = await exec(['gh', 'api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`], { cwd: clone });
      if (r.code !== 0) return 'unknown';
      let j; try { j = JSON.parse(r.out); } catch { return 'unknown'; }
      const runs = Array.isArray(j.check_runs) ? j.check_runs : [];
      if (!runs.length) return 'missing';
      if (runs.some((x) => ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(x.conclusion))) return 'failure';
      if (runs.some((x) => x.status !== 'completed')) return 'pending';
      return 'success';
    },
  };
}
// Self-deploy restart. ONLY scripts/safe-restart.sh restarts anything (it restarts the systemd service and waits for idle);
// tmux is used solely to launch that script outside our cgroup, never to kill or respawn a session or process.
// The lane runs inside the service that scripts/safe-restart.sh restarts, and the unit sets
// NoNewPrivileges, so the script's `sudo systemctl restart` cannot run from a child of ours. The tmux server lives outside
// the service (its own unit and cgroup, no NoNewPrivileges) and is where sessions already run safe-restart: `run-shell -b`
// runs it there, so it outlives our stop and may sudo. Output goes to `log`, the exit code to `exit` (atomic rename).
// restart({ cwd, waitMin, log, exit, pid }) -> { ok, error? }
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export function restartCommand({ cwd, waitMin, log, exit, pid }) {
  // `pid`: the shell's own pid is written first, so a later self deploy can tell a waiter that is still waiting from a dead one
  return `cd ${sq(cwd)} && ${pid ? `echo $$ >${sq(pid)} && ` : ''}./scripts/safe-restart.sh --wait ${Number(waitMin) || 0} >${sq(log)} 2>&1; echo $? >${sq(`${exit}.tmp`)} && mv ${sq(`${exit}.tmp`)} ${sq(exit)}`;
}
export function createTmuxRestart({ tmux = process.env.TMUX_BIN || 'tmux' } = {}) {
  return (o) => new Promise((resolve) => {
    const cmd = restartCommand(o);
    if (cmd.includes('#')) { resolve({ ok: false, error: 'a path contains #, which tmux would expand' }); return; }
    execFile(tmux, ['run-shell', '-b', cmd], { timeout: 15_000 }, (e, _o, err) => resolve(e ? { ok: false, error: String(err || e.message).trim().slice(0, 300) } : { ok: true }));
  });
}
// A launched waiter is alive while its pid file names a live process whose command line is still the safe-restart shell
// (a recycled pid is another command). Unreadable /proc (not Linux): the signal-0 probe alone.
export function waiterAlive(pidFile) {
  let pid; try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch { return false; }
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('safe-restart'); } catch { return true; }
}
// The restarted service answers. -> boolean
export const defaultHealth = (base = `http://127.0.0.1:${Number(process.env.PORT || 7777)}`) => async () => {
  try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; }
};

// Round 7 merge floor with the lane as the tester (its own test run replaces the session's test report).
// `approveInfra` (a manager approval on the request) drops ONLY the CI/deploy/infra-path reason; `infra` tells the lane when that
// was the floor's only reason, so it can ask the manager instead of bouncing the branch.
// Q199: a migration merges by EFFECT. An additive-only migration (CREATE TABLE / CREATE INDEX / ADD COLUMN) merges with the manager's
// approval AND the --migration-applied attestation (the lane cannot read the target DB, so the manager says the objects are there);
// a destructive one is returned with the construct that makes it so.
export async function defaultMergeEval({ cwd, branch, branchSha, target, remote, conventionFiles, approveInfra = false, migrationApplied = false, optOut = [] }) {
  const facts = await gitFacts({ cwd, branch, branchSha, target, remote, conventionFiles });
  const files = (facts.sensitive || []).filter((s) => s.why === 'deploy').map((s) => s.file);
  const rest = mergeFloor(facts, { state: 'green' }, { conventionFiles, approveInfra: true, optOut });
  const base = approveInfra ? rest : mergeFloor(facts, { state: 'green' }, { conventionFiles, optOut });
  // the path-based migration reasons become the effect-based ones (or vanish when the attestation allows the merge)
  const mig = migrationReasons(facts, { approvedBy: approveInfra, migrationApplied });
  const reasons = base.filter((x) => !MIGRATION_REASON.test(x)).concat(mig);
  return { verdict: reasons.length ? 'escalate' : 'merge', reasons, facts, infra: { files, only: !approveInfra && files.length > 0 && rest.length === 0 },
    migration: { files: (facts.sensitive || []).filter((s) => s.why === 'migration').map((s) => s.file), allowed: mig.length === 0 && base.length > 0, applied: !!migrationApplied, attestedCheck: migrationAttestedCheck(facts, { migrationApplied }) } };
}

// ---- the lane ----------------------------------------------------------------------------------------------------------

// Per-request attribution (Round 14b, docs/v2/SCORING.md): the requesting session's usage-ledger rows labelled with the session
// in (from, to], where from = the session's previous request (any branch) or 24 h before, whichever is later, and to = the request
// time. With the requester's worktree (git toplevel, sent by `integrate`) the rows are those whose cwd is inside it (attribution
// 'worktree', per branch); without it, or when none match, the session-label rows ('session-window', splits by time). Frozen at enqueue.
// Subagent rows match by `workCwd` (the directory the subagent tool actually ran in) before falling back to `cwd` (parent's folder).
export function sessionUsage({ stateDir, session, worktree = null, from, to }) {
  if (!session && !worktree) return null;
  const rows = readLedgerTail(path.join(stateDir, 'usage-ledger.jsonl'));
  const wt = worktree && path.isAbsolute(worktree) ? worktree.replace(/\/+$/, '') : null;
  let a = wt ? attribute(rows.filter((r) => rowCwdMatchesWorktree(r, wt)), from, to) : null;
  const rule = a ? 'worktree' : 'session-window';
  if (!a && session) a = attribute(rows.filter((r) => r.label === session), from, to);
  return a && { attribution: rule, model: a.model, runtime: a.agent, tokens: a.tokens, tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsd: a.costUsd, plan: a.plan, from: new Date(from).toISOString(), to: new Date(to).toISOString(), rule: rule === 'worktree' ? 'ledger rows with cwd inside the requester worktree since the session\'s previous request (max 24h)' : 'session ledger rows since its previous request (max 24h)' };
}

const TASK_BRANCH_RE = /^v2\/task\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export function createIntegrationLane({ stateDir, config = null, git = createDefaultGit(), run = createDefaultRun(), ci = null,
  taskGrant = null, deploys = null, mergeEval = defaultMergeEval, usage = sessionUsage, notify = () => {}, managerItem = () => {}, journal = () => {}, mergeOptOut = () => [], now = () => Date.now(), log = () => {},
  // Approval identity (2026-10-20): only a manager session may pass --approved-by / --migration-applied. `managerSessions` is a
  // function returning the current manager session names (server.js passes loadManagerSessions). Absent = older wiring / tests:
  // every caller keeps today's behaviour, so an un-wired lane is never suddenly stricter.
  managerSessions = null,
  pollMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), restart = createTmuxRestart(), pidAlive = waiterAlive } = {}) {
  if (!stateDir) throw coded('E_CONFIG', 'integration lane: stateDir required');
  const dir = path.join(stateDir, 'integration');
  const file = path.join(dir, 'requests.jsonl');
  const reqs = new Map();          // id -> request (insertion = enqueue order)
  const live = new Map();          // id -> { step, tail } (memory only: the running step's output)
  const waiters = new Map();       // id -> Set<fn>
  const workers = new Map();       // repo -> Promise
  const settleTimers = new Map();  // repo -> timer that wakes the picker when a settle window ends
  let stopped = false, started = false;

  const cfgAll = () => (config ? validateConfig(typeof config === 'function' ? config() : config) : loadConfig(stateDir));
  const repoCfg = (key) => cfgAll().repos[key] || null;
  // The repo's own settleMs, else the global one, else the default. 0 means "no settle window".
  const settleOf = (key) => { const all = cfgAll(); const r = all.repos[key]; return (r && r.settleMs != null ? r.settleMs : (all.settleMs != null ? all.settleMs : DEFAULT_SETTLE_MS)); };
  const iso = () => new Date(now()).toISOString();
  const persist = (r) => { try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.appendFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 }); } catch (e) { log('persist failed', e.message); } };
  let lastTold = Promise.resolve();   // the latest notify call, so a self deploy can let the notice out before its restart
  const emit = (r, event) => {
    try { lastTold = Promise.resolve(notify(view(r), { at: iso(), ...event })).catch((e) => log('notify failed', e?.message)); } catch (e) { log('notify failed', e?.message); lastTold = Promise.resolve(); }
  };
  function view(r) {
    const o = structuredClone(r);
    const l = live.get(r.id); if (l && r.state === 'running') o.live = { ...l };
    if (r.state === 'queued') o.position = ahead(r) + 1;
    return o;
  }
  const ahead = (r) => [...reqs.values()].filter((x) => x.repo === r.repo && (x.state === 'running' || (x.state === 'queued' && x.seq < r.seq))).length;
  const wake = (id) => { for (const f of waiters.get(id) || []) f(); };

  // ---- settle window (owner 2026-10-20) ------------------------------------------------------
  // A queued request may only be picked once it has sat unchanged for its repo's settleMs. `settleUntil` is the moment the
  // window ends (ISO), set at enqueue and pushed back by every coalesce. Absent = an older record or settleMs 0: pick at once.
  const settleUntilOf = (repo) => { const ms = settleOf(repo); return ms > 0 ? new Date(now() + ms).toISOString() : null; };
  const settleLeft = (r) => (r.settleUntil ? Math.max(0, Date.parse(r.settleUntil) - now()) : 0);
  const settled = (r) => settleLeft(r) <= 0;
  // The lane is serial per repo (one worker), so a queued request behind a running one already waits for it; this is only the
  // mark that says so, and it survives a restart.
  const markBehind = (r) => {
    const run = [...reqs.values()].find((x) => x.repo === r.repo && x.state === 'running');
    r.afterId = run ? run.id : null;
  };
  // Wake the picker for a repo in `ms`, replacing any timer already armed for it (a coalesce moves the window).
  function armSettle(repo, ms) {
    const old = settleTimers.get(repo);
    if (old) { clearTimeout(old); settleTimers.delete(repo); }
    if (!(ms > 0) || stopped) return;
    const t = setTimeout(() => { settleTimers.delete(repo); if (!stopped) kick(repo); }, ms);
    t.unref?.();
    settleTimers.set(repo, t);
  }

  function load() {
    reqs.clear();
    let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
    const lines = txt.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); else lines.pop();   // an unterminated last line was never acknowledged
    for (const l of lines) { try { const r = JSON.parse(l); if (r?.id) reqs.set(r.id, r); } catch { /* torn */ } }
  }

  function transition(r, state, patch = {}, event = {}) {
    Object.assign(r, patch, { state, updatedAt: iso() });
    const final = FINAL.includes(state);
    if (final) { r.endedAt = iso(); live.delete(r.id); }
    persist(r);
    emit(r, { kind: final ? 'final' : state === 'running' ? 'running' : 'state', state, final, reason: r.reason ?? null, ...event });
    if (final) wake(r.id);
  }

  // One recorded step: start/end times, output tail. fn(setLive) -> { ok?, tail?, info? }; a throw is recorded and rethrown.
  async function step(r, name, fn) {
    const s = { name, startedAt: iso(), endedAt: null, ok: null, tail: '' };
    r.steps.push(s); r.step = name; live.set(r.id, { step: name, tail: '' }); r.updatedAt = iso(); persist(r);
    emit(r, { kind: 'step', state: r.state, step: name, final: false });
    const setLive = (chunk) => { const l = live.get(r.id); if (l) l.tail = redact(l.tail + chunk).slice(-4000); };
    try {
      const out = (await fn(setLive)) || {};
      s.ok = out.ok !== false; s.tail = out.bounded ? redact(out.tail) : tailOf(out.tail ?? ''); if (out.info !== undefined) s.info = out.info;
      return out;
    } catch (e) { s.ok = false; s.tail = tailOf(e.message); throw e; } finally { s.endedAt = iso(); persist(r); }
  }
  class Ret extends Error { constructor(reason, tail = '', extra = {}) { super(reason); this.reason = reason; this.tail = tail; this.extra = extra; } }

  const G = (r, c, args, o) => git(args, { cwd: c.clone, timeoutMs: 120_000, ...o });
  const ident = ['-c', 'user.name=mycodebox-lane', '-c', 'user.email=lane@mycodebox.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

  async function fetch(r, c) {
    const f = await step(r, 'fetch', async () => {
      const x = await G(r, c, ['fetch', '--prune', c.remote]);
      if (x.code !== 0) return { ok: false, tail: x.err || x.out };
      // keep the lane clone's local target in step with the remote so the merge floor compares like with like
      const head = await G(r, c, ['symbolic-ref', '-q', 'HEAD']);
      if (head.code === 0) await G(r, c, ['checkout', '-q', '--detach']);
      await G(r, c, ['update-ref', `refs/heads/${c.target}`, `refs/remotes/${c.remote}/${c.target}`]);
      return { ok: true };
    });
    if (!f.ok) throw new Ret('fetch failed', f.tail);
  }
  const rev = async (r, c, ref, cwd) => { const x = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: cwd || c.clone }); return x.code === 0 ? x.out.trim() : null; };
  const contains = async (r, c, sha) => (await G(r, c, ['merge-base', '--is-ancestor', sha, `${c.remote}/${c.target}`])).code === 0;

  // The remote's target tip read straight from the remote (no fetch needed). -> sha | null (unknown)
  const remoteTip = async (r, c) => {
    const x = await G(r, c, ['ls-remote', c.remote, `refs/heads/${c.target}`], { timeoutMs: 60_000 });
    const m = x.code === 0 ? /^([0-9a-f]{40,64})\s/.exec(x.out) : null;
    return m ? m[1] : null;
  };
  // Retry until the remote answers (a follow-up fetch can fail after a push that landed); a stopped lane leaves the request running.
  const knownTip = async (r, c) => {
    for (;;) {
      const t = await remoteTip(r, c);
      if (t) return t;
      if (stopped) throw new Ret('lane stopped');
      await sleep(pollMs);
    }
  };

  function wtPath(r) { return path.join(dir, 'wt', r.id); }
  async function dropWorktree(r, c) {
    const p = wtPath(r);
    await git(['worktree', 'remove', '--force', p], { cwd: c.clone }).catch(() => {});
    fs.rmSync(p, { recursive: true, force: true });
    await git(['worktree', 'prune'], { cwd: c.clone }).catch(() => {});
  }

  // Convention-file conflict resolution inside the merge worktree. -> true when every file was resolved.
  async function resolveConventions(r, c, wt, files) {
    for (const f of files) {
      let ok = false;
      if (c.conventionResolver === 'max-plus-one') {
        const ours = await git(['show', `:2:${f}`], { cwd: wt }), theirs = await git(['show', `:3:${f}`], { cwd: wt });
        const num = (t) => /(\d+)(\s*)$/.exec(t.out);
        const a = ours.code === 0 ? num(ours) : null, b = theirs.code === 0 ? num(theirs) : null;
        if (a && b) {
          const next = String(Math.max(Number(a[1]), Number(b[1])) + 1);
          fs.writeFileSync(path.join(wt, f), ours.out.slice(0, a.index) + next + a[2]);
          ok = true;
        }
      } else {
        ok = (await git(['checkout', '--ours', '--', f], { cwd: wt })).code === 0;
      }
      if (!ok || (await git(['add', '--', f], { cwd: wt })).code !== 0) return false;
    }
    return true;
  }

  // Which resolver owns a conflicting file: a repo-configured union file, a regenerate group, or none. A configured path
  // matches the full repo path or a bare basename (like isConvention). Regenerate entries sharing a command run once.
  // -> { union, regenerate: [{ cmd, files }], other }
  const classify = (c, files) => {
    const hit = (list, f) => list.some((x) => f === x || path.basename(f) === x);
    const union = [], groups = new Map(), other = [];
    for (const f of files) {
      const g = (c.regenerate || []).find((e) => hit(e.files, f));
      if (g) {
        const k = groups.get(g.cmd) || { cmd: g.cmd, files: [] };
        k.files.push(f); groups.set(g.cmd, k);
      } else if (hit(c.unionFiles || [], f)) union.push(f);
      else other.push(f);
    }
    return { union, regenerate: [...groups.values()], other };
  };

  // Union files (append-only lists like the release notes): keep both sides' added lines. `git merge-file --union` on the
  // three conflict stages is the same three-way merge git would have run, with conflict markers replaced by both sides.
  // -> true when every file resolved.
  async function resolveUnion(wt, files) {
    const tmp = path.join(dir, 'tmp', `union-${randomBytes(6).toString('hex')}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      for (const f of files) {
        const [b, o, t] = await Promise.all([1, 2, 3].map((s) => git(['show', `:${s}:${f}`], { cwd: wt })));
        if (b.code !== 0 || o.code !== 0 || t.code !== 0) return false;   // a rename/delete side has no content to union
        const [bp, op, tp] = ['base', 'ours', 'theirs'].map((n) => path.join(tmp, n));
        fs.writeFileSync(bp, b.out); fs.writeFileSync(op, o.out); fs.writeFileSync(tp, t.out);
        const m = await git(['merge-file', '--union', '--stdout', op, bp, tp], { cwd: wt });
        if (m.code !== 0) return false;
        fs.writeFileSync(path.join(wt, f), m.out);
        if ((await git(['add', '--', f], { cwd: wt })).code !== 0) return false;
      }
      return true;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // Regenerate files (a generated index and its siblings): the target's version wins, then the repo's own generator
  // rewrites the file in the merge worktree and its output is staged. Anything the command adds or rewrites is staged
  // too, so a file the generator owns but the branch never conflicted on still ends up consistent. -> { ok, tail }
  async function resolveRegenerate(c, wt, groups) {
    for (const g of groups) {
      if ((await git(['checkout', '--ours', '--', ...g.files], { cwd: wt })).code !== 0) return { ok: false, tail: `could not take the target's ${g.files.join(', ')}` };
      if ((await git(['add', '--', ...g.files], { cwd: wt })).code !== 0) return { ok: false, tail: `could not stage ${g.files.join(', ')}` };
      const before = new Set((await git(['status', '--porcelain', '-z'], { cwd: wt })).out.split('\0').filter(Boolean));
      const res = await run(g.cmd, { cwd: wt, timeoutMs: c.testTimeoutMin * 60_000 });
      if (res.code !== 0 || res.timedOut) return { ok: false, tail: res.timedOut ? `${g.cmd} timed out` : `${g.cmd} failed (exit ${res.code})\n${tailOf(res.out, 20, 2000)}` };
      const after = (await git(['status', '--porcelain', '-z'], { cwd: wt })).out.split('\0').filter(Boolean);
      const extra = after.filter((l) => !before.has(l) && !/^[RC]/.test(l)).map((l) => l.slice(3));   // what the generator wrote: a new or changed path
      const add = [...new Set([...g.files.filter((f) => fs.existsSync(path.join(wt, f))), ...extra])];
      if (add.length && (await git(['add', '--', ...add], { cwd: wt })).code !== 0) return { ok: false, tail: `could not stage the output of ${g.cmd}` };
    }
    return { ok: true };
  }

  // A clean merge carries a convention file the branch changed straight into the target, so main ends up with the branch's
  // label (twice on 2026-10-20, virtualpytest); the pre-push hook does not see the lane's push. After the merge commit
  // exists, restore every convention file the branch changed to the target's version and amend. max-plus-one keeps its
  // conflict-only rule (there is nothing to bump against without a conflict).
  async function enforceConventions(r, c, wt, { branchSha, targetSha, msg }) {
    if (c.conventionResolver !== 'take-target') return { ok: true, files: [] };
    const b = await git(['merge-base', targetSha, branchSha], { cwd: wt });
    if (b.code !== 0) return { ok: true, files: [] };   // no common ancestor: leave the merge alone
    const base = b.out.trim();
    const files = [];
    for (const f of c.conventions) {
      const [merged, atBase, atTarget] = await Promise.all([git(['show', `HEAD:${f}`], { cwd: wt }),
        git(['show', `${base}:${f}`], { cwd: wt }), git(['show', `${targetSha}:${f}`], { cwd: wt })]);
      if (merged.code !== 0 || atBase.code !== 0 || atTarget.code !== 0) continue;              // no such file in the merge, the base or the target
      if (merged.out === atBase.out || merged.out === atTarget.out) continue;                   // the branch left it alone, or it already is the target's
      if ((await git(['checkout', targetSha, '--', f], { cwd: wt })).code !== 0) continue;
      if ((await git(['add', '--', f], { cwd: wt })).code !== 0) continue;
      files.push(f);
    }
    if (!files.length) return { ok: true, files: [] };
    const a = await git([...ident, 'commit', '--amend', '--no-edit', '-m', `${msg}; resolved ${files.join(', ')} (${c.conventionResolver})`], { cwd: wt });
    return a.code === 0 ? { ok: true, files } : { ok: false, files, tail: a.err || a.out };
  }

  const optOutList = () => { try { return mergeOptOut() || []; } catch { return []; } };
  // OWNER_DECISIONS §15: every lane verdict and self-deploy is a decision record (merge-decisions.jsonl) for "Decided for you".
  // `request` joins it to the lane request (a revert finds the merge commit there); a retry on a moved target gets its own id.
  const jr = (rec) => { try { journal({ task_id: `manager:${rec.session || 'lane'}`, source: 'integration-lane', policy_ref: 'OWNER_DECISIONS §15', reversible: true, actor: { role: 'integration-lane', runtime: null, model: null }, ...rec }); } catch (err) { log('journal failed', err?.message); } };
  function journalVerdict(r, c, e, reasons) {
    const ok = e?.verdict === 'merge', f = e?.facts || {};
    jr({ decision_id: `lane-merge-${r.id}${r.attempt > 1 ? `-${r.attempt}` : ''}`, kind: 'merge', ts: iso(), question: `Merge ${r.branch} into ${c.target}?`, chosen: ok ? 'merge' : 'escalate',
      rationale: ok ? 'the merge floor passed on the current target; the lane tests the merge before it pushes' : reasons.join('; ') || 'not mergeable',
      evidence: [`branch ${r.branch}@${String(r.branchSha || '').slice(0, 12)} -> ${c.target}`, `floor: ${ok ? 'passed' : reasons.join('; ') || 'failed'}`, `files: ${f.files?.length ?? 0}${f.docsOnly ? ' (docs-only)' : ''}`],
      confidence: Number.isFinite(e?.decision?.confidence) ? e.decision.confidence : null, rollback: 'git revert -m 1 <merge commit> on the target branch (queued through the lane)',
      session: r.session, repo: r.repo, branch: r.branch, target: c.target, request: r.id, ...(ok ? {} : { reasons }) });
  }
  function journalDeploy(r, c, o) {
    jr({ decision_id: `lane-deploy-${r.id}`, kind: 'deploy', ts: iso(), question: `Deploy ${r.branch} (${String(r.sha || '').slice(0, 12)}) to ${o.env}?`, chosen: 'deploy',
      rationale: `the merge ${String(r.sha || '').slice(0, 12)} passed the lane's tests${r.ci === 'success' ? ' and CI' : ''}; this repo deploys every merge`, evidence: [`env ${o.env} scope ${o.scope} ref ${c.target}@${String(r.sha || '').slice(0, 12)}`],
      confidence: null, rollback: o.rollback || 'deploy the previous release', session: r.session, repo: r.repo, branch: r.branch, env: o.env, scope: o.scope, ref: c.target, sha: r.sha, request: r.id });
  }

  // Q199: the additive-migration merge the manager attested is a decision of its own, in the owner's "Decided for you" feed.
  function journalMigration(r, c, e) {
    const m = e?.migration;
    if (!m?.allowed || !m.files?.length) return;
    jr({ decision_id: `lane-migration-${r.id}${r.attempt > 1 ? `-${r.attempt}` : ''}`, kind: 'merge', ts: iso(),
      question: `Merge additive migration ${m.files.join(', ')}?`, chosen: 'approve',
      rationale: `Q199 (owner 2026-10-20, narrowed 2026-10-21): the migration floor goes by effect. These files only add objects (CREATE TABLE / CREATE INDEX / ADD COLUMN), which can always be applied and merged; the session applies them itself. A destructive or unreadable migration still returns to the owner`,
      evidence: [`migration files: ${m.files.join(', ')}`, 'effect: additive only (no DROP, ALTER ... TYPE/RENAME, or data writes)', ...(m.attestedCheck ? ['ALTER TABLE ... ADD CONSTRAINT ... CHECK read as additive only because the request attests migrationApplied'] : []), ...(r.migrationApplied ? [`attestation (not required): migrationApplied (${r.migrationAppliedBy || r.approvedBy || 'manager'})`] : [])],
      confidence: null, reversible: true, migrationAdditive: true, ...(r.migrationApplied ? { migrationApplied: true } : {}), ...(m.attestedCheck ? { attestedCheck: true } : {}), migrationFiles: m.files, rollback: 'git revert -m 1 <merge commit> on the target branch (queued through the lane)',
      approvedBy: r.approvedBy, session: r.session, repo: r.repo, branch: r.branch, target: c.target, request: r.id });
  }

  // Every file the lane knows how to resolve on conflict: the repo's conventions plus its union / regenerate files. The
// merge floor sees them as resolvable, so a collision on them does not return the request before the merge step runs.
const resolvable = (c) => [...new Set([...c.conventions, ...(c.unionFiles || []), ...(c.regenerate || []).flatMap((g) => g.files)])];

  // The merge floor against the current remote target. Re-run whenever the target moved (a re-merge), not only once.
  async function evaluate(r, c) {
    const ev = await step(r, 'evaluate', async () => {
      const e = await mergeEval({ cwd: c.clone, branch: r.branch, branchSha: r.branchSha, target: c.target, remote: c.remote, conventionFiles: resolvable(c), repo: r.repo, session: r.session, approveInfra: !!r.approvedBy, migrationApplied: !!r.migrationApplied, optOut: optOutList() });
      const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
      // The evaluation is the lane's review: recorded as evidence (source: floor, or jev/reasoning when mergeEval reports its decision).
      r.review = { pass: e?.verdict === 'merge', source: e?.decision?.source || 'floor', confidence: Number.isFinite(e?.decision?.confidence) ? e.decision.confidence : null, at: iso() };
      journalVerdict(r, c, e, reasons);
      if (e?.verdict === 'merge') journalMigration(r, c, e);
      return { ok: e?.verdict === 'merge', tail: reasons.join('\n'), info: { reasons, infra: e?.infra?.only ? e.infra.files : null } };
    });
    if (!ev.ok && ev.info.infra) {
      const paths = ev.info.infra;
      const st = await G(r, c, ['diff', '--stat', `${c.remote}/${c.target}...${r.branchSha}`]);
      const stat = tailOf(st.out || st.err || '');
      const reason = `needs manager approval: touches CI/deploy/infra paths: ${paths.join(', ')}`;
      try { managerItem({ kind: 'merge', id: r.id, repo: r.repo, branch: r.branch, session: r.session, paths, diffStat: stat, text: `${reason}\n${stat}\nApprove: integrate request ${r.branch} --repo ${r.repo} --approved-by manager` }); } catch (err) { log('manager item failed', err?.message); }
      throw new Ret(reason, stat, { outcome: 'needs_approval', infraPaths: paths, reasons: ev.info.reasons });
    }
    if (!ev.ok) throw new Ret(`merge evaluation: ${ev.info.reasons.join('; ') || 'not mergeable'}`, ev.tail, { reasons: ev.info.reasons });
  }

  // Merge the branch into the current remote target, test it, push it. Throws Ret to return the request.
  async function mergeAndPush(r, c, branchSha) {
    for (let attempt = 0; attempt < MAX_PUSH_TRIES; attempt++) {
      r.attempt = attempt + 1;
      if (attempt > 0) { await fetch(r, c); if (!r.revertOf) await evaluate(r, c); }
      const targetSha = await rev(r, c, `${c.remote}/${c.target}`);
      if (!targetSha) throw new Ret(`target ${c.remote}/${c.target} not found`);
      r.targetBase = targetSha;
      if (r.revertOf && (await G(r, c, ['merge-base', '--is-ancestor', r.revertOf, targetSha])).code !== 0) throw new Ret(`the merge ${r.revertOf.slice(0, 12)} is not on ${c.remote}/${c.target}: nothing to revert`);
      if (!r.revertOf && (await G(r, c, ['merge-base', '--is-ancestor', branchSha, targetSha])).code === 0) { r.alreadyMerged = true; r.sha = targetSha; r.pushed = true; return; }
      const wt = wtPath(r);
      await dropWorktree(r, c);
      try {
        await step(r, 'worktree', async () => {
          fs.mkdirSync(path.dirname(wt), { recursive: true });
          const x = await G(r, c, ['worktree', 'add', '--detach', wt, targetSha]);
          return { ok: x.code === 0, tail: x.err };
        });
        if (!fs.existsSync(wt)) throw new Ret('could not create a worktree', '');
        const msg = `Merge ${r.branch} into ${c.target} (integration ${r.id})`;
        const m = await step(r, 'merge', async () => {
          if (r.revertOf) {   // a lane revert (owner's one-tap undo): revert the merge commit on the current target, then test and push like a merge
            const y = await git([...ident, 'revert', '-m', '1', '--no-edit', r.revertOf], { cwd: wt, timeoutMs: 120_000 });
            if (y.code !== 0) await git(['revert', '--abort'], { cwd: wt });
            return { ok: y.code === 0, tail: y.err || y.out, info: { error: true } };
          }
          const x = await git([...ident, 'merge', '--no-ff', '--no-edit', '-m', msg, branchSha], { cwd: wt, timeoutMs: 120_000 });
          if (x.code === 0) {
            const e = await enforceConventions(r, c, wt, { branchSha, targetSha, msg });
            if (!e.ok) return { ok: false, tail: e.tail, info: { error: true, convention: e.files } };
            return { ok: true, info: { conflicts: [], fixed: e.files, resolved: e.files.length ? c.conventionResolver : null } };
          }
          const u = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: wt });
          const files = u.out.split('\0').filter(Boolean);
          if (!files.length) { await git(['merge', '--abort'], { cwd: wt }); return { ok: false, tail: x.err || x.out, info: { error: true } }; }
          // Shared files the repo configures resolve here; a conflict in anything else still returns the request.
          const conv = files.filter((f) => isConvention(f, c.conventions));
          const groups = classify(c, files.filter((f) => !conv.includes(f)));
          if (!groups.other.length) {
            let fine = conv.length ? await resolveConventions(r, c, wt, conv) : true;
            if (fine && groups.union.length) fine = await resolveUnion(wt, groups.union);
            const reg = fine && groups.regenerate.length ? await resolveRegenerate(c, wt, groups.regenerate) : { ok: true };
            fine = fine && reg.ok;
            const labels = [conv.length && `${conv.join(', ')} (${c.conventionResolver})`, groups.union.length && `${groups.union.join(', ')} (union)`,
              groups.regenerate.length && `${groups.regenerate.flatMap((g) => g.files).join(', ')} (regenerate)`].filter(Boolean);
            if (fine && (await git([...ident, 'commit', '--no-edit', '-m', `${msg}; resolved ${labels.join(', ')}`], { cwd: wt })).code === 0) {
              const e = await enforceConventions(r, c, wt, { branchSha, targetSha, msg });   // a second convention file may have merged cleanly
              if (!e.ok) return { ok: false, tail: e.tail, info: { error: true, convention: e.files } };
              return { ok: true, info: { conflicts: files, resolved: labels.join(', '), fixed: e.files } };
            }
            if (!reg.ok) return { ok: false, tail: reg.tail, info: { error: true, regenerate: groups.regenerate.flatMap((g) => g.files) } };
          }
          await git(['merge', '--abort'], { cwd: wt });
          return { ok: false, tail: files.join('\n'), info: { conflicts: files } };
        });
        if (!m.ok) {
          const files = m.info?.conflicts || [];
          if (m.info?.convention) throw new Ret(`could not restore ${m.info.convention.join(', ')} to the target's version`, m.tail, { conflicts: m.info.convention });
          if (m.info?.regenerate) throw new Ret(`could not regenerate ${m.info.regenerate.join(', ')}`, m.tail, { conflicts: m.info.regenerate });
          if (m.info?.error) throw new Ret(r.revertOf ? 'revert failed' : 'merge failed', m.tail);
          throw new Ret(`merge conflict outside convention files: ${files.join(', ')}`, m.tail, { conflicts: files });
        }
        const sha = await rev(r, c, 'HEAD', wt);
        r.sha = sha; r.mergeSha = sha; persist(r);
        // a fresh worktree has no node_modules: install from the lockfile so the test command can be plain `npm test`
        if (c.test && fs.existsSync(path.join(wt, 'package-lock.json'))) {
          const i = await step(r, 'install', async (setLive) => {
            const res = await run(INSTALL_CMD, { cwd: wt, timeoutMs: c.testTimeoutMin * 60_000, onData: setLive, env: { CI: '1' } });
            return { ok: res.code === 0 && !res.timedOut, tail: res.out, info: { code: res.code, timedOut: !!res.timedOut } };
          });
          if (!i.ok) throw new Ret(i.info?.timedOut ? `${INSTALL_CMD} timed out` : `${INSTALL_CMD} failed (exit ${i.info?.code})`, r.steps.at(-1).tail);
        }
        if (c.test) {
          const t = await step(r, 'test', async (setLive) => {
            const res = await run(c.test, { cwd: wt, timeoutMs: c.testTimeoutMin * 60_000, onData: setLive,
              env: { GHOSTY_STATE_DIR: path.join(dir, 'tmp', r.id), CI: '1', V2_BASE_SHA: targetSha } });   // tests what the merge touches; full suite nightly (scripts/test-run.js)
            fs.rmSync(path.join(dir, 'tmp', r.id), { recursive: true, force: true });
            const ok = res.code === 0 && !res.timedOut;
            const f = ok ? { tail: res.out, failing: [] } : testFailure(res.out);
            return { ok, tail: f.tail, bounded: !ok, info: { code: res.code, timedOut: !!res.timedOut, failing: f.failing } };
          });
          const failing = t.info?.failing || [];
          const names = failing.length ? `: ${failing.length} failing: ${failing.slice(0, 3).map((n) => n.slice(0, 80)).join('; ')}${failing.length > 3 ? '; …' : ''}` : '';
          if (!t.ok) throw new Ret(t.info?.timedOut ? `tests timed out after ${c.testTimeoutMin} min` : `tests red (exit ${t.info?.code})${names}`, r.steps.at(-1).tail, failing.length ? { failing } : {});
        }
        if (c.deploy?.kind === 'self') {
          // this repo restarts the service that runs the lane: a merge that does not even parse is never pushed
          const k = await step(r, 'precheck', async () => {
            const res = await run(`${sq(process.execPath)} --check server.js`, { cwd: wt, timeoutMs: 60_000 });
            return { ok: res.code === 0 && !res.timedOut, tail: res.out, info: { code: res.code } };
          });
          if (!k.ok) throw new Ret('node --check server.js failed on the merge', r.steps.at(-1).tail);
        }
        const p = await step(r, 'push', async () => {
          // compare-and-swap: only if the remote target is still the commit the merge was built on (never clobber a rewind or a newer push)
          const x = await G(r, c, ['push', '--porcelain', `--force-with-lease=refs/heads/${c.target}:${targetSha}`, c.remote, `${sha}:refs/heads/${c.target}`], { timeoutMs: 120_000 });
          const f = await G(r, c, ['fetch', '--prune', c.remote]);
          if (f.code !== 0) {   // cannot read the result by fetching: ask the remote itself before deciding anything
            const tip = await knownTip(r, c);
            if (tip === sha) return { ok: true, info: { rejected: false } };
            return { ok: false, tail: x.err || x.out, info: { moved: tip !== targetSha } };
          }
          if (await contains(r, c, sha)) return { ok: true, info: { rejected: false } };   // the remote is the truth, whatever push said
          const now = await rev(r, c, `${c.remote}/${c.target}`);
          return { ok: false, tail: x.err || x.out, info: { moved: now !== targetSha } };   // lease rejected / target changed: re-merge onto it
        });
        if (p.ok) { r.pushed = true; persist(r); return; }
        if (!p.info.moved) throw new Ret('push failed', p.tail);
        log('target moved, re-merging', r.id);
      } finally { await dropWorktree(r, c); }
    }
    throw new Ret('target keeps moving: gave up after 3 attempts');
  }

  async function waitCi(r, c) {
    const impl = ci || createGithubCi({ git });
    const deadline = now() + c.ciTimeoutMin * 60_000;
    const res = await step(r, 'ci', async () => {
      let last = 'unknown';
      for (;;) {
        let s; try { const v = await impl.status(r.sha, { repo: r.repo, clone: c.clone, remote: c.remote }); s = typeof v === 'string' ? v : v?.status; } catch { s = 'unknown'; }
        if (s !== last) { last = s; r.ci = s; persist(r); }
        if (s === 'success' || s === 'failure') return { ok: s === 'success', info: { status: s }, tail: `CI ${s} for ${r.sha.slice(0, 12)}` };
        if (stopped) throw new Ret('lane stopped');
        if (now() >= deadline) return { ok: false, info: { status: last, timedOut: true }, tail: `CI still ${last} after ${c.ciTimeoutMin} min` };
        await sleep(pollMs);
      }
    });
    return res;
  }

  async function doDeploy(r, c) {
    if (!deploys) throw new Ret('no deploy adapter');
    const res = await step(r, 'deploy', async () => {
      try {
        // a crash between the request and the saved id would re-request: look the deploy up by its agent first
        if (!r.deployId && deploys.find) { const id = await deploys.find({ agent: `integration:${r.id}` }).catch(() => null); if (id) { r.deployId = id; persist(r); } }
        if (!r.deployId) {
          const q = await deploys.request({ env: c.deploy.env, scope: r.deployScope, ref: r.sha || c.target, sha: r.sha, agent: `integration:${r.id}` });
          if (!q?.id) return { ok: false, tail: q?.error ?? q?.reason ?? 'deploy request refused' };
          r.deployId = q.id; persist(r);
        }
        const w = await deploys.wait(r.deployId);
        r.deployVersion = w?.version ?? null;
        r.deployed = w?.ok === true ? { id: r.deployId, version: r.deployVersion, env: c.deploy.env, scope: r.deployScope } : null;
        return { ok: w?.ok === true, tail: w?.ok === true ? `deployed ${r.deployVersion ?? ''}` : (w?.error || w?.tail || w?.reason || w?.state || 'deploy failed'), info: { id: r.deployId } };
      } catch (e) { return { ok: false, tail: `deploy error: ${e?.message}` }; }   // the merge is on the target: report, never throw
    });
    return res;
  }

  // ---- self deploy: the repo of this very service (deploy.kind 'self') ------------------------------------------------
  // After the merge is on the target: refuse on tracked edits in the live checkout, pull --ff-only, npm ci when the lockfile
  // changed, node --check, then the request is marked deployed and persisted, and only then safe-restart.sh is launched
  // (outside the service). A request marked done is never resumed. Nothing is reset or reverted here; a failure after the
  // pull carries a rollback line for the manager. A refusal or failure is a deploy_failed final state, which the notify
  // layer raises as a high-priority manager event.
  const short = (s) => String(s || '').slice(0, 12);
  const restartFiles = (r) => ({ log: path.join(dir, 'restart', `${r.id}.log`), exit: path.join(dir, 'restart', `${r.id}.exit`), pid: path.join(dir, 'restart', `${r.id}.pid`) });
  // The request whose safe-restart waiter was launched by the lane and has not exited (no .exit file, process alive), read from the
  // persisted requests so a lane restart keeps it. A waiter launched a moment ago may not have written its pid file yet (60 s grace).
  const pendingWaiter = (self) => [...reqs.values()].find((x) => {
    const s = x.selfDeploy;
    if (x.id === self || s?.restart !== 'scheduled' || !s.exit || fs.existsSync(s.exit)) return false;
    return fs.existsSync(s.pid || '') ? pidAlive(s.pid) : Date.now() - Date.parse(s.restartAt) < 60_000;
  }) || null;
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  function selfFail(r, outcome, reason, tail = '') {
    const sd = r.selfDeploy;
    sd.phase = 'done'; sd.outcome = outcome;
    const moved = sd.prevSha && sd.newSha && sd.prevSha !== sd.newSha;
    transition(r, 'deploy_failed', { reason, tail: tailOf(tail), rollback: moved ? sd.rollback : null });
  }
  function selfDone(r) {
    const sd = r.selfDeploy;
    sd.phase = 'done'; sd.outcome = 'deployed';
    r.deployed = { id: null, version: short(sd.newSha), env: 'live', scope: 'self', previous: sd.prevSha };
    journalDeploy(r, repoCfg(r.repo), { env: 'live', scope: 'self', rollback: sd.prevSha !== sd.newSha ? sd.rollback : null });
    transition(r, 'deployed', { reason: null, rollback: sd.prevSha !== sd.newSha ? sd.rollback : null });
    return lastTold;
  }

  async function selfDeploy(r, c) {
    const live = c.deploy.liveCheckout;
    const L = (args, o) => git(args, { cwd: live, timeoutMs: 120_000, ...o });
    const prior = r.selfDeploy?.prevSha || null;   // resumed mid-deploy: the service still runs the sha seen first
    const sd = r.selfDeploy = { phase: 'checking', live, prevSha: null, newSha: null, expectedSha: null, outcome: null, rollback: null };
    persist(r);
    const chk = await step(r, 'deploy-check', async () => {
      const head = await rev(r, c, 'HEAD', live);
      if (!head) return { ok: false, tail: `${live} is not a git checkout` };
      const st = await L(['status', '--porcelain', '--untracked-files=no']);
      if (st.code !== 0) return { ok: false, tail: st.err || st.out };
      const dirty = st.out.split('\n').filter(Boolean).map((l) => l.slice(3));
      const branch = (await L(['symbolic-ref', '-q', '--short', 'HEAD'])).out.trim();
      return { ok: !dirty.length && branch === c.target, tail: dirty.join('\n'), info: { head, dirty, branch } };
    });
    const ci = chk.info || {};
    if (ci.dirty?.length) return selfFail(r, 'deploy_refused', `deploy refused: the live checkout ${live} has uncommitted changes to tracked files: ${ci.dirty.slice(0, 10).join(', ')}${ci.dirty.length > 10 ? ', …' : ''}`, chk.tail);
    if (!chk.ok) return selfFail(r, 'deploy_refused', ci.head ? `deploy refused: the live checkout ${live} is on ${ci.branch || 'a detached HEAD'}, not ${c.target}` : `deploy refused: ${chk.tail || 'cannot read the live checkout'}`, chk.tail);
    sd.prevSha = prior || ci.head;
    // Never reset --hard: detach the live checkout on the previous sha, then revert the merge on the target through the lane.
    sd.rollback = `git -C ${live} checkout --detach ${short(sd.prevSha)} && cd ${live} && scripts/safe-restart.sh; then revert on ${c.target} through the lane: git revert -m 1 ${short(r.mergeSha)}`;
    persist(r);

    const pull = await step(r, 'deploy-pull', async () => {
      // exactly the tested merge: never whatever the target is now (it may carry commits nobody tested)
      if (!r.sha) return { ok: false, tail: 'the request has no merge sha' };
      const f = await L(['fetch', '-q', c.remote], { timeoutMs: 180_000 });
      if (f.code !== 0) return { ok: false, tail: f.err || f.out };
      if ((await L(['merge-base', '--is-ancestor', r.sha, `${c.remote}/${c.target}`])).code !== 0) return { ok: false, tail: `${c.remote}/${c.target} no longer contains the tested merge ${short(r.sha)} (rewound or rewritten)` };
      const x = await L(['merge', '--ff-only', '-q', r.sha], { timeoutMs: 180_000 });
      return { ok: x.code === 0, tail: x.err || x.out };
    });
    if (!pull.ok) return selfFail(r, 'deploy_refused', `deploy refused: could not fast-forward ${live} to the tested merge ${short(r.sha)}`, pull.tail);
    sd.newSha = await rev(r, c, 'HEAD', live); persist(r);
    if (r.sha && (await L(['merge-base', '--is-ancestor', r.sha, 'HEAD'])).code !== 0) {
      return selfFail(r, 'deploy_failed', `the live checkout pulled ${short(sd.newSha)}, which does not contain the merge ${short(r.sha)}: not restarted`);
    }

    if (sd.newSha !== sd.prevSha && (await L(['diff', '--name-only', sd.prevSha, sd.newSha, '--', 'package-lock.json'])).out.trim()) {
      const inst = await step(r, 'deploy-install', async (setLive) => {
        const res = await run(INSTALL_CMD, { cwd: live, timeoutMs: 15 * 60_000, onData: setLive });
        return { ok: res.code === 0 && !res.timedOut, tail: res.out };
      });
      if (!inst.ok) return selfFail(r, 'install_failed', `${INSTALL_CMD} failed in ${live} at ${short(sd.newSha)}: NOT restarted, the service still runs ${short(sd.prevSha)}`, inst.tail);
    }

    const syn = await step(r, 'deploy-syntax', async () => {
      const res = await run(`${sq(process.execPath)} --check server.js`, { cwd: live, timeoutMs: 60_000 });
      return { ok: res.code === 0 && !res.timedOut, tail: res.out };
    });
    if (!syn.ok) return selfFail(r, 'check_failed', `node --check server.js FAILED in ${live} at ${short(sd.newSha)}: NOT restarted, the service still runs ${short(sd.prevSha)}`, syn.tail);

    // The restart is the LAST step and ends this process: the request is marked done (deployed), persisted and told (feed,
    // manager event, session notice) first, so the restart can neither lose nor re-run it. A launch failure is recorded as
    // `restartError` and raised as a manager item; the outcome stays `deployed`.
    // One waiter: a safe-restart this lane launched that is still waiting restarts into whatever the live checkout holds then,
    // which is the sha pulled just now, so no second waiter is launched.
    const pw = pendingWaiter(r.id);
    if (pw) {
      Object.assign(sd, { expectedSha: sd.newSha, restartAt: iso(), restart: 'coalesced', restartWaiter: pw.id, note: `restart pending (coalesced with ${pw.id})` });
      const told = selfDone(r);
      await Promise.race([told, new Promise((res) => setTimeout(res, 15_000).unref?.())]);
      return;
    }
    const f = restartFiles(r);
    fs.mkdirSync(path.dirname(f.log), { recursive: true, mode: 0o700 });
    fs.rmSync(f.exit, { force: true }); fs.rmSync(f.log, { force: true }); fs.rmSync(f.pid, { force: true });
    Object.assign(sd, { expectedSha: sd.newSha, restartAt: iso(), restart: 'scheduled', note: 'restart scheduled via safe-restart', ...f });
    const told = selfDone(r);
    await Promise.race([told, new Promise((res) => setTimeout(res, 15_000).unref?.())]);   // the notice goes out before the service stops
    const x = await Promise.resolve(restart({ cwd: live, waitMin: c.deploy.restartWaitMin, log: f.log, exit: f.exit, pid: f.pid })).catch((e) => ({ ok: false, error: e?.message }));
    if (x?.ok === true) return;
    const err = redact(String(x?.error || 'launch failed')).slice(0, 300);
    sd.restart = 'launch_failed'; r.restartError = err; r.updatedAt = iso(); persist(r);
    log('self deploy restart launch failed', r.id, err);
    try {
      Promise.resolve(managerItem({ key: `integration:${r.id}:restart-error`, title: `Integration ${r.id}: live restart NOT launched`, priority: 'high',
        body: `${short(sd.newSha)} is pulled and checked in ${live} but scripts/safe-restart.sh could not be launched (${err}). The service still runs ${short(sd.prevSha)}; restart it with scripts/safe-restart.sh.`.slice(0, 600), url: '/?integration=1' })).catch((e) => log('manager item failed', e?.message));
    } catch (e) { log('manager item failed', e?.message); }
  }

  async function processRequest(r) {
    const c = repoCfg(r.repo);
    if (!c) { transition(r, 'returned', { reason: `repo ${r.repo} is not configured` }); return; }
    if (r.state === 'queued') { r.startedAt = iso(); r.steps = []; r.attempt = 0; transition(r, 'running', {}, {}); }
    else { r.resumed = (r.resumed || 0) + 1; emit(r, { kind: 'resumed', state: 'running', final: false }); }
    try {
      if (!r.pushed) {
        // restart check: a recorded merge may already be on the remote (the push step finished but was not recorded)
        if (r.mergeSha) {
          let landed = false;
          try { await fetch(r, c); landed = await contains(r, c, r.mergeSha); } catch (e) { if (!(e instanceof Ret)) throw e; landed = (await knownTip(r, c)) === r.mergeSha; }   // fetch down: read the remote tip
          if (landed) { r.pushed = true; r.sha = r.mergeSha; persist(r); }
        }
      }
      if (!r.pushed && r.revertOf) { await fetch(r, c); await mergeAndPush(r, c, null); }
      else if (!r.pushed) {
        await fetch(r, c);
        const branchSha = await step(r, 'resolve', async () => {
          if (r.branch === c.target) return { ok: false, tail: 'the branch is the target' };
          const sha = await rev(r, c, `${c.remote}/${r.branch}`);
          return { ok: !!sha, tail: sha ? '' : `${c.remote}/${r.branch} does not exist (push the branch first)`, info: { sha } };
        });
        if (!branchSha.ok) throw new Ret(branchSha.tail);
        r.branchSha = branchSha.info.sha;
        const alreadyIn = (await G(r, c, ['merge-base', '--is-ancestor', r.branchSha, `${c.remote}/${c.target}`])).code === 0;
        if (!alreadyIn) {
          // A V2 task branch merges only with the owner's SHA-bound integration grant in the task store (OWNER_DECISIONS §11.1); no store, no merge.
          const tm = TASK_BRANCH_RE.exec(r.branch);
          if (tm && !(taskGrant && await Promise.resolve(taskGrant(tm[1], r.branchSha)).catch(() => false))) throw new Ret(`${r.branch} at ${r.branchSha.slice(0, 12)}: no integration grant for this SHA in the V2 task store; the owner approves the merge of this exact SHA first`);
          await evaluate(r, c);
        }
        await mergeAndPush(r, c, r.branchSha);
      }
      // from here the merge is on the target: nothing below returns the request or reverts anything
      if (c.ci && !(r.ci === 'success')) {
        const ciRes = await waitCi(r, c);
        if (!ciRes.ok) { transition(r, 'merged_ci_red', { reason: ciRes.info?.timedOut ? `CI did not finish: ${ciRes.tail}` : 'CI red on the merge commit', tail: ciRes.tail }); return; }
      }
      // a re-request of a branch that was already on the target changes nothing: it does not restart the service unless --deploy was explicit
      if (r.alreadyMerged && !r.deployExplicit) { transition(r, 'merged', { reason: null }); return; }
      if (c.deploy?.kind === 'self') { await selfDeploy(r, c); return; }
      if (r.deployScope) {
        const d = await doDeploy(r, c);
        if (!d.ok) { transition(r, 'deploy_failed', { reason: `deploy failed: ${d.tail}`, tail: d.tail }); return; }
        journalDeploy(r, c, { env: c.deploy.env, scope: r.deployScope });
        transition(r, 'deployed', { reason: null }); return;
      }
      transition(r, 'merged', { reason: null });
    } catch (e) {
      if (e instanceof Ret) {
        if (e.reason === 'lane stopped') { /* leave running: resumed at next start */ }
        else if (r.pushed) transition(r, 'merged', { reason: null, warning: e.reason, tail: e.tail });
        else transition(r, 'returned', { reason: e.reason, tail: e.tail, ...(e.extra || {}) });
      } else {
        log('lane error', r.id, e?.stack || e);
        if (r.pushed) transition(r, 'merged', { warning: `lane error after push: ${redact(e?.message)}`, tail: tailOf(e?.message) });
        else transition(r, 'returned', { reason: `lane error: ${redact(e?.message)}`, tail: tailOf(e?.message) });
      }
    }
  }

  // Approval identity (2026-10-20): only a manager session may claim an approval. A working session once approved its own
  // update_core change by passing `--approved-by manager`; the claim is now checked against the requesting session's name.
  // Without `managerSessions` (tests, older wiring) every caller is treated as the manager: today's behaviour, unchanged.
  const isManagerSession = (session) => {
    if (!managerSessions) return true;
    let names; try { names = managerSessions(); } catch { return false; }
    return Array.isArray(names) && !!session && names.includes(session);
  };
  // Tell the manager once that a session tried to approve for it. One event per request id: a re-request that repeats the same
  // claim (a coalesce while queued) must not fill the feed.
  function managerItemRefusal(r, refused) {
    const who = refused.session || 'an unnamed session';
    try {
      Promise.resolve(managerItem({ key: `lane:self-approval:${r.id}`,
        title: `${who} passed --approved-by on ${r.branch}`,
        body: `${who} asked for the merge floor to be skipped (approval: ${refused.by}), but only a manager session may approve. The approval was ignored: the request is queued and evaluated as if none was given, so an infra-path or migration floor still returns it. Ask the manager to approve it from a manager session.`,
        priority: 'high', url: '/?integration=1' })).catch((e) => log('manager item failed', e?.message));
    } catch (e) { log('manager item failed', e?.message); }
  }
  // Apply one approval claim (--approved-by / --migration-applied) to a request: honoured -> approvedBy / migrationApplied are
  // written, refused -> they are left unset (so a floor still returns the request) and the attempt is stored as approvalRefused.
  // A request that no longer carries a claim loses the one it had, exactly as before. `claim` is the session making this claim
  // (null when the caller named none): the gate reads it, not the session stored on an earlier request, so a session-less
  // caller cannot ride on the manager's name.
  // -> { honoured: boolean, refused: boolean }
  function applyApproval(r, input, claim) {
    const who = claim == null ? null : String(claim);
    const by = input.approvedBy ? String(input.approvedBy).slice(0, 80) : null;
    const wantsMigration = !!input.migrationApplied;
    if (!by && !wantsMigration) {
      delete r.approvedBy; delete r.approvedAt; delete r.migrationApplied; delete r.migrationAppliedBy; delete r.migrationAppliedAt; delete r.approvalRefused;
      return { honoured: false, refused: false };
    }
    if (!isManagerSession(who)) {
      delete r.approvedBy; delete r.approvedAt; delete r.migrationApplied; delete r.migrationAppliedBy; delete r.migrationAppliedAt;
      const same = r.approvalRefused && r.approvalRefused.by === (by || 'migration-applied') && r.approvalRefused.session === who;
      r.approvalRefused = { by: by || 'migration-applied', session: who, at: iso() };
      if (!same) managerItemRefusal(r, r.approvalRefused);
      return { honoured: false, refused: true };
    }
    delete r.approvalRefused;
    if (by) { r.approvedBy = by; r.approvedAt = iso(); } else delete r.approvedBy;
    if (wantsMigration) { r.migrationApplied = true; r.migrationAppliedBy = by; r.migrationAppliedAt = iso(); }
    else delete r.migrationApplied;
    return { honoured: !!by, refused: false };
  }

  // A second request for a branch whose request is still queued updates that entry: same id, same queue position, the newest tip,
  // the notes appended, the widest deploy scope and the newest manager flags. A coalesce restarts the settle window.
  function coalesce(r, input, v) {
    const note = input.note ? String(input.note).slice(0, 500) : null;
    if (note) {
      const parts = [r.note, note].filter(Boolean).flatMap((n) => String(n).split('\n')).map((l) => l.trim()).filter(Boolean);
      const merged = [...new Set(parts)].join('\n');
      r.note = merged.length > 500 ? `…${merged.slice(merged.length - 499)}` : merged;
    }
    if (v.explicit || !r.deployScope) { r.deployScope = v.deployScope; r.deployExplicit = r.deployExplicit || v.explicit; }
    else if (v.deployScope && (SCOPE_WIDTH[v.deployScope] ?? 0) > (SCOPE_WIDTH[r.deployScope] ?? 0)) r.deployScope = v.deployScope;   // the wider scope wins
    // --approved-by / --migration-applied attest to a request; the newest one wins, and a request that no longer carries one loses it.
    if (v.session && !r.session) r.session = v.session;
    if (v.worktree && !r.worktree) r.worktree = v.worktree;
    const wasApproved = r.approvedBy;
    const ap = applyApproval(r, input, input.session);
    r.head = /^[0-9a-f]{7,64}$/.test(String(input.sha || '')) ? String(input.sha) : null;   // the caller's tip; the lane re-reads it from the remote
    r.settleUntil = settleUntilOf(v.key);
    markBehind(r);
    r.coalesced = (r.coalesced || 0) + 1;
    r.updatedAt = iso();
    persist(r);
    emit(r, { kind: 'coalesced', state: 'queued', final: false, coalesced: true, position: ahead(r) + 1 });
    if (ap.honoured && r.approvedBy !== wasApproved) { try { journalApproval(r, v); } catch (e) { log('journal failed', e?.message); } }
    armSettle(v.key, settleLeft(r));
    kick(v.key);
    return { id: r.id, position: ahead(r) + 1, repo: v.key, coalesced: true, duplicate: true, ...(ap.refused ? { approvalIgnored: true, approvalRefused: r.approvalRefused } : {}) };
  }
  // The approval decision record for --approved-by (OWNER_DECISIONS §15); enqueue and a coalesce both write one.
  function journalApproval(r, v) {
    journal({ kind: 'merge', decision_id: `merge-approval-${r.id}`, ts: r.approvedAt, source: 'integration-lane', question: `Approve the infra-path floor reason for ${v.branch} into ${v.target}?`,
      chosen: 'approve', approvedBy: r.approvedBy, approvedAt: r.approvedAt, rationale: 'a manager approval skips only the CI/deploy/infra-path floor reason; secrets, migrations, sudoers, units, red tests and conflicts still return the request',
      request: r.id, repo: v.key, branch: v.branch, target: v.target });
  }

  // The next queued request for a repo whose settle window has ended; null while the head one is still settling.
  function nextQueued(repo) { return [...reqs.values()].find((x) => x.repo === repo && x.state === 'queued' && settled(x)) || null; }
  // How long until the head queued request for a repo may be picked (0 when one is ready).
  const settleWait = (repo) => { const head = [...reqs.values()].find((x) => x.repo === repo && x.state === 'queued'); return head ? settleLeft(head) : 0; };
  function kick(repo) {
    if (stopped || !started || workers.has(repo)) return;
    const p = (async () => {
      // a resumed running request first, then FIFO
      for (;;) {
        if (stopped) return;
        const r = [...reqs.values()].find((x) => x.repo === repo && x.state === 'running') || nextQueued(repo);
        if (!r) { const wait = settleWait(repo); if (wait > 0) armSettle(repo, wait); return; }   // a queued request is still settling
        await processRequest(r);
        if (stopped && !FINAL.includes(r.state)) return;
      }
    })().catch((e) => log('worker died', repo, e?.message)).finally(() => { workers.delete(repo); if (!stopped && (settleWait(repo) <= 0 && nextQueued(repo))) kick(repo); });
    workers.set(repo, p);
  }

  return {
    // Load the log and resume: running requests continue, queued ones start. Safe to call once.
    start() {
      load(); started = true; stopped = false;
      for (const r of reqs.values()) if (r.state === 'running') { r.steps ||= []; }
      for (const repo of new Set([...reqs.values()].filter((x) => x.state === 'queued' || x.state === 'running').map((x) => x.repo))) kick(repo);
      return this;
    },
    // Stop taking work. Does not wait for a step in flight (a hung test must not hang shutdown): await idle() for that.
    stop() { stopped = true; for (const t of settleTimers.values()) clearTimeout(t); settleTimers.clear(); },
    // Resolves when every worker has gone idle (tests, graceful shutdown).
    async idle() { while (workers.size) await Promise.allSettled([...workers.values()]); },
    config: () => cfgAll(),
    repoKeys: () => Object.keys(cfgAll().repos),

    // { repo?, branch, session?, deploy?, note?, by? } -> { id, position, repo }. Throws E_INVALID / E_NOT_FOUND.
    enqueue(input = {}) {
      const { repos } = cfgAll();
      const key = input.repo;
      if (!key || !repos[key]) throw coded(key ? 'E_NOT_FOUND' : 'E_INVALID', key ? `repo ${key} is not configured` : 'repo required');
      const c = repos[key];
      let branch = String(input.branch ?? '').trim().replace(/^refs\/heads\//, '').replace(new RegExp(`^${c.remote}/`), '');
      if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) throw coded('E_INVALID', 'invalid branch name');
      if (branch === c.target) throw coded('E_INVALID', `the branch is the target (${c.target}): work on a branch`);
      let deployScope = null;
      if (input.deploy && c.deploy?.kind !== 'self') {   // a self deploy follows every merge: no scope to ask for
        if (!c.deploy) throw coded('E_INVALID', `repo ${key} has no deploy configured`);
        deployScope = input.deploy === true ? c.deploy.defaultScope : String(input.deploy);
        if (!SCOPES.has(deployScope)) throw coded('E_INVALID', `deploy scope must be one of ${[...SCOPES].join(', ')}`);
      }
      const session = input.session == null ? null : String(input.session).slice(0, 120);
      const worktree = typeof input.worktree === 'string' && path.isAbsolute(input.worktree) ? input.worktree.slice(0, 500) : null;
      // Coalesce (2026-10-20): a second request for a branch whose first is still QUEUED updates that entry instead of queueing a
      // second merge of the same branch (one branch merged 3 times in 3 minutes restarted the target CI three times). Same repo +
      // branch + target only, and never a revert (it merges a different commit by construction).
      const open = [...reqs.values()].find((x) => x.state === 'queued' && x.repo === key && x.branch === branch && x.target === c.target && !x.revertOf);
      if (open) return coalesce(open, input, { key, branch, target: c.target, session, worktree, deployScope, explicit: !!input.deploy });
      const seq = Math.max(0, ...[...reqs.values()].map((x) => x.seq || 0)) + 1;
      const r = { id: `int-${now().toString(36)}${randomBytes(3).toString('hex')}`, seq, repo: key, branch, target: c.target, session,
        deployScope, deployExplicit: !!input.deploy, worktree, note: input.note ? String(input.note).slice(0, 500) : null, by: input.by ? String(input.by).slice(0, 80) : null,
        state: 'queued', createdAt: iso(), updatedAt: iso(), startedAt: null, endedAt: null, step: null, steps: [], reason: null, tail: '',
        sha: null, branchSha: null, ci: null, deployed: null,
        settleUntil: settleUntilOf(key), afterId: null };
      // --approved-by / --migration-applied: honoured only when the requesting session is a manager session (2026-10-20); a claim from
      // any other session is ignored and the request is evaluated as if none was given.
      const ap = applyApproval(r, input, session);
      try {
        const prev = Math.max(0, ...[...reqs.values()].filter((x) => session && x.session === session).map((x) => Date.parse(x.createdAt) || 0));
        const to = now(); r.usage = usage({ stateDir, session, worktree: r.worktree, from: Math.max(prev, to - 864e5), to });
      } catch (e) { log('usage attribution failed', e?.message); }
      reqs.set(r.id, r); markBehind(r); persist(r);
      if (ap.honoured) { try { journalApproval(r, { key, branch, target: c.target }); } catch (e) { log('journal failed', e?.message); } }
      emit(r, { kind: 'queued', state: 'queued', final: false });
      const out = { id: r.id, position: ahead(r) + 1, repo: key, ...(ap.refused ? { approvalIgnored: true, approvalRefused: r.approvalRefused } : {}) };
      kick(key);
      return out;
    },
    // The owner's one-tap revert of a merge the lane made: a request that reverts the merge commit (git revert -m 1) on the target, tests it and
    // pushes it like any merge. -> { id, position, repo }. Throws E_NOT_FOUND / E_INVALID.
    revert(id, { by = null, session = null } = {}) {
      const o = reqs.get(id);
      if (!o) throw coded('E_NOT_FOUND', `unknown request ${id}`);
      if (!o.pushed || !o.mergeSha || o.alreadyMerged || o.revertOf) throw coded('E_INVALID', `request ${id} has no merge commit of its own to revert`);
      const dup = [...reqs.values()].find((x) => x.revertOf === o.mergeSha && (x.state === 'queued' || x.state === 'running'));
      if (dup) return { id: dup.id, position: ahead(dup) + 1, repo: dup.repo, duplicate: true };
      const c = repoCfg(o.repo);
      if (!c) throw coded('E_NOT_FOUND', `repo ${o.repo} is not configured`);
      const seq = Math.max(0, ...[...reqs.values()].map((x) => x.seq || 0)) + 1;
      const r = { id: `int-${now().toString(36)}${randomBytes(3).toString('hex')}`, seq, repo: o.repo, branch: `revert-${o.mergeSha.slice(0, 12)}`, target: c.target, session: session ?? o.session,
        deployScope: null, deployExplicit: false, revertOf: o.mergeSha, revertOfRequest: o.id, worktree: null, note: `revert of ${o.branch} (${o.id})`, by: by ? String(by).slice(0, 80) : null,
        state: 'queued', createdAt: iso(), updatedAt: iso(), startedAt: null, endedAt: null, step: null, steps: [], reason: null, tail: '', sha: null, branchSha: null, ci: null, deployed: null };
      reqs.set(r.id, r); persist(r);
      emit(r, { kind: 'queued', state: 'queued', final: false });
      const out = { id: r.id, position: ahead(r) + 1, repo: r.repo };
      kick(r.repo);
      return out;
    },
    get: (id) => (reqs.has(id) ? view(reqs.get(id)) : null),
    // Newest first. state: one state or a comma list or an array.
    list({ repo, state, limit = 50 } = {}) {
      const states = state ? (Array.isArray(state) ? state : String(state).split(',')) : null;
      return [...reqs.values()].filter((x) => (!repo || x.repo === repo) && (!states || states.includes(x.state))).sort((a, b) => b.seq - a.seq)
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(view);
    },
    // Long-poll: resolves with the request when it is final or after timeoutMs.
    wait(id, timeoutMs = 30_000) {
      const r = reqs.get(id);
      if (!r) return Promise.resolve(null);
      if (FINAL.includes(r.state)) return Promise.resolve(view(r));
      return new Promise((resolve) => {
        const set = waiters.get(id) || new Set(); waiters.set(id, set);
        const done = () => { clearTimeout(t); set.delete(done); if (!set.size) waiters.delete(id); resolve(view(reqs.get(id))); };
        const t = setTimeout(done, timeoutMs);
        set.add(done);
      });
    },
    // Only a queued request can be cancelled; a running one is past the point of a clean stop.
    cancel(id, { by } = {}) {
      const r = reqs.get(id);
      if (!r) throw coded('E_NOT_FOUND', 'no such request');
      if (r.state !== 'queued') throw coded('E_STATE', `request is ${r.state}: only a queued request can be cancelled`);
      transition(r, 'cancelled', { reason: `cancelled${by ? ` by ${String(by).slice(0, 80)}` : ''}` });
      return view(r);
    },
    // Repository key for a remote URL (credentials and .git/ssh spelling ignored), or null.
    async repoForUrl(url) {
      const want = normalizeRemoteUrl(url);
      if (!want) return null;
      for (const c of Object.values(cfgAll().repos)) {
        const u = await git(['remote', 'get-url', c.remote], { cwd: c.clone });
        if (u.code === 0 && normalizeRemoteUrl(u.out) === want) return c.key;
      }
      return null;
    },
    async repoForCwd(cwd) {
      if (!cwd || !path.isAbsolute(String(cwd))) return null;
      const u = await git(['remote', 'get-url', 'origin'], { cwd });
      return u.code === 0 ? this.repoForUrl(u.out) : null;
    },
  };
}
