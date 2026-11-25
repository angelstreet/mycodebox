// Scheduled jobs (P3) never delay dev work (owner 2026-11-16): a P3 lease yields to a waiting P0..P2 ticket or a queued deploy and ends 2 min later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseService } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
function harness() {
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0), m: 5000 };
  const svc = createLeaseService({ dir: tmp('lease-sched-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'] } });
  const advance = async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); };
  const claim = (agent, resources, o = {}) => svc.claim({ env: 'env-a', resources: [].concat(resources), agent, ...o });
  return { svc, advance, claim };
}
const activeIds = async (svc) => (await svc.list({ env: 'env-a' })).leases.map((l) => l.id);

test('P3 scheduled lease: a P1 ticket makes it yield, and it ends 2 min later, not at its TTL', async () => {
  const h = harness();
  const s = await h.claim('deployment:stream-wall', 'device:host-1/device1', { priority: 'P3', ttl_min: 60 });
  assert.equal(s.lease.ttl_min, 10);
  const dev = await h.claim('codebox:dev', 'device:host-1/device1', { priority: 'P1', wait: 'ticket' });
  assert.ok(dev.ticket);
  await h.advance(1000);
  assert.ok((await activeIds(h.svc)).includes(s.lease.id), 'still held inside the grace');
  await h.advance(MIN);
  assert.ok((await activeIds(h.svc)).includes(s.lease.id), 'still held after 1 min');
  assert.equal((await h.svc.renew({ id: s.lease.id })).code, 'E_YIELD_REQUIRED');
  await h.advance(MIN + 5000);
  assert.ok(!(await activeIds(h.svc)).includes(s.lease.id), 'ended after the 2 min grace');
  const ev = (await h.svc.events({})).events.filter((e) => e.id === s.lease.id && e.kind === 'expired');
  assert.match(JSON.stringify(ev), /yield-grace/);
});

test('P2 lease keeps the old rule: yields on renew but is not cut', async () => {
  const h = harness();
  const s = await h.claim('codebox:p2', 'device:host-1/device1', { priority: 'P2', ttl_min: 10 });
  await h.claim('codebox:dev', 'device:host-1/device1', { priority: 'P1', wait: 'ticket' });
  await h.advance(5 * MIN);
  assert.ok((await activeIds(h.svc)).includes(s.lease.id));
});

test('P3 lease with no higher claim waiting is untouched', async () => {
  const h = harness();
  const s = await h.claim('deployment:x', 'device:host-1/device1', { priority: 'P3' });
  await h.advance(5 * MIN);
  assert.ok((await activeIds(h.svc)).includes(s.lease.id));
});

test('a new P3 claim never queues ahead of a dev ticket: it is refused, not waited', async () => {
  const h = harness();
  await h.claim('codebox:hold', 'device:host-1/device1', { priority: 'P1' });
  await h.claim('codebox:dev', 'device:host-1/device1', { priority: 'P1', wait: 'ticket' });
  const r = await h.claim('deployment:y', 'device:host-1/device1', { priority: 'P3' });
  assert.equal(r.ok, false); assert.equal(r.code, 'E_HELD');
});

// bug-4c604fc3: the registry made every nightly STB run (P3 device lease) yield to host deploys that never waited on it: the runner
// starts a host deploy with skip_leased, syncs past device leases and defers the vpt-host restart to a catch-up.
test('a queued host deploy does not make a P3 device lease yield: it syncs past device leases (bug-4c604fc3)', async () => {
  const h = harness();
  const s = await h.claim('deployment:nightly', 'device:host-1/device1', { priority: 'P3', kind: 'host' });
  await h.svc.deploy.request({ env: 'env-a', scope: 'host', ref: 'abc1234', agent: 'ag', hosts: ['host-1', 'host-2'], approved: true, purpose: 'dev deploy' });
  await h.advance(1000);
  assert.ok((await h.svc.renew({ id: s.lease.id })).ok, 'renew still allowed');
  await h.advance(2 * MIN + 5000);
  assert.ok((await activeIds(h.svc)).includes(s.lease.id));
  assert.equal((await h.svc.events({})).events.filter((e) => e.id === s.lease.id && e.kind === 'yield').length, 0);
});

