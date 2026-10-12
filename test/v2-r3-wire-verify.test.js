// Independent review probes for the round-3 wiring (orchestration/v2-runtime.js, v2-integrate.js, server.js hooks).
// The server is booted as a child process (never imported) with a temp state dir, a temp work root, HOST=127.0.0.1, a
// private `tmux -L` socket and the test-only fake adapter. Tests marked `todo` demonstrate a defect and stay green.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { v2Config } from '../orchestration/v2-runtime.js';
import { createServerIntegrate } from '../orchestration/v2-integrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-r3-verify-')));
const SOCK = `v2r3v-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX_WRAPPER = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX_WRAPPER, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const children = new Set();
execFileSync(TMUX_WRAPPER, ['new-session', '-d', '-s', 'verify-fixture', '-x', '80', '-y', '20', 'sleep 3000']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCK), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const POLICY = { schema_version: 1, project_id: 'verify-fixture', test_command: ['node', 'check.js'],
  allowlists: { commands: [['node']], paths: ['src', 'check.js'], runtimes: null, models: null },
  protected_paths: ['.ai'], protected_branches: ['main'], approval_policy: { requires: [] } };
const HELLO = [{ op: 'write', path: 'src/hello.txt', content: 'hello\n' }, { op: 'usage', input_tokens: 10, output_tokens: 5, usd: 0.001 }];
const SCRIPTS = { default: { developer: HELLO }, hang: { developer: [{ op: 'hang' }] } };

let n = 0;
function world() {
  const base = path.join(TMP, `w${++n}`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Fixture User'); sh(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, '.ai', 'project.json'), JSON.stringify(POLICY, null, 1));
  fs.writeFileSync(path.join(repo, 'check.js'), "const fs=require('fs');process.exit(fs.existsSync('src/hello.txt')?0:1)\n");
  fs.writeFileSync(path.join(repo, 'src', 'README.md'), '# fixture\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'init');
  const scripts = path.join(base, 'scripts.json');
  fs.writeFileSync(scripts, JSON.stringify(SCRIPTS));
  const state = path.join(base, 'state'), work = path.join(base, 'work');
  fs.mkdirSync(state, { recursive: true });
  return { base, repo, state, work, scripts, main: sh(repo, 'rev-parse', 'main') };
}

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

async function boot(w, { extra = {}, cwd = ROOT } = {}) {
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: path.join(w.base, 'home'), LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: w.state,
    TMUX_BIN: TMUX_WRAPPER, TLS_KEY: path.join(w.base, 'none.pem'), TLS_CERT: path.join(w.base, 'none.pem'),
    GHOSTY_V2: '1', GHOSTY_V2_WORK_ROOT: w.work, GHOSTY_V2_REPOS: w.repo, GHOSTY_V2_TEST_FAKE_ADAPTER: w.scripts, ...extra };
  fs.mkdirSync(env.HOME, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code, sig) => { children.delete(child); r({ code, sig }); }));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ }
    if (i > 150) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  const s = { child, port, api, exited, log: () => log.split('\n').filter((l) => !/listSessions|^\s*$/.test(l)).join('\n') };
  s.status = await until(async () => { const r = await api('GET', '/api/v2/ops/status'); return ['running', 'refused'].includes(r.body?.status?.state) && r.body.status; }, 20_000, () => log);
  return s;
}
async function until(fn, ms = 20_000, diag = () => '') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out\n${diag()}`); await sleep(100); }
}
async function term(s) { s.child.kill('SIGTERM'); return s.exited; }
const CREATE = (w, over = {}) => ({ goal: 'Create src/hello.txt containing hello [fake:hang]', repository: w.repo, risk_class: 'low', runtime_capabilities: ['code'], ...over });

// ---- single writer ---------------------------------------------------------------------------------

