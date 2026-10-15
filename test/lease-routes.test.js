// HTTP front of the lease service: auth, address allowlist, body limits, long-poll, 100 parallel claims through the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes, addrAllowed, parseCidrs, hashToken, DEFAULT_CIDRS, MAX_BODY, MAX_WAIT_S, PREFIX } from '../lease-routes.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TOKEN = 'tok-mac-0123456789abcdef';   // leak-scan: allow (fake test token)
const TOKEN2 = 'tok-box-0123456789abcdef';
const DEPLOYER = 'tok-dep-0123456789abcdef';

async function boot(cidrs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-http-'));
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify({ clients: [
    { name: 'mac', sha256: hashToken(TOKEN) }, { name: 'box', sha256: hashToken(TOKEN2) },
    { name: 'deployer', sha256: hashToken(DEPLOYER), exemptAgents: ['manager:deploy', 'update_core:*'] },
  ] }));
  const service = createLeaseService({ dir, config: { envs: ['env-a'] } });
  const routes = createLeaseRoutes({ service, dir, cidrs });
  const server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const call = async (method, p, { body, token = TOKEN, headers = {}, raw } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body || raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { dir, service, routes, server, call, close: () => new Promise((r) => server.close(r)) };
}
const claim = (c, agent, resources, o = {}, token) => c.call('POST', '/claim', { body: { env: 'env-a', resources, agent, ...o }, token });

test('auth: no token, bad token, revoked token -> 401 E_AUTH; a good token works', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('GET', '/list', { token: null })).status, 401);
    assert.equal((await c.call('GET', '/list', { token: 'nope-nope-nope-nope' })).body.code, 'E_AUTH');   // leak-scan: allow (fake test token)
    assert.equal((await c.call('GET', '/list')).status, 200);
    fs.writeFileSync(path.join(c.dir, 'clients.json'), JSON.stringify({ clients: [] }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await c.call('GET', '/list')).status, 401, 'revoked without a restart');
  } finally { await c.close(); }
});

test('address allowlist: refused before authentication outside loopback / tailnet / LEASE_ALLOW_CIDRS', async () => {
  const c = await boot('198.51.100.0/24');
  try {
    const fake = (addr) => { const req = { url: `${PREFIX}/list`, method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, socket: { remoteAddress: addr }, on() {} }; const out = {}; const res = { writeHead(s) { out.status = s; }, end(b) { out.body = JSON.parse(b); }, setHeader() {} }; return c.routes.handle(req, res).then(() => out); };
    assert.equal((await fake('203.0.113.9')).status, 403);
    assert.equal((await fake('203.0.113.9')).body.code, 'E_AUTH');
    assert.equal((await fake('198.51.100.7')).status, 200, 'extra CIDR');
    assert.equal((await fake('100.64.1.2')).status, 200, 'tailnet range');   // leak-scan: allow (CGNAT test address)
    assert.equal((await fake('::ffff:127.0.0.1')).status, 200, 'mapped loopback');
    assert.equal((await fake('100.128.0.1')).status, 403, 'just outside 100.64.0.0/10');   // leak-scan: allow (CGNAT test address)
  } finally { await c.close(); }
  const cidrs = parseCidrs(DEFAULT_CIDRS.join(','));
  assert.ok(addrAllowed('fd7a:115c:a1e0::1', cidrs)); assert.ok(addrAllowed('::1', cidrs)); assert.ok(!addrAllowed('2001:db8::1', cidrs)); assert.ok(!addrAllowed('garbage', cidrs));
});

test('100 parallel claims on one resource through the API: exactly one grant', async () => {
  const c = await boot();
  try {
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => claim(c, `agent-${i}`, ['host-1/device1'])));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 409 && r.body.code === 'E_HELD').length, 99);
  } finally { await c.close(); }
});

