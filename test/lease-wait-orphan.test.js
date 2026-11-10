// A waiting `vpt-lease claim --wait` must end with the work that started it (reported 2026-11-10: a waiter left in a background shell
// re-claimed the resource after the holder released it and held it until the TTL). Real CLI against the real service, temp state dir, fake resources.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes } from '../lease-routes.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLIENT = path.join(ROOT, 'scripts', 'vpt-lease');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-orphan-'));
const dir = path.join(tmp, 'state');
const home = path.join(tmp, 'home');
let server, service;

before(async () => {
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', 'test-machine', '--dir', dir, '--owner'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(home, 'token'), r.stdout.trim() + '\n', { mode: 0o600 });
  service = createLeaseService({ dir, config: { envs: ['env-a'] } });
  const routes = createLeaseRoutes({ service, dir });
  server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), `VPT_LEASE_MODE=central\nVPT_LEASE_URL=http://127.0.0.1:${server.address().port}\nVPT_LEASE_TOKEN_FILE=${path.join(home, 'token')}\n`);
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const ENV = { PATH: process.env.PATH, HOME: home, LANG: 'C', VPT_LEASE_TEST_FAST: '1' };
const vl = (args, env = {}) => new Promise((ok) => {      // async: the service runs in this process, a sync spawn would starve it
  const c = spawn('python3', ['-I', CLIENT, ...args], { env: { ...ENV, ...env } });
  let out = '', err = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.stdin.end();
  c.on('close', (status) => ok({ status, stdout: out, stderr: err }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const leases = async () => JSON.parse((await vl(['list', '--json'])).stdout).leases;

test('a waiter whose parent shell died is cancelled, so it never claims after the holder releases', async () => {
  const held = await vl(['claim', 'env-a', 'dev-1', '--agent', 'codebox:holder', '--kind', 'host']);
  assert.equal(held.status, 0, held.stderr);
  const holderId = held.stdout.trim();
  // the parent shell starts the waiter in the background and prints its pid, then dies (the work that needed the claim ended)
  const sh = spawn('sh', ['-c', `python3 -I ${CLIENT} claim env-a dev-1 --agent codebox:waiter --kind host --wait >/dev/null 2>&1 & echo $!; sleep 30`], { env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
  const wpid = await new Promise((ok) => sh.stdout.once('data', (c) => ok(Number(String(c).trim()))));
  await sleep(1500);
  sh.kill('SIGKILL');
  await sleep(2500);
  const stillAlive = alive(wpid);
  assert.equal((await vl(['release', holderId, '--agent', 'codebox:holder'])).status, 0);
  await sleep(1500);
  const stale = (await leases()).filter((l) => l.agent === 'codebox:waiter');
  if (stillAlive) try { process.kill(wpid, 'SIGTERM'); } catch {}
  assert.equal(stillAlive, false, 'orphaned waiter must exit');
  assert.deepEqual(stale, [], 'no stale lease for the abandoned waiter');
});

test('a live waiter whose agent releases everything (release --agent) is cancelled and never claims', async () => {
  const held = await vl(['claim', 'env-a', 'dev-2', '--agent', 'codebox:other', '--kind', 'host']);
  assert.equal(held.status, 0, held.stderr);
  const w = vl(['claim', 'env-a', 'dev-2', '--agent', 'codebox:x', '--kind', 'host', '--wait']);
  await sleep(1500);
  assert.equal((await vl(['release', '--agent', 'codebox:x'])).status, 0);
  const r = await w;
  assert.equal(r.status, 1, 'the waiting claim ends');
  assert.equal((await vl(['release', held.stdout.trim(), '--agent', 'codebox:other'])).status, 0);
  await sleep(1000);
  assert.deepEqual((await leases()).filter((l) => l.agent === 'codebox:x'), []);
});
