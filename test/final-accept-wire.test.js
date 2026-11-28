// Accepted final through the real server (the wiring a unit test cannot see): an isolated tmux socket, a stand-in agent pane that ends a turn on a
// needs-owner line each time it is typed to, a temp state folder. No live session is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmp } from './helpers-tmp.js';
import { waitServer } from './helpers/wait-server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const cleanups = [];
after(() => cleanups.forEach((f) => { try { f(); } catch { /* gone */ } }));

test('server: accept_final on the manager send keeps the session quiet, a later task message reopens it', { timeout: 150_000, skip: !hasTmux && 'no tmux' }, async () => {
  const base = tmp('final-wire-'), state = join(base, 'state'), home = join(base, 'home'), bin = join(base, 'bin');
  [state, home, bin].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(state, 'manager.json'), JSON.stringify({ enabled: true, aiTriage: 'off', routerShadow: false, wakeShadow: false }));
  const socket = `finalwire${process.pid}`, tmuxBin = join(bin, 'tmux');
  writeFileSync(tmuxBin, `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v tmux']).toString().trim()} -L ${socket} "$@"\n`); chmodSync(tmuxBin, 0o755);
  // each line typed to the stand-in agent starts a turn; it works for 4 s and ends on a question for the owner that names the turn
  writeFileSync(join(bin, 'claude'), `#!/bin/bash
box() { printf '──────────────────────────────\\n❯ \\n──────────────────────────────\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\n'; }
n=0
box
while read -r line; do
  [ -z "$line" ] && continue
  n=$((n+1))
  clear
  for i in 1 2 3 4 5 6 7 8; do printf '\\r\\033[K* Working... (%ss · esc to interrupt)' $i; sleep 0.5; done
  clear
  printf '● Turn %s is over.\\n\\n  STATUS: needs-owner: turn-%s needs a credential; 1 = give it / 2 = leave\\n\\n✻ Crunched for 4s\\n\\n' $n $n
  box
done
`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(tmuxBin, ['new-session', '-d', '-s', 'partial-session', '-x', '200', '-y', '50', join(bin, 'claude')]);
  cleanups.push(() => execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }));
  cleanups.push(() => rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true }));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: tmuxBin, GHOSTY_NO_UI_REVIEW_NIGHTLY: '1',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem'), TICK_MS: '500', STALL_SETTLE_MS: '1000' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  await waitServer(`${url}`, () => log);
  await sleep(4000);   // ghosty alerts on changes, never on first sight
  const post = async (path, body) => { const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const lines = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const asks = () => lines('manager-events.jsonl').filter((e) => e.session === 'partial-session' && ['asks', 'waiting', 'needs-manager'].includes(e.kind));
  const until = async (ok, what) => { for (let i = 0; i < 80; i++) { if (ok()) return; await sleep(500); } throw new Error(`${what}\n${log.slice(-3000)}\n${execFileSync(tmuxBin, ['capture-pane', '-p', '-t', 'partial-session'])}`); };
  const quietStops = () => lines('stalls.jsonl').filter((e) => e.type === 'final_accepted_quiet').length;
  const accepted = async () => (await (await fetch(`${url}/api/manager/accept-final`)).json()).accepted;

  assert.equal((await post('/api/send/partial-session', { keys: 'start the task' })).status, 200);
  await until(() => asks().length === 1, 'control: an open session raises an ask');
  const askedAt = Date.now();

  assert.equal((await post('/api/send/partial-session', { keys: 'x', by: 'integration', accept_final: true })).status, 403);
  assert.equal((await post('/api/send/partial-session', { keys: 'x', by: 'manager-agent', accept_final: true, when: 'idle' })).status, 400);
  assert.equal((await post('/api/manager/accept-final/partial-session', {})).status, 400);
  assert.equal((await post('/api/manager/accept-final/nobody', { by: 'manager-agent' })).status, 404);
  assert.deepEqual(await accepted(), {});
  await sleep(Math.max(0, askedAt + 62_000 - Date.now()));   // past the 60 s alert debounce, else "no new ask" would prove nothing

  assert.equal((await post('/api/send/partial-session', { keys: 'Manager decision: the partial result is final. Stop here.', by: 'manager-agent', accept_final: true })).status, 200);
  await until(() => quietStops() === 1, 'the stop after the acceptance is journalled as quiet');
  await sleep(3000);
  assert.equal(asks().length, 1, 'no new ask for an accepted session');
  assert.equal((await accepted())['partial-session'].by, 'manager-agent');
  const feed = await (await fetch(`${url}/api/push/feed?since=0`)).json();
  assert.equal(feed.items.filter((x) => /turn-2/.test(x.body)).length, 0, 'the owner was not pushed either');

  assert.equal((await post('/api/send/partial-session', { keys: 'New task: do one more thing', by: 'manager-agent' })).status, 200);
  assert.deepEqual(await accepted(), {});
  await until(() => asks().length === 2, 'reopened: it asks again');

  assert.equal((await post('/api/manager/accept-final/partial-session', { by: 'manager-agent', note: 'recorded without a message' })).status, 200);
  assert.equal((await fetch(`${url}/api/manager/accept-final/partial-session?by=manager-agent`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await accepted(), {});
});
