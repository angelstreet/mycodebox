// Equivalent resources (owner 2026-10-31: "agents are not waiting for a lease or a device when we have another one available"):
// claim --any <group>, one ticket over equivalent options, free equivalents on a named ticket, the device-only hint on a host claim,
// and the rolling deploy release (a host the deploy finished is no longer held).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseService } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
const INV = { 'env-a': { web: ['host-1', 'host-2', 'host-3'], tv: ['host-1/device1', 'host-2/device1'] } };
function harness(cfg = {}) {
  const clock = { t: Date.UTC(2026, 9, 31, 12, 0, 0), m: 5000 };
  const svc = createLeaseService({ dir: tmp('lease-eqv-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'], maxClaimMin: 1e6, inventory: () => INV, ...cfg } });
  const h = { clock, svc };
  h.advance = async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); };
  h.claim = (agent, resources, o = {}) => svc.claim({ env: 'env-a', resources: [].concat(resources), agent, kind: 'host', ...o });
  return h;
}

test('claim --any takes the first free member of the group and says which', async () => {
  const h = harness();
  assert.ok((await h.claim('a', 'host-1')).ok);
  const r = await h.svc.claim({ env: 'env-a', any: 'web', agent: 'b', kind: 'host' });
  assert.ok(r.ok);
  assert.deepEqual(r.lease.resources, ['host:host-2']);
  assert.deepEqual(r.chosen, ['host:host-2']);
  assert.equal(r.any, 'web');
});

test('claim --any with every member busy: E_HELD lists the options, a ticket is granted whichever frees first', async () => {
  const h = harness();
  const ids = [];
  for (const [a, x] of [['a', 'host-1'], ['b', 'host-2'], ['c', 'host-3']]) ids.push((await h.claim(a, x, { expect_min: 30 })).lease.id);
  const busy = await h.svc.claim({ env: 'env-a', any: 'web', agent: 'w', kind: 'host' });
  assert.equal(busy.code, 'E_HELD');
  assert.equal(busy.options.length, 3);
  const tk = (await h.svc.claim({ env: 'env-a', any: 'web', agent: 'w', kind: 'host', wait: 'ticket' })).ticket;
  assert.equal(tk.state, 'waiting');
  assert.equal(tk.any, 'web');
  assert.equal(tk.alternatives.length, 3);
  await h.svc.release({ id: ids[2] });                 // the third host frees first: the ticket gets it, not the one it was displayed on
  const g = await h.svc.ticket(tk.id);
  assert.equal(g.ticket.state, 'granted');
  assert.deepEqual(g.ticket.lease.resources, ['host:host-3']);
  assert.deepEqual(g.ticket.resources, ['host:host-3']);
});

test('an --any ticket does not take a member a named ticket queued for first', async () => {
  const h = harness();
  const l1 = (await h.claim('a', 'host-1')).lease.id;
  const l2 = (await h.claim('b', 'host-2')).lease.id;
  await h.claim('c', 'host-3');
  const named = (await h.claim('n', 'host-2', { wait: 'ticket' })).ticket;
  const any = (await h.svc.claim({ env: 'env-a', any: 'web', agent: 'w', kind: 'host', wait: 'ticket' })).ticket;
  await h.svc.release({ id: l2 });
  assert.equal((await h.svc.ticket(named.id)).ticket.state, 'granted', 'the named waiter was first on host-2');
  assert.equal((await h.svc.ticket(any.id)).ticket.state, 'waiting');
  await h.svc.release({ id: l1 });
  assert.deepEqual((await h.svc.ticket(any.id)).ticket.lease.resources, ['host:host-1']);
});

test('explicit alternatives work without an inventory; unknown group is refused with the known ones', async () => {
  const h = harness({ inventory: () => ({}) });
  await h.claim('a', 'host-1/device1');
  const r = await h.svc.claim({ env: 'env-a', resources: ['host-1/device1'], alternatives: [['host-2/device1']], agent: 'b', kind: 'host' });
  assert.deepEqual(r.lease.resources, ['device:host-2/device1']);
  const bad = await h.svc.claim({ env: 'env-a', any: 'nope', agent: 'b' });
  assert.equal(bad.code, 'E_INVALID');
  assert.match(bad.error, /unknown resource group/);
});

test('a named ticket shows the free equivalents of its resource; unique hardware shows none', async () => {
  const h = harness();
  await h.claim('a', 'host-1');
  await h.claim('b', 'host-3');
  const busy = await h.claim('w', 'host-1');
  assert.deepEqual(busy.equivalents_free.map((x) => x.legacy), ['host-2']);
  const tk = (await h.claim('w', 'host-1', { wait: 'ticket' })).ticket;
  assert.deepEqual(tk.equivalents_free, [{ group: 'web', resource: 'host:host-2', legacy: 'host-2' }]);
  await h.claim('a', 'host-9/device1');
  const uniq = (await h.claim('w2', 'host-9/device1', { wait: 'ticket' })).ticket;
  assert.equal(uniq.equivalents_free, undefined);
  const inv = await h.svc.inventory({ env: 'env-a' });
  assert.deepEqual(inv.groups.find((g) => g.group === 'web').members.map((m) => [m.resource, m.free]), [['host-1', false], ['host-2', true], ['host-3', false]]);
});

test('a host claim blocked only by a device lease gets the narrow-claim hint', async () => {
  const h = harness();
  await h.claim('run', 'host-1/device5');
  const r = await h.claim('w', 'host-1');
  assert.equal(r.code, 'E_HELD');
  assert.match(r.hint, /blocked only by device lease\(s\) on host-1\/device5/);
  assert.ok((await h.claim('w', 'host-1/device1')).ok, 'the narrow device claim is granted at once');
  await h.claim('x', 'host-2');
  assert.equal((await h.claim('w', 'host-2')).hint, undefined, 'a whole-host holder: no hint');
});

test('rolling deploy: releaseHosts drops a finished host from the deploy lease and the deploy stops blocking it', async () => {
  const h = harness();
  const q = await h.svc.deploy.request({ env: 'env-a', scope: 'host', hosts: ['host-1', 'host-2'], ref: 'r', agent: 'a', approved: true });
  const st = await h.svc.deploy.start({ id: q.id ?? q.deploy?.id, agent: 'manager:deploy' });
  assert.ok(st.ok, JSON.stringify(st));
  const id = st.deploy.id;
  assert.notEqual((await h.claim('w', 'host-1/device1')).ok, true, 'held while the deploy runs on it');
  const r = await h.svc.deploy.releaseHosts({ id, hosts: ['host-1'] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.released, ['host-1']);
  assert.ok((await h.claim('w', 'host-1/device1')).ok, 'a finished host is free while the deploy goes on');
  assert.notEqual((await h.claim('w2', 'host-2')).ok, true, 'the host still being deployed stays held');
  await h.svc.deploy.releaseHosts({ id, hosts: ['host-2'] });
  assert.equal(Object.values((await h.svc.list({ env: 'env-a' })).leases).filter((l) => l.deploy_id === id).length, 0, 'last host done: the deploy lease is gone');
  assert.equal((await h.svc.deploy.releaseHosts({ id: 'nope', hosts: ['host-1'] })).code, 'E_NOT_FOUND');
});
