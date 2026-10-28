import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inFixWindow, verdictRun, decide, brief, createCiWatch, mergePlatformVerdict, MAX_ATTEMPTS } from '../ci-watch.js';

const T0 = Date.parse('2026-10-15T06:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const r = (id, conclusion, min, status = 'completed') => ({ databaseId: id, number: id, headSha: `sha${id}`, status, conclusion, createdAt: at(min), url: `https://ci.example/run/${id}` });

test('verdictRun: newest finished success/failure wins; cancelled and skipped runs are ignored', () => {
  assert.equal(verdictRun([r(3, 'cancelled', 30), r(2, 'failure', 20), r(1, 'success', 10)], T0 + 40 * 60000).run.databaseId, 2);
  assert.equal(verdictRun([r(2, 'success', 20), r(1, 'failure', 10)], T0 + 40 * 60000).run.conclusion, 'success');
  assert.ok(verdictRun([r(1, 'cancelled', 10)], T0).wait);
});

test('verdictRun: a red verdict waits for a newer run still in progress, but not for one queued over an hour', () => {
  const runs = [r(3, null, 30, 'in_progress'), r(2, 'failure', 20)];
  assert.match(verdictRun(runs, T0 + 40 * 60000).wait, /run 3/);
  assert.equal(verdictRun(runs, T0 + 100 * 60000).run.databaseId, 2);
  assert.equal(verdictRun([r(3, null, 30, 'queued'), r(2, 'success', 20)], T0 + 40 * 60000).run.databaseId, 2);   // green needs no wait
});

test('decide: red with no fixer starts one; a working fixer is left alone; an idle one is nudged, not more than every 25 min', () => {
  const red = r(2, 'failure', 20), now = T0 + 60 * 60000;
  assert.equal(decide({ run: red, st: {}, fixer: { alive: false }, now }).type, 'start');
  assert.equal(decide({ run: red, st: { redSince: 1, attempts: 1, lastDispatchAt: now - 60 * 60000 }, fixer: { alive: true, working: true }, now }).type, 'none');
  assert.equal(decide({ run: red, st: { redSince: 1, attempts: 1, lastDispatchAt: now - 30 * 60000 }, fixer: { alive: true, working: false }, now }).type, 'nudge');
  assert.equal(decide({ run: red, st: { redSince: 1, attempts: 1, lastDispatchAt: now - 10 * 60000 }, fixer: { alive: true, working: false }, now }).type, 'none');
});

test('decide: after MAX_ATTEMPTS it asks the owner once, then stays quiet; green closes the streak', () => {
  const red = r(2, 'failure', 20), now = T0;
  assert.equal(decide({ run: red, st: { redSince: 1, attempts: MAX_ATTEMPTS }, fixer: { alive: false }, now }).type, 'stuck');
  assert.equal(decide({ run: red, st: { redSince: 1, attempts: MAX_ATTEMPTS, stuckAt: 2 }, fixer: { alive: false }, now }).type, 'none');
  assert.equal(decide({ run: r(3, 'success', 30), st: { redSince: 1 }, fixer: {}, now }).type, 'green');
  assert.equal(decide({ run: r(3, 'success', 30), st: {}, fixer: {}, now }).type, 'none');
});

test('brief: names the run, the failing jobs and the rules (no skipping checks, no force-push, watch the run)', () => {
  const b = brief({ cfg: { repo: 'org/fake', branch: 'main', cwd: '/w/fake' }, run: r(2, 'failure', 20), jobs: ['Frontend Lint'], logFile: '/s/2.log' });
  for (const s of ['org/fake', '/w/fake', 'https://ci.example/run/2', 'Frontend Lint', '/s/2.log', 'Do not skip', 'Never force-push', 'gh run watch', 'STATUS']) assert.ok(b.includes(s), s);
});

test('mergePlatformVerdict: success + platform failures -> failure (with the jobs); green stays green; gh-failure and cancelled are unchanged', () => {
  const green = r(2, 'success', 20);
  const merged = mergePlatformVerdict(green, ['e2e-pi1', 'vpt-smoke']);
  assert.equal(merged.conclusion, 'failure');
  assert.deepEqual(merged.jobs, ['e2e-pi1', 'vpt-smoke']);
  assert.equal(merged.databaseId, 2);
  // The original is not mutated.
  assert.equal(green.conclusion, 'success');
  assert.equal(green.jobs, undefined);

  assert.equal(mergePlatformVerdict(r(3, 'success', 30), []).conclusion, 'success');
  assert.equal(mergePlatformVerdict(r(4, 'success', 40), null).conclusion, 'success');
  const stillRed = mergePlatformVerdict(r(5, 'failure', 50), ['e2e-pi1']);
  assert.equal(stillRed.conclusion, 'failure');
  assert.deepEqual(stillRed.jobs, ['e2e-pi1']);
  // cancelled stays cancelled; verdictRun skips it, but if a caller hands it in we must not flip it.
  assert.equal(mergePlatformVerdict({ ...r(6, 'cancelled', 60), status: 'completed' }, ['e2e-pi1']).conclusion, 'cancelled');
  assert.equal(mergePlatformVerdict(null, ['x']), null);
});

function harness(t, { runs, jobs = ['Frontend Lint'], fixer = { exists: false, alive: false, working: false }, mode = 'live', cfg = true, fixWindow, platformJobs = [], platformError = null, log = { error() {} } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (cfg) writeFileSync(join(dir, 'ci-watch.json'), JSON.stringify({ repo: 'org/fake', workflow: 'ci.yml', cwd: '/w/fake', ...(fixWindow !== undefined ? { fixWindow } : {}) }));
  const calls = { started: [], sent: [], events: [], alerts: [], platformQueries: [] };
  let clock = T0 + 60 * 60000;
  const w = createCiWatch({
    stateDir: dir,
    run: async (cmd, args) => {
      if (cmd === 'ssh') {
        calls.platformQueries.push(args);
        if (platformError) throw platformError;
        return platformJobs.join('\n');
      }
      if (args[1] === 'list') return JSON.stringify(runs());
      if (args.includes('--log-failed')) return 'step failed\nerror: unused eslint-disable';
      return JSON.stringify({ jobs: jobs.map((name) => ({ name, conclusion: 'failure' })).concat([{ name: 'ok-job', conclusion: 'success' }]) });
    },
    sessionState: async () => fixer,
    startSession: async (o) => { calls.started.push(o); fixer = { exists: true, alive: true, working: true }; },
    sendToSession: async (n, text) => { calls.sent.push([n, text]); },
    record: async (e) => { calls.events.push(e.key); },
    alert: (k) => { calls.alerts.push(k); },
    mode: () => mode, now: () => clock, log,
  });
  return { w, dir, calls, setFixer: (f) => { fixer = f; }, advance: (min) => { clock += min * 60000; } };
}

test('tick: red -> red event + fixer started with a brief file; working fixer -> nothing; green -> green event, streak cleared', async (t) => {
  let runs = [r(2, 'failure', 20)];
  const h = harness(t, { runs: () => runs });
  await h.w.tick();
  assert.deepEqual(h.calls.events, ['ci-watch:red', 'ci-watch:fixer-started']);
  assert.equal(h.calls.started.length, 1);
  const s = h.calls.started[0];
  assert.equal(s.name, 'ci-fix-main'); assert.equal(s.cwd, '/w/fake'); assert.equal(s.provider, 'claude'); assert.equal(s.model, undefined);
  assert.match(readFileSync(s.promptFile, 'utf8'), /Frontend Lint/);
  assert.match(readFileSync(join(h.dir, 'ci-fix', '2.log'), 'utf8'), /unused eslint-disable/);
  h.advance(30); await h.w.tick();
  assert.equal(h.calls.started.length, 1); assert.equal(h.calls.sent.length, 0);
  runs = [r(3, 'success', 70), r(2, 'failure', 20)];
  h.advance(30); await h.w.tick();
  assert.deepEqual(h.calls.events.slice(-1), ['ci-watch:green']);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'ci-watch-state.json'), 'utf8')), {});
});

