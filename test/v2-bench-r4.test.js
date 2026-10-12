// Round 4 (OWNER_DECISIONS §12.4): --reps, MiniMax M3 / M3.1-Flash specs and reviewer pairs, subscription billing in the
// bench spend and the scorecard, provider waits, time-to-stop, the markdown report. Offline (fake runtime, synthetic stores).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBench, parseArgs, planRuns, profileFor, spendOfRecords, recordBilling, createSuiteLedger, sameModel, entryOf, DEFAULT_REVIEWERS, summarize } from '../scripts/v2-bench.js';
import { spendOf, registryDoc } from '../scripts/v2-bench-http.js';
import { buildScorecard, billingOf, validateManifest, toolScore, BENCH_SCHEMA } from '../orchestration/scorecard.js';
import { createTaskStore } from '../orchestration/store.js';
import { scorecardOf, markdownReport, readStoreLogs } from '../scripts/v2-score.js';
import { spec, SHA_A } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-r4-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const outDir = () => path.join(TMP, `out-${n++}`);
const ROOT = path.resolve(import.meta.dirname, '..');

test('--reps: option, default 1, bounds', () => {
  assert.equal(parseArgs(['--runtimes', 'fake-dev', '--fake']).reps, 1);
  assert.equal(parseArgs(['--runtimes', 'fake-dev', '--fake', '--reps', '3']).reps, 3);
  assert.equal(parseArgs(['--runtimes', 'fake-dev', '--fake', '--report']).report, true);
  for (const bad of ['0', '1.5', 'x', '21']) assert.throws(() => parseArgs(['--runtimes', 'fake-dev', '--fake', '--reps', bad]), /--reps/);
});

