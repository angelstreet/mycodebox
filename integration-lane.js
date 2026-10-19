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
import { gitFacts, mergeFloor, isConvention } from './merge-policy.js';
import { attribute, readLedgerTail } from './usage-window.js';

export const FINAL = Object.freeze(['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled']);
export const STATES = Object.freeze(['queued', 'running', ...FINAL]);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPES = new Set(['frontend', 'server', 'host', 'full']);   // the deploy queue's scopes
const MAX_PUSH_TRIES = 3;
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
// -> { repos: {key: normalized}, errors: [] }. Unknown keys are ignored; an invalid repo is dropped and reported.
export function validateConfig(raw) {
  const repos = {}, errors = [];
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
    const mins = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    repos[key] = { key, clone: c.clone, remote, target, test: c.test ? c.test.trim() : null, testTimeoutMin: mins(c.testTimeoutMin, 30),
      ci: c.ci ?? null, ciTimeoutMin: mins(c.ciTimeoutMin, 60), deploy, conventions, conventionResolver };
  }
  return { repos, errors };
}
export function loadConfig(stateDir) {
  try { return validateConfig(JSON.parse(fs.readFileSync(path.join(stateDir, 'integration.json'), 'utf8'))); } catch { return { repos: {}, errors: [] }; }
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
// restart({ cwd, waitMin, log, exit }) -> { ok, error? }
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export function restartCommand({ cwd, waitMin, log, exit }) {
  return `cd ${sq(cwd)} && ./scripts/safe-restart.sh --wait ${Number(waitMin) || 0} >${sq(log)} 2>&1; echo $? >${sq(`${exit}.tmp`)} && mv ${sq(`${exit}.tmp`)} ${sq(exit)}`;
}
export function createTmuxRestart({ tmux = process.env.TMUX_BIN || 'tmux' } = {}) {
  return (o) => new Promise((resolve) => {
    const cmd = restartCommand(o);
    if (cmd.includes('#')) { resolve({ ok: false, error: 'a path contains #, which tmux would expand' }); return; }
    execFile(tmux, ['run-shell', '-b', cmd], { timeout: 15_000 }, (e, _o, err) => resolve(e ? { ok: false, error: String(err || e.message).trim().slice(0, 300) } : { ok: true }));
  });
}
// The restarted service answers. -> boolean
export const defaultHealth = (base = `http://127.0.0.1:${Number(process.env.PORT || 7777)}`) => async () => {
  try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; }
};

// Round 7 merge floor with the lane as the tester (its own test run replaces the session's test report).
// `approveInfra` (a manager approval on the request) drops ONLY the CI/deploy/infra-path reason; `infra` tells the lane when that
// was the floor's only reason, so it can ask the manager instead of bouncing the branch.
export async function defaultMergeEval({ cwd, branch, branchSha, target, remote, conventionFiles, approveInfra = false }) {
  const facts = await gitFacts({ cwd, branch, branchSha, target, remote, conventionFiles });
  const files = (facts.sensitive || []).filter((s) => s.why === 'deploy').map((s) => s.file);
  const rest = mergeFloor(facts, { state: 'green' }, { conventionFiles, approveInfra: true });
  const reasons = approveInfra ? rest : mergeFloor(facts, { state: 'green' }, { conventionFiles });
  return { verdict: reasons.length ? 'escalate' : 'merge', reasons, facts, infra: { files, only: !approveInfra && files.length > 0 && rest.length === 0 } };
}

// ---- the lane ----------------------------------------------------------------------------------------------------------
// Per-request attribution (Round 14b, docs/v2/SCORING.md): the requesting session's usage-ledger rows labelled with the session
// in (from, to], where from = the session's previous request (any branch) or 24 h before, whichever is later, and to = the request
// time. Frozen on the request at enqueue. Per session, not per branch: a session on two branches splits by time.
export function sessionUsage({ stateDir, session, from, to }) {
  if (!session) return null;
  const a = attribute(readLedgerTail(path.join(stateDir, 'usage-ledger.jsonl')).filter((r) => r.label === session), from, to);
  return a && { model: a.model, runtime: a.agent, tokens: a.tokens, tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsd: a.costUsd, plan: a.plan, from: new Date(from).toISOString(), to: new Date(to).toISOString(), rule: 'session ledger rows since its previous request (max 24h)' };
}

