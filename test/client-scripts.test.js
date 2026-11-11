// integrate self-update / found-bug --self-update against the real integration routes (scriptsDir = a temp "checkout"), drift warning,
// missing-found-bug hint, checksum refusal, idempotence + backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createIntegrationRoutes } from '../integration-routes.js';
import { hashToken } from '../lease-routes.js';
import { manifest, versionOf } from '../client-scripts.js';
import { tmp } from './helpers-tmp.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SCRIPTS = join(ROOT, 'scripts');
const TOKEN = 'cs-token-0123456789abcdef';

function run(bin, args, env) {
  return new Promise((res) => execFile('sh', [bin, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, timeout: 30000 }, (e, stdout, stderr) => res({ code: e ? e.code : 0, stdout, stderr })));
}
async function boot({ tamper = false, lane = {} } = {}) {
  const state = tmp('cs-state-'), served = tmp('cs-served-');
  for (const n of ['integrate', 'found-bug']) copyFileSync(join(SCRIPTS, n), join(served, n));
  const mf0 = manifest(served);   // the manifest sha is of the real file; a tampered body then fails the client's check
  mkdirSync(join(state, 'leases'), { recursive: true });
  writeFileSync(join(state, 'leases', 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-t', sha256: hashToken(TOKEN), exemptAgents: [], integrate: true }] }));
  const routes = createIntegrationRoutes({ lane: { enqueue: () => ({ id: 'int-1', position: 1, repo: 'r' }), repoForUrl: async () => 'r', repoForCwd: async () => 'r', repoKeys: () => ['r'], ...lane }, stateDir: state, isLoopback: () => false, reporterOk: () => false, scriptsDir: served, cidrs: '127.0.0.0/8' });
  const srv = http.createServer(async (req, res) => {
    if (tamper && req.url.includes('/client-scripts/integrate')) { res.writeHead(200); return res.end('#!/bin/sh\necho evil\n'); }
    if (req.method === 'POST' && req.url === '/api/bugs') { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"id":"bug-1"}'); }
    if (!(await routes.handle(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, served, mf0, close: () => new Promise((r) => srv.close(r)) };
}
function client() {
  const home = tmp('cs-home-'), cfg = join(home, 'cfg'), bin = join(home, 'bin');
  mkdirSync(cfg); mkdirSync(bin); writeFileSync(join(cfg, 'token'), TOKEN, { mode: 0o600 });
  return { home, cfg, bin, env: (url) => ({ HOME: home, MYCODEBOX_URL: url, GHOSTY_URL: url, MYCODEBOX_CONFIG_DIR: cfg, MYCODEBOX_BIN_DIR: bin, GHOSTY_STATE_DIR: join(home, 'st') }) };
}

test('both scripts carry the same CLIENT_SCRIPTS_VERSION and the server reads it', () => {
  const m = manifest(SCRIPTS);
  assert.ok(m.files.integrate.version >= 1);
  assert.equal(m.files.integrate.version, m.files['found-bug'].version);
  assert.equal(versionOf(readFileSync(join(SCRIPTS, 'integrate'), 'utf8')), m.version);
});

test('the route needs an integrate client token', async () => {
  const b = await boot();
  try {
    const get = (h) => new Promise((r) => http.get(`${b.url}/api/integration/client-scripts`, { headers: h }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(await get({}), 403);
    assert.equal(await get({ authorization: 'Bearer wrong-wrong-wrong' }), 401);
    assert.equal(await get({ authorization: `Bearer ${TOKEN}` }), 200);
  } finally { await b.close(); }
});

test('integrate self-update installs both scripts, keeps a backup, is idempotent', async () => {
  const b = await boot(), c = client();
  try {
    writeFileSync(join(c.bin, 'found-bug'), '#!/bin/sh\necho old\n'); chmodSync(join(c.bin, 'found-bug'), 0o755);
    const r1 = await run(join(SCRIPTS, 'integrate'), ['self-update'], c.env(b.url));
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stdout, /updated integrate/); assert.match(r1.stdout, /updated found-bug/);
    assert.equal(readFileSync(join(c.bin, 'found-bug'), 'utf8'), readFileSync(join(SCRIPTS, 'found-bug'), 'utf8'));
    assert.equal(readFileSync(join(c.bin, 'found-bug.bak'), 'utf8'), '#!/bin/sh\necho old\n');
    assert.ok(statSync(join(c.bin, 'integrate')).mode & 0o100, 'executable');
    const r2 = await run(join(c.bin, 'integrate'), ['self-update'], c.env(b.url));   // the installed copy updates itself
    assert.equal(r2.code, 0, r2.stderr); assert.match(r2.stdout, /current/); assert.doesNotMatch(r2.stdout, /updated/);
    const r3 = await run(join(c.bin, 'found-bug'), ['--self-update'], c.env(b.url));
    assert.equal(r3.code, 0, r3.stderr); assert.match(r3.stdout, /current/);
  } finally { await b.close(); }
});

test('a checksum mismatch installs nothing', async () => {
  const b = await boot({ tamper: true }), c = client();
  try {
    const r = await run(join(SCRIPTS, 'integrate'), ['self-update'], c.env(b.url));
    assert.notEqual(r.code, 0); assert.match(r.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(c.bin, 'integrate')), false);
  } finally { await b.close(); }
});

test('integrate request: ONE drift line when the server is newer, and the found-bug hint when it is missing', async () => {
  const b = await boot(), c = client();
  try {
    const old = readFileSync(join(SCRIPTS, 'integrate'), 'utf8').replace(/^CLIENT_SCRIPTS_VERSION=\d+/m, 'CLIENT_SCRIPTS_VERSION=0');
    const p = join(c.home, 'integrate-old'); writeFileSync(p, old);
    const r = await run(p, ['request', 'feat/x', '--repo', 'r'], c.env(b.url));
    assert.equal(r.code, 0, r.stderr);
    assert.equal((r.stdout.match(/client scripts are old/g) || []).length, 1);
    assert.match(r.stdout, /run integrate self-update/);
    assert.match(r.stdout, /found-bug is not installed here: run integrate self-update/);
    const cur = await run(join(SCRIPTS, 'integrate'), ['request', 'feat/x', '--repo', 'r'], c.env(b.url));
    assert.doesNotMatch(cur.stdout, /client scripts are old/);
  } finally { await b.close(); }
});

test('found-bug prints ONE drift line after filing when its version is older', async () => {
  const b = await boot(), c = client();
  try {
    const p = join(c.home, 'found-bug-old'); writeFileSync(p, readFileSync(join(SCRIPTS, 'found-bug'), 'utf8').replace(/^CLIENT_SCRIPTS_VERSION=\d+/m, 'CLIENT_SCRIPTS_VERSION=0'));
    const r = await run(p, ['--title', 't', '--session', 's'], c.env(b.url));
    assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /filed bug-1/);
    assert.equal((r.stdout.match(/client scripts are old/g) || []).length, 1);
    const cur = await run(join(SCRIPTS, 'found-bug'), ['--title', 't', '--session', 's'], c.env(b.url));
    assert.doesNotMatch(cur.stdout, /client scripts are old/);
  } finally { await b.close(); }
});
