// V2 benchmark suite (scripts/v2-bench.js) in --fake mode: the whole goal loop runs offline with scripted fake
// developers and a scripted fake reviewer, in disposable repos under the system temp dir. Synthetic fixtures only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBench, createSuiteLedger, parseArgs, selectTasks, classify, MANIFEST_SCHEMA, profileFor, sameModel, refuseOutDir, minViableTaskUsd, notRunOutcome } from '../scripts/v2-bench.js';
import { TASKS, SUITE_ID, SUITE_VERSION, EXPECTED_OUTCOMES, policyFor, noopFiles } from './fixtures/v2-bench/tasks.js';
import { checkAction, validatePolicy } from '../orchestration/policy.js';
import { parseOpencodeEvent } from '../orchestration/adapters/opencode.js';
import { validateManifest, toolScore } from '../orchestration/scorecard.js';
import { scorecardOf, scoreStore } from '../scripts/v2-score.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const outDir = () => path.join(TMP, `out-${n++}`);

// Writes a fixture (optionally with overlay files) to a plain directory and runs its acceptance checks.
function runChecks(task, overlay = {}) {
  const dir = path.join(TMP, `fx-${n++}`);
  for (const [f, c] of Object.entries({ ...task.files, ...overlay })) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return task.checks.map((c) => spawnSync(process.execPath, c.command.slice(1), { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } }).status);
}

test('suite: 8-12 synthetic tasks with classes, expected outcomes and valid policies', () => {
  assert.equal(SUITE_ID, 'mycodebox-v2-bench');
  assert.equal(SUITE_VERSION, 1);
  assert.ok(TASKS.length >= 8 && TASKS.length <= 12);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const cls of ['bugfix', 'feature', 'refactor', 'docs', 'forbidden', 'impossible', 'flaky']) assert.ok(TASKS.some((t) => t.task_class === cls), cls);
  for (const t of TASKS) {
    assert.ok(EXPECTED_OUTCOMES.includes(t.expected_outcome), t.id);
    assert.deepEqual(validatePolicy(policyFor(t)), [], t.id);
    for (const c of t.checks) assert.equal(c.command[0], 'node');
    // Only the forbidden task names a restricted action; every other goal is runnable without an owner decision.
    const gate = checkAction(policyFor(t), { goal: t.goal, scope: 'repo', definition_of_done: [] }, { class: 'execute' });
    assert.equal(gate.allow, t.task_class !== 'forbidden', `${t.id}: ${gate.reason}`);
  }
  assert.equal(TASKS.find((t) => t.task_class === 'forbidden').expected_outcome, 'awaiting_approval');
  assert.equal(TASKS.find((t) => t.task_class === 'impossible').expected_outcome, 'waiting_no_progress');
  assert.throws(() => selectTasks('nope'), /unknown bench task/);
});

test('fixtures: checks fail at base, pass with the scripted solution; flaky and impossible cannot pass by a no-op', () => {
  for (const t of TASKS.filter((x) => x.task_class !== 'forbidden')) {
    assert.ok(runChecks(t).some((s) => s !== 0), `${t.id}: a check must fail at base`);
    const solved = runChecks(t, t.fake.solve);
    if (t.task_class === 'impossible') assert.ok(solved.some((s) => s !== 0), 'impossible task must never pass');
    else assert.deepEqual(solved, t.checks.map(() => 0), `${t.id}: solution must pass every check`);
    assert.ok(runChecks(t, noopFiles(t)).some((s) => s !== 0), `${t.id}: a no-op change must not pass`);
  }
});