// Scenario: instance A is the controller, is suspended (or its heartbeat fails) past the 60 s lease TTL, instance B
// takes over and is alive. A's own loop writes are fenced (E_CONTROLLER_LOST) and its owner actions see E_HELD, but
// `POST /api/v2/tasks` is gated only by the process-local `state === 'running'` flag: intake.createTask writes to the
// raw store handle without the lease fence. Expected: 409/503, nothing written. Observed: 201, the task is created
// by a process that is not the controller.
test('probe: task create on a displaced controller is written without the lease (second live controller holds it)', { timeout: 60_000,
  todo: 'v2-runtime.js intake.createTask -> baseIntake.createTask writes through the unfenced store; only `state` is checked, not the lease' }, async () => {
  const w = world();
  const a = await boot(w);
  let b = null;
  try {
    assert.equal(a.status.state, 'running', a.log());
    // Simulate A's lease running out (A suspended past the TTL): expire the holder in the record, then B takes over.
    const leasesDir = path.join(w.state, 'v2', 'leases');
    const rec = fs.readdirSync(leasesDir).find((f) => f.startsWith(encodeURIComponent('service:local:goal-loop')) && f.endsWith('.lease.json'));
    assert.ok(rec, fs.readdirSync(leasesDir).join(','));
    const j = JSON.parse(fs.readFileSync(path.join(leasesDir, rec), 'utf8'));
    j.holder.expires_at = 1;
    fs.writeFileSync(path.join(leasesDir, rec), JSON.stringify(j));
    b = await boot(w);
    assert.equal(b.status.state, 'running', b.log());
    // The displaced instance A still creates tasks: that is the defect.
    const r = await a.api('POST', '/api/v2/tasks', CREATE(w, { goal: 'written by a displaced controller [fake:hang]' }));
    const obs = [`create via A -> ${r.status} ${r.body?.code || ''}`];
    if (r.status === 201) {
      const id = r.body.task.task_id;
      // A's owner actions on that very task fail closed (B is alive): A knows it is not the controller, yet it wrote.
      const viaA = await a.api('POST', `/api/v2/tasks/${id}/cancel`, { reason: 'from A' });
      obs.push(`cancel via A -> ${viaA.status} ${viaA.body?.code || ''}`);
      // Does the live controller B even see the task A wrote? (its store handle replayed before A's write)
      const viaB = await b.api('GET', `/api/v2/tasks/${id}`);
      obs.push(`read via B -> ${viaB.status} ${viaB.body?.code || viaB.body?.task?.state || ''}`);
      // B's own store write still works.
      const made = await b.api('POST', '/api/v2/tasks', CREATE(w));
      obs.push(`create via B -> ${made.status}`);
    }
    assert.ok([409, 503].includes(r.status), `expected the write to be refused; observed: ${obs.join('; ')}`);
  } finally { if (b) await term(b); await term(a); }
});

// ---- repo allowlist ---------------------------------------------------------------------------------

// `allowed(repo)` in v2-runtime.js realpaths the request's `repository` as given, so a relative path would resolve against
// the server's cwd; the HTTP layer (http.js checkCreate) refuses non-absolute paths first, so this is not reachable via
// the API. Pinned here so the HTTP check stays load-bearing.
test('probe: a relative `repository` is refused even when the server cwd is the allowlisted repo', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w, { cwd: w.repo });
  try {
    assert.equal(s.status.state, 'running', s.log());
    for (const rel of ['.', 'repo', './repo', '../repo']) {
      const r = await s.api('POST', '/api/v2/tasks', CREATE(w, { repository: rel }));
      assert.deepEqual([r.status, r.body.code], [400, 'E_INVALID'], JSON.stringify(r.body));
    }
    // ../ inside an absolute path normalizes to the allowlisted realpath: accepted by design (realpath allowlist).
    const r = await s.api('POST', '/api/v2/tasks', CREATE(w, { repository: `${w.repo}/src/..` }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // A sibling path outside the allowlist, even under the same parent, is refused.
    const other = path.join(w.base, 'other'); fs.mkdirSync(other); sh(other, 'init', '-q', '-b', 'main');
    const o = await s.api('POST', '/api/v2/tasks', CREATE(w, { repository: other }));
    assert.deepEqual([o.status, o.body.code], [400, 'E_INTAKE_REPO']);
  } finally { await term(s); }
});

