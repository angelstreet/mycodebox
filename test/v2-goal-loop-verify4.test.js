// Round-4 verification of the goal loop at abe580e: variants of X1-X8 (interrupted-run usage, task-branch gate,
// own-lease adoption, reached-cap approval), a GL13 invariant across a crash sweep, and the open risk of two
// controllers on one store. Defects are `todo` tests asserting the required behaviour. Synthetic data only.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv4-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: ['node', '--test', 'test/math.test.js'],
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test', 'out'], runtimes: null, models: null },
  protected_paths: ['.ai'], approval_policy: { requires: [] } };
const TEST_FILE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n"
  + "test('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n";

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
  if (policy) { fs.mkdirSync(path.join(dir, '.ai')); fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(policy, null, 1)); }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

const impl = (body, usage = { input_tokens: 1000, output_tokens: 200 }) => [{ op: 'write', path: 'src/math.js', content: `export const add = ${body};\n` }, { op: 'usage', ...usage }];
const GOOD = impl('(a, b) => a + b');
const PAID = (usd, body = '(a, b) => a + b') => impl(body, { input_tokens: 1000, output_tokens: 200, usd });
const BAD = impl('(a, b) => a - b');
const verdict = (v, findings = [], usage = null) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }, ...(usage ? [{ op: 'usage', ...usage }] : [])];
const APPROVE = verdict('approve');
const APPROVE_PAID = (usd) => verdict('approve', [], { input_tokens: 500, output_tokens: 50, usd });

const model = (m, tier, extra = {}) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true, ...extra });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard', { context_tokens: 200000 }), model('rev', 'standard')] };

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
function world({ dev = [], rev = [], policy = POLICY, loopOpts = {} } = {}) {
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
  const registry = createRegistry(REGISTRY);
  const verifier = createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000 });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev, rev });
  // Each make() is "a controller process": its own store handle, loop and `active` map over the same state dir.
  const make = (wrap = (s) => s) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, wtRoot, storeDir, ad, now, advance: (ms) => { t += ms; }, leases, worktrees, make, ...make() };
  env.reopen = (wrap) => Object.assign(env, make(wrap));
  env.submit = async (over = {}) => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'],
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
    ...over }, { source: 'api', actor_id: 'api-client' })).task;
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
const started = (env, id, role = null) => env.events(id).filter((e) => e.kind === 'task.started' && (!role || e.payload.role === role)).map((e) => e.payload);
const asks = (env, id) => env.events(id).filter((e) => e.kind === 'approval.requested');
const lastWait = (v) => loopDecisions(v).map((d) => d.loop.patch.wait).filter(Boolean).at(-1);
const uniqueEvents = (evs) => { assert.equal(new Set(evs.map((e) => e.event_id)).size, evs.length, 'no duplicate event'); evs.forEach((e, i) => i && assert.ok(e.seq > evs[i - 1].seq, 'seq strictly increasing')); };
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
function dieAt(store, when) {
  const dead = { v: false };
  const err = () => Promise.reject(Object.assign(new Error('controller process crashed'), { code: 'E_TEST_CRASH' }));
  const out = {};
  for (const [k, fn] of Object.entries(store)) {
    out[k] = typeof fn !== 'function' ? fn : (...a) => {
      if (dead.v) return err();
      if (when(k, a)) { dead.v = true; return err(); }
      return fn(...a);
    };
  }
  return { store: out, dead };
}