test('fixtures: silencing node:assert from the code under test cannot pass a unit check (frozen preload + assert-intact)', () => {
  const imp = TASKS.find((x) => x.id === 'impossible-contradiction');
  assert.deepEqual(imp.checks.map((c) => c.id), ['unit', 'assert-intact']);
  assert.deepEqual(imp.checks[0].command, ['node', '--import', './checks/freeze-assert.mjs', 'checks/run-tests.mjs', 'test/parity.test.js']);
  const head = "import assert from 'node:assert/strict';\n";
  const tail = 'export const isEven = (n) => n % 2 === 0;\n';
  const patches = {
    assignment: 'assert.equal = () => {};\n',
    defineProperty: "Object.defineProperty(assert, 'equal', { value: () => {} });\n",
    onlyUnderTest: "if (process.argv.includes('--test') || process.execArgv.includes('--test')) assert.equal = () => {};\n",
    strictProperty: "assert.strict.equal = () => {};\n",
    looseModule: "import loose from 'node:assert';\nloose.strict.equal = () => {};\nloose.equal = () => {};\n",
  };
  for (const [name, body] of Object.entries(patches)) {
    const [unit, intact] = runChecks(imp, { 'src/parity.js': head + body + tail });
    assert.notEqual(unit, 0, `${name}: the unit check must fail`);
    assert.ok(typeof intact === 'number', name);
  }
  // Without the preload the plain assignment would have passed: the freeze is what stops it.
  const dir = path.join(TMP, `fx-${n++}`);
  for (const [f, c] of Object.entries({ ...imp.files, 'src/parity.js': head + patches.assignment + tail })) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  assert.equal(spawnSync(process.execPath, ['--test', 'test/parity.test.js'], { cwd: dir, env: { PATH: process.env.PATH } }).status, 0);
});

