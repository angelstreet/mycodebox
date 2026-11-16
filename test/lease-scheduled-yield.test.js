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

test('a queued host deploy makes a P3 lease on that host yield and end after 2 min; a P1 lease is not touched', async () => {
  const h = harness();
  const s = await h.claim('deployment:nightly', 'device:host-1/device1', { priority: 'P3', kind: 'host' });
  const p1 = await h.claim('codebox:p1', 'device:host-2/device1', { priority: 'P1', kind: 'host' });
  await h.svc.deploy.request({ env: 'env-a', scope: 'host', ref: 'abc1234', agent: 'ag', hosts: ['host-1', 'host-2'], approved: true, purpose: 'dev deploy' });
  await h.advance(1000);
  assert.equal((await h.svc.renew({ id: s.lease.id })).code, 'E_YIELD_REQUIRED');
  await h.advance(2 * MIN + 5000);
  const ids = await activeIds(h.svc);
  assert.ok(!ids.includes(s.lease.id));
  assert.ok(ids.includes(p1.lease.id));
});
