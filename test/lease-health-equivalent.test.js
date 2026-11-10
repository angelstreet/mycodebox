// Owner 2026-11-10: never wait on a named device while a HEALTHY equivalent is free. Service (health filter), health reader and probe,
// the real vpt-lease client (immediate switch, unhealthy never offered, both busy waits), nudge and done-check enforcement.
// Fake leases / hosts only, temp state dirs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes } from '../lease-routes.js';
import { healthReader } from '../scripts/lease-serve.js';
import { probe } from '../scripts/lease-health-probe.js';
import { planNudges } from '../lease-nudge.js';
import { refusal, applyEquivalence, equivalenceReader } from '../lease-equivalence.js';
import { mergedHealth } from '../scripts/lease-serve.js';
import { acceptedWaitReason, waitingOnLeaseStatus, equivalentWaitMessage, createDoneCheck } from '../done-check.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLIENT = path.join(ROOT, 'scripts', 'vpt-lease');
const INV = { 'env-a': { stb: ['pi-1/device4', 'pi-3/device4', 'pi-5/device4'] } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-health-'));
const health = { hosts: {}, devices: {} };
let server, base, service;
const home = path.join(tmp, 'home');

before(async () => {
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  const dir = path.join(tmp, 'state');
  const tok = spawnSync('node', [path.join(ROOT, 'scripts', 'lease-token.js'), 'add', 'm', '--dir', dir, '--owner'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(home, 'token'), tok + '\n', { mode: 0o600 });
  service = createLeaseService({ dir, config: { envs: ['env-a'], inventory: INV, health: () => health } });
  const routes = createLeaseRoutes({ service, dir });
  server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), `VPT_LEASE_MODE=central\nVPT_LEASE_URL=${base}\nVPT_LEASE_TOKEN_FILE=${path.join(home, 'token')}\n`);
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const reset = () => { health.hosts = {}; health.devices = {}; };

function vl(args) {
  let child;
  const pr = new Promise((resolve) => {
    child = spawn('python3', ['-I', CLIENT, ...args], { env: { PATH: process.env.PATH, HOME: home, LANG: 'C', VPT_LEASE_TEST_FAST: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, out, err }));
  });
  pr.child = child;
  return pr;
}
const hold = async (res, agent) => (await vl(['claim', 'env-a', res, '--agent', agent, '--kind', 'host'])).out.trim().split('\n')[0];
const rel = (id) => vl(['release', id]);

test('service: an equivalent on an unreachable host or an absent device is never offered; healthy free one is', async () => {
  reset();
  const l1 = (await service.claim({ env: 'env-a', resources: ['pi-1/device4'], agent: 'a', kind: 'host' })).lease.id;
  const tk = (await service.claim({ env: 'env-a', resources: ['pi-1/device4'], agent: 'w', kind: 'host', wait: 'ticket' })).ticket;
  assert.deepEqual(tk.equivalents_free.map((e) => e.legacy), ['pi-3/device4', 'pi-5/device4']);
  health.hosts['pi-3'] = { up: false, reason: 'host pi-3 does not answer' };
  health.devices['pi-5/device4'] = { present: false };
  const v = (await service.ticket(tk.id)).ticket;
  assert.equal(v.equivalents_free, undefined);
  assert.deepEqual(v.equivalents_unhealthy.map((e) => e.legacy), ['pi-3/device4', 'pi-5/device4']);
  assert.match(v.equivalents_unhealthy[0].reason, /does not answer/);
  const inv = await service.inventory({ env: 'env-a' });
  const ms = inv.groups[0].members;
  assert.deepEqual(ms.map((m) => m.healthy), [true, false, false]);
  assert.match(ms[1].health_reason, /pi-3/);
  const any = await service.claim({ env: 'env-a', any: 'stb', agent: 'x', kind: 'host' });
  assert.equal(any.code, 'E_HELD', 'the only healthy member is busy: --any does not fall onto an unhealthy one');
  health.hosts['pi-1'] = { up: false };
  assert.equal((await service.claim({ env: 'env-a', any: 'stb', agent: 'x', kind: 'host' })).code, 'E_INVALID');
  reset();
  await service.cancelTicket(tk.id); await service.release({ id: l1 });
});

test('healthReader: stale or missing data is unknown (healthy), fresh data is used, "*" merges', () => {
  const f = path.join(tmp, 'h.json');
  let t = Date.UTC(2026, 10, 10, 12);
  const rd = healthReader(f, { error() {} }, () => t);
  assert.deepEqual(rd('env-a'), { hosts: {}, devices: {} });
  fs.writeFileSync(f, JSON.stringify({ 'env-a': { at: new Date(t).toISOString(), hosts: { 'pi-3': { up: false } } }, '*': { at: new Date(t).toISOString(), devices: { 'x/device1': { present: false } } } }));
  assert.equal(rd('env-a').hosts['pi-3'].up, false);
  assert.equal(rd('env-a').devices['x/device1'].present, false);
  assert.deepEqual(rd('env-b').hosts, {});
  t += 16 * 60000;
  assert.deepEqual(rd('env-a'), { hosts: {}, devices: {} });
});

test('probe: one check per host, down host recorded with a reason, devices copied', async () => {
  const calls = [];
  const out = await probe({ 'env-a': { hosts: { 'Pi-3': 'x:22', 'pi-1': 'y:22' }, devices: { 'pi-1/device4': { present: true } } } },
    { check: async (a) => { calls.push(a); return a === 'x:22' ? { up: false, reason: 'host x unreachable' } : { up: true }; }, now: () => 0 });
  assert.equal(calls.length, 2);
  assert.equal(out['env-a'].hosts['pi-3'].up, false);
  assert.equal(out['env-a'].hosts['pi-1'].up, true);
  assert.equal(out['env-a'].at, '1970-01-01T00:00:00.000Z');
});

test('client scenario: (1) healthy free equivalent -> switched at once; (2) equivalent on an unreachable host -> not offered, waits; (3) both busy -> waits', async () => {
  reset();
  const h1 = await hold('pi-1/device4', 'codebox:h1');
  // (1)
  const t0 = Date.now();
  const r1 = await vl(['run', 'env-a', 'pi-1/device4', '--agent', 'codebox:w1', '--kind', 'host', '--', 'sh', '-c', 'echo got=$VPT_LEASE_RESOURCE']);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /got=pi-3\/device4/, 'named device busy, equivalent free and healthy: it got the equivalent');
  assert.match(r1.err, /auto-equivalent: pi-1\/device4 is busy and pi-3\/device4 is free and healthy: took pi-3\/device4 at once/);
  assert.ok(Date.now() - t0 < 10000, 'no 2 min wait');
  // (2) pi-3 and pi-5 down
  health.hosts['pi-3'] = { up: false, reason: 'host pi-3 does not answer' };
  health.hosts['pi-5'] = { up: false, reason: 'host pi-5 does not answer' };
  const w2 = vl(['claim', 'env-a', 'pi-1/device4', '--agent', 'codebox:w2', '--kind', 'host', '--wait']);
  await new Promise((r) => setTimeout(r, 2500));
  const list = await vl(['list', 'env-a']);
  assert.match(list.out, /unhealthy-equivalent=pi-3\/device4 \(host pi-3 does not answer\)/);
  assert.doesNotMatch(list.out, /free-equivalent=/);
  const inv = await vl(['inventory', 'env-a']);
  assert.match(inv.out, /pi-3\/device4 \(UNHEALTHY: host pi-3 does not answer\)/);
  w2.child.kill();
  // (3) healthy again but all other members busy
  reset();
  const h3 = await hold('pi-3/device4', 'codebox:h3'); const h5 = await hold('pi-5/device4', 'codebox:h5');
  const w3 = vl(['claim', 'env-a', 'pi-1/device4', '--agent', 'codebox:w3', '--kind', 'host', '--wait']);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await Promise.race([w3, new Promise((r) => setTimeout(() => r('waiting'), 50))])), 'waiting', 'every member busy: it waits');
  assert.match((await vl(['list', 'env-a'])).out, /TICKET .*pi-1\/device4/);
  w3.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const l of [h1, h3, h5]) await rel(l);
});

