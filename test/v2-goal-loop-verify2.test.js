// Re-verification of the goal loop at c31e9bf (fixes for verify-1 findings 1-16, D2/D3/D5, D-012..D-014). Variants of
// every earlier probe plus the author's open risks (a) lease meta after re-acquire, (b) unpriced roles under a cap,
// (c) unbilled rate limits. Defects are `todo` tests asserting the required behaviour. Synthetic data only.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv2-')));
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
const GOOD_PAID = impl('(a, b) => a + b', { input_tokens: 1000, output_tokens: 200, usd: 0.4 });
const BAD = impl('(a, b) => a - b');
const GAMED = impl('(a, b) => (a === 2 && b === 3 ? 5 : 0)');
const verdict = (v, findings = [], usage = null) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }, ...(usage ? [{ op: 'usage', ...usage }] : [])];
const APPROVE = verdict('approve');
const REJECT = verdict('reject', [{ id: 'no_test_gaming', severity: 'blocker', message: 'add() special-cases the test inputs' }]);
const fail = (text, code = 1) => [{ op: 'stderr', text }, { op: 'exit', code }];
// A reviewer that judges the diff it is shown (survives re-runs after a crash, unlike an index-scripted one).
const judge = (prompt) => (/a === 2 && b === 3/.test(prompt) ? REJECT : APPROVE);

const model = (m, tier, extra = {}) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true, ...extra });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard', { context_tokens: 200000 }), model('rev', 'standard')] };
const PRICED = { version: 1, as_of: '2026-10-11', models: REGISTRY.models.map((m) => ({ ...m, price: { input: 3, output: 15 }, price_as_of: '2026-10-01', source: 'synthetic' })) };

function roleAdapter({ wtRoot, reviewRoot, dev, rev, revBy }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: rev.length ? rev : [APPROVE] });
  const log = { dev: [], rev: [] };
  return {
    log, devA, revA, id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
      features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) {
      if (o.role === 'reviewer') { log.rev.push(o); return revA.start(revBy ? { ...o, script: revBy(o.prompt) } : o); }
      log.dev.push(o); return devA.start(o);
    },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
}

let worlds = 0;
function world({ dev = [], rev = [], revBy = null, policy = POLICY, loopOpts = {}, registry: reg = REGISTRY } = {}) {
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
  const ad = roleAdapter({ wtRoot, reviewRoot, dev, rev, revBy });
  const make = (wrap = (s) => s) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, now, sleep, ...loopOpts });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, wtRoot, storeDir, ad, spawned, now, advance: (ms) => { t += ms; }, leases, worktrees, ...make() };
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

// ---- (a) lease re-acquire vs worktree meta -------------------------------------------------------
test('W1 (risk a) after the loop re-acquires an expired worktree lease, the worktree module still recognises its owner (renew/remove not fenced out)', async () => {
    const env = world({ dev: [BAD, GOOD] });
    const task = await env.submit();
    assert.equal((await env.loop.run(task.task_id, { until: ['repair'] })).state, 'repair');
    env.advance(7 * 3600_000);
    assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
    const v = await env.view(task.task_id);
    assert.equal(loopDecisions(v, 'lease_reacquired').length, 1);
    const { loop: cp } = await env.loop.inspect(task.task_id);
    const wt = env.wt(task.task_id);
    // Either handle the owner uses must work: the owner name, or the lease the loop now holds.
    const byOwner = await env.worktrees.remove(wt, { owner: 'goal-loop' }).catch((e) => e);
    const byLease = await env.worktrees.remove(wt, { lease: cp.worktree.lease }).catch((e) => e);
    assert.ok(!(byOwner instanceof Error) || !(byLease instanceof Error), `remove by owner: ${byOwner.code ?? 'ok'}; by current lease: ${byLease.code ?? 'ok'}`);
    const renewed = await env.worktrees.renew(wt, { owner: 'goal-loop' }).catch((e) => e);
    assert.ok(!(renewed instanceof Error), `renew: ${renewed.code}`);
  });

// ---- (b) and #5: unpriced roles under a cap --------------------------------------------------------
test('W2 (risk b) capped task, no estimator, unpriced registry: one owner confirmation per unpriced role, then accepted', async () => {
  const env = world({ dev: [GOOD_PAID], rev: [APPROVE] });
  const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 5 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'dev-run-ok' });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval', 'the reviewer is the second unpriced role');
  assert.equal(env.devStarts(), 1);
  assert.equal(env.revStarts(), 0);
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'review-ok' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(env.devStarts(), 1, 'the second confirmation resumed verification only');
  const budgetAsks = asks(env, task.task_id).filter((e) => e.payload.kind === 'budget');
  assert.equal(budgetAsks.length, 2);
  assert.ok(budgetAsks.every((e) => /estimate unknown/.test(e.payload.question)));
});

