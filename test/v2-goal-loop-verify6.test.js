// Round-6 verification of the goal loop at 21e5f1a: liveness-gated controller takeover with REAL processes and a
// REAL clock (a child process keeps an intent's heartbeat fresh; pid liveness via process.kill(pid, 0); EPERM = alive),
// the in-process live controller mid-run, and the D-018 consequence for owner actions from another process.
// Synthetic data only; children are killed on exit.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { createVerifier } from '../orchestration/verifier.js';
import { createGoalLoop, pidAlive } from '../orchestration/goal-loop.js';
import { createIntake } from '../orchestration/intake.js';
import { clock } from './fixtures/v2-task.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-glv6-')));
const children = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
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
function mkRepo() {
  const dir = path.join(TMP, `repo${++repos}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  fs.mkdirSync(path.join(dir, '.ai'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), TEST_FILE);
  fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(POLICY, null, 1));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

const impl = (body) => [{ op: 'write', path: 'src/math.js', content: `export const add = ${body};\n` }, { op: 'usage', input_tokens: 1000, output_tokens: 200 }];
const GOOD = impl('(a, b) => a + b');
const APPROVE = [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }];
const model = (m, tier) => ({ runtime: 'fake', provider: 'fake', model: m, tier, capabilities: ['text', 'code', 'tools', 'resume', 'cancel'], efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true });
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [model('dev-a', 'strong'), model('dev-b', 'standard'), model('rev', 'standard')] };

function roleAdapter({ wtRoot, reviewRoot, dev }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
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

const CTL = { ttl_ms: 3000 };   // heartbeat interval 1 s; a successor watches an unsure intent for 2 s
let worlds = 0;
// REAL clock everywhere (loop, lease authority, sleep): heartbeats and liveness windows are wall-clock here.
function world({ dev = [] } = {}) {
  const w = ++worlds;
  const repo = mkRepo();
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt'), reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  const storeDir = path.join(base, 'state', 'v2');
  const ck = clock();
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }) });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo.dir], leases, git });
  const registry = createRegistry(REGISTRY);
  const verifier = createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 20_000 });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev });
  const make = () => {
    const store = createTaskStore({ dir: storeDir, ...ck });
    const loop = createGoalLoop({ store, registry, adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot,
      leases, git, allowFake: true, controller: CTL });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo, base, storeDir, ad, leases, make, ...make() };
  env.submit = async () => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: repo.dir, risk_class: 'low', runtime_capabilities: ['code'],
    acceptance_checks: [{ id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
  }, { source: 'api', actor_id: 'api-client' })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  env.view = (id) => env.store.get(id);
  env.devStarts = () => ad.log.dev.length;
  env.intents = () => fs.readdirSync(storeDir).filter((f) => /^controller\..+\.intent\.json$/.test(f));
  return env;
}
const OWNER = { role: 'owner', id: 'owner-1' };
const RESOURCE = 'service:local:goal-loop';
const states = (v) => v.history.map((h) => h.to);
const uniqueEvents = (evs) => { assert.equal(new Set(evs.map((e) => e.event_id)).size, evs.length, 'no duplicate event'); evs.forEach((e, i) => i && assert.ok(e.seq > evs[i - 1].seq, 'seq strictly increasing')); };
async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 25)); }
}
const exited = (c) => waitFor(() => c.exitCode !== null || c.signalCode !== null);

// A real "live controller": a child process that keeps an intent file's heartbeat fresh every 250 ms (what a goal-loop
// instance's beat() does), claiming `pid` (0 = its own) and `host`. The controller lease is held under that intent's id.
const BEATER = path.join(TMP, 'beater.mjs');
fs.writeFileSync(BEATER, [
  "import fs from 'node:fs';",
  'const [file, pid, host, instance, lease_id, resource] = process.argv.slice(2);',
  'const write = () => { const i = { resource, lease_id, owner: "goal-loop", task_id: null, instance, pid: Number(pid) || process.pid, host, started_at: Date.now(), heartbeat_at: Date.now() };',
  '  fs.writeFileSync(`${file}.tmp`, JSON.stringify(i)); fs.renameSync(`${file}.tmp`, file); };',
  'write(); setInterval(write, 250);',
].join('\n'));
async function liveController(env, { pid = 0, host = os.hostname() } = {}) {
  const instance = `fake-${Math.random().toString(36).slice(2, 8)}`;
  const lease_id = `ctl-live-${instance}-00000001`;
  const file = path.join(env.storeDir, `controller.${instance}.intent.json`);
  const a = await env.leases.acquire(RESOURCE, { owner: 'goal-loop', ttl_ms: 600_000, scope: `controller ${instance}`, lease_id });
  assert.ok(a.ok, 'the live controller holds the lease');
  const child = spawn(process.execPath, [BEATER, file, String(pid), host, instance, lease_id, RESOURCE], { stdio: 'ignore' });
  children.push(child);
  await waitFor(() => fs.existsSync(file));
  const intent = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { lease: a.lease, file, instance, intent, child, stop: async () => { child.kill('SIGKILL'); await exited(child); } };
}
async function expectHeld(env, loop, task, why) {
  const before = env.events(task.task_id).length;
  const mine = env.intents().length;
  await assert.rejects(loop.recover(), (e) => e.code === 'E_CONTROLLER_HELD' && /alive/.test(e.message), why);
  assert.equal(env.events(task.task_id).length, before, `${why}: no write by the refused instance`);
  assert.equal(env.intents().length, mine, `${why}: the refused instance left no intent file`);
}

test('pidAlive: own pid true; pid 1 true (EPERM as non-root, or root); a reaped child false; 0 and negatives false', async () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(1), true);
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' });
  children.push(c);
  assert.equal(pidAlive(c.pid), true);
  c.kill('SIGKILL'); await exited(c);
  assert.equal(pidAlive(c.pid), false);
  for (const bad of [0, -1, 1.5, '12', null]) assert.equal(pidAlive(bad), false, String(bad));
});

test('R1 a live controller (real child pid on this host, fresh heartbeat) refuses a second instance\'s recover(); once the process is dead the successor takes over', async () => {
  const env = world();
  const task = await env.submit();
  const live = await liveController(env);
  assert.equal(live.intent().pid, live.child.pid);
  await expectHeld(env, env.loop, task, 'live child');
  assert.deepEqual(await env.leases.validate(live.lease), { ok: true }, 'the live lease is untouched');
  assert.equal((await env.loop.step(task.task_id)).controller, 'E_HELD', 'step() is refused as well');
  await live.stop();   // the process is gone: pid dead on this host
  await env.loop.recover();
  assert.ok(!fs.existsSync(live.file), 'the dead intent is dropped');
  assert.equal((await env.leases.validate(live.lease)).code, 'E_FENCED', 'the dead controller\'s handle is fenced');
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  uniqueEvents(env.events(task.task_id));
});

test('R2 EPERM counts as alive: an intent claiming pid 1 with a fresh heartbeat is held; a STALE heartbeat (> 2 intervals) beats a live pid', async () => {
  const env = world();
  const task = await env.submit();
  const live = await liveController(env, { pid: 1 });
  assert.equal(live.intent().pid, 1);
  await expectHeld(env, env.loop, task, 'pid 1 + fresh heartbeat');
  await live.stop();                 // pid 1 is still "alive" (EPERM) but nobody beats any more
  await new Promise((r) => setTimeout(r, 2200));
  await env.loop.recover();          // stale for > 2 intervals: taken over
  assert.ok(!fs.existsSync(live.file));
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
});

test('R3 an intent from ANOTHER host (pid meaningless here) is judged by its heartbeat alone: fresh -> held, stopped -> taken over', async () => {
  const env = world();
  const task = await env.submit();
  const live = await liveController(env, { pid: process.pid, host: 'other-host.example.invalid' });
  await expectHeld(env, env.loop, task, 'foreign host, fresh heartbeat');
  await live.stop();
  await new Promise((r) => setTimeout(r, 2200));
  await env.loop.recover();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
});

test('R4 in-process: a second instance\'s recover() during a live controller\'s run is refused (its heartbeat moves); the run completes untouched', async () => {
  const env = world({ dev: [[{ op: 'delay', ms: 4500 }, ...GOOD]] });
  const task = await env.submit();
  const A = env.loop;
  const pA = A.run(task.task_id);
  await waitFor(() => env.devStarts() === 1);
  const B = env.make();
  const t0 = Date.now();
  await assert.rejects(B.loop.recover(), (e) => e.code === 'E_CONTROLLER_HELD' && /alive/.test(e.message));
  assert.ok(Date.now() - t0 >= 1900, 'the successor watched the heartbeat for two intervals before deciding');
  const rA = await pA;
  assert.equal(rA.state, 'accepted');
  const v = await env.view(task.task_id);
  assert.ok(!states(v).includes('unknown_external_effect'), 'the live run was never reconciled as interrupted');
  assert.equal(env.devStarts(), 1, 'no duplicate run');
  assert.equal(env.intents().length, 1, 'only the live controller\'s intent remains');
  uniqueEvents(env.events(task.task_id));
  assert.equal((await B.loop.step(task.task_id)).controller ?? 'terminal', 'E_HELD');
});

test('R5 D-018 consequence: an owner cancel issued through ANOTHER process while the controller is alive and mid-run',
  { todo: 'design constraint (D-018): cancel()/approve()/deny()/resume() take the controller lease (liveness-gated takeover), so from a process that is not the live controller they fail with E_CONTROLLER_HELD for as long as it lives; owner actions must be routed to the controller instance (or the store must admit task.cancelled without the lease, as the one write that never conflicts with reconciliation). Marked todo so the deployment rule is not forgotten.' }, async () => {
    const env = world({ dev: [[{ op: 'delay', ms: 4500 }, ...GOOD]] });
    const task = await env.submit();
    const pA = env.loop.run(task.task_id);
    await waitFor(() => env.devStarts() === 1);
    const B = env.make();
    const r = await B.loop.cancel(task.task_id, { actor: OWNER, reason: 'owner changed their mind' }).then(() => 'ok', (e) => e.code);
    const rA = await pA;
    assert.equal(r, 'ok', `cancel from another process: ${r}; the run went on to ${rA.state}`);
  });