test('client: a waiting claim moves the moment a healthy equivalent frees (no 2 min, no end-of-poll wait)', async () => {
  reset();
  const a = await hold('pi-1/device4', 'codebox:a'), b = await hold('pi-3/device4', 'codebox:b'), c = await hold('pi-5/device4', 'codebox:c');
  const w = vl(['run', 'env-a', 'pi-1/device4', '--agent', 'codebox:w', '--kind', 'host', '--', 'sh', '-c', 'echo got=$VPT_LEASE_RESOURCE']);
  await new Promise((r) => setTimeout(r, 1500));
  await rel(b);
  const r = await w;
  assert.match(r.out, /got=pi-3\/device4/);
  await rel(a); await rel(c);
});

test('client: --no-auto-equivalent keeps waiting even with a healthy equivalent free', async () => {
  reset();
  const a = await hold('pi-1/device4', 'codebox:a');
  const w = vl(['claim', 'env-a', 'pi-1/device4', '--agent', 'codebox:n', '--kind', 'host', '--wait', '--no-auto-equivalent']);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await Promise.race([w, new Promise((r) => setTimeout(() => r('waiting'), 50))])), 'waiting');
  w.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  await rel(a);
});

test('nudge: a ticket with a healthy free equivalent is told after 30 s with the exact command; unique hardware stays quiet', () => {
  const now = Date.UTC(2026, 10, 10, 21, 30);
  const tk = (o = {}) => ({ id: 't-1', env: 'e', resources: ['pi-1/device4'], agent: 'codebox:s', createdMs: now - 45000, holderIds: [], holders: [], equivalents: ['pi-3/device4'], groups: ['stb'], any: null, hint: '', ...o });
  const sessionOf = (a) => a.slice(8);
  const [n] = planNudges({ now, view: { ok: true, leases: [], tickets: [tk()] }, sessionOf });
  assert.match(n.text, /STOP WAITING/);
  assert.match(n.text, /vpt-lease ticket t-1 --cancel && vpt-lease claim e pi-3\/device4 --agent codebox:s --kind host --wait/);
  assert.equal(planNudges({ now, view: { ok: true, leases: [], tickets: [tk({ createdMs: now - 10000 })] }, sessionOf }).length, 0);
  assert.equal(planNudges({ now, view: { ok: true, leases: [], tickets: [tk({ equivalents: [] })] }, sessionOf }).length, 0);
  const last = new Map([[`codebox:s|t-1|waiter`, now - 5 * 60000]]);
  assert.equal(planNudges({ now, view: { ok: true, leases: [], tickets: [tk()] }, sessionOf, last }).length, 0, 'cooldown 10 min');
  assert.equal(planNudges({ now: now + 6 * 60000, view: { ok: true, leases: [], tickets: [tk({ createdMs: now - 45000 })] }, sessionOf, last }).length, 1);
});