// ---- X1/X2 variants ------------------------------------------------------------------------------
test('Y1 X1 variant: the interrupted review attempt is recorded as unknown and a cap then STOPS on it (spend unknown), never spends past it', async () => {
  const env = world({ dev: [PAID(0.3)], rev: [APPROVE_PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  const { store } = dieAt(env.store, (k, a) => k === 'recordUsage' && /\.review-/.test(String(a[1]?.run_id)));
  env.reopen(() => store);
  assert.equal((await env.loop.run(task.task_id).catch((e) => e)).code, 'E_TEST_CRASH');
  env.reopen();
  await env.loop.recover();
  const r = await env.loop.run(task.task_id);
  const v = await env.view(task.task_id);
  const a0 = v.usage.find((u) => u.run_id.endsWith('-a0'));
  assert.ok(a0, 'attempt a0 is in the ledger');
  assert.deepEqual([a0.usd, a0.input_tokens, a0.output_tokens], [null, null, null]);
  assert.match(String(a0.source), /interrupted/);
  assert.equal(v.usage_totals.usd, null);
  assert.equal(r.state, 'awaiting_approval', 'the cap cannot be verified with an unknown attempt: owner decides');
  assert.equal(env.revStarts(), 1, 'no second billed review before the owner answered');
  assert.match(asks(env, task.task_id).at(-1).payload.question, /spend unknown/);
  // one confirmation authorizes exactly one more review; the task then completes
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'unknown-ok' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(env.revStarts(), 2);
  assert.equal(env.devStarts(), 1);
  uniqueEvents(env.events(task.task_id));
});

const WRITES = new Set(['transition', 'append', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'setHead', 'snapshotPolicy']);
test('Y2 GL13 across a crash sweep (paid developer and reviewer): after recovery every started run has a usage record and the total is unknown iff any run is', async () => {
  let points = 0;
  const bad = [];
  for (let n = 1; n <= 60; n++) {
    const env = world({ dev: [PAID(0.2, '(a, b) => a - b'), PAID(0.2)], rev: [APPROVE_PAID(0.1)] });
    const task = await env.submit();
    let i = 0;
    const { store, dead } = dieAt(env.store, (k) => WRITES.has(k) && ++i === n);
    env.reopen(() => store);
    const first = await env.loop.run(task.task_id).catch((e) => e);
    if (!dead.v) { assert.equal(first.state, 'accepted'); break; }
    points++;
    try {
      env.reopen();
      await env.loop.recover();
      const r = await env.loop.run(task.task_id);
      assert.equal(r.state, 'accepted', `resumed to ${r.state}`);
      const v = await env.view(task.task_id);
      uniqueEvents(env.events(task.task_id));
      const runs = started(env, task.task_id).map((x) => x.run_id);
      const usageIds = v.usage.map((u) => u.run_id);
      assert.deepEqual([...new Set(runs)].sort(), [...new Set(usageIds)].sort(), 'every started run has exactly one usage record');
      const anyUnknown = v.usage.some((u) => u.usd === null);
      assert.equal(v.usage_totals.usd === null, anyUnknown, `total ${v.usage_totals.usd} vs unknown entries ${anyUnknown}`);
      if (!anyUnknown) assert.ok(Math.abs(v.usage_totals.usd - (0.2 * started(env, task.task_id, 'developer').length + 0.1 * started(env, task.task_id, 'reviewer').length)) < 1e-9);
    } catch (e) { bad.push({ n, message: String(e.message).split('\n')[0] }); }
  }
  assert.ok(points >= 25, `sweep covered only ${points} write points`);
  assert.deepEqual(bad, [], `crash points with a ledger gap: ${JSON.stringify(bad)}`);
});

// ---- X7 variants ---------------------------------------------------------------------------------
test('Y3 X7 variant: a detached HEAD in the task worktree suspends dispatch; restoring the branch + owner resume completes on the task branch tip', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  const wt = env.wt(task.task_id);
  sh(wt, 'checkout', '-q', '--detach');
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const w = lastWait(await env.view(task.task_id));
  assert.equal(w.reason, 'off_task_branch');
  assert.equal(w.until_ms, null);
  assert.match(w.diagnosis, /detached HEAD/);
  assert.equal(env.devStarts(), 1, 'no run off the task branch');
  env.advance(24 * 3600_000);
  assert.equal((await env.loop.step(task.task_id)).transitioned, false, 'time does not fix a checkout');
  sh(wt, 'checkout', '-q', `v2/task/${task.task_id}`);
  await env.loop.resume(task.task_id, { actor: OWNER });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.equal(sh(env.repo.dir, 'rev-parse', `v2/task/${task.task_id}`), v.head_sha);
  assert.equal(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), `v2/task/${task.task_id}`);
});

test('Y3b X7 variant: a branch switch between verification and acceptance is caught before accept, not after', async () => {
  const env = world({ dev: [GOOD], rev: [APPROVE] });
  const task = await env.submit();
  const wt = env.wt(task.task_id);
  // the switch lands while the reviewer looks at the SHA: the reviewer's own checkout is separate, the task worktree moves
  const orig = env.ad.start.bind(env.ad);
  let once = false;
  env.ad.start = (o) => { if (o.role === 'reviewer' && !once) { once = true; sh(wt, 'checkout', '-q', '-b', 'elsewhere'); } return orig(o); };
  const r = await env.loop.run(task.task_id);
  const v = await env.view(task.task_id);
  assert.ok(!states(v).includes('accepted'), `accepted while the worktree is on ${sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')}`);
  assert.equal(r.state, 'waiting');
  assert.equal(lastWait(v).reason, 'off_task_branch');
});

// ---- X6 variants ---------------------------------------------------------------------------------
test('Y4 X6 variant: adoptOwn never adopts a live lease of the same owner for ANOTHER task, nor another owner for this task', async () => {
  for (const [owner, task_id, label] of [['goal-loop', 'other-task', 'same owner, other task'], ['someone-else', null, 'other owner, same task']]) {
    const env = world({ dev: [BAD, GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
    env.advance(7 * 3600_000);
    const other = await env.leases.acquire(`worktree:${task.task_id}`, { owner, task_id: task_id ?? task.task_id, ttl_ms: 3600_000, scope: 'worktree' });
    assert.equal(other.ok, true, label);
    const r = await env.loop.run(task.task_id);
    assert.equal(r.state, 'waiting', label);
    const v = await env.view(task.task_id);
    assert.equal(lastWait(v).reason, 'lease_held', label);
    assert.equal(loopDecisions(v, 'lease_reacquired').length, 0, `${label}: nothing adopted`);
    assert.equal(env.devStarts(), 1, label);
    // even an owner acknowledgement cannot adopt a live foreign/other-task holder
    await env.loop.resume(task.task_id, { actor: OWNER });
    assert.equal((await env.loop.run(task.task_id)).state, 'waiting', label);
    assert.equal(env.devStarts(), 1, label);
  }
});

// Adapted to coordinator decision D-015 (adoptOwn removed): the lost lease is now produced the way a real crash
// produces it -- worktrees.renew() persists its write-ahead lease_id, the backend grants that lease, and the process
// dies before the meta rewrite -- and the restart must adopt exactly that lease. (A lease merely held under the same
// owner name, with another lease_id, is a twin and stays fenced: see Y4 and the lease verifier's finding 2.)
test('Y5 X6 variant: after adopting its own lost lease (write-ahead id) the worktree meta follows, so renew/remove keep working', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  env.advance(7 * 3600_000);
  const real = env.leases.acquire;
  let granted = null;
  env.leases.acquire = async (...a) => {
    const r = await real(...a);
    if (String(a[0]).startsWith('worktree:')) {
      env.leases.acquire = real;
      granted = r;
      throw Object.assign(new Error('controller process crashed after acquire'), { code: 'E_TEST_CRASH' });
    }
    return r;
  };
  await env.loop.run(task.task_id).catch(() => null);   // the crash surfaces inside the lease check
  env.leases.acquire = real;
  assert.ok(granted?.ok, 'the worktree lease was granted before the crash');
  env.reopen();
  await env.loop.recover();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const { loop: cp } = await env.loop.inspect(task.task_id);
  const meta = env.worktrees.owner(env.wt(task.task_id)).lease;
  assert.deepEqual([meta.lease_id, meta.token], [cp.worktree.lease.lease_id, cp.worktree.lease.token]);
  assert.equal(meta.token, granted.lease.token, 'the adopted lease is the one granted before the crash');
  const renewed = await env.worktrees.renew(env.wt(task.task_id), { owner: 'goal-loop' });
  assert.equal(renewed.reacquired, false);
  const kept = await env.worktrees.remove(env.wt(task.task_id), { owner: 'goal-loop' });
  assert.deepEqual(kept, { removed: false, retained: true });
});

// ---- open risk: two controllers on one store ------------------------------------------------------
test('Y6 two controllers over the same store and worktree: the second refuses to step a task the first has in flight', async () => {
    const env = world({ dev: [[{ op: 'delay', ms: 400 }, ...PAID(0.3)]] });
    const task = await env.submit();
    const A = env;
    const B = env.make();
    const pA = A.loop.run(task.task_id);
    await waitFor(() => env.devStarts() === 1);
    const rB = await B.loop.step(task.task_id).catch((e) => e);
    const vMid = await B.store.get(task.task_id);
    const bWrote = vMid.usage.some((u) => u.run_id.endsWith('.run1')) || vMid.status !== 'executing';
    const rA = await pA.catch((e) => e);
    const v = await env.view(task.task_id);
    assert.ok(!bWrote && rB.transitioned === false, `controller B acted on A's in-flight run: B -> ${rB.state ?? rB.code}, usage for run1 ${JSON.stringify(v.usage.find((u) => u.run_id.endsWith('.run1')) ?? null)}, A -> ${rA.state ?? rA.code}`);
  });

// ---- X8 variant ------------------------------------------------------------------------------------
test('Y7 X8 variant: a "raise" that does not clear the reached cap is refused up front, not accepted and re-asked', async () => {
    const env = world({ dev: [[BAD[0], { op: 'usage', input_tokens: 10, output_tokens: 10, usd: 0.8 }], GOOD], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    const n1 = asks(env, task.task_id).length;
    const res = await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'lower', grants: { budget_policy: { max_usd: 0.9 } } }).then(() => 'ok', (e) => e.code);
    if (res === 'ok') {
      const r = await env.loop.run(task.task_id);
      assert.equal(asks(env, task.task_id).length, n1, `re-asked after a non-clearing raise (state ${r.state})`);
    } else assert.equal(res, 'E_INVALID');
  });

test('Y7b X8: a bare confirmation of a reached cap is refused; a real raise continues within the new cap', async () => {
  const env = world({ dev: [[BAD[0], { op: 'usage', input_tokens: 10, output_tokens: 10, usd: 0.8 }], PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  assert.match(asks(env, task.task_id).at(-1).payload.question, /cap reached/i);
  await assert.rejects(env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'confirm-only' }), { code: 'E_INVALID' });
  assert.equal(env.devStarts(), 1);
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'raise', grants: { budget_policy: { max_usd: 2 } } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.ok(v.usage_totals.usd <= 2 + 1e-9);
});

// ---- estimateRun contract: null defers to the default, a partial answer is merged with it ----
test('estimateRun null: the default applies (unknown before any measured run: a cap stops for an estimate); usd-only answers add no stop', async () => {
  const none = world({ dev: [PAID(0.3)], loopOpts: { estimateRun: () => null } });
  const t1 = await none.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await none.loop.run(t1.task_id)).state, 'awaiting_approval');
  assert.match(asks(none, t1.task_id).at(-1).payload.question, /estimate unknown/);
  // a claude-style usd-only estimate: no first-run unknown stop
  const usdOnly = world({ dev: [PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3 }) } });
  const t2 = await usdOnly.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await usdOnly.loop.run(t2.task_id)).state, 'accepted');
});

test('estimateRun usd-only with token caps: the first run needs a confirmation, later runs use the measured token mean (no stop per run)', async () => {
  const env = world({ dev: [[BAD[0], { op: 'usage', input_tokens: 1000, output_tokens: 200, usd: 0.3 }], PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 5, max_input_tokens: 5000, max_output_tokens: 5000 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  assert.match(asks(env, task.task_id).at(-1).payload.question, /estimate unknown/);
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'first-run' });
  await env.loop.run(task.task_id);
  // The repair run (same developer) was estimated from the measured token mean: it started without a second stop. Only the
  // not-yet-measured reviewer may ask (default estimate: unknown).
  assert.equal(env.devStarts(), 2);
  const later = asks(env, task.task_id).slice(1);
  assert.ok(later.every((a) => a.payload.role === 'reviewer' || /reviewer|review/i.test(JSON.stringify(a.payload))), JSON.stringify(later.map((a) => a.payload).slice(0, 2)).slice(0, 400));
});
