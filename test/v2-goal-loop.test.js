// Goal loop E2E over real git worktrees, the scriptable fake runtime, real `node --test` acceptance commands inside a
// temp repo and a scripted fake reviewer. Synthetic data only; every path is under a temp dir.
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
import { validateDecision } from '../orchestration/task-contract.js';
import { route } from '../orchestration/router.js';
import { clock } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-gl-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

// ---- synthetic project ----------------------------------------------------------------------------
const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: ['node', '--test', 'test/math.test.js'],
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test', 'out'], runtimes: null, models: null },
  protected_paths: ['.ai'], approval_policy: { requires: [] } };
const TEST_FILE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n"
  + "test('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n";
const HANG_TEST = "import test from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n";
const FLAKY_TEST = "import test from 'node:test';\nimport fs from 'node:fs';\nimport assert from 'node:assert/strict';\n"
  + "test('flaky', () => { const f = 'flaky-count.txt'; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); assert.equal(n % 2, 1); });\n";

let repos = 0;
function mkRepo({ policy = POLICY } = {}) {
  const dir = path.join(TMP, `repo${++repos}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), TEST_FILE);
  fs.writeFileSync(path.join(dir, 'test', 'hang.test.js'), HANG_TEST);
  fs.writeFileSync(path.join(dir, 'test', 'flaky.test.js'), FLAKY_TEST);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'flaky-count.txt\n');
  if (policy) { fs.mkdirSync(path.join(dir, '.ai')); fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(policy, null, 1)); }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

// ---- scripts for the fake runtime --------------------------------------------------------------
const impl = (body) => [{ op: 'write', path: 'src/math.js', content: `export const add = ${body};\n` }, { op: 'usage', input_tokens: 1000, output_tokens: 200 }];
const GOOD = impl('(a, b) => a + b');
const BAD = impl('(a, b) => a - b');
const GAMED = impl('(a, b) => (a === 2 && b === 3 ? 5 : 0)');   // passes the tests only by special-casing them
const verdict = (v, findings = []) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }];
const APPROVE = verdict('approve');
const REJECT_GAMED = verdict('reject', [{ id: 'no_test_gaming', severity: 'blocker', message: 'add() special-cases the test inputs' }]);
const fail = (text, code = 1) => [{ op: 'stderr', text }, { op: 'exit', code }];

const REGISTRY = { version: 1, as_of: '2026-10-11', models: [
  { runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'strong', capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'dev-b', tier: 'standard', capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'rev', tier: 'standard', capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 2, test_only: true },
] };

// Developer and reviewer are separate fake runtimes; the loop tells them apart only by the role it starts.
function roleAdapter({ wtRoot, reviewRoot, dev, rev }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: rev.length ? rev : [APPROVE] });
  const log = { dev: [], rev: [], devRuns: [] };
  const hooks = { onDev: null, onRev: null };
  return {
    log, hooks, devA, revA,
    id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
      features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) {
      if (o.role === 'reviewer') { log.rev.push(o); hooks.onRev?.(o); return revA.start(o); }
      log.dev.push(o); hooks.onDev?.(o);
      const run = devA.start(o);
      log.devRuns.push(run);
      return run;
    },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
}

let worlds = 0;
// A disposable world: repo, store, leases, worktrees, verifier, adapters and a loop. `reopen()` = controller restart.
function world({ dev = [], rev = [], policy, loopOpts = {}, storeWrap = (s) => s } = {}) {
  const w = ++worlds;
  const repo = mkRepo({ policy });
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt');
  const reviewRoot = path.join(base, 'review');
  fs.mkdirSync(reviewRoot, { recursive: true });
  fs.mkdirSync(path.join(base, 'vtmp'), { recursive: true });
  const storeDir = path.join(base, 'state', 'v2');
  const ck = clock();
  let t = Date.parse('2026-10-11T08:00:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now });   // shares the fake clock: expiry is observable
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo.dir], leases, git });
  const registry = createRegistry(REGISTRY);
  const verifier = createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000 });
  fs.mkdirSync(wtRoot, { recursive: true });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev, rev });
  const make = (adapter = ad, wrap = storeWrap) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: adapter }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts });
    const intake = createIntake({ store });
    return { store, loop, intake };
  };
  const env = { repo, base, wtRoot, reviewRoot, storeDir, ad, now, sleep, advance: (ms) => { t += ms; }, leases, worktrees, registry, verifier, ...make() };
  env.reopen = (adapter = ad, wrap = (s) => s) => Object.assign(env, make(adapter, wrap));
  env.submit = async (over = {}, { source = 'api', template } = {}) => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'],
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
    ...over }, { source, actor_id: `${source}-client`, template })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  env.view = (id) => env.store.get(id);
  env.devStarts = () => ad.log.dev.length;
  env.wt = (id) => path.join(fs.realpathSync(wtRoot), id);
  return env;
}

const states = (v) => v.history.map((h) => h.to);
const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const started = (env, id, role = 'developer') => env.events(id).filter((e) => e.kind === 'task.started' && e.payload.role === role).map((e) => e.payload);

// ---- GL02 / T09 ---------------------------------------------------------------------------------
test('GL02/T09 failing first run -> structured feedback -> fix -> pass on exact SHA -> independent approve', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  const r1 = await env.loop.run(task.task_id, { until: ['repair'] });
  assert.equal(r1.state, 'repair');
  // T09: a failing unit test can never complete the task.
  await assert.rejects(env.store.transition(task.task_id, 'accepted'), (e) => ['E_ILLEGAL_TRANSITION', 'E_ACCEPTANCE_UNMET'].includes(e.code));
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'accepted');
  const v = await env.view(task.task_id);
  const head = sh(env.wt(task.task_id), 'rev-parse', 'HEAD');
  assert.equal(v.head_sha, head);
  // run 2 got the failing test name and assertion class from run 1, not "try again"
  const p2 = env.ad.log.dev[1].prompt;
  assert.match(p2, /STRUCTURED FEEDBACK/);
  assert.match(p2, /add sums two numbers/);
  assert.match(p2, /ERR_ASSERTION/);
  const unit = v.evidence.filter((e) => e.check_id === 'unit');
  assert.ok(unit.some((e) => e.exit !== 0 && e.sha !== head), 'failing evidence on the first SHA');
  assert.ok(unit.some((e) => e.exit === 0 && e.sha === head), 'passing evidence on the final SHA');
  const approve = v.verdicts.find((x) => x.sha === head && x.verdict === 'approve');
  assert.ok(approve);
  assert.notEqual(approve.actor.id, started(env, task.task_id)[1].entry, 'reviewer differs from the developer');
  assert.equal(env.ad.log.rev.length, 1, 'reviewer only consulted once the checks passed');
});

test('GL02 no 3-attempt cutoff: three different failures in a row, then success', async () => {
  const env = world({ dev: [BAD, impl("() => { throw new TypeError('nope'); }"), impl('(a, b) => `${a}${b}`'), GOOD] });
  const task = await env.submit();
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'accepted');
  assert.equal(env.devStarts(), 4);
  const v = await env.view(task.task_id);
  assert.equal(loopDecisions(v, 'strategy_change').length, 0, 'different signatures: plain repairs, no forced change, no cutoff');
  assert.equal(loopDecisions(v, 'repair').length, 3);
});

// ---- helpers for crash / timing scenarios -------------------------------------------------------
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
// A store whose process "dies": once dead() is true every call throws, so the old controller can write nothing more.
function crashable(store, dead, failOnce = () => false) {
  const out = {};
  for (const [k, fn] of Object.entries(store)) {
    out[k] = typeof fn !== 'function' ? fn : (...args) => {
      if (dead()) return Promise.reject(Object.assign(new Error('controller process crashed'), { code: 'E_TEST_CRASH' }));
      if (failOnce(k, args)) return Promise.reject(Object.assign(new Error('crash right after the decision'), { code: 'E_TEST_CRASH' }));
      return fn(...args);
    };
  }
  return out;
}
const uniqueEvents = (evs) => { assert.equal(new Set(evs.map((e) => e.event_id)).size, evs.length, 'no duplicate event'); evs.forEach((e, i) => i && assert.ok(e.seq > evs[i - 1].seq)); };

// ---- GL01 -----------------------------------------------------------------------------------------
test('GL01 UI, API, schedule and agent tasks get the same goal contract and the same loop', async () => {
  const env = world();
  const ids = [];
  for (const source of ['ui', 'api', 'schedule', 'agent']) ids.push((await env.submit({}, { source })).task_id);
  const CONTRACT = ['goal', 'scope', 'prohibited_actions', 'definition_of_done', 'acceptance_checks', 'risk_class', 'runtime_capabilities', 'privacy_policy',
    'approval_policy', 'budget_policy', 'no_progress_policy', 'retry_strategy', 'review_policy', 'base_sha', 'repository'];
  const views = await Promise.all(ids.map((id) => env.view(id)));
  for (const v of views.slice(1)) for (const k of CONTRACT) assert.deepEqual(v[k], views[0][k], `field ${k}`);
  assert.deepEqual(views.map((v) => v.created_by.kind), ['ui', 'api', 'schedule', 'agent']);
  assert.deepEqual(views[0].budget_policy, { mode: 'track' });
  for (const id of ids) assert.equal((await env.loop.run(id)).state, 'accepted');
  const shapes = await Promise.all(ids.map(async (id) => states(await env.view(id)).join('>')));
  assert.equal(new Set(shapes).size, 1, 'identical lifecycle for every source');
  // Defaults come from the documented template / project policy, never invented.
  const d = await env.submit({ acceptance_checks: undefined });
  assert.deepEqual(d.acceptance_checks[0].command, POLICY.test_command);
  // The informational opt-out is recorded but never dispatched to a developer.
  const info = await env.submit({}, { template: 'informational' });
  const r = await env.loop.step(info.task_id);
  assert.equal(r.transitioned, false);
  assert.equal((await env.view(info.task_id)).status, 'created');
});

test('T01 missing project policy -> awaiting_approval with a clarification; fixed policy + approval -> proceeds', async () => {
  const env = world({ policy: null });
  const task = await env.submit();
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'awaiting_approval');
  const v = await env.view(task.task_id);
  assert.equal(v.outcome, 'needs_owner');
  assert.equal(env.devStarts(), 0);
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'approval.requested' && e.payload.kind === 'clarification'));
  fs.mkdirSync(path.join(env.repo.dir, '.ai'));
  fs.writeFileSync(path.join(env.repo.dir, '.ai', 'project.json'), JSON.stringify(POLICY));
  await env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'policy-added' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
});

// ---- GL03 / GL07 ----------------------------------------------------------------------------------
test('GL03 identical failures force evidence-based strategy changes (replan, then a different model), then success', async () => {
  const env = world({ dev: [BAD, BAD, BAD, BAD, BAD, BAD, BAD, GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const changes = loopDecisions(v, 'strategy_change');
  assert.deepEqual(changes.map((d) => d.chosen), ['replan', 'model']);
  for (const d of changes) {
    assert.ok(d.alternatives.length >= 3);
    assert.ok(d.evidence.some((e) => /same signature 3x/.test(e)));
  }
  const runs = started(env, task.task_id);
  assert.equal(runs.length, 8);
  // BAD patches are byte-identical, so their check evidence collapses onto one SHA: the 7 failing iterations show
  // as dev runs plus the 3x-signature evidence above, and the accepted SHA's checks pass.
  assert.ok(v.evidence.some((e) => e.exit !== 0), 'failing checks recorded');
  assert.equal(v.evidence.at(-1).exit, 0);
  assert.equal(runs[0].entry, 'fake:dev-a');
  assert.equal(runs[6].entry, 'fake:dev-b', 'model changed after the second forced change');
  assert.match(env.ad.log.dev[3].prompt, /PLAN REVISION 1/);
  assert.notEqual(v.verdicts.at(-1).actor.id, 'fake:dev-b');
  assert.notEqual(v.verdicts.at(-1).actor.id, 'fake:dev-a');
});

test('GL07 no progress: 3 strategy changes without new passing evidence -> waiting(no_progress), no runaway', async () => {
  const env = world({ dev: [BAD] });
  const task = await env.submit();
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(v.outcome, 'waiting');
  assert.deepEqual(loopDecisions(v, 'strategy_change').map((d) => d.chosen), ['replan', 'model', 'harness']);
  assert.equal(env.devStarts(), 12);
  const np = loopDecisions(v, 'no_progress').at(-1);
  assert.match(np.loop.patch.wait.diagnosis, /3 strategy change/);
  assert.ok(np.loop.patch.wait.next_action);
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'no_progress'));
  // Time passing alone does not restart it.
  env.advance(24 * 3600_000);
  for (let i = 0; i < 3; i++) assert.equal((await env.loop.step(task.task_id)).transitioned, false);
  assert.equal(env.devStarts(), 12);
  // An explicit owner resume is a new input: replan.
  await env.loop.resume(task.task_id, { actor: { role: 'owner', id: 'owner-1' } });
  assert.equal((await env.loop.step(task.task_id)).state, 'replan');
});

// ---- GL04 -----------------------------------------------------------------------------------------
test('GL04 unknown check result and missing artifacts never pass; unavailable evaluator -> waiting, never accepted', async () => {
  // (a) a check that never exits: killed at its timeout, exit unknown -> waiting
  const a = world();
  const ta = await a.submit({ acceptance_checks: [{ id: 'hang', command: ['node', '--test', 'test/hang.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true, timeout_ms: 1500 }] });
  const ra = await a.loop.run(ta.task_id, { until: ['waiting'] });
  assert.equal(ra.state, 'waiting');
  const va = await a.view(ta.task_id);
  assert.ok(va.evidence.every((e) => e.exit === null));
  assert.equal(loopDecisions(va).at(-1).loop.patch.wait.reason, 'evidence_unavailable');
  assert.ok(!states(va).includes('accepted'));

  // (b) declared artifact missing although the command exits 0 -> not passing, structured feedback
  const b = world();
  const tb = await b.submit({ acceptance_checks: [{ id: 'report', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'artifact', artifact: 'out/report.txt', required: true }] });
  assert.equal((await b.loop.run(tb.task_id, { until: ['repair'] })).state, 'repair');
  const vb = await b.view(tb.task_id);
  assert.equal(vb.evidence[0].exit, 0);
  assert.equal(vb.evidence[0].artifact, null);
  assert.equal(loopDecisions(vb).at(-1).loop.patch.feedback.checks[0].failures[0].error_class, 'missing_artifact');
  await assert.rejects(b.store.transition(tb.task_id, 'accepted'));

  // (c) the reviewer answers prose without a verdict: unavailable -> waiting; later a real verdict -> accepted
  const c = world({ rev: [[{ op: 'emit', event: { type: 'text', text: 'Looks fine to me, ship it.' } }], APPROVE] });
  const tc = await c.submit();
  assert.equal((await c.loop.run(tc.task_id, { until: ['waiting'] })).state, 'waiting');
  const vc = await c.view(tc.task_id);
  assert.equal(loopDecisions(vc, 'evaluator_unavailable').length, 1);
  assert.equal(vc.verdicts.length, 0, 'prose is never recorded as a verdict');
  assert.equal((await c.loop.run(tc.task_id)).state, 'accepted');
  assert.equal(c.devStarts(), 1, 're-evaluation does not rerun the developer');
  assert.equal(c.ad.log.rev.length, 2);
});

test('flaky check (pass and fail on the same SHA) is marked and never accepted on the flaky pass', async () => {
  const env = world();
  const task = await env.submit({ acceptance_checks: [{ id: 'flaky', command: ['node', '--test', 'test/flaky.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] });
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  const v = await env.view(task.task_id);
  const ev = v.evidence.filter((e) => e.check_id === 'flaky');
  assert.deepEqual(ev.map((e) => e.exit), [1, 0], 'fail then pass on one SHA');
  assert.equal(ev[0].sha, ev[1].sha);
  assert.equal(loopDecisions(v, 'flaky').length, 1);
  assert.equal(loopDecisions(v).at(-1).loop.patch.feedback.kind, 'flaky');
  assert.equal(env.ad.log.rev.length, 0, 'a flaky pass is not even sent to review');
});

// ---- GL05 / T15 -----------------------------------------------------------------------------------
test('GL05 independent reviewer rejects a superficially passing patch; developer repairs; checks rerun', async () => {
  const env = world({ dev: [GAMED, GOOD], rev: [REJECT_GAMED, APPROVE] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const [rej, appr] = v.verdicts;
  assert.equal(rej.verdict, 'reject');
  assert.equal(appr.verdict, 'approve');
  assert.notEqual(rej.sha, appr.sha);
  assert.ok(v.evidence.some((e) => e.sha === rej.sha && e.exit === 0), 'the gamed patch passed the tests');
  assert.ok(v.evidence.some((e) => e.sha === appr.sha && e.exit === 0), 'checks rerun on the repaired SHA');
  assert.match(env.ad.log.dev[1].prompt, /no_test_gaming/);
  assert.match(env.ad.log.dev[1].prompt, /review_reject/);
});

test('T15 tests pass but the reviewer keeps disagreeing: evidence cannot settle it -> owner decides, never accepted', async () => {
  const env = world({ dev: [GAMED], rev: [REJECT_GAMED] });
  const task = await env.submit({ no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 } });
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'awaiting_approval');
  const v = await env.view(task.task_id);
  assert.equal(loopDecisions(v).at(-1).loop.patch.approval.kind, 'review_disagreement');
  assert.ok(!states(v).includes('accepted'));
  assert.ok(v.evidence.length > 0 && v.evidence.every((e) => e.exit === 0), 'checks ran and every one passed');
});

test('T15 reviewer approves but the required tests are red: never accepted, back to repair (evidence outranks the verdict)', async () => {
  const BROKEN = impl('(a, b) => 0');
  const env = world({ dev: [BROKEN], rev: [APPROVE] });
  const task = await env.submit({ no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 } });
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  let v = await env.view(task.task_id);
  assert.ok(v.evidence.length > 0 && v.evidence.every((e) => e.exit !== 0), 'the required check is red');
  assert.equal(v.verdicts.filter((x) => x.verdict === 'approve' && v.evidence.some((e) => e.sha === x.sha && e.exit !== 0)).length, 0, 'no approval is recorded against red evidence');
  // Even when the loop runs on (reviewer script still says approve), the red SHA is never accepted.
  await env.loop.run(task.task_id);
  v = await env.view(task.task_id);
  assert.ok(!states(v).includes('accepted'));
  assert.notEqual(v.status, 'accepted');
});

// ---- GL06 / T12 -----------------------------------------------------------------------------------
test('T12/GL06 rate limit: backoff (waiting) twice, then a compatible fallback runtime; state preserved', async () => {
  const RL = fail('429 Too Many Requests. retry-after: 2');
  const env = world({ dev: [RL, RL, RL, GOOD] });
  const task = await env.submit();
  const t0 = env.now();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.deepEqual(loopDecisions(v, 'provider_fallback').map((d) => d.chosen), ['backoff and retry the same runtime', 'backoff and retry the same runtime', 'switch to a compatible runtime']);
  assert.equal(env.events(task.task_id).filter((e) => e.kind === 'model.rate_limited').length, 3);
  assert.ok(env.now() - t0 >= 4000, 'retry-after honoured by waiting');
  assert.equal(states(v).filter((s) => s === 'waiting').length, 2);
  assert.deepEqual(started(env, task.task_id).map((r) => r.entry), ['fake:dev-a', 'fake:dev-a', 'fake:dev-a', 'fake:dev-b']);
});

test('GL06 provider outage -> compatible fallback; context exhaustion -> compacted fresh run', async () => {
  const out = world({ dev: [fail('mcode: command not found', 127), GOOD] });
  const t1 = await out.submit();
  assert.equal((await out.loop.run(t1.task_id)).state, 'accepted');
  assert.deepEqual(started(out, t1.task_id).map((r) => r.entry), ['fake:dev-a', 'fake:dev-b']);

  const ctxw = world({ dev: [fail('Error: context length exceeded for this model'), GOOD] });
  const t2 = await ctxw.submit();
  assert.equal((await ctxw.loop.run(t2.task_id)).state, 'accepted');
  assert.match(ctxw.ad.log.dev[1].prompt, /CONTEXT SUMMARY/);
  assert.equal(loopDecisions(await ctxw.view(t2.task_id), 'provider_fallback')[0].chosen, 'compact context / larger model');
});

test('GL06/T18 controller crash mid-run: restart reconciles the unconfirmed run and resumes without duplicates', async () => {
  let dead = false;
  const env = world({ dev: [[{ op: 'hang' }], GOOD] });
  env.reopen(env.ad, (s) => crashable(s, () => dead));
  const task = await env.submit();
  const p = env.loop.run(task.task_id).catch((e) => e);
  await waitFor(() => env.devStarts() === 1);
  dead = true;                                 // the controller process dies with a run in flight
  env.reopen();                                // new process: fresh store and loop over the same state dir
  const rec = await env.loop.recover();
  assert.equal(rec.pendingEffects.length, 1);
  assert.equal((await env.view(task.task_id)).status, 'unknown_external_effect');
  // The orphan run of the dead process ends; that process can no longer write anything.
  await env.ad.devA.cancel(env.ad.log.devRuns[0]);
  assert.equal((await p).code, 'E_TEST_CRASH');
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'accepted');
  const v = await env.view(task.task_id);
  const runs = v.effects.filter((e) => e.kind === 'developer_run');
  assert.deepEqual(runs.map((e) => e.phase), ['failed', 'confirmed']);
  assert.ok(loopDecisions(v, 'crash_recovery').length === 1);
  assert.match(env.ad.log.dev[1].prompt, /interrupted/);
  uniqueEvents(env.events(task.task_id));
  // recovering again is a no-op
  const before = env.events(task.task_id).length;
  env.reopen();
  await env.loop.recover();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(env.events(task.task_id).length, before);
});

test('T18 crash between a decision and its transition: the restart replays the recorded transition, no second decision', async () => {
  let fired = false;
  const env = world();
  env.reopen(env.ad, (s) => crashable(s, () => false, (m, args) => {
    if (m === 'transition' && args[1] === 'ready' && !fired) { fired = true; return true; }
    return false;
  }));
  const task = await env.submit();
  await assert.rejects(env.loop.run(task.task_id), { code: 'E_TEST_CRASH' });
  assert.equal((await env.view(task.task_id)).status, 'planned');
  env.reopen();
  await env.loop.recover();
  const r = await env.loop.step(task.task_id);
  assert.equal(r.state, 'ready');
  assert.equal(loopDecisions(await env.view(task.task_id), 'assign_developer').length, 1);
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  uniqueEvents(env.events(task.task_id));
});

// ---- GL08 / GL13 ----------------------------------------------------------------------------------
test('GL08 every automatic decision is a structured record; routine choices never ask the owner', async () => {
  const env = world({ dev: [BAD, BAD, BAD, GOOD], rev: [REJECT_GAMED, APPROVE] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.ok(v.decisions.length >= 8);
  for (const d of v.decisions) {
    assert.deepEqual(validateDecision(d).errors, [], d.decision_id);
    assert.ok(d.alternatives.length >= 2, `${d.kind} lists alternatives`);
    assert.ok(d.evidence.length >= 1, `${d.kind} cites evidence`);
    assert.ok(d.rationale.length > 10);
    if (d.reversible) assert.ok(d.rollback, `${d.kind} says how to undo/retry`);
  }
  const kinds = new Set(v.decisions.map((d) => d.kind));
  for (const k of ['interpret', 'plan', 'route', 'assign_developer', 'repair', 'strategy_change', 'accept']) assert.ok(kinds.has(k), k);
  // Every transition the loop chose (not mechanical ones) is preceded by its decision.
  const chosen = loopDecisions(v).filter((d) => d.loop.next).map((d) => d.loop.next.to);
  assert.ok(chosen.includes('accepted'));
  assert.equal(env.events(task.task_id).filter((e) => e.kind === 'approval.requested').length, 0, 'no owner question for safe reversible choices');
});

test('GL13 usage measured where reported, unknown stays null; exhausted quota throttles without spend', async () => {
  let quotaCalls = 0;
  const env = world({ loopOpts: { quota: () => (++quotaCalls <= 1 ? { status: 'exhausted', retry_after_ms: 30_000 } : { status: 'ok' }) } });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const dev = v.usage.find((u) => u.run_id.includes('.run'));
  assert.equal(dev.input_tokens, 1000);
  assert.equal(dev.usd, null);
  assert.ok(dev.unknown.includes('usd'));
  const rev = v.usage.find((u) => u.run_id.includes('.review'));
  assert.deepEqual([rev.input_tokens, rev.output_tokens, rev.usd], [null, null, null]);
  assert.equal(v.usage_totals.usd, null, 'unknown spend is not $0');
  const wait = loopDecisions(v, 'budget_wait');
  assert.equal(wait.length, 1);
  assert.equal(wait[0].loop.patch.wait.reason, 'quota');
  assert.equal(env.devStarts(), 1, 'no start while the quota was exhausted');
});

// ---- GL09 -----------------------------------------------------------------------------------------
test('GL09 privileged actions need explicit authorization whatever the goal text says; silence is never approval', async () => {
  // (a) the goal itself asks for a production deploy
  const a = world();
  const ta = await a.submit({ goal: 'Implement add(a, b) in src/math.js and then deploy it to production' });
  assert.equal((await a.loop.run(ta.task_id)).state, 'awaiting_approval');
  for (let i = 0; i < 5; i++) { a.advance(7 * 24 * 3600_000); assert.equal((await a.loop.step(ta.task_id)).transitioned, false); }
  assert.equal((await a.view(ta.task_id)).outcome, 'needs_owner');
  assert.equal(a.devStarts(), 0);
  const req = a.events(ta.task_id).find((e) => e.kind === 'approval.requested');
  assert.ok(req.payload.classes.includes('deploy'));

  // (b) the developer asks for `git push origin main` and labels it "read": the label is ignored, nothing runs
  const b = world({ dev: [[{ op: 'emit', event: { type: 'action_request', class: 'read', argv: ['git', 'push', 'origin', 'main'] } }, ...GOOD], GOOD] });
  const tb = await b.submit();
  assert.equal((await b.loop.run(tb.task_id)).state, 'awaiting_approval');
  const ask = b.events(tb.task_id).find((e) => e.kind === 'approval.requested' && e.payload.run_id);
  assert.equal(ask.payload.action.class, 'command');
  assert.ok(ask.payload.classes.includes('push_shared'));
  assert.equal(sh(b.repo.dir, 'remote').length, 0);
  assert.equal(sh(b.repo.dir, 'rev-parse', 'main'), b.repo.sha, 'main untouched');
  // an explicit owner decision is the only way forward; refusing the action continues the task without it (#13)
  await b.loop.deny(tb.task_id, { actor: { role: 'owner', id: 'owner-1' }, reason: 'no pushes from tasks' });
  assert.equal((await b.loop.step(tb.task_id)).state, 'repair');
  assert.equal((await b.loop.run(tb.task_id)).state, 'accepted');
  assert.match(b.ad.log.dev[1].prompt, /refused/);
  assert.equal(sh(b.repo.dir, 'rev-parse', 'main'), b.repo.sha, 'main still untouched');
  // denying a gate the goal cannot proceed without ends the task truthfully
  await a.loop.deny(ta.task_id, { actor: { role: 'owner', id: 'owner-1' }, reason: 'no production deploys' });
  assert.equal((await a.loop.step(ta.task_id)).state, 'failed_unrecoverable');

  // (c) the developer edits the read-only project policy
  const c = world({ dev: [[{ op: 'write', path: '.ai/project.json', content: '{"schema_version":1}' }, ...GOOD]] });
  const tc = await c.submit();
  assert.equal((await c.loop.run(tc.task_id)).state, 'awaiting_approval');
  assert.equal(loopDecisions(await c.view(tc.task_id)).at(-1).kind, 'scope_gate');
});

// ---- T10 / T13 / T14 ------------------------------------------------------------------------------
test('T10/GL12 source changes after verification: SHA revalidated, checks and review rerun on the new SHA', async () => {
  const env = world({ rev: [APPROVE] });
  const task = await env.submit();
  let once = false;
  env.ad.hooks.onRev = () => {
    if (once) return;
    once = true;   // an out-of-band commit lands while the reviewer looks at the old SHA
    const wt = env.wt(task.task_id);
    fs.writeFileSync(path.join(wt, 'src', 'extra.js'), 'export const extra = 1;\n');
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-q', '-m', 'concurrent change');
  };
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const head = sh(env.wt(task.task_id), 'rev-parse', 'HEAD');
  assert.equal(v.head_sha, head);
  assert.equal(loopDecisions(v, 'revalidate_sha').length, 1);
  const shas = [...new Set(v.evidence.map((e) => e.sha))];
  assert.equal(shas.length, 2, 'checks ran on the old and on the new SHA');
  assert.ok(v.evidence.some((e) => e.sha === head && e.exit === 0));
  assert.ok(v.verdicts.some((x) => x.sha === head && x.verdict === 'approve'));
  assert.equal(env.ad.log.rev.length, 2);
});

test('T13 explicit budget cap: stop before overspend -> awaiting_approval; an owner extension continues within it', async () => {
  const PAID_BAD = [BAD[0], { op: 'usage', input_tokens: 1000, output_tokens: 200, usd: 0.4 }];
  const env = world({ dev: [PAID_BAD], loopOpts: { estimateRun: () => ({ usd: 0.4, input_tokens: 1000, output_tokens: 200, duration_ms: 1000, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  assert.equal(env.devStarts(), 2, '0.8 spent; a third 0.4 run would exceed 1.0');
  let v = await env.view(task.task_id);
  assert.ok(v.usage_totals.usd <= 1);
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'budget.threshold'));
  env.advance(30 * 24 * 3600_000);
  assert.equal((await env.loop.step(task.task_id)).transitioned, false, 'time does not authorize spend');
  await env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'budget-2', grants: { budget_policy: { max_usd: 2 } } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  v = await env.view(task.task_id);
  assert.equal(env.devStarts(), 5);
  assert.ok(v.usage_totals.usd <= 2 + 1e-9);
});

test('T14 cancel during a run: no commit, no evidence, no later writes; status is cancelled', async () => {
  const env = world({ dev: [[{ op: 'delay', ms: 300 }, ...GOOD]] });
  const task = await env.submit();
  const p = env.loop.run(task.task_id);
  await waitFor(() => env.devStarts() === 1);
  await env.loop.cancel(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, reason: 'changed my mind' });
  const r = await p;
  assert.equal(r.state, 'cancelled');
  const v = await env.view(task.task_id);
  assert.equal(v.status, 'cancelled');
  assert.equal(v.evidence.length, 0);
  const wt = env.wt(task.task_id);
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), env.repo.sha, 'nothing committed');
  assert.match(fs.readFileSync(path.join(wt, 'src', 'math.js'), 'utf8'), /not implemented/, 'the run never wrote');
  const evs = env.events(task.task_id);
  const at = evs.findIndex((e) => e.kind === 'task.cancelled');
  assert.deepEqual(evs.slice(at + 1).map((e) => e.kind), ['action.failed'], 'only the truthful effect outcome after cancel');
  assert.equal((await env.loop.step(task.task_id)).terminal, true);
  await assert.rejects(env.store.recordUsage(task.task_id, { usd: 1 }), { code: 'E_CANCELLED' });
});

// ---- minimum genuine end-to-end test with a machine-readable trace -------------------------------
test('E2E submit -> route -> worktree -> failing test -> verifier rejection -> fix -> rerun on final SHA -> independent review -> accepted -> restart without duplicates; repeated with 429, cancel, budget cap, unsafe action', async () => {
  const trace = { schema: 'mycodebox.v2.goal-loop-trace/1', synthetic: true, scenarios: {} };
  const record = async (name, env, id, extra = {}) => {
    const v = await env.view(id);
    const evs = env.events(id);
    uniqueEvents(evs);
    trace.scenarios[name] = { task_id: id, created_by: v.created_by, final_state: v.status, outcome: v.outcome, head_sha: v.head_sha,
      states: states(v), decisions: v.decisions.map((d) => ({ kind: d.kind, chosen: d.chosen })),
      evidence: v.evidence.map((e) => ({ check_id: e.check_id, sha: e.sha, exit: e.exit })), verdicts: v.verdicts.map((x) => ({ sha: x.sha, actor: x.actor.id, verdict: x.verdict })),
      developer_runs: started(env, id).map((r) => r.entry), usage_totals: v.usage_totals, events: evs.length, ...extra };
    return v;
  };

  // happy path with one repair loop, then a controller restart
  const e = world({ dev: [BAD, GOOD] });
  const t = await e.submit({}, { source: 'ui' });
  assert.equal((await e.loop.run(t.task_id)).state, 'accepted');
  const n = e.events(t.task_id).length, runs = e.devStarts();
  e.reopen();
  await e.loop.recover();
  assert.equal((await e.loop.run(t.task_id)).state, 'accepted');
  assert.equal(e.events(t.task_id).length, n, 'restart: no duplicate event');
  assert.equal(e.devStarts(), runs, 'restart: no duplicate run');
  const v = await record('happy', e, t.task_id, { restart_new_events: e.events(t.task_id).length - n });
  assert.equal(v.evidence[0].exit, 1);
  assert.equal(v.evidence.at(-1).exit, 0);
  assert.equal(v.evidence.at(-1).sha, v.head_sha);
  assert.ok(v.verdicts.every((x) => x.sha === v.head_sha));

  const rl = world({ dev: [fail('429 rate limit exceeded, retry after 3s'), GOOD] });
  const trl = await rl.submit({}, { source: 'ui' });
  assert.equal((await rl.loop.run(trl.task_id)).state, 'accepted');
  assert.ok(states(await record('rate_limit_429', rl, trl.task_id)).includes('waiting'));

  const c = world({ dev: [[{ op: 'delay', ms: 300 }, ...GOOD]] });
  const tc = await c.submit({}, { source: 'ui' });
  const pc = c.loop.run(tc.task_id);
  await waitFor(() => c.devStarts() === 1);
  await c.loop.cancel(tc.task_id, { actor: { role: 'owner', id: 'owner-1' } });
  assert.equal((await pc).state, 'cancelled');
  assert.equal((await record('cancel', c, tc.task_id)).evidence.length, 0);

  const b = world({ dev: [[BAD[0], { op: 'usage', usd: 0.6 }]], loopOpts: { estimateRun: () => ({ usd: 0.6 }) } });
  const tb = await b.submit({ budget_policy: { mode: 'cap', max_usd: 1 } }, { source: 'ui' });
  assert.equal((await b.loop.run(tb.task_id)).state, 'awaiting_approval');
  assert.equal((await record('budget_cap', b, tb.task_id)).usage_totals.usd, 0.6);

  const u = world({ dev: [[{ op: 'emit', event: { type: 'action_request', argv: ['git', 'push', '--force', 'origin', 'main'] } }, ...GOOD]] });
  const tu = await u.submit({}, { source: 'ui' });
  assert.equal((await u.loop.run(tu.task_id)).state, 'awaiting_approval');
  assert.equal((await record('unsafe_action', u, tu.task_id)).outcome, 'needs_owner');

  const out = path.join(TMP, 'goal-loop-trace.json');
  fs.writeFileSync(out, `${JSON.stringify(trace, null, 1)}\n`);
  if (process.env.V2_TRACE_OUT) fs.copyFileSync(out, process.env.V2_TRACE_OUT);
  const back = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(back.scenarios), ['happy', 'rate_limit_429', 'cancel', 'budget_cap', 'unsafe_action']);
  assert.deepEqual(Object.values(back.scenarios).map((s) => s.final_state), ['accepted', 'accepted', 'cancelled', 'awaiting_approval', 'awaiting_approval']);
});

// ---- delivery hook, infrastructure, admission -----------------------------------------------------
test('delivery: accepted work goes through the injected integrate(task) hook; an unknown outcome is reconciled, never repeated blindly', async () => {
  const calls = [];
  // first call: the remote does not answer; reconcile shows nothing happened; the retry with the same key waits on CI, then succeeds
  const integrate = async (task, ctx) => { calls.push({ id: task.task_id, ...ctx }); return calls.length === 1 ? { next: 'pushed?', reason: 'remote did not answer' }
    : calls.length === 2 ? { next: 'waiting', retry_after_ms: 1000, reason: 'remote CI pending' } : { next: 'release_verifying', release_verified: true, reason: 'gates green' }; };
  integrate.reconcile = async () => ({ applied: false });
  const env = world({ loopOpts: { integrate } });
  const task = await env.submit({ review_policy: { mode: 'goal_loop', independent_review: true, deliver: true } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.ok(['integrating', 'unknown_external_effect', 'release_verifying', 'accepted'].every((s) => states(v).includes(s)));
  assert.equal(calls.length, 3, 'unknown -> reconciled retry -> CI pending wait -> verified');
  assert.equal(calls[0].sha, v.head_sha);
  assert.ok(v.history.some((h) => h.from === 'waiting' && h.to === 'integrating'), 'D-007: a pending integration resumes in integrating');
  assert.equal(new Set(calls.map((c) => c.idempotency_key)).size, 1, 'same idempotency key on the retry');
  assert.deepEqual(v.effects.filter((e) => e.kind === 'integration').map((e) => e.phase), ['failed', 'confirmed']);

  // A controller that never answers: bounded by the no-progress rule, then the owner decides.
  const never = async () => ({ next: '???' });
  never.reconcile = async () => ({ applied: false });
  const nv = world({ loopOpts: { integrate: never } });
  const tn = await nv.submit({ review_policy: { mode: 'goal_loop', independent_review: true, deliver: true } });
  assert.equal((await nv.loop.run(tn.task_id)).state, 'awaiting_approval');
  assert.equal((await nv.view(tn.task_id)).effects.filter((e) => e.kind === 'integration').length, 3);

  // Delivery requested but no integration controller wired: the task waits in integrating, it never skips delivery.
  const bare = world();
  const tb = await bare.submit({ review_policy: { mode: 'goal_loop', independent_review: true, deliver: true } });
  const r = await bare.loop.run(tb.task_id);
  assert.equal(r.state, 'integrating');
  assert.equal(r.idle, true);
});

test('infrastructure failure under the task opens a System Operations incident and waits; admission pause holds new runs', async () => {
  const ops = [];
  let enospc = 1;
  const flakyGit = (args, o) => {
    if (args.includes('commit') && enospc-- > 0) return Promise.reject(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }));
    return git(args, o);
  };
  let paused = true;
  const env = world({ loopOpts: { git: flakyGit, opsRequester: { request: async (r) => { ops.push(r); return { incident_id: 'inc-test-1', executed: false }; } },
    admission: { isPaused: () => paused, reasons: () => (paused ? ['incident:inc-test-0'] : []) } } });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id, { until: ['waiting'] })).state, 'waiting');
  assert.equal(loopDecisions(await env.view(task.task_id)).at(-1).kind, 'admission_paused');
  assert.equal(env.devStarts(), 0);
  paused = false;
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'accepted');
  const v = await env.view(task.task_id);
  const inc = loopDecisions(v, 'infra_incident');
  assert.equal(inc.length, 1);
  assert.equal(inc[0].loop.patch.wait.incident_id, 'inc-test-1');
  assert.equal(ops[0].op.type, 'host.disk_pressure');
  assert.equal(ops[0].role, 'goal-loop', 'the loop only requests operations');
});

// ---- verifier follow-ups (decisions D3, D-012, D-013, #7, #1, D2) ------------------------------------
test('D3 router: a no-route or single-candidate decision still lists at least two alternatives (valid §9 record)', () => {
  const reg = createRegistry(REGISTRY).withProbes({ fake: { available: true, models: ['dev-a', 'dev-b', 'rev'], efforts: ['low'], features: {} } });
  const base = { task_id: 'task-r', goal: 'Implement add', risk_class: 'low', runtime_capabilities: ['code'] };
  const none = route({ ...base, runtime_capabilities: ['vision'] }, { registry: reg, allowFake: true, checkAction: () => ({ allow: true }) });
  assert.equal(none.choice, null);
  const one = route(base, { registry: reg, allowFake: true, exclude: ['fake:dev-b', 'fake:rev'], checkAction: () => ({ allow: true }) });
  assert.equal(one.choice, 'fake:dev-a');
  for (const r of [none, one]) {
    assert.ok(r.decision.alternatives.length >= 2);
    assert.deepEqual(validateDecision({ ...r.decision, task_id: 'task-r' }).errors, []);
  }
  // D-014: only an explicit floor grant waives the critical-risk floor
  const crit = { ...base, risk_class: 'critical' };
  assert.equal(route(crit, { registry: reg, allowFake: true, checkAction: () => ({ allow: true }) }).choice, null);
  assert.ok(route(crit, { registry: reg, allowFake: true, checkAction: () => ({ allow: true }), floorGrants: ['critical_risk'] }).choice);
});

test('D-012 iterations_without_progress is configurable: varying failures with no new evidence force a recorded change', async () => {
  const env = world({ dev: [BAD, impl("() => { throw new TypeError('nope'); }"), BAD, GOOD] });
  const task = await env.submit({ no_progress_policy: { same_signature: 3, strategy_changes_without_progress: 3, iterations_without_progress: 2 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const sc = loopDecisions(v, 'strategy_change');
  assert.equal(sc.length, 1, 'two stale iterations (different signatures) forced one change');
  assert.ok(sc[0].evidence.some((e) => /limit 2/.test(e)));
});

test('D-013 high risk: security reviewer named by the policy, then an owner approval bound to the exact head SHA', async () => {
  const env = world({ policy: { ...POLICY, security_reviewer: 'fake:rev' } });
  const task = await env.submit({ risk_class: 'high' });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  let v = await env.view(task.task_id);
  assert.deepEqual(v.verdicts.map((x) => [x.actor.role, x.verdict]), [['reviewer', 'approve'], ['security', 'approve']]);
  const ask = env.events(task.task_id).filter((e) => e.kind === 'approval.requested').at(-1);
  assert.equal(ask.payload.kind, 'risk_acceptance');
  assert.deepEqual(ask.payload.keys, [`accept:${v.head_sha}`]);
  await assert.rejects(env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, grants: { classes: ['deploy'] } }), { code: 'E_INVALID' });
  await assert.rejects(env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, grants: { budget_policy: { max_usd: 9 } } }), { code: 'E_INVALID' });
  await env.loop.approve(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, approval_ref: 'risk-ok' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(env.devStarts(), 1, 'the approval resumes verification only');
  v = await env.view(task.task_id);
  assert.equal(v.verdicts.length, 2, 'verdicts on the same SHA are reused, not re-bought');
});

test('#1/W1 a worktree lease taken by another owner suspends the task (no blind retries); after the owner resumes, the freed lease is re-acquired and the meta follows', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  env.advance(7 * 3600_000);
  const intruder = await env.leases.acquire(`worktree:${task.task_id}`, { owner: 'someone-else', task_id: 'other', ttl_ms: 3600_000 });
  assert.equal(intruder.ok, true);
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  assert.equal(r.idle, true);
  const w = loopDecisions(await env.view(task.task_id)).at(-1).loop.patch.wait;
  assert.equal(w.reason, 'lease_held');
  assert.equal(w.until_ms, null);
  assert.equal(env.devStarts(), 1);
  await env.leases.release(intruder.lease);
  await env.loop.resume(task.task_id, { actor: { role: 'owner', id: 'owner-1' } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(loopDecisions(await env.view(task.task_id), 'lease_reacquired').length, 1);
  const { loop: cp } = await env.loop.inspect(task.task_id);
  const meta = env.worktrees.owner(env.wt(task.task_id)).lease;
  assert.deepEqual([meta.lease_id, meta.token], [cp.worktree.lease.lease_id, cp.worktree.lease.token], 'worktree meta holds the lease the loop uses');
});

test('D2 a task whose log is corrupt is never stepped (store_error), and the loop reads events from the store', async () => {
  const env = world();
  const task = await env.submit();
  await env.loop.step(task.task_id);
  const log = path.join(env.storeDir, 'tasks', task.task_id, 'events.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(log, `${[lines[0], '{"not": "an event"}', ...lines.slice(1)].join('\n')}\n`);
  env.reopen();
  await env.loop.recover();
  const r = await env.loop.step(task.task_id);
  assert.equal(r.transitioned, false);
  assert.match(r.note, /store error/);
  assert.equal(env.devStarts(), 0);
});

test('D-016 one controller per store: a second instance never steps; recover() takes over (write-ahead adopt) and fences the old one', async () => {
  const env = world();
  const task = await env.submit();
  const A = env.loop;
  assert.equal((await A.step(task.task_id)).state, 'clarified');
  const before = env.events(task.task_id).length;
  env.reopen();                                   // controller B over the same store dir and lease backend
  const B = env.loop;
  const rB = await B.step(task.task_id);
  assert.equal(rB.transitioned, false);
  assert.equal(rB.controller, 'E_HELD');
  assert.match(rB.note, /another goal-loop controller holds service:local:goal-loop/);
  assert.equal(env.events(task.task_id).length, before, 'the second instance wrote nothing');
  // B is the restart after A died: recover() adopts A's lease through A's write-ahead id, releases it, re-acquires
  await B.recover();
  const rA = await A.step(task.task_id);
  assert.equal(rA.transitioned, false, 'the old instance is fenced');
  assert.equal(rA.controller, 'E_HELD');
  assert.equal((await B.run(task.task_id)).state, 'accepted');
  uniqueEvents(env.events(task.task_id));
});

test('Z1 fence per write: a controller fenced mid-run (before any heartbeat could notice) writes nothing afterwards', async () => {
  const env = world({ dev: [[{ op: 'delay', ms: 400 }, ...GOOD]] });
  const task = await env.submit();
  const p = env.loop.run(task.task_id);
  await waitFor(() => env.devStarts() === 1);
  const before = env.events(task.task_id).length;
  // someone takes the controller lease out from under the running instance (its heartbeat interval is 20 s)
  const f = fs.readdirSync(env.storeDir).find((x) => /^controller\..+\.intent\.json$/.test(x));
  const intent = JSON.parse(fs.readFileSync(path.join(env.storeDir, f), 'utf8'));
  const ad = await env.leases.adopt({ resource: intent.resource, lease_id: intent.lease_id, owner: intent.owner, task_id: null });
  assert.ok(ad.ok);
  await env.leases.release(ad.lease);
  const other = await env.leases.acquire(intent.resource, { owner: 'goal-loop', ttl_ms: 60_000, scope: 'controller someone-else' });
  assert.ok(other.ok);
  const r = await p;
  assert.equal(r.idle, true);
  assert.match(r.note, /controller lease lost/);
  assert.equal(env.events(task.task_id).length, before, 'no store write after the fence');
  assert.equal(sh(env.wt(task.task_id), 'rev-parse', 'HEAD'), env.repo.sha, 'no commit after the fence');
});

test('m4 a policy block that carries no approval request goes to waiting with reason, diagnosis and next action, not a keyless awaiting_approval', async () => {
  // delivery bridge shape for a protected path / path not allowlisted / target policy: no controller request, so no key
  const integrate = async () => ({ next: 'awaiting_approval', classes: ['integration'], keys: [], reason: 'integration needs the owner: changes protected paths (.ai/x)' });
  integrate.reconcile = async () => ({ applied: false });
  const env = world({ loopOpts: { integrate } });
  const task = await env.submit({ review_policy: { mode: 'goal_loop', independent_review: true, deliver: true } });
  const r = await env.loop.run(task.task_id);
  const v = await env.view(task.task_id);
  assert.notEqual(r.state, 'awaiting_approval', 'nothing the owner could approve exists');
  assert.equal(r.state, 'waiting');
  const wait = loopDecisions(v).at(-1).loop.patch.wait;
  assert.equal(wait.reason, 'policy_block');
  assert.match(wait.diagnosis, /protected paths/);
  assert.ok(wait.next_action);
  assert.equal(wait.until_ms, null, 'revisited on an owner resume or a policy change, not on a timer');
});
