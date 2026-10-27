// Hard 60-minute lease cap (owner 2026-10-27): claim/renew clamp, continuous-hold limit while someone waits, existing leases untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseService } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
function harness(cfg = {}) {
  const clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0), m: 5000 };
  const dir = tmp('lease-cap-');
  const open = (c = {}) => createLeaseService({ dir, now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'], ...c } });
  const h = { clock, dir, open, svc: open(cfg) };
  h.advance = async (ms) => { clock.t += ms; clock.m += ms; await h.svc.tick(); };
  h.claim = (agent, resources, o = {}) => h.svc.claim({ env: 'env-a', resources: [].concat(resources), agent, ...o });
  return h;
}

test('claim of 240 min is clamped to 60 with ttl_clamped_from and a warning', async () => {
  const h = harness();
  const r = await h.claim('codebox:a', 'device:host-1/device4', { ttl_min: 240 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.ttl_min, 60);
  assert.equal(r.lease.ttl_clamped_from, 240);
  assert.match(JSON.stringify(r.warnings || r.lease.warnings || r), /max 60 min per claim/);
});

test('claim at or under 60 is untouched; observe and pin modes are capped too', async () => {
  const h = harness();
  const a = await h.claim('codebox:a', 'device:host-1/device1', { ttl_min: 45 });
  assert.equal(a.lease.ttl_min, 45); assert.equal(a.lease.ttl_clamped_from, null);
  const p = await h.claim('codebox:b', 'device:host-1/device2', { ttl_min: 300, mode: 'pin' });
  assert.equal(p.lease.ttl_min, 60);
  const o = await h.claim('codebox:c', 'device:host-1/device2', { ttl_min: 300, mode: 'observe' });
  assert.equal(o.lease.ttl_min, 60);
});

test('priority clamp: the lower limit wins, ttl_clamped_from keeps the requested value', async () => {
  const h = harness();
  const r = await h.claim('codebox:a', 'device:host-1/device1', { ttl_min: 240, priority: 'P2' });
  assert.equal(r.lease.ttl_min, 10);
  assert.equal(r.lease.ttl_clamped_from, 240);
});

test('system (exempt) leases keep their own limits', async () => {
  const h = harness();
  const r = await h.svc.claim({ env: 'env-a', resources: ['server'], agent: 'manager:deploy', ttl_min: 240, exempt: true });
  assert.equal(r.lease.ttl_min, 240);
});

test('renew is clamped to 60 and extends when nobody waits, even past 60 min of hold', async () => {
  const h = harness();
  const { lease } = await h.claim('codebox:a', 'device:host-1/device1', { ttl_min: 60 });
  await h.advance(50 * MIN);
  const r = await h.svc.renew({ id: lease.id, ttl_min: 240 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.ttl_min, 60);
  await h.advance(50 * MIN);                                  // 100 min continuous, still no waiter
  assert.equal((await h.svc.renew({ id: lease.id, ttl_min: 60 })).ok, true);
});

test('renew with a waiter: clamped to the 60 min since the claim (refusal: pre-cap test below)', async () => {
  const h = harness();
  const { lease } = await h.claim('codebox:a', 'device:host-1/device1', { ttl_min: 60 });
  await h.advance(40 * MIN);
  const w = await h.claim('codebox:b', 'device:host-1/device1', { wait: 'ticket' });
  assert.ok(w.ticket || w.ticket_id || w.id || w.ok === false, JSON.stringify(w));
  const r = await h.svc.renew({ id: lease.id, ttl_min: 60 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.ttl_min, 20);
});

test('a pre-cap 240-minute lease is not shortened; it cannot be extended past 60 min of hold when someone waits', async () => {
  const h = harness({ maxClaimMin: 1000 });
  const { lease } = await h.claim('mac:fp-only', 'device:host-1/device4', { ttl_min: 240 });
  assert.equal(lease.ttl_min, 240);
  h.svc = h.open({ maxClaimMin: 60 });                        // restart with the cap on: state is replayed from the journal
  await h.advance(90 * MIN);
  const live = (await h.svc.renew({ id: lease.id, ttl_min: 5 }));
  assert.equal(live.ok, true);                                // no waiter: renewal allowed (clamped), lease was not killed at 60
  await h.claim('codebox:b', 'device:host-1/device4', { wait: 'ticket' });
  const r = await h.svc.renew({ id: lease.id, ttl_min: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_HOLD_CAP');
});
