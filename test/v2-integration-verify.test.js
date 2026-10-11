// Independent verification of the V2 Integration Agent (package 09). Adversarial: every test tries to reach a
// push/merge without one of approval-for-exact-SHA, remote CI success, a fresh fence check, or gates on the merge
// SHA, or tries to smuggle argv through handoff fields. Disposable bare remotes only; this repository's remote is
// never touched. Known defects are `todo` tests that currently pass for the wrong reason.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createIntegrationQueue } from '../orchestration/integration-queue.js';
import { createIntegrationController, createGitRunner } from '../orchestration/integration-controller.js';
import { spec, clock } from './fixtures/v2-task.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-intv-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME);
const GIT_ENV = { PATH: process.env.PATH, HOME, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-agent-2' };
const UNIT = { id: 'unit', command: ['node', 'check.js'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true };
const CHECK_JS = `console.log('ok');\n`;

const policy = (extra = {}) => ({
  schema_version: 1, project_id: 'demo', test_command: ['node', 'check.js'], protected_branches: ['main'],
  ci_gates: [{ id: 'unit', command: ['node', 'check.js'] }],
  allowlists: { commands: [['node', 'check.js']], paths: ['.'], runtimes: ['fake'], models: null },
  excluded_paths: ['.env'], protected_paths: ['.ai'], prohibited_actions: ['write_live_state'],
  approval_policy: { requires: ['merge_protected', 'push_shared'] }, ...extra,
});

let worldN = 0;
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
  const ref = (r) => { try { return sh(dir, '--git-dir', origin, 'rev-parse', `refs/heads/${r}`); } catch { return null; } };
  return { dir, origin, seed, dev, head: () => ref('main'), ref };
}

function makeController(o, { name = 'a', store, leaseDir, ci = { status: () => 'success' }, approvals = autoApprove(),
  deploys = { status: () => 'idle' }, git, repoName = 'demo', extraRepos = {} } = {}) {
  const base = path.join(o.dir, `ctl-${name}`);
  fs.mkdirSync(base, { recursive: true });
  const mirror = path.join(base, 'mirror');
  if (!fs.existsSync(mirror)) sh(base, 'clone', '-q', o.origin, mirror);
  const run = git || createGitRunner({ env: GIT_ENV });
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: leaseDir || path.join(o.dir, 'leases') }), alert: () => {} });
  const wts = createWorktrees({ git: run, root: path.join(base, 'wt'), repoAllowlist: [mirror], leases });
  const queue = createIntegrationQueue({ dir: path.join(base, 'queue') });
  const st = store || createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const alerts = [];
  const controller = createIntegrationController({
    store: st, leases, worktrees: wts, git: run, ci, approvals, deploys, queue, owner: `integrator-${name}`,
    repos: { [repoName]: { dir: mirror, remote: o.origin }, ...extraRepos },
    alert: (a) => alerts.push(a), manifestDir: path.join(base, 'manifests'), artifactsDir: path.join(base, 'artifacts'),
  });
  return { controller, store: st, queue, leases, mirror, alerts, base };
}
function autoApprove(extra = {}) {
  const calls = [];
  return { calls, check: (req) => { calls.push(req); return { ok: true, approval_ref: `appr-${req.action}`, sha: req.sha, action: req.action, target: req.target, repo: req.repo, approved_by: 'owner-test', ...extra }; } };
}
function devBranch(o, branch, files, { from = 'origin/main' } = {}) {
  sh(o.dev, 'fetch', '-q', 'origin');
  sh(o.dev, 'checkout', '-q', '-B', branch, from);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(o.dev, f), c);
  sh(o.dev, 'add', '.'); sh(o.dev, 'commit', '-q', '-m', `work on ${branch}`);
  sh(o.dev, 'push', '-q', '-f', 'origin', branch);
  return { sha: sh(o.dev, 'rev-parse', 'HEAD'), base: sh(o.dev, 'rev-parse', from) };
}
async function readyTask(store, id, { sha, scope = ['.'], verdict = true, evidence = true } = {}) {
  await store.createTask(spec({ task_id: id, scope: { paths: scope }, acceptance_checks: [UNIT], base_sha: sha }));
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating']) await store.transition(id, s, { actor: 'controller' });
  await store.setHead(id, sha, { actor: DEV });
  if (evidence) await store.recordEvidence(id, { check_id: 'unit', sha, command: UNIT.command, exit: 0, duration_ms: 10, artifact: null, actor: 'runner' });
  if (verdict) await store.recordVerdict(id, { sha, actor: VERIFIER, verdict: 'approve', findings: [] });
}
const handoff = (id, branch, b, diff_scope, over = {}) => ({ task_id: id, repo: 'demo', target: 'main', source_branch: branch, source_sha: b.sha,
  base_sha: b.base, developer: DEV, diff_scope, ...over });
