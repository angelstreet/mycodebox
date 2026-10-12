// Round 4 (OWNER_DECISIONS §12.1-§12.3) through the real goal loop: run limits reach the adapter, a cheap model on an
// impossible task stops after `stall_runs_to_no_progress` stalled runs, an independent feasibility review stops impossible
// requirements on failing checks (and is ignored on green checks), subscription runs never trigger an unknown-cost
// budget stop, quota waits name their entry, and the escalation ladder climbs on failures (never off a pin).
// Fake runtimes, injected clock (a run's time limit is simulated: the real timer runs 1000x shorter), synthetic data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { createVerifier } from '../orchestration/verifier.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createIntake } from '../orchestration/intake.js';
import { route as realRoute } from '../orchestration/router.js';
import { pinnedRoute } from '../orchestration/v2-runtime.js';
import { clock } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-r4gl-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: ['node', '--test', 'test/math.test.js'],
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test'], runtimes: null, models: null }, protected_paths: ['.ai'], approval_policy: { requires: [] } };
// An impossible pair of assertions: add(2, 3) must be 5 and 6.
const TEST_OK = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add sums two numbers', () => { assert.equal(add(2, 3), 5); });\n";
const TEST_IMPOSSIBLE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(2, 3), 6); });\n";

let repos = 0;
function mkRepo(testFile) {
  const dir = path.join(TMP, `repo${++repos}`);
  for (const d of ['src', 'test', '.ai']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.name', 'Test User'); sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), testFile);
  fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(POLICY, null, 1));
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const USAGE = { op: 'usage', input_tokens: 1000, output_tokens: 200 };
const HANG = [USAGE, { op: 'hang' }];
const GOOD = [{ op: 'write', path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' }, USAGE];
const BAD = [{ op: 'write', path: 'src/math.js', content: 'export const add = (a, b) => a - b;\n' }, USAGE];
const say = (o) => ({ op: 'emit', event: { type: 'result', text: `Done.\n${JSON.stringify(o)}` } });
const CLAIM = [...BAD, say({ impossible: true, diagnosis: 'add(2, 3) must equal both 5 and 6' })];
const APPROVE = [say({ verdict: 'approve', findings: [] })];
const IMPOSSIBLE = [say({ verdict: 'reject', impossible: true, diagnosis: 'the check asserts add(2, 3) === 5 and === 6' })];
const ACHIEVABLE = [say({ verdict: 'reject', impossible: false, findings: [{ id: 'meets_goal', severity: 'blocker', message: 'subtracts instead of adding' }] })];
const QUOTA = [{ op: 'stderr', text: 'Error: usage limit exceeded for your plan, try again in 600 seconds' }, { op: 'exit', code: 1 }];

const caps = ['text', 'code', 'tools', 'resume', 'cancel'];
const M = (model, tier, o = {}) => ({ runtime: 'fake', provider: 'fake', model, tier, capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true, ...o });
const LEASH = { docs: { timeout_ms: 150000, max_steps: 40, effort: 'low', stall_runs_to_no_progress: 2 }, 'coding:low': { timeout_ms: 150000, max_steps: 40, effort: 'low', stall_runs_to_no_progress: 2 } };
// A cheap subscription model with the short leash, a priced light model, a priced standard one, and a reviewer that is
// dear enough to be the top rung (so it is never a cheaper developer choice).
const LADDER = [
  M('cheap', 'light', { billing: 'subscription', run_limits: LEASH }),
  M('light2', 'light', { price: { input: 1, output: 5 }, price_as_of: '2026-10-10' }),
  M('std', 'standard', { price: { input: 2, output: 10 }, price_as_of: '2026-10-10' }),
  M('rev', 'strong', { price: { input: 40, output: 200 }, price_as_of: '2026-10-10' }),
];

let worlds = 0;
// dev: { <model>: [script per run, last repeats] }, rev: [script per review].
function world({ registry = LADDER, dev = {}, rev = [APPROVE], testFile = TEST_OK, route = realRoute, policy = {} } = {}) {
  const w = ++worlds;
  const repo = mkRepo(testFile);
  if (Object.keys(policy).length) { fs.writeFileSync(path.join(repo, '.ai', 'project.json'), JSON.stringify({ ...POLICY, ...policy }, null, 1)); sh(repo, 'commit', '-qam', 'policy'); }
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt'), reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  let t = Date.parse('2026-10-12T08:00:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  // Leases keep real elapsed time: a simulated 150 s run must not expire the controller lease a heartbeat would renew.
  const real0 = Date.now();
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now: () => Date.parse('2026-10-12T08:00:00Z') + (Date.now() - real0) });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo], leases, git });
  const devA = fakeAdapter({ allowedRoots: [wtRoot] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot] });
  const log = { dev: [], rev: [] };
  const runs = {};
  const pick = (list, i) => list[Math.min(i, list.length - 1)];
  const ad = {
    id: 'fake', provider_ids: ['fake'], limitSupport: { max_steps: true, context_mode: true, effort: true },
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: registry.map((m) => m.model), efforts: ['low', 'medium', 'high'], features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) {
      const isRev = o.role === 'reviewer';
      (isRev ? log.rev : log.dev).push(o);
      const k = `${isRev ? 'rev' : 'dev'}:${o.model}`;
      const i = runs[k] = (runs[k] ?? -1) + 1;
      const script = isRev ? pick(rev, log.rev.length - 1) : pick(dev[o.model] || [GOOD], i);
      // The run's time limit is simulated: a 150 s limit fires after 150 ms of real time and moves the clock by 150 s.
      const run = (isRev ? revA : devA).start({ ...o, script, timeout_ms: o.timeout_ms ? Math.max(30, Math.round(o.timeout_ms / 1000)) : undefined });
      run.done.then((r) => { if (r.timed_out) t += o.timeout_ms; });
      return run;
    },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
  const storeDir = path.join(base, 'state', 'v2');
  const store = createTaskStore({ dir: storeDir, ...clock() });
  const loop = createGoalLoop({ store, registry: createRegistry({ version: 1, as_of: '2026-10-11', models: registry }), adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot),
    verifier: createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000 }), reviewRoot,
    leases, git, allowFake: true, now, sleep, route, runTimeoutMs: 30 * 60_000 });
  const intake = createIntake({ store });
  const env = { log, store, loop, now };
  env.submit = async (over = {}) => (await intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers', repository: repo, risk_class: 'low',
    runtime_capabilities: ['code'], acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }], ...over,
  }, { source: 'api', actor_id: 'api-client' })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return env;
}
const D = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const devStarts = (env, id) => env.events(id).filter((e) => e.kind === 'task.started' && e.payload.role === 'developer');

