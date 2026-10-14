// OWNER_DECISIONS §11.1: the V2 engine wired into the REAL server.js (orchestration/v2-runtime.js), booted as a child
// process (never imported here) on a free loopback port, with a temp state dir, a temp work root, a temp git repo with
// a valid .ai/project.json on GHOSTY_V2_REPOS, a private tmux socket (TMUX_BIN wrapper -L <unique>) and the test-only
// scripted fake adapter (the only runtime in that mode: no real CLI is reachable). TLS is pointed at missing files.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../orchestration/store.js';
import { createIntake } from '../orchestration/intake.js';
import { recordProposals } from '../orchestration/proposals.js';
import { createServerIntegrate } from '../orchestration/v2-integrate.js';
import { createGitRunner } from '../orchestration/integration-controller.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wiring-')));
const SOCK = `v2wire-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX_WRAPPER = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX_WRAPPER, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const children = new Set();
// A private tmux server with one idle session, so the dashboard's session poll has something to list.
execFileSync(TMUX_WRAPPER, ['new-session', '-d', '-s', 'wiring-fixture', '-x', '80', '-y', '20', 'sleep 3000']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server was started */ }
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCK), { force: true });   // the stale socket file
  fs.rmSync(TMP, { recursive: true, force: true });
});

const POLICY = { schema_version: 1, project_id: 'wiring-fixture', test_command: ['node', 'check.js'],
  allowlists: { commands: [['node']], paths: ['src', 'check.js'], runtimes: null, models: null },
  protected_paths: ['.ai'], protected_branches: ['main'], approval_policy: { requires: [] } };
const HELLO = [{ op: 'write', path: 'src/hello.txt', content: 'hello\n' }, { op: 'usage', input_tokens: 10, output_tokens: 5, usd: 0.001 }];
const SCRIPTS = {
  default: { developer: HELLO },
  outside: { developer: [{ op: 'write', path: 'secret/notes.txt', content: 'x\n' }, ...HELLO] },
  crash: { developer_runs: [[{ op: 'hang' }], HELLO] },   // run 1 hangs until the server is killed; run 2 solves
  hang: { developer: [{ op: 'hang' }] },
};

let n = 0;
// A disposable world: repo (+ bare origin), state dir, work root, scripts file.
function world() {
  const base = path.join(TMP, `w${++n}`);
  const repo = path.join(base, 'repo'), origin = path.join(base, 'origin.git');
  fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  sh(base, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Fixture User'); sh(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, '.ai', 'project.json'), JSON.stringify(POLICY, null, 1));
  fs.writeFileSync(path.join(repo, 'check.js'), "const fs=require('fs');process.exit(fs.existsSync('src/hello.txt')&&fs.readFileSync('src/hello.txt','utf8').trim()==='hello'?0:1)\n");
  fs.writeFileSync(path.join(repo, 'src', 'README.md'), '# fixture\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', 'origin', 'main');
  const scripts = path.join(base, 'scripts.json');
  fs.writeFileSync(scripts, JSON.stringify(SCRIPTS));
  const state = path.join(base, 'state'), work = path.join(base, 'work');
  fs.mkdirSync(state, { recursive: true });
  return { base, repo, origin, state, work, scripts, main: sh(repo, 'rev-parse', 'main') };
}

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

async function boot(w, { v2 = true, extra = {} } = {}) {
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: path.join(w.base, 'home'), LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: w.state,
    TMUX_BIN: TMUX_WRAPPER, TLS_KEY: path.join(w.base, 'none.pem'), TLS_CERT: path.join(w.base, 'none.pem'),
    ...(v2 ? { GHOSTY_V2: '1', GHOSTY_V2_WORK_ROOT: w.work, GHOSTY_V2_REPOS: w.repo, GHOSTY_V2_TEST_FAKE_ADAPTER: w.scripts, GHOSTY_V2_PUSH_REMOTE: 'origin' } : {}), ...extra };
  fs.mkdirSync(env.HOME, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code, sig) => { children.delete(child); r({ code, sig }); }));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ }
    if (i > 150) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  const s = { child, port, api, exited, log: () => log.split('\n').filter((l) => !/listSessions|^\s*$/.test(l)).join('\n') };
  if (v2) s.status = await until(async () => { const r = await api('GET', '/api/v2/ops/status'); return ['running', 'refused'].includes(r.body?.status?.state) && r.body.status; }, 20_000, () => log);
  return s;
}

async function until(fn, ms = 20_000, diag = () => '') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out\n${diag()}`);
    await sleep(100);
  }
}
const task = async (s, id) => (await s.api('GET', `/api/v2/tasks/${id}`)).body.task;
// awaiting_approval counts only with a pending request (an answered one is about to move on).
const inState = (s, id, states, ms) => {
  let last = null;
  const diag = () => `${s.log()}\nlast view: ${JSON.stringify(last && { state: last.state, history: last.history.slice(-6).map((h) => `${h.to}: ${h.reason}`), wait: last.wait, pending: last.pending_approval })}`;
  return until(async () => { const t = last = await task(s, id); return states.includes(t.state) && (t.state !== 'awaiting_approval' || t.pending_approval) && t; }, ms, diag);
};
const create = async (s, w, over = {}) => {
  const r = await s.api('POST', '/api/v2/tasks', { goal: 'Create src/hello.txt containing the single line hello', repository: w.repo, risk_class: 'low',
    runtime_capabilities: ['code'], ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.task.task_id;
};
async function term(s) { s.child.kill('SIGTERM'); return s.exited; }

test('wiring: a task created via the API executes to accepted in a worktree under the work root; main is unchanged', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w);
  try {
    assert.equal(s.status.state, 'running', s.log());
    const id = await create(s, w);
    const t = await inState(s, id, ['accepted', 'failed_unrecoverable', 'waiting', 'awaiting_approval'], 30_000);
    assert.equal(t.state, 'accepted', JSON.stringify([t.history?.map((h) => `${h.to}: ${h.reason}`), t.wait, t.pending_approval]));
    assert.equal(t.outcome, 'done');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(w.work), 'wt', id, 'src', 'hello.txt')), 'the run wrote inside its worktree under the work root');
    assert.equal(sh(w.repo, 'rev-parse', 'main'), w.main, 'main of the repo did not move');
    assert.ok(!fs.existsSync(path.join(w.repo, 'src', 'hello.txt')), 'the checkout itself is untouched');
    assert.equal(t.acceptance_checks[0].status, 'passing_on_head');
    assert.deepEqual(t.runs.map((r) => r.role).sort(), ['developer', 'reviewer']);
    assert.notEqual(t.runs.find((r) => r.role === 'developer').model, t.runs.find((r) => r.role === 'reviewer').model, 'independent reviewer of another model');
    assert.equal(t.usage.records.length, 2);
    // Budget stops are answered through the API (what a benchmark driver does): unknown estimate -> approve.
    const capped = await create(s, w, { budget_policy: { mode: 'cap', max_usd: 1 }, no_progress_policy: { same_signature: 2, strategy_changes_without_progress: 1 },
      preferred_models: ['fake:fake-dev'] });
    let c;
    for (let i = 0; i < 4; i++) {
      c = await inState(s, capped, ['accepted', 'awaiting_approval', 'failed_unrecoverable', 'waiting'], 30_000);
      if (c.state !== 'awaiting_approval') break;
      assert.deepEqual([c.pending_approval.kind, c.pending_approval.cap_reached], ['budget', false]);
      const ar = await s.api('POST', `/api/v2/tasks/${capped}/approve`, { action_id: c.pending_approval.action_id, ...(c.pending_approval.sha ? { sha: c.pending_approval.sha } : {}), reason: 'driver ledger ok' });
      assert.equal(ar.status, 200, JSON.stringify([ar.body, c.pending_approval]));
    }
    assert.equal(c.state, 'accepted');
    assert.equal(c.runs.find((r) => r.role === 'developer').model, 'fake-dev', 'pinned developer');
    assert.equal(c.runs.find((r) => r.role === 'reviewer').model, 'fake-review', 'the pinned model never reviews');
    assert.equal(c.budget_policy.max_usd, 1);
    // A repository outside GHOSTY_V2_REPOS never gets a task.
    const other = path.join(w.base, 'other');
    fs.mkdirSync(other); sh(other, 'init', '-q', '-b', 'main');
    const r = await s.api('POST', '/api/v2/tasks', { goal: 'anything', repository: other, acceptance_checks: [{ id: 'x', command: ['node', '-e', '0'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] });
    assert.deepEqual([r.status, r.body.code], [400, 'E_INTAKE_REPO']);
  } finally { await term(s); }
});

