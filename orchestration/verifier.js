// Deterministic acceptance runner + independent reviewer invocation (GOAL_LOOP_CONTRACT steps 5-6, ARCHITECTURE §10).
// Checks run as argv (never a shell) in the task worktree with a fresh temporary GHOSTY_STATE_DIR, a timeout and a
// minimal env; every run is stored as evidence on the exact SHA. Unknown exit (spawn failure, timeout, kill) or a
// missing declared artifact is "not passing". A failing check is rerun once on the same SHA: pass+fail = flaky, and a
// flaky pass never counts. The reviewer is an adapter run with a rubric; its prose is recorded as a verdict, never as a
// test, and an unparseable answer is "unavailable", never approval.
import { spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewerPrompt, parseReviewerVerdict } from './roles.js';

const MAX_OUT = 256 * 1024;
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR'];

// node:test TAP ("not ok 3 - name") and spec ("✖ name (1.2ms)") reporters; error class from the assertion code/name.
export function parseFailures(output, exit) {
  const out = String(output ?? '');
  const tests = [];
  for (const m of out.matchAll(/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/gm)) tests.push(m[1]);
  if (!tests.length) for (const m of out.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)) tests.push(m[1]);
  // Suites report as failing parents too; the innermost (first listed) test is the signal.
  const leaf = [...new Set(tests)].filter((t) => !/^(?:tests?|failing tests:?)$/i.test(t));
  const code = /code:\s*'?(ERR_[A-Z_]+)'?/.exec(out)?.[1] || /\b([A-Z][A-Za-z]*Error)\b/.exec(out)?.[1] || null;
  const errorClass = code || (Number.isInteger(exit) ? `exit_${exit}` : 'unknown_exit');
  const msg = /\b\w*Error\b[^:\n]*:\s*([^\n]{1,300})/.exec(out)?.[1]?.trim() || null;
  if (!leaf.length) return [{ test: null, error_class: errorClass, message: msg }];
  return leaf.slice(0, 20).map((test) => ({ test, error_class: errorClass, message: msg }));
}

