// Round 5: the first live V2 defect (2026-10-14), replayed with fake runtimes through the real goal loop. A docs task: the
// cheap developer's run 1 commits the edit and then hits its run limit; the project check runs out of its time limit
// (unknown exit); run 2 correctly changes nothing; the task ended waiting/no_progress. Fixed: per-class checks (docs),
// the check time limit from .ai/project.json, an evidence timeout suspends instead of looking like a code failure, a
// timed-out run that committed is evaluated on its commit, and a no-change run on an unmeasured or passing head goes to
// evaluation. Injected clock (a run's limit is simulated 1000x shorter), synthetic data only.
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
import { createIntake, buildTaskSpec } from '../orchestration/intake.js';
import { validatePolicy } from '../orchestration/policy.js';
import { validateTask } from '../orchestration/task-contract.js';
import { checkMarkdown } from '../scripts/docs-check.js';
import { decide as runIfChanged, globRe } from '../scripts/run-if-changed.js';
import { clock } from './fixtures/v2-task.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-r5-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const git = (args, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));

// A check that needs about 1 s: it runs out of a 300 ms limit and passes under a 10 s one.
const SLOW_CHECK = { id: 'project-tests', command: ['node', '-e', 'setTimeout(() => process.exit(0), 1000)'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true };
const POLICY = { schema_version: 1, project_id: 'fixture-project', test_command: SLOW_CHECK.command,
  allowlists: { commands: [['node']], paths: ['docs', 'src'], runtimes: null, models: null }, protected_paths: ['.ai'], approval_policy: { requires: [] } };

let repos = 0;
function mkRepo(policy) {
  const dir = path.join(TMP, `repo${++repos}`);
  for (const d of ['docs', 'src', '.ai']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.name', 'Test User'); sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'docs', 'USAGE.md'), '# Usage\n\nThe dashboard lists sessions.\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, '.ai', 'project.json'), JSON.stringify(policy, null, 1));
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const setPolicy = (repo, policy) => { fs.writeFileSync(path.join(repo, '.ai', 'project.json'), JSON.stringify(policy, null, 1)); sh(repo, 'commit', '-qam', 'policy'); };

const USAGE = { op: 'usage', input_tokens: 1000, output_tokens: 200 };
const EDIT = { op: 'write', path: 'docs/USAGE.md', content: '# Usage\n\nThe dashboard lists sessions. The V2 tasks view is in the More menu.\n' };
const EDIT_THEN_HANG = [EDIT, USAGE, { op: 'hang' }];     // run 1 of the live task: edit made, then the run limit
const NO_CHANGE = [USAGE];                                 // run 2 of the live task: the work is already there
const BAD_THEN_HANG = [{ op: 'write', path: 'docs/USAGE.md', content: '# Usage\n\n```\nunclosed\n' }, USAGE, { op: 'hang' }];
const HANG = [USAGE, { op: 'hang' }];
const say = (o) => ({ op: 'emit', event: { type: 'result', text: `Done.\n${JSON.stringify(o)}` } });
const APPROVE = [say({ verdict: 'approve', findings: [] })];
const REJECT = [say({ verdict: 'reject', impossible: false, findings: [{ id: 'meets_goal', severity: 'major', message: 'say where the More menu is' }] })];
const ACHIEVABLE = [say({ verdict: 'reject', impossible: false, findings: [{ id: 'meets_goal', severity: 'blocker', message: 'fence the code block' }] })];

const caps = ['text', 'code', 'tools', 'resume', 'cancel'];
const M = (model, tier, o = {}) => ({ runtime: 'fake', provider: 'fake', model, tier, capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 1, test_only: true, ...o });
// The live routing default for a cheap model on docs: a 120 s leash, two stalls to no-progress.
const LEASH = { docs: { timeout_ms: 120000, max_steps: 40, effort: 'low', stall_runs_to_no_progress: 2 } };
const LADDER = [M('cheap', 'light', { billing: 'subscription', run_limits: LEASH }), M('rev', 'strong', { price: { input: 40, output: 200 }, price_as_of: '2026-10-10' })];

let worlds = 0;
// dev: scripts per developer run (last repeats); rev: scripts per review; checkMs: the verifier's own default limit;
// onDevStart(i): test hook at each developer start.
function world({ dev = [EDIT_THEN_HANG], rev = [APPROVE], policy = POLICY, checkMs = 300, onDevStart = () => {} } = {}) {
  const w = ++worlds;
  const repo = mkRepo(policy);
  const base = path.join(TMP, `w${w}`);
  const wtRoot = path.join(base, 'wt'), reviewRoot = path.join(base, 'review');
  for (const d of [wtRoot, reviewRoot, path.join(base, 'vtmp')]) fs.mkdirSync(d, { recursive: true });
  let t = Date.parse('2026-10-14T11:40:00Z');
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const real0 = Date.now();
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now: () => Date.parse('2026-10-14T11:40:00Z') + (Date.now() - real0) });
  const worktrees = createWorktrees({ root: wtRoot, repoAllowlist: [repo], leases, git });
  const devA = fakeAdapter({ allowedRoots: [wtRoot] });
  const revA = fakeAdapter({ allowedRoots: [reviewRoot] });
  const log = { dev: [], rev: [] };
  const pick = (list, i) => list[Math.min(i, list.length - 1)];
  const ad = {
    id: 'fake', provider_ids: ['fake'], limitSupport: { max_steps: true, context_mode: true, effort: true },
    probeCapabilities: async () => ({ available: true, version: 'fake-1', models: LADDER.map((m) => m.model), efforts: ['low', 'medium', 'high'], features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } }),
    start(o) {
      const isRev = o.role !== 'developer';
      (isRev ? log.rev : log.dev).push(o);
      if (!isRev) onDevStart(log.dev.length - 1);
      const script = isRev ? pick(rev, log.rev.length - 1) : pick(dev, log.dev.length - 1);
      const run = (isRev ? revA : devA).start({ ...o, script, timeout_ms: o.timeout_ms ? Math.max(30, Math.round(o.timeout_ms / 1000)) : undefined });
      run.done.then((r) => { if (r.timed_out) t += o.timeout_ms; });
      return run;
    },
    observe: (r) => devA.observe(r), cancel: (r) => devA.cancel(r), collectUsage: (r) => devA.collectUsage(r), normalizeError: (e) => devA.normalizeError(e),
    resume() { throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }); },
  };
  const storeDir = path.join(base, 'state', 'v2');
  const store = createTaskStore({ dir: storeDir, ...clock() });
  const loop = createGoalLoop({ store, registry: createRegistry({ version: 1, as_of: '2026-10-11', models: LADDER }), adapters: { fake: ad }, worktrees, worktreeRoot: fs.realpathSync(wtRoot),
    verifier: createVerifier({ tmpRoot: path.join(base, 'vtmp'), artifactRoot: path.join(base, 'artifacts'), timeoutMs: checkMs }), reviewRoot,
    leases, git, allowFake: true, now, sleep, runTimeoutMs: 30 * 60_000 });
  const intake = createIntake({ store });
  const env = { log, store, loop, now, repo };
  // The live task's shape: docs class, checks defaulted by intake from the project policy.
  env.submit = async (over = {}) => (await intake.createTask({ title: 'live smoke: docs typo', task_class: 'docs', repository: repo, risk_class: 'low',
    goal: 'In docs/USAGE.md, add one sentence at the end of the first paragraph saying that the V2 tasks view is in the More menu. Change nothing else.', ...over },
  { source: 'api', actor_id: 'api-client' })).task;
  env.events = (id) => fs.readFileSync(path.join(storeDir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return env;
}
const D = (v, kind) => v.decisions.filter((d) => d.loop && (!kind || d.kind === kind));
const stallStop = (v) => D(v, 'no_progress').some((d) => /stalled developer run/.test(d.loop.patch.wait?.diagnosis ?? ''));

test('live sequence: run 1 commits then times out, the check runs out of time -> check_timeout wait (no repair, no stall); a raised limit verifies the same SHA -> accepted', async () => {
  const env = world({ dev: [EDIT_THEN_HANG, NO_CHANGE] });
  const task = await env.submit();
  const r1 = await env.loop.run(task.task_id);
  assert.equal(r1.state, 'waiting');
  let v = await env.store.get(task.task_id);
  // run 1 was evaluated on its commit, not counted as a stall
  const rt = D(v, 'run_timeout');
  assert.equal(rt.length, 1);
  assert.equal(rt[0].chosen, 'evaluate the committed change');
  assert.deepEqual(rt[0].loop.patch, { stall_pending: `${task.task_id}.run1` });
  // the check timeout is not a code failure: no repair decision, no developer run 2, no stall, a clear diagnosis
  const ct = D(v, 'check_timeout');
  assert.equal(ct.length, 1);
  assert.equal(ct[0].loop.patch.wait.reason, 'check_timeout');
  assert.equal(ct[0].loop.patch.wait.until_ms, null);
  assert.equal(ct[0].loop.patch.verify_only, true);
  assert.match(ct[0].loop.patch.wait.diagnosis, /project-tests \(verifier default\) ran out of time on [0-9a-f]{12}: no result, which is not a failure of the change/);
  assert.match(ct[0].loop.patch.wait.next_action, /checks\.timeout_ms in \.ai\/project\.json/);
  assert.equal(D(v, 'repair').length, 0);
  assert.equal(D(v, 'no_progress').length, 0);
  assert.equal(env.log.dev.length, 1);
  assert.ok(env.events(task.task_id).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'check_timeout'));
  const head = v.head_sha;
  assert.equal(v.evidence.length, 1);
  assert.equal(v.evidence[0].exit, null);
  // stays put: no timer resumes it
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  assert.equal(env.log.dev.length, 1);
  // the owner raises the project check limit (the fix's config knob): the same SHA is verified, no developer run
  setPolicy(env.repo, { ...POLICY, checks: { timeout_ms: 10_000 } });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 1, 'no developer run after the timeout');
  assert.equal(v.head_sha, head);
  const ev = v.evidence.filter((e) => e.sha === head);
  assert.deepEqual(ev.map((e) => e.exit), [null, 0], 'the timed-out run is rerun under a new evidence index, never reused');
  assert.equal(new Set(env.events(task.task_id).filter((e) => e.kind === 'evidence.recorded').map((e) => e.event_id)).size, 2);
  assert.equal(stallStop(v), false);
});

