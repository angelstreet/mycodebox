// Round-5 verification of the goal loop at 2cf2855: D-016 controller lease (two controllers, takeover, heartbeat
// expiry during a long run, superseded sleeping controller), D-017 interaction (owner cancel while recovery is
// pending), Y3b handoff gate and Y7 variants. Defects are `todo` tests asserting the required behaviour. Synthetic only.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv5-')));
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
const verdict = (v, findings = []) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }];
const APPROVE = verdict('approve');

const model = (m, tier, extra = {}) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true, ...extra });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard', { context_tokens: 200000 }), model('rev', 'standard')] };

function roleAdapter({ wtRoot, reviewRoot, dev, rev }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: rev.length ? rev : [APPROVE] });
  const log = { dev: [], rev: [] };
  const hooks = { onDev: null };
  return {
    log, hooks, devA, revA, id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
      features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) { if (o.role === 'reviewer') { log.rev.push(o); return revA.start(o); } log.dev.push(o); hooks.onDev?.(o); return devA.start(o); },
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
  // Each make() is "a controller process": own store handle, loop, controller lease and `active` map over one state dir.
  const make = (wrap = (s) => s, extra = {}) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts, ...extra });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, wtRoot, storeDir, ad, now, advance: (ms) => { t += ms; }, leases, worktrees, make, ...make() };
  env.reopen = (wrap, extra) => Object.assign(env, make(wrap, extra));
  env.submit = async (over = {}) => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'],
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
    ...over }, { source: 'api', actor_id: 'api-client' })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  env.view = (id) => env.store.get(id);
  env.devStarts = () => ad.log.dev.length;
  env.wt = (id) => path.join(fs.realpathSync(wtRoot), id);
  return env;
}
const OWNER = { role: 'owner', id: 'owner-1' };
const states = (v) => v.history.map((h) => h.to);
const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const started = (env, id, role = null) => env.events(id).filter((e) => e.kind === 'task.started' && (!role || e.payload.role === role)).map((e) => e.payload);
const lastWait = (v) => loopDecisions(v).map((d) => d.loop.patch.wait).filter(Boolean).at(-1);
const uniqueEvents = (evs) => { assert.equal(new Set(evs.map((e) => e.event_id)).size, evs.length, 'no duplicate event'); evs.forEach((e, i) => i && assert.ok(e.seq > evs[i - 1].seq, 'seq strictly increasing')); };
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
const WRITES = new Set(['transition', 'append', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'setHead', 'snapshotPolicy']);
// Counts successful store writes made through this handle once `flag.on` is set (writes "after the event").
function countAfter(store, flag, log) {
  const out = {};
  for (const [k, fn] of Object.entries(store)) {
    out[k] = typeof fn !== 'function' ? fn : async (...a) => { const r = await fn(...a); if (flag.on && WRITES.has(k)) log.push(k); return r; };
  }
  return out;
}
function dieAt(store, when) {
  const dead = { v: false };
  const err = () => Promise.reject(Object.assign(new Error('controller process crashed'), { code: 'E_TEST_CRASH' }));
  const out = {};
  for (const [k, fn] of Object.entries(store)) {
    out[k] = typeof fn !== 'function' ? fn : (...a) => { if (dead.v) return err(); if (when(k, a)) { dead.v = true; return err(); } return fn(...a); };
  }
  return { store: out, dead };
}
const CTL = { controller: { ttl_ms: 3000 } };   // heartbeat every 1 s (ttl/3, floor 1 s)

// ---- D-016: takeover of a LIVE controller ---------------------------------------------------------
test('Z1 D-016 recover() on a second instance while the first is alive and mid-run: the first must write nothing after losing the lease', async () => {
    const env = world({ dev: [[{ op: 'delay', ms: 600 }, ...PAID(0.3)], PAID(0.3)], loopOpts: CTL });
    const task = await env.submit();
    const flag = { on: false }, late = [];
    env.reopen((s) => countAfter(s, flag, late));
    const A = env.loop;
    const pA = A.run(task.task_id);
    await waitFor(() => env.devStarts() === 1);
    const B = env.make();   // a second instance started by mistake, running its normal startup path
    flag.on = true;
    await B.loop.recover();
    const pB = B.loop.run(task.task_id);
    const rA = await pA.catch((e) => e);
    const rB = await pB.catch((e) => e);
    assert.deepEqual(late, [], `the fenced instance wrote after the takeover: ${late.join(', ')} (A -> ${rA.state ?? rA.code}, B -> ${rB.state ?? rB.code})`);
    assert.equal(rB.state, 'accepted');
    uniqueEvents(env.events(task.task_id));
  });

