// TASK-58 C10: read-only VPT take-control locks next to the vpt-lease leases on the Platforms page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVptLockStore, lockRows } from '../vpt-locks.js';
import { platformsBlocks, locksForResource, vptLockLabel } from '../public/platforms-view.js';

const NOW = 1_800_000_000;   // seconds
const raw = {
  'vpt-pi1:stb4': { host_name: 'vpt-pi1', device_id: 'stb4', owner_type: 'manual_control', owner_user_name: 'jo', owner_session_id: 'SECRET', locked_at: NOW - 240, lock_lifespan: 1 },
  'vpt-pi3:device1': { host_name: 'vpt-pi3', device_id: 'device1', owner_type: 'script', owner_job_id: 'j1', locked_at: NOW - 7200, lock_reason: 'nightly', active_script_reason: 'smoke' },
};
const okFetch = (calls = []) => async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ success: true, locked_devices: raw }) }; };

test('lockRows: small rows, no session ids, ages from locked_at', () => {
  const rows = lockRows(raw, NOW);
  assert.deepEqual(rows.map((r) => [r.host, r.device, r.ownerType, r.owner, r.ageMin]), [['vpt-pi1', 'stb4', 'manual_control', 'jo', 4], ['vpt-pi3', 'device1', 'script', '', 120]]);
  assert.equal(rows[1].reason, 'smoke');
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  assert.deepEqual(lockRows(null, NOW), []);
});

test('store: GET only with the API key to the origin of JEV_URL; cached; one request in flight', async () => {
  const calls = [];
  let t = 1_000_000;
  const s = createVptLockStore({ jevUrl: 'http://10.0.0.3:5109/server/ai/decide', apiKey: 'k', fetchFn: okFetch(calls), now: () => t, ttlMs: 15000 });
  const [a, b] = await Promise.all([s.get(), s.get()]);
  assert.equal(calls.length, 1);
  assert.equal(a.ok, true); assert.equal(b.locks.length, 2);
  assert.equal(calls[0].url, 'http://10.0.0.3:5109/server/control/lockedDevices');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-API-Key'], 'k');
  assert.equal(calls[0].init.body, undefined);
  t += 14000; await s.get(); assert.equal(calls.length, 1);
  t += 2000; await s.get(); assert.equal(calls.length, 2);
});

test('store: failures (network, http 401, bad json, not configured) are {ok:false}, never throw, short error cache', async () => {
  let t = 1_000_000, n = 0;
  const mk = (fetchFn, o = {}) => createVptLockStore({ jevUrl: 'http://h:1/x', apiKey: 'k', fetchFn, now: () => t, ...o });
  const down = mk(async () => { n++; throw new Error('ECONNREFUSED'); });
  assert.deepEqual(await down.get(), { ok: false, error: 'ECONNREFUSED' });
  await down.get(); assert.equal(n, 1, 'error is cached briefly');
  t += 11000; await down.get(); assert.equal(n, 2);
  assert.equal((await mk(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })).get()).ok, false);
  assert.equal((await mk(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })).get()).ok, false);
  assert.equal((await createVptLockStore({ jevUrl: '', apiKey: '' }).get()).ok, false);
  // timeout guard: a hung server resolves to ok:false within timeoutMs
  const hung = mk((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('timed out')))), { timeoutMs: 50 });
  const t0 = Date.now(); const r = await hung.get();
  assert.equal(r.ok, false); assert.ok(Date.now() - t0 < 2000);
});

test('locksForResource: host/device, whole host, env-wide, vpt-/host- prefixes ignored', () => {
  const locks = lockRows(raw, NOW);
  assert.equal(locksForResource('vpt-pi1/stb4', locks).length, 1);
  assert.equal(locksForResource('pi1/stb4', locks).length, 1);
  assert.equal(locksForResource('vpt-pi1/other', locks).length, 0);
  assert.equal(locksForResource('vpt-pi3', locks).length, 1);
  assert.equal(locksForResource('*', locks).length, 2);
});

const leases = [
  { id: 'l1', env: 'node1-vpt', resource: 'vpt-pi1/stb4', agent: 'codebox:s1', kind: 'host', ttlLeftMin: 30 },
  { id: 'l2', env: 'node1-vpt', resource: 'vpt-pi1/free1', agent: 'codebox:s2', kind: 'host', ttlLeftMin: 20 },
  { id: 'l3', env: 'node3-qualiai', resource: 'host-x/y', agent: 'codebox:s3', kind: 'host', ttlLeftMin: 20 },
];
const view = (vptLocks) => platformsBlocks({ leases, deploys: [], deployed: {}, sessionNames: ['s1', 's2', 's3'], machines: new Set(['codebox']), nowMs: NOW * 1000, vptLocks });
const block = (v, env) => v.find((b) => b.env === env);

test('platformsBlocks: both locks per device, lock-only devices listed, other envs untouched', () => {
  const v = view({ ok: true, env: 'node1-vpt', locks: lockRows(raw, NOW) });
  const b = block(v, 'node1-vpt');
  assert.equal(b.inUse.find((r) => r.resource === 'vpt-pi1/stb4').vptLock, 'VPT lock: manual_control · jo, 4m');
  assert.equal(b.inUse.find((r) => r.resource === 'vpt-pi1/free1').vptLock, 'VPT lock: free');
  assert.deepEqual(b.vptOther.map((x) => x.resource), ['vpt-pi3 · device1']);   // locked without a lease
  assert.match(b.vptOther[0].text, /^script · smoke, 2h00$/);
  assert.equal(block(v, 'node3-qualiai').inUse[0].vptLock, '');
  assert.deepEqual(block(v, 'node3-qualiai').vptOther, []);
});

test('platformsBlocks: failure = "VPT lock: unknown" on every lease row of that env; no data yet = no label; page still builds', () => {
  const b = block(view({ ok: false, env: 'node1-vpt', error: 'ECONNREFUSED' }), 'node1-vpt');
  assert.deepEqual(b.inUse.map((r) => r.vptLock), ['VPT lock: unknown', 'VPT lock: unknown']);
  assert.equal(b.vptUnknown, true);
  assert.equal(vptLockLabel(null, 'x'), 'VPT lock: unknown');
  assert.deepEqual(block(view(null), 'node1-vpt').inUse.map((r) => r.vptLock), ['', '']);
  assert.equal(block(view(undefined), 'node1-vpt').vptUnknown, false);
});

test('platformsBlocks: a held lock shows its env even without any lease or deploy there', () => {
  const v = platformsBlocks({ leases: [], deploys: [], deployed: {}, vptLocks: { ok: true, env: 'node1-vpt', locks: lockRows(raw, NOW) } });
  assert.equal(v.length, 1); assert.equal(v[0].vptOther.length, 2);
});
