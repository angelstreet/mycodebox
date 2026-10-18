// CI watch (owner, 2026-10-15): keep a repo's main branch green without anyone starting a session by hand.
// Every 30 min it reads main's newest finished CI run (gh). Red -> one fixer session on that repo (cbsession) with a
// standard brief, or a nudge with the new run if the fixer is already up and idle. Green -> ci-watch:green, streak reset.
// After MAX_ATTEMPTS dispatches in one red streak it stops and asks the owner once (ci-watch:stuck, pushed).
// Config: <stateDir>/ci-watch.json { repo, workflow, branch, cwd, session, provider, model } (the repo slug stays out of this repo).
// provider/model go to cbsession -p/-m (default claude, cbsession's model); the owner prefers an existing MiniMax M3 session (2026-10-15).
// Switch: manager.json `ciWatch` "live" (default) | "dry" (log what it would do) | "off". Journal: ci-watch.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const POLL_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 4;           // fixer starts + nudges per red streak before the owner is asked
const NUDGE_GAP_MS = 25 * 60 * 1000;     // an idle fixer is nudged at most this often
const PENDING_MAX_MS = 60 * 60 * 1000;   // a newer run still queued after this (offline runner) no longer holds the verdict back

// Pure. runs: gh run list rows (newest first). Returns the run the verdict is about, or { wait } while a newer run is pending.
export function verdictRun(runs, now) {
  const rows = (runs || []).filter((r) => r && r.headSha);
  const done = rows.find((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'failure'));
  if (!done) return { wait: 'no finished run' };
  const newer = rows.find((r) => r.status !== 'completed' && Date.parse(r.createdAt) > Date.parse(done.createdAt)
    && now - Date.parse(r.createdAt) < PENDING_MAX_MS);
  if (newer && done.conclusion === 'failure') return { wait: `run ${newer.databaseId} on ${String(newer.headSha).slice(0, 9)} still ${newer.status}`, run: done };
  return { run: done };
}

// Pure. Merges a gh run's conclusion with the platform store (cicd.ci_jobs). Platform jobs
// (api-routes, backend-server-tests, e2e-*, web-script-local-debug, vpt-smoke) run with
// continue-on-error, so gh reports 'success' while the platform records 'failure'. If gh
// says 'success' but the platform has failed jobs for this run, the run is treated as red.
// The returned run carries `jobs` either way so the brief/nudge can name the failures.
export function mergePlatformVerdict(run, dbFailedJobs) {
  if (!run) return run;
  const jobs = (dbFailedJobs || []).filter(Boolean);
  if (jobs.length && run.conclusion === 'success') return { ...run, conclusion: 'failure', jobs };
  return { ...run, jobs };
}

// Pure. What to do this tick. st: persisted streak state; fixer: { exists, alive, working } of the fixer session.
// -> { type: 'none'|'green'|'start'|'nudge'|'stuck', reason, red? }
export function decide({ run, st, fixer, now }) {
  if (!run) return { type: 'none', reason: 'no verdict' };
  if (run.conclusion === 'success') return st.redSince ? { type: 'green', reason: `run ${run.databaseId} green` } : { type: 'none', reason: 'green' };
  const red = { runId: run.databaseId, sha: run.headSha, url: run.url };
  const attempts = st.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) return st.stuckAt ? { type: 'none', reason: 'stuck, owner asked', red } : { type: 'stuck', reason: `${attempts} fixer attempts, still red`, red };
  if (fixer.alive && fixer.working) return { type: 'none', reason: 'fixer working', red };
  if (fixer.alive) {
    if (now - (st.lastDispatchAt || 0) < NUDGE_GAP_MS) return { type: 'none', reason: 'fixer idle, nudged recently', red };
    return { type: 'nudge', reason: `fixer idle, main still red (run ${run.databaseId})`, red };
  }
  return { type: 'start', reason: `main red (run ${run.databaseId}), no fixer`, red };
}

// Pure. The fixer's brief (also the nudge text, shortened).
export function brief({ cfg, run, jobs, logFile }) {
  return [
    `You are the CI fixer for ${cfg.repo} (${cfg.branch}), started by ci-watch on codebox. Its CI is red and your job is to make it green.`,
    `Working directory: ${cfg.cwd} (a shared checkout: make your own git worktree for edits).`,
    `Red run: ${run.url} on ${String(run.headSha).slice(0, 9)}. Failing jobs: ${jobs.join(', ') || 'see the run'}.`,
    logFile ? `Failed-step log excerpt: ${logFile}` : '',
    '',
    'Do this:',
    '1. Read the failure (gh run view --log-failed), find the cause in the code, and fix the code. Do not skip, disable or loosen a check to get green.',
    '2. Run the failing checks locally on your worktree first (the same commands the workflow runs).',
    '3. Merge and push the fix to main yourself (owner mandate 2026-10-14). Never force-push, never set a *_SKIP bypass, keep the pre-push hook happy.',
    '   A lint/type/docs fix needs no deploy; a runtime change goes through the normal deploy procedure on a free lease.',
    '4. Watch the run your push starts (gh run watch) until it finishes. If it is red for another reason, fix that too.',
    '5. Do not touch runners, hosts, secrets or other sessions\' branches beyond the fix. If the cause is outside the code (runner offline, infra), say so and stop.',
    'End every turn with one STATUS line. ci-watch re-checks main every 30 min and nudges you while it is red.',
  ].filter((l) => l !== null).join('\n');
}

