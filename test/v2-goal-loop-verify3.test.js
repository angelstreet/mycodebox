// Round-3 verification of the goal loop at ab0d94f: GL13 for runs interrupted before their usage is recorded, attacks
// on worktrees.renew({ acknowledgeFence }) / the loop's lease_ack, and budget-confirmation edge cases. Defects are
// `todo` tests asserting the required behaviour. Synthetic data only.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv3-')));
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
const PAID = (usd) => impl('(a, b) => a + b', { input_tokens: 1000, output_tokens: 200, usd });
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
  const make = (wrap = (s) => s) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, wtRoot, storeDir, ad, now, advance: (ms) => { t += ms; }, leases, worktrees, ...make() };
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
  env.intrude = (id, owner = 'someone-else') => env.leases.acquire(`worktree:${id}`, { owner, task_id: 'other', ttl_ms: 3600_000, scope: 'worktree' });
  return env;
}
const OWNER = { role: 'owner', id: 'owner-1' };
const states = (v) => v.history.map((h) => h.to);
const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const started = (env, id, role = null) => env.events(id).filter((e) => e.kind === 'task.started' && (!role || e.payload.role === role)).map((e) => e.payload);
const asks = (env, id) => env.events(id).filter((e) => e.kind === 'approval.requested');
const lastWait = (v) => loopDecisions(v).map((d) => d.loop.patch.wait).filter(Boolean).at(-1);
// A controller that dies at the first store write matching `when`: that write and every later one fail.
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