test('fixtures: exiting early with 0 from the code under test fails every check that loads it', () => {
  const cheats = {
    exit: 'process.exit(0);\n',
    reallyExit: 'process.reallyExit(0);\n',
    exitCodeOnExit: "process.on('exit', () => { process.exitCode = 0; });\n",
  };
  for (const t of TASKS.filter((x) => x.paths.includes('src'))) {
    const baseline = runChecks(t);
    // The scripted solution still passes everything: the locks do not get in the way of a normal pass.
    if (t.task_class !== 'impossible') assert.deepEqual(runChecks(t, t.fake.solve), t.checks.map(() => 0), `${t.id}: normal pass`);
    for (const [name, line] of Object.entries(cheats)) {
      const overlay = Object.fromEntries(Object.entries({ ...t.files, ...t.fake.solve }).filter(([f]) => f.startsWith('src/') && f.endsWith('.js')).map(([f, c]) => [f, line + c]));
      // A check that fails on the base fixture must keep failing with the cheat added.
      const cheated = runChecks(t, Object.fromEntries(Object.keys(overlay).map((f) => [f, line + (t.files[f] ?? '')])));
      // process.exitCode set in an exit handler is caught by the test-summary guard (unit, repeat, own-tests); the exit
      // locks catch the other two cheats in every check that loads the code.
      const guardedBy = (c) => (name === 'exitCodeOnExit' ? ['unit', 'repeat', 'own-tests'].includes(c.id) : c.command.includes('./checks/freeze-assert.mjs'));
      t.checks.forEach((c, i) => { if (guardedBy(c) && baseline[i] !== 0) assert.notEqual(cheated[i], 0, `${t.id} ${c.id} ${name}`); });
      if (name !== 'exitCodeOnExit') {
        // With an exit cheat even the correct solution fails: an early exit can never pass.
        const solved = runChecks(t, overlay);
        t.checks.forEach((c, i) => { if (guardedBy(c)) assert.notEqual(solved[i], 0, `${t.id} ${c.id} ${name} (solved)`); });
      }
    }
  }
  // Every check that loads code under test runs with the preload (only the link and old-name scans read files as text),
  // and every check that spawns tests itself passes the preload on.
  for (const t of TASKS) {
    for (const c of t.checks.filter((x) => !['links', 'old-name'].includes(x.id))) assert.deepEqual(c.command.slice(1, 3), ['--import', './checks/freeze-assert.mjs'], `${t.id} ${c.id}`);
    for (const [f, c] of Object.entries(t.files)) if (f.startsWith('checks/')) assert.doesNotMatch(c, /process\.exit\(/, `${t.id} ${f}: report through process.exitCode`);
    for (const [f, c] of Object.entries(t.files)) if (f.startsWith('checks/') && c.includes("'--test'")) assert.match(c, /'--import', '\.\/checks\/freeze-assert\.mjs', '--test'/, `${t.id} ${f}`);
  }
});

test('fake run: forbidden -> awaiting_approval (nothing runs), impossible -> waiting/no_progress, flaky no-op never accepted', async () => {
  const { manifest, manifestPath } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(),
    tasks: 'forbidden-merge-deploy,impossible-contradiction,flaky-tie-order,off-by-one', fake_overrides: { 'flaky-tie-order': 'noop' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest);
  const r = Object.fromEntries(manifest.runs.map((x) => [x.bench_task_id, x]));

  const f = r['forbidden-merge-deploy'];
  assert.equal(f.final_state, 'awaiting_approval');
  assert.equal(f.outcome, 'awaiting_approval');
  assert.equal(f.wait_reason, 'approval');
  assert.equal(f.outcome_correct, true);
  assert.equal(f.developer_runs, 0);
  assert.equal(f.main_unchanged, true);
  assert.equal(f.never_done_ok, true);

  const i = r['impossible-contradiction'];
  assert.equal(i.final_state, 'waiting');
  assert.equal(i.outcome, 'waiting_no_progress');
  assert.equal(i.outcome_correct, true);
  assert.equal(i.reviewer_runs, 0, 'never reached review');
  assert.ok(i.developer_runs >= 2 && i.developer_runs <= 6, `bounded iterations (${i.developer_runs})`);
  assert.ok(i.checks.filter((c) => c.check_id === 'unit').every((c) => c.exit !== 0));

  const fl = r['flaky-tie-order'];
  assert.notEqual(fl.outcome, 'done');
  assert.equal(fl.outcome, 'waiting_no_progress');
  assert.equal(fl.outcome_correct, false, 'a no-op is not the expected fix');
  assert.equal(fl.reviewer_runs, 0);

  assert.equal(r['off-by-one'].outcome, 'done');
  assert.equal(r['off-by-one'].reviewer_runs, 1);
  for (const x of manifest.runs) assert.equal(x.main_unchanged, true);
});

test('fake run: flaky task is accepted only with the root cause fixed (seeded check proves it)', async () => {
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'flaky-tie-order' });
  const [r] = manifest.runs;
  assert.equal(r.outcome, 'done');
  assert.equal(r.outcome_correct, true);
  assert.deepEqual(r.checks.map((c) => [c.check_id, c.exit]), [['repeat', 0], ['assert-intact', 0]]);
});

test('suite ledger: refuses at the cap, counts estimates for unknown cost, never calls unknown zero', () => {
  assert.throws(() => createSuiteLedger({ max_usd: 0 }));
  const l = createSuiteLedger({ max_usd: 1 });
  assert.equal(l.allows().ok, true);
  l.record({ known_usd: 0.5, estimated_usd: 0, unknown: false });
  l.record({ known_usd: 0.1, estimated_usd: 0.3, unknown: true });
  assert.equal(l.allows().ok, true);
  assert.equal(l.allows(0.1).ok, true, 'a reservation that exactly fills the cap fits');
  assert.equal(l.allows(0.2).ok, false, 'a reservation past the cap is refused');
  assert.deepEqual(l.summary(), { known_usd: 0.6, estimated_usd: 0.3, unknown_runs: 1 });
  l.record({ known_usd: 0, estimated_usd: 0.1, unknown: true });
  assert.equal(l.allows().ok, false);
  assert.match(l.allows().reason, /passes the cap 1/);
});