test('probe: v2Config realpaths the allowlist and refuses symlinked overlap; fake adapter needs a readable JSON file', () => {
  const base = path.join(TMP, 'cfg');
  const state = path.join(base, 'state'), checkout = path.join(base, 'checkout'), work = path.join(base, 'work'), repo = path.join(base, 'repo');
  for (const d of [state, checkout, work, repo]) fs.mkdirSync(d, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  const link = path.join(base, 'repo-link'); fs.symlinkSync(repo, link);
  const stateLink = path.join(base, 'state-link'); fs.symlinkSync(state, stateLink);
  const insideWork = path.join(work, 'inner'); fs.mkdirSync(insideWork); sh(insideWork, 'init', '-q', '-b', 'main');
  const c = v2Config({ GHOSTY_V2_WORK_ROOT: work, GHOSTY_V2_REPOS: [link, 'relative/repo', insideWork, `${repo}/../repo`].join(path.delimiter) }, { stateDir: state, repoRoot: checkout });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.repos, [fs.realpathSync(repo)], 'symlink and ../ normalize to one realpath; relative and work-root entries are dropped');
  assert.ok(c.warnings.some((x) => /relative\/repo is not an existing absolute path/.test(x)));
  assert.ok(c.warnings.some((x) => /inner overlaps the state dir or the work root/.test(x)));
  // A work root that is a symlink into the state dir is caught through realpath.
  const c2 = v2Config({ GHOSTY_V2_WORK_ROOT: path.join(stateLink, 'wt'), GHOSTY_V2_REPOS: repo }, { stateDir: state, repoRoot: checkout });
  assert.ok(c2.errors.some((x) => /must not overlap the state dir/.test(x)), JSON.stringify(c2.errors));
  // Fake adapter: the flag must name a readable JSON file, otherwise the loop refuses to start (no silent fallback to real runtimes).
  const c3 = v2Config({ GHOSTY_V2_WORK_ROOT: work, GHOSTY_V2_REPOS: repo, GHOSTY_V2_TEST_FAKE_ADAPTER: path.join(base, 'missing.json') }, { stateDir: state, repoRoot: checkout });
  assert.ok(c3.errors.some((x) => /GHOSTY_V2_TEST_FAKE_ADAPTER unreadable/.test(x)));
  assert.equal(c3.fakeScripts, null);
  // Push remote must be a plain name: anything URL- or option-like is dropped.
  for (const bad of ['--mirror', 'https://x/y.git', 'a b', '']) {
    const c4 = v2Config({ GHOSTY_V2_WORK_ROOT: work, GHOSTY_V2_REPOS: repo, GHOSTY_V2_PUSH_REMOTE: bad }, { stateDir: state, repoRoot: checkout });
    assert.equal(c4.pushRemote, null, bad);
  }
});

// ---- push gate -------------------------------------------------------------------------------------

test('probe: the integrate hook pushes exactly one refspec (own branch, full SHA, compare-and-swap) and refuses anything else', async () => {
  const calls = [];
  const remote = new Map();
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'remote') return 'origin\n';
    if (args[0] === 'ls-remote') { const ref = args[2].replace('refs/heads/', ''); return remote.has(ref) ? `${remote.get(ref)}\trefs/heads/${ref}\n` : ''; }
    if (args[0] === 'push') { const [sha, ref] = args[4].split(':'); remote.set(ref.replace('refs/heads/', ''), sha); return ''; }
    if (args[0] === 'merge-base') throw Object.assign(new Error('not ancestor'), { code: 'E_GIT' });
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const effects = [], events = [];
  const store = { append: async () => {}, get: async () => ({ effects }), events: async () => events,
    recordEffect: async (_id, e) => { const cur = effects.find((x) => x.effect_id === e.effect_id); if (cur) Object.assign(cur, e); else effects.push({ ...e }); } };
  const integrate = createServerIntegrate({ git, pushRemote: 'origin', loadPolicy: () => ({ ok: true, policy: { project_id: 'p', protected_branches: ['main'] } }) });
  const sha = 'a'.repeat(40);
  const task = { task_id: 'task-1', repository: '/repo' };
  // Wrong branch, short SHA, foreign branch name: refused before any git call.
  for (const [s, wt] of [[sha, { branch: 'main' }], [sha, { branch: 'v2task/task-2' }], ['abc1234', { branch: 'v2task/task-1' }], [`${sha}; rm -rf /`, { branch: 'v2task/task-1' }]]) {
    const r = await integrate(task, { sha: s, worktree: wt, store });
    assert.deepEqual([r.next, r.block], ['awaiting_approval', 'policy'], JSON.stringify(r));
  }
  assert.equal(calls.length, 0, 'no git call for a refused handoff');
  const r = await integrate(task, { sha, worktree: { branch: 'v2task/task-1' }, store });
  assert.equal(r.next, 'awaiting_approval');
  assert.deepEqual(r.keys, [`integration:merge:p:main:${sha}`]);
  assert.deepEqual(r.classes, ['merge_protected']);
  const pushes = calls.filter((a) => a[0] === 'push');
  assert.deepEqual(pushes, [['push', '--porcelain', '--force-with-lease=refs/heads/v2task/task-1:', 'origin', `${sha}:refs/heads/v2task/task-1`]]);
  assert.ok(!calls.some((a) => a.includes('--force') || a.some((x) => /refs\/heads\/main/.test(x) && a[0] === 'push')), 'never --force, never a push touching main');
  assert.equal(effects.filter((e) => e.kind === 'push_task_branch').at(-1).phase, 'confirmed');
  // Approved at the SHA: still no merge; the hook only reads whether main contains it.
  events.push({ kind: 'approval.granted', payload: { k: 1, grants: { request_kind: 'integration', keys: r.keys } } });
  const n0 = calls.length;
  const r2 = await integrate(task, { sha, worktree: { branch: 'v2task/task-1' }, store });
  assert.equal(r2.next, 'waiting');
  assert.deepEqual(calls.slice(n0).map((a) => a[0]).filter((x) => !['remote', 'ls-remote'].includes(x)), ['merge-base'], 'no push, no merge after approval');
  // A grant of another kind or another SHA does not count.
  events.length = 0;
  events.push({ kind: 'approval.granted', payload: { k: 1, grants: { request_kind: 'proposal', keys: r.keys } } },
    { kind: 'approval.granted', payload: { k: 2, grants: { request_kind: 'integration', keys: [`integration:merge:p:main:${'b'.repeat(40)}`] } } });
  assert.equal((await integrate(task, { sha, worktree: { branch: 'v2task/task-1' }, store })).next, 'awaiting_approval');
  assert.throws(() => createServerIntegrate({ git, pushRemote: '--mirror' }), /invalid remote name/);
});

