// Holder death releases the lease (owner 2026-10-27): pid + start time, two dead checks 30 s apart, never a live holder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createLeaseService } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const SEC = 1000;
function harness(cfg = {}) {
  const clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0), m: 5000 };
  const procs = new Map([[4242, '1000']]);               // pid -> start time; absent = dead
  const svc = createLeaseService({ dir: tmp('lease-hg-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'], procStart: (p) => procs.get(p) ?? null, ...cfg } });
  const advance = async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); };
  const claim = (agent, res, o = {}) => svc.claim({ env: 'env-a', resources: [res], agent, ...o });
  return { clock, procs, svc, advance, claim };
}
const held = async (h) => (await h.svc.list({})).leases?.length ?? 0;
const reaped = async (h) => (await h.svc.events({})).events.filter((e) => e.reason === 'holder-gone');

test('dead holder_pid is released after two checks 30 s apart, journaled with the reason', async () => {
  const h = harness();
  const r = await h.claim('codebox:disp', 'device:host-1/device4', { holder_pid: 4242 });
  assert.equal(r.ok, true);
  await h.advance(40 * SEC); assert.equal(await held(h), 1);
  h.procs.delete(4242);
  await h.advance(31 * SEC); assert.equal(await held(h), 1, 'first dead check: kept');
  await h.advance(31 * SEC);
  assert.equal(await held(h), 0, 'second dead check: released');
  const e = await reaped(h);
  assert.equal(e.length, 1);
  assert.match(e[0].detail, /released stale lease .* holder pid 4242 is gone/);
});

test('a live holder is kept; a single missed check does not release', async () => {
  const h = harness();
  await h.claim('codebox:disp', 'device:host-1/device4', { holder_pid: 4242 });
  h.procs.delete(4242); await h.advance(31 * SEC);
  h.procs.set(4242, '1000'); await h.advance(31 * SEC); await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 1);
});

test('a reused pid (different start time) counts as dead', async () => {
  const h = harness();
  await h.claim('codebox:disp', 'device:host-1/device4', { holder_pid: 4242 });
  h.procs.set(4242, '9999');
  await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 0);
});

test('agent codebox:<name>-<pid> is tracked without holder_pid', async () => {
  const h = harness();
  await h.claim('codebox:TASK-168-4242', 'device:host-1/device4');
  h.procs.delete(4242);
  await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 0);
});

test('a pid that is not alive at claim time, or lives on another host, is not tracked (TTL behaviour)', async () => {
  const h = harness();
  await h.claim('codebox:x-777', 'device:host-1/device1');                              // 777 never existed
  await h.claim('codebox:y', 'device:host-1/device2', { holder_pid: 4242, holder_host: 'proxmox-elsewhere' });
  h.procs.delete(4242);
  await h.advance(31 * SEC); await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 2);
  assert.equal((await reaped(h)).length, 0);
});

test('same host name is tracked; heartbeat-less, pid-less lease and mac agents are unaffected', async () => {
  const h = harness();
  await h.claim('codebox:z', 'device:host-1/device1', { holder_pid: 4242, holder_host: os.hostname() });
  await h.claim('codebox:plain', 'device:host-1/device2');
  await h.claim('mac:laptop-4242', 'device:host-1/device3');
  h.procs.delete(4242);
  await h.advance(31 * SEC); await h.advance(31 * SEC);
  const ls = (await h.svc.list({})).leases.map((l) => l.agent).sort();
  assert.deepEqual(ls, ['codebox:plain', 'mac:laptop-4242']);
});

test('pin and observe modes are untouched', async () => {
  const h = harness();
  await h.claim('codebox:p', 'device:host-1/device1', { holder_pid: 4242, mode: 'pin' });
  h.procs.delete(4242);
  await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 1);
});

test('invalid holder_pid is refused', async () => {
  const h = harness();
  assert.equal((await h.claim('codebox:a', 'device:host-1/device1', { holder_pid: 1 })).ok, false);
  assert.equal((await h.claim('codebox:a', 'device:host-1/device1', { holder_pid: 'x' })).ok, false);
});

test('an agent-name pid from another host (holder_host differs) is not tracked', async () => {
  const h = harness();
  await h.claim('codebox:TASK-168-4242', 'device:host-1/device4', { holder_host: 'proxmox-elsewhere' });
  h.procs.delete(4242);
  await h.advance(31 * SEC); await h.advance(31 * SEC); await h.advance(31 * SEC);
  assert.equal(await held(h), 1);
});