const status = async (store, id) => (await store.get(id)).status;

// Records every git argv; optional hooks run before/instead of a command.
function spyGit({ before = () => {}, instead = () => undefined } = {}) {
  const real = createGitRunner({ env: GIT_ENV });
  const log = [];
  const git = async (args, o) => {
    log.push(args);
    await before(args, o);
    const r = await instead(args, o, real);
    return r === undefined ? real(args, o) : r;
  };
  return { git, log, pushes: () => log.filter((a) => a[0] === 'push') };
}

// ---- handoff-field argv / transport probes ------------------------------------------------------------

test('argv-shaped handoff fields never reach git: branch, target, repo, task id and source_repo are rejected first', async () => {
  const o = makeOrigin('argv');
  const marker = path.join(tmp, `argv-marker-${Date.now()}`);
  const g = spyGit();
  const w = makeController(o, { git: g.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'argv', { sha: a.sha });
  const bad = [
    { source_branch: `--upload-pack=touch ${marker}` }, { source_branch: '-x' }, { source_branch: 'a..b' }, { source_branch: 'a//b' },
    { target: '--force' }, { target: 'main:evil' }, { target: '+main' }, { target: 'a b' },
    { repo: '../demo' }, { repo: 'demo; rm -rf x' },
    { source_repo: `--upload-pack=touch ${marker}` }, { source_repo: '' },
    { source_sha: 'HEAD' }, { source_sha: `${a.sha} --force` }, { base_sha: 'main' },
    { task_id: '' }, { developer: { role: 'developer' } },
    { diff_scope: [''] }, { diff_scope: 'a.txt' },
  ];
  for (const over of bad) {
    const n = g.log.length;
    const r = await w.controller.submit(handoff('argv', 'feat-a', a, ['a.txt'], over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.code, 'E_HANDOFF_INVALID');
    assert.equal(g.log.length, n, `${JSON.stringify(over)}: no git call at all`);
  }
  // Transport tricks in source_repo: git itself must refuse the `ext::` helper; nothing executes.
  const r = await w.controller.submit(handoff('argv', 'feat-a', a, ['a.txt'], { source_repo: `ext::sh -c "touch ${marker}"` }));
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(marker), false, 'no command executed through a transport helper');
  // Every git argv so far: no element is a bare option besides the ones the controller itself spells.
  const OWN = new Set(['--no-tags', '--quiet', '--porcelain', '--is-ancestor', '--name-only', '--no-renames', '--porcelain=v1', '--untracked-files=no', '--no-ff', '--no-edit', '--abort', '--diff-filter=U', '-c', '-m', '-b']);
  for (const args of g.log) for (const x of args.slice(1)) if (x.startsWith('-')) assert.ok(OWN.has(x) || x.startsWith('--force-with-lease='), `unexpected option in argv: ${x}`);
  assert.equal(o.head(), a.base);
});

test('task ids that would break ref syntax are refused, never pushed, and do not crash the run', async () => {
  const o = makeOrigin('taskid');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  // The store refuses ids with refspec/argv metacharacters outright...
  for (const id of ['x:y', 'sp ace', 'x~1', '-dash', 'a/b', '.hidden']) await assert.rejects(readyTask(w.store, id, { sha: a.sha }), { code: 'E_INVALID_TASK' });
  // ...and ids the store accepts but git ref syntax does not are refused by validation, without an unhandled throw.
  for (const id of ['a..b', 'end.lock']) {
    await readyTask(w.store, id, { sha: a.sha });
    const r = await w.controller.submit(handoff(id, 'feat-a', a, ['a.txt']));
    assert.equal(r.ok, false, id);
    assert.equal(r.code, 'E_HANDOFF_INVALID');
  }
  assert.equal(o.head(), a.base);
});

test('non-main target uses the D-008 lease repo:<r>:branch:<name> and merges only that branch', async () => {
  const o = makeOrigin('target');
  sh(o.seed, 'push', '-q', 'origin', 'main:develop');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'tgt', { sha: a.sha });
  const r = await w.controller.submit(handoff('tgt', 'feat-a', a, ['a.txt'], { target: 'develop' }));
  assert.equal(r.ok, true);
  const run = await w.controller.runNext('demo', 'develop');
  assert.equal(run.outcome, 'merged');
  assert.equal(o.ref('develop'), run.integration_sha);
  assert.equal(o.head(), a.base, 'main untouched');
  assert.deepEqual(run.manifest.leases.map((l) => l.resource), ['repo:demo:branch:develop', 'repo:demo:integration']);
  assert.deepEqual(run.manifest.approvals.map((x) => [x.action, x.target]), [['merge', 'develop']]);
});