test('run 1 commits then times out; the check has no exit code (spawn failure); run 2 changes nothing -> evaluated, not a stall -> accepted', async () => {
  // The check's program appears only when run 2 starts: run 1's evaluation has no exit code, run 2's re-evaluation has.
  const bin = path.join(TMP, `late-check-${worlds + 1}`);
  const policy = { ...POLICY, allowlists: { ...POLICY.allowlists, commands: [['node'], [bin]] } };
  const env = world({ dev: [EDIT_THEN_HANG, NO_CHANGE], policy, checkMs: 10_000,
    onDevStart: (i) => { if (i === 1) { fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(bin, 0o755); } } });
  const task = await env.submit({ acceptance_checks: [{ ...SLOW_CHECK, command: [bin] }] });
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 2);
  const nc = D(v, 'run_no_change');
  assert.equal(nc.length, 1);
  assert.equal(nc[0].chosen, 'evaluate the head');
  assert.ok(nc[0].evidence.some((x) => /unchanged, its checks: unevaluated/.test(x)));
  assert.deepEqual(nc[0].loop.patch, { stall_pending: `${task.task_id}.run2` });
  assert.equal(stallStop(v), false);
  assert.deepEqual(v.evidence.map((e) => e.exit), [null, 0]);
});

test('run 1 commits then times out on passing checks; the reviewer rejects; no-change runs on that rejected head are stalls (run 1 is not)', async () => {
  const env = world({ dev: [EDIT_THEN_HANG, NO_CHANGE], rev: [REJECT], policy: { ...POLICY, checks: { timeout_ms: 10_000 } } });
  const task = await env.submit({ acceptance_checks: [SLOW_CHECK] });
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(D(v, 'run_timeout')[0].chosen, 'evaluate the committed change');
  // a rejected head is not "passing": runs 2 and 3 changed nothing on it and are the two stalls; the timed-out run 1,
  // whose commit passed its checks, is not one (before the fix the task stopped after run 2)
  assert.equal(env.log.dev.length, 3);
  assert.deepEqual(D(v, 'run_no_change').map((d) => d.chosen), ['count it as a stalled run', 'count it as a stalled run']);
  assert.ok(stallStop(v));
  assert.match(D(v, 'no_progress').at(-1).loop.patch.wait.diagnosis, /^2 stalled developer run\(s\)/);
});