export function createIntegrationLane({ stateDir, config = null, git = createDefaultGit(), run = createDefaultRun(), ci = null,
  deploys = null, mergeEval = defaultMergeEval, usage = sessionUsage, notify = () => {}, managerItem = () => {}, journal = () => {}, now = () => Date.now(), log = () => {},
  pollMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), restart = createTmuxRestart() } = {}) {
  if (!stateDir) throw coded('E_CONFIG', 'integration lane: stateDir required');
  const dir = path.join(stateDir, 'integration');
  const file = path.join(dir, 'requests.jsonl');
  const reqs = new Map();          // id -> request (insertion = enqueue order)
  const live = new Map();          // id -> { step, tail } (memory only: the running step's output)
  const waiters = new Map();       // id -> Set<fn>
  const workers = new Map();       // repo -> Promise
  let stopped = false, started = false;

  const cfgAll = () => (config ? validateConfig(typeof config === 'function' ? config() : config) : loadConfig(stateDir));
  const repoCfg = (key) => cfgAll().repos[key] || null;
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

  // The merge floor against the current remote target. Re-run whenever the target moved (a re-merge), not only once.
  async function evaluate(r, c) {
    const ev = await step(r, 'evaluate', async () => {
      const e = await mergeEval({ cwd: c.clone, branch: r.branch, branchSha: r.branchSha, target: c.target, remote: c.remote, conventionFiles: c.conventions, repo: r.repo, session: r.session, approveInfra: !!r.approvedBy });
      const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
      // The evaluation is the lane's review: recorded as evidence (source: floor, or jev/reasoning when mergeEval reports its decision).
      r.review = { pass: e?.verdict === 'merge', source: e?.decision?.source || 'floor', confidence: Number.isFinite(e?.decision?.confidence) ? e.decision.confidence : null, at: iso() };
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
      if (attempt > 0) { await fetch(r, c); await evaluate(r, c); }
      const targetSha = await rev(r, c, `${c.remote}/${c.target}`);
      if (!targetSha) throw new Ret(`target ${c.remote}/${c.target} not found`);
      r.targetBase = targetSha;
      if ((await G(r, c, ['merge-base', '--is-ancestor', branchSha, targetSha])).code === 0) { r.alreadyMerged = true; r.sha = targetSha; r.pushed = true; return; }
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
          const x = await git([...ident, 'merge', '--no-ff', '--no-edit', '-m', msg, branchSha], { cwd: wt, timeoutMs: 120_000 });
          if (x.code === 0) return { ok: true, info: { conflicts: [] } };
          const u = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: wt });
          const files = u.out.split('\0').filter(Boolean);
          if (!files.length) { await git(['merge', '--abort'], { cwd: wt }); return { ok: false, tail: x.err || x.out, info: { error: true } }; }
          if (files.every((f) => isConvention(f, c.conventions))) {
            if (await resolveConventions(r, c, wt, files)
              && (await git([...ident, 'commit', '--no-edit', '-m', `${msg}; resolved ${files.join(', ')} (${c.conventionResolver})`], { cwd: wt })).code === 0) return { ok: true, info: { conflicts: files, resolved: c.conventionResolver } };
          }
          await git(['merge', '--abort'], { cwd: wt });
          return { ok: false, tail: files.join('\n'), info: { conflicts: files } };
        });
        if (!m.ok) {
          const files = m.info?.conflicts || [];
          if (m.info?.error) throw new Ret('merge failed', m.tail);
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
              env: { GHOSTY_STATE_DIR: path.join(dir, 'tmp', r.id), CI: '1' } });
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
  const restartFiles = (r) => ({ log: path.join(dir, 'restart', `${r.id}.log`), exit: path.join(dir, 'restart', `${r.id}.exit`) });
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
      const x = await L(['pull', '--ff-only', '-q'], { timeoutMs: 180_000 });
      return { ok: x.code === 0, tail: x.err || x.out };
    });
    if (!pull.ok) return selfFail(r, 'deploy_refused', `deploy refused: git pull --ff-only failed in ${live}`, pull.tail);
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
    const f = restartFiles(r);
    fs.mkdirSync(path.dirname(f.log), { recursive: true, mode: 0o700 });
    fs.rmSync(f.exit, { force: true }); fs.rmSync(f.log, { force: true });
    Object.assign(sd, { expectedSha: sd.newSha, restartAt: iso(), restart: 'scheduled', note: 'restart scheduled via safe-restart', ...f });
    const told = selfDone(r);
    await Promise.race([told, new Promise((res) => setTimeout(res, 15_000).unref?.())]);   // the notice goes out before the service stops
    const x = await Promise.resolve(restart({ cwd: live, waitMin: c.deploy.restartWaitMin, log: f.log, exit: f.exit })).catch((e) => ({ ok: false, error: e?.message }));
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
      if (!r.pushed) {
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
          await evaluate(r, c);
        }
        await mergeAndPush(r, c, r.branchSha);
      }
      // from here the merge is on the target: nothing below returns the request or reverts anything
      if (c.ci && !(r.ci === 'success')) {
        const ciRes = await waitCi(r, c);
        if (!ciRes.ok) { transition(r, 'merged_ci_red', { reason: ciRes.info?.timedOut ? `CI did not finish: ${ciRes.tail}` : 'CI red on the merge commit', tail: ciRes.tail }); return; }
      }
      if (c.deploy?.kind === 'self') { await selfDeploy(r, c); return; }
      if (r.deployScope) {
        const d = await doDeploy(r, c);
        if (!d.ok) { transition(r, 'deploy_failed', { reason: `deploy failed: ${d.tail}`, tail: d.tail }); return; }
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

  function nextQueued(repo) { return [...reqs.values()].find((x) => x.repo === repo && x.state === 'queued') || null; }
  function kick(repo) {
    if (stopped || !started || workers.has(repo)) return;
    const p = (async () => {
      // a resumed running request first, then FIFO
      for (;;) {
        if (stopped) return;
        const r = [...reqs.values()].find((x) => x.repo === repo && x.state === 'running') || nextQueued(repo);
        if (!r) return;
        await processRequest(r);
        if (stopped && !FINAL.includes(r.state)) return;
      }
    })().catch((e) => log('worker died', repo, e?.message)).finally(() => { workers.delete(repo); if (!stopped && (nextQueued(repo))) kick(repo); });
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
    stop() { stopped = true; },
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
      const dup = [...reqs.values()].find((x) => x.state === 'queued' && x.repo === key && x.branch === branch && x.session === session && x.deployScope === deployScope && !x.approvedBy === !input.approvedBy);
      if (dup) return { id: dup.id, position: ahead(dup) + 1, repo: key, duplicate: true };
      const seq = Math.max(0, ...[...reqs.values()].map((x) => x.seq || 0)) + 1;
      const r = { id: `int-${now().toString(36)}${randomBytes(3).toString('hex')}`, seq, repo: key, branch, target: c.target, session,
        deployScope, note: input.note ? String(input.note).slice(0, 500) : null, by: input.by ? String(input.by).slice(0, 80) : null,
        state: 'queued', createdAt: iso(), updatedAt: iso(), startedAt: null, endedAt: null, step: null, steps: [], reason: null, tail: '',
        sha: null, branchSha: null, ci: null, deployed: null,
        ...(input.approvedBy ? { approvedBy: String(input.approvedBy).slice(0, 80), approvedAt: iso() } : {}) };
      try {
        const prev = Math.max(0, ...[...reqs.values()].filter((x) => session && x.session === session).map((x) => Date.parse(x.createdAt) || 0));
        const to = now(); r.usage = usage({ stateDir, session, from: Math.max(prev, to - 864e5), to });
      } catch (e) { log('usage attribution failed', e?.message); }
      reqs.set(r.id, r); persist(r);
      if (r.approvedBy) { try { journal({ kind: 'merge', decision_id: `merge-approval-${r.id}`, ts: r.approvedAt, source: 'integration-lane', question: `Approve the infra-path floor reason for ${branch} into ${c.target}?`, chosen: 'approve', approvedBy: r.approvedBy, approvedAt: r.approvedAt, rationale: 'a manager approval skips only the CI/deploy/infra-path floor reason; secrets, migrations, sudoers, units, red tests and conflicts still return the request', request: r.id, repo: key, branch, target: c.target }); } catch (e) { log('journal failed', e?.message); } }
      emit(r, { kind: 'queued', state: 'queued', final: false });
      const out = { id: r.id, position: ahead(r) + 1, repo: key };
      kick(key);
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