test('wiring: a change outside the path allowlist stops at awaiting_approval bound to the head SHA; wrong SHA refused, approve proceeds, deny ends it', { timeout: 90_000 }, async () => {
  const w = world();
  const s = await boot(w);
  try {
    const a = await create(s, w, { goal: 'Create src/hello.txt containing hello [fake:outside]' });
    const b = await create(s, w, { goal: 'Create src/hello.txt containing hello, second [fake:outside]' });
    for (const id of [a, b]) {
      const t = await inState(s, id, ['awaiting_approval', 'accepted', 'failed_unrecoverable'], 30_000);
      assert.equal(t.state, 'awaiting_approval');
      assert.equal(t.pending_approval.sha, t.head_sha);
      assert.ok(t.pending_approval.sha);
    }
    const ta = await task(s, a);
    const bad = await s.api('POST', `/api/v2/tasks/${a}/approve`, { action_id: ta.pending_approval.action_id, sha: 'f'.repeat(40) });
    assert.deepEqual([bad.status, bad.body.code], [409, 'E_SHA_MISMATCH']);
    const ok = await s.api('POST', `/api/v2/tasks/${a}/approve`, { action_id: ta.pending_approval.action_id, sha: ta.pending_approval.sha, reason: 'fixture path is fine' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await inState(s, a, ['accepted', 'failed_unrecoverable'], 30_000)).state, 'accepted');
    const tb = await task(s, b);
    const d = await s.api('POST', `/api/v2/tasks/${b}/deny`, { action_id: tb.pending_approval.action_id, sha: tb.pending_approval.sha, reason: 'no' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal((await inState(s, b, ['failed_unrecoverable', 'accepted'], 30_000)).state, 'failed_unrecoverable');
    assert.equal(sh(w.repo, 'rev-parse', 'main'), w.main);
  } finally { await term(s); }
});

test('wiring: delivery pushes only the task-owned branch; the merge waits for an SHA-bound owner approval and is never executed here', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w);
  try {
    const id = await create(s, w, { deliver: true });
    const t = await inState(s, id, ['awaiting_approval', 'accepted', 'failed_unrecoverable', 'waiting'], 30_000);
    assert.equal(t.state, 'awaiting_approval', JSON.stringify(t.history?.map((h) => `${h.to}: ${h.reason}`)));
    const p = t.pending_approval;
    assert.equal(p.kind, 'integration');
    assert.deepEqual(p.classes, ['merge_protected']);
    assert.deepEqual(p.keys, [`integration:merge:wiring-fixture:main:${t.head_sha}`]);
    assert.equal(p.sha, t.head_sha);
    const remote = (ref) => { try { return sh(w.base, '--git-dir', w.origin, 'rev-parse', `refs/heads/${ref}`); } catch { return null; } };
    assert.equal(remote(`v2/task/${id}`), t.head_sha, 'the owned task branch was pushed at the verified SHA');
    assert.equal(remote('main'), w.main, 'origin main untouched');
    const bad = await s.api('POST', `/api/v2/tasks/${id}/approve`, { action_id: p.action_id, sha: w.main });
    assert.deepEqual([bad.status, bad.body.code], [409, 'E_SHA_MISMATCH']);
    assert.equal((await s.api('POST', `/api/v2/tasks/${id}/approve`, { action_id: p.action_id, sha: p.sha })).status, 200);
    const after = await inState(s, id, ['waiting', 'accepted'], 30_000);
    assert.equal(after.state, 'waiting', 'approved, but this server has no integration lane: it never merges');
    assert.equal(after.wait.reason, 'integration');
    assert.equal(remote('main'), w.main);
    assert.equal(sh(w.repo, 'rev-parse', 'main'), w.main);
  } finally { await term(s); }
});

