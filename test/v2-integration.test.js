// V2 Integration Agent (spec §12.3; T24-T31, T39, GL12). Real git, but only against disposable repos: every test
// builds a temp bare "origin", clones it, and commits as a fake user. Nothing here touches this repository's remote.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createIntegrationQueue } from '../orchestration/integration-queue.js';
import { createCiGates, gatesFromPolicy, normalizeCiStatus, remoteStatus } from '../orchestration/ci-gates.js';
import { createIntegrationController, createGitRunner, redact } from '../orchestration/integration-controller.js';
import { spec, clock } from './fixtures/v2-task.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-int-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME);
const GIT_ENV = { PATH: process.env.PATH, HOME, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-agent-2' };
const UNIT = { id: 'unit', command: ['node', 'check.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true };

// Gate: fails when app.txt says BROKEN, and proves it got a fresh, empty GHOSTY_STATE_DIR.
const CHECK_JS = `const fs = require('fs');
const d = process.env.GHOSTY_STATE_DIR;
if (!d || fs.readdirSync(d).length) { console.error('state dir not fresh'); process.exit(3); }
fs.writeFileSync(require('path').join(d, 'ran'), '1');
const s = fs.readdirSync('.').filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(f, 'utf8')).join('');
if (s.includes('BROKEN')) { console.error('broken'); process.exit(1); }
console.log('ok');
`;
// Gate that edits a tracked file once (marker outside the repo): the tree it tested is no longer the tree at HEAD.
const MUTATE_JS = (marker) => `const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); fs.appendFileSync('app.txt', 'drift\\n'); }
`;

const policy = (extra = {}) => ({
  schema_version: 1, project_id: 'demo', test_command: ['node', 'check.js'], protected_branches: ['main'],
  ci_gates: [{ id: 'unit', command: ['node', 'check.js'] }],
  allowlists: { commands: [['node', 'check.js']], paths: ['.'], runtimes: ['fake'], models: null },
  excluded_paths: ['.env'], protected_paths: ['.ai'], prohibited_actions: ['write_live_state'],
  approval_policy: { requires: ['merge_protected', 'push_shared'] }, ...extra,
});

let worldN = 0;
// One disposable remote with an owner seed clone, a developer clone and an integration mirror.
function makeOrigin(name, { pol = policy(), files = {} } = {}) {
  const dir = path.join(tmp, `${name}-${++worldN}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, 'origin.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(dir, 'seed');
  sh(dir, 'clone', '-q', origin, seed);
  sh(seed, 'config', 'user.name', 'Seed User'); sh(seed, 'config', 'user.email', 'seed@example.invalid');
  sh(seed, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(seed, '.ai'));
  fs.writeFileSync(path.join(seed, '.ai', 'project.json'), JSON.stringify(pol, null, 1));
  fs.writeFileSync(path.join(seed, 'check.js'), CHECK_JS);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'line one\nline two\n');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(seed, f), c);
  sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'seed'); sh(seed, 'push', '-q', 'origin', 'main');
  const dev = path.join(dir, 'dev');
  sh(dir, 'clone', '-q', origin, dev);
  sh(dev, 'config', 'user.name', 'Dev User'); sh(dev, 'config', 'user.email', 'dev@example.invalid');
  return { dir, origin, seed, dev, head: () => sh(dir, '--git-dir', origin, 'rev-parse', 'refs/heads/main') };
}

function makeController(o, { name = 'a', store, leaseDir, backend, authority, ci = { status: () => 'success' }, approvals = autoApprove(),
  deploys = { status: () => 'idle' }, git, alert, candidate_ref, leaseTtlMs, now } = {}) {
  const base = path.join(o.dir, `ctl-${name}`);
  fs.mkdirSync(base, { recursive: true });
  const mirror = path.join(base, 'mirror');
  if (!fs.existsSync(mirror)) sh(base, 'clone', '-q', o.origin, mirror);
  const run = git || createGitRunner({ env: GIT_ENV });
  const leases = authority || createLeaseAuthority({ backend: backend || fileBackend({ dir: leaseDir || path.join(o.dir, 'leases') }), alert: alert || (() => {}), ...(now ? { now } : {}) });
  const wts = createWorktrees({ git: run, root: path.join(base, 'wt'), repoAllowlist: [mirror], leases });
  const queue = createIntegrationQueue({ dir: path.join(base, 'queue') });
  const st = store || createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const alerts = [];
  const controller = createIntegrationController({
    store: st, leases, worktrees: wts, git: run, ci, approvals, deploys, queue, owner: `integrator-${name}`,
    repos: { demo: { dir: mirror, remote: o.origin, ...(candidate_ref ? { candidate_ref } : {}) } },
    alert: (a) => alerts.push(a), manifestDir: path.join(base, 'manifests'), artifactsDir: path.join(base, 'artifacts'),
    ...(leaseTtlMs ? { leaseTtlMs } : {}), ...(now ? { now } : {}),
  });
  return { controller, store: st, queue, leases, mirror, alerts, base };
}

function autoApprove() {
  const calls = [];
  return { calls, check: (req) => { calls.push(req); return { ok: true, approval_ref: `appr-${req.action}-${req.sha.slice(0, 8)}`, sha: req.sha, action: req.action, target: req.target, repo: req.repo, approved_by: 'owner-test' }; } };
}
// Owner grants exact (action, sha, target) triples only.
function ownerApprovals() {
  const grants = new Map();
  const calls = [];
  return {
    calls, grant: (action, sha, target, extra = {}) => grants.set(`${action}|${sha}|${target}`, { approval_ref: `appr-${grants.size + 1}`, ...extra }),
    check: (req) => {
      calls.push(req);
      const g = grants.get(`${req.action}|${req.sha}|${req.target}`);
      return g ? { ok: true, sha: req.sha, action: req.action, target: req.target, repo: req.repo, approved_by: 'owner-test', ...g } : { ok: false, reason: 'not approved' };
    },
  };
}

// A developer branch with the given file contents, branched from the current origin/main.
function devBranch(o, branch, files, { from = 'origin/main' } = {}) {
  sh(o.dev, 'fetch', '-q', 'origin');
  sh(o.dev, 'checkout', '-q', '-B', branch, from);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(o.dev, f), c);
  sh(o.dev, 'add', '.'); sh(o.dev, 'commit', '-q', '-m', `work on ${branch}`);
  sh(o.dev, 'push', '-q', '-f', 'origin', branch);
  return { sha: sh(o.dev, 'rev-parse', 'HEAD'), base: sh(o.dev, 'rev-parse', from) };
}

// Task in `evaluating` with passing evidence and an independent approve verdict on `sha`.
async function readyTask(store, id, { sha, scope = ['.'], verdict = true, evidence = true } = {}) {
  await store.createTask(spec({ task_id: id, scope: { paths: scope }, acceptance_checks: [UNIT], base_sha: sha }));
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating']) await store.transition(id, s, { actor: 'controller' });
  await store.setHead(id, sha, { actor: DEV });
  if (evidence) await store.recordEvidence(id, { check_id: 'unit', sha, command: UNIT.command, exit: 0, duration_ms: 10, artifact: null, actor: 'runner' });
  if (verdict) await store.recordVerdict(id, { sha, actor: VERIFIER, verdict: 'approve', findings: [] });
}
const handoff = (id, branch, b, diff_scope) => ({ task_id: id, repo: 'demo', target: 'main', source_branch: branch, source_sha: b.sha,
  base_sha: b.base, developer: DEV, diff_scope });
const eventsOf = (store, id) => fs.readFileSync(path.join(store.dir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const parents = (o, sha) => sh(o.dir, '--git-dir', o.origin, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
const status = async (store, id) => (await store.get(id)).status;

// ---- units ------------------------------------------------------------------------------------------

test('ci-gates: status normalization and gate list from policy fail closed', async () => {
  assert.equal(normalizeCiStatus('success', 'a'), 'success');
  assert.equal(normalizeCiStatus({ status: 'success', sha: 'b' }, 'a'), 'unknown');   // a verdict for another sha
  assert.equal(normalizeCiStatus('green', 'a'), 'unknown');
  assert.equal(normalizeCiStatus(undefined, 'a'), 'unknown');
  assert.equal((await remoteStatus(undefined, 'a')).status, 'missing');
  assert.equal((await remoteStatus({ status: () => { throw new Error('down'); } }, 'a')).status, 'unknown');
  assert.equal((await remoteStatus({ status: () => new Promise(() => {}) }, 'a', { timeoutMs: 20 })).status, 'unknown');
  assert.deepEqual(gatesFromPolicy(policy()), [{ id: 'unit', command: ['node', 'check.js'] }]);
  assert.deepEqual(gatesFromPolicy({ test_command: ['npm', 'test'] }), [{ id: 'test', command: ['npm', 'test'] }]);
  assert.deepEqual(gatesFromPolicy({}), []);
});

test('integration queue: durable FIFO, one running item per target, torn tail and interrupted runs recovered', async () => {
  const dir = path.join(tmp, 'queue-unit');
  const q = createIntegrationQueue({ dir });
  const a = await q.enqueue({ task_id: 'ta', repo: 'demo', target: 'main' }, { idempotencyKey: 'k-a' });
  const again = await q.enqueue({ task_id: 'ta', repo: 'demo', target: 'main' }, { idempotencyKey: 'k-a' });
  assert.equal(again.item_id, a.item_id);
  const b = await q.enqueue({ task_id: 'tb', repo: 'demo', target: 'main' });
  await q.enqueue({ task_id: 'tc', repo: 'demo', target: 'other' });
  assert.deepEqual((await q.peek('demo', 'main', { limit: 5 })).map((x) => x.task_id), ['ta', 'tb']);
  await q.start([a.item_id], { owner: 'x' });
  assert.deepEqual(await q.peek('demo', 'main'), []);
  await assert.rejects(q.start([b.item_id], { owner: 'y' }), { code: 'E_BUSY' });
  assert.equal((await q.peek('demo', 'other')).length, 1);   // other lanes are independent
  fs.appendFileSync(path.join(dir, 'queue.jsonl'), '{"seq":99,"op":"sta');   // torn, never acknowledged
  const q2 = createIntegrationQueue({ dir });
  assert.equal((await q2.list()).length, 3);                                  // readers see the log, torn tail ignored
  await assert.rejects(q2.finish(a.item_id, 'merged'), { code: 'E_BUSY' });   // single writer: q still owns it
  await q.close();
  await q2.claim();
  const items = await q2.list();
  assert.equal(items.length, 3);
  assert.equal(items.find((x) => x.item_id === a.item_id).state, 'unknown');   // was running at the crash
  assert.ok(fs.readFileSync(path.join(dir, 'queue.jsonl'), 'utf8').includes('recovered_torn_tail'));
  await q2.finish(a.item_id, 'merged');
  await assert.rejects(q2.finish(a.item_id, 'queued'), { code: 'E_ILLEGAL_TRANSITION' });
  // A final item does not pin its idempotency key: the same handoff can be queued again.
  const again2 = await q2.enqueue({ task_id: 'ta', repo: 'demo', target: 'main' }, { idempotencyKey: 'k-a' });
  assert.notEqual(again2.item_id, a.item_id);
  assert.ok(createIntegrationQueue({ dir: path.join(tmp, 'queue-unit-reload') }));
  const q3 = createIntegrationQueue({ dir });
  assert.equal((await q3.list()).length, 4);
});

test('handoff validation rejects missing evidence, self-approval, stale sha and out-of-scope diffs', async () => {
  const o = makeOrigin('validate');
  const w = makeController(o);
  const b = devBranch(o, 'feat-v', { 'app.txt': 'line one\nline two\nmore\n', 'other.txt': 'x\n' });
  await readyTask(w.store, 'v-noev', { sha: b.sha, evidence: false });
  let r = await w.controller.submit(handoff('v-noev', 'feat-v', b, ['.']));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /missing passing evidence for required check unit/);
  assert.ok(eventsOf(w.store, 'v-noev').some((e) => e.kind === 'task.blocked' && e.payload.reason === 'handoff_rejected'));

  await readyTask(w.store, 'v-self', { sha: b.sha, verdict: false });
  await w.store.recordVerdict('v-self', { sha: b.sha, actor: { role: 'verifier', id: ' DEV-Agent-1 ' }, verdict: 'approve', findings: [] });
  r = await w.controller.submit(handoff('v-self', 'feat-v', b, ['.']));
  assert.match(r.errors.join('\n'), /independence: no independent approve/);   // case-folded id = the developer

  await readyTask(w.store, 'v-scope', { sha: b.sha, scope: ['app.txt'] });
  r = await w.controller.submit(handoff('v-scope', 'feat-v', b, ['app.txt']));
  assert.match(r.errors.join('\n'), /other\.txt is not in the declared diff_scope/);
  assert.match(r.errors.join('\n'), /other\.txt is outside the task scope/);

  await readyTask(w.store, 'v-stale', { sha: b.sha });
  r = await w.controller.submit({ ...handoff('v-stale', 'feat-v', b, ['.']), source_sha: b.base });
  assert.match(r.errors.join('\n'), /stale handoff/);

  r = await w.controller.submit(handoff('v-stale', 'feat-v', b, ['.']));
  assert.equal(r.ok, true);
  assert.equal(r.item.state, 'queued');
});

// ---- T24 ---------------------------------------------------------------------------------------------

test('T24 conflicting branches: conflict detected and returned to its developer with files; the other merges', async () => {
  const o = makeOrigin('t24c');
  const w = makeController(o);
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'app.txt': 'line one A\nline two\n' });
  const b = devBranch(o, 'feat-b', { 'app.txt': 'line one B\nline two\n' });
  await readyTask(w.store, 't24-a', { sha: a.sha });
  await readyTask(w.store, 't24-b', { sha: b.sha });
  assert.equal((await w.controller.submit(handoff('t24-a', 'feat-a', a, ['app.txt']))).ok, true);
  assert.equal((await w.controller.submit(handoff('t24-b', 'feat-b', b, ['app.txt']))).ok, true);

  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  assert.equal(o.head(), r.integration_sha);
  assert.deepEqual(parents(o, r.integration_sha), [before, a.sha]);
  // B: back to repair with the conflicting file, never auto-resolved.
  assert.equal(await status(w.store, 't24-b'), 'repair');
  const qb = (await w.queue.list()).find((x) => x.task_id === 't24-b');
  assert.equal(qb.state, 'returned');
  assert.deepEqual(qb.detail.files, ['app.txt']);
  assert.deepEqual(r.manifest.rounds[0].conflicts.map((c) => c.files), [['app.txt']]);
  const dec = (await w.store.get('t24-b')).decisions.find((d) => d.kind === 'integration.conflict');
  assert.equal(dec.chosen, 'return to developer');
  assert.equal(sh(o.dir, '--git-dir', o.origin, 'show', `${o.head()}:app.txt`), 'line one A\nline two');
  // Gates ran on the merge sha, not on the developer's sha.
  const ev = (await w.store.get('t24-a')).evidence.filter((e) => e.check_id === 'integration:unit');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].sha, r.integration_sha);
  assert.notEqual(ev[0].sha, a.sha);
  assert.equal(ev[0].exit, 0);
  assert.equal(await status(w.store, 't24-a'), 'release_verifying');
});

test('T24 non-conflicting branches: merged sequentially, gates run once on the final merge sha', async () => {
  const o = makeOrigin('t24n');
  const w = makeController(o);
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'from a\n' });
  const b = devBranch(o, 'feat-b', { 'b.txt': 'from b\n' });
  await readyTask(w.store, 'n-a', { sha: a.sha });
  await readyTask(w.store, 'n-b', { sha: b.sha });
  await w.controller.submit(handoff('n-a', 'feat-a', a, ['a.txt']));
  await w.controller.submit(handoff('n-b', 'feat-b', b, ['b.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  const merges = sh(o.dir, '--git-dir', o.origin, 'rev-list', '--merges', `${before}..${r.integration_sha}`).split('\n');
  assert.equal(merges.length, 2);
  assert.equal(merges[0], r.integration_sha);
  assert.deepEqual(r.manifest.rounds[0].merges.map((x) => x.source_sha), [a.sha, b.sha]);
  assert.equal(r.manifest.rounds[0].gates.length, 1);
  assert.equal(r.manifest.rounds[0].gates[0].sha, r.integration_sha);
  assert.match(r.manifest.rounds[0].gates[0].env_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(r.manifest.rounds[0].gates[0].artifact_digest, /^sha256:[0-9a-f]{64}$/);
  for (const t of ['n-a', 'n-b']) {
    assert.equal(await status(w.store, t), 'release_verifying');
    assert.deepEqual((await w.store.get(t)).evidence.filter((e) => e.check_id === 'integration:unit').map((e) => e.sha), [r.integration_sha]);
  }
});

test('T24 red gate on the merge sha returns the work even though each branch was green alone', async () => {
  const o = makeOrigin('t24red');
  const w = makeController(o);
  const before = o.head();
  // Each branch alone is fine; together they spell BROKEN.
  const a = devBranch(o, 'feat-a', { 'zz1.txt': 'BRO' });
  const b = devBranch(o, 'feat-b', { 'zz2.txt': 'KEN' });
  await readyTask(w.store, 'r-a', { sha: a.sha });
  await readyTask(w.store, 'r-b', { sha: b.sha });
  await w.controller.submit(handoff('r-a', 'feat-a', a, ['zz1.txt']));
  await w.controller.submit(handoff('r-b', 'feat-b', b, ['zz2.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'gates_failed');
  assert.equal(o.head(), before);
  assert.equal(await status(w.store, 'r-a'), 'repair');
  assert.equal((await w.store.get('r-a')).evidence.find((e) => e.check_id === 'integration:unit').exit, 1);
});

// ---- T25 ---------------------------------------------------------------------------------------------

test('T25 two integration controllers race on the same target: exactly one fenced holder mutates it', async () => {
  const o = makeOrigin('t25');
  const store = createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const leaseDir = path.join(o.dir, 'shared-leases');
  const before = o.head();
  // Each controller waits inside its run (holding its leases) until the other one has finished: if both could
  // hold the lane at once, both would wait out the timeout and both would push.
  const done = {};
  const settled = { a: new Promise((r) => { done.a = r; }), b: new Promise((r) => { done.b = r; }) };
  const ciFor = (other) => ({ status: async () => { await Promise.race([settled[other], new Promise((r) => setTimeout(r, 3000))]); return 'success'; } });
  const A = makeController(o, { name: 'a', store, leaseDir, ci: ciFor('b') });
  const B = makeController(o, { name: 'b', store, leaseDir, ci: ciFor('a') });
  const x = devBranch(o, 'feat-x', { 'x.txt': 'x\n' });
  const y = devBranch(o, 'feat-y', { 'y.txt': 'y\n' });
  await readyTask(store, 't25-x', { sha: x.sha });
  await readyTask(store, 't25-y', { sha: y.sha });
  await A.controller.submit(handoff('t25-x', 'feat-x', x, ['x.txt']));
  await B.controller.submit(handoff('t25-y', 'feat-y', y, ['y.txt']));

  const [ra, rb] = await Promise.all([
    A.controller.runNext('demo', 'main').finally(() => done.a()),
    B.controller.runNext('demo', 'main').finally(() => done.b()),
  ]);
  const outcomes = [ra.outcome, rb.outcome].sort();
  assert.deepEqual(outcomes, ['busy', 'merged']);
  const [win, lose, winTask, loseTask, loser] = ra.outcome === 'merged' ? [ra, rb, 't25-x', 't25-y', B] : [rb, ra, 't25-y', 't25-x', A];
  assert.equal(o.head(), win.integration_sha);
  assert.deepEqual(parents(o, win.integration_sha)[0], before);   // exactly one merge on top of the old target
  assert.equal(lose.reason, 'E_HELD');
  assert.equal(await status(store, loseTask), 'evaluating');      // the loser never entered integration
  assert.equal(await status(store, winTask), 'release_verifying');
  assert.equal((await loser.queue.list()).find((i) => i.task_id === loseTask).state, 'queued');
  const audit = fs.readFileSync(path.join(leaseDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(audit.some((e) => e.op === 'denied' && e.code === 'E_HELD'));

  // The loser goes next, from a fresh target that already contains the winner.
  const again = await loser.controller.runNext('demo', 'main');
  assert.equal(again.outcome, 'merged');
  assert.equal(parents(o, again.integration_sha)[0], win.integration_sha);
});

// ---- T26 ---------------------------------------------------------------------------------------------

test('T26 lease backend unavailable or stale: no merge/push, blocked and alerted', async () => {
  for (const mode of ['unavailable', 'stale']) {
    const o = makeOrigin(`t26-${mode}`);
    const authAlerts = [];
    const authority = createLeaseAuthority({ backend: fakeBackend({ fail: mode }), alert: (a) => authAlerts.push(a) });
    const w = makeController(o, { authority });
    const before = o.head();
    const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
    await readyTask(w.store, `t26-${mode}`, { sha: a.sha });
    await w.controller.submit(handoff(`t26-${mode}`, 'feat-a', a, ['a.txt']));
    const r = await w.controller.runNext('demo', 'main');
    assert.equal(r.outcome, 'blocked');
    assert.match(r.reason, /E_UNAVAILABLE/);
    assert.equal(o.head(), before);
    assert.equal(await status(w.store, `t26-${mode}`), 'evaluating');
    assert.ok(eventsOf(w.store, `t26-${mode}`).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'lease_unavailable'));
    assert.equal((await w.queue.list())[0].state, 'blocked');
    assert.ok(authAlerts.some((x) => x.kind === 'lease_unavailable'));
    assert.ok(w.alerts.some((x) => x.kind === 'integration_blocked_lease'));
    assert.equal((await w.store.get(`t26-${mode}`)).effects.length, 0);
  }
});

test('T26 deployment state unknown blocks integration before any lease or mutation', async () => {
  const o = makeOrigin('t26-deploy');
  const w = makeController(o, { deploys: { status: () => { throw new Error('registry down'); } } });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't26-d', { sha: a.sha });
  await w.controller.submit(handoff('t26-d', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason, 'deploy_state_unknown');
  assert.equal(o.head(), before);
  assert.ok(w.alerts.some((x) => x.kind === 'deploy_state_unknown'));
});

// ---- T27 ---------------------------------------------------------------------------------------------

test('T27 lease expires mid-run and is taken over: the stale executor cannot push', async () => {
  const o = makeOrigin('t27');
  const c = () => c.t; c.t = Date.now();
  const leaseDir = path.join(o.dir, 'leases');
  const intruder = createLeaseAuthority({ backend: fileBackend({ dir: leaseDir }), now: c });
  let taken = null;
  const ci = { status: async () => {
    if (!taken) {   // during the long CI wait the lease runs out and someone else legitimately takes the target
      c.t += 10 * 60_000;
      taken = await intruder.acquire('repo:demo:main', { owner: 'other-integrator', ttl_ms: 60_000, scope: 'integration' });
    }
    return 'success';
  } };
  const w = makeController(o, { leaseDir, ci, now: c, leaseTtlMs: 60_000 });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't27', { sha: a.sha });
  await w.controller.submit(handoff('t27', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(taken.ok, true);
  assert.equal(r.outcome, 'lease_lost');
  assert.match(r.reason, /E_FENCED|E_EXPIRED/);
  assert.equal(o.head(), before);
  const effects = (await w.store.get('t27')).effects;
  assert.equal(effects.length, 1);
  assert.equal(effects[0].phase, 'failed');   // recorded, fenced before the push ran, never applied
  assert.ok(w.alerts.some((x) => x.kind === 'lease_lost'));
  assert.ok(eventsOf(w.store, 't27').some((e) => e.kind === 'task.blocked' && e.payload.reason === 'lease_lost'));
});

// ---- T28 ---------------------------------------------------------------------------------------------

test('T28 target updated after tests: previous gate invalidated, rebuilt on the new target, all gates rerun', async () => {
  const o = makeOrigin('t28t');
  let upstream = null;
  const ci = { status: async () => {
    if (!upstream) {   // somebody lands a change on main while we wait for CI
      fs.writeFileSync(path.join(o.seed, 'up.txt'), 'upstream\n');
      sh(o.seed, 'add', '.'); sh(o.seed, 'commit', '-q', '-m', 'upstream change'); sh(o.seed, 'push', '-q', 'origin', 'main');
      upstream = sh(o.seed, 'rev-parse', 'HEAD');
    }
    return 'success';
  } };
  const w = makeController(o, { ci });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't28', { sha: a.sha });
  await w.controller.submit(handoff('t28', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  const [r0, r1] = r.manifest.rounds;
  assert.match(r0.invalidated, /target moved/);
  assert.equal(r1.target_sha, upstream);
  assert.notEqual(r0.integration_sha, r1.integration_sha);
  assert.equal(r.integration_sha, r1.integration_sha);
  assert.deepEqual(parents(o, r.integration_sha), [upstream, a.sha]);
  const shas = (await w.store.get('t28')).evidence.filter((e) => e.check_id === 'integration:unit').map((e) => e.sha);
  assert.deepEqual(shas, [r0.integration_sha, r1.integration_sha]);
  assert.ok((await w.store.get('t28')).decisions.some((d) => d.kind === 'integration.invalidate'));
});

test('T28 integration tree changed by a gate after tests: evidence invalidated and gates rerun on a clean tree', async () => {
  const marker = path.join(tmp, `t28-marker-${Date.now()}`);
  const pol = policy({ ci_gates: [{ id: 'mutate', command: ['node', 'mutate.js'] }, { id: 'unit', command: ['node', 'check.js'] }] });
  const o = makeOrigin('t28b', { pol, files: { 'mutate.js': MUTATE_JS(marker) } });
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't28b', { sha: a.sha });
  await w.controller.submit(handoff('t28b', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  assert.match(r.manifest.rounds[0].invalidated, /gate mutate changed the worktree/);
  assert.deepEqual(r.manifest.rounds[1].gates.map((g) => [g.check_id, g.exit, g.sha]), [['mutate', 0, r.integration_sha], ['unit', 0, r.integration_sha]]);
  assert.equal(sh(o.dir, '--git-dir', o.origin, 'show', `${o.head()}:app.txt`), 'line one\nline two');
});

// ---- T29 ---------------------------------------------------------------------------------------------

test('T29 remote CI red, missing, pending or unknown: no merge even with local gates green', async () => {
  const cases = [
    ['failure', { status: () => 'failure' }, 'ci_failed', 'repair'],
    ['pending', { status: () => 'pending' }, 'ci_blocked', 'waiting'],
    ['missing', { status: () => 'missing' }, 'ci_blocked', 'waiting'],
    ['not configured', undefined, 'ci_blocked', 'waiting'],
    ['other sha', { status: () => ({ status: 'success', sha: '0'.repeat(40) }) }, 'ci_blocked', 'waiting'],
    ['garbage', { status: () => 'green' }, 'ci_blocked', 'waiting'],
  ];
  for (const [label, ci, outcome, state] of cases) {
    const o = makeOrigin('t29');
    const approvals = autoApprove();
    const w = makeController(o, { ci: ci ?? null, approvals });
    const before = o.head();
    const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
    const id = `t29-${label.replace(/ /g, '-')}`;
    await readyTask(w.store, id, { sha: a.sha });
    await w.controller.submit(handoff(id, 'feat-a', a, ['a.txt']));
    const r = await w.controller.runNext('demo', 'main');
    assert.equal(r.outcome, outcome, label);
    assert.equal(o.head(), before, `${label}: target untouched`);
    const ev = (await w.store.get(id)).evidence.find((e) => e.check_id === 'integration:unit');
    assert.equal(ev.exit, 0, `${label}: local gate was green`);
    assert.equal(await status(w.store, id), state, label);
    assert.equal(approvals.calls.length, 0, `${label}: never even asked to merge`);
    assert.equal((await w.store.get(id)).effects.length, 0);
    if (state === 'waiting') {   // D-007: parked with a structured wake condition, item parked too
      const ev = (await w.store.events(id)).filter((e) => e.kind === 'task.blocked').at(-1);
      assert.deepEqual(ev.payload.wake, { kind: 'ci_status', repo: 'demo', sha: r.integration_sha });
      assert.equal((await w.queue.list())[0].state, 'blocked');
    }
  }
});

// ---- T30 ---------------------------------------------------------------------------------------------

function flakyPush(mode) {
  const real = createGitRunner({ env: GIT_ENV });
  const log = [];
  let lsRemoteDown = false;
  const git = async (args, o) => {
    log.push(args[0]);
    if (args[0] === 'ls-remote' && lsRemoteDown) throw Object.assign(new Error('network down'), { code: 'E_GIT' });
    if (args[0] === 'push' && args.at(-1).endsWith(':refs/heads/main')) {
      if (mode !== 'lost') await real(args, o);           // the remote accepts it...
      if (mode === 'blind') lsRemoteDown = true;
      throw Object.assign(new Error('git push timed out'), { code: 'E_TIMEOUT' });   // ...but we never hear back
    }
    return real(args, o);
  };
  return { git, log, pushes: () => log.filter((x) => x === 'push').length, heal: () => { lsRemoteDown = false; } };
}

test('T30 push times out after the remote accepted it: remote queried, no double push, marked confirmed', async () => {
  const o = makeOrigin('t30');
  const f = flakyPush('accepted');
  const w = makeController(o, { git: f.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't30', { sha: a.sha });
  await w.controller.submit(handoff('t30', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  assert.equal(o.head(), r.integration_sha);
  assert.equal(f.pushes(), 1);
  assert.equal(f.log[f.log.lastIndexOf('push') + 1], 'ls-remote');   // asked the remote right after the timeout
  assert.equal(r.manifest.rounds[0].pushed.uncertain_response, true);
  const eff = (await w.store.get('t30')).effects;
  assert.deepEqual(eff.map((e) => e.phase), ['confirmed']);
  assert.deepEqual(eff[0].history.map((h) => h.phase), ['attempted', 'confirmed']);
  assert.equal(await status(w.store, 't30'), 'release_verifying');
});

test('T30 push timed out and the remote did not take it: marked failed, not retried blindly, not success', async () => {
  const o = makeOrigin('t30lost');
  const f = flakyPush('lost');
  const w = makeController(o, { git: f.git });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't30l', { sha: a.sha });
  await w.controller.submit(handoff('t30l', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'blocked');
  assert.match(r.reason, /push failed/);
  assert.equal(o.head(), before);
  assert.equal(f.pushes(), 1);
  assert.deepEqual((await w.store.get('t30l')).effects.map((e) => e.phase), ['failed']);
  assert.equal(await status(w.store, 't30l'), 'waiting');
});

test('T30 push outcome unknowable: unknown_external_effect, then reconciled from the remote without pushing again', async () => {
  const o = makeOrigin('t30blind');
  const f = flakyPush('blind');
  const w = makeController(o, { git: f.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't30b', { sha: a.sha });
  await w.controller.submit(handoff('t30b', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'unknown_external_effect');
  assert.equal(await status(w.store, 't30b'), 'unknown_external_effect');
  assert.deepEqual((await w.store.get('t30b')).effects.map((e) => e.phase), ['possibly_applied']);
  assert.equal((await w.queue.list())[0].state, 'unknown');
  f.heal();
  const r2 = await w.controller.runNext('demo', 'main');
  assert.equal(r2.outcome, 'reconciled');
  assert.equal(f.pushes(), 1);
  assert.equal(o.head(), r.integration_sha);
  assert.deepEqual((await w.store.get('t30b')).effects.map((e) => e.phase), ['confirmed']);
  assert.equal(await status(w.store, 't30b'), 'release_verifying');
  assert.equal((await w.queue.list())[0].state, 'merged');
});

// ---- T31 ---------------------------------------------------------------------------------------------

test('T31 unapproved merge is refused and audited; approvals for another sha/action/target or expired do not count', async () => {
  const o = makeOrigin('t31');
  const approvals = ownerApprovals();
  const w = makeController(o, { approvals });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't31', { sha: a.sha });
  await w.controller.submit(handoff('t31', 'feat-a', a, ['a.txt']));

  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'awaiting_approval');
  assert.equal(o.head(), before);
  assert.equal(await status(w.store, 't31'), 'awaiting_approval');
  const req = eventsOf(w.store, 't31').find((e) => e.kind === 'approval.requested');
  assert.equal(req.payload.actor.id, 'integrator-a');
  assert.deepEqual(req.payload.required, { action: 'merge', class: 'merge_protected', sha: r.integration_sha, target: 'main' });
  assert.equal((await w.store.get('t31')).effects.length, 0);

  // Wrong sha, wrong action, wrong target, expired: all refused.
  const sha = r.integration_sha;
  approvals.grant('merge', a.sha, 'main');
  approvals.grant('push', sha, 'main');
  approvals.grant('merge', sha, 'release');
  const r2 = await w.controller.runNext('demo', 'main');
  assert.equal(r2.outcome, 'awaiting_approval');
  assert.equal(r2.integration_sha, sha);   // deterministic rebuild: same inputs, same sha
  approvals.grant('merge', sha, 'main', { expires_at: Date.now() - 1 });
  assert.equal((await w.controller.runNext('demo', 'main')).outcome, 'awaiting_approval');
  assert.equal(o.head(), before);

  approvals.grant('merge', sha, 'main', { expires_at: Date.now() + 3600_000, approval_ref: 'owner-ok-1' });
  const ok = await w.controller.runNext('demo', 'main');
  assert.equal(ok.outcome, 'merged');
  assert.equal(o.head(), sha);
  assert.deepEqual(ok.manifest.approvals.at(-1), { action: 'merge', sha, target: 'main', approval_ref: 'owner-ok-1', approved_by: 'owner-test' });
});

test('T31 policy-prohibited merge is refused even with an approval', async () => {
  const o = makeOrigin('t31p', { pol: policy({ prohibited_actions: ['merge_protected'] }) });
  const w = makeController(o);
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 't31p', { sha: a.sha });
  await w.controller.submit(handoff('t31p', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'returned');
  assert.equal(o.head(), before);
  assert.equal(await status(w.store, 't31p'), 'awaiting_approval');
  assert.equal((await w.queue.list())[0].state, 'rejected');
});

// ---- T39 ---------------------------------------------------------------------------------------------

test('T39 E2E on a disposable remote: worktree patch -> independent verify -> integration -> gates -> CI -> approved push/merge, exact SHAs in a manifest', async () => {
  const o = makeOrigin('t39');
  const store = createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const approvals = ownerApprovals();
  const remoteRef = (ref) => { try { return sh(o.dir, '--git-dir', o.origin, 'rev-parse', `refs/heads/${ref}`); } catch { return null; } };
  // Fake remote CI: it can only report on commits it has seen, i.e. the published candidate branch.
  const ci = { status: (sha) => (remoteRef('v2int/main') === sha ? { status: 'success', sha } : 'missing') };
  const w = makeController(o, { store, approvals, ci, candidate_ref: 'v2int/main' });
  const before = o.head();

  // Developer: own leased worktree, patch, commit, publish branch.
  const devLeases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(o.dir, 'dev-leases') }) });
  const devGit = createGitRunner({ env: GIT_ENV });
  const devWts = createWorktrees({ git: devGit, root: path.join(o.dir, 'dev-wt'), repoAllowlist: [o.dev], leases: devLeases });
  sh(o.dev, 'fetch', '-q', 'origin');
  const wt = await devWts.create({ repo: o.dev, task_id: 't39', base_sha: before, owner: 'dev-agent-1' });
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'new feature\n');
  sh(wt.path, 'add', 'feature.txt'); sh(wt.path, 'commit', '-q', '-m', 'feature');
  const devSha = sh(wt.path, 'rev-parse', 'HEAD');
  sh(wt.path, 'push', '-q', 'origin', `${wt.branch}:${wt.branch}`);

  await store.createTask(spec({ task_id: 't39', scope: { paths: ['feature.txt'] }, acceptance_checks: [UNIT], base_sha: before }));
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating']) await store.transition('t39', s, { actor: 'controller' });
  await store.setHead('t39', devSha, { actor: DEV });
  // Developer evidence: the real check, on the exact dev sha.
  const gates = createCiGates({ git: devGit, artifactsDir: path.join(o.dir, 'dev-artifacts'), actor: DEV });
  const dg = await gates.run({ cwd: wt.path, sha: devSha, gates: [{ id: 'unit', command: UNIT.command }] });
  assert.equal(dg.ok, true);
  await store.recordEvidence('t39', { ...dg.evidence[0], artifact: dg.evidence[0].artifact_digest, actor: 'runner' });
  // Independent verifier: its own checkout of that sha, its own run, its own verdict.
  const vdir = path.join(o.dir, 'verifier');
  sh(o.dir, 'clone', '-q', o.origin, vdir);
  sh(vdir, 'checkout', '-q', '--detach', devSha);
  const vg = await createCiGates({ git: devGit, artifactsDir: path.join(o.dir, 'ver-artifacts'), actor: VERIFIER })
    .run({ cwd: vdir, sha: devSha, gates: [{ id: 'unit', command: UNIT.command }] });
  assert.equal(vg.ok, true);
  await store.recordVerdict('t39', { sha: devSha, actor: VERIFIER, verdict: 'approve', findings: [] });

  const sub = await w.controller.submit({ task_id: 't39', repo: 'demo', target: 'main', source_branch: wt.branch, source_sha: devSha,
    base_sha: before, developer: DEV, diff_scope: ['feature.txt'] });
  assert.equal(sub.ok, true);

  // Run 1: gates green, CI has never seen the sha, publishing the candidate needs the owner.
  const r1 = await w.controller.runNext('demo', 'main');
  assert.equal(r1.outcome, 'awaiting_approval');
  assert.deepEqual(r1.required, { action: 'push', class: 'push_shared', sha: r1.integration_sha, target: 'v2int/main' });
  assert.equal(remoteRef('v2int/main'), null);
  const S = r1.integration_sha;
  approvals.grant('push', S, 'v2int/main');
  // Run 2: same sha rebuilt, candidate published, CI success on S, merge still needs its own approval.
  const r2 = await w.controller.runNext('demo', 'main');
  assert.equal(r2.integration_sha, S);
  assert.equal(remoteRef('v2int/main'), S);
  assert.equal(r2.outcome, 'awaiting_approval');
  assert.deepEqual(r2.required, { action: 'merge', class: 'merge_protected', sha: S, target: 'main' });
  assert.equal(o.head(), before);
  approvals.grant('merge', S, 'main');
  // Run 3: approved for exactly S -> CAS push to main.
  const r3 = await w.controller.runNext('demo', 'main');
  assert.equal(r3.outcome, 'merged');
  assert.equal(o.head(), S);
  assert.deepEqual(parents(o, S), [before, devSha]);
  assert.equal(await status(store, 't39'), 'release_verifying');

  // Machine-readable manifest with the exact SHAs.
  const m = JSON.parse(fs.readFileSync(r3.manifest_path, 'utf8'));
  assert.equal(m.outcome, 'merged');
  assert.equal(m.integration_sha, S);
  assert.equal(m.target_sha_before, before);
  assert.equal(m.remote_target_after, S);
  assert.deepEqual(m.items.map((i) => [i.task_id, i.source_sha, i.base_sha, i.developers, i.verifiers]), [['t39', devSha, before, ['dev-agent-1'], ['verifier-agent-2']]]);
  const round = m.rounds.at(-1);
  assert.equal(round.target_sha, before);
  assert.deepEqual(round.merges, [{ item_id: m.items[0].item_id, task_id: 't39', source_sha: devSha, merge_sha: S }]);
  assert.ok(round.gates.every((g) => g.sha === S && g.exit === 0));
  assert.deepEqual(round.remote_ci && [round.remote_ci.status, round.remote_ci.sha], ['success', S]);
  assert.deepEqual(m.approvals.map((x) => [x.action, x.sha, x.target]), [['merge', S, 'main']]);
  assert.deepEqual(m.effects.map((e) => [e.kind, e.ref, e.sha, e.expected, e.phase]), [['merge', 'main', S, before, 'confirmed']]);
  assert.deepEqual(m.leases.map((l) => l.resource), ['repo:demo:integration', 'repo:demo:main']);
  const all = fs.readdirSync(path.dirname(r3.manifest_path)).filter((f) => f.endsWith('.json'));
  assert.equal(all.length, 3);   // one immutable manifest per run
  // Candidate push effect recorded in run 2, merge effect in run 3: both confirmed, nothing pending.
  assert.deepEqual((await store.get('t39')).effects.map((e) => [e.kind, e.phase]), [['push', 'confirmed'], ['merge', 'confirmed']]);
});

// ---- GL12 --------------------------------------------------------------------------------------------

test('GL12 reopened after an upstream change: evidence, CI and approval are revalidated against the new SHA', async () => {
  const o = makeOrigin('gl12');
  const approvals = ownerApprovals();
  const green = new Set();
  const ci = { status: (sha) => (green.has(sha) ? 'success' : 'pending') };
  const w = makeController(o, { approvals, ci });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'gl12', { sha: a.sha });
  await w.controller.submit(handoff('gl12', 'feat-a', a, ['a.txt']));
  const r1 = await w.controller.runNext('demo', 'main');
  assert.equal(r1.outcome, 'ci_blocked');
  const S1 = r1.integration_sha;
  green.add(S1);
  approvals.grant('merge', S1, 'main');   // the owner approved the OLD candidate...

  // ...but main moves before the merge happens.
  fs.writeFileSync(path.join(o.seed, 'up.txt'), 'upstream\n');
  sh(o.seed, 'add', '.'); sh(o.seed, 'commit', '-q', '-m', 'upstream'); sh(o.seed, 'push', '-q', 'origin', 'main');
  const up = o.head();

  const r2 = await w.controller.runNext('demo', 'main');
  const S2 = r2.integration_sha;
  assert.notEqual(S2, S1);
  assert.equal(r2.outcome, 'ci_blocked');                 // CI green for S1 is not trusted for S2
  assert.equal(o.head(), up);
  assert.equal(parents(o, up).length, 1);
  green.add(S2);
  const r3 = await w.controller.runNext('demo', 'main');
  assert.equal(r3.outcome, 'awaiting_approval');          // approval for S1 is not an approval for S2
  assert.equal(r3.required.sha, S2);
  approvals.grant('merge', S2, 'main');
  const r4 = await w.controller.runNext('demo', 'main');
  assert.equal(r4.outcome, 'merged');
  assert.equal(o.head(), S2);
  assert.deepEqual(parents(o, S2), [up, a.sha]);
  const ev = (await w.store.get('gl12')).evidence.filter((e) => e.check_id === 'integration:unit').map((e) => e.sha);
  assert.ok(ev.includes(S1) && ev.includes(S2));          // gates re-ran on the new sha

  // A developer push after the handoff: the old handoff is stale, its evidence does not carry over.
  const o2 = makeOrigin('gl12b');
  const w2 = makeController(o2);
  const b = devBranch(o2, 'feat-b', { 'b.txt': 'b\n' });
  await readyTask(w2.store, 'gl12b', { sha: b.sha });
  await w2.controller.submit(handoff('gl12b', 'feat-b', b, ['b.txt']));
  const b2 = devBranch(o2, 'feat-b', { 'b.txt': 'b2\n' }, { from: 'feat-b' });
  await w2.store.setHead('gl12b', b2.sha, { actor: DEV });
  const before2 = o2.head();
  const rr = await w2.controller.runNext('demo', 'main');
  assert.equal(rr.outcome, 'rejected');
  assert.equal(o2.head(), before2);
  assert.match((await w2.queue.list())[0].detail.errors.join('\n'), /stale handoff/);
  // Re-handed off at the new sha: the evidence on the old sha does not carry over.
  const re = await w2.controller.submit(handoff('gl12b', 'feat-b', b2, ['b.txt']));
  assert.equal(re.ok, false);
  assert.match(re.errors.join('\n'), /missing passing evidence for required check unit on/);
  assert.match(re.errors.join('\n'), /independence: no independent approve on/);
});

// ---- verifier follow-ups (F6, F8, F10) ---------------------------------------------------------------

test('F8 a source already contained in the target short-circuits to release_verifying: no merge, no approval, no push', async () => {
  const o = makeOrigin('f8');
  const approvals = ownerApprovals();
  const w = makeController(o, { approvals });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'f8', { sha: a.sha });
  await w.controller.submit(handoff('f8', 'feat-a', a, ['a.txt']));
  sh(o.seed, 'fetch', '-q', 'origin'); sh(o.seed, 'merge', '-q', '--ff-only', a.sha); sh(o.seed, 'push', '-q', 'origin', 'main');
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'already_merged');
  assert.equal(o.head(), a.sha);
  assert.equal(approvals.calls.length, 0);
  assert.equal(await status(w.store, 'f8'), 'release_verifying');
  assert.equal((await w.queue.list())[0].state, 'merged');
});

test('F6 reconcile only touches effects this controller wrote, with a well-formed key', async () => {
  const o = makeOrigin('f6');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'f6', { sha: a.sha });
  await w.store.recordEffect('f6', { effect_id: 'someone-else:f6:merge', idempotency_key: `merge:demo:refs/heads/main:${o.head()}`, kind: 'merge', phase: 'attempted' });
  const r = await w.controller.reconcileTask('f6');
  assert.equal(r.ok, false);
  assert.deepEqual((await w.store.get('f6')).effects.map((e) => e.phase), ['attempted']);   // left for its owner, not guessed
});

test('F10 credentials in remote URLs never reach events, alerts or manifests', () => {
  assert.equal(redact('fatal: unable to access https://user:fake-token@git.example.invalid/r.git/'), 'fatal: unable to access https://***@git.example.invalid/r.git/');
  assert.equal(redact('ssh://git@git.example.invalid/r.git'), 'ssh://***@git.example.invalid/r.git');
  assert.equal(redact('/tmp/plain/path'), '/tmp/plain/path');
});