// ---- ops routes, origin and content-type -------------------------------------------------------------

test('probe: ops routes are read-only / request-only and sit behind the Origin and content-type checks', { timeout: 60_000 }, async () => {
  const w = world();
  const s = await boot(w);
  try {
    assert.equal(s.status.state, 'running', s.log());
    assert.equal((await s.api('POST', '/api/v2/ops/status', {})).status, 405);
    assert.equal((await s.api('POST', '/api/v2/ops/incidents', {})).status, 405);
    assert.equal((await s.api('GET', '/api/v2/ops/requests')).status, 405);
    assert.equal((await s.api('POST', '/api/v2/ops/requests', { action: 'restart', extra: 1 })).status, 400);
    assert.equal((await s.api('POST', '/api/v2/ops/requests', { action: 'restart; rm -rf /' })).status, 400);
    // Cross-origin and non-JSON are refused before the V2 handler runs.
    assert.equal((await s.api('POST', '/api/v2/ops/requests', { action: 'restart' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.api('POST', '/api/v2/tasks', CREATE(w), { origin: 'https://evil.example' })).status, 403);
    const raw = await fetch(`http://127.0.0.1:${s.port}/api/v2/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(CREATE(w)) });
    assert.equal(raw.status, 415);
    // A request only records an incident: nothing executes; a non-string type is coerced, not stored raw.
    const r = await s.api('POST', '/api/v2/ops/requests', { action: 'restart', type: { nested: true }, symptom: 'probe' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual([r.body.executed, r.body.state], [false, 'mitigation_requested']);
    const inc = (await s.api('GET', '/api/v2/ops/incidents')).body.incidents.find((i) => i.incident_id === r.body.incident_id);
    assert.equal(inc.type, 'health.unknown');
    // Status never carries env values or paths, only counts/flags.
    const st = (await s.api('GET', '/api/v2/ops/status')).body.status;
    assert.deepEqual(Object.keys(st).sort(), ['concurrency', 'reason', 'repos', 'runtimes', 'scheduler', 'state', 'test_fake_adapter', 'work_root_set']);
    assert.equal(typeof st.repos, 'number');
    // deliver is refused for informational tasks; review_policy cannot be set directly.
    assert.equal((await s.api('POST', '/api/v2/tasks', { goal: 'q', template: 'informational', deliver: true })).status, 400);
    assert.equal((await s.api('POST', '/api/v2/tasks', CREATE(w, { review_policy: { deliver: true } }))).status, 400);
  } finally { await term(s); }
});