test('W2b #5 the router\'s price-based estimate is used for the DEVELOPER run too: a priced registry under a cap starts without an owner confirmation', async () => {
    const env = world({ dev: [GOOD_PAID], registry: PRICED });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 5 } });
    const r = await env.loop.run(task.task_id);
    assert.equal(r.state, 'accepted', `priced models, 5 USD cap: got ${r.state} with ${asks(env, task.task_id).length} owner ask(s)`);
    assert.equal(asks(env, task.task_id).filter((e) => e.payload.kind === 'budget').length, 0, 'no owner question for priced runs far under the cap');
  });

test('W3 #5 variant: unknown SPEND on a prior run under a cap, confirmed once by the owner, authorizes the next run (no identical re-ask)', async () => {
    const env = world({ dev: [impl('(a, b) => a - b', { input_tokens: 10, output_tokens: 10 }), GOOD], loopOpts: { estimateRun: () => ({ usd: 0.1, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
    const q1 = asks(env, task.task_id).at(-1).payload.question;
    await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'unknown-spend-ok' });
    const r = await env.loop.run(task.task_id);
    const again = asks(env, task.task_id).filter((e) => e.payload.question === q1);
    assert.ok(env.devStarts() >= 2 || again.length === 1, `identical question re-asked ${again.length - 1} time(s); state ${r.state}, ${env.devStarts()} run(s)`);
  });

// ---- (c) and #4 variants: what counts as billed ---------------------------------------------------
test('W4 (risk c) a rate-limited developer run that recorded no usage backs off on a timer, switches, and never spends (OWNER_DECISIONS §4 quota -> waiting + backoff)', async () => {
  const env = world({ dev: [fail('429 Too Many Requests')] });
  const task = await env.submit();
  const { r } = await drive(env, task.task_id, { maxSteps: 80, stopWhen: () => env.devStarts() >= 12 });
  const v = await env.view(task.task_id);
  assert.ok(!states(v).includes('accepted'));
  assert.equal(v.usage_totals.usd, null, 'nothing billed: unknown stays unknown');
  assert.equal(loopDecisions(v, 'no_progress').length, 0, 'an unbilled quota wait is not a no-progress suspension');
  const waits = loopDecisions(v, 'provider_fallback').map((d) => d.loop.patch.wait).filter(Boolean);
  assert.ok(waits.length >= 6 && waits.every((w) => w.until_ms != null), 'every wait is timed (never an inputs-change suspension)');
  assert.ok(r.state === 'waiting' || r.state === 'repair' || r.state === 'executing');
  assert.equal(env.events(task.task_id).filter((e) => e.kind === 'model.rate_limited').length, env.devStarts());
});

test('W4b a crash whose usage is UNKNOWN (adapter reports nothing) is not treated as free: it counts toward suspension like a billed one', async () => {
    const env = world({ dev: [fail('Segmentation fault', 139)] });
    const task = await env.submit();
    await drive(env, task.task_id, { maxSteps: 120, stopWhen: () => env.devStarts() >= 15 });
    const v = await env.view(task.task_id);
    const runs = started(env, task.task_id);
    const firstNoAlt = loopDecisions(v, 'provider_fallback').findIndex((d) => /no compatible alternative|no alternative/.test(d.rationale));
    assert.ok(firstNoAlt >= 0, 'every candidate was tried');
    const after = runs.length - (firstNoAlt + 1);
    assert.ok(after <= v.no_progress_policy.same_signature, `${after} identical crash runs with unknown usage after "no alternative" (total ${runs.length}), state ${v.status}`);
  });

test('W5 a rate-limited REVIEWER gets the same unbilled timed backoff as a developer, not a no-progress suspension', async () => {
    const env = world({ dev: [GOOD], rev: [fail('429 Too Many Requests')] });
    const task = await env.submit();
    await drive(env, task.task_id, { maxSteps: 120, stopWhen: () => env.revStarts() >= 12 });
    const v = await env.view(task.task_id);
    assert.ok(!states(v).includes('accepted'));
    assert.equal(v.usage_totals.usd, null, 'nothing billed');
    assert.equal(loopDecisions(v, 'no_progress').length, 0, `suspended after ${env.revStarts()} rate-limited review attempts with no spend`);
  });

// ---- D-013 binding to the exact SHA ---------------------------------------------------------------
test('W6 D-013 an owner risk acceptance is bound to the SHA it named: a later head needs a new approval, never the stale one', async () => {
  const env = world({ dev: [GOOD], rev: [APPROVE] });
  const task = await env.submit({ risk_class: 'high' });
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const v1 = await env.view(task.task_id);
  const ask1 = asks(env, task.task_id).at(-1);
  assert.equal(ask1.payload.kind, 'risk_acceptance');
  assert.deepEqual(ask1.payload.keys, [`accept:${v1.head_sha}`]);
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'accept-sha1' });
  // an out-of-band commit lands on the task branch before the approved resume is stepped
  const wt = env.wt(task.task_id);
  fs.writeFileSync(path.join(wt, 'src', 'extra.js'), 'export const extra = 1;\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-q', '-m', 'late change');
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'awaiting_approval', 'the new SHA is not covered by the old grant');
  const v2 = await env.view(task.task_id);
  assert.notEqual(v2.head_sha, v1.head_sha);
  assert.ok(!states(v2).includes('accepted'));
  const ask2 = asks(env, task.task_id).at(-1);
  assert.deepEqual(ask2.payload.keys, [`accept:${v2.head_sha}`]);
  assert.ok(v2.evidence.some((e) => e.sha === v2.head_sha && e.exit === 0), 'checks reran on the new SHA');
  assert.ok(v2.verdicts.some((x) => x.sha === v2.head_sha && x.verdict === 'approve'), 'review reran on the new SHA');
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'accept-sha2' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(env.devStarts(), 1, 'no developer run was needed at any point');
});

