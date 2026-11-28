// GET /api/reply/<s> in the REAL server.js (docs/READER-SUMMARY.md): next to the reply it gives the turn's `Summary:` lines and the STATUS
// { kind, headline }, read from the pane's closing text. The server runs as a child process on a free loopback port with a temp state dir,
// a temp HOME and a private tmux socket: no live state, no live pane.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { waitServer } from './helpers/wait-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'srvreply-')));
const SOCK = `srvreply-${randomBytes(4).toString('hex')}`;
const REAL_TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
const TMUX = path.join(TMP, 'tmux-wrapper.sh');
fs.writeFileSync(TMUX, `#!/bin/sh\nexec ${REAL_TMUX} -L ${SOCK} "$@"\n`, { mode: 0o755 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

const TURN = path.join(TMP, 'turn.txt');
fs.writeFileSync(TURN, [
  '⏺ The fix is in.',
  '',
  '  Summary:',
  '  - Resume failed when the folder was gone.',
  '  - Resume now rebuilds the folder first.',
  '',
  '  Verification:',
  '  1. pass — tests green',
  '',
  '  STATUS: done — resume fix merged · closing review: docs none needed · bugs: none',
  '',
].join('\n'));
const PLAIN = path.join(TMP, 'plain.txt');
fs.writeFileSync(PLAIN, '⏺ Nothing to summarise here.\n\n  STATUS: waiting: integration int-1\n');
execFileSync(TMUX, ['new-session', '-d', '-s', 'withsum', '-x', '120', '-y', '30', `cat ${TURN}; sleep 3000`]);
execFileSync(TMUX, ['new-session', '-d', '-s', 'nosum', '-x', '120', '-y', '30', `cat ${PLAIN}; sleep 3000`]);

after(() => {
  try { child?.kill('SIGKILL'); } catch { /* gone */ }
  try { execFileSync(REAL_TMUX, ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

test('/api/reply: summary lines and STATUS of the last turn; null summary when the turn has none', async () => {
  const port = await freePort();
  const state = path.join(TMP, 'state'), home = path.join(TMP, 'home');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, GHOSTY_DISK_GUARD: 'off',
    TMUX_BIN: TMUX, TLS_KEY: path.join(TMP, 'none.pem'), TLS_CERT: path.join(TMP, 'none.pem') };
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitServer(base, () => log);
  await sleep(300);
  const get = async (s) => fetch(`${base}/api/reply/${s}`).then((r) => r.json());
  const a = await get('withsum');
  assert.deepEqual(a.summary, ['Resume failed when the folder was gone.', 'Resume now rebuilds the folder first.'], JSON.stringify(a));
  assert.deepEqual(a.status, { kind: 'done', headline: 'resume fix merged' });
  const b = await get('nosum');
  assert.equal(b.summary, null);
  assert.deepEqual(b.status, { kind: 'waiting', headline: 'integration int-1' });
});