// ---- GL13: a run that started but whose usage was never recorded -----------------------------------
test('X1 GL13 a controller crash between the reviewer start and its usage record leaves that attempt as UNKNOWN spend (in the ledger, and a cap stops on it)', async () => {
    const env = world({ dev: [PAID(0.3)], rev: [APPROVE_PAID(0.3)], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    const { store, dead } = dieAt(env.store, (k, a) => k === 'recordUsage' && /\.review-/.test(String(a[1]?.run_id)));
    env.reopen(() => store);
    assert.equal((await env.loop.run(task.task_id).catch((e) => e)).code, 'E_TEST_CRASH');
    assert.equal(dead.v, true);
    assert.equal(env.revStarts(), 1, 'the first review attempt ran (and was billed) before the crash');
    env.reopen();
    await env.loop.recover();
    const r = await env.loop.run(task.task_id);
    const v = await env.view(task.task_id);
    const startedReviews = started(env, task.task_id, 'reviewer').map((x) => x.run_id);
    assert.ok(startedReviews.some((id) => id.endsWith('-a0')), 'attempt a0 is on record as started');
    const unknownA0 = v.usage.some((u) => u.run_id.endsWith('-a0'));
    assert.ok(unknownA0, `attempt a0 has no ledger entry at all (ledger: ${v.usage.map((u) => `${u.run_id}=${u.usd}`).join(', ')}); real spend 0.9 of a 1.0 cap, shown ${v.usage_totals.usd}`);
    assert.equal(v.usage_totals.usd, null, 'a started attempt with no usage makes the total unknown, never a lower number');
    assert.ok(r.state === 'awaiting_approval' || r.state === 'accepted');
  });

test('X2 GL13 a controller crash between a developer run start and its usage record leaves that run as UNKNOWN spend after crash recovery', async () => {
    const env = world({ dev: [PAID(0.3), PAID(0.3)], rev: [APPROVE_PAID(0.1)] });
    const task = await env.submit();
    const { store, dead } = dieAt(env.store, (k, a) => k === 'recordUsage' && /\.run\d+$/.test(String(a[1]?.run_id)));
    env.reopen(() => store);
    assert.equal((await env.loop.run(task.task_id).catch((e) => e)).code, 'E_TEST_CRASH');
    assert.equal(dead.v, true);
    env.reopen();
    const rec = await env.loop.recover();
    assert.equal(rec.pendingEffects.length, 1);
    assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
    const v = await env.view(task.task_id);
    assert.equal(loopDecisions(v, 'crash_recovery').length, 1);
    const run1 = started(env, task.task_id, 'developer')[0].run_id;
    assert.ok(v.usage.some((u) => u.run_id === run1), `interrupted ${run1} is absent from the ledger (${v.usage.map((u) => u.run_id).join(', ')})`);
    assert.equal(v.usage_totals.usd, null, 'its spend is unknown, so the total is unknown');
  });

// ---- acknowledgeFence / lease_ack attacks ----------------------------------------------------------
async function heldThenResume(env, task) {
  assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
  env.advance(7 * 3600_000);
  const intruder = await env.intrude(task.task_id);
  assert.equal(intruder.ok, true);
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  assert.equal(lastWait(await env.view(task.task_id)).reason, 'lease_held');
  return intruder;
}

test('X3 ack attack: an owner resume while the foreign holder is still LIVE never re-acquires or writes; the task suspends again', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  await heldThenResume(env, task);
  await env.loop.resume(task.task_id, { actor: OWNER });
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(lastWait(v).reason, 'lease_held');
  assert.equal(lastWait(v).until_ms, null);
  assert.equal(env.devStarts(), 1, 'no run under a foreign lease');
  assert.equal(loopDecisions(v, 'lease_reacquired').length, 0);
  const third = await env.intrude(task.task_id, 'third-party');
  assert.equal(third.code, 'E_HELD');
  assert.equal(third.holder?.owner, 'someone-else', 'the intruder still holds it');
});

test('X4 ack attack: the acknowledgement covers ONE fence; a later foreign holder suspends the task again instead of being re-acquired silently', async () => {
  const env = world({ dev: [BAD, BAD, GOOD] });
  const task = await env.submit();
  const intruder = await heldThenResume(env, task);
  await env.leases.release(intruder.lease);
  await env.loop.resume(task.task_id, { actor: OWNER });
  // dispatch re-acquires (ack consumed) and moves to executing; the run itself happens on the next step
  assert.equal((await env.loop.run(task.task_id, { until: ['executing'] })).state, 'executing');
  assert.equal(loopDecisions(await env.view(task.task_id), 'lease_reacquired').length, 1);
  assert.equal(env.devStarts(), 1);
  // a second intruder takes and releases the (live, ours) lease: impossible while we hold it...
  const again = await env.intrude(task.task_id, 'someone-else-2');
  assert.equal(again.ok, false, 'our re-acquired lease is live: nobody else can take it');
  assert.equal(again.code, 'E_HELD');
  // ...but after it lapses they can; that second fence needs a fresh owner decision.
  env.advance(7 * 3600_000);
  const later = await env.intrude(task.task_id, 'someone-else-2');
  assert.equal(later.ok, true);
  await env.leases.release(later.lease);
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting', 'the earlier acknowledgement must not cover this fence');
  const v = await env.view(task.task_id);
  assert.equal(lastWait(v).reason, 'lease_held');
  assert.equal(loopDecisions(v, 'lease_reacquired').length, 1, 'no silent second re-acquire');
  assert.equal(env.devStarts(), 2, 'the already-dispatched run ran; its commit was refused under the fence');
  assert.equal(sh(env.repo.dir, 'rev-parse', `v2/task/${task.task_id}`), (await env.view(task.task_id)).head_sha, 'nothing committed under the fence');
});

test('X5 ack attack: a project-policy change resumes a lease_held wait but is NOT an owner acknowledgement of the fence', async () => {
  const env = world({ dev: [BAD, GOOD] });
  const task = await env.submit();
  const intruder = await heldThenResume(env, task);
  await env.leases.release(intruder.lease);
  fs.writeFileSync(path.join(env.repo.dir, '.ai', 'project.json'), JSON.stringify({ ...POLICY, protected_paths: ['.ai', 'docs'] }));
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(lastWait(v).reason, 'lease_held');
  assert.equal(loopDecisions(v, 'lease_reacquired').length, 0, 'fence not acknowledged by a policy edit');
  assert.equal(env.devStarts(), 1);
  // the explicit owner resume is
  await env.loop.resume(task.task_id, { actor: OWNER });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
});

// Adapted to coordinator decision D-015: a lease merely held under this owner name with another lease_id is a twin and
// stays fenced; the crash this probe targets is reproduced faithfully instead (write-ahead id persisted, lease granted,
// process dies before the meta rewrite), and the restart must adopt exactly that lease.
test('X6 ack attack: after a crash inside worktrees.renew() between acquire and the meta rewrite, the lease is held by this task\'s OWN owner; the restart adopts it instead of suspending', async () => {
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
  await env.loop.run(task.task_id).catch(() => null);
  env.leases.acquire = real;
  assert.ok(granted?.ok, 'the lease was granted to this owner before the crash');
  env.reopen();
  await env.loop.recover();
  let r = await env.loop.run(task.task_id);
  if (r.state === 'waiting') {   // give the owner's acknowledgement a chance too
    await env.loop.resume(task.task_id, { actor: OWNER });
    r = await env.loop.run(task.task_id);
  }
  assert.equal(r.state, 'accepted', `own lost lease treated as foreign: ${r.state} (${lastWait(await env.view(task.task_id))?.diagnosis})`);
});

test('X7 ack attack: a foreign holder that moved the worktree off its task branch; after the acknowledged resume the accepted SHA must be the task branch tip', async () => {
    const env = world({ dev: [BAD, GOOD] });
    const task = await env.submit();
    const intruder = await heldThenResume(env, task);
    const wt = env.wt(task.task_id);
    sh(wt, 'checkout', '-q', '-b', 'intruder-branch');
    fs.writeFileSync(path.join(wt, 'src', 'intruder.js'), 'export const x = 1;\n');
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-q', '-m', 'intruder commit');
    await env.leases.release(intruder.lease);
    await env.loop.resume(task.task_id, { actor: OWNER });
    const r = await env.loop.run(task.task_id);
    const v = await env.view(task.task_id);
    const branchTip = sh(env.repo.dir, 'rev-parse', `v2/task/${task.task_id}`);
    const onBranch = sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
    assert.ok(r.state !== 'accepted' || (branchTip === v.head_sha && onBranch === `v2/task/${task.task_id}`),
      `accepted ${v.head_sha?.slice(0, 12)} while the worktree is on ${onBranch} and v2task tip is ${branchTip.slice(0, 12)}`);
  });

// ---- budget confirmation edge: a reached cap ------------------------------------------------------
test('X8 confirming a REACHED cap without raising it is refused (or honoured), never answered with the identical question again', async () => {
    const env = world({ dev: [[...BAD.slice(0, 1), { op: 'usage', input_tokens: 10, output_tokens: 10, usd: 0.8 }], GOOD], loopOpts: { estimateRun: () => ({ usd: 0.3, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    const q1 = asks(env, task.task_id).at(-1).payload.question;
    assert.match(q1, /would exceed/);
    const ok = await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'confirm-only' }).then(() => true, (e) => e.code);
    if (ok === true) {
      const r = await env.loop.run(task.task_id);
      const again = asks(env, task.task_id).filter((e) => e.payload.question === q1);
      assert.equal(again.length, 1, `identical cap question re-asked after a confirmation (state ${r.state})`);
    } else assert.equal(ok, 'E_INVALID');
  });

// ---- guarantees that must hold ----------------------------------------------------------------------
test('X9 one billing classifier: a developer run refused at the door (auth) is unbilled and asks the owner once; a crash after start with unknown usage is billed and suspends after 3', async () => {
  const a = world({ dev: [[{ op: 'stderr', text: 'Error: invalid API key (401 unauthorized)' }, { op: 'exit', code: 1 }]] });
  const ta = await a.submit();
  const ra = await a.loop.run(ta.task_id);
  const va = await a.view(ta.task_id);
  assert.equal(ra.state, 'awaiting_approval', 'auth errors are an owner question');
  assert.equal(va.usage_totals.usd, null);
  assert.equal(loopDecisions(va, 'no_progress').length, 0);

  const b = world({ dev: [[{ op: 'stderr', text: 'Segmentation fault' }, { op: 'exit', code: 139 }]] });
  const tb = await b.submit();
  let steps = 0;
  for (; steps < 120; steps++) {
    const r = await b.loop.step(tb.task_id);
    if (r.idle || r.terminal) break;
    if (!r.transitioned && !r.again && r.until_ms != null) b.advance(r.until_ms - b.now() + 1);
  }
  const vb = await b.view(tb.task_id);
  assert.equal(vb.status, 'waiting');
  assert.equal(lastWait(vb).reason, 'no_progress');
  assert.ok(b.devStarts() <= 9, `${b.devStarts()} runs before suspension (3 entries x 3)`);
});
