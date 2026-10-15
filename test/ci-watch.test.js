import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verdictRun, decide, brief, createCiWatch, MAX_ATTEMPTS } from '../ci-watch.js';

const T0 = Date.parse('2026-10-15T06:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const r = (id, conclusion, min, status = 'completed') => ({ databaseId: id, headSha: `sha${id}`, status, conclusion, createdAt: at(min), url: `https://ci.example/run/${id}` });

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

function harness(t, { runs, jobs = ['Frontend Lint'], fixer = { exists: false, alive: false, working: false }, mode = 'live', cfg = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (cfg) writeFileSync(join(dir, 'ci-watch.json'), JSON.stringify({ repo: 'org/fake', workflow: 'ci.yml', cwd: '/w/fake' }));
  const calls = { started: [], sent: [], events: [], alerts: [] };
  let clock = T0 + 60 * 60000;
  const w = createCiWatch({
    stateDir: dir,
    run: async (cmd, args) => {
      if (args[1] === 'list') return JSON.stringify(runs());
      if (args.includes('--log-failed')) return 'step failed\nerror: unused eslint-disable';
      return JSON.stringify({ jobs: jobs.map((name) => ({ name, conclusion: 'failure' })).concat([{ name: 'ok-job', conclusion: 'success' }]) });
    },
    sessionState: async () => fixer,
    startSession: async (o) => { calls.started.push(o); fixer = { exists: true, alive: true, working: true }; },
    sendToSession: async (n, text) => { calls.sent.push([n, text]); },
    record: async (e) => { calls.events.push(e.key); },
    alert: (k) => { calls.alerts.push(k); },
    mode: () => mode, now: () => clock, log: { error() {} },
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