test('impossible task on a cheap model: 2 stalled 150 s runs -> waiting/no_progress (stall_runs_to_no_progress, D-024)', async () => {
  const env = world({ dev: { cheap: [HANG] }, rev: [ACHIEVABLE], testFile: TEST_IMPOSSIBLE });
  const task = await env.submit();
  const t0 = env.now();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  const np = D(v, 'no_progress').at(-1);
  assert.equal(np.loop.patch.wait.reason, 'no_progress');
  assert.equal(np.loop.patch.wait.until_ms, null);
  assert.match(np.loop.patch.wait.diagnosis, /2 stalled developer run\(s\) on fake:cheap \(stopped at the run time limit of 150000 ms/);
  assert.match(np.loop.patch.wait.next_action, /next rung is fake:light2/);
  assert.equal(env.log.dev.length, 2, 'two stalled runs, not five');
  assert.equal(D(v, 'run_timeout').length, 2);
  assert.ok(D(v, 'run_timeout').every((d) => d.evidence.includes('stall signature run_timeout:fake:cheap :: timeout')));
  assert.equal(D(v, 'strategy_change').length, 0, 'no §4 strategy rounds on the short leash');
  // limits reached the adapter and are recorded with each start
  for (const o of env.log.dev) { assert.equal(o.timeout_ms, 150000); assert.equal(o.max_steps, 40); assert.equal(o.effort, 'low'); assert.equal(o.context_mode, undefined); }
  const st = devStarts(env, task.task_id)[0].payload;
  assert.deepEqual(st.limits, { timeout_ms: 150000, max_steps: 40, effort: 'low', context_mode: 'standard', stall_runs_to_no_progress: 2 });
  assert.equal(st.limit_sources.timeout_ms, 'registry');
  // the first stall asked an independent reviewer once (it said achievable): the second stall stopped the task
  assert.equal(env.log.rev.length, 1);
  assert.equal(env.log.rev[0].review_role, 'feasibility');
  assert.equal(D(v, 'feasibility_review').length, 1);
  // simulated time: two 150 s runs, no backoff
  assert.equal(env.now() - t0, 300_000);
  // usage carries billing; a subscription's usd stays null
  const u = env.events(task.task_id).filter((e) => e.kind === 'usage.recorded');
  assert.ok(u.filter((e) => e.payload.run_id.includes('.run')).every((e) => e.payload.billing === 'subscription' && e.payload.usd === null));
});

test('impossible requirements: developer claim + independent feasibility review on failing checks -> waiting/no_progress after ONE run', async () => {
  const env = world({ dev: { cheap: [CLAIM] }, rev: [IMPOSSIBLE], testFile: TEST_IMPOSSIBLE });
  const task = await env.submit();
  const t0 = env.now();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 1);
  assert.equal(env.log.rev.length, 1);
  assert.match(env.log.rev[0].prompt, /THE DEVELOPER CLAIMS THE REQUIREMENTS ARE IMPOSSIBLE/);
  assert.match(env.log.rev[0].prompt, /FAILING CHECKS/);
  assert.equal(D(v, 'impossible_claim').length, 1);
  const np = D(v, 'no_progress').at(-1);
  assert.match(np.loop.patch.wait.diagnosis, /independent reviewer fake:\w+ judged the requirements contradictory or impossible: the check asserts/);
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'no_progress'));
  assert.ok(env.now() - t0 < 180_000, 'under 3 minutes');
  // the reviewer is never a developer of the task
  assert.ok(!devStarts(env, task.task_id).some((e) => e.payload.entry === `fake:${env.log.rev[0].model}`));
});

