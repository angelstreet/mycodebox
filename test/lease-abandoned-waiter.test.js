// An abandoned or forgotten waiting claim must never hold a device (owner 2026-11-11: the Mi was held ~11 h by two `claim --wait`
// waiters of an idle session). Root cause: the forwarded waiter aborted at exit (a daemon thread inside the buffered stdin reader),
// ssh reported 255, and the codebox client queued again after every grant. Real CLI on both sides of a fake ssh, real service,
// temp state dir, fake tmux, fake resources; never the live registry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes } from '../lease-routes.js';
import { tmp as mkTmp } from './helpers-tmp.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLIENT = process.env.VPT_LEASE_CLIENT_UNDER_TEST || path.join(ROOT, 'scripts', 'vpt-lease');
const tmp = mkTmp('lease-abandon-');
const dir = path.join(tmp, 'state');
const home = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin');
const alive = path.join(tmp, 'sessions');     // fake tmux: a session exists while <alive>/<name> exists
let server, service;

before(async () => {
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(alive);
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', 'test-machine', '--dir', dir, '--owner'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(home, 'token'), r.stdout.trim() + '\n', { mode: 0o600 });
  service = createLeaseService({ dir, config: { envs: ['env-a'] } });
  const routes = createLeaseRoutes({ service, dir });
  server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), `VPT_LEASE_URL=http://127.0.0.1:${server.address().port}\nVPT_LEASE_TOKEN_FILE=${path.join(home, 'token')}\n`);
  // fake ssh: runs the remote command locally with our stdin; like real ssh, a remote killed by a signal (abort = 134) is exit 255.
  // FAKE_DROP_AFTER_GRANT=1: the remote answers, then the connection drops anyway (255).
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
for last; do :; done
sh -c "$last"; rc=$?
[ -n "$FAKE_DROP_AFTER_GRANT" ] && case "$last" in *" claim "*) rc=255;; esac
[ "$rc" -gt 128 ] && exit 255
exit $rc
`, { mode: 0o755 });
  // fake tmux: has-session / list-panes for the sessions in <alive>; list-panes prints the pid stored in the file
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
cmd=$1; shift; t=""
while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { t=\${2#=}; shift; }; shift; done
[ -e "${alive}/$t" ] || exit 1
[ "$cmd" = "list-panes" ] && cat "${alive}/$t"
exit 0
`, { mode: 0o755 });
});
const kids = new Set();      // a waiter that never ends (the bug) must not outlive the test
after(() => { for (const c of kids) try { c.kill('SIGKILL'); } catch {} server.closeAllConnections?.(); server.close(); });

