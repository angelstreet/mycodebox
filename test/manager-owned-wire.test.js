// A manager-started session through the real server (manager-owned.js, owner 2026-11-26): an isolated tmux socket and a stand-in agent pane that
// ends a turn on "STATUS: needs-owner", then one on a suggestion list. No owner push, not the owner's turn; the manager gets the event and may answer.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const cleanups = [];
after(() => cleanups.forEach((f) => { try { f(); } catch { /* gone */ } }));

test('server: a manager-started session asks the manager, never the owner; the manager answers its suggestions; nobody automatic does', { timeout: 150_000, skip: !hasTmux && 'no tmux' }, async () => {
  const base = tmp('mowned-wire-'), state = join(base, 'state'), home = join(base, 'home'), bin = join(base, 'bin');
  [state, home, bin].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(state, 'manager.json'), JSON.stringify({ enabled: true, aiTriage: 'off', routerShadow: false, wakeShadow: false }));
  writeFileSync(join(state, 'sessions.json'), JSON.stringify({ 'worker-session': { priority: 'P2', paused: false, seenAt: Date.now(), startedBy: 'manager' } }));
  // the reflection question was already asked (the done check sends it on its own 5-min tick): answering the last item then ends the session's work
  writeFileSync(join(state, 'suggestions.json'), JSON.stringify({ since: 1, s: { 'worker-session': { asked: { at: 1, sig: 'earlier-done' }, items: [] } } }));
  const socket = `mownedwire${process.pid}`, tmuxBin = join(bin, 'tmux');
  writeFileSync(tmuxBin, `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v tmux']).toString().trim()} -L ${socket} "$@"\n`); chmodSync(tmuxBin, 0o755);
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
  if [ $n = 1 ]; then printf '  STATUS: needs-owner: which of the two layouts should I keep for turn %s?\\n\\n✻ Crunched for 3s\\n\\n' $n
  else printf '  Suggestions:\\n  - add a retry on the walk\\n  - shorter journal rows\\n\\n  STATUS: done — turn-%s finished\\n\\n✻ Crunched for 3s\\n\\n' $n; fi
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
  const post = async (path, body, headers = {}) => { const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const record = async () => (await (await fetch(`${url}/api/suggestions`)).json()).sessions['worker-session'];
  const feed = async () => (await (await fetch(`${url}/api/push/feed?since=0`)).json()).items;
  const row = async () => (await (await fetch(`${url}/api/sessions`)).json()).status['worker-session'];
  const jsonl = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const asks = () => jsonl('manager-events.jsonl').filter((e) => e.key === 'worker-session:needs-manager');
  const until = async (ok, what) => { for (let i = 0; i < 80; i++) { if (await ok()) return; await sleep(500); } throw new Error(`${what}\n${JSON.stringify(await row())}\n${JSON.stringify(jsonl('manager-events.jsonl'))}\n${log.slice(-3000)}`); };
  const noOwnerAsk = async () => assert.deepEqual((await feed()).filter((x) => /worker-session.*(needs you|asks you|is done)/.test(x.title)), []);
  const dashboard = { origin: url };

  // 1. a needs-owner ending: a manager event, no owner push, not red, not in NEEDS YOU
  assert.equal((await post('/api/send/worker-session', { keys: 'start the task' }, dashboard)).status, 200);
  await until(() => asks().length >= 1, 'the needs-owner stop becomes a needs-manager event');
  await sleep(4000);
  await noOwnerAsk();
  assert.match(asks().at(-1).body, /needs the manager.*you started it.*manager-ask\.js --source worker-session/);
  let card = await row();
  assert.equal(card.managerStarted, true);
  assert.equal(isOwnersTurn(card), false);
  assert.equal(displayState(card), 'manager');

  // its mockup reaches the manager, not the owner's feed
  const mock = await post('/api/mockups', { session: 'worker-session', title: 'New layout', url: 'https://example.test/m.html' }, { 'x-ghosty-reporter-token': readFileSync(join(state, 'reporter.token'), 'utf8').trim() });
  assert.deepEqual([mock.status, mock.body.to, mock.body.feedId], [200, 'manager', null], JSON.stringify(mock.body));
  assert.deepEqual((await feed()).filter((x) => /^Mockup:/.test(x.title)), []);
  await until(() => jsonl('manager-events.jsonl').some((e) => e.key === 'worker-session:mockup' && e.body.includes(`/api/mockups/${mock.body.id}/object`)), 'the manager has the mockup');

  // 2. suggestions: asked of the manager; an automatic or peer answer is refused, the manager's is recorded as the manager's
  assert.equal((await post('/api/send/worker-session', { keys: 'list your ideas' }, dashboard)).status, 200);
  await until(async () => (await record())?.items.length === 2, 'the list is recorded');
  await until(() => asks().some((e) => /2 suggestion\(s\).*"by":"manager-agent"/.test(e.body)), 'the manager is asked, with how to answer');
  await sleep(3000);
  await noOwnerAsk();
  card = await row();
  assert.equal(card.suggestions.state, 'open');
  assert.equal(isOwnersTurn(card), false);
  assert.equal(displayState(card), 'manager');
  for (const body of [{ keys: 'yes 1, no 2', by: 'ghosty-auto' }, { keys: 'no all', by: 'some-peer' }, { keys: 'no all' }, { key: '1', by: 'manager-agent' }]) {
    assert.equal((await post('/api/send/worker-session', body)).status, 409, JSON.stringify(body));
  }
  assert.equal((await post('/api/send/worker-session', { keys: 'do the 2', by: 'manager-agent' })).status, 400);
  assert.equal((await record()).items.filter((i) => i.answer).length, 0);
  const ok = await post('/api/send/worker-session', { keys: 'no all', by: 'manager-agent' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await until(async () => (await record()).items.every((i) => i.answer === 'no'), 'recorded');
  assert.deepEqual((await record()).items.map((i) => i.by), ['manager', 'manager']);
  await until(() => jsonl('manager-decisions.jsonl').some((d) => d.session === 'worker-session' && /suggestions: 1 no/.test(d.what)), 'shown to the owner in Decided for you');

  // really done (done accepted, nothing open): the manager is told once that it can close it, and nothing closes it
  const ready = () => jsonl('manager-events.jsonl').filter((e) => e.key === 'worker-session:ready-to-close');
  await until(() => ready().length === 1, 'ready-to-close event');
  assert.match(ready()[0].body, /DELETE \/api\/sessions\/worker-session\?confirm=worker-session/);
  await sleep(4000);
  assert.equal(ready().length, 1, 'once');
  assert.ok(await row(), 'the session is still there');

  // 3. a session this one starts is the manager's too (its name used to be refused as started_by, so nothing was recorded)
  const token = readFileSync(join(state, 'reporter.token'), 'utf8').trim();
  const started = await post('/api/history/started', { name: 'grandchild', provider: 'claude', model: null, cwd: base, started_by: 'worker-session' }, { 'x-ghosty-reporter-token': token });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.record.parent, 'worker-session');
  assert.equal(JSON.parse(readFileSync(join(state, 'sessions.json'), 'utf8')).grandchild.startedBy, 'worker-session');
});