test('a reviewer judging the requirements achievable keeps the loop going, with its findings as feedback', async () => {
  const env = world({ dev: { cheap: [CLAIM, GOOD] }, rev: [ACHIEVABLE, APPROVE] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.store.get(task.task_id);
  assert.equal(D(v, 'feasibility_review')[0].chosen, 'requirements achievable: keep iterating');
  assert.match(env.log.dev[1].prompt, /subtracts instead of adding/);
});

test('an "impossible" verdict on green checks is ignored and journaled', async () => {
  // the second run really changes the code (an unchanged head would reuse the reject and count as a stall)
  const env = world({ dev: { cheap: [GOOD, [{ op: 'write', path: 'src/math.js', content: 'export const add = (a, b) => b + a;\n' }, USAGE]] }, rev: [IMPOSSIBLE, APPROVE] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.store.get(task.task_id);
  assert.equal(D(v, 'impossible_ignored').length, 1);
  assert.equal(D(v, 'no_progress').length, 0);
});

test('capable models keep the §4 rule (no stall limit): stalls feed strategy changes', async () => {
  const reg = [M('dev-a', 'strong'), M('rev', 'standard')];
  const env = world({ registry: reg, dev: { 'dev-a': [HANG] }, testFile: TEST_IMPOSSIBLE });
  const task = await env.submit({ no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 }, run_limits: { timeout_ms: 60000 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 4);
  assert.ok(!D(v, 'strategy_change').some((d) => d.chosen === 'escalate_model'), 'a strong model has no rung above it here');
  assert.equal(D(v, 'strategy_change').length, 1);
  assert.match(D(v, 'no_progress').at(-1).loop.patch.wait.diagnosis, /strategy change/);
  assert.equal(devStarts(env, task.task_id)[0].payload.limits.timeout_ms, 60000, 'task run_limits win');
  assert.equal(env.log.rev.length, 0, 'no feasibility review without a stall limit or a claim');
});

test('subscription runs never trigger the unknown-cost budget stop under a USD cap; quota waits name their entry', async () => {
  const env = world({ dev: { cheap: [QUOTA, GOOD] } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 5 } });
  const first = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(first.state, 'waiting');
  let v = await env.store.get(task.task_id);
  const fb = D(v, 'provider_fallback').at(-1);
  assert.equal(fb.loop.patch.wait.reason, 'rate_limit');
  assert.equal(fb.loop.patch.wait.entry, 'fake:cheap');
  assert.equal(fb.loop.patch.wait.role, 'developer');
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'model.rate_limited' && e.payload.entry === 'fake:cheap'));
  assert.equal(D(v, 'no_progress').length, 0);
  // the reviewer here is priced and known: the whole task runs without an owner budget confirmation
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  v = await env.store.get(task.task_id);
  assert.ok(!env.events(task.task_id).some((e) => e.kind === 'approval.requested' && e.payload.kind === 'budget'), 'no unknown-cost confirmation');
});

test('escalation ladder: failing checks climb cheap -> light2 -> std; each choice and escalation is journaled', async () => {
  const env = world({ dev: { cheap: [BAD], light2: [BAD], std: [GOOD] } });
  const task = await env.submit({ no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 3 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.store.get(task.task_id);
  assert.deepEqual(devStarts(env, task.task_id).map((e) => e.payload.entry), ['fake:cheap', 'fake:cheap', 'fake:light2', 'fake:light2', 'fake:std']);
  const sc = D(v, 'strategy_change');
  assert.deepEqual(sc.map((d) => d.chosen), ['escalate_model', 'escalate_model']);
  assert.ok(sc[0].evidence.includes('escalation fake:cheap -> fake:light2'));
  assert.ok(sc[1].evidence.includes('escalation fake:light2 -> fake:std'));
  assert.deepEqual(D(v, 'assign_developer').map((d) => d.chosen), ['fake:cheap', 'fake:light2', 'fake:std']);
  assert.match(D(v, 'assign_developer')[1].rationale, /Escalation ladder \(D-026\)/);
  assert.match(v.decisions.find((d) => d.kind === 'route').rationale, /Escalation ladder \(D-026\): starts on the cheapest good-enough rung fake:cheap/);
});

test('escalation: a pinned task never leaves its pin; policy routing.escalation false keeps the router ranking', async () => {
  const env = world({ dev: { cheap: [BAD] }, route: pinnedRoute(realRoute) });
  const task = await env.submit({ preferred_models: ['fake:cheap'], no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 2 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.ok(devStarts(env, task.task_id).every((e) => e.payload.entry === 'fake:cheap'));
  assert.ok(!D(v, 'strategy_change').some((d) => d.chosen === 'escalate_model'));
  const off = world({ dev: { cheap: [GOOD], light2: [GOOD], std: [GOOD] }, policy: { routing: { escalation: false } } });
  const t2 = await off.submit({ priority: 'balanced' });
  assert.equal((await off.loop.run(t2.task_id)).state, 'accepted');
  assert.doesNotMatch((await off.store.get(t2.task_id)).decisions.find((d) => d.kind === 'route').rationale, /Escalation ladder/);
});

test('high-risk work never starts on, or escalates to, a model below its floor', async () => {
  const env = world({ dev: { std: [BAD], cheap: [GOOD], light2: [GOOD] }, rev: [APPROVE] });
  const task = await env.submit({ risk_class: 'high', no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 } });
  await env.loop.run(task.task_id, { until: ['waiting', 'awaiting_approval'] });
  const entries = devStarts(env, task.task_id).map((e) => e.payload.entry);
  assert.ok(entries.length >= 1);
  assert.ok(entries.every((e) => !['fake:cheap', 'fake:light2'].includes(e)), entries.join(','));
  const v = await env.store.get(task.task_id);
  assert.ok(!D(v, 'strategy_change').some((d) => d.chosen === 'escalate_model'));
});

// ---------- round-4 sanity fixes (C): no-change runs and repeated claims are stalls; the first measurement keeps the count
const NOOP = [USAGE];
const CLAIM_ONLY = [USAGE, say({ impossible: true, diagnosis: 'add(2, 3) must equal both 5 and 6' })];
const GARBLED = [{ op: 'emit', event: { type: 'result', text: 'I think it is fine.' } }];
const TWO_CHECKS = [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true },
  { id: 'smoke', command: ['node', '-e', '0'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }];
const POLICY2 = { allowlists: { commands: [['node', '--test'], ['node', '-e']], paths: ['src', 'test'], runtimes: null, models: null } };

test('short leash: a timeout then a run that changed nothing -> waiting/no_progress after 2 runs, even when the first evaluation looks like progress', async () => {
  const env = world({ dev: { cheap: [HANG, NOOP] }, rev: [ACHIEVABLE], testFile: TEST_IMPOSSIBLE, policy: POLICY2 });
  const task = await env.submit({ acceptance_checks: TWO_CHECKS });
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 2);
  assert.equal(D(v, 'run_timeout').length, 1);
  assert.equal(D(v, 'run_no_change').length, 1);
  assert.match(D(v, 'no_progress').at(-1).loop.patch.wait.diagnosis, /^2 stalled developer run\(s\) on fake:cheap/);
});

test('short leash: repeated impossibility claims with no new evidence count as stalls (once per run), even when the reviewer answer is unusable', async () => {
  const env = world({ dev: { cheap: [CLAIM_ONLY] }, rev: [GARBLED], testFile: TEST_IMPOSSIBLE });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 2, 'claim + no change in one run is one stall');
  assert.equal(D(v, 'impossible_claim').length, 2);
  assert.equal(D(v, 'run_no_change').length, 0, 'already counted by the claim');
  assert.match(D(v, 'feasibility_review')[0].evidence.join(' '), /unavailable \(unparseable_verdict\)/);
  assert.match(D(v, 'no_progress').at(-1).loop.patch.wait.diagnosis, /^2 stalled developer run\(s\)/);
});

test('without a stall limit, a run that changes nothing is not a stall (capable models keep the §4 rule)', async () => {
  const env = world({ registry: [M('dev-a', 'strong'), M('rev', 'standard')], dev: { 'dev-a': [NOOP] }, testFile: TEST_IMPOSSIBLE });
  const task = await env.submit({ no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(D(v, 'run_no_change').length, 0);
  assert.equal(env.log.dev.length, 4);
});