const ENV = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C', VPT_LEASE_TEST_FAST: '1', VPT_LEASE_TMUX: path.join(bin, 'tmux') };
const central = { VPT_LEASE_MODE: 'central' };
// the codebox side: every call forwarded over (fake) ssh to the real client in central mode
const viaSsh = { VPT_LEASE_MODE: 'central-through-ssh', VPT_LEASE_SSH_TARGET: '<registry-host>', VPT_LEASE_REMOTE_CMD: `python3 -I ${CLIENT}` };
const vl = (args, env = central) => new Promise((ok) => {      // async: the service runs in this process
  const c = spawn('python3', ['-I', CLIENT, ...args], { env: { ...ENV, ...env } });
  kids.add(c); c.on('exit', () => kids.delete(c));
  let out = '', err = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.stdin.end();
  c.on('close', (status) => ok({ status, stdout: out, stderr: err }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => JSON.parse((await vl(['list', '--json'])).stdout);
const mine = async (agent) => { const s = await state(); return { leases: s.leases.filter((l) => l.agent === agent), tickets: (s.tickets || []).filter((t) => t.agent === agent) }; };
const hold = async (res, agent) => { const h = await vl(['claim', 'env-a', res, '--agent', agent, '--kind', 'host']); assert.equal(h.status, 0, h.stderr); return h.stdout.trim(); };
const release = async (id, agent) => assert.equal((await vl(['release', id, '--agent', agent])).status, 0);

test('forwarded claim --wait: granted once, exits 0 with that lease, never queues again (the 2026-11-11 Mi loop)', async () => {
  const holder = await hold('dev-1', 'codebox:h1');
  const w = vl(['claim', 'env-a', 'dev-1', '--agent', 'codebox:w1', '--kind', 'host', '--wait'], viaSsh);
  await sleep(1500);
  await release(holder, 'codebox:h1');
  const r = await Promise.race([w, sleep(15000).then(() => ({ status: 'timeout' }))]);
  assert.notEqual(r.status, 'timeout', 'the waiter must end once granted');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Fatal Python error|UNAVAILABLE|retrying/);
  await sleep(1500);
  const m = await mine('codebox:w1');
  assert.deepEqual(m.leases.map((l) => l.id), [r.stdout.trim().split('\n')[0]], 'exactly the one lease it printed');
  assert.deepEqual(m.tickets, [], 'no new ticket');
  await release(m.leases[0].id, 'codebox:w1');
});

test('an ssh drop right after the grant: the lease is adopted (printed, exit 0), not claimed a second time', async () => {
  const holder = await hold('dev-2', 'codebox:h2');
  const w = vl(['claim', 'env-a', 'dev-2', '--agent', 'codebox:w2', '--kind', 'host', '--wait'], { ...viaSsh, FAKE_DROP_AFTER_GRANT: '1' });
  await sleep(1500);
  await release(holder, 'codebox:h2');
  const r = await Promise.race([w, sleep(15000).then(() => ({ status: 'timeout' }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /adopted, not claimed again/);
  await sleep(1000);
  const m = await mine('codebox:w2');
  assert.equal(m.leases.length, 1);
  assert.equal(r.stdout.trim(), m.leases[0].id, 'the lease id is printed once');
  assert.deepEqual(m.tickets, []);
  await release(m.leases[0].id, 'codebox:w2');
});

for (const [label, env] of [['central', central], ['forwarded', viaSsh]]) {
  test(`${label}: --max-wait bounds a waiting claim: exit 3, ticket cancelled, never granted later`, async () => {
    const agent = `codebox:mw-${label}`;
    const holder = await hold(`dev-mw-${label}`, `codebox:hmw-${label}`);
    const t0 = Date.now();
    const r = await vl(['claim', 'env-a', `dev-mw-${label}`, '--agent', agent, '--kind', 'host', '--wait', '--max-wait', '0.03'], env);
    assert.equal(r.status, 3, r.stderr);
    assert.ok(Date.now() - t0 < 10000);
    assert.match(r.stderr, /--max-wait/);
    await release(holder, `codebox:hmw-${label}`);
    await sleep(1000);
    assert.deepEqual(await mine(agent), { leases: [], tickets: [] });
  });

  test(`${label}: a waiter whose codebox session is closed stops and cancels its ticket`, async () => {
    const name = `sess-${label}`;
    fs.writeFileSync(path.join(alive, name), `${process.pid}\n`);
    const holder = await hold(`dev-s-${label}`, `codebox:hs-${label}`);
    const w = vl(['claim', 'env-a', `dev-s-${label}`, '--agent', `codebox:${name}`, '--kind', 'host', '--wait'], env);
    await sleep(1500);
    fs.rmSync(path.join(alive, name));
    const r = await Promise.race([w, sleep(10000).then(() => ({ status: 'timeout' }))]);
    assert.equal(r.status, 130, r.stderr);
    assert.match(r.stderr, /session .* is closed/);
    await release(holder, `codebox:hs-${label}`);
    await sleep(1000);
    assert.deepEqual(await mine(`codebox:${name}`), { leases: [], tickets: [] });
  });

  test(`${label}: a codebox claim records its session's pane as holder pid (exclusive only), so closing the session frees it`, async () => {
    const name = `own-${label}`;
    fs.writeFileSync(path.join(alive, name), `${process.pid}\n`);
    const r = await vl(['claim', 'env-a', `dev-o-${label}`, '--agent', `codebox:${name}`, '--kind', 'host'], env);
    assert.equal(r.status, 0, r.stderr);
    const [l] = (await mine(`codebox:${name}`)).leases;
    assert.equal(l.holder_pid, process.pid);
    assert.equal(l.holder_host, os.hostname());
    await release(l.id, `codebox:${name}`);
    const p = await vl(['claim', 'env-a', `dev-o-${label}`, '--agent', `codebox:${name}`, '--kind', 'host', '--mode', 'pin'], env);
    assert.equal(p.status, 0, p.stderr);
    const [pl] = (await mine(`codebox:${name}`)).leases;
    assert.equal(pl.holder_pid, null, 'a pin keeps TTL behaviour');
    await release(pl.id, `codebox:${name}`);
    fs.rmSync(path.join(alive, name));
  });
}