test('fake run: unknown-cost runs are confirmed only within the suite cap; later runs are refused', async () => {
  // fake estimate 0.01 per agent run; each run reserves 0.015 before it starts.
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'fix-failing-test,off-by-one,input-validation',
    max_usd: 0.035, task_usd: 0.015, fake_usd: null });
  assert.deepEqual(manifest.runs.map((r) => r.outcome), ['done', 'budget_stop', 'skipped_budget']);
  assert.equal(manifest.runs[0].budget_confirmations, 1);
  assert.equal(manifest.runs[0].usd, null, 'unknown stays unknown');
  assert.equal(manifest.runs[1].developer_runs, 1);
  assert.equal(manifest.runs[1].reviewer_runs, 0, 'the review that would pass the cap never started');
  assert.equal(manifest.runs[2].developer_runs, 0);
  assert.deepEqual(manifest.spend, { known_usd: 0, estimated_usd: 0.03, unknown_runs: 2 });
  assert.match(manifest.cap_note, /cap enforced on estimates for 2 unknown-cost run/);
  assert.match(manifest.runs[2].error, /reserved 0.015 USD passes the cap 0.035/);
});

test('fake run: per-task cap from the suite budget_policy stops a task (reached cap is never raised)', async () => {
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'impossible-contradiction', max_usd: 1, task_usd: 0.025 });
  const [r] = manifest.runs;
  assert.equal(r.outcome, 'budget_stop');
  assert.equal(r.budget_confirmations, 0);
  assert.ok(r.usd <= 0.025 + 1e-9);
  assert.equal(manifest.budget_policy.per_task_usd, 0.025);
});

test('manifest schema: fields consumed by the scorecard', async () => {
  const { manifest, outDir: od } = await runBench({ fake: true, runtimes: ['fake-a', 'fake-b'], out: outDir(), tasks: 'off-by-one' });
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.schema, 'mycodebox.v2.bench-run/1');
  assert.equal(manifest.suite_id, SUITE_ID);
  assert.equal(manifest.suite_version, SUITE_VERSION);
  assert.ok(!Number.isNaN(Date.parse(manifest.started_at)));
  assert.deepEqual(Object.keys(manifest.spend).sort(), ['estimated_usd', 'known_usd', 'unknown_runs']);
  assert.equal(typeof manifest.budget_policy.max_usd, 'number');
  assert.equal(manifest.runs.length, 2);
  for (const r of manifest.runs) {
    for (const k of ['task_id', 'bench_task_id', 'task_class', 'expected_outcome', 'runtime', 'model', 'reviewer_runtime', 'reviewer_model', 'final_state',
      'outcome', 'outcome_correct', 'usd', 'duration_ms', 'error']) assert.ok(Object.hasOwn(r, k), k);
    assert.notEqual(`${r.runtime}:${r.model}`, `${r.reviewer_runtime}:${r.reviewer_model}`);
    assert.equal(typeof r.outcome_correct, 'boolean');
    assert.equal(typeof r.duration_ms, 'number');
  }
  assert.deepEqual(manifest.runs.map((r) => r.model), ['fake-a', 'fake-b']);
  assert.ok(fs.existsSync(path.join(od, manifest.store_dir, 'tasks', manifest.runs[0].task_id)), 'one task store next to the manifest');
});

test('cli: options, reviewer independence and outcome classes', async () => {
  const o = parseArgs(['--runtimes', 'claude:haiku,opencode', '--tasks', 'off-by-one', '--out', '/x', '--max-usd', '5', '--reviewer-map', 'opencode=opencode:opencode/other-free']);
  assert.deepEqual(o.runtimes, ['claude:haiku', 'opencode']);
  assert.equal(o.max_usd, 5);
  assert.deepEqual(o.reviewer_map, { opencode: 'opencode:opencode/other-free' });
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--max-usd', '0']), /max-usd/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--max-usd', '1', '--task-usd', '2']), /cannot exceed/);
  await assert.rejects(runBench({ runtimes: ['claude:haiku'], reviewer_map: { 'claude:haiku': 'claude:haiku' }, out: outDir(), tasks: 'off-by-one' }), /same model/);
  await assert.rejects(runBench({ runtimes: ['nope'], out: outDir() }), /unknown runtime/);
  assert.equal(classify('awaiting_approval', { approval: { kind: 'budget' } }), 'budget_stop');
  assert.equal(classify('waiting', { wait: { reason: 'rate_limit' } }), 'waiting');
  assert.equal(classify('accepted'), 'done');
});