export function createCiWatch({
  stateDir, run, sessionState, startSession, sendToSession, record = async () => {}, alert = () => {},   // alert pushes the owner AND writes the feed
  mode = () => 'live',
  now = Date.now, pollMs = POLL_MS, log = console,
} = {}) {
  const cfgFile = join(stateDir, 'ci-watch.json');
  const stFile = join(stateDir, 'ci-watch-state.json');
  const journal = join(stateDir, 'ci-watch.jsonl');
  let st = {}, last = { at: 0, mode: 'off', verdict: null, action: null };
  let timer = null, busy = false;

  async function load() { try { st = JSON.parse(await readFile(stFile, 'utf8')); } catch { st = {}; } }
  async function save() { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }
  const gh = async (args) => JSON.parse(await run('gh', args));

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { ...last, at: now(), mode: m });
      let cfg;
      try { cfg = JSON.parse(await readFile(cfgFile, 'utf8')); } catch { return (last = { at: now(), mode: m, verdict: 'no ci-watch.json', action: null }); }
      cfg = { branch: 'main', session: 'ci-fix-main', provider: 'claude', ...cfg };
      await load();
      const runs = await gh(['run', 'list', '-R', cfg.repo, '-b', cfg.branch, ...(cfg.workflow ? ['-w', cfg.workflow] : []), '-L', '20',
        '--json', 'databaseId,number,headSha,status,conclusion,createdAt,url']);
      const v = verdictRun(runs, now());
      if (v.wait) return (last = { at: now(), mode: m, verdict: v.wait, action: null });
      // Platform store check: a green run may hide continue-on-error failures (api-routes,
      // backend-server-tests, e2e-*, web-script-local-debug, vpt-smoke). On a failure, gh
      // already says red so the query is skipped. If the query errors, fall back to gh.
      let platformJobs = [];
      if (v.run.conclusion === 'success' && v.run.number) {
        try {
          const q = `select j.job from cicd.ci_jobs j join cicd.ci_runs r using(project,run) where j.project='virtualpytest' and r.run_number=${Number(v.run.number)} and j.status='failure'`;
          const out = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'database', `sudo -n docker exec -i supabase_db_supabase psql -U postgres -d postgres -At -c "${q}"`]);
          platformJobs = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean);
        } catch (e) {
          log.error?.('[ci-watch] platform store lookup failed, falling back to gh:', String(e.message).split('\n')[0]);
        }
      }
      const merged = mergePlatformVerdict(v.run, platformJobs);
      const fixer = await sessionState(cfg.session);
      const d = decide({ run: merged, st, fixer, now: now() });
      last = { at: now(), mode: m, verdict: `${merged.conclusion} run ${merged.databaseId}`, action: d };
      if (m === 'dry') { if (d.type !== 'none') await note({ dry: true, ...d }); return last; }
      if (d.red && !st.redSince) {   // a new red streak: once in the feed, whatever this tick does
        st = { redSince: now(), attempts: 0 }; await save();
        await record({ key: 'ci-watch:red', title: `CI red on ${cfg.branch}`, body: d.reason, url: merged.url, priority: 'default' });
      }
      if (d.type === 'none') return last;
      if (d.type === 'green') {
        await record({ key: 'ci-watch:green', title: `CI green again on ${cfg.branch}`, body: `${d.reason}; red since ${new Date(st.redSince).toISOString()}, ${st.attempts || 0} fixer dispatch(es)`, url: merged.url, priority: 'default' });
        await note(d); st = {}; await save(); return last;
      }
      if (d.type === 'stuck') {
        st.stuckAt = now(); await save(); await note(d);
        const body = `${cfg.branch} is still red after ${st.attempts} fixer attempts (${merged.url}). ci-watch stopped dispatching; look at ${cfg.session}. Delete ci-watch-state.json to let it retry.`;
        alert('ci-watch:stuck', { title: 'CI fixer stuck', body, url: merged.url, priority: 'high' });
        return last;
      }
      const view = await gh(['run', 'view', String(merged.databaseId), '-R', cfg.repo, '--json', 'jobs']);
      const ghJobs = (view.jobs || []).filter((j) => j.conclusion === 'failure').map((j) => j.name);
      // Platform jobs (continue-on-error) replace gh's view when present; otherwise use gh's failed jobs.
      const jobs = merged.jobs && merged.jobs.length ? merged.jobs : ghJobs;
      const dir = join(stateDir, 'ci-fix'); await mkdir(dir, { recursive: true });
      let logFile = join(dir, `${merged.databaseId}.log`);
      try { const out = await run('gh', ['run', 'view', String(merged.databaseId), '-R', cfg.repo, '--log-failed']); await writeFile(logFile, out.split('\n').slice(-400).join('\n')); } catch { logFile = null; }
      const text = brief({ cfg, run: merged, jobs, logFile });
      if (d.type === 'start') {
        const promptFile = join(dir, `${merged.databaseId}.prompt.md`);
        await writeFile(promptFile, text);
        await startSession({ name: cfg.session, cwd: cfg.cwd, provider: cfg.provider, model: cfg.model, promptFile });
      } else {
        await sendToSession(cfg.session, `ci-watch: ${cfg.branch} is still red. Run ${merged.url}, failing: ${jobs.join(', ') || 'see the run'}.${logFile ? ` Log excerpt: ${logFile}.` : ''} Fix it as in your brief, push, and watch the run.`);
      }
      st.attempts = (st.attempts || 0) + 1; st.lastDispatchAt = now(); await save();
      await note({ ...d, jobs, attempt: st.attempts });
      await record({ key: `ci-watch:${d.type === 'start' ? 'fixer-started' : 'fixer-nudged'}`, title: `CI fixer ${d.type === 'start' ? 'started' : 'nudged'} (${st.attempts}/${MAX_ATTEMPTS})`, body: `${cfg.session}: ${jobs.join(', ') || 'red run'}`, url: merged.url, priority: 'default' });
      return last;
    } catch (e) {
      log.error?.('[ci-watch]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => ({ ...last, streak: st }),
    start(firstDelayMs = 2 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