test('claim, ticket long-poll (wakes on release), release, renew, heartbeat, narrow, mode, list, check, events, leases/:id', async () => {
  const c = await boot();
  try {
    const a = (await claim(c, 'a', ['host-1/device1'], { purpose: 'p' })).body.lease;
    assert.equal(a.client, 'mac');
    const t = (await claim(c, 'b', ['host-1/device1'], { wait: 'ticket' }, TOKEN2)).body.ticket;
    assert.equal(t.state, 'waiting');
    const t0 = Date.now();
    const poll = c.call('GET', `/tickets/${t.id}?wait=20`, { token: TOKEN2 });
    setTimeout(() => c.call('POST', '/release', { body: { id: a.id, agent: 'a' } }), 100);
    const got = await poll;
    assert.equal(got.body.ticket.state, 'granted'); assert.ok(Date.now() - t0 < 5000, 'woken by the release, not by the timeout');
    assert.equal((await c.call('GET', `/leases/${got.body.ticket.lease.id}`)).body.state, 'active');
    assert.equal((await c.call('GET', '/leases/nosuch')).status, 404);
    const l = got.body.ticket.lease;
    assert.equal((await c.call('POST', '/renew', { body: { id: l.id, ttl_min: 30 }, token: TOKEN2 })).status, 200);
    assert.equal((await c.call('POST', '/renew', { body: { id: l.id } })).status, 403, 'another client is not the holder');
    assert.equal((await c.call('POST', '/heartbeat', { body: { id: l.id, active: true, generation: l.generation + 1 }, token: TOKEN2 })).body.code, 'E_FENCED');
    assert.equal((await c.call('POST', '/mode', { body: { id: l.id, mode: 'pin' }, token: TOKEN2 })).body.lease.mode, 'pin');
    assert.equal((await c.call('GET', '/check?env=env-a&resources=host-1/device1')).body.free, true, 'a pin does not conflict');
    const ls = (await c.call('GET', '/list?env=env-a')).body;
    assert.equal(ls.leases.length, 1); assert.deepEqual(ls.tickets, []);
    const ev = (await c.call('GET', '/events?after=0')).body;
    assert.ok(ev.events.length >= 3 && ev.next >= 3);
    assert.equal((await c.call('POST', '/claim', { body: { env: 'host-1', resources: ['frontend'], agent: 'x' } })).body.code, 'E_INVALID');
    assert.equal((await c.call('GET', '/nosuch')).status, 404);
    assert.equal((await c.call('GET', '/status')).body.ok, true);
  } finally { await c.close(); }
});

test('the long-poll wait is capped at 30 seconds and a body over the limit is 413', async () => {
  const c = await boot();
  try {
    const big = JSON.stringify({ env: 'env-a', resources: ['frontend'], agent: 'a', purpose: 'x'.repeat(MAX_BODY + 10) });
    assert.equal((await c.call('POST', '/claim', { raw: big })).status, 413);
    assert.equal((await c.call('POST', '/claim', { raw: '{nope' })).status, 400);
    assert.equal((await c.call('POST', '/claim', { raw: '[]' })).status, 400);
    assert.equal(MAX_WAIT_S, 30);
  } finally { await c.close(); }
});

test('identity comes from the token: body client / exempt / owner are ignored; only the deployer client gets the exemption; owner routes log the caller', async () => {
  const c = await boot();
  try {
    const d = await c.call('POST', '/deploy/request', { body: { env: 'env-a', scope: 'host', hosts: ['host-1'], ref: 'r', agent: 'a', approved: true } });
    assert.equal(d.status, 200);
    const spoof = await claim(c, 'manager:deploy', ['host-1'], { exempt: true, client: 'deployer', owner: true });
    assert.equal(spoof.body.code, 'E_DEPLOY_PENDING', 'a mac token cannot claim the exemption by asserting it');
    const ok = await claim(c, 'manager:deploy', ['host-1'], {}, DEPLOYER);
    assert.equal(ok.status, 200); assert.equal(ok.body.lease.system, true); assert.equal(ok.body.lease.client, 'deployer');
    const other = await claim(c, 'whoever', ['host-1'], {}, DEPLOYER);
    assert.equal(other.body.code, 'E_DEPLOY_PENDING', 'the exemption is for the listed agents only');
    const l = (await claim(c, 'a', ['frontend'])).body.lease;
    assert.equal((await c.call('POST', '/release', { body: { id: l.id }, token: TOKEN2 })).status, 403);
    const forced = await c.call('POST', '/owner/release', { body: { id: l.id, by: 'owner' }, token: TOKEN2, headers: { 'tailscale-user-login': 'alice@example.test' } });
    assert.equal(forced.status, 200);
    const ev = (await c.call('GET', '/events')).body.events.find((e) => e.kind === 'forced');
    assert.equal(ev.by, 'alice@example.test via client:box', 'the real caller, never a fixed owner');
  } finally { await c.close(); }
});

test('deploy routes: request, approve, start (returns the lease), finish, list, wait, last, record', async () => {
  const c = await boot();
  try {
    const r = (await c.call('POST', '/deploy/request', { body: { env: 'env-a', scope: 'frontend', ref: 'abc', agent: 'a' } })).body;
    assert.equal((await c.call('POST', '/deploy/start', { body: { id: r.id } })).status, 400);
    assert.equal((await c.call('POST', '/deploy/approve', { body: { id: r.id } })).status, 200);
    const s = (await c.call('POST', '/deploy/start', { body: { id: r.id, agent: 'manager:deploy' } })).body;
    assert.deepEqual(s.granted, ['frontend']); assert.ok(s.lease_id);
    assert.equal((await c.call('GET', `/deploy/wait?id=${r.id}&timeout=0`)).body.final, false);
    assert.equal((await c.call('GET', '/deploy/list?env=env-a')).body.deploys[0].state, 'running');
    assert.equal((await c.call('POST', '/deploy/finish', { body: { id: r.id, status: 'done', version: 'v1' } })).status, 200);
    assert.equal((await c.call('GET', `/deploy/wait?id=${r.id}&timeout=1`)).body.success, true);
    assert.equal((await c.call('GET', '/deploy/last?env=env-a')).body.envs['env-a'].frontend.version, 'v1');
    assert.equal((await c.call('POST', '/deploy/record', { body: { env: 'env-a', scope: 'server', agent: 'u', status: 'done', ref: 'r' } })).body.targets[0], 'server');
  } finally { await c.close(); }
});