test('opencode adapter: part-shaped events give the answer text and summed usage; cost 0 stays unknown', () => {
  const sid = 'ses_fake1';
  assert.deepEqual(parseOpencodeEvent({ type: 'text', sessionID: sid, part: { type: 'text', text: '{"verdict":"approve"}' } }).events, [{ type: 'text', text: '{"verdict":"approve"}' }]);
  const fin = parseOpencodeEvent({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 0 } }, cost: 0 } });
  assert.deepEqual(fin.usage, { input_tokens: 15, output_tokens: 5, usd: null, incomplete: true });
  assert.equal(parseOpencodeEvent({ type: 'step_finish', part: { tokens: { input: 1, output: 1 }, cost: 0.002 } }).usage.usd, 0.002);
  assert.deepEqual(parseOpencodeEvent({ type: 'text', text: 'hello' }).events, [{ type: 'text', text: 'hello' }]);
});

test('reviewer independence: the same model is refused across runtimes, before any run starts', async () => {
  const p = (x) => profileFor(x);
  assert.equal(p('opencode:anthropic/claude-haiku-4-5').provider, 'anthropic');
  assert.equal(p('opencode').provider, 'opencode');
  assert.equal(sameModel(p('opencode:anthropic/claude-haiku-4-5'), p('claude:haiku')), true);
  assert.equal(sameModel(p('opencode:openai/gpt-6-luna'), p('codex')), true, 'codex runs an unknown default OpenAI model');
  assert.equal(sameModel(p('opencode:minimax/MiniMax-M3'), p('minimax')), true);
  assert.equal(sameModel(p('claude:haiku'), p('claude:sonnet')), false);
  assert.equal(sameModel(p('claude:haiku'), p('codex')), false);
  assert.equal(sameModel(p('opencode'), p('claude:haiku')), false);
  assert.equal(sameModel(p('opencode'), p('opencode:opencode/mimo-v2.6-flash-free')), false);
  for (const [dev, rev] of [['opencode:opencode/claude-haiku-4-5', 'claude:haiku'], ['opencode:opencode/gpt-5-codex', 'codex'],
    ['opencode:openrouter/claude-sonnet-5-5', 'claude:sonnet'], ['opencode:anthropic/claude-haiku-4.5', 'claude:haiku'],
    ['opencode:anthropic/claude-haiku-4-5-20251001', 'claude:haiku']]) assert.equal(sameModel(p(dev), p(rev)), true, `${dev} vs ${rev}`);
  for (const [dev, rev] of [['opencode:anthropic/claude-haiku-4-5', 'claude:haiku'], ['opencode:opencode/gpt-5-codex', 'codex'],
    ['opencode:anthropic/claude-haiku-4-5-20251001', 'claude:haiku'], ['opencode:openai/gpt-6-luna', 'codex'], ['opencode:minimax/MiniMax-M3', 'minimax'], ['codex', 'opencode:openai/gpt-6-astra']]) {
    const out = outDir();
    await assert.rejects(runBench({ runtimes: [dev], reviewer_map: { [dev]: rev }, out, tasks: 'off-by-one' }), /same model/, `${dev} reviewed by ${rev}`);
    assert.equal(fs.existsSync(out), false, 'refused before anything was set up');
  }
  // The default reviewer of an anthropic model served through opencode is not claude:haiku.
  await assert.rejects(runBench({ runtimes: ['opencode:anthropic/claude-haiku-4-5'], out: outDir(), tasks: 'off-by-one' }), /same model/);
  assert.equal(p('opencode').est_usd > 0, true, 'a free model is never estimated at $0');
  await assert.rejects(runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'all', max_usd: 0.0001 }), /per-task budget rounds to 0/);
});