test('a queued host deploy still makes a whole-host P3 lease yield and end after 2 min; a P1 lease is not touched', async () => {
  const h = harness();
  const s = await h.claim('deployment:nightly', 'host-1', { priority: 'P3', kind: 'host' });
  const p1 = await h.claim('codebox:p1', 'device:host-2/device1', { priority: 'P1', kind: 'host' });
  await h.svc.deploy.request({ env: 'env-a', scope: 'host', ref: 'abc1234', agent: 'ag', hosts: ['host-1', 'host-2'], approved: true, purpose: 'dev deploy' });
  await h.advance(1000);
  assert.equal((await h.svc.renew({ id: s.lease.id })).code, 'E_YIELD_REQUIRED');
  await h.advance(2 * MIN + 5000);
  const ids = await activeIds(h.svc);
  assert.ok(!ids.includes(s.lease.id));
  assert.ok(ids.includes(p1.lease.id));
});

// a strict catch-up (the deferred vpt-host restart, made the way the runner makes it: a catch-up that skipped its host again)
async function strictCatchUp(h, hosts) {
  const r = await h.svc.deploy.request({ env: 'env-a', scope: 'host', ref: 'abc1234', agent: 'ag', hosts, approved: true, purpose: 'catch-up for x' });
  await h.svc.deploy.start({ id: r.id ?? r.deploy?.id, skip_leased: true });
  const id = (await h.svc.deploy.finish({ id: r.id ?? r.deploy?.id, status: 'done', skipped_hosts: hosts.join(',') })).catchup;
  const l = await h.svc.deploy.list({ env: 'env-a' });
  return (l.deploys || l).find((d) => d.id === id);
}

test('outside the nightly window a strict catch-up still makes a P3 device lease yield (owner 2026-11-16)', async () => {
  const h = harness();   // 12:00 UTC
  const s = await h.claim('deployment:wall', 'device:host-1/device1', { priority: 'P3', kind: 'host' });
  const c = await strictCatchUp(h, ['host-1']);
  assert.ok(c?.strict, 'the registry re-armed a strict catch-up');
  await h.advance(11 * MIN);   // past the catch-up cooldown
  await h.advance(2 * MIN + 5000);
  assert.ok(!(await activeIds(h.svc)).includes(s.lease.id), 'the scheduled run ended for the restart');
});

test('inside the nightly window a strict catch-up waits for the P3 run, gates no claim, and starts once it is released (bug-4c604fc3)', async () => {
  const clock = { t: Date.UTC(2026, 10, 25, 22, 0, 0), m: 5000 };
  const svc = createLeaseService({ dir: tmp('lease-sched-night-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'] } });
  const h = { svc, advance: async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); }, claim: (agent, resources, o = {}) => svc.claim({ env: 'env-a', resources: [].concat(resources), agent, ...o }) };
  const s = await h.claim('deployment:nightly', 'device:host-1/device3', { priority: 'P3', kind: 'host' });
  const c = await strictCatchUp(h, ['host-1']);
  assert.ok(c?.strict);
  // 90 min of renewals, as the host scheduler heartbeats a 2 h campaign: never told to yield, never hold-capped
  for (let i = 0; i < 18; i++) { await h.advance(5 * MIN); assert.ok((await h.svc.renew({ id: s.lease.id })).ok, `renew ${i}`); }
  assert.ok((await activeIds(h.svc)).includes(s.lease.id));
  assert.equal((await h.svc.events({})).events.filter((e) => e.id === s.lease.id && e.kind === 'yield').length, 0);
  // a dev claim on another device of the host is not gated by the waiting catch-up
  const dev = await h.claim('codebox:dev', 'device:host-1/device1', { priority: 'P1', kind: 'host' });
  assert.ok(dev.ok, JSON.stringify(dev));
  await h.svc.release({ id: dev.lease.id });
  // the deploy cannot start while the run holds the device, and can once it is released
  assert.equal((await h.svc.deploy.start({ id: c.id, skip_leased: true })).code, 'E_HELD');
  await h.svc.release({ id: s.lease.id });
  assert.ok((await h.svc.deploy.start({ id: c.id, skip_leased: true })).ok);
});