export function createVerifier({ spawn = nodeSpawn, fs = nodeFs, env = process.env, tmpRoot = os.tmpdir(), artifactRoot = null,
  timeoutMs = 120_000, now = Date.now } = {}) {
  const baseEnv = Object.fromEntries(ENV_KEYS.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]]));

  // -> { exit: integer|null, duration_ms, output, error }
  // register(kill|null): lets the caller stop a running check on cancel (T14); cleared when the check ends.
  function runCheck(check, { cwd, register = () => {} }) {
    return new Promise((resolve) => {
      const stateDir = fs.mkdtempSync(path.join(tmpRoot, 'v2-check-state-'));
      const t0 = now();
      let out = '';
      let done = false;
      let timedOut = false;
      const finish = (exit, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        register(null);
        try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
        resolve({ exit: timedOut ? null : exit, duration_ms: Math.max(0, now() - t0), output: out, error: timedOut ? 'timeout' : error });
      };
      let child;
      try {
        child = spawn(check.command[0], check.command.slice(1), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...baseEnv, GHOSTY_STATE_DIR: stateDir, CI: '1', NO_COLOR: '1' } });
      } catch (e) { finish(null, `spawn failed: ${e.code || e.message}`); return; }
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, check.timeout_ms || timeoutMs);
      register(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
      const take = (d) => { if (out.length < MAX_OUT) out += String(d).slice(0, MAX_OUT - out.length); };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', (e) => finish(null, `spawn failed: ${e.code || e.message}`));
      child.on('close', (code, signal) => finish(signal ? null : code, signal ? `killed by ${signal}` : null));
    });
  }

  // Deterministic per (task, sha, check, run index): reused evidence can find its output again after a restart.
  const logPath = (task_id, sha, check_id, i) => (artifactRoot ? path.join(artifactRoot, task_id, sha.slice(0, 12), `${check_id}-${i}.log`) : null);
  const readLog = (...a) => { try { return fs.readFileSync(logPath(...a), 'utf8'); } catch { return ''; } };
  function saveArtifact(task_id, sha, check_id, i, text) {
    if (!artifactRoot) return null;
    try {
      const f = logPath(task_id, sha, check_id, i);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      fs.writeFileSync(f, text, { mode: 0o600 });
      return f;
    } catch { return null; }
  }

  const passes = (check, exit, artifactOk) => exit !== null && exit === check.expect.exit && artifactOk;

  // existing: evidence already recorded for this SHA in the current head epoch (reused, never rerun: crash-safe).
  // -> results[{ check_id, required, status: pass|fail|flaky|unavailable, exits[], failures[], output_tail, evidence_ids[] }]
  async function runChecks({ store, task, cwd, sha, epoch, existing = [], actor, isCancelled = async () => false, register = () => {} }) {
    const results = [];
    for (const check of task.acceptance_checks) {
      const prior = existing.filter((e) => e.check_id === check.id);
      // A declared artifact is recorded as its path when present, null when missing: reuse can tell the difference.
      const runs = prior.map((e, i) => ({ exit: e.exit, artifactOk: !check.artifact || e.artifact !== null, output: readLog(task.task_id, sha, check.id, i), reused: true }));
      const want = () => (runs.length === 0 ? 1 : runs.length === 1 && !passes(check, runs[0].exit, runs[0].artifactOk) && runs[0].exit !== null ? 1 : 0);
      while (want()) {
        // Cancellation is checked before every spawn: no check runs after cancel (T14).
        if (await isCancelled()) return { cancelled: true, results };
        const i = runs.length;
        const r = await runCheck(check, { cwd, register });
        if (await isCancelled()) return { cancelled: true, results };   // a killed check is not evidence
        const artifactOk = !check.artifact || fs.existsSync(path.join(cwd, check.artifact));
        const log = saveArtifact(task.task_id, sha, check.id, i, r.output + (r.error ? `\n[runner] ${r.error}\n` : ''));
        await store.recordEvidence(task.task_id, { check_id: check.id, sha, command: check.command, exit: r.exit,
          duration_ms: r.duration_ms, artifact: check.artifact ? (artifactOk ? check.artifact : null) : log, actor }, { event_id: `ev-${sha.slice(0, 12)}-e${epoch}-${check.id}-${i}` });
        runs.push({ exit: r.exit, artifactOk, output: r.output, error: r.error });
      }
      const ok = runs.map((r) => passes(check, r.exit, r.artifactOk));
      let status;
      if (runs.some((r) => r.exit === null)) status = 'unavailable';
      else if (ok.every(Boolean)) status = 'pass';
      else if (ok.some(Boolean)) status = 'flaky';
      else status = 'fail';
      const last = runs.at(-1);
      let failures = [];
      if (status === 'fail' || status === 'flaky') {
        failures = !last.artifactOk && last.exit === check.expect.exit
          ? [{ test: `${check.id}:${check.artifact}`, error_class: 'missing_artifact', message: `declared artifact ${check.artifact} was not produced` }]
          : parseFailures(runs.find((r, i) => !ok[i] && r.output)?.output ?? last.output, last.exit);
      }
      results.push({ check_id: check.id, required: check.required, status, exits: runs.map((r) => r.exit), failures,
        output_tail: String(runs.find((r, i) => !ok[i])?.output || '').slice(-3000), error: runs.find((r) => r.error)?.error ?? null });
    }
    return { cancelled: false, results };
  }

  // -> { verdict: 'approve'|'reject'|'unavailable', findings[], usage, error, run }
  // role: 'reviewer' | 'security'; strict: demand the bare JSON verdict (after unparseable answers).
  async function review({ adapter, entry, task, sha, cwd, diff, evidence, run_id, timeout_ms, role = 'reviewer', strict = false, onStart = () => {} }) {
    let run;
    try {
      run = adapter.start({ task_id: task.task_id, run_id, cwd, model: entry.model, effort: null, timeout_ms, role: 'reviewer', review_role: role,
        prompt: reviewerPrompt({ task, sha, diff, evidence, role, strict }) });
    } catch (e) {
      return { verdict: 'unavailable', findings: [], usage: null, error: { class: e.code === 'E_UNSUPPORTED' ? 'unavailable' : 'crash', message: e.message }, run: null };
    }
    onStart(run);
    const result = await run.done;
    const usage = adapter.collectUsage(run);
    if (result.cancelled) return { verdict: 'unavailable', findings: [], usage, error: { class: 'cancelled' }, run };
    if (result.error) return { verdict: 'unavailable', findings: [], usage, error: result.error, run };
    const v = parseReviewerVerdict(run.events);
    if (!v) return { verdict: 'unavailable', findings: [], usage, error: { class: 'unparseable_verdict' }, run };
    return { ...v, usage, error: null, run };
  }

  return { runCheck, runChecks, review };
}
