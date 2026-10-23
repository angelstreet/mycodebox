// server.js wiring of the integration lane (round 13): a real server child process; a lane request that reaches a final
// state notifies the owner through brief B's notify. State dir and repos are temp; nothing live is touched.
// A merged request takes no feed slot (owner 2026-10-23): it waits for the periodic digest, and the manager event
// still fires, so the manager wakes on it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
after(() => { for (const c of children) c.kill('SIGKILL'); });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// the digest waiting for its next tick, and the manager event feed
const pendingOf = (state) => { try { return JSON.parse(readFileSync(join(state, 'push-digest.json'), 'utf8')).pending || []; } catch { return []; } };
const eventsOf = (state) => { try { return readFileSync(join(state, 'manager-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };

test('server.js wires the lane to notify: a merged request waits for the digest and still wakes the manager', { timeout: 60_000 }, async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const base = tmp('int-wire-'), state = join(base, 'state'), home = join(base, 'home');
  mkdirSync(state, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(state, 'integration.json'), JSON.stringify({ repos: { 'env-a': w.cfg() } }));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: '/bin/false',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${url}/api/sessions`)).ok) break; } catch { /* not up yet */ }
      if (i > 150) throw new Error(`server did not start:\n${log}`);
      await sleep(100);
    }
    const tokenFile = join(state, 'reporter.token');
    assert.ok(existsSync(tokenFile), 'reporter token file');
    const token = readFileSync(tokenFile, 'utf8').trim();
    const q = await fetch(`${url}/api/integration/requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ghosty-reporter-token': token }, body: JSON.stringify({ repo: 'env-a', branch: 'feat' }) });
    assert.equal(q.status, 200, log);
    const { id } = await q.json();
    let pending = null, event = null;
    for (let i = 0; i < 200 && !(pending && event); i++) {
      const f = await (await fetch(`${url}/api/push/feed?since=0`)).json();
      assert.equal(f.items.find((x) => x.title.includes(id) && /merged/.test(x.title)), undefined, 'a merged request must not take a feed slot');
      pending = pendingOf(state).find((p) => p.title.includes(id) && /merged/.test(p.title)) || null;
      event = eventsOf(state).find((e) => e.key === `integration:${id}:merged`) || null;
      if (!(pending && event)) await sleep(150);
    }
    assert.ok(pending, `the merged notice never reached the digest\n${log}`);
    assert.match(pending.body, new RegExp(`Integration ${id}: merged feat into main`));
    assert.ok(event, `the manager never woke on the merged request\n${log}`);
    // the dashboard (same origin, no token) can read the request
    const g = await fetch(`${url}/api/integration/requests/${id}`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(g.status, 200); assert.equal((await g.json()).state, 'merged');
    // and a cross-origin page cannot
    assert.equal((await fetch(`${url}/api/integration/requests`, { headers: { origin: 'http://evil.example' } })).status, 403);
  } finally { child.kill('SIGKILL'); }
});

test('a request resumed at boot (pushed, deploy pending) finds notify and deploys wired', { timeout: 60_000 }, async () => {
  const w = makeWorld();
  const base = tmp('int-wire-'), state = join(base, 'state'), home = join(base, 'home');
  mkdirSync(join(state, 'integration'), { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(state, 'integration.json'), JSON.stringify({ repos: { 'env-a': w.cfg(), 'env-b': w.cfg({ deploy: { env: 'env-b', defaultScope: 'server' } }) } }));
  const sha = 'a'.repeat(40), at = new Date().toISOString();
  const seed = (id, seq, repo, extra) => ({ id, seq, repo, branch: 'feat', target: 'main', session: null, deployScope: null, state: 'running', createdAt: at, updatedAt: at, startedAt: at,
    endedAt: null, step: 'push', steps: [], reason: null, tail: '', sha, branchSha: sha, pushed: true, ci: null, deployed: null, ...extra });
  writeFileSync(join(state, 'integration', 'requests.jsonl'), `${JSON.stringify(seed('int-seedmerged', 1, 'env-a'))}\n${JSON.stringify(seed('int-seeddeploy', 2, 'env-b', { deployScope: 'server', deployId: 'd9' }))}\n`);
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: '/bin/false',
    TLS_KEY: join(base, 'none.pem'), TLS_CERT: join(base, 'none.pem') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${url}/api/sessions`)).ok) break; } catch { /* not up yet */ }
      if (i > 150) throw new Error(`server did not start:\n${log}`);
      await sleep(100);
    }
    let pending = null, event = null;
    for (let i = 0; i < 100 && !(pending && event); i++) {
      pending = pendingOf(state).find((p) => p.title.includes('int-seedmerged')) || null;
      event = eventsOf(state).find((e) => e.key === 'integration:int-seedmerged:merged') || null;
      if (!(pending && event)) await sleep(100);
    }
    assert.ok(pending, `the resumed request's final notice never reached the digest\n${log}`);
    assert.ok(event, `the resumed request never woke the manager\n${log}`);
    await sleep(1500);   // the deploy keeps waiting on its recorded deploy id; it is not failed by an unwired adapter
    const g = await (await fetch(`${url}/api/integration/requests/int-seeddeploy`, { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(g.state, 'running', JSON.stringify(g.request?.reason));
    assert.doesNotMatch(log, /not wired/);
  } finally { child.kill('SIGKILL'); }
});