test('tick: an idle live fixer is nudged with the new run; after MAX_ATTEMPTS the owner is alerted once', async (t) => {
  const h = harness(t, { runs: () => [r(2, 'failure', 20)], fixer: { exists: true, alive: true, working: false } });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { await h.w.tick(); h.advance(30); }
  assert.equal(h.calls.sent.length, MAX_ATTEMPTS);
  assert.match(h.calls.sent[0][1], /still red.*run\/2/);
  assert.deepEqual(h.calls.alerts, ['ci-watch:stuck']);
  assert.equal(h.calls.started.length, 0);
});

test('tick: dry mode only journals; off and a missing config do nothing', async (t) => {
  const dry = harness(t, { runs: () => [r(2, 'failure', 20)], mode: 'dry' });
  await dry.w.tick();
  assert.equal(dry.calls.started.length, 0); assert.deepEqual(dry.calls.events, []);
  assert.match(readFileSync(join(dry.dir, 'ci-watch.jsonl'), 'utf8'), /"dry":true.*"type":"start"/);
  const off = harness(t, { runs: () => { throw new Error('must not call gh'); }, mode: 'off' });
  await off.w.tick(); assert.equal(off.w.snapshot().mode, 'off');
  const none = harness(t, { runs: () => { throw new Error('must not call gh'); }, cfg: false });
  await none.w.tick(); assert.equal(none.w.snapshot().verdict, 'no ci-watch.json');
  assert.equal(existsSync(join(none.dir, 'ci-watch-state.json')), false);
});