test('wiring: cancel via the API stops a running task', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w);
  try {
    const id = await create(s, w, { goal: 'Create src/hello.txt [fake:hang]' });
    await inState(s, id, ['executing'], 20_000);
    const r = await s.api('POST', `/api/v2/tasks/${id}/cancel`, { reason: 'fixture cancel' });
    assert.deepEqual([r.status, r.body.state], [200, 'cancelled'], JSON.stringify(r.body));
    await sleep(500);
    assert.equal((await task(s, id)).state, 'cancelled');
  } finally { await term(s); }
});

test('wiring: a scoring proposal task (informational) is approved from the API', { timeout: 60_000 }, async () => {
  const w = world();
  const store = createTaskStore({ dir: path.join(w.state, 'v2') });
  const [rec] = await recordProposals([{ proposal_id: 'p-fixture-1', kind: 'router_weights', title: 'Try other router weights', rationale: 'fixture', change: { weights: {} },
    text: null, shadow: null, evidence_refs: ['scorecard'], risk_class: 'low' }], { store, intake: createIntake({ store }), base_sha: w.main, project_id: 'scoring' });
  const s = await boot(w);
  try {
    const t = await task(s, rec.task_id);
    assert.equal(t.state, 'awaiting_approval');
    const r = await s.api('POST', `/api/v2/tasks/${rec.task_id}/approve`, { action_id: t.pending_approval.action_id, reason: 'ok' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match((await task(s, rec.task_id)).next_action, /decision recorded/);
  } finally { await term(s); }
});

test('wiring: a killed server is recovered by the next one under the lease; a second live server runs no loop and its writes fail closed', { timeout: 180_000 }, async () => {
  const w = world();
  const a = await boot(w);
  const id = await create(a, w, { goal: 'Create src/hello.txt [fake:crash]' });
  await until(async () => (await task(a, id)).runs.some((r) => r.role === 'developer'), 20_000, a.log);   // run 1 started (and hangs)
  a.child.kill('SIGKILL');
  await a.exited;
  const b = await boot(w);
  let c = null;
  try {
    // A kill can leave the lease backend's lock file behind: the backend breaks it once stale (and the dead holder's
    // TTL ran out), meanwhile the runtime retries; it never runs without the lease.
    if (b.status.state !== 'running') {
      assert.match(b.status.reason, /E_UNAVAILABLE/, b.log());
      await until(async () => (await b.api('GET', '/api/v2/ops/status')).body.status.state === 'running', 100_000, b.log);
    }
    const done = await inState(b, id, ['accepted', 'failed_unrecoverable', 'waiting', 'awaiting_approval'], 40_000);
    assert.equal(done.state, 'accepted', 'the interrupted task resumed and finished');
    assert.ok(done.decisions.some((d) => d.kind === 'crash_recovery'), 'the interrupted run was reconciled, not repeated blindly');
    c = await boot(w);
    assert.equal(c.status.state, 'refused', c.log());
    assert.match(c.status.reason, /another goal-loop controller/);
    const cr = await c.api('POST', '/api/v2/tasks', { goal: 'x', repository: w.repo });
    assert.deepEqual([cr.status, cr.body.code], [503, 'E_NO_CONTROLLER']);
    const id2 = await create(b, w, { goal: 'Create src/hello.txt [fake:hang]' });
    const xr = await c.api('POST', `/api/v2/tasks/${id2}/cancel`, {});
    assert.deepEqual([xr.status, xr.body.code], [503, 'E_NO_CONTROLLER']);
    assert.equal((await c.api('GET', '/api/v2/tasks')).status, 200, 'reads still work');
    assert.notEqual((await task(b, id2)).state, 'cancelled');
    assert.equal((await b.api('POST', `/api/v2/tasks/${id2}/cancel`, {})).status, 200);
  } finally {
    if (c) await term(c);
    await term(b);
  }
});

test('wiring: SIGTERM releases the controller lease: a new instance takes over at once', { timeout: 60_000 }, async () => {
  const w = world();
  const a = await boot(w);
  assert.equal(a.status.state, 'running');
  const t0 = Date.now();
  const ex = await term(a);
  assert.equal(ex.code, 0, a.log());
  assert.match(a.log(), /controller lease released/);
  const b = await boot(w);
  try {
    assert.equal(b.status.state, 'running', b.log());
    assert.ok(Date.now() - t0 < 30_000, 'no wait for the 60 s lease TTL');
  } finally { await term(b); }
});

test('wiring: GHOSTY_V2 unset -> /api/v2/* 404 and no v2 state; V2 on without a work root -> no loop, writes refused', { timeout: 60_000 }, async () => {
  const w = world();
  const off = await boot(w, { v2: false });
  try {
    assert.equal((await off.api('GET', '/api/v2/tasks')).status, 404);
    assert.equal((await off.api('POST', '/api/v2/tasks', { goal: 'x' })).status, 404);
    assert.equal((await off.api('GET', '/api/v2/ops/status')).status, 404);
    assert.ok(!fs.existsSync(path.join(w.state, 'v2')), 'no v2 directory');
  } finally { await term(off); }
  const nowr = await boot(w, { extra: { GHOSTY_V2_WORK_ROOT: '' } });
  try {
    assert.equal(nowr.status.state, 'refused');
    assert.match(nowr.status.reason, /GHOSTY_V2_WORK_ROOT/);
    const r = await nowr.api('POST', '/api/v2/tasks', { goal: 'x', repository: w.repo });
    assert.deepEqual([r.status, r.body.code], [503, 'E_NO_CONTROLLER']);
  } finally { await term(nowr); }
  const inside = await boot(w, { extra: { GHOSTY_V2_WORK_ROOT: path.join(w.state, 'wt') } });
  try { assert.match(inside.status.reason, /must not overlap the state dir/); } finally { await term(inside); }
});

test('integrate hook: an unreachable remote is a note (no effect recorded, bounded owner request); repo hooks never run on the push', { timeout: 30_000 }, async () => {
  const w = world();
  const git = createGitRunner({ env: GIT_ENV });
  const POL = () => ({ ok: true, policy: { project_id: 'p', protected_branches: ['main'] } });
  const effects = [];
  const store = { append: async () => {}, get: async () => ({ effects }), events: async () => [],
    recordEffect: async (_id, e) => { const cur = effects.find((x) => x.effect_id === e.effect_id); if (cur) Object.assign(cur, e); else effects.push({ ...e }); } };
  const sha = w.main;
  const id = 'task-hook-1';
  sh(w.repo, 'branch', `v2/task/${id}`, sha);
  // A developer run could plant hooks in the shared .git: the push must not run them.
  const marker = path.join(w.base, 'hook-ran');
  fs.writeFileSync(path.join(w.repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const integrate = createServerIntegrate({ git, pushRemote: 'origin', loadPolicy: POL });
  const r = await integrate({ task_id: id, repository: w.repo }, { sha, worktree: { branch: `v2/task/${id}` }, store });
  assert.equal(r.next, 'awaiting_approval');
  assert.equal(sh(w.base, '--git-dir', w.origin, 'rev-parse', `refs/heads/v2/task/${id}`), sha, 'pushed');
  assert.ok(!fs.existsSync(marker), 'the pre-push hook did not run');
  // Dead remote: no throw, no attempted effect, the merge request still stands.
  sh(w.repo, 'remote', 'set-url', 'origin', path.join(w.base, 'gone.git'));
  const id2 = 'task-hook-2';
  sh(w.repo, 'branch', `v2/task/${id2}`, sha);
  const before = effects.length;
  for (let i = 0; i < 3; i++) {
    const r2 = await integrate({ task_id: id2, repository: w.repo }, { sha, worktree: { branch: `v2/task/${id2}` }, store });
    assert.equal(r2.next, 'awaiting_approval');
    assert.match(r2.reason, /unreadable/);
  }
  assert.equal(effects.length, before, 'no effect recorded for an unreachable remote');
});

test('session history: dashboard create/kill, unknown tick start, v2 runs, cbsession endpoint (loopback + token), GET /api/history', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w);
  const histFile = path.join(w.state, 'session-history.jsonl');
  const recs = () => (fs.existsSync(histFile) ? fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    // The tick records the fixture tmux session first seen as 'unknown'.
    await until(() => recs().some((r) => r.name === 'wiring-fixture' && r.started_by === 'unknown'), 15_000, () => s.log());
    // Dashboard create (agent bash = no command) and kill.
    const c = await s.api('POST', '/api/sessions', { name: 'hist-dash', agent: 'bash', cwd: path.join(w.base, 'home') });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const st = recs().find((r) => r.name === 'hist-dash');
    assert.deepEqual([st.kind, st.started_by, st.provider, st.cwd, st.schema_version], ['session.started', 'dashboard', 'bash', fs.realpathSync(path.join(w.base, 'home')), 1]);
    await sleep(2500);   // ticks must not add an 'unknown' start for it
    assert.equal(recs().filter((r) => r.name === 'hist-dash' && r.kind === 'session.started').length, 1);
    assert.equal((await s.api('DELETE', '/api/sessions/hist-dash?confirm=hist-dash')).status, 200);
    assert.equal(recs().find((r) => r.name === 'hist-dash' && r.kind === 'session.ended').reason, 'killed');
    // cbsession endpoint: token required.
    const post = (headers, body) => fetch(`http://127.0.0.1:${s.port}/api/history/started`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const body = { name: 'cb-one', provider: 'claude', model: 'haiku', cwd: '/w/x', prompt_ref: '/h/cb-one.prompt.md', handover_ref: null, remote_control_url: 'https://claude.ai/code/session_abc' };
    assert.equal((await post({}, body)).status, 401);
    assert.equal((await post({ 'x-ghosty-reporter-token': 'wrong' }, body)).status, 401);
    const token = fs.readFileSync(path.join(w.state, 'reporter.token'), 'utf8').trim();
    assert.equal((await post({ 'x-ghosty-reporter-token': token }, { ...body, name: 'bad name' })).status, 400);
    assert.equal((await post({ 'x-ghosty-reporter-token': token }, body)).status, 200);
    assert.equal(recs().find((r) => r.name === 'cb-one').started_by, 'cbsession');
    // V2 runs: one started/ended pair per developer and reviewer run, named by run id.
    const id = await create(s, w);
    await inState(s, id, ['accepted', 'failed_unrecoverable'], 30_000);
    await until(() => recs().filter((r) => r.kind === 'session.ended' && r.name.startsWith(id)).length >= 2, 10_000, () => JSON.stringify(recs()));
    const v2s = recs().filter((r) => r.started_by === 'v2');
    assert.ok(v2s.length >= 2 && v2s.every((r) => r.name.startsWith(id) && r.provider === 'fake'));
    // API: rows for all of it.
    const h = (await s.api('GET', '/api/history?limit=200')).body;
    assert.ok(h.ok && h.total >= 5);
    const dash = h.sessions.find((x) => x.name === 'hist-dash');
    assert.equal(dash.started_by, 'dashboard'); assert.ok(dash.end > 0); assert.equal(dash.tokens, null); assert.equal(dash.cost_usd, null);
    assert.equal(h.sessions.find((x) => x.name === 'cb-one').remote_control_url, 'https://claude.ai/code/session_abc');
    assert.equal((await s.api('GET', '/api/history?started_by=v2')).body.sessions.every((x) => x.started_by === 'v2'), true);
    assert.equal((await s.api('GET', '/api/history?status=nope')).status, 400);
    assert.equal((await s.api('GET', '/api/history/hist-dash')).body.session.name, 'hist-dash');
    assert.equal((await s.api('GET', '/api/history/none')).status, 404);
    // Malformed percent-escapes answer 400 and the process stays up.
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/history/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/reply/%E0%A4%A`)).status, 400);
    assert.equal((await s.api('GET', '/api/history?limit=1')).status, 200);
    // Proxied requests and client timestamps: refused / ignored.
    assert.equal((await post({ 'x-ghosty-reporter-token': token, 'x-forwarded-for': '203.0.113.9' }, { ...body, name: 'cb-two' })).status, 403);
    assert.equal((await post({ 'x-ghosty-reporter-token': token }, { ...body, name: 'cb-three', ts: 1 })).status, 200);
    assert.ok(recs().find((r) => r.name === 'cb-three').ts > 1e12, 'server time, not the client ts');
    // Restart: open instances are rebuilt from the file, no duplicate 'unknown' start.
    const before = recs().filter((r) => r.name === 'wiring-fixture').length;
    await term(s);
    const s2 = await boot(w);
    try { await sleep(2500); assert.equal(recs().filter((r) => r.name === 'wiring-fixture').length, before); } finally { await term(s2); }
  } finally { try { s.child.kill('SIGKILL'); } catch { /* gone */ } }
});

test('session history: v2 instances left open by a previous process are ended at v2 start', { timeout: 60_000 }, async () => {
  const w = world();
  fs.writeFileSync(path.join(w.state, 'session-history.jsonl'), JSON.stringify({ schema_version: 1, kind: 'session.started', name: 'old.run1', provider: 'fake', model: null, cwd: '/x', started_by: 'v2', prompt_ref: null, handover_ref: null, ts: 1000 }) + '\n');
  const s = await boot(w);
  try {
    const h = (await s.api('GET', '/api/history/old.run1')).body.session;
    assert.deepEqual([h.started_by, h.end > 0], ['v2', true]);
  } finally { await term(s); }
});