// ---- the push itself ----------------------------------------------------------------------------------

test('the only remote mutation is a compare-and-swap push bound to the observed target sha; never --force', async () => {
  const o = makeOrigin('cas');
  const g = spyGit();
  const w = makeController(o, { git: g.git });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'cas', { sha: a.sha });
  await w.controller.submit(handoff('cas', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  const pushes = g.pushes();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], ['push', '--porcelain', `--force-with-lease=refs/heads/main:${before}`, o.origin, `${r.integration_sha}:refs/heads/main`]);
  assert.ok(!g.log.some((a) => a.includes('--force') || a.includes('-f') || a.some((x) => x.startsWith('+') && x.endsWith(':refs/heads/main'))));
  // Order right before the push: fence validation (reads the lease file) happened after the last CI query.
  const i = g.log.indexOf(pushes[0]);
  assert.equal(g.log[i + 1][0], 'ls-remote', 'remote re-read right after the push');
});

test('push answer lost while someone else landed a DIFFERENT commit: effect failed, never confirmed; rebuilt on the new target', async () => {
  const o = makeOrigin('foreign');
  let foreign = null;
  const g = spyGit({ instead: async (args) => {
    if (args[0] === 'push' && args.at(-1).endsWith(':refs/heads/main') && !foreign) {
      // Instead of ours, an unrelated commit lands on main and our push response is lost.
      fs.writeFileSync(path.join(o.seed, 'up.txt'), 'upstream\n');
      sh(o.seed, 'add', '.'); sh(o.seed, 'commit', '-q', '-m', 'foreign'); sh(o.seed, 'push', '-q', 'origin', 'main');
      foreign = sh(o.seed, 'rev-parse', 'HEAD');
      throw Object.assign(new Error('git push timed out'), { code: 'E_TIMEOUT' });
    }
  } });
  const w = makeController(o, { git: g.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'fo', { sha: a.sha });
  await w.controller.submit(handoff('fo', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'merged');
  const [r0, r1] = r.manifest.rounds;
  assert.match(r0.invalidated, /CAS rejected|moved/);
  assert.equal(r.manifest.effects[0].phase, 'failed');   // our sha was NOT on the remote: not confirmed
  assert.equal(r.manifest.effects[0].sha, r0.integration_sha);
  assert.equal(r1.target_sha, foreign);
  assert.deepEqual(sh(o.dir, '--git-dir', o.origin, 'rev-list', '--parents', '-n', '1', o.head()).split(' ').slice(1), [foreign, a.sha]);
  const eff = (await w.store.get('fo')).effects;
  assert.deepEqual(eff.map((e) => e.phase), ['failed', 'confirmed']);
  assert.equal(g.pushes().length, 2);
});

test('store write fails right after the push landed: nothing claims success, no second push, reconciled from the remote', async () => {
  const o = makeOrigin('crash');
  const store = createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const real = store.recordEffect;
  let boom = true;
  store.recordEffect = async (id, e) => { if (boom && e.phase === 'confirmed') { boom = false; throw new Error('disk full'); } return real(id, e); };
  const g = spyGit();
  const w = makeController(o, { store, git: g.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(store, 'cr', { sha: a.sha });
  await w.controller.submit(handoff('cr', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.notEqual(r.outcome, 'merged');
  assert.equal(r.outcome, 'unknown_external_effect');
  assert.equal(await status(store, 'cr'), 'unknown_external_effect');
  assert.equal((await w.queue.list())[0].state, 'unknown');
  const r2 = await w.controller.runNext('demo', 'main');
  assert.equal(r2.outcome, 'reconciled');
  assert.equal(g.pushes().length, 1);
  assert.equal(await status(store, 'cr'), 'release_verifying');
  assert.deepEqual((await store.get('cr')).effects.map((e) => e.phase), ['confirmed']);
});

test('fence re-checked after the approval: a lease taken over during the approval call stops the push', async () => {
  const o = makeOrigin('fence');
  const leaseDir = path.join(o.dir, 'leases');
  const w = makeController(o, { leaseDir, approvals: { check: async (req) => {
    // While the owner is being asked, our lease is cleared and re-acquired by somebody else.
    const f = path.join(leaseDir, `${encodeURIComponent('repo:demo:main')}.lease.json`);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    rec.holder = null; fs.writeFileSync(f, JSON.stringify(rec));
    const other = createLeaseAuthority({ backend: fileBackend({ dir: leaseDir }) });
    assert.equal((await other.acquire('repo:demo:main', { owner: 'intruder', ttl_ms: 60_000 })).ok, true);
    return { ok: true, approval_ref: 'x', sha: req.sha, action: req.action, target: req.target, repo: req.repo };
  } } });
  const before = o.head();
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'fe', { sha: a.sha });
  await w.controller.submit(handoff('fe', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'lease_lost');
  assert.equal(o.head(), before);
  assert.deepEqual((await w.store.get('fe')).effects.map((e) => e.phase), ['failed']);
});

test('leases are released even when the run throws, and an active deploy blocks before any lease', async () => {
  const o = makeOrigin('release');
  const store = createTaskStore({ dir: path.join(o.dir, 'state', 'v2'), ...clock() });
  const real = store.recordEvidence;
  store.recordEvidence = async (id, e) => { if (String(e.check_id).startsWith('integration:')) throw new Error('ledger offline'); return real(id, e); };
  const w = makeController(o, { store });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(store, 'rl', { sha: a.sha });
  await w.controller.submit(handoff('rl', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'error');
  assert.equal(o.head(), a.base);
  for (const res of ['repo:demo:integration', 'repo:demo:main']) {
    const got = await w.leases.acquire(res, { owner: 'probe', ttl_ms: 1000 });
    assert.equal(got.ok, true, `${res} released after the throw`);
    await w.leases.release(got.lease);
  }
  const o2 = makeOrigin('deploy-active');
  const w2 = makeController(o2, { deploys: { status: () => 'active' } });
  const b = devBranch(o2, 'feat-b', { 'b.txt': 'b\n' });
  await readyTask(w2.store, 'da', { sha: b.sha });
  await w2.controller.submit(handoff('da', 'feat-b', b, ['b.txt']));
  const r2 = await w2.controller.runNext('demo', 'main');
  assert.equal(r2.outcome, 'blocked');
  assert.equal(r2.reason, 'deploy_in_progress');
  assert.equal(o2.head(), b.base);
  assert.equal(fs.existsSync(path.join(o2.dir, 'leases', `${encodeURIComponent('repo:demo:main')}.lease.json`)), false, 'no lease touched');
});

test('approval replies that are malformed do not count: missing ref, ok without fields, sha of another object', async () => {
  const cases = [
    ['no approval_ref', { approval_ref: '' }],
    ['ref not a string', { approval_ref: 42 }],
    ['sha mismatch', { sha: '0'.repeat(40) }],
    ['action mismatch', { action: 'push' }],
    ['target mismatch', { target: 'develop' }],
  ];
  for (const [label, over] of cases) {
    const o = makeOrigin('appr');
    const w = makeController(o, { approvals: autoApprove(over) });
    const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
    await readyTask(w.store, 'ap', { sha: a.sha });
    await w.controller.submit(handoff('ap', 'feat-a', a, ['a.txt']));
    const r = await w.controller.runNext('demo', 'main');
    assert.equal(r.outcome, 'awaiting_approval', label);
    assert.equal(o.head(), a.base, label);
  }
});

// ---- defects ------------------------------------------------------------------------------------------

test('independence is judged from the store, not from the handoff: a developer cannot rename itself out of the way', async () => {
  const o = makeOrigin('selfappr');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  // dev-agent-1 set the head AND is the only "verifier" of it.
  await readyTask(w.store, 'self', { sha: a.sha, verdict: false });
  await w.store.recordVerdict('self', { sha: a.sha, actor: { role: 'verifier', id: 'dev-agent-1' }, verdict: 'approve', findings: [] });
  const r = await w.controller.submit(handoff('self', 'feat-a', a, ['a.txt'], { developer: { role: 'developer', id: 'somebody-else' } }));
  assert.equal(r.ok, false, 'self-approval must not count whatever the handoff claims');
  assert.equal(o.head(), a.base);
});

test('policy excluded_paths and path allowlist apply to the integrated diff', async () => {
  const o = makeOrigin('excluded');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { '.env': 'TOKEN=fake-not-real\n' });
  await readyTask(w.store, 'ex', { sha: a.sha });
  await w.controller.submit(handoff('ex', 'feat-a', a, ['.env']));
  const r = await w.controller.runNext('demo', 'main');
  assert.notEqual(r.outcome, 'merged');
  assert.equal(o.head(), a.base, '.env must never reach the shared branch');
});

test('a transient git failure during in-run validation is retryable, not a final rejection pinned by the idempotency key', async () => {
  const o = makeOrigin('transient');
  let down = false;
  const g = spyGit({ before: (args) => { if (down && args[0] === 'fetch') throw Object.assign(new Error('could not read from remote'), { code: 'E_GIT' }); } });
  const w = makeController(o, { git: g.git });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'tr', { sha: a.sha });
  const s1 = await w.controller.submit(handoff('tr', 'feat-a', a, ['a.txt']));
  assert.equal(s1.ok, true);
  down = true;
  const r = await w.controller.runNext('demo', 'main');
  assert.notEqual(r.outcome, 'merged');
  down = false;
  const item = (await w.queue.list())[0];
  assert.notEqual(item.state, 'rejected', 'a network blip is not a verdict on the handoff');
  const s2 = await w.controller.submit(handoff('tr', 'feat-a', a, ['a.txt']));
  assert.equal(s2.ok, true);
  assert.notEqual((await w.controller.runNext('demo', 'main')).outcome, 'empty', 'the handoff must be integrable again');
});

test('a source branch deleted after the handoff is a final rejection, not retried forever', async () => {
  const o = makeOrigin('deleted-src');
  const gone = spyGit({ before: (args) => { if (args[0] === 'fetch' && args.some((a) => String(a).includes('feat-gone'))) throw Object.assign(new Error("fatal: couldn't find remote ref refs/heads/feat-gone"), { code: 'E_GIT' }); } });
  const w = makeController(o, { git: gone.git });
  const a = devBranch(o, 'feat-gone', { 'g.txt': 'g\n' });
  await readyTask(w.store, 'gone', { sha: a.sha });
  const s = await w.controller.submit(handoff('gone', 'feat-gone', a, ['g.txt']));
  assert.notEqual(s.code, 'E_RETRYABLE');
  assert.equal(s.ok, false);
});

test('two queue instances over one directory cannot both claim the same item', async () => {
  const dir = path.join(tmp, 'queue-shared');
  const qa = createIntegrationQueue({ dir });
  const a = await qa.enqueue({ task_id: 't', repo: 'demo', target: 'main' });
  const qb = createIntegrationQueue({ dir });
  await qb.init();
  await qa.start([a.item_id], { owner: 'A' });
  await assert.rejects(qb.start([a.item_id], { owner: 'B' }), /E_BUSY|E_ILLEGAL_TRANSITION/);
});

test('an approval is bound to the repository as well', async () => {
  const o = makeOrigin('repo-bind');
  const w = makeController(o, { approvals: autoApprove({ repo: 'another-repo' }) });
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'rb', { sha: a.sha });
  await w.controller.submit(handoff('rb', 'feat-a', a, ['a.txt']));
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'awaiting_approval');
  assert.equal(o.head(), a.base);
});

// ---- F3 closure (9515250): missing refs are final, and a final rejection does not strand the handoff ------

test('F3 closure: a really deleted source branch is rejected once; re-pushed, the same handoff resubmits and merges', async () => {
  const o = makeOrigin('f3real');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'f3r', { sha: a.sha });
  await w.controller.submit(handoff('f3r', 'feat-a', a, ['a.txt']));
  sh(o.dev, 'push', '-q', 'origin', '--delete', 'feat-a');
  const r = await w.controller.runNext('demo', 'main');
  assert.equal(r.outcome, 'rejected');
  const item = (await w.queue.list())[0];
  assert.equal(item.state, 'rejected');
  assert.match(item.detail.errors.join('\n'), /couldn't find remote ref/);
  assert.equal(item.attempts, 1);
  assert.equal((await w.controller.runNext('demo', 'main')).outcome, 'empty');   // not retried
  // A missing target branch is final too, and never retried.
  const s0 = await w.controller.submit(handoff('f3r', 'feat-a', a, ['a.txt'], { target: 'nope' }));
  assert.equal(s0.code, 'E_HANDOFF_INVALID');
  // The developer restores the branch: the same (task, sha, target) is accepted again and integrates.
  sh(o.dev, 'push', '-q', 'origin', 'feat-a');
  const s = await w.controller.submit(handoff('f3r', 'feat-a', a, ['a.txt']));
  assert.equal(s.ok, true);
  assert.notEqual(s.item.item_id, item.item_id);
  assert.equal((await w.controller.runNext('demo', 'main')).outcome, 'merged');
  assert.equal(await status(w.store, 'f3r'), 'release_verifying');
});

test('F3 residual: a well-formed but non-existent base_sha is a final rejection, not E_RETRYABLE forever', async () => {
  const o = makeOrigin('f3bogus');
  const w = makeController(o);
  const a = devBranch(o, 'feat-a', { 'a.txt': 'a\n' });
  await readyTask(w.store, 'f3b', { sha: a.sha });
  const s = await w.controller.submit(handoff('f3b', 'feat-a', a, ['a.txt'], { base_sha: 'f'.repeat(40) }));
  assert.equal(s.ok, false);
  assert.equal(s.code, 'E_HANDOFF_INVALID');
});
