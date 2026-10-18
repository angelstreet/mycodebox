// server.js wiring of the integration lane (round 13): a real server child process; a lane request that reaches a final
// state shows in the owner's feed through brief B's notify. State dir and repos are temp; nothing live is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld } from './helpers-lane.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
after(() => { for (const c of children) c.kill('SIGKILL'); });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

test('server.js wires the lane to notify: a merged request lands in the feed with the lane wording', { timeout: 60_000 }, async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const base = mkdtempSync(join(tmpdir(), 'int-wire-')), state = join(base, 'state'), home = join(base, 'home');
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
    let item = null;
    for (let i = 0; i < 200 && !item; i++) {
      const f = await (await fetch(`${url}/api/push/feed?since=0`)).json();
      item = f.items.find((x) => x.title.includes(id) && /merged/.test(x.title));
      if (!item) await sleep(150);
    }
    assert.ok(item, `no feed item for ${id}\n${log}`);
    assert.match(item.body, new RegExp(`Integration ${id}: merged feat into main`));
    // the dashboard (same origin, no token) can read the request
    const g = await fetch(`${url}/api/integration/requests/${id}`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(g.status, 200); assert.equal((await g.json()).state, 'merged');
    // and a cross-origin page cannot
    assert.equal((await fetch(`${url}/api/integration/requests`, { headers: { origin: 'http://evil.example' } })).status, 403);
  } finally { child.kill('SIGKILL'); }
});
