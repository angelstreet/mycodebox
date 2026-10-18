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
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createGitRunner } from './orchestration/integration-controller.js';
import { gitFacts, mergeFloor, isConvention } from './merge-policy.js';

export const FINAL = Object.freeze(['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled']);
export const STATES = Object.freeze(['queued', 'running', ...FINAL]);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPE_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const MAX_PUSH_TRIES = 3;
const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
// Remote URLs may carry credentials: never let them into a tail, a reason or a notice.
const redact = (t) => String(t ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@');
export const tailOf = (text, lines = 60, chars = 6000) => redact(String(text ?? '')).split('\n').slice(-lines).join('\n').slice(-chars).trim();

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
    if (c.deploy != null) {
      if (typeof c.deploy !== 'object' || typeof c.deploy.env !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(c.deploy.env)) { bad('deploy.env required'); continue; }
      const defaultScope = c.deploy.defaultScope ?? 'full';
      if (!SCOPE_RE.test(defaultScope)) { bad('invalid deploy.defaultScope'); continue; }
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
  const g = createGitRunner();
  return async (args, { cwd, timeoutMs } = {}) => {
    try { return { code: 0, out: await g(args, { cwd, timeout_ms: timeoutMs }), err: '' }; } catch (e) {
      if (e.code === 'E_TIMEOUT') return { code: -1, out: e.stdout || '', err: 'git timed out', timedOut: true };
      return { code: Number.isInteger(e.exit) ? e.exit : -1, out: e.stdout || '', err: e.stderr || e.message || '' };
    }
  };
}
// run(cmd, { cwd, timeoutMs, env, onData }) -> { code, out, timedOut }. `sh -c`, own process group so a timeout kills the tree.
export function createDefaultRun() {
  return (cmd, { cwd, timeoutMs = 30 * 60_000, env, onData } = {}) => new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
// Round 7 merge floor with the lane as the tester (its own test run replaces the session's test report).
export async function defaultMergeEval({ cwd, branch, target, conventionFiles }) {
  const facts = await gitFacts({ cwd, branch, target, conventionFiles });
  const reasons = mergeFloor(facts, { state: 'green' }, { conventionFiles });
  return { verdict: reasons.length ? 'escalate' : 'merge', reasons, facts };
}

// ---- the lane ----------------------------------------------------------------------------------------------------------
export function createIntegrationLane({ stateDir, config = null, git = createDefaultGit(), run = createDefaultRun(), ci = null,
  deploys = null, mergeEval = defaultMergeEval, notify = () => {}, now = () => Date.now(), log = () => {},
  pollMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
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
  const emit = (r, event) => {
    try { Promise.resolve(notify(view(r), { at: iso(), ...event })).catch((e) => log('notify failed', e?.message)); } catch (e) { log('notify failed', e?.message); }
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
      s.ok = out.ok !== false; s.tail = tailOf(out.tail ?? ''); if (out.info !== undefined) s.info = out.info;
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

  // Merge the branch into the current remote target, test it, push it. Throws Ret to return the request.
  async function mergeAndPush(r, c, branchSha) {
    for (let attempt = 0; attempt < MAX_PUSH_TRIES; attempt++) {
      r.attempt = attempt + 1;
      if (attempt > 0) await fetch(r, c);
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
        if (c.test) {
          const t = await step(r, 'test', async (setLive) => {
            const res = await run(c.test, { cwd: wt, timeoutMs: c.testTimeoutMin * 60_000, onData: setLive,
              env: { GHOSTY_STATE_DIR: path.join(dir, 'tmp', r.id), CI: '1' } });
            fs.rmSync(path.join(dir, 'tmp', r.id), { recursive: true, force: true });
            return { ok: res.code === 0 && !res.timedOut, tail: res.out, info: { code: res.code, timedOut: !!res.timedOut } };
          });
          if (!t.ok) throw new Ret(t.info?.timedOut ? `tests timed out after ${c.testTimeoutMin} min` : `tests red (exit ${t.info?.code})`, r.steps.at(-1).tail);
        }
        const p = await step(r, 'push', async () => {
          const x = await G(r, c, ['push', c.remote, `${sha}:refs/heads/${c.target}`], { timeoutMs: 120_000 });
          await G(r, c, ['fetch', '--prune', c.remote]);
          if (await contains(r, c, sha)) return { ok: true, info: { rejected: false } };   // the remote is the truth, whatever push said
          const moved = (await G(r, c, ['merge-base', '--is-ancestor', `${c.remote}/${c.target}`, sha])).code !== 0;
          return { ok: false, tail: x.err || x.out, info: { moved } };
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
      if (!r.deployId) {
        const q = await deploys.request({ env: c.deploy.env, scope: r.deployScope, ref: c.target, sha: r.sha, agent: `integration:${r.id}` });
        if (!q?.id) return { ok: false, tail: q?.reason || 'deploy request refused' };
        r.deployId = q.id; persist(r);
      }
      const w = await deploys.wait(r.deployId);
      r.deployVersion = w?.version ?? null; r.deployed = w?.ok === true ? { id: r.deployId, version: r.deployVersion, env: c.deploy.env, scope: r.deployScope } : null;
      return { ok: w?.ok === true, tail: w?.ok === true ? `deployed ${r.deployVersion ?? ''}` : (w?.reason || w?.state || 'deploy failed'), info: { id: r.deployId } };
    });
    return res;
  }

  async function processRequest(r) {
    const c = repoCfg(r.repo);
    if (!c) { transition(r, 'returned', { reason: `repo ${r.repo} is not configured` }); return; }
    if (r.state === 'queued') { r.startedAt = iso(); r.steps = []; r.attempt = 0; transition(r, 'running', {}, {}); }
    else { r.resumed = (r.resumed || 0) + 1; emit(r, { kind: 'resumed', state: 'running', final: false }); }
    try {
      if (!r.pushed) {
        // restart check: a recorded merge may already be on the remote (the push step finished but was not recorded)
        if (r.mergeSha) { await fetch(r, c); if (await contains(r, c, r.mergeSha)) { r.pushed = true; r.sha = r.mergeSha; persist(r); } }
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
          const ev = await step(r, 'evaluate', async () => {
            const e = await mergeEval({ cwd: c.clone, branch: r.branch, target: c.target, conventionFiles: c.conventions, repo: r.repo, session: r.session });
            const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
            return { ok: e?.verdict === 'merge', tail: reasons.join('\n'), info: { reasons } };
          });
          if (!ev.ok) throw new Ret(`merge evaluation: ${ev.info.reasons.join('; ') || 'not mergeable'}`, ev.tail, { reasons: ev.info.reasons });
        }
        await mergeAndPush(r, c, r.branchSha);
      }
      // from here the merge is on the target: nothing below returns the request or reverts anything
      if (c.ci && !(r.ci === 'success')) {
        const ciRes = await waitCi(r, c);
        if (!ciRes.ok) { transition(r, 'merged_ci_red', { reason: ciRes.info?.timedOut ? `CI did not finish: ${ciRes.tail}` : 'CI red on the merge commit', tail: ciRes.tail }); return; }
      }
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
      if (input.deploy) {
        if (!c.deploy) throw coded('E_INVALID', `repo ${key} has no deploy configured`);
        deployScope = input.deploy === true ? c.deploy.defaultScope : String(input.deploy);
        if (!SCOPE_RE.test(deployScope)) throw coded('E_INVALID', 'invalid deploy scope');
      }
      const session = input.session == null ? null : String(input.session).slice(0, 120);
      const dup = [...reqs.values()].find((x) => x.state === 'queued' && x.repo === key && x.branch === branch && x.session === session && x.deployScope === deployScope);
      if (dup) return { id: dup.id, position: ahead(dup) + 1, repo: key, duplicate: true };
      const seq = Math.max(0, ...[...reqs.values()].map((x) => x.seq || 0)) + 1;
      const r = { id: `int-${now().toString(36)}${randomBytes(3).toString('hex')}`, seq, repo: key, branch, target: c.target, session,
        deployScope, note: input.note ? String(input.note).slice(0, 500) : null, by: input.by ? String(input.by).slice(0, 80) : null,
        state: 'queued', createdAt: iso(), updatedAt: iso(), startedAt: null, endedAt: null, step: null, steps: [], reason: null, tail: '',
        sha: null, branchSha: null, ci: null, deployed: null };
      reqs.set(r.id, r); persist(r);
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