test('done-check: STATUS waiting on a lease while an equivalent is free: one push with the command, manager told on the second stop; no equivalent: accepted', async () => {
  assert.ok(waitingOnLeaseStatus('x\nSTATUS: waiting: lease on pi-1/device4 (queued ticket t-a0a129b3)'));
  assert.ok(!waitingOnLeaseStatus('STATUS: waiting: integration int-123'));
  assert.ok(!waitingOnLeaseStatus('STATUS: done — x'));
  const dir = fs.mkdtempSync(path.join(tmp, 'dc-'));
  let text = 'STATUS: waiting: lease on pi-1/device4 (queued ticket t-1)', eq = { ticketId: 't-1', env: 'e', resources: ['pi-1/device4'], agent: 'codebox:s', equivalents: ['pi-3/device4'], group: 'stb' };
  const sent = [], events = [];
  const git = async () => '';
  const w = createDoneCheck({ stateDir: dir, git, log: { error() {} }, pressure: () => ({ loadPerCore: 0, ramAvailPct: 90 }),
    listDone: async () => [{ name: 's', cwd: '/w/s', text }], equivalentOf: async () => eq,
    send: async (n, x) => { sent.push(x); }, record: async (e) => { events.push(e.key); } });
  const r = await w.tick();
  assert.deepEqual(r.waitingWhileEquivalentFree, ['s']);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /vpt-lease ticket t-1 --cancel && vpt-lease claim e pi-3\/device4 --agent codebox:s --kind host --wait/);
  await w.tick(); assert.equal(sent.length, 1, 'same stop: not again');
  text += ' still';
  await w.tick(); assert.equal(sent.length, 1, 'second stop: the manager is told, not the session');
  assert.deepEqual(events, ['done-check-eq:s']);
  await w.tick(); assert.deepEqual(events, ['done-check-eq:s'], 'told once');
  eq = null; text = 'STATUS: waiting: lease on unique-box (ticket t-9)';
  const before = sent.length; await w.tick(); assert.equal(sent.length, before, 'no equivalent: the wait is accepted');
  assert.match(equivalentWaitMessage({ ticketId: 't', env: 'e', equivalents: ['a'], resources: ['b'] }), /not accepted/);
});