test('plan: tasks x models x reps, rep-major, per-task cap split over every rep', () => {
  const o = parseArgs(['--runtimes', 'fake-a,fake-b', '--fake', '--tasks', 'off-by-one,input-validation', '--reps', '3', '--max-usd', '12']);
  const { planned, taskUsd } = planRuns(o);
  assert.equal(planned.length, 2 * 2 * 3);
  assert.deepEqual(planned.map((p) => p.rep), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  assert.equal(taskUsd, 1);
  assert.equal(planRuns({ ...o, reps: 1 }).taskUsd, 3);
});

test('specs: minimax:m3 and minimax:m3.1-flash are distinct subscription models, each with an independent reviewer', () => {
  const m3 = profileFor('minimax:m3'), fl = profileFor('minimax:m3.1-flash');
  assert.equal(m3.model, 'MiniMax-M3');
  assert.equal(fl.model, 'MiniMax-M3.1-Flash-Preview');
  for (const p of [m3, fl]) { assert.equal(p.runtime, 'minimax'); assert.equal(p.billing, 'subscription'); assert.equal(p.passModel, true); assert.equal(p.est_usd, 0); }
  assert.deepEqual(fl.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(fl.effort, 'low');
  assert.deepEqual([m3.efforts, m3.effort], [[], null]);
  assert.deepEqual(registryDoc(new Map([[entryOf(fl), fl]])).models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(profileFor('claude:haiku').billing, 'per_token');
  assert.equal(sameModel(m3, fl), false);
  assert.equal(entryOf(fl), 'minimax:MiniMax-M3.1-Flash-Preview');
  const { pairs, planned } = planRuns(parseArgs(['--runtimes', 'minimax:m3,minimax:m3.1-flash,claude:haiku', '--tasks', 'off-by-one,input-validation', '--reps', '3', '--max-usd', '10', '--task-usd', '0.55']));
  assert.deepEqual(pairs.map((p) => [p.spec, p.revSpec]), [['minimax:m3', 'claude:haiku'], ['minimax:m3.1-flash', 'claude:haiku'], ['claude:haiku', 'codex']]);
  for (const p of pairs) { assert.notEqual(entryOf(p.dev), entryOf(p.rev)); assert.equal(sameModel(p.dev, p.rev), false); }
  assert.equal(planned.length, 2 * 3 * 3);
  assert.equal(DEFAULT_REVIEWERS['minimax:m3'], 'claude:haiku');
  // The pair can be changed, but never to the same model.
  assert.throws(() => planRuns(parseArgs(['--runtimes', 'minimax:m3', '--reviewer-map', 'minimax:m3=minimax:m3', '--tasks', 'off-by-one', '--max-usd', '10', '--task-usd', '0.5'])), /same model/);
  const alt = planRuns(parseArgs(['--runtimes', 'claude:haiku', '--reviewer-map', 'claude:haiku=minimax:m3', '--tasks', 'off-by-one', '--max-usd', '10', '--task-usd', '0.5']));
  assert.equal(alt.pairs[0].revSpec, 'minimax:m3');
});

test('fake run with reps: every task x model runs N times, records carry rep, the cap covers all of them', async () => {
  const lines = [];
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'off-by-one,input-validation', reps: 2, max_usd: 4, log: (l) => lines.push(l) });
  assert.equal(manifest.reps, 2);
  assert.equal(manifest.runs.length, 4);
  assert.deepEqual(manifest.runs.map((r) => [r.bench_task_id, r.rep]), [['off-by-one', 1], ['input-validation', 1], ['off-by-one', 2], ['input-validation', 2]]);
  assert.equal(manifest.budget_policy.per_task_usd, 1, 'max_usd 4 / 4 planned runs');
  assert.ok(manifest.runs.every((r) => r.outcome === 'done'));
  assert.ok(lines.some((l) => /rep 2\/2/.test(l)));
  assert.ok(summarize(manifest).table[2].includes('#2'));
  assert.equal(validateManifest(manifest).ok, true);
});

test('fake run with reps: a reached cap leaves explicit skipped_budget records, rep by rep', async () => {
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-a', 'fake-b'], out: outDir(), tasks: 'off-by-one', reps: 3, max_usd: 0.04, task_usd: 0.02 });
  const by = manifest.runs.map((r) => `${r.rep}:${r.runtime_spec}:${r.outcome}`);
  assert.equal(manifest.runs.length, 6);
  assert.ok(manifest.runs.some((r) => r.outcome === 'skipped_budget'), by.join(' '));
  assert.ok(manifest.runs.filter((r) => r.outcome === 'skipped_budget').every((r) => r.rep >= 2 && /suite ledger/.test(r.error)));
  assert.ok(manifest.spend.known_usd + manifest.spend.estimated_usd <= 0.04 + 1e-9);
});

test('subscription billing: a subscription record is not unknown, not estimated, not $0 measured', () => {
  const est = () => 0.1;
  const sub = [{ runtime: 'minimax', model: 'MiniMax-M3', usd: null, input_tokens: 10, output_tokens: 5 }];
  const a = spendOfRecords(sub, est);
  assert.deepEqual([a.unknown, a.unknown_records, a.estimated_usd, a.known_usd, a.usd, a.cost_basis, a.subscription_records], [false, 0, 0, 0, null, 'subscription', 1]);
  const mixed = spendOfRecords([...sub, { runtime: 'claude', model: 'claude-haiku-4-5', usd: 0.02 }], est);
  assert.deepEqual([mixed.unknown, mixed.known_usd, mixed.usd, mixed.cost_basis], [false, 0.02, 0.02, 'measured']);
  const unk = spendOfRecords([...sub, { runtime: 'codex', model: 'x', usd: null }], est);
  assert.deepEqual([unk.unknown, unk.estimated_usd, unk.usd, unk.cost_basis], [true, 0.1, null, 'estimated']);
  // explicit billing wins; a usd on a subscription record is not counted as measured spend
  assert.equal(recordBilling({ runtime: 'minimax', billing: 'per_token', usd: 1 }), 'per_token');
  assert.equal(spendOfRecords([{ runtime: 'claude', model: 'm', billing: 'subscription', usd: 0 }], est).known_usd, 0);
  assert.equal(spendOfRecords([{ runtime: 'claude', model: 'm', billing: 'subscription', usd: 0 }], est).usd, null);
  assert.equal(spendOfRecords([], est).usd, 0);
  assert.equal(spendOf(sub, est).cost_basis, 'subscription', 'the HTTP driver uses the same rule');
  // the ledger never sees a subscription run as an unknown-cost run
  const l = createSuiteLedger({ max_usd: 1 });
  l.record(a);
  assert.deepEqual(l.summary(), { known_usd: 0, estimated_usd: 0, unknown_runs: 0 });
});

// ---- scorecard over a real store with synthetic runs ----
const T0 = Date.parse('2026-01-01T00:00:00Z');
const storeIn = (dir) => { let t = T0; let k = 0; return createTaskStore({ dir, now: () => (t += 1000), randomId: () => `r${++k}` }); };
const tspec = (id, over = {}) => spec({ task_id: id, runtime_capabilities: ['code'], scope: { paths: ['README.md'] }, ...over });
const MM = 'minimax:MiniMax-M3', HK = 'claude:claude-haiku-4-5', REVR = 'codex:gpt-6-luna';
async function done(s, id, who, { usd = null, rework = 0, tin = 100, tout = 20, revUsd = 0.01 } = {}) {
  await s.createTask(tspec(id));
  for (const st of ['clarified', 'planned', 'ready', 'executing']) await s.transition(id, st);
  for (let i = 0; i < rework; i++) { await s.transition(id, 'repair'); await s.transition(id, 'executing'); }
  await s.transition(id, 'evaluating');
  await s.setHead(id, SHA_A, { actor: { role: 'developer', id: who } });
  const [runtime, ...m] = who.split(':');
  await s.recordUsage(id, { runtime, model: m.join(':'), usd, input_tokens: tin, output_tokens: tout, run_id: `${id}-d` });
  await s.recordUsage(id, { runtime: 'codex', model: 'gpt-6-luna', usd: revUsd, input_tokens: 7, output_tokens: 3, run_id: `${id}-r` });
  await s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: REVR }, verdict: 'approve', findings: [] });
  await s.transition(id, 'accepted');
}
async function stuck(s, id, who, { waits = 0, quota = 0, usd = null } = {}) {
  await s.createTask(tspec(id));
  for (const st of ['clarified', 'planned', 'ready', 'executing']) await s.transition(id, st);
  const [runtime, ...m] = who.split(':');
  await s.recordUsage(id, { runtime, model: m.join(':'), usd, input_tokens: 1000, output_tokens: 200, run_id: `${id}-d` });
  for (let i = 0; i < waits; i++) await s.append(id, { event_id: `rl-${id}-${i}`, kind: 'model.rate_limited', payload: { entry: who, retry_after_ms: 1000 } });
  for (let i = 0; i < quota; i++) { await s.transition(id, 'waiting', { reason: 'provider quota exhausted: waiting with backoff' }); await s.transition(id, 'ready'); await s.transition(id, 'executing'); }
  await s.append(id, { event_id: `bl-${id}`, kind: 'task.blocked', payload: { reason: 'no_progress', diagnosis: 'x', next_action: 'y' } });
  await s.transition(id, 'waiting', { reason: 'no_progress' });
}
const manifestFor = (runs, extra = {}) => ({ schema: BENCH_SCHEMA, suite_id: 's', suite_version: '1', driver: 'http', reps: 2, runs, budget_policy: { max_usd: 10, max_task_ms: 600000 }, ...extra });

