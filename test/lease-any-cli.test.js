// The REAL scripts/vpt-lease against the REAL lease service: claim --any / --alt, run --any (VPT_LEASE_RESOURCE), inventory,
// the free-equivalent advice and deploy release-hosts (owner 2026-10-31: never wait on a resource while an equivalent one is free).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-any-'));
const dir = path.join(tmp, 'state');
const home = path.join(tmp, 'home');
let server, base, service, token;

const tokenOf = (name, more = []) => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', name, '--dir', dir, ...more], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const writeConfig = (h, url, tokenFile, extra = '') => {
  fs.mkdirSync(path.join(h, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(h, '.config', 'vpt-lease', 'config'), `VPT_LEASE_MODE=central\nVPT_LEASE_URL=${url}\nVPT_LEASE_TOKEN_FILE=${tokenFile}\n${extra}`);
};

before(async () => {
  fs.mkdirSync(home, { recursive: true });
  token = tokenOf('test-machine', ['--owner']);   // deploy approve is owner-only
  fs.writeFileSync(path.join(home, 'token'), token + '\n', { mode: 0o600 });
  service = createLeaseService({ dir, config: { envs: ['env-a'], inventory: { 'env-a': { web: ['host-1', 'host-2'], web2: ['host-3', 'host-4'] } } } });
  const routes = createLeaseRoutes({ service, dir });
  server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  writeConfig(home, base, path.join(home, 'token'));
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function vl(args, { env = {}, input, h = home } = {}) {
  let child;
  const pr = new Promise((resolve) => {
    child = spawn('python3', ['-I', CLIENT, ...args], { env: { PATH: process.env.PATH, HOME: h, LANG: 'C', VPT_LEASE_TEST_FAST: '1', ...env } });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, out, err, lines: out.split('\n') }));
  });
  pr.child = child;
  return pr;
}

const A = ['--agent', 'codebox:t', '--kind', 'host'];

test('claim --any prints the lease id, then resource=<granted>; a busy named claim points at the free equivalent', async () => {
  const one = await vl(['claim', 'env-a', 'host-1', ...A]);
  assert.equal(one.code, 0, one.err);
  const busy = await vl(['claim', 'env-a', 'host-1', '--agent', 'codebox:u', '--kind', 'host']);
  assert.equal(busy.code, 3);
  assert.match(busy.err, /FREE EQUIVALENT NOW: host-2/);
  const any = await vl(['claim', 'env-a', '--any', 'web', '--agent', 'codebox:u', '--kind', 'host']);
  assert.equal(any.code, 0, any.err);
  const [id, res] = any.out.trim().split('\n');
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(res, 'resource=host-2');
  const inv = await vl(['inventory', 'env-a']);
  assert.match(inv.out, /web: host-1 \(held by codebox:t\)  host-2 \(held by codebox:u\)/);
  for (const l of [one.out.trim().split('\n')[0], id]) assert.equal((await vl(['release', l])).code, 0);
});

test('run --any exports the granted resource to the command; no resources and no --any is a usage error', async () => {
  const r = await vl(['run', 'env-a', '--any', 'web', ...A, '--', 'sh', '-c', 'echo "got=$VPT_LEASE_RESOURCE host=$VPT_LEASE_HOST"']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /got=host-1 host=host-1/);
  assert.equal((await vl(['claim', 'env-a', ...A])).code, 2);
  const bad = await vl(['claim', 'env-a', '--any', 'nope', ...A]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown resource group/);
});

test('deploy release-hosts frees a finished host of the running deploy', async () => {
  const q = await vl(['deploy', 'request', 'env-a', '--scope', 'host', '--hosts', 'host-1,host-2', '--ref', 'r1', '--agent', 'codebox:t', '--approved']);
  assert.equal(q.code, 0, q.err);
  const id = q.out.trim();
  assert.equal((await vl(['deploy', 'start', id])).code, 0);
  const rel = await vl(['deploy', 'release-hosts', id, '--hosts', 'host-1']);
  assert.equal(rel.code, 0, rel.err);
  assert.match(rel.out, /released host-1/);
  const c = await vl(['claim', 'env-a', 'host-1/device1', '--agent', 'codebox:v', '--kind', 'host']);
  assert.equal(c.code, 0, c.err);
  assert.equal((await vl(['deploy', 'finish', id, '--status', 'done'])).code, 0);
});

test('auto-equivalent: a named --wait claim switches to a free group member; --no-auto-equivalent and a failing --verify-profile keep waiting', async () => {
  const c3 = await vl(['claim', 'env-a', 'host-3', '--agent', 'codebox:h3', '--kind', 'host']);
  assert.equal(c3.code, 0, c3.err);
  const h3 = c3.out.trim().split('\n')[0];
  const h4 = (await vl(['claim', 'env-a', 'host-4', '--agent', 'codebox:h4', '--kind', 'host'])).out.trim().split('\n')[0];
  const sw = vl(['run', 'env-a', 'host-3', '--agent', 'codebox:w', '--kind', 'host', '--', 'sh', '-c', 'echo got=$VPT_LEASE_RESOURCE']);
  const no = vl(['claim', 'env-a', 'host-3', '--agent', 'codebox:n', '--kind', 'host', '--wait', '--no-auto-equivalent']);
  const bad = vl(['claim', 'env-a', 'host-3', '--agent', 'codebox:b', '--kind', 'host', '--wait', '--verify-profile', 'false']);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await vl(['release', h4])).code, 0);
  const r = await sw;
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /auto-equivalent: .*host-4/);
  assert.match(r.out, /got=host-4/);
  await new Promise((r2) => setTimeout(r2, 2500));
  assert.doesNotMatch((await Promise.race([no, new Promise((r3) => setTimeout(() => r3({ err: '' }), 10))])).err || '', /auto-equivalent/);
  no.child.kill(); bad.child.kill();
  const rel = await vl(['release', h3]);
  assert.equal(rel.code, 0, rel.err + ' h3=' + h3);
});