test('single-member group (the only Android TV box with the app): no equivalent exists, no push of any kind, however long it waits', async () => {
  const svc = createLeaseService({ dir: fs.mkdtempSync(path.join(tmp, 'one-')), config: { envs: ['env-a'], inventory: { 'env-a': { 'tv-only': ['mi-1/device5'], other: ['pi-1/device1', 'pi-3/device1'] } }, health: () => ({ hosts: {}, devices: {} }) } });
  await svc.claim({ env: 'env-a', resources: ['mi-1/device5'], agent: 'holder', kind: 'host' });
  const tk = (await svc.claim({ env: 'env-a', resources: ['mi-1/device5'], agent: 'codebox:kpi-androidtv', kind: 'host', wait: 'ticket' })).ticket;
  assert.equal(tk.equivalents_free, undefined, 'the group has no other member');
  assert.equal(tk.equivalents_unhealthy, undefined);
  const view = { ok: true, leases: [], tickets: [{ id: tk.id, env: 'env-a', resources: ['mi-1/device5'], agent: 'codebox:kpi-androidtv', createdMs: Date.now() - 3 * 3600000, holderIds: [], holders: ['holder'], equivalents: [], groups: [], any: null, hint: '' }] };
  assert.equal(planNudges({ now: Date.now(), view, sessionOf: (a) => a.slice(8) }).length, 0, 'nudge: nothing');
  let sent = 0;
  const w = createDoneCheck({ stateDir: fs.mkdtempSync(path.join(tmp, 'dc1-')), git: async () => '', log: { error() {} }, pressure: () => ({ loadPerCore: 0, ramAvailPct: 90 }),
    listDone: async () => [{ name: 'kpi-androidtv', cwd: '/w/k', text: 'STATUS: waiting: lease on mi-1/device5 (ticket ' + tk.id + ')' }],
    equivalentOf: async () => null, send: async () => { sent++; }, record: async () => {} });
  await w.tick();
  assert.equal(sent, 0, 'done-check: the wait is accepted');
});

// ---- agent-x (2026-11-10): the candidates offered were off the network / had a hung IR dongle / were on no server ----
const DATA = {
  known_broken: { 'pi-1/device3': 'Q297 hung IR dongle, no /dev/lirc-x' },
  servers: { 'srv-a': ['pi-1', 'mf-1'] },
  hosts: { 'pi-3': { up: false, reason: 'host pi-3 is off the network' } },
  devices: { 'mf-1/device9': { working: false, reason: 'no control path' } },
};

test('refusal: known broken, host unreachable, control path missing, not on the claimant\'s backend server; a healthy same-server device passes', () => {
  assert.match(refusal(DATA, 'pi-1/device3', 'pi-1/device4'), /known broken: Q297/);
  assert.match(refusal(DATA, 'pi-3/device4', 'pi-1/device4'), /off the network/);
  assert.match(refusal({ ...DATA, hosts: {} }, 'pi-3/device4', 'pi-1/device4'), /registered on no backend server \(srv-a lists pi-1\)/);
  assert.match(refusal(DATA, 'mf-1/device9', 'pi-1/device4'), /no control path/);
  assert.match(refusal({ servers: { 'srv-a': ['pi-1'], other: ['mf-1'] } }, 'mf-1/device2', 'pi-1/device4'), /registered on other, not on srv-a/);
  assert.equal(refusal(DATA, 'mf-1/device2', 'pi-1/device4'), null, 'a healthy device on the same server is a real equivalent');
  assert.equal(refusal(DATA, 'pi-1/device5', ''), null, 'no claimant resource: no server rule');
  assert.equal(refusal(null, 'x/device1', 'y/device1'), null);
  assert.match(refusal({ known_broken: { 'pi-1': 'host being rebuilt' } }, 'pi-1/device2', ''), /host being rebuilt/, 'a whole host can be listed');
});

