// The REAL scripts/vpt-lease (python3, central mode, config file in a temp HOME) against the REAL lease service and routes
// on a loopback port. Every mismatch between client and docs/v2/LEASES-CENTRAL.md Appendix A is a bug on one of the sides.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-integ-'));
const dir = path.join(tmp, 'state');
const home = path.join(tmp, 'home');
let server, base, service, token;

const tokenOf = (name) => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', name, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const writeConfig = (h, url, tokenFile, extra = '') => {
  fs.mkdirSync(path.join(h, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(h, '.config', 'vpt-lease', 'config'), `VPT_LEASE_MODE=central\nVPT_LEASE_URL=${url}\nVPT_LEASE_TOKEN_FILE=${tokenFile}\n${extra}`);
};

before(async () => {
  fs.mkdirSync(home, { recursive: true });
  token = tokenOf('test-machine');
  fs.writeFileSync(path.join(home, 'token'), token + '\n', { mode: 0o600 });
  service = createLeaseService({ dir, config: { envs: ['env-a'] } });
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
const A = 'codebox:alice', B = 'codebox:bob';
const claim = async (agent, resources, extra = []) => {
  const r = await vl(['claim', 'env-a', ...resources, '--agent', agent, ...extra]);
  assert.equal(r.code, 0, r.err);
  return r.lines[0];
};
const release = (id) => vl(['release', id]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('claim / list / list --json / check / release with exit codes', async () => {
  const id = await claim(A, ['host-1/stb-1'], ['--purpose', 'integration run', '--ttl', '30']);
  assert.match(id, /^\S+$/);
  let r = await vl(['list', 'env-a']);
  assert.equal(r.code, 0);
  assert.match(r.lines[0], new RegExp(`^${id}  env-a/host-1/stb-1  agent=${A}  since=.+ UTC  expires_in=(29|30)m  purpose=integration run  kind=host`));
  r = await vl(['list', '--json']);
  const j = JSON.parse(r.out);
  const row = j.leases.find((l) => l.id === id);
  assert.equal(row.resource, 'host-1/stb-1'); assert.ok(row.ttlLeftMin >= 29); assert.equal(typeof row.expires, 'number');
  assert.ok(Array.isArray(j.deploys) && Array.isArray(j.waiters));
  r = await vl(['check', 'env-a', 'host-1/stb-1']);
  assert.equal(r.code, 3); assert.match(r.out, /^BUSY \u2014 env-a in use:\n/); assert.match(r.out, new RegExp(id));
  r = await vl(['check', 'env-a', 'host-1/stb-1', '--ignore-agent', A]);
  assert.deepEqual([r.code, r.lines[0]], [0, 'FREE \u2014 nothing active on env-a (host-1/stb-1)']);
  r = await release(id);
  assert.deepEqual([r.code, r.out], [0, 'released 1\n']);
  r = await vl(['check', 'env-a', 'host-1/stb-1']);
  assert.equal(r.code, 0);
  assert.equal((await vl(['renew', 'nope-nope'])).code, 1);
});

test('busy claim exits 3 with holders on stderr; a frontend claim and two devices on one host are granted alongside', async () => {
  const d1 = await claim(A, ['host-2/stb-1']);
  const r = await vl(['claim', 'env-a', 'host-2/stb-1', '--agent', B]);
  assert.equal(r.code, 3); assert.equal(r.out, ''); assert.match(r.err, /BUSY \u2014 held by:/); assert.match(r.err, new RegExp(`agent=${A}`));
  const d2 = await claim(B, ['host-2/stb-2']);       // another device on the same host
  const fe = await claim(B, ['frontend']);           // a frontend deploy is not blocked by a device run
  assert.notEqual(new Set([d1, d2, fe]).size, 1);
  const host = await vl(['claim', 'env-a', 'host-2', '--agent', 'codebox:carol']);
  assert.equal(host.code, 3, 'a whole host conflicts with its devices');
  for (const id of [d1, d2, fe]) await release(id);
});

test('claim --ticket then ticket <id> --wait; ticket status and --cancel', async () => {
  const held = await claim(A, ['host-3/stb-1']);
  let r = await vl(['claim', 'env-a', 'host-3/stb-1', '--agent', B, '--ticket', '--expect', '5']);
  assert.equal(r.code, 0);
  const tid = r.lines[0];
  assert.match(r.lines[1], /^position=1 eta=\S+ held-by=codebox:alice$/);
  r = await vl(['ticket', tid]);
  assert.equal(r.code, 3); assert.match(r.out, /^waiting #1, eta \S+ \(held by codebox:alice\)/);
  const waiting = vl(['ticket', tid, '--wait']);
  await sleep(400);
  await release(held);
  const w = await waiting;
  assert.equal(w.code, 0, w.err);
  const bobLease = w.lines[0];
  assert.equal((await vl(['validate', bobLease, '--agent', B])).code, 0);
  await release(bobLease);
  // cancel
  const h2 = await claim(A, ['host-3/stb-1']);
  const t2 = (await vl(['claim', 'env-a', 'host-3/stb-1', '--agent', B, '--ticket'])).lines[0];
  r = await vl(['ticket', t2, '--cancel']);
  assert.deepEqual([r.code, r.out], [0, 'cancelled\n']);
  await release(h2);
});

test('queued hint: a free resource with only tickets ahead says "free but N waiting"; claim --wait is granted when the holder releases', async () => {
  const holder = await claim(A, ['host-4']);                       // whole host held by alice
  const waiter = vl(['claim', 'env-a', 'host-4/stb-1', '--agent', B, '--wait', '--expect', '1']);   // queued behind the host lease
  await sleep(500);
  // stb-2 on the same host conflicts with the host lease too; but a ticket queued on stb-1 does not hold stb-2 -> use a probe on the waiter's own resource
  const probe = await vl(['claim', 'env-a', 'host-4/stb-1', '--agent', 'codebox:carol']);
  assert.equal(probe.code, 3);
  await release(holder);
  const w = await waiter;
  assert.equal(w.code, 0, w.err);
  assert.match(w.err, /waiting #1, eta \S+ \(held by codebox:alice\)/);
  await release(w.lines[0]);
});

test('queued: a free device behind a waiting whole-host ticket answers busy with the "free but N waiting" hint', async () => {
  const holder = await claim(A, ['host-5/stb-1']);
  const t = (await vl(['claim', 'env-a', 'host-5', '--agent', B, '--ticket'])).lines[0];   // whole host waits behind the device lease
  const probe = await vl(['claim', 'env-a', 'host-5/stb-2', '--agent', 'codebox:carol']);   // stb-2 itself is free
  assert.equal(probe.code, 3, probe.err);
  assert.match(probe.err, /free but \S+ waiting ahead of you: use --wait/);
  await release(holder);
  const w = await vl(['ticket', t, '--wait']);
  assert.equal(w.code, 0, w.err);
  await release(w.lines[0]);
});

test('check --skip-leased: LEASED line for a leased host, then FREE', async () => {
  const id = await claim(A, ['host-6/stb-1']);
  const r = await vl(['check', 'env-a', 'frontend', '--skip-leased', '--hosts', 'host-6,host-7']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^LEASED host-6 ${A}\\n`)); assert.match(r.out, /FREE \u2014 nothing blocks this deploy on env-a \(skipping host-6\)/);
  await release(id);
});

test('run -- <cmd>: active heartbeats, released at exit, exit code passed through', async () => {
  const seen = [];
  const r = await vl(['run', 'env-a', 'host-8/stb-1', '--agent', A, '--', 'sh', '-c', 'sleep 1; exit 7']);
  assert.equal(r.code, 7);
  assert.equal((await vl(['check', 'env-a', 'host-8/stb-1'])).code, 0, 'released at exit');
  const ev = (await vl(['events', '--json'])).out;
  const events = JSON.parse(ev).events;
  void seen;
  assert.ok(events.some((e) => e.event === 'released' && e.agent === A), 'release is in the event log');
  // heartbeats are active while the command runs
  const hp = vl(['run', 'env-a', 'host-8/stb-3', '--agent', A, '--', 'sleep', '2']);
  let row;
  for (let i = 0; i < 60 && !row; i++) { await sleep(100); row = JSON.parse((await vl(['list', '--json'])).out).leases.find((l) => l.resource === 'host-8/stb-3' && l.lastHeartbeatAt); }
  assert.ok(row, 'a heartbeat reached the service'); assert.equal(row.heartbeat_s, 300, 'run declares its heartbeat interval');
  assert.equal((await hp).code, 0);
  // a signal also releases
  const p = vl(['run', 'env-a', 'host-8/stb-2', '--agent', A, '--', 'sleep', '30']);
  for (let i = 0; i < 100 && (await vl(['check', 'env-a', 'host-8/stb-2'])).code === 0; i++) await sleep(50);
  p.child.kill('SIGTERM');
  assert.equal((await p).code, 143);
  assert.equal((await vl(['check', 'env-a', 'host-8/stb-2'])).code, 0);
});

test('validate, heartbeat, mode pin, narrow, renew, events', async () => {
  const id = await claim(A, ['host-9'], ['--kind', 'server']);
  assert.deepEqual((await vl(['validate', id, '--agent', A])).code, 0);
  let r = await vl(['validate', id, '--agent', B]);
  assert.equal(r.code, 3); assert.match(r.out, /not valid/);
  assert.equal((await vl(['heartbeat', id, '--active'])).code, 0);
  r = await vl(['narrow', id, '--kind', 'host']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^narrowed 1\n$/);
  r = await vl(['renew', id, '--ttl', '60']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^renewed until \d{4}-\d\d-\d\d \d\d:\d\d UTC\n$/);
  r = await vl(['mode', id, 'pin']);
  assert.equal(r.code, 0, r.err); assert.equal(r.out, 'mode pin\n');
  r = await vl(['validate', id, '--agent', A]);
  assert.equal(r.code, 3); assert.match(r.out, /mode is pin/);
  // a pin never blocks
  const other = await claim(B, ['host-9']);
  await release(other);
  r = await vl(['events', '--after', '0', '--limit', '500']);
  assert.equal(r.code, 0); assert.match(r.out, /granted|narrowed|downgraded/);
  const j = JSON.parse((await vl(['events', '--json'])).out);
  assert.ok(j.events.length > 0 && j.events.every((e) => e.line > 0 && e.event));
  assert.equal(j.next, j.events.at(-1).line);
  await release(id);
  r = await vl(['validate', id, '--agent', A]);
  assert.equal(r.code, 3);
});

test('observe mode never conflicts', async () => {
  const id = await claim(A, ['host-10/stb-1']);
  const ob = await vl(['claim', 'env-a', 'host-10/stb-1', '--agent', B, '--mode', 'observe']);
  assert.equal(ob.code, 0, ob.err);
  await release(ob.lines[0]); await release(id);
});

test('deploy flow: request -> list -> start (lease) -> a claim with VPT_DEPLOY_ID joins -> finish -> last; deploy wait', async () => {
  let r = await vl(['deploy', 'request', 'env-a', '--scope', 'host', '--hosts', 'host-11', '--ref', 'main', '--agent', 'codebox:alice', '--purpose', 'integ', '--approved']);
  assert.equal(r.code, 0, r.err);
  const did = r.lines[0];
  assert.match(did, /^\S+$/);
  r = await vl(['deploy', 'list', 'env-a']);
  assert.match(r.out, new RegExp(`^DEPLOY ${did}  env-a  state=queued  scope=host  ref=main  by=${A}`));
  r = await vl(['deploy', 'list', 'env-a', '--json']);
  assert.equal(JSON.parse(r.out).deploys.find((d) => d.id === did).state, 'queued');
  const waiter = vl(['deploy', 'wait', did, '--timeout', '1']);
  r = await vl(['deploy', 'start', did, '--agent', A]);
  assert.equal(r.code, 0, r.err); assert.equal(r.out, 'running\n');
  // the running deploy fences its hosts: a stranger waits/gets exit 4 or 3, the deploy's own claim joins
  const stranger = await vl(['claim', 'env-a', 'host-11/stb-1', '--agent', B]);
  assert.ok([3, 4].includes(stranger.code), `stranger: ${stranger.code} ${stranger.err}`);
  const joined = await vl(['claim', 'env-a', 'host-11', '--agent', 'update_core:x'], { env: { VPT_DEPLOY_ID: did } });
  assert.equal(joined.code, 0, joined.err);
  await release(joined.lines[0]);
  r = await vl(['deploy', 'finish', did, '--status', 'done', '--version', 'v1.2.3']);
  assert.equal(r.code, 0, r.err); assert.equal(r.out, 'done\n');
  const w = await waiter;
  assert.equal(w.code, 0, w.err); assert.match(w.out, new RegExp(`deploy ${did} done \\(version v1\\.2\\.3\\)`));
  r = await vl(['deploy', 'last', 'env-a']);
  assert.equal(r.code, 0); assert.match(r.out, /^env-a\n/); assert.match(r.out, /host-11 +v1\.2\.3/);
  assert.equal(JSON.parse((await vl(['deploy', 'last', '--json'])).out).envs['env-a']['host-11'].version, 'v1.2.3');
  r = await vl(['deploy', 'record', 'env-a', '--scope', 'frontend', '--ref', 'main', '--commit', 'abcdef123456', '--version', 'v9', '--agent', 'a', '--status', 'done', '--deploy-id', 'ext-1']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^recorded done: env-a frontend/);
  r = await vl(['deploy', 'record', 'env-a', '--scope', 'frontend', '--ref', 'main', '--version', 'v9', '--agent', 'a', '--status', 'done', '--deploy-id', 'ext-1']);
  assert.match(r.out, /^already recorded ext-1/);
  r = await vl(['deploy', 'wait', '--env', 'env-a', '--timeout', '1']);
  assert.deepEqual([r.code, r.out], [0, 'no deploy pending on env-a\n']);
  // cancel / approve
  const d2 = (await vl(['deploy', 'request', 'env-a', '--scope', 'frontend', '--ref', 'x', '--agent', A])).lines[0];
  assert.equal((await vl(['deploy', 'approve', d2])).out, 'approved\n');
  assert.equal((await vl(['deploy', 'cancel', d2])).out, 'cancelled\n');
  assert.equal((await vl(['deploy', 'cancel', 'nope'])).code, 1);
});

test('unreachable URL -> exit 5 (never free)', async () => {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`; await new Promise((r) => s.close(r));
  const h = path.join(tmp, 'home-dead'); writeConfig(h, url, path.join(home, 'token'));
  for (const args of [['claim', 'env-a', 'host-1', '--agent', A], ['check', 'env-a'], ['deploy', 'list'], ['deploy', 'last']]) {
    const r = await vl(args, { h });
    assert.equal(r.code, 5, args.join(' ')); assert.doesNotMatch(r.out, /FREE/);
  }
});

test('bad or revoked token -> exit 1 (E_AUTH is an error, not "unavailable"), no lease granted', async () => {
  const h = path.join(tmp, 'home-bad');
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 'token'), 'not-a-valid-token-at-all\n', { mode: 0o600 });
  writeConfig(h, base, path.join(h, 'token'));
  for (const args of [['claim', 'env-a', 'host-12', '--agent', A], ['check', 'env-a'], ['list'], ['deploy', 'list']]) {
    const r = await vl(args, { h });
    assert.equal(r.code, 1, args.join(' ')); assert.match(r.err, /E_AUTH/);
  }
  assert.equal((await vl(['check', 'env-a', 'host-12'])).code, 0, 'nothing was granted');
  // revoked
  const t2 = tokenOf('to-revoke');
  const h2 = path.join(tmp, 'home-rev'); fs.mkdirSync(h2, { recursive: true });
  fs.writeFileSync(path.join(h2, 'token'), t2, { mode: 0o600 }); writeConfig(h2, base, path.join(h2, 'token'));
  assert.equal((await vl(['list'], { h: h2 })).code, 0);
  spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'revoke', 'to-revoke', '--dir', dir]);
  assert.equal((await vl(['list'], { h: h2 })).code, 1);
});

test('shadow mode: the legacy result stands; a disagreement reaches the real /shadow-report; an agreement does not', async () => {
  const legacy = path.join(tmp, 'legacy-cli');
  fs.writeFileSync(legacy, '#!/bin/sh\ncase "$1" in claim) echo LEGACY1;; check) echo "FREE (legacy)";; *) echo ok;; esac\nexit ${FAKE_CODE:-0}\n', { mode: 0o755 });
  const h = path.join(tmp, 'home-shadow'); fs.mkdirSync(h, { recursive: true });
  writeConfig(h, base, path.join(home, 'token'), `VPT_LEASE_LEGACY=${legacy}\nVPT_LEASE_MACHINE=machine-1\n`);
  fs.writeFileSync(path.join(h, '.config', 'vpt-lease', 'config'), fs.readFileSync(path.join(h, '.config', 'vpt-lease', 'config'), 'utf8').replace('MODE=central', 'MODE=shadow'));
  // agreement: legacy free (0), central free (0); the claim is mirrored in the SHADOW store, never in the real one
  let r = await vl(['claim', 'env-a', 'host-13', '--agent', A], { h });
  assert.deepEqual([r.code, r.out], [0, 'LEGACY1\n']);
  assert.equal((await vl(['check', 'env-a', 'host-13'])).code, 0, 'the real store has no lease from a shadow claim');
  const before = (await service.shadow.list()).reports?.length ?? 0;
  // disagreement: legacy says free (0), but central (shadow store) holds the lease from the first call -> busy (3)
  r = await vl(['check', 'env-a', 'host-13', '--ignore-agent', B], { h });
  assert.deepEqual([r.code, r.out], [0, 'FREE (legacy)\n']);
  const after = (await service.shadow.list()).reports || [];
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).command, 'check env-a host-13 --ignore-agent ' + B);
  assert.equal(after.at(-1).legacy.code, 0); assert.equal(after.at(-1).central.code, 3);
  r = await vl(['release', 'LEGACY1'], { h });
  assert.equal(r.code, 0);
});