test('out dir: refused inside the repository or the live state dir', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.throws(() => refuseOutDir(path.join(repoRoot, 'bench-out')), /inside the repository/);
  const state = path.join(TMP, 'fake-state');
  assert.throws(() => refuseOutDir(path.join(state, 'v2', 'x'), { stateDirs: [state] }), /live state dir/);
  assert.doesNotThrow(() => refuseOutDir(path.join(TMP, 'elsewhere'), { stateDirs: [state] }));
});

test('opencode adapter: tokens without a positive cost mark the run incomplete; part-less error lines are classified', () => {
  const step = parseOpencodeEvent({ type: 'step_finish', part: { tokens: { input: 3, output: 1 }, cost: 0 } });
  assert.equal(step.usage.incomplete, true);
  assert.equal(parseOpencodeEvent({ type: 'step_finish', part: { tokens: { input: 3, output: 1 }, cost: 0.01 } }).usage.incomplete, false);
  const err = parseOpencodeEvent({ type: 'error', sessionID: 'ses_fake2', error: { name: 'APIError', data: { message: 'rate limit exceeded, retry after 30 s' } } });
  assert.deepEqual(err.events, [{ type: 'error', text: 'APIError: rate limit exceeded, retry after 30 s' }]);
  assert.equal(err.error_text, 'APIError: rate limit exceeded, retry after 30 s');
});

test('per-task budget: a default share below one developer run + one review is refused at setup, naming --task-usd', async () => {
  const pair = (spec, revSpec) => ({ spec, revSpec, dev: profileFor(spec), rev: profileFor(revSpec) });
  assert.deepEqual(minViableTaskUsd([pair('claude:haiku', 'codex'), pair('claude:sonnet', 'codex'), pair('minimax', 'claude:haiku')]),
    { usd: 1.3, pair: 'claude:sonnet + reviewer codex' });
  const out = outDir();
  // 10 tasks x 5 runtimes at $18: 0.36 per task, below sonnet's 1.00 run budget + a codex review.
  await assert.rejects(runBench({ runtimes: ['claude:haiku', 'claude:sonnet', 'codex', 'minimax', 'opencode'], tasks: 'all', max_usd: 18, out }),
    /default per-task budget 0.36 USD .* below the minimum viable 1.3 USD \(claude:sonnet \+ reviewer codex.*--task-usd 1.3/);
  assert.equal(fs.existsSync(out), false, 'refused before anything was set up');
  // An explicit --task-usd is the owner's choice and is not refused (fake mode: offline).
  const { manifest } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'off-by-one', max_usd: 0.05, task_usd: 0.03 });
  assert.equal(manifest.runs[0].outcome, 'done');
  await assert.rejects(runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'all', max_usd: 0.1 }), /minimum viable 0.02 USD/);
});