test('tick: a green run with platform failures is treated as red; the brief names the platform jobs (not the gh view)', async (t) => {
  // gh sees this run as success (continue-on-error hides the failures), the platform store
  // reports e2e-pi1 and vpt-smoke failed. ci-watch must dispatch a fixer and name those jobs.
  const logErrs = [];
  const h = harness(t, {
    runs: () => [r(2, 'success', 20)],
    platformJobs: ['e2e-pi1', 'vpt-smoke'],
    jobs: ['Frontend Lint'],   // gh view of failed jobs (would be picked up without the platform merge)
    log: { error: (...a) => logErrs.push(a.join(' ')) },
  });
  await h.w.tick();
  assert.deepEqual(h.calls.events, ['ci-watch:red', 'ci-watch:fixer-started']);
  assert.equal(h.calls.started.length, 1);
  const prompt = readFileSync(h.calls.started[0].promptFile, 'utf8');
  assert.match(prompt, /e2e-pi1/);
  assert.match(prompt, /vpt-smoke/);
  assert.ok(!/Frontend Lint/.test(prompt), 'gh-view failed jobs must not replace the platform ones');
  // The query was made against the right ssh alias with the run_number.
  assert.equal(h.calls.platformQueries.length, 1);
  const q = h.calls.platformQueries[0];
  assert.equal(q[0], '-o'); assert.equal(q[1], 'BatchMode=yes');
  assert.equal(q[2], '-o'); assert.equal(q[3], 'ConnectTimeout=10');
  assert.equal(q[4], 'database');
  assert.match(q[5], /cicd\.ci_jobs/);
  assert.match(q[5], /r\.run_number=2/);
  assert.match(q[5], /j\.status='failure'/);
  assert.match(h.w.snapshot().verdict, /failure run 2/);
  assert.equal(logErrs.length, 0);
});

test('tick: a clean green run queries the platform store and stays green when the store has no failures', async (t) => {
  const h = harness(t, { runs: () => [r(2, 'success', 20)], platformJobs: [] });
  await h.w.tick();
  assert.equal(h.calls.platformQueries.length, 1);
  assert.deepEqual(h.calls.events, []);
  assert.equal(h.calls.started.length, 0);
  assert.match(h.w.snapshot().verdict, /success run 2/);
});