test('service: known-broken list and server registration (equivalence.json) keep devices out of equivalents_free and --any, with the reason shown', async () => {
  const f = path.join(tmp, 'equivalence.json');
  fs.writeFileSync(f, JSON.stringify({ 'env-a': DATA }));
  const inv = { 'env-a': { stb: ['pi-1/device4', 'pi-1/device3', 'pi-3/device4', 'mf-1/device2'] } };
  const svc = createLeaseService({ dir: fs.mkdtempSync(path.join(tmp, 'eq-')), config: { envs: ['env-a'], inventory: inv, health: mergedHealth(() => ({ hosts: {}, devices: {} }), equivalenceReader(f, { error() {} })) } });
  await svc.claim({ env: 'env-a', resources: ['pi-1/device4'], agent: 'holder', kind: 'host' });
  const tk = (await svc.claim({ env: 'env-a', resources: ['pi-1/device4'], agent: 'w', kind: 'host', wait: 'ticket' })).ticket;
  assert.deepEqual(tk.equivalents_free.map((e) => e.legacy), ['mf-1/device2'], 'only the healthy same-server box');
  assert.deepEqual(tk.equivalents_unhealthy.map((e) => e.legacy).sort(), ['pi-1/device3', 'pi-3/device4']);
  assert.match(tk.equivalents_unhealthy.find((e) => e.legacy === 'pi-1/device3').reason, /Q297/);
  const m = (await svc.inventory({ env: 'env-a' })).groups[0].members;
  assert.deepEqual(m.map((x) => x.healthy), [true, false, false, true]);
});

test('dashboard side: the view is filtered with the same rules; the push names what was not offered and why', () => {
  const t = { id: 't-1', env: 'e', resources: ['pi-1/device4'], agent: 'codebox:agent-x', createdMs: Date.now() - 60000, holderIds: [], holders: [], any: null, hint: '', groups: ['stb'],
    equivalents: ['pi-3/device4', 'pi-1/device3', 'mf-1/device2'] };
  const view = applyEquivalence({ ok: true, leases: [], tickets: [t] }, () => ({ ...DATA, hosts: DATA.hosts }));
  assert.deepEqual(view.tickets[0].equivalents, ['mf-1/device2']);
  assert.deepEqual(view.tickets[0].equivalentsRefused.map((x) => x.resource), ['pi-3/device4', 'pi-1/device3']);
  const [n] = planNudges({ now: Date.now(), view, sessionOf: (a) => a.slice(8) });
  assert.match(n.text, /free now: mf-1\/device2/);
  assert.doesNotMatch(n.text, /free now:[^.]*pi-[13]/);
  assert.match(n.text, /Not offered, and why: pi-3\/device4 \(host pi-3 is off the network\); pi-1\/device3 \(known broken: Q297/);
  const none = applyEquivalence({ ok: true, leases: [], tickets: [{ ...t, equivalents: ['pi-3/device4', 'pi-1/device3'] }] }, () => DATA);
  assert.equal(planNudges({ now: Date.now(), view: none, sessionOf: (a) => a.slice(8) }).length, 0, 'nothing healthy left: no push at all');
});

test('done-check: a waiting line that names a real difference is accepted; "needs exactly X" without one is pushed, with the refused list', async () => {
  assert.ok(acceptedWaitReason('STATUS: waiting: lease on pi-1/device4 (t-1): needs exactly device4, stb4 variant firmware'));
  assert.ok(acceptedWaitReason('STATUS: waiting: lease t-1 on pi-1/device4 because pi-3 is not registered on the srv-a server'));
  assert.ok(acceptedWaitReason('STATUS: waiting: lease t-1 needs exactly pi-1/device4: the other box has a hung dongle (known broken Q297)'));
  assert.ok(!acceptedWaitReason('STATUS: waiting: lease t-1 on pi-1/device4, needs exactly this one'));
  assert.ok(!acceptedWaitReason('STATUS: waiting: lease t-1 on pi-1/device4'));
  const eq = { ticketId: 't-1', env: 'e', resources: ['pi-1/device4'], agent: 'codebox:s', equivalents: ['mf-1/device2'], refused: [{ resource: 'pi-3/device4', reason: 'host pi-3 is off the network' }] };
  assert.match(equivalentWaitMessage(eq), /Not offered, and why: pi-3\/device4 \(host pi-3 is off the network\)/);
  for (const [text, expectSent] of [['STATUS: waiting: lease t-1 on pi-1/device4: needs exactly it, other box is a different model', 0], ['STATUS: waiting: lease t-1 on pi-1/device4', 1]]) {
    let sent = 0;
    const w = createDoneCheck({ stateDir: fs.mkdtempSync(path.join(tmp, 'dcr-')), git: async () => '', log: { error() {} }, pressure: () => ({ loadPerCore: 0, ramAvailPct: 90 }),
      listDone: async () => [{ name: 's', cwd: '/w/s', text }], equivalentOf: async () => eq, send: async () => { sent++; }, record: async () => {} });
    await w.tick();
    assert.equal(sent, expectSent, text);
  }
});