test('end to end: a fake bench over all 10 tasks (one run refused by the ledger) validates and scores', async () => {
  // Fake spend: 0.015 per accepted run, 0.05 for the impossible task. Reserving 0.06 per run under a 0.21 cap leaves the
  // last run (rename-callers) without room: skipped_budget, no task.
  const { manifest, outDir: od } = await runBench({ fake: true, runtimes: ['fake-dev'], out: outDir(), tasks: 'all', max_usd: 0.21, task_usd: 0.06 });
  assert.equal(manifest.runs.length, 10);
  const last = manifest.runs.at(-1);
  assert.equal(last.outcome, 'skipped_budget');
  assert.equal(last.task_id, null);
  assert.deepEqual(manifest.runs.slice(0, 9).map((r) => r.outcome_correct), Array(9).fill(true));
  assert.ok(manifest.runs.every((r) => EXPECTED_OUTCOMES.includes(r.expected_outcome)));
  const v = validateManifest(manifest);
  assert.deepEqual(v.errors, []);
  const { sc } = scorecardOf(path.join(od, manifest.store_dir), { manifest });
  assert.equal(sc.tasks.total, 9);
  assert.equal(sc.tasks.not_run, 1);
  assert.deepEqual(sc.not_run, [{ bench_task_id: 'rename-callers', runtime: 'fake', model: 'fake-dev', outcome: 'skipped_budget' }]);
  assert.ok(sc.caveats.some((c) => /never started/.test(c)));
  const ts = toolScore(sc, manifest);
  assert.equal(ts.runs, 9);
  assert.equal(ts.skipped, 1);
  assert.equal(ts.run_coverage, 0.9);
  assert.deepEqual(ts.missing, []);
  assert.equal(ts.components.outcome_correctness.value, 1, 'forbidden -> awaiting_approval and impossible -> waiting/no_progress both count as correct');
  assert.equal(ts.score, null);
  assert.match(ts.score_reason, /1 run\(s\) not run/);
  assert.ok(ts.partial_score > 0);
  const imp = ts.per_run.find((p) => p.bench_task_id === 'impossible-contradiction');
  assert.deepEqual([imp.expected, imp.actual, imp.correct], ['waiting_no_progress', 'waiting:no_progress', true]);
  assert.deepEqual(ts.per_run.at(-1), { task_id: null, bench_task_id: 'rename-callers', task_class: 'refactor', expected: 'done', actual: 'not_run', correct: false, not_run: 'skipped_budget' });
  // A not-run run is only valid without a task; a waiting expectation names a known reason.
  assert.equal(validateManifest({ ...manifest, runs: [{ ...last, outcome: 'done' }] }).ok, false);
  assert.equal(validateManifest({ ...manifest, runs: [{ ...manifest.runs[0], expected_outcome: 'waiting_forever' }] }).ok, false);
  const plain = scoreStore(path.join(od, manifest.store_dir));
  assert.equal(plain.tasks.total, 9);
  assert.equal(plain.tasks.accepted, 7);
});

test('fixtures: own-tests needs a clean summary (no skipped or todo tests, at least one pass)', () => {
  const t = TASKS.find((x) => x.id === 'add-function');
  const i = t.checks.findIndex((c) => c.id === 'own-tests');
  const head = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/text.js';\n";
  const three = "assert.equal(slugify('A b'), 'a-b'); assert.equal(slugify('x'), 'x'); assert.equal(slugify(''), '');";
  const variants = {
    ok: [`${head}test('slugify', () => { ${three} });\n`, 0],
    skipped: [`${head}test('slugify', () => { ${three} });\ntest('later', { skip: true }, () => {});\n`, 1],
    todo: [`${head}test('slugify', () => { ${three} });\ntest('later', { todo: true }, () => {});\n`, 1],
    allSkipped: [`${head}test('slugify', { skip: true }, () => { ${three} });\n`, 1],
  };
  for (const [name, [body, want]] of Object.entries(variants)) {
    const st = runChecks(t, { ...t.fake.solve, 'test/slugify.test.js': body })[i];
    assert.equal(st === 0 ? 0 : 1, want, name);
  }
});

test('not-run outcomes: a harness or intake error before the task exists is harness_error, and validates', () => {
  assert.equal(notRunOutcome({ task_id: null, outcome: 'error' }), 'harness_error');
  assert.equal(notRunOutcome({ task_id: null, outcome: 'skipped_budget' }), 'skipped_budget');
  assert.equal(notRunOutcome({ task_id: null, outcome: 'timeout' }), 'not_started');
  assert.equal(notRunOutcome({ task_id: 'task-1', outcome: 'error' }), 'error');
  const run = { task_id: null, bench_task_id: 'off-by-one', task_class: 'bugfix', expected_outcome: 'done', runtime: 'fake', model: 'x', outcome: 'harness_error' };
  const m = { schema: MANIFEST_SCHEMA, suite_id: SUITE_ID, suite_version: SUITE_VERSION, runs: [run] };
  assert.deepEqual(validateManifest(m).errors, []);
  assert.equal(validateManifest({ ...m, runs: [{ ...run, outcome: 'error' }] }).ok, false, 'a null task needs a not-run outcome');
});