test('a timed-out run whose commit passes and is approved is accepted after ONE run (the clock is not a verdict)', async () => {
  const env = world({ dev: [EDIT_THEN_HANG], policy: { ...POLICY, checks: { timeout_ms: 10_000 } } });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 1);
  assert.equal(D(v, 'run_timeout')[0].chosen, 'evaluate the committed change');
});

test('D-024 kept: a timed-out run whose commit fails its checks counts as a stall; a no-change run on that failing head is the second -> no_progress', async () => {
  const docs = [{ id: 'docs-check', command: ['node', path.join(ROOT, 'scripts', 'docs-check.js')], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }];
  const env = world({ dev: [BAD_THEN_HANG, HANG], rev: [ACHIEVABLE], policy: { ...POLICY, checks: { timeout_ms: 10_000, by_task_class: { docs } } } });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'waiting');
  const v = await env.store.get(task.task_id);
  assert.equal(env.log.dev.length, 2);
  const rt = D(v, 'run_timeout');
  assert.equal(rt[0].chosen, 'evaluate the committed change');
  assert.equal(rt[1].chosen, 'check what the run left, as an attempt');
  assert.ok(stallStop(v), 'stopped by the stalled-run rule');
  assert.match(D(v, 'no_progress').at(-1).loop.patch.wait.diagnosis, /2 stalled developer run\(s\) on fake:cheap/);
  assert.equal(v.evidence[0].exit, 1);
});