test('shadow: requests with shadow:true hit the shadow store only; reports are stored and listed; there is no route that grants through shadow into the real store', async () => {
  const c = await boot();
  try {
    const s = await claim(c, 'a', ['frontend'], { shadow: true });
    assert.equal(s.status, 200);
    assert.equal((await c.call('GET', '/list')).body.leases.length, 0);
    assert.equal((await c.call('GET', '/check?env=env-a&resources=frontend&shadow=1')).body.free, false, 'the shadow store has its own state');
    assert.equal((await c.call('POST', '/shadow-report', { body: { machine: 'host-1', command: 'claim', legacy: { code: 0 }, central: { code: 3 } } })).status, 200);
    assert.equal((await c.call('GET', '/shadow-reports')).body.reports.length, 1);
  } finally { await c.close(); }
});

test('request_id over HTTP: a retried claim returns the same lease', async () => {
  const c = await boot();
  try {
    const a = await claim(c, 'a', ['frontend'], { request_id: 'abc' });
    const b = await claim(c, 'a', ['frontend'], { request_id: 'abc' });
    assert.equal(a.body.lease.id, b.body.lease.id);
  } finally { await c.close(); }
});

test('scripts: lease-token add / list / revoke (token printed once, only the hash stored), lease-export, lease-import dry run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-scripts-'));
  const run = (script, args, input) => spawnSync('node', [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GHOSTY_STATE_DIR: dir } });
  const add = run('lease-token.js', ['add', 'mac', '--dir', dir, '--exempt', 'manager:deploy,update_core:*']);
  assert.equal(add.status, 0);
  const token = add.stdout.trim();
  assert.ok(token.length >= 40);
  const stored = fs.readFileSync(path.join(dir, 'clients.json'), 'utf8');
  assert.ok(!stored.includes(token), 'the token itself is never stored'); assert.ok(stored.includes(hashToken(token)));
  assert.equal(fs.statSync(path.join(dir, 'clients.json')).mode & 0o777, 0o600);
  const list = run('lease-token.js', ['list', '--dir', dir]);
  assert.match(list.stdout, /^mac\t/); assert.ok(!list.stdout.includes(token) && !list.stdout.includes(hashToken(token)));
  assert.notEqual(run('lease-token.js', ['add', 'mac', '--dir', dir]).status, 0, 'duplicate');
  // export from a real state dir
  const sdir = path.join(dir, 'state');
  const svc = createLeaseService({ dir: sdir, config: { envs: ['env-a'] } });
  await svc.claim({ env: 'env-a', resources: ['host-1', 'frontend'], agent: 'a' });
  const ex = JSON.parse(run('lease-export.js', ['--dir', sdir]).stdout);
  assert.deepEqual(ex.leases.map((r) => r.resource).sort(), ['frontend', 'host-1']); assert.ok(ex.leases[0].expires > 0);
  // import dry run: nothing is written, legacy ids are kept
  const legacy = JSON.stringify({ leases: [{ id: 'cafe0001', env: 'env-a', resource: 'frontend', agent: 'x', expires: Math.floor(Date.now() / 1000) + 600 }, { id: 'old00001', env: 'env-a', resource: 'server', agent: 'y', expires: 1 }], deploys: [{ id: 'dep00001', env: 'env-a', scope: 'frontend', state: 'queued' }] });
  const imp = run('lease-import.js', ['--leases', '-'], legacy);
  assert.equal(imp.status, 0); assert.match(imp.stdout, /1 lease\(s\), 1 deploy\(s\) to import, 1 skipped/); assert.match(imp.stdout, /dry run/);
  assert.equal(run('lease-token.js', ['revoke', 'mac', '--dir', dir]).status, 0);
  assert.equal(run('lease-token.js', ['list', '--dir', dir]).stdout.trim(), '');
  const imp2 = run('lease-import.js', ['--leases', '-', '--apply'], legacy);
  assert.notEqual(imp2.status, 0, '--apply needs --url and --token-file');
});

test('import through the API keeps ids; the imported lease can be released by its old id', async () => {
  const c = await boot();
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const r = await c.call('POST', '/import', { body: { leases: [{ id: 'abcd0001', env: 'env-a', resource: 'frontend', agent: 'x', expires: exp }] } });
    assert.equal(r.body.leases, 1);
    assert.equal((await c.call('POST', '/release', { body: { id: 'abcd0001' }, token: TOKEN2 })).body.released[0], 'abcd0001');
  } finally { await c.close(); }
});
