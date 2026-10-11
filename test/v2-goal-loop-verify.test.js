// Independent verification probes for the goal loop (v2/05-goal-loop at 68611d8). Each defect is a `todo` test that
// asserts the REQUIRED behaviour, so it starts failing-as-todo and flips to a real pass once fixed. Synthetic data only:
// temp git repos, the scriptable fake runtime, a fake clock shared by the loop and the lease authority.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { createVerifier } from '../orchestration/verifier.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createIntake } from '../orchestration/intake.js';
import { clock } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv-')));
const children = [];
after(() => {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: ['node', '--test', 'test/math.test.js'],
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test', 'out'], runtimes: null, models: null },
  protected_paths: ['.ai'], approval_policy: { requires: [] } };
const TEST_FILE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n"
  + "test('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n";
const HANG_TEST = "import test from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n";
// Eight independent tests: `N` levels pass. Lets a developer make measurable progress inside ONE acceptance check.
const MULTI_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { N } from '../src/multi.js';\n"
  + "for (let i = 1; i <= 8; i++) test(`level ${i}`, () => { assert.ok(N >= i, `N=${N} < ${i}`); });\n";

let repos = 0;
function mkRepo({ policy = POLICY } = {}) {
  const dir = path.join(TMP, `repo${++repos}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'src', 'multi.js'), 'export const N = 0;\n');
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), TEST_FILE);
  fs.writeFileSync(path.join(dir, 'test', 'hang.test.js'), HANG_TEST);
  fs.writeFileSync(path.join(dir, 'test', 'multi.test.js'), MULTI_TEST);
  if (policy) { fs.mkdirSync(path.join(dir, '.ai')); fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(policy, null, 1)); }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

const impl = (body, usage = { input_tokens: 1000, output_tokens: 200 }) => [{ op: 'write', path: 'src/math.js', content: `export const add = ${body};\n` }, { op: 'usage', ...usage }];
const GOOD = impl('(a, b) => a + b');
const BAD = impl('(a, b) => a - b');
const GAMED = impl('(a, b) => (a === 2 && b === 3 ? 5 : 0)');
const verdict = (v, findings = [], usage = null) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }, ...(usage ? [{ op: 'usage', ...usage }] : [])];
const APPROVE = verdict('approve');
const REJECT = verdict('reject', [{ id: 'no_test_gaming', severity: 'blocker', message: 'add() special-cases the test inputs' }]);
const PROSE = [{ op: 'emit', event: { type: 'text', text: 'Looks fine to me, ship it.' } }, { op: 'usage', input_tokens: 500, output_tokens: 50, usd: 0.2 }];
const fail = (text, code = 1) => [{ op: 'stderr', text }, { op: 'exit', code }];
const PUSH = { op: 'emit', event: { type: 'action_request', class: 'read', argv: ['git', 'push', 'origin', 'main'] } };

const model = (m, tier, ctx = 100000) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: ctx, latency_ms: 1, test_only: true });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard', 200000), model('rev', 'standard')] };

function roleAdapter({ wtRoot, reviewRoot, dev, rev }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: rev.length ? rev : [APPROVE] });
  const log = { dev: [], rev: [] };
  return {
    log, devA, revA, id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
      features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) { if (o.role === 'reviewer') { log.rev.push(o); return revA.start(o); } log.dev.push(o); return devA.start(o); },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
}

let worlds = 0;
// Like the author's world, plus: the lease authority shares the loop's fake clock (lease expiry is observable) and the
// verifier's spawn is captured (acceptance-check children are observable).
function world({ dev = [], rev = [], policy = POLICY, loopOpts = {}, registry: reg = REGISTRY } = {}) {
  const w = ++worlds;
  const repo = mkRepo({ policy });
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt'), reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  const storeDir = path.join(base, 'state', 'v2');
  const ck = clock();
  let t = Date.parse('2026-10-11T08:00:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo.dir], leases, git });
  const registry = createRegistry(reg);
  const spawned = [];
  const verifier = createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000,
    spawn: (...a) => { const c = nodeSpawn(...a); spawned.push(c); children.push(c); return c; } });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev, rev });
  const make = (wrap = (s) => s) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, wtRoot, storeDir, ad, spawned, now, advance: (ms) => { t += ms; }, leases, ...make() };
  env.reopen = (wrap) => Object.assign(env, make(wrap));
  env.submit = async (over = {}, { source = 'api', template } = {}) => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'],
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
    ...over }, { source, actor_id: `${source}-client`, template })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  env.view = (id) => env.store.get(id);
  env.devStarts = () => ad.log.dev.length;
  env.revStarts = () => ad.log.rev.length;
  env.wt = (id) => path.join(fs.realpathSync(wtRoot), id);
  return env;
}
const OWNER = { role: 'owner', id: 'owner-1' };
const states = (v) => v.history.map((h) => h.to);
const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const started = (env, id, role = 'developer') => env.events(id).filter((e) => e.kind === 'task.started' && e.payload.role === role).map((e) => e.payload);
const asks = (env, id) => env.events(id).filter((e) => e.kind === 'approval.requested');
const uniqueEvents = (evs) => { assert.equal(new Set(evs.map((e) => e.event_id)).size, evs.length, 'no duplicate event'); evs.forEach((e, i) => i && assert.ok(e.seq > evs[i - 1].seq, 'seq strictly increasing')); };
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
// Step-driven loop with the fake clock: timed waits elapse instantly, so a runaway shows as steps/runs, not wall time.
async function drive(env, id, { maxSteps = 60, stopWhen = () => false } = {}) {
  let r;
  for (let i = 0; i < maxSteps; i++) {
    r = await env.loop.step(id);
    if (r.terminal || r.idle || stopWhen(r)) return { r, steps: i + 1 };
    if (r.transitioned || r.again) continue;
    if (r.until_ms != null) { env.advance(Math.max(0, r.until_ms - env.now()) + 1); continue; }
    return { r, steps: i + 1 };
  }
  return { r, steps: maxSteps, exhausted: true };
}

// ---- 1. worktree lease expiry ---------------------------------------------------------------------
test('V1 a task that outlives its 6 h worktree lease still completes (lease renewed or re-acquired by its owner)', async () => {
    const env = world({ dev: [BAD, GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
    env.advance(7 * 3600_000);   // a long-running task: waits, reviews and runs add up
    const { r } = await drive(env, task.task_id, { maxSteps: 40 });
    const v = await env.view(task.task_id);
    const pingPong = loopDecisions(v, 'lease_unavailable').length;
    assert.equal(r.state, 'accepted', `expected progress after lease expiry; got ${r.state} after ${pingPong} lease_unavailable decisions`);
    assert.ok(pingPong <= 1, 'no repeated blind lease retries');
  });

// ---- 2/3. budget gate at the review stage and the first-run estimate ----------------------------------
test('V2 a budget stop raised before the REVIEW does not cost an extra developer run once the owner extends the budget', async () => {
    const env = world({ dev: [impl('(a, b) => a + b', { input_tokens: 1000, output_tokens: 200, usd: 0.4 })], rev: [APPROVE],
      loopOpts: { estimateRun: ({ role }) => ({ usd: role === 'reviewer' ? 0.7 : 0.4, input_tokens: 1000, output_tokens: 200, duration_ms: 1000, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    assert.equal(env.devStarts(), 1);
    assert.equal(env.revStarts(), 0, 'the reviewer was stopped by the cap (0.4 + 0.7 > 1)');
    await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'budget-2', grants: { budget_policy: { max_usd: 2 } } });
    assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
    assert.equal(env.revStarts(), 1);
    assert.equal(env.devStarts(), 1, 'no developer run was pending: only the review should resume');
  });

test('V3 a capped task without an injected estimator can be started by one explicit owner confirmation', async () => {
    const env = world({ dev: [GOOD] });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 5 } });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    assert.equal(env.devStarts(), 0);
    await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'confirm-cap', grants: { budget_policy: { max_usd: 5 } } });
    const r = await env.loop.run(task.task_id);
    assert.ok(env.devStarts() >= 1, `owner confirmed the cap; got ${r.state} with ${asks(env, task.task_id).length} approval requests and no run`);
  });

// ---- 4. critical risk: approval changes nothing ----------------------------------------------------
test('V4 an owner approval of the routing gate for a critical task is honoured (no identical re-ask)', async () => {
    const env = world();
    const task = await env.submit({ risk_class: 'critical' });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    const first = asks(env, task.task_id).at(-1);
    await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'critical-ok' });
    const { r } = await drive(env, task.task_id, { maxSteps: 12 });
    const again = asks(env, task.task_id).filter((e) => e.payload.question === first.payload.question);
    assert.equal(again.length, 1, `identical question re-asked ${again.length - 1} time(s) after approval (state ${r.state})`);
  });

// ---- 5. cancel during an acceptance check ---------------------------------------------------------
test('V5 cancel while an acceptance check is running kills the check process (T14)', async () => {
    const env = world({ dev: [GOOD] });
    const task = await env.submit({ acceptance_checks: [{ id: 'hang', command: ['node', '--test', 'test/hang.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true, timeout_ms: 6000 }] });
    const p = env.loop.run(task.task_id);
    await waitFor(() => env.spawned.length === 1);
    const child = env.spawned[0];
    const t0 = Date.now();
    await env.loop.cancel(task.task_id, { actor: OWNER, reason: 'stop' });
    try {
      const r = await p;
      assert.equal(r.state, 'cancelled');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 2500).catch(() => {});
      const alive = child.exitCode === null && child.signalCode === null;
      assert.ok(!alive && Date.now() - t0 < 2500, `check process still running ${Date.now() - t0} ms after cancel`);
      assert.equal((await env.view(task.task_id)).evidence.length, 0);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  });

// ---- 6/7. approvals: deny semantics, binding, clamping ----------------------------------------------
test('V6 denying a developer\'s requested action continues the task without that action instead of killing it', async () => {
    const env = world({ dev: [[PUSH, ...GOOD], GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    await env.loop.deny(task.task_id, { actor: OWNER, reason: 'no pushes from tasks' });
    const r = await env.loop.run(task.task_id);
    assert.equal(r.state, 'accepted', `denied push should not end the task; got ${r.state}`);
    assert.match(env.ad.log.dev[1].prompt, /denied|refused/i, 'the developer learns the action was refused');
  });

test('V7 an owner grant is bound to the request it answers: the same restricted action asked again is asked again', async () => {
    const env = world({ dev: [[PUSH, ...GOOD], [PUSH, ...GOOD], GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    assert.equal(asks(env, task.task_id).filter((e) => e.payload.run_id).length, 1);
    await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'once' });
    const r = await env.loop.run(task.task_id);
    const agentAsks = asks(env, task.task_id).filter((e) => e.payload.run_id);
    assert.equal(agentAsks.length, 2, `second push request on run 2 must be surfaced again; got ${agentAsks.length} (state ${r.state})`);
  });

test('V7b approve() refuses grants beyond the classes that were requested', async () => {
    const env = world({ dev: [[PUSH, ...GOOD], GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    await assert.rejects(env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'x', grants: { classes: ['deploy', 'credentials'] } }), { code: 'E_INVALID' });
  });

// ---- 8/9. unbounded identical retries -------------------------------------------------------------
test('V8 a reviewer that keeps answering without a verdict is not retried identically forever (no-progress rule applies to billed reviews)', async () => {
    const env = world({ dev: [GOOD], rev: [PROSE] });
    const task = await env.submit();
    await drive(env, task.task_id, { maxSteps: 80, stopWhen: () => env.revStarts() >= 10 });
    const v = await env.view(task.task_id);
    assert.ok(!states(v).includes('accepted'));
    const entries = new Set(started(env, task.task_id, 'reviewer').map((r) => r.entry));
    const unavailable = loopDecisions(v, 'evaluator_unavailable').length;
    assert.ok(env.revStarts() <= v.no_progress_policy.same_signature || entries.size > 1 || loopDecisions(v, 'no_progress').length,
      `${env.revStarts()} identical reviewer runs (${[...entries].join(',')}) and ${unavailable} unavailable decisions, ${v.usage_totals.usd ?? 'unknown'} USD, no strategy change or suspension`);
  });

test('V9 a developer runtime that crashes after billing, with no alternative left, is not re-run identically forever', async () => {
    const env = world({ dev: [[{ op: 'usage', input_tokens: 2000, output_tokens: 10, usd: 0.1 }, ...fail('Segmentation fault', 139)]] });
    const task = await env.submit();
    await drive(env, task.task_id, { maxSteps: 120, stopWhen: () => env.devStarts() >= 15 });
    const v = await env.view(task.task_id);
    const runs = started(env, task.task_id);
    const firstNoAlt = loopDecisions(v, 'provider_fallback').findIndex((d) => /no compatible alternative|no alternative/.test(d.rationale));
    assert.ok(firstNoAlt >= 0, 'every candidate was tried');
    const after = runs.length - (firstNoAlt + 1);
    assert.ok(after <= v.no_progress_policy.same_signature,
      `${after} identical billed runs after "no alternative" (total ${runs.length} runs, ${v.usage_totals.usd} USD), state ${v.status}`);
  });

// ---- 10. elevated risk ----------------------------------------------------------------------------
test('V10 a high-risk task is not accepted on the independent reviewer alone (security reviewer / owner gate, Phase 5 exit)', async () => {
    const env = world();
    const task = await env.submit({ risk_class: 'high' });
    const r = await env.loop.run(task.task_id);
    const v = await env.view(task.task_id);
    const securityVerdict = v.verdicts.some((x) => x.actor?.role === 'security');
    assert.ok(r.state !== 'accepted' || securityVerdict || asks(env, task.task_id).length, 'high risk accepted with no security review and no owner gate');
  });

// ---- 11. privacy policy string dropped before routing (author deviation 4) -------------------------
test('V11 an unrecognised privacy_policy string fails closed at routing instead of being dropped', async () => {
    const env = world();
    const task = await env.submit({ privacy_policy: 'no_external_providers' });
    const { r } = await drive(env, task.task_id, { maxSteps: 30 });
    assert.equal(env.devStarts(), 0, `developer dispatched on an unmapped privacy policy (state ${r.state})`);
  });

// ---- 12. crash sweep: one crash at every persisted write boundary -----------------------------------
const WRITES = new Set(['transition', 'append', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'setHead', 'snapshotPolicy']);
function crashAtWrite(store, n, dead) {
  let i = 0;
  const err = () => Promise.reject(Object.assign(new Error('controller process crashed'), { code: 'E_TEST_CRASH' }));
  const out = {};
  for (const [k, fn] of Object.entries(store)) {
    out[k] = typeof fn !== 'function' ? fn : (...a) => {
      if (dead.v) return err();
      if (WRITES.has(k) && ++i === n) { dead.v = true; return err(); }
      return fn(...a);
    };
  }
  return out;
}
// One world per crash point; a point's failure is collected (with the state it left the task in), never aborts the sweep.
const sweep = { points: 0, bad: [] };
test('V12 crash sweep (GL06/T18): a crash at every store-write boundary of the repair path recovers to accepted with no duplicate event or run', async () => {
  for (let n = 1; n <= 60; n++) {
    const env = world({ dev: [BAD, GOOD] });
    const task = await env.submit();
    const dead = { v: false };
    env.reopen((s) => crashAtWrite(s, n, dead));
    const first = await env.loop.run(task.task_id).catch((e) => e);
    if (!dead.v) { assert.equal(first.state, 'accepted'); break; }   // past the last write: the sweep is complete
    sweep.points++;
    let crashedIn = null;
    try {
      assert.equal(first.code, 'E_TEST_CRASH', `crash point ${n}`);
      env.reopen();
      crashedIn = (await env.view(task.task_id)).status;
      const rec = await env.loop.recover();
      assert.ok(rec.resumable.includes(task.task_id));
      const r = await env.loop.run(task.task_id).catch((e) => e);
      assert.equal(r.state, 'accepted', `crash point ${n} (task was ${crashedIn}): resumed to ${r.state ?? r.code}`);
      const v = await env.view(task.task_id);
      const evs = env.events(task.task_id);
      uniqueEvents(evs);
      const runs = started(env, task.task_id);
      assert.equal(new Set(runs.map((x) => x.run_id)).size, runs.length, `crash point ${n}: duplicate run id`);
      assert.ok(runs.length <= 3, `crash point ${n}: ${runs.length} developer runs (2 + at most 1 interrupted)`);
      const devEffects = v.effects.filter((e) => e.kind === 'developer_run');
      assert.ok(devEffects.every((e) => ['confirmed', 'failed'].includes(e.phase)), `crash point ${n}: unreconciled run effect`);
      assert.ok(devEffects.filter((e) => e.phase === 'failed').length <= 1, `crash point ${n}: more than one interrupted run`);
      assert.ok(v.evidence.some((e) => e.sha === v.head_sha && e.exit === 0 && e.check_id === 'unit'), `crash point ${n}: no passing evidence on head`);
      const devIds = new Set(runs.map((x) => x.entry));
      assert.ok(v.verdicts.some((x) => x.sha === v.head_sha && x.verdict === 'approve' && !devIds.has(x.actor.id)), `crash point ${n}: no independent approve on head`);
      // a second restart changes nothing
      const before = evs.length;
      env.reopen();
      await env.loop.recover();
      assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
      assert.equal(env.events(task.task_id).length, before, `crash point ${n}: restart of an accepted task wrote events`);
    } catch (e) {
      sweep.bad.push({ n, state: crashedIn, message: String(e.message).split('\n')[0] });
    }
  }
  assert.ok(sweep.points >= 25, `sweep covered only ${sweep.points} write points`);
  // Known defect (V12b) aside, every write boundary must recover.
  const other = sweep.bad.filter((b) => !(b.state === 'clarified' && /E_HELD/.test(b.message)));
  assert.deepEqual(other, [], `crash points that did not recover: ${JSON.stringify(other)}`);
});

test('V12b a crash between worktrees.create() and the plan decision is recoverable on restart', async () => {
    assert.deepEqual(sweep.bad, [], `crash points that did not recover: ${JSON.stringify(sweep.bad)}`);
  });

// ---- 13. the extra no-progress trigger vs measurable progress --------------------------------------
test('V13 monotone progress inside a single acceptance check (one more test passing per iteration) is progress, not "no new passing evidence"', async () => {
    const env = world({ dev: Array.from({ length: 8 }, (_, i) => [{ op: 'write', path: 'src/multi.js', content: `export const N = ${i + 1};\n` }, { op: 'usage', input_tokens: 10, output_tokens: 10 }]) });
    const task = await env.submit({ acceptance_checks: [{ id: 'multi', command: ['node', '--test', 'test/multi.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] });
    assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
    const v = await env.view(task.task_id);
    assert.equal(env.devStarts(), 8);
    assert.equal(loopDecisions(v, 'strategy_change').length, 0, `forced strategy change(s) ${loopDecisions(v, 'strategy_change').map((d) => d.chosen)} despite one more test passing every iteration`);
  });

// ---- 14. guarantees that must hold (plain tests) ---------------------------------------------------
test('V14a unknown USD on a prior run under a cap stops the next dispatch (GL13: unknown is not 0)', async () => {
  const env = world({ dev: [impl('(a, b) => a - b', { input_tokens: 10, output_tokens: 10 }), GOOD], loopOpts: { estimateRun: () => ({ usd: 0.1, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  assert.equal(env.devStarts(), 1);
  const ask = asks(env, task.task_id).at(-1);
  assert.match(ask.payload.question, /unknown/);
  assert.equal((await env.view(task.task_id)).usage_totals.usd, null);
});

test('V14b reviewer spend counts toward the cap (T13/GL13)', async () => {
  const env = world({ dev: [impl('(a, b) => (a === 2 && b === 3 ? 5 : 0)', { input_tokens: 10, output_tokens: 10, usd: 0.3 }), GOOD],
    rev: [verdict('reject', [{ id: 'no_test_gaming', severity: 'blocker', message: 'special-cased' }], { input_tokens: 10, output_tokens: 10, usd: 0.5 }), APPROVE],
    loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const v = await env.view(task.task_id);
  assert.equal(v.usage_totals.usd, 0.8);
  assert.equal(env.devStarts(), 1, '0.8 spent incl. the reviewer; a 0.3 repair run would exceed 1.0');
  assert.equal(loopDecisions(v).at(-1).loop.patch.approval.kind, 'budget');
});

test('V14c with no runtime independent of the developer the task is never accepted', async () => {
  const env = world({ registry: { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong')] } });
  const task = await env.submit();
  const { r } = await drive(env, task.task_id, { maxSteps: 12 });
  const v = await env.view(task.task_id);
  assert.ok(!states(v).includes('accepted'));
  assert.equal(r.state, 'waiting');
  assert.ok(loopDecisions(v, 'evaluator_unavailable').length >= 1);
  assert.equal(v.verdicts.length, 0);
});

test('V14d cancel during the independent review: no verdict, no acceptance, status cancelled', async () => {
  const env = world({ dev: [GOOD], rev: [[{ op: 'delay', ms: 400 }, ...APPROVE]] });
  const task = await env.submit();
  const p = env.loop.run(task.task_id);
  await waitFor(() => env.revStarts() === 1);
  await env.loop.cancel(task.task_id, { actor: OWNER });
  assert.equal((await p).state, 'cancelled');
  const v = await env.view(task.task_id);
  assert.equal(v.status, 'cancelled');
  assert.equal(v.verdicts.length, 0);
  assert.equal(env.events(task.task_id).filter((e) => e.kind === 'task.cancelled').length, 1);
});

test('V14e a developer-authored approve never counts: same entry as developer and reviewer is excluded by the loop and refused by the store', async () => {
  const env = world({ dev: [GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const dev = started(env, task.task_id)[0].entry;
  assert.ok(v.verdicts.every((x) => x.actor.id !== dev));
  // and a forged self-approval by the developer's own entry on a passing SHA cannot unlock accepted
  const w2 = world({ dev: [GOOD], rev: [PROSE] });
  const t2 = await w2.submit();
  assert.equal((await w2.loop.run(t2.task_id, { until: ['waiting'] })).state, 'waiting');
  const v2 = await w2.view(t2.task_id);
  assert.ok(v2.evidence.some((e) => e.sha === v2.head_sha && e.exit === 0));
  await w2.store.recordVerdict(t2.task_id, { sha: v2.head_sha, actor: { role: 'reviewer', id: started(w2, t2.task_id)[0].entry }, verdict: 'approve', findings: [] });
  // The table refuses waiting -> accepted before the acceptance floor is consulted; the floor itself (self-approval
  // never counts) is covered by the task-core verification. Either way the forged verdict unlocks nothing.
  await assert.rejects(w2.store.transition(t2.task_id, 'accepted', { actor: 'forger' }), (e) => ['E_ILLEGAL_TRANSITION', 'E_ACCEPTANCE_UNMET'].includes(e.code));
  assert.equal((await w2.loop.step(t2.task_id)).state, 'waiting', 'the loop does not accept on it either');
  assert.ok(!states(await w2.view(t2.task_id)).includes('accepted'));
});