test('scorecard: subscription cost basis, tokens, wall time, reps, provider waits and time-to-stop per model and per task', async () => {
  const dir = path.join(TMP, 'store-a');
  const s = storeIn(dir);
  await done(s, 'm1', MM, { rework: 1 });
  await done(s, 'm2', MM, { tin: 300, tout: 40 });
  await done(s, 'h1', HK, { usd: 0.03 });
  await done(s, 'h2', HK, { usd: 0.05, rework: 2 });
  await stuck(s, 'mi1', MM, { waits: 2, quota: 1 });
  await stuck(s, 'hi1', HK, { usd: 0.02 });
  const runs = [['m1', MM, 'off-by-one', 1], ['m2', MM, 'off-by-one', 2], ['h1', HK, 'off-by-one', 1], ['h2', HK, 'off-by-one', 2], ['mi1', MM, 'impossible-contradiction', 1], ['hi1', HK, 'impossible-contradiction', 1]]
    .map(([task_id, e, bench_task_id, rep]) => ({ task_id, bench_task_id, rep, task_class: 'x', expected_outcome: bench_task_id === 'off-by-one' ? 'done' : 'waiting_no_progress', runtime: e.split(':')[0], model: e.split(':').slice(1).join(':') }));
  const mf = manifestFor(runs);
  assert.equal(validateManifest(mf).ok, true);
  assert.equal(validateManifest({ ...mf, runs: [{ ...runs[0], rep: 0 }] }).ok, false);
  const { sc } = scorecardOf(dir, { manifest: mf });
  const mm = sc.model_metrics.find((m) => m.key === MM), hk = sc.model_metrics.find((m) => m.key === HK);
  assert.equal(mm.cost_basis, 'subscription');
  assert.equal(hk.cost_basis, 'measured');
  assert.deepEqual([mm.runs, mm.reps, mm.verified, mm.first_pass], [3, 2, 2, 1]);
  assert.deepEqual([hk.runs, hk.verified, hk.first_pass], [3, 2, 1]);
  assert.equal(mm.tokens.developer_input, 100 + 300 + 1000);
  assert.equal(mm.tokens.developer_output, 20 + 40 + 200);
  assert.equal(mm.rework.rounds, 1);
  assert.equal(hk.rework.rounds, 2);
  assert.equal(mm.usd.measured, 0.02, 'only the per-token reviews of MiniMax tasks: two accepted runs x 0.01 (subscription adds nothing)');
  assert.ok(Math.abs(hk.usd.measured - (0.03 + 0.05 + 0.02 + 0.02)) < 1e-9);
  assert.equal(mm.provider_waits.total, 3);
  assert.deepEqual(mm.provider_waits.by_entry, { [MM]: 3 });
  assert.equal(hk.provider_waits.total, 0);
  assert.equal(mm.time_to_stop_no_progress_ms.n, 1);
  assert.ok(mm.time_to_stop_no_progress_ms.mean > 0);
  assert.equal(hk.time_to_stop_no_progress_ms.n, 1);
  assert.ok(mm.wall_ms.n === 3 && mm.wall_ms.min <= mm.wall_ms.mean && mm.wall_ms.mean <= mm.wall_ms.max);
  const t = Object.fromEntries(sc.task_metrics.map((m) => [m.key, m]));
  assert.equal(t['off-by-one'].runs, 4);
  assert.equal(t['impossible-contradiction'].time_to_stop_no_progress_ms.n, 2);
  assert.equal(t['impossible-contradiction'].verified, 0);
  assert.equal(sc.task_model_metrics.length, 4);
  const run = Object.fromEntries(sc.runs.map((r) => [r.task_id, r]));
  assert.equal(run.m1.cost_usd, null, 'a subscription task has no USD total: unknown to the tool score, as before');
  assert.equal(run.m1.cost_unknown_reason, 'subscription usage (no marginal USD)');
  assert.equal(run.m1.cost_basis, 'subscription');
  assert.equal(run.mi1.rep, 1);
  assert.ok(sc.caveats.some((c) => /subscription/.test(c)));
  // markdown: all three tables, subscription never printed as $0
  const mp = path.join(TMP, 'm-a.json');
  fs.writeFileSync(mp, JSON.stringify(mf));
  const md = markdownReport(mp, { store: dir });
  for (const h of ['## Per model (developer)', '## Per task', '## Per task and model', 'time to stop, impossible task']) assert.ok(md.includes(h), h);
  const row = md.split('\n').find((l) => l.startsWith(`| ${MM} |`));
  assert.match(row, /subscription \(\+ \$0\.0200 per-token reviews\)/);
  assert.ok(row.includes('| subscription |'), row);
  assert.ok(!/\| \$0\.0000 \|/.test(row), 'a subscription model is never shown as $0 measured');
  assert.ok(md.includes('off-by-one | ' + MM));
  assert.ok(md.includes(`| ${HK} |`));
  // the CLI prints the same
  const cli = spawnSync(process.execPath, ['scripts/v2-score.js', '--markdown', '--suite', mp, '--store', dir], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, md);
  assert.equal(spawnSync(process.execPath, ['scripts/v2-score.js', '--markdown'], { cwd: ROOT, encoding: 'utf8' }).status, 2);
});

