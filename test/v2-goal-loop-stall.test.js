// Round 3 (OWNER_DECISIONS §11.3): a developer run that stalls until the run timeout kills it, or exits 0 without fixing
// anything, is an attempt with no new passing evidence. Repeated stalls end in waiting/no_progress (diagnosis + next
// action) without spending the clock on timed backoffs; quota errors still back off; a later real fix still reaches
// accepted. Fake runtime (in-process `hang` until killed by the run timer), injected clock/sleep, synthetic data only.
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
import { clock } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glstall-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: ['node', '--test', 'test/math.test.js'],
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test'], runtimes: null, models: null },
  protected_paths: ['.ai'], approval_policy: { requires: [] } };
const TEST_FILE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n"
  + "test('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n";

let repos = 0;
function mkRepo() {
  const dir = path.join(TMP, `repo${++repos}`);
  for (const d of ['src', 'test', '.ai']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), TEST_FILE);
  fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(POLICY, null, 1));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir };
}

const USAGE = { op: 'usage', input_tokens: 1000, output_tokens: 200 };
const HANG = [USAGE, { op: 'hang' }];                 // works until the run timer kills it
const NOOP = [USAGE];                                  // exits 0 without changing anything
const GOOD = [{ op: 'write', path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' }, USAGE];
const QUOTA = [{ op: 'stderr', text: 'Error: You exceeded your current quota. Retry after 120 seconds' }, { op: 'exit', code: 1 }];
const APPROVE = [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }];
const model = (m, tier) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard'), model('rev', 'standard')] };
// The bench's policy: two identical failures force one strategy change, the next stall suspends.
const BENCH_NP = { same_signature: 2, strategy_changes_without_progress: 1 };
const RUN_TIMEOUT_MS = 150;   // real ms: the fake runtime's run timer is the adapter's own setTimeout

function roleAdapter({ wtRoot, reviewRoot, dev }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: [APPROVE] });
  const log = { dev: [], rev: [] };
  return {
    log, id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
      features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) { if (o.role === 'reviewer') { log.rev.push(o); return revA.start(o); } log.dev.push(o); return devA.start(o); },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
}

let worlds = 0;
// Injected clock: simulated time moves only through the loop's sleep (backoffs), so "no backoff" is observable.
function world({ dev }) {
  const w = ++worlds;
  const repo = mkRepo();
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt'), reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  const storeDir = path.join(base, 'state', 'v2');
  let t = Date.parse('2026-10-12T08:00:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo.dir], leases, git });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev });
  const store = createTaskStore({ dir: storeDir, ...clock() });
  const loop = createGoalLoop({ store, registry: createRegistry(REGISTRY), adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot),
    verifier: createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000 }), reviewRoot,
    leases, git, allowFake: true, now, sleep, runTimeoutMs: RUN_TIMEOUT_MS });
  const intake = createIntake({ store });
  const env = { ad, store, loop, now };
  env.submit = async (over = {}) => (await intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'], no_progress_policy: { ...BENCH_NP },
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }], ...over,
  }, { source: 'api', actor_id: 'api-client' })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return env;
}
const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const states = (v) => v.history.map((h) => h.to);
const timeouts = (env, id) => env.events(id).filter((e) => e.kind === 'tool.failed' && e.payload.error?.class === 'timeout').length;

function assertNoProgressStop(env, v, id) {
  assert.equal(v.status, 'waiting');
  assert.notEqual(v.status, 'accepted');
  const np = loopDecisions(v, 'no_progress').at(-1);
  assert.ok(np, 'a no_progress decision');
  const wait = np.loop.patch.wait;
  assert.equal(wait.reason, 'no_progress');
  assert.equal(wait.until_ms, null, 'revisited on new inputs, not on a timer');
  assert.match(wait.diagnosis, /strategy change/);
  assert.ok(wait.next_action);
  assert.ok(env.events(id).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'no_progress'));
  assert.deepEqual(loopDecisions(v, 'strategy_change').map((d) => d.chosen), ['replan'], 'one strategy change first, never a blind retry');
}

