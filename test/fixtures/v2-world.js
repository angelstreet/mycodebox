// Shared disposable worlds for the V2 acceptance tests (docs/v2/ACCEPTANCE.md). Synthetic data only: every repo,
// remote, store, lease dir and worktree lives under one temp dir per test file; git runs with a scrubbed env and a
// fake identity; runtimes are the scriptable fake adapter or stub CLIs behind the real adapters.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../../orchestration/store.js';
import { createWorktrees } from '../../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../../orchestration/lease-authority.js';
import { createRegistry } from '../../orchestration/model-registry.js';
import { createAdapter as fakeAdapter } from '../../orchestration/adapters/fake.js';
import { createVerifier } from '../../orchestration/verifier.js';
import { createGoalLoop } from '../../orchestration/goal-loop.js';
import { createIntake } from '../../orchestration/intake.js';
import { createIntegrationQueue } from '../../orchestration/integration-queue.js';
import { createIntegrationController, createGitRunner } from '../../orchestration/integration-controller.js';
import { createDelivery } from '../../orchestration/delivery.js';
import { clock } from './v2-task.js';

// ---- synthetic project ------------------------------------------------------------------------------
export const MATH_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n"
  + "test('add sums two numbers', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n";
export const UNIT_CHECK = { id: 'unit', command: ['node', '--test', 'test/math.test.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true };
export const POLICY = {
  schema_version: 1, project_id: 'fixture-project', test_command: UNIT_CHECK.command,
  allowlists: { commands: [['node', '--test']], paths: ['src', 'test', 'out'], runtimes: null, models: null },
  protected_paths: ['.ai'], protected_branches: ['main'], approval_policy: { requires: ['merge_protected', 'push_shared'] },
  ci_gates: [{ id: 'unit', command: UNIT_CHECK.command }],
};

// ---- fake runtime scripts ------------------------------------------------------------------------------
export const impl = (body, usage = { input_tokens: 1000, output_tokens: 200 }) => [{ op: 'write', path: 'src/math.js', content: `export const add = ${body};\n` }, { op: 'usage', ...usage }];
export const GOOD = impl('(a, b) => a + b');
export const BAD = impl('(a, b) => a - b');
export const THROWS = impl("() => { throw new TypeError('nope'); }");
export const GAMED = impl('(a, b) => (a === 2 && b === 3 ? 5 : 0)');   // passes the tests only by special-casing them
export const verdict = (v, findings = []) => [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: v, findings }) } }];
export const APPROVE = verdict('approve');
export const REJECT_GAMED = verdict('reject', [{ id: 'no_test_gaming', severity: 'blocker', message: 'add() special-cases the test inputs' }]);
export const fail = (text, code = 1) => [{ op: 'stderr', text }, { op: 'exit', code }];

const caps = ['text', 'code', 'tools', 'resume', 'cancel'];
export const REGISTRY = { version: 1, as_of: '2026-10-11', models: [
  { runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'strong', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'dev-b', tier: 'standard', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'rev', tier: 'standard', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 2, test_only: true },
] };

// Developer and reviewer are separate fake runtimes; the loop tells them apart only by the role it starts.
export function roleAdapter({ wtRoot, reviewRoot, dev = [], rev = [], probe = null }) {
  const devA = fakeAdapter({ allowedRoots: [wtRoot], scripts: dev.length ? dev : [GOOD] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot], scripts: rev.length ? rev : [APPROVE] });
  const log = { dev: [], rev: [], devRuns: [] };
  const hooks = { onDev: null, onRev: null };
  return {
    log, hooks, devA, revA,
    id: 'fake', provider_ids: ['fake'],
    probeCapabilities: async () => probe ?? ({ available: true, version: 'fake-1', models: ['dev-a', 'dev-b', 'rev'], efforts: ['low', 'medium', 'high'],
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

// ---- sandbox -------------------------------------------------------------------------------------------
export function sandbox(prefix) {
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));
  const HOME = path.join(TMP, 'home');
  fs.mkdirSync(HOME);
  const GIT_ENV = { PATH: process.env.PATH, HOME, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));
  let n = 0;
  const dir = (name) => { const d = path.join(TMP, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  return { TMP, HOME, GIT_ENV, sh, git, dir };
}

const seedFiles = (dir, policy) => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "export const add = () => { throw new Error('not implemented'); };\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), MATH_TEST);
  if (policy) { fs.mkdirSync(path.join(dir, '.ai'), { recursive: true }); fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(policy, null, 1)); }
};