test('scorecard: a manifest without rep or billing (round 2/3) is still scorable; the tool score is unchanged in meaning', async () => {
  const dir = path.join(TMP, 'store-b');
  const s = storeIn(dir);
  await done(s, 'o1', MM);
  await done(s, 'o2', HK, { usd: 0.04 });
  const mf = { schema: BENCH_SCHEMA, suite_id: 's', suite_version: '1', runs: ['o1', 'o2'].map((task_id, i) => ({ task_id, bench_task_id: 'off-by-one', task_class: 'x', expected_outcome: 'done', runtime: i ? 'claude' : 'minimax', model: i ? 'claude-haiku-4-5' : 'MiniMax-M3' })),
    budget_policy: { max_usd: 10, max_task_ms: 600000 } };
  const { sc } = scorecardOf(dir, { manifest: mf });
  assert.equal(sc.runs.find((r) => r.task_id === 'o1').rep, null);
  const ts = toolScore(sc, mf);
  assert.equal(ts.components.cost.value, null, 'a subscription task still has no USD total');
  assert.match(ts.components.cost.reason, /unknown cost/);
  assert.equal(ts.components.outcome_correctness.value, 1);
  assert.equal(ts.score, null);
});

test('billingOf: field wins, minimax falls back to subscription, a priced record is per_token, else unknown', () => {
  assert.equal(billingOf({ billing: 'per_token', runtime: 'minimax' }), 'per_token');
  assert.equal(billingOf({ runtime: 'minimax', usd: null }), 'subscription');
  assert.equal(billingOf({ runtime: 'claude', usd: 0.1 }), 'per_token');
  assert.equal(billingOf({ runtime: 'codex', usd: null }), 'unknown');
  assert.equal(billingOf({ runtime: 'claude', billing: 'bogus', usd: null }), 'unknown');
});