test('tick: a platform-store lookup failure falls back to gh (red already red, green stays green) and is logged', async (t) => {
  // A red run is not queried at all (gh already says red, no need to ask the platform store).
  const red = harness(t, {
    runs: () => [r(2, 'failure', 20)],
    platformError: new Error('database ssh refused'),
  });
  await red.w.tick();
  assert.deepEqual(red.calls.events, ['ci-watch:red', 'ci-watch:fixer-started']);
  assert.equal(red.calls.platformQueries.length, 0);

  // A green run queries the platform; on error we log and fall back to gh (still green).
  const logErrs = [];
  const green = harness(t, {
    runs: () => [r(2, 'success', 20)],
    platformError: new Error('database ssh refused'),
    log: { error: (...a) => logErrs.push(a.join(' ')) },
  });
  await green.w.tick();
  assert.equal(green.calls.platformQueries.length, 1);
  assert.equal(green.calls.started.length, 0);
  assert.deepEqual(green.calls.events, []);
  assert.match(green.w.snapshot().verdict, /success run 2/);
  assert.ok(logErrs.some((l) => /platform store lookup failed/.test(l)), `expected fallback log, got: ${JSON.stringify(logErrs)}`);
});

test('tick: a gh-failure run is not queried in the platform store (gh already says red, so no ssh)', async (t) => {
  const h = harness(t, { runs: () => [r(2, 'failure', 20)] });
  await h.w.tick();
  assert.equal(h.calls.platformQueries.length, 0);
  assert.equal(h.calls.started.length, 1);
});

const ZRH = { from: 1, to: 6, tz: 'Europe/Zurich' };

test('inFixWindow: inside, outside, midnight wrap, missing config', () => {
  const utc = (iso) => Date.parse(iso);   // 2026-10-15 is CEST (UTC+2)
  assert.equal(inFixWindow(ZRH, utc('2026-10-15T00:00:00Z')), true);    // 02:00 local
  assert.equal(inFixWindow(ZRH, utc('2026-10-14T23:00:00Z')), true);    // 01:00 local, inclusive
  assert.equal(inFixWindow(ZRH, utc('2026-10-15T04:00:00Z')), false);   // 06:00 local, exclusive
  assert.equal(inFixWindow(ZRH, utc('2026-10-15T07:00:00Z')), false);
  const wrap = { from: 22, to: 4, tz: 'Europe/Zurich' };
  assert.equal(inFixWindow(wrap, utc('2026-10-15T21:00:00Z')), true);   // 23:00
  assert.equal(inFixWindow(wrap, utc('2026-10-15T00:30:00Z')), true);   // 02:30
  assert.equal(inFixWindow(wrap, utc('2026-10-15T10:00:00Z')), false);
  assert.equal(inFixWindow(undefined, 0), true); assert.equal(inFixWindow(null, 0), true);
});

test('tick: red outside the fix window is fed once, dispatches nothing, counts no attempt, says why; inside it dispatches', async (t) => {
  const h = harness(t, { runs: () => [r(2, 'failure', 20)], fixWindow: ZRH });   // harness clock: 09:00 Zurich
  await h.w.tick(); await h.w.tick();
  assert.deepEqual(h.calls.events, ['ci-watch:red']);
  assert.equal(h.calls.started.length, 0);
  assert.match(h.w.snapshot().verdict, /fixer waits for 01:00/);
  assert.match(h.w.snapshot().action.reason, /fixer waits for 01:00/);
  assert.equal(h.w.snapshot().streak.attempts, 0);
  h.advance(17 * 60);   // 02:00 next day
  await h.w.tick();
  assert.deepEqual(h.calls.events, ['ci-watch:red', 'ci-watch:fixer-started']);
  assert.equal(h.calls.started.length, 1);
});

test('tick: an idle fixer is not nudged outside the window; a missing or null fixWindow keeps the old behaviour', async (t) => {
  const idle = { exists: true, alive: true, working: false };
  const out = harness(t, { runs: () => [r(2, 'failure', 20)], fixer: idle, fixWindow: ZRH });
  await out.w.tick(); assert.equal(out.calls.sent.length, 0);
  const nul = harness(t, { runs: () => [r(2, 'failure', 20)], fixWindow: null });
  await nul.w.tick(); assert.equal(nul.calls.started.length, 1);
  const none = harness(t, { runs: () => [r(2, 'failure', 20)] });
  await none.w.tick(); assert.equal(none.calls.started.length, 1);
});