test('Z2 D-016 the controller lease expires during a long run (heartbeat renew fails): no writes after the loss; the next step regains control, reconciles and finishes', async () => {
  const env = world({ dev: [[{ op: 'delay', ms: 1600 }, ...PAID(0.3)], PAID(0.3)], loopOpts: CTL });
  const task = await env.submit();
  const flag = { on: false }, late = [];
  env.reopen((s) => countAfter(s, flag, late));
  env.ad.hooks.onDev = () => { if (env.devStarts() === 1) setTimeout(() => { env.advance(10_000); flag.on = true; }, 200); };   // the lease lapses under the running step
  const r1 = await env.loop.run(task.task_id);
  assert.equal(env.devStarts(), 1);
  assert.equal(r1.idle, true);
  assert.match(r1.note, /controller lease lost/);
  assert.deepEqual(late, [], `writes after the lease lapsed: ${late.join(', ')}`);
  const mid = await env.view(task.task_id);
  assert.equal(mid.status, 'executing');
  assert.ok(!mid.usage.some((u) => u.run_id.endsWith('.run1')), 'nothing recorded for the orphaned run yet');
  // the same instance steps again: it re-acquires the free lease, reconciles (interrupted run -> unknown) and completes
  flag.on = false;
  const r2 = await env.loop.run(task.task_id);
  assert.equal(r2.state, 'accepted');
  const v = await env.view(task.task_id);
  assert.equal(loopDecisions(v, 'crash_recovery').length, 1);
  const run1 = v.usage.find((u) => u.run_id.endsWith('.run1'));
  assert.ok(run1 && run1.usd === null, 'the orphaned run is unknown spend');
  assert.equal(v.usage_totals.usd, null);
  assert.equal(env.devStarts(), 2);
  uniqueEvents(env.events(task.task_id));
});

test('Z3 D-017 the owner can cancel a task whose recovery is pending (unconfirmed effect, fresh handle, no recover() yet)', async () => {
  const env = world({ dev: [PAID(0.3)] });
  const task = await env.submit();
  const { store, dead } = dieAt(env.store, (k, a) => k === 'recordUsage' && /\.run\d+$/.test(String(a[1]?.run_id)));
  env.reopen(() => store);
  assert.equal((await env.loop.run(task.task_id).catch((e) => e)).code, 'E_TEST_CRASH');
  assert.equal(dead.v, true);
  env.reopen();   // e.g. the HTTP layer's handle right after a restart, before the controller recovered
  const seen = await env.view(task.task_id);
  assert.equal(seen.status, 'executing');
  const cancel = () => env.loop.cancel(task.task_id, { actor: OWNER, reason: 'owner cancels during recovery' }).then(() => 'ok', (e) => e.code);
  // The crashed instance's intent is in this same (live) process: an owner action does not sit out the liveness
  // window inside the request (D-020 review item 4); it answers E_CONTROLLER_HELD at once and the client retries.
  assert.equal(await cancel(), 'E_CONTROLLER_HELD');
  env.advance(41_000);   // > 2 heartbeat intervals without a beat: provably dead
  assert.equal(await cancel(), 'ok', 'cancellation must always be possible');
  assert.equal((await env.view(task.task_id)).status, 'cancelled');
  await env.loop.recover();
  assert.equal((await env.view(task.task_id)).status, 'cancelled', 'recovery keeps the cancel');
  assert.equal((await env.loop.run(task.task_id)).terminal, true);
  assert.equal(env.devStarts(), 1);
});