test('stall: a developer run that hangs until the run timeout counts as no progress -> waiting/no_progress, no backoff', async () => {
  const env = world({ dev: [HANG] });
  const task = await env.submit();
  const t0 = env.now();
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const v = await env.store.get(task.task_id);
  assertNoProgressStop(env, v, task.task_id);
  // 2 identical stalls -> replan, 2 more -> suspend: four runs, each killed by the run timer, each checked.
  assert.equal(env.ad.log.dev.length, 4);
  assert.equal(timeouts(env, task.task_id), 4);
  assert.equal(loopDecisions(v, 'run_timeout').length, 4);
  assert.equal(loopDecisions(v, 'provider_fallback').length, 0, 'a run timeout is not a provider backoff');
  assert.equal(states(v).filter((s) => s === 'waiting').length, 1, 'only the final no-progress wait');
  assert.equal(env.now() - t0, 0, 'no simulated time spent on backoffs');
  assert.equal(env.ad.log.rev.length, 0, 'failing checks: the reviewer is never consulted');
  // The next run is told why its predecessor stopped.
  assert.match(env.ad.log.dev[1].prompt, /run_timeout/);
  assert.match(env.ad.log.dev[1].prompt, /time limit/);
  // Time alone does not restart it.
  for (let i = 0; i < 2; i++) assert.equal((await env.loop.step(task.task_id)).transitioned, false);
  assert.equal(env.ad.log.dev.length, 4);
});

test('stall: a developer run that exits 0 without fixing anything -> waiting/no_progress', async () => {
  const env = world({ dev: [NOOP] });
  const task = await env.submit();
  const t0 = env.now();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assertNoProgressStop(env, v, task.task_id);
  assert.equal(env.ad.log.dev.length, 4);
  assert.equal(env.now() - t0, 0);
});

test('stall: timeouts and failing no-op runs share one signature (the checks), so alternation still converges', async () => {
  const env = world({ dev: [HANG, NOOP, HANG, NOOP] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assertNoProgressStop(env, v, task.task_id);
  assert.equal(timeouts(env, task.task_id), 2);
  assert.equal(loopDecisions(v, 'provider_fallback').length, 0);
});

test('stall: a timed-out run that left a correct change is checked and can be accepted; a later real fix is accepted', async () => {
  // (a) the run writes the fix, then hangs until killed: its changes are committed and verified, not discarded.
  const a = world({ dev: [[...GOOD, { op: 'hang' }]] });
  const ta = await a.submit();
  assert.equal((await a.loop.run(ta.task_id)).state, 'accepted');
  assert.equal(timeouts(a, ta.task_id), 1);
  // (b) two stalls force a replan, then a real fix still reaches accepted (no attempt cap).
  const b = world({ dev: [HANG, HANG, GOOD] });
  const tb = await b.submit();
  assert.equal((await b.loop.run(tb.task_id)).state, 'accepted');
  const v = await b.store.get(tb.task_id);
  assert.deepEqual(loopDecisions(v, 'strategy_change').map((d) => d.chosen), ['replan']);
  assert.equal(b.ad.log.dev.length, 3);
  assert.equal(v.evidence.at(-1).exit, 0);
});

test('stall: a quota error still backs off on a timer (waiting until_ms), not a no-progress stop', async () => {
  const env = world({ dev: [QUOTA, GOOD] });
  const task = await env.submit();
  const t0 = env.now();
  const first = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(first.state, 'waiting');
  let v = await env.store.get(task.task_id);
  const fb = loopDecisions(v, 'provider_fallback').at(-1);
  assert.equal(fb.chosen, 'backoff and retry the same runtime');
  assert.equal(fb.loop.patch.wait.reason, 'rate_limit');
  assert.ok(fb.loop.patch.wait.until_ms > t0, 'timed backoff');
  assert.equal(loopDecisions(v, 'no_progress').length, 0);
  assert.equal(loopDecisions(v, 'run_timeout').length, 0);
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  v = await env.store.get(task.task_id);
  assert.ok(env.now() - t0 >= 120_000, 'retry-after honoured');
});

test('stall: cancel during a hanging run still cancels (no stall accounting after cancel)', async () => {
  const env = world({ dev: [[USAGE, { op: 'hang' }]] });
  const task = await env.submit();
  const p = env.loop.run(task.task_id);
  const end = Date.now() + 8000;
  while (env.ad.log.dev.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  await env.loop.cancel(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, reason: 'stop' });
  const r = await p;
  assert.equal(r.state, 'cancelled');
  const v = await env.store.get(task.task_id);
  assert.equal(v.status, 'cancelled');
  assert.equal(loopDecisions(v, 'no_progress').length, 0);
});