test('docs class: intake takes the project\'s docs checks; the docs check passes a docs-only change and the suite is skipped (exit 0, logged)', async () => {
  const checks = JSON.parse(fs.readFileSync(path.join(ROOT, '.ai', 'project.json'), 'utf8')).checks;
  assert.deepEqual(validatePolicy({ ...POLICY, checks }), []);
  assert.ok(checks.timeout_ms >= 300_000, 'fits the measured suite (about 136 s on the live host) with margin');
  const { spec } = buildTaskSpec({ goal: 'g', task_class: 'docs', base_sha: 'a'.repeat(40) }, { source: 'api', actor_id: 'x', policy: { ...POLICY, checks } });
  assert.deepEqual(spec.acceptance_checks.map((c) => c.id), ['docs-check', 'docs-links', 'project-tests-if-code']);
  assert.deepEqual(spec.definition_of_done.slice(0, 3), ['docs-check passes on the candidate SHA', 'docs-links passes on the candidate SHA', 'project-tests-if-code passes on the candidate SHA']);
  // other classes (and no class) keep the project suite
  for (const task_class of ['code', undefined]) {
    const s2 = buildTaskSpec({ goal: 'g', task_class, base_sha: 'a'.repeat(40) }, { source: 'api', actor_id: 'x', policy: { ...POLICY, checks } }).spec;
    assert.deepEqual(s2.acceptance_checks.map((c) => c.id), ['project-tests']);
  }
  // the real scripts, end to end in a scratch repo with the env the verifier sets
  const repo = mkRepo(POLICY);
  fs.mkdirSync(path.join(repo, 'scripts'));
  for (const f of ['docs-check.js', 'run-if-changed.js']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(repo, 'scripts', f));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'scripts');
  const baseSha = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'docs', 'USAGE.md'), '# Usage\n\nSee [the readme](../README.md) and [nowhere](missing.md).\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'docs');
  const run = (argv) => { try { return { code: 0, out: execFileSync('node', argv, { cwd: repo, encoding: 'utf8', env: { ...GIT_ENV, V2_BASE_SHA: baseSha } }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
  let r = run(['scripts/docs-check.js']);
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/USAGE\.md:3: broken link \.\.\/README\.md/);
  assert.match(r.out, /broken link missing\.md/);
  fs.writeFileSync(path.join(repo, 'docs', 'USAGE.md'), '# Usage\n\nThe V2 tasks view is in the More menu.\n');
  sh(repo, 'commit', '-qam', 'fix');
  assert.equal(run(['scripts/docs-check.js']).code, 0);
  const marker = path.join(TMP, `suite-ran-${worlds}`);
  const suite = ['scripts/run-if-changed.js', '--except', '*.md', '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  r = run(suite);
  assert.equal(r.code, 0);
  assert.match(r.out, /skipped node -e .*: all \d+ changed path\(s\) match \*\.md/);
  assert.equal(fs.existsSync(marker), false);
  // a docs task that touches code runs the suite after all
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 2;\n');
  sh(repo, 'commit', '-qam', 'code');
  r = run(suite);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(marker), true);
});

test('docs-check and run-if-changed units: fences, links, anchors-only, conflict markers, globs, unknown base never skips', () => {
  const exists = (p) => ['README.md', 'docs/USAGE.md', 'docs/img/a.png'].includes(p);
  assert.deepEqual(checkMarkdown('[a](../README.md) [b](USAGE.md#x) [c](https://example.invalid) [d](#top) ![i](img/a.png) `[e](nope.md)`\n', 'docs/X.md', exists), []);
  assert.deepEqual(checkMarkdown('```\n[a](nope.md)\n```\n', 'README.md', exists), []);
  assert.deepEqual(checkMarkdown('text\n```js\ncode\n', 'README.md', exists), ['README.md:2: code fence ``` never closed']);
  assert.deepEqual(checkMarkdown('<<<<<<< HEAD\n', 'README.md', exists), ['README.md:1: merge-conflict marker']);
  assert.deepEqual(checkMarkdown('[a](docs/none.md)\n', 'README.md', exists), ['README.md:1: broken link docs/none.md']);
  assert.ok(globRe('*.md').test('docs/v2/A.md'));
  assert.ok(!globRe('*.md').test('src/a.mdx'));
  assert.ok(globRe('docs/**').test('docs/a/b.png'));
  assert.ok(!globRe('docs/**').test('src/docs/a'));
  assert.equal(runIfChanged(null, ['*.md']).run, true);
  assert.equal(runIfChanged([], ['*.md']).run, true);
  assert.equal(runIfChanged(['docs/USAGE.md', 'README.md'], ['*.md']).run, false);
  assert.deepEqual(runIfChanged(['docs/USAGE.md', 'src/a.js'], ['*.md']).outside, ['src/a.js']);
});

test('check time limits are validated (task checks and project policy)', () => {
  const base = { goal: 'g', task_class: 'docs', base_sha: 'a'.repeat(40) };
  const errs = (checks) => validateTask({ ...buildTaskSpec({ ...base, acceptance_checks: checks }, { source: 'api', actor_id: 'x', policy: POLICY }).spec, task_id: 'task-x', project_id: 'p', schema_version: 1, created_at: 'x', updated_at: 'x' }).errors;
  assert.ok(errs([{ ...SLOW_CHECK, timeout_ms: 0 }]).some((e) => e.path === 'acceptance_checks[0].timeout_ms'));
  assert.ok(!errs([{ ...SLOW_CHECK, timeout_ms: 600_000 }]).some((e) => /timeout_ms/.test(e.path)));
  const bad = validatePolicy({ ...POLICY, checks: { timeout_ms: 1.5, by_task_class: { Docs: [], docs: [{ ...SLOW_CHECK, required: false }] }, extra: 1 } }).map((e) => e.path);
  for (const p of ['checks.timeout_ms', 'checks.by_task_class.Docs', 'checks.by_task_class.docs', 'checks.extra']) assert.ok(bad.includes(p), p);
});