test('Z4 D-016 a controller asleep in a timed wait past its lease TTL is superseded: it wakes, gets E_HELD and writes nothing; the new one completes', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  const A = env.loop;
  assert.equal((await A.step(task.task_id)).state, 'clarified');
  env.advance(61_000);   // A idles (between steps nothing renews its 60 s lease)
  const B = env.make();
  assert.equal((await B.loop.step(task.task_id)).state, 'planned', 'the free (expired) lease is simply acquired');
  const before = env.events(task.task_id).length;
  const rA = await A.step(task.task_id);
  assert.equal(rA.transitioned, false);
  assert.equal(rA.controller, 'E_HELD');
  assert.equal(env.events(task.task_id).length, before, 'the superseded instance wrote nothing');
  assert.equal((await B.loop.run(task.task_id)).state, 'accepted');
  // run() does not give up on E_HELD (D-020 review item 2): it waits out the holder's TTL, then finds the task done.
  const settled = env.events(task.task_id).length;
  assert.equal((await A.run(task.task_id)).terminal, true);
  assert.equal(env.events(task.task_id).length, settled, 'nothing written by the superseded instance');
  uniqueEvents(env.events(task.task_id));
});

// ---- Y3b: the handoff gate ------------------------------------------------------------------------
test('Z5 Y3b variant: a branch switch after acceptance-for-delivery but before the first handoff call is caught; the handoff never sees it', async () => {
  const calls = [];
  const integrate = async (task, ctx) => { calls.push(ctx.sha); return calls.length === 1 ? { next: 'waiting', retry_after_ms: 1000, reason: 'remote CI pending' } : { next: 'release_verifying', release_verified: true }; };
  integrate.reconcile = async () => ({ applied: false });
  const env = world({ loopOpts: { integrate } });
  const task = await env.submit({ review_policy: { mode: 'goal_loop', independent_review: true, deliver: true } });
  assert.equal((await env.loop.run(task.task_id, { until: ['integrating'] })).state, 'integrating');   // transition done, handoff not yet called
  assert.equal(calls.length, 0);
  const wt = env.wt(task.task_id);
  sh(wt, 'checkout', '-q', '-b', 'elsewhere');
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(lastWait(v).reason, 'off_task_branch');
  assert.equal(lastWait(v).resume_to, 'integrating');
  assert.equal(calls.length, 0, 'no handoff while off the task branch');
  assert.ok(!v.effects.some((e) => e.kind === 'integration'), 'no handoff effect was even attempted');
  env.advance(24 * 3600_000);
  assert.equal((await env.loop.step(task.task_id)).transitioned, false, 'time does not restore a branch');
  sh(wt, 'checkout', '-q', `v2task/${task.task_id}`);
  await env.loop.resume(task.task_id, { actor: OWNER });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  // once handed off, the confirmed handoff is retried by key with the verified SHA; the task branch tip is unchanged
  assert.deepEqual(calls, [v.head_sha, v.head_sha]);
  assert.equal(sh(env.repo.dir, 'rev-parse', `v2task/${task.task_id}`), v.head_sha);
});

// ---- Y7 variant ---------------------------------------------------------------------------------------
test('Z6 Y7 variant: a raise that exactly clears spend + estimate is accepted and the task continues within it', async () => {
  const env = world({ dev: [[BAD[0], { op: 'usage', input_tokens: 10, output_tokens: 10, usd: 0.8 }], PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  await assert.rejects(env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'short', grants: { budget_policy: { max_usd: 1.05 } } }), { code: 'E_INVALID' });
  // 0.8 spent + 0.3 repair run + 0.3 review estimate = 1.4 (1.4000000000000001 in floating point): 1.5 clears it, 1.1 would stop again before the review
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'clears', grants: { budget_policy: { max_usd: 1.5 } } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  const known = v.usage.filter((u) => typeof u.usd === 'number').reduce((a, u) => a + u.usd, 0);
  assert.ok(Math.abs(known - 1.1) < 1e-9, `known spend ${known}`);
  assert.equal(v.usage_totals.usd, null, 'the reviewer reported no USD: the total stays unknown');
});

// ---- housekeeping ----------------------------------------------------------------------------------
test('Z7 D-016 controller write-ahead intent files do not accumulate across restarts (a successor drops the one it adopted)', async () => {
    const env = world();
    const task = await env.submit();
    for (let i = 0; i < 4; i++) { env.reopen(); await env.loop.recover(); await env.loop.step(task.task_id); }
    const intents = fs.readdirSync(env.storeDir).filter((f) => /^controller\..+\.intent\.json$/.test(f));
    assert.ok(intents.length <= 2, `${intents.length} controller intent files after 4 restarts`);
  });
