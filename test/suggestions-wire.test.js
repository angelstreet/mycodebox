// No done while a suggestion has no yes / no from the owner (suggestions.js), through the real server: an isolated tmux socket and a stand-in agent
// pane that ends a turn on a list above a done line. No live session is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmp } from './helpers-tmp.js';
import { displayState } from '../public/state.js';
import { isOwnersTurn } from '../public/ask-model.js';
import { hashToken } from '../lease-routes.js';

const MAC = 'tok-wire-0123456789abcdef';   // leak-scan: allow (fake test token)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const cleanups = [];
after(() => cleanups.forEach((f) => { try { f(); } catch { /* gone */ } }));

test('server: a listed suggestion keeps a done session out of done; only the owner\'s dashboard or typed answer counts, per item', { timeout: 150_000, skip: !hasTmux && 'no tmux' }, async () => {
  const base = tmp('sugg-wire-'), state = join(base, 'state'), home = join(base, 'home'), bin = join(base, 'bin');
  [state, home, bin, join(state, 'leases')].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(state, 'leases', 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-a', sha256: hashToken(MAC), remote: true }] }));
  writeFileSync(join(state, 'manager.json'), JSON.stringify({ enabled: true, aiTriage: 'off', routerShadow: false, wakeShadow: false }));
  const socket = `suggwire${process.pid}`, tmuxBin = join(bin, 'tmux');
  writeFileSync(tmuxBin, `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v tmux']).toString().trim()} -L ${socket} "$@"\n`); chmodSync(tmuxBin, 0o755);
  // every typed line is echoed to a file; the first turn ends on a list above a done line, later turns on a plain done line
  const got = join(base, 'typed.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/bash
box() { printf '──────────────────────────────\\n❯ \\n──────────────────────────────\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\n'; }
n=0
box
while read -r line; do
  [ -z "$line" ] && continue
  printf '%s\\n' "$line" >> ${got}
  case "$line" in *mycodebox:*) continue;; esac
  n=$((n+1))
  clear
  for i in 1 2 3 4 5 6; do printf '\\r\\033[K* Working... (%ss · esc to interrupt)' $i; sleep 0.5; done
  clear
  printf '● Turn %s is over.\\n\\n' $n
  [ $n = 1 ] && printf '  Improvements that no worker has taken on:\\n  - add a retry on the walk\\n  - shorter journal rows\\n\\n'
  printf '  STATUS: done — turn-%s finished\\n\\n✻ Crunched for 3s\\n\\n' $n
  box
done
`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(tmuxBin, ['new-session', '-d', '-s', 'worker-session', '-x', '200', '-y', '50', join(bin, 'claude')]);
  cleanups.push(() => execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }));
  cleanups.push(() => rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true }));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: tmuxBin, GHOSTY_NO_UI_REVIEW_NIGHTLY: '1',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem'), TICK_MS: '500', STALL_SETTLE_MS: '1000' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { if ((await fetch(`${url}/api/sessions`)).ok) break; } catch { /* not up */ } if (i > 150) throw new Error(`no server:\n${log}`); await sleep(100); }
  await sleep(4000);
  const post = async (path, body, headers = {}) => { const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); const out = { status: r.status, body: await r.json() }; if (process.env.WIRE_LOG) console.log(path, body.keys || body.event, JSON.stringify(out)); return out; };
  const record = async () => (await (await fetch(`${url}/api/suggestions`)).json()).sessions['worker-session'];
  const feed = async () => (await (await fetch(`${url}/api/push/feed?since=0`)).json()).items;
  const row = async () => (await (await fetch(`${url}/api/sessions`)).json()).status['worker-session'];
  const until = async (ok, what) => { for (let i = 0; i < 80; i++) { if (await ok()) return; await sleep(500); } throw new Error(`${what}\n${JSON.stringify(await row())}\n${log.slice(-3000)}\n${execFileSync(tmuxBin, ['capture-pane', '-p', '-t', 'worker-session'])}`); };
  const dashboard = { origin: url };

  assert.equal((await post('/api/send/worker-session', { keys: 'start the task' }, dashboard)).status, 200);
  await until(async () => (await record())?.items.length === 2, 'the list above the done line is recorded');
  await sleep(3000);
  const pushes = await feed();
  assert.equal(pushes.filter((x) => /is done/.test(x.title)).length, 0, 'no "is done" push');
  const events = () => readFileSync(join(state, 'manager-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.session === 'worker-session');
  await until(() => existsSync(join(state, 'manager-events.jsonl')) && events().some((e) => e.kind === 'asks' && /improvement suggestion\(s\) to answer/.test(e.body)), 'the list under a done line is asked of the owner');
  for (const e of events()) assert.doesNotMatch(`${e.title} ${e.body}`, /STATUS: done|is done/, 'nothing reads as finished');
  // what the dashboard gets: red, the owner's turn, and no "STATUS: done" on the card
  const card = await row();
  assert.equal(card.suggestions.state, 'open');
  assert.equal(card.suggestions.open, 2);
  assert.equal(displayState(card), 'waiting');
  assert.equal(isOwnersTurn(card), true);
  assert.doesNotMatch(String(card.lastTurn?.line || ''), /done/i);

  // the manager, and a script that sends no `by` without being a browser, cannot say yes or no
  for (const [body, headers] of [[{ keys: 'yes 1, no 2', by: 'manager-agent' }, dashboard], [{ key: '1', by: 'manager-agent' }, {}], [{ keys: 'no all' }, {}], [{ keys: 'do 1 and 2', by: 'owner-relay' }, dashboard]]) {
    const r = await post('/api/send/worker-session', body, headers);
    assert.equal(r.status, 409, JSON.stringify([body, r.body]));
    assert.match(r.body.error, /only the owner may answer/);
  }
  const many = await post('/api/send-many', { sessions: ['worker-session'], keys: 'yes', by: 'manager-agent' });
  assert.equal(many.body.results[0].ok, false);
  assert.equal((await record()).items.filter((i) => i.answer).length, 0);
  // any other message goes through, marked as not the answer
  assert.equal((await post('/api/send/worker-session', { keys: 'The lane merged your branch.', by: 'manager-agent' })).status, 200);
  await until(() => existsSync(got) && /not the owner's answer to your 2 open improvement/.test(readFileSync(got, 'utf8')), 'the note is typed with it');
  await sleep(5000);
  assert.equal((await record()).items.filter((i) => i.answer).length, 0);

  // "do the 2" of a list of 2 is ambiguous (all two, or item 2): nothing is recorded and the feed asks the owner
  assert.equal((await post('/api/send/worker-session', { keys: 'do the 2' }, dashboard)).status, 200);
  await until(async () => (await feed()).some((x) => /all 2 suggestions, or only item 2\?/.test(x.title)), 'the owner is asked back');
  assert.equal((await record()).items.filter((i) => i.answer).length, 0, 'nothing recorded for the ambiguous reply');
  await sleep(4000);
  assert.equal((await post('/api/send/worker-session', { keys: 'no 2' }, dashboard)).status, 200);
  await until(async () => (await record()).items[1].answer === 'no', 'the dashboard answer is recorded');
  assert.equal((await record()).clear, undefined, 'one item is still open');
  await sleep(5000);

  // typed into the session (terminal / Remote Control): the reporter's prompt, which this server did not type
  const token = readFileSync(join(state, 'reporter.token'), 'utf8').trim();
  const typed = (text) => post('/api/reporter/event', { v: 1, event: 'prompt', session: 'worker-session', text }, { 'x-ghosty-reporter-token': token });
  await typed('The lane merged your branch.');   // what the server typed is not the owner's
  // a session started with no goal takes the first real task the owner types (not the server's own lines, not steering)
  const goal = () => { try { return JSON.parse(readFileSync(join(state, 'goals.json'), 'utf8'))['worker-session']; } catch { return undefined; } };
  await typed('continue');
  await sleep(1000);
  assert.equal(goal(), undefined);
  await typed('show the model and the effort in the dock for every session');
  await until(() => goal()?.source === 'first-owner-prompt', 'the goal comes from the owner\'s first task');
  assert.deepEqual([goal().goal, goal().parts], ['show the model and the effort in the dock for every session', []]);
  assert.equal((await record()).items[0].answer, undefined);
  assert.equal((await typed('no 1')).status, 200);
  await until(async () => (await record()).clear?.how === 'answered', 'the typed answer is recorded');
  await until(async () => !(await row()).suggestions, 'nothing left to answer: the hold is gone');
  await until(async () => (await feed()).some((x) => /worker-session is done/.test(x.title)) || (existsSync(join(state, 'push-digest.json')) && /worker-session/.test(readFileSync(join(state, 'push-digest.json'), 'utf8'))), 'the held "is done" push goes out once everything is answered');
  assert.deepEqual((await record()).items.map((i) => [i.answer, i.by, i.via]), [['no', 'owner', 'typed'], ['no', 'owner', 'dashboard']]);

  // a Mac session has no pane: the dashboard answer is recorded and handed to the manager to pass on; nobody else can give it
  const mac = await (await fetch(`${url}/api/remote/v1/stops`, { method: 'POST', headers: { authorization: `Bearer ${MAC}`, 'content-type': 'application/json' },
    body: JSON.stringify({ machine: 'mac-test', project: 'demo', session_id: 'sid-wire-mac-1', session_name: 'macrow', text: 'Suggestions:\n1. cache the list\nSTATUS: done — list fixed' }) })).json();
  const path = `/api/send/${encodeURIComponent(mac.session)}`;
  assert.equal((await post(path, { keys: 'no all', by: 'manager-agent' }, dashboard)).status, 409);
  assert.equal((await post(path, { keys: 'no all' })).status, 409, 'not a browser');
  assert.equal((await post(path, { keys: 'please rebase' }, dashboard)).status, 400);
  const ok = await post(path, { keys: 'no all' }, dashboard);
  assert.deepEqual([ok.status, ok.body.recorded, ok.body.open], [200, true, 0]);
  await until(() => readFileSync(join(state, 'manager-events.jsonl'), 'utf8').includes('pass it on with SendMessage'), 'the manager is asked to relay it');
});