test('W6b D-013 a policy-named security reviewer that is the developer\'s own entry is not independent: wait, never accepted', async () => {
  const env = world({ dev: [GOOD], policy: { ...POLICY, security_reviewer: 'fake:dev-a' } });
  const task = await env.submit({ risk_class: 'high' });
  const { r } = await drive(env, task.task_id, { maxSteps: 20 });
  const v = await env.view(task.task_id);
  assert.equal(started(env, task.task_id)[0].entry, 'fake:dev-a');
  assert.equal(r.state, 'waiting');
  assert.equal(r.idle, true);
  assert.ok(!states(v).includes('accepted'));
  assert.ok(!v.verdicts.some((x) => x.actor.role === 'security'));
  assert.match(loopDecisions(v, 'evaluator_unavailable').at(-1).loop.patch.wait.diagnosis, /security/);
});

// ---- #7 variants: grant keys ----------------------------------------------------------------------
test('W7 a grant for one requested command does not cover a different command of the same class in the same run, nor the gate keys', async () => {
  const PUSH1 = { op: 'emit', event: { type: 'action_request', argv: ['git', 'push', 'origin', 'main'] } };
  const PUSH2 = { op: 'emit', event: { type: 'action_request', argv: ['git', 'push', 'origin', 'release'] } };
  const env = world({ dev: [[PUSH1, ...GOOD], [PUSH2, ...GOOD], GOOD] });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const first = asks(env, task.task_id).filter((e) => e.payload.run_id);
  assert.equal(first.length, 1);
  await env.loop.approve(task.task_id, { actor: OWNER, approval_ref: 'push-main-once' });
  const grant = env.events(task.task_id).find((e) => e.kind === 'approval.granted');
  assert.deepEqual(grant.payload.grants.keys, [first[0].payload.key]);
  assert.ok(grant.payload.grants.keys.every((k) => k.startsWith('agent:')), 'an agent grant never carries a gate/route/accept key');
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const second = asks(env, task.task_id).filter((e) => e.payload.run_id);
  assert.equal(second.length, 2);
  assert.notEqual(second[1].payload.key, second[0].payload.key);
  await env.loop.deny(task.task_id, { actor: OWNER, reason: 'no' });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  assert.equal(sh(env.repo.dir, 'remote').length, 0);
});

