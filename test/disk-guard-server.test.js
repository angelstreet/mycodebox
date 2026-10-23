// The disk-space safety policy in the REAL server.js: the banner's endpoint, the 409 refusal of new work and the
// guarantee that running work is not blocked. The server is booted as a child process (never imported here) on a
// free loopback port, with a temp state dir, a temp HOME and a private tmux socket: no live state is touched.
// The disk itself is the real one; the policy is switched on with a hold threshold of 0 %, so every volume is "full".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diskguard-')));
const SOCK = `diskguard-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX_WRAPPER = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX_WRAPPER, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A private tmux server with one idle session: the dashboard's poll has something to list.
execFileSync(TMUX_WRAPPER, ['new-session', '-d', '-s', 'disk-fixture', '-x', '80', '-y', '20', 'sleep 3000']);

after(async () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCK), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

async function boot({ diskGuard }) {
  const port = await freePort();
  const state = path.join(TMP, `state-${randomBytes(3).toString('hex')}`);
  const home = path.join(TMP, `home-${randomBytes(3).toString('hex')}`);
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (diskGuard) fs.writeFileSync(path.join(state, 'manager.json'), JSON.stringify({ diskGuard }));
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state,
    TMUX_BIN: TMUX_WRAPPER, TLS_KEY: path.join(TMP, 'none.pem'), TLS_CERT: path.join(TMP, 'none.pem') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ }
    if (i > 150) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  return { api, home, log: () => log };
}

test('the disk endpoint: the banner reading and the thresholds', async () => {
  const s = await boot({});
  const r = await s.api('GET', '/api/disk');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.holdPct, 90);
  assert.equal(r.body.warnPct, 85);
  assert.ok(Array.isArray(r.body.disks));
  assert.ok(Array.isArray(r.body.top), 'the detail carries the top consumers');
  // A healthy disk: no reason code, nothing refused.
  assert.equal(r.body.reason, null);
  assert.equal(r.body.blocked, false);
});

test('the hold: new sessions and resumes are refused with 409 disk_low, running work is not', async () => {
  // holdPct 0: every volume counts as full, whatever the machine really looks like.
  const s = await boot({ diskGuard: { holdPct: 0 } });

  const d = await s.api('GET', '/api/disk');
  assert.equal(d.body.level, 'hold');
  assert.equal(d.body.reason, 'disk_low');
  assert.equal(d.body.blocked, true);

  const start = await s.api('POST', '/api/sessions', { name: 'refused-new', agent: 'bash', cwd: s.home });
  assert.equal(start.status, 409, 'starting a new session is refused');
  assert.equal(start.body.reason, 'disk_low');
  assert.match(start.body.error, /paused/, 'the owner reads why');

  const resume = await s.api('POST', '/api/sessions/disk-fixture/resume', {});
  assert.equal(resume.status, 409, 'resuming a session is refused');
  assert.equal(resume.body.reason, 'disk_low');

  // Existing work keeps running: the dashboard reads, and a send to a running session still goes through.
  const list = await s.api('GET', '/api/sessions');
  assert.equal(list.status, 200);
  const send = await s.api('POST', '/api/send/disk-fixture', { keys: 'echo still-works' });
  assert.notEqual(send.status, 409, 'a send is never blocked by the disk policy');
  assert.notEqual(send.body?.reason, 'disk_low');
});

test('the owner override: new work starts again while the banner stays', async () => {
  const s = await boot({ diskGuard: { holdPct: 0, override: true } });
  const d = await s.api('GET', '/api/disk');
  assert.equal(d.body.level, 'hold');
  assert.equal(d.body.reason, 'disk_low', 'the banner still shows: the disk is still full');
  assert.equal(d.body.blocked, false, 'but the hold is lifted');
  const start = await s.api('POST', '/api/sessions', { name: 'allowed-new', agent: 'bash', cwd: s.home });
  assert.equal(start.status, 200, 'the explicit override lets new work start');
});
