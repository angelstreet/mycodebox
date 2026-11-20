// POST /api/scroll in the REAL server.js (alt-scroll.js): a fullscreen app with SGR mouse tracking gets `n` wheel notches, answered once
// redrawn; a fullscreen app without mouse tracking gets PageUp; a pane with scrollback is refused. The server runs as a child process on
// a free loopback port with a temp state dir, a temp HOME and a private tmux socket (fixtures/fake-fullscreen-tui.mjs): no live state.
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
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'altscroll-')));
const SOCK = `altscroll-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
const STRAY = path.join(TMP, 'stray.log');
const TUI = path.join(ROOT, 'test', 'fixtures', 'fake-fullscreen-tui.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

// mouse: the TUI with SGR mouse tracking; keys: the same TUI told to switch tracking off (sends ?1000l after start); log: a shell with scrollback
execFileSync(TMUX, ['new-session', '-d', '-s', 'mouse', '-x', '80', '-y', '20', `STRAY_LOG=${STRAY} ${process.execPath} ${TUI}`]);
execFileSync(TMUX, ['new-session', '-d', '-s', 'keys', '-x', '80', '-y', '20', `NO_MOUSE=1 STRAY_LOG=${STRAY} ${process.execPath} ${TUI}`]);
execFileSync(TMUX, ['new-session', '-d', '-s', 'log', '-x', '80', '-y', '20', 'seq 1 500; sleep 3000']);

after(() => {
  try { child?.kill('SIGKILL'); } catch { /* gone */ }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCK), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const status = (s) => execFileSync(TMUX, ['capture-pane', '-p', '-t', `=${s}:`]).toString().trim().split('\n').at(-1).trim();

async function boot() {
  const port = await freePort();
  const state = path.join(TMP, 'state'), home = path.join(TMP, 'home');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state,
    TMUX_BIN: TMUX, TLS_KEY: path.join(TMP, 'none.pem'), TLS_CERT: path.join(TMP, 'none.pem') };
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ }
    if (i > 150) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  // the 1 s tick must have seen the panes (alt flag) before a scroll is accepted
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${base}/api/snapshot/mouse`).then((x) => x.json()).catch(() => null);
    if (r && r.alt) break;
    await sleep(100);
  }
  return async (s, body) => {
    const r = await fetch(`${base}/api/scroll/${s}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('scroll: wheel notches to a mouse-tracking fullscreen app, PageUp to one without, refusal with scrollback; nothing typed', async () => {
  const scroll = await boot();
  assert.equal(status('mouse'), 'off=0');
  let r = await scroll('mouse', { dir: 'up', n: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.body.notches, 4);
  assert.equal(r.body.changed, true, 'answered once the app had redrawn');
  assert.equal(status('mouse'), 'off=12', '4 notches of 3 lines');
  r = await scroll('mouse', { dir: 'down', n: 1 });
  assert.equal(status('mouse'), 'off=9');
  r = await scroll('mouse', { dir: 'up', n: 1e6 });
  assert.equal(r.body.notches, 60, 'capped');
  await scroll('mouse', { dir: 'bottom' });
  assert.equal(status('mouse'), 'off=0', 'bottom is ctrl+End');

  assert.equal(status('keys'), 'off=0');
  r = await scroll('keys', { dir: 'up', n: 5 });
  assert.equal(r.status, 200);
  assert.equal(status('keys'), `off=${20 - 2}`, 'no mouse tracking: one PageUp, never the raw wheel bytes');

  r = await scroll('log', { dir: 'up' });
  assert.equal(r.status, 409);
  r = await scroll('mouse', { dir: 'sideways' });
  assert.equal(r.status, 400);
  assert.equal(fs.existsSync(STRAY) ? fs.readFileSync(STRAY, 'latin1') : '', '', 'no stray input reached either app');
});