// ---- crash sweep over the review-reject path (reviewer-phase writes, onFailure review path) --------
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
test('W8 crash sweep over GL05 (gamed patch -> reviewer reject -> repair -> approve): every store-write boundary recovers to accepted without duplicates', async () => {
  let points = 0;
  const bad = [];
  for (let n = 1; n <= 80; n++) {
    const env = world({ dev: [GAMED, GOOD], revBy: judge });
    const task = await env.submit();
    const dead = { v: false };
    env.reopen((s) => crashAtWrite(s, n, dead));
    const first = await env.loop.run(task.task_id).catch((e) => e);
    if (!dead.v) { assert.equal(first.state, 'accepted'); break; }
    points++;
    let crashedIn = null;
    try {
      assert.equal(first.code, 'E_TEST_CRASH');
      env.reopen();
      crashedIn = (await env.view(task.task_id)).status;
      await env.loop.recover();
      const r = await env.loop.run(task.task_id).catch((e) => e);
      assert.equal(r.state, 'accepted', `resumed to ${r.state ?? r.code}`);
      const v = await env.view(task.task_id);
      uniqueEvents(env.events(task.task_id));
      const runs = started(env, task.task_id);
      assert.equal(new Set(runs.map((x) => x.run_id)).size, runs.length, 'duplicate run id');
      assert.ok(runs.length <= 3, `${runs.length} developer runs`);
      assert.ok(v.effects.filter((e) => e.kind === 'developer_run' && e.phase === 'failed').length <= 1, 'more than one interrupted run');
      const devIds = new Set(runs.map((x) => x.entry));
      // A crash mid-GAMED-run lets the repair run overwrite it before any review, so a reject may not exist; but a
      // verdict on a non-head SHA can only be a reject, and the gamed function never reaches the accepted tree.
      assert.ok(v.verdicts.filter((x) => x.sha !== v.head_sha).every((x) => x.verdict === 'reject'), 'only rejects on earlier SHAs');
      assert.ok(v.verdicts.some((x) => x.sha === v.head_sha && x.verdict === 'approve' && !devIds.has(x.actor.id)), 'independent approve on head');
      assert.ok(!v.verdicts.some((x) => x.sha === v.head_sha && x.verdict === 'reject'), 'no reject on the accepted head');
      assert.match(fs.readFileSync(path.join(env.wt(task.task_id), 'src', 'math.js'), 'utf8'), /a \+ b/, 'the accepted tree holds the real fix');
      assert.ok(v.evidence.some((e) => e.sha === v.head_sha && e.exit === 0));
      const before = env.events(task.task_id).length;
      env.reopen();
      await env.loop.recover();
      assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
      assert.equal(env.events(task.task_id).length, before, 'restart of an accepted task wrote events');
    } catch (e) { bad.push({ n, state: crashedIn, message: String(e.message).split('\n')[0] }); }
  }
  assert.ok(points >= 30, `sweep covered only ${points} write points`);
  assert.deepEqual(bad, [], `crash points that did not recover: ${JSON.stringify(bad)}`);
});

// ---- #3 variant: reviewer strategy changes are bounded and recorded ---------------------------------
test('W9 unparseable reviewer: 3 identical -> other reviewer, 3 more -> strict format, 3 more -> suspended until inputs change; every retry recorded', async () => {
  const PROSE = [{ op: 'emit', event: { type: 'text', text: 'Looks fine to me, ship it.' } }, { op: 'usage', input_tokens: 500, output_tokens: 50, usd: 0.2 }];
  const env = world({ dev: [GOOD], rev: [PROSE] });
  const task = await env.submit();
  const { r } = await drive(env, task.task_id, { maxSteps: 120 });
  const v = await env.view(task.task_id);
  assert.equal(r.state, 'waiting');
  assert.equal(r.idle, true);
  assert.ok(!states(v).includes('accepted'));
  const changes = loopDecisions(v, 'reviewer_strategy_change').map((d) => d.chosen);
  assert.deepEqual(changes, ['other_reviewer', 'strict_format']);
  const entries = started(env, task.task_id, 'reviewer').map((x) => x.entry);
  assert.equal(new Set(entries).size, 2, 'two distinct reviewer entries were tried');
  assert.ok(env.ad.log.rev.at(-1).prompt.includes('STRICT FORMAT'));
  assert.equal(env.revStarts(), 9, 'three identical failures per strategy, three strategies');
  assert.equal(env.devStarts(), 1);
  const np = loopDecisions(v, 'no_progress').at(-1);
  assert.equal(np.loop.patch.wait.until_ms, null);
  assert.match(np.loop.patch.wait.diagnosis, /no usable verdict/);
  // time alone never restarts it; an owner resume does
  env.advance(30 * 24 * 3600_000);
  assert.equal((await env.loop.step(task.task_id)).transitioned, false);
  assert.equal(env.revStarts(), 9);
  await env.loop.resume(task.task_id, { actor: OWNER });
  assert.equal((await env.loop.step(task.task_id)).state, 'ready');
});

test('W9b every billed review attempt is in the ledger and counts against the cap (T13/GL13)', async () => {
    const PROSE = [{ op: 'emit', event: { type: 'text', text: 'Looks fine to me, ship it.' } }, { op: 'usage', input_tokens: 500, output_tokens: 50, usd: 0.2 }];
    const env = world({ dev: [impl('(a, b) => a + b', { input_tokens: 10, output_tokens: 10, usd: 0.3 })], rev: [PROSE],
      loopOpts: { estimateRun: () => ({ usd: 0.2, input_tokens: 10, output_tokens: 10, duration_ms: 1, turns: 1 }) } });
    const task = await env.submit({ budget_policy: { mode: 'cap', max_usd: 1 } });
    await drive(env, task.task_id, { maxSteps: 120 });
    const v = await env.view(task.task_id);
    const reviews = v.usage.filter((u) => u.run_id.includes('.review'));
    const real = 0.3 + 0.2 * env.revStarts();
    assert.equal(reviews.length, env.revStarts(), `${env.revStarts()} review attempts, ${reviews.length} ledger entries`);
    assert.ok(real <= 1 + 0.2 + 1e-9, `real spend ${real.toFixed(1)} USD exceeded the 1 USD cap; ledger shows ${v.usage_totals.usd}`);
  });
