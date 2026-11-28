// integrate wait / status (token audit 2026-11-28 point d: sessions polled `integrate status` 9-14 times): `wait` is ONE long-poll per state change
// held by the server, never a client-side poll loop, and `status` on a request that is not final tells the session to stop polling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createIntegrationRoutes } from '../integration-routes.js';
import { hashToken } from '../lease-routes.js';
import { tmp } from './helpers-tmp.js';

const INTEGRATE = join(resolve(dirname(new URL(import.meta.url).pathname), '..'), 'scripts', 'integrate');
const TOKEN = 'iw-token-0123456789abcdef';
const req = (state) => ({ id: 'int-w1', repo: 'r', branch: 'feat/x', target: 'main', state, sha: state === 'merged' ? 'a'.repeat(40) : null });

async function boot(holdMs) {
  const state = tmp('iw-state-');
  mkdirSync(join(state, 'leases'), { recursive: true });
  writeFileSync(join(state, 'leases', 'clients.json'), JSON.stringify({ clients: [{ name: 'iw', sha256: hashToken(TOKEN), exemptAgents: [], integrate: true }] }));
  const calls = { wait: 0, get: 0 };
  const lane = { repoKeys: () => ['r'], repoForUrl: async () => 'r', repoForCwd: async () => 'r',
    get: () => { calls.get++; return req('running'); },
    wait: (id, ms) => { calls.wait++; calls.lastTimeoutMs = ms; return new Promise((r) => setTimeout(() => r(req('merged')), holdMs)); } };   // the server answers on the state change
  const routes = createIntegrationRoutes({ lane, stateDir: state, isLoopback: () => false, reporterOk: () => false, cidrs: '127.0.0.0/8' });
  const srv = http.createServer(async (q, s) => { if (!(await routes.handle(q, s))) { s.writeHead(404); s.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmp('iw-home-'), cfg = join(home, 'cfg'); mkdirSync(cfg); writeFileSync(join(cfg, 'token'), TOKEN, { mode: 0o600 });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const env = { PATH: '/usr/bin:/bin', HOME: home, MYCODEBOX_URL: url, GHOSTY_URL: url, MYCODEBOX_CONFIG_DIR: cfg, GHOSTY_STATE_DIR: join(home, 'st') };
  const run = (args) => new Promise((res) => execFile('sh', [INTEGRATE, ...args], { env, timeout: 30000 }, (e, stdout, stderr) => res({ code: e ? e.code : 0, stdout, stderr })));
  return { calls, run, close: () => new Promise((r) => srv.close(r)) };
}

test('integrate wait blocks on ONE server-held long-poll until the state changes, then exits with the result', async () => {
  const b = await boot(1200);
  try {
    const t0 = Date.now();
    const r = await b.run(['wait', 'int-w1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /int-w1/);
    assert.ok(Date.now() - t0 >= 1100, 'held by the server, not answered at once');
    assert.equal(b.calls.wait, 1, 'one call for one state change: no client-side poll loop');
    assert.equal(b.calls.get, 0, 'wait never polls status');
    assert.ok(b.calls.lastTimeoutMs >= 20000, `asks the server to hold up to its max (${b.calls.lastTimeoutMs} ms)`);
  } finally { await b.close(); }
});

test('integrate status on a request that is not final says: one integrate wait in the background, never poll status', async () => {
  const b = await boot(0);
  try {
    const r = await b.run(['status', 'int-w1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Not final yet: do not poll status\. Run ONE integrate wait int-w1 in the background \(run_in_background\)/);
  } finally { await b.close(); }
});

test('the help text and AGENTS.md carry the rule', () => {
  assert.match(readFileSync(INTEGRATE, 'utf8'), /never poll `integrate status` in a loop/);
  assert.match(readFileSync(join(dirname(INTEGRATE), '..', 'AGENTS.md'), 'utf8'), /one `integrate wait <id>` \(run_in_background\), never poll `integrate status` in a loop/);
});
