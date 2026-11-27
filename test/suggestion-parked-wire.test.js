// Suggestions the Opus triage parked with the owner (suggestion-triage.js, owner 2026-11-27), through the real server: listed by
// GET /api/suggestions/owner, answered only from the owner's dashboard by POST /api/suggestions/owner. Isolated tmux socket, temp state dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmp } from './helpers-tmp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const cleanups = [];
after(() => cleanups.forEach((f) => { try { f(); } catch { /* gone */ } }));

test('server: a parked suggestion is listed and only the owner\'s dashboard answers it', { timeout: 60_000, skip: !hasTmux && 'no tmux' }, async () => {
  const base = tmp('parked-wire-'), state = join(base, 'state'), home = join(base, 'home'), bin = join(base, 'bin');
  [state, home, bin].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(state, 'manager.json'), JSON.stringify({ enabled: true, aiTriage: 'off', suggestionTriage: 'off', routerShadow: false, wakeShadow: false }));
  const at = Date.now();
  writeFileSync(join(state, 'suggestions.json'), JSON.stringify({ since: at - 1000, s: { 'gone-session': { items: [
    { n: 1, tier: 'worth', text: 'add a test', at, answer: 'yes', by: 'opus', via: 'triage', built: true },
    { n: 2, tier: 'smaller', text: 'buy a paid monitoring plan', at, answer: 'owner', by: 'opus', via: 'triage', proposed: 'yes', why: 'costs money', floor: 'money', answeredAt: at },
    { n: 4, tier: 'smaller', text: 'rename the lease columns', at, answer: 'owner', by: 'opus', via: 'triage', proposed: 'no', why: 'churn', answeredAt: at },   // Opus said no: never listed (owner 2026-11-27)
    { n: 3, tier: 'worth', text: 'split the lease view into two pages', at, answer: 'owner', by: 'opus', via: 'triage', proposed: 'yes', why: 'product choice', answeredAt: at },
  ] } } }));
  const socket = `parkwire${process.pid}`, tmuxBin = join(bin, 'tmux');
  writeFileSync(tmuxBin, `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v tmux']).toString().trim()} -L ${socket} "$@"\n`); chmodSync(tmuxBin, 0o755);
  cleanups.push(() => execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: tmuxBin, GHOSTY_NO_UI_REVIEW_NIGHTLY: '1',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem'), TICK_MS: '500' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { if ((await fetch(`${url}/api/sessions`)).ok) break; } catch { /* not up */ } if (i > 150) throw new Error(`no server:\n${log}`); await sleep(100); }
  const parked = async () => (await (await fetch(`${url}/api/suggestions/owner`)).json()).items;
  const post = async (body, headers = {}) => { const r = await fetch(`${url}/api/suggestions/owner`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  const list = await parked();
  assert.deepEqual(list.map((i) => [i.session, i.n, i.proposed, i.floor]), [['gone-session', 2, 'yes', 'money'], ['gone-session', 3, 'yes', undefined]]);
  // not the owner: the manager, or a script with no browser origin, cannot answer it
  assert.equal((await post({ session: 'gone-session', n: 2, answer: 'yes', by: 'manager-agent' }, { origin: url })).status, 403);
  assert.equal((await post({ session: 'gone-session', n: 2, answer: 'yes' })).status, 403);
  assert.equal((await post({ session: 'gone-session', n: 1, answer: 'yes' }, { origin: url })).status, 404);   // not parked
  assert.equal((await post({ session: 'gone-session', n: 2, answer: 'maybe' }, { origin: url })).status, 400);
  // the owner's dashboard: recorded as the owner's
  const ok = await post({ session: 'gone-session', n: 2, answer: 'no' }, { origin: url });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.answer, ok.body.parked], ['no', 1]);
  // a yes for a session with no pane: the manager is told to pass it on
  const yes = await post({ session: 'gone-session', n: 3, answer: 'yes' }, { origin: url });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.deepEqual(await parked(), []);
  const events = readFileSync(join(state, 'manager-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => /the owner approved parked suggestion 3/.test(e.title)), JSON.stringify(events.slice(-3)));
  const item = JSON.parse(readFileSync(join(state, 'suggestions.json'), 'utf8')).s['gone-session'].items.find((i) => i.n === 2);
  assert.deepEqual([item.answer, item.by, item.via], ['no', 'owner', 'dashboard']);
});