// A plain local repository (no remote).
export function mkRepo(sb, { policy = POLICY } = {}) {
  const dir = sb.dir('repo');
  sb.sh(dir, 'init', '-q', '-b', 'main');
  sb.sh(dir, 'config', 'user.name', 'Test User');
  sb.sh(dir, 'config', 'user.email', 'test@example.invalid');
  seedFiles(dir, policy);
  sb.sh(dir, 'add', '.');
  sb.sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sb.sh(dir, 'rev-parse', 'HEAD') };
}

// A disposable bare "origin" seeded with the project, plus the developer clone the goal loop works in.
export function mkOrigin(sb, { policy = POLICY } = {}) {
  const dir = sb.dir('origin');
  const origin = path.join(dir, 'origin.git');
  sb.sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(dir, 'seed');
  sb.sh(dir, 'clone', '-q', origin, seed);
  sb.sh(seed, 'config', 'user.name', 'Seed User'); sb.sh(seed, 'config', 'user.email', 'seed@example.invalid');
  sb.sh(seed, 'checkout', '-q', '-b', 'main');
  seedFiles(seed, policy);
  sb.sh(seed, 'add', '.'); sb.sh(seed, 'commit', '-q', '-m', 'seed'); sb.sh(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(dir, 'dev');
  sb.sh(dir, 'clone', '-q', origin, repo);
  sb.sh(repo, 'config', 'user.name', 'Dev User'); sb.sh(repo, 'config', 'user.email', 'dev@example.invalid');
  const head = (ref = 'main') => { try { return sb.sh(dir, '--git-dir', origin, 'rev-parse', `refs/heads/${ref}`); } catch { return null; } };
  const upstream = (file, content) => {   // someone else lands a commit on origin/main
    sb.sh(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
    fs.writeFileSync(path.join(seed, file), content);
    sb.sh(seed, 'add', '.'); sb.sh(seed, 'commit', '-q', '-m', `upstream ${file}`); sb.sh(seed, 'push', '-q', 'origin', 'main');
    return head();
  };
  const parents = (sha) => sb.sh(dir, '--git-dir', origin, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  return { dir, origin, seed, repo, head, upstream, parents, sha: head() };
}

// ---- goal-loop world --------------------------------------------------------------------------------------
// A disposable controller world: store, leases, worktrees, verifier, adapters, loop, intake. reopen() = restart.
export function world(sb, { dev = [], rev = [], policy, repo = null, registry = REGISTRY, adapters = null, loopOpts = {}, storeWrap = (s) => s, probe = null } = {}) {
  const r = repo || mkRepo(sb, { policy });
  const base = sb.dir('world');
  const wtRoot = path.join(base, 'wt');
  const reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  const stateDir = path.join(base, 'state');
  const storeDir = path.join(stateDir, 'v2');
  const ck = clock();
  let t = Date.parse('2026-10-11T08:00:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(storeDir, 'leases') }) });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [r.dir], leases, git: sb.git });
  const reg = createRegistry(registry);
  const verifier = createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: 30_000 });
  const ad = roleAdapter({ wtRoot, reviewRoot, dev, rev, probe });
  const make = (wrap = storeWrap) => {
    const store = wrap(createTaskStore({ dir: storeDir, ...ck }));
    const loop = createGoalLoop({ store, registry: reg, adapters: adapters ? adapters({ wtRoot, reviewRoot, ad }) : { fake: ad }, worktrees,
      worktreeRoot: fs.realpathSync(wtRoot), verifier, reviewRoot, leases, git: sb.git, allowFake: true, now, sleep, ...loopOpts });
    return { store, loop, intake: createIntake({ store }) };
  };
  const env = { repo: r, base, wtRoot, reviewRoot, stateDir, storeDir, ad, now, sleep, advance: (ms) => { t += ms; }, leases, worktrees, registry: reg, verifier, ...make() };
  env.reopen = (wrap = (s) => s) => Object.assign(env, make(wrap));
  env.submit = async (over = {}, { source = 'api', template, idempotencyKey } = {}) => (await env.intake.createTask({
    project_id: 'fixture-project', goal: 'Implement add(a, b) in src/math.js so that it returns the sum of both numbers',
    repository: r.dir, risk_class: 'low', runtime_capabilities: ['code'], acceptance_checks: [UNIT_CHECK], ...over,
  }, { source, actor_id: `${source}-client`, template, idempotencyKey })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  env.view = (id) => env.store.get(id);
  env.devStarts = () => ad.log.dev.length;
  env.wt = (id) => path.join(fs.realpathSync(wtRoot), id);
  return env;
}

export const states = (v) => v.history.map((h) => h.to);
export const loopDecisions = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
export const devRuns = (env, id, role = 'developer') => env.events(id).filter((e) => e.kind === 'task.started' && e.payload.role === role).map((e) => e.payload);
export async function waitFor(pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- integration controller on the disposable origin ---------------------------------------------------------
// Fake remote CI: it only knows commits published on the candidate ref; each new SHA is pending once, then success.
export function fakeRemoteCi(o, { candidate = 'v2int/main', red = new Set() } = {}) {
  const seen = new Map();
  const log = [];
  const status = (sha) => {
    const onRemote = o.head(candidate) === sha || o.head('main') === sha;
    let s;
    if (!onRemote) s = 'missing';
    else if (red.has(sha)) s = 'failure';
    else { const k = (seen.get(sha) || 0) + 1; seen.set(sha, k); s = k === 1 ? 'pending' : 'success'; }
    log.push({ sha, status: s });
    return { status: s, sha };
  };
  return { status, log, red };
}

// The production bridge (orchestration/delivery.js) over a real integration controller on the disposable origin. The
// returned `integrate` is what the goal loop is given; every call's result is kept in `runs` (with the controller run
// outcome and its manifest) for assertions.
export function makeDelivery(sb, o, { store, name = 'a', ci, deploys = { status: () => 'idle' }, leases, candidate_ref = 'v2int/main', gates, leaseTtlMs, now } = {}) {
  const base = path.join(o.dir, `ctl-${name}`);
  fs.mkdirSync(base, { recursive: true });
  const mirror = path.join(base, 'mirror');
  if (!fs.existsSync(mirror)) sb.sh(base, 'clone', '-q', o.origin, mirror);
  const run = createGitRunner({ env: sb.GIT_ENV });
  const auth = leases || createLeaseAuthority({ backend: fileBackend({ dir: path.join(o.dir, 'int-leases') }) });
  const wts = createWorktrees({ git: run, root: path.join(base, 'wt'), repoAllowlist: [mirror], leases: auth });
  const queue = createIntegrationQueue({ dir: path.join(base, 'queue') });
  const alerts = [];
  const delivery = createDelivery({
    store, queue, git: sb.git, ci, repo: 'demo', target: 'main',
    controller: ({ store: handle, approvals }) => createIntegrationController({
      store: handle, leases: auth, worktrees: wts, git: run, ci, approvals, deploys, queue, owner: `integrator-${name}`,
      repos: { demo: { dir: mirror, remote: o.origin, source_remotes: [o.repo], ...(candidate_ref ? { candidate_ref } : {}) } },
      alert: (a) => alerts.push(a), manifestDir: path.join(base, 'manifests'), artifactsDir: path.join(base, 'artifacts'),
      ...(gates ? { gates } : {}), ...(leaseTtlMs ? { leaseTtlMs } : {}), ...(now ? { now } : {}),
    }),
  });
  const runs = [];
  const integrate = async (task, ctx) => {
    const r = await delivery.integrate(task, ctx);
    const manifest = r.manifest_path && fs.existsSync(r.manifest_path) ? JSON.parse(fs.readFileSync(r.manifest_path, 'utf8')) : null;
    runs.push({ ...r, outcome: r.run_outcome, manifest, integration_sha: r.integration_sha ?? manifest?.rounds?.at(-1)?.integration_sha ?? r.required?.sha ?? null });
    return r;
  };
  integrate.reconcile = (task, ctx) => delivery.integrate.reconcile(task, ctx);
  return { delivery, integrate, runs, queue, leases: auth, mirror, alerts, base, wanted: () => runs.flatMap((r) => r.proposals || []) };
}
