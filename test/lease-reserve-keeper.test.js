import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, keep } from '../scripts/lease-reserve-keeper.js';

function harness(o, leaseFn) {
  let t = 0; const calls = [], logs = [], ends = [];
  const deps = {
    pid: 4242, now: () => t, sleep: async (ms) => { t += ms; }, log: (m) => logs.push(m), save: () => {},
    lease: (args) => { calls.push(args); return leaseFn(args, calls); }, runEnd: (c) => ends.push(c),
  };
  return { deps, calls, logs, ends };
}
const o = (extra = {}) => ({ ...parseArgs(['start', '--env', 'e', '--agent', 'codebox:x', '--until', new Date(3 * 3600 * 1000).toISOString(), '--state', 's', '--on-end', 'restore', 'a/d1', 'a/d2']), ...extra });

test('parseArgs reads flags and resources', () => {
  const p = parseArgs(['start', '--env', 'n', '--agent', 'codebox:x', '--until', '2026-11-27T00:00:00Z', '--state', 's', 'h/d1', 'h/d2']);
  assert.deepEqual(p.res, ['h/d1', 'h/d2']); assert.equal(p.agent, 'codebox:x'); assert.equal(p.ttl, 60);
});

test('claims once, heartbeats, renews, releases and runs on-end at the end time', async () => {
  const h = harness(o(), (a) => ({ code: 0, out: a[0] === 'claim' ? 'abcdef12\n' : 'ok', err: '' }));
  await keep(o(), h.deps);
  const c = h.calls;
  assert.equal(c.filter((a) => a[0] === 'claim').length, 1);
  const claim = c.find((a) => a[0] === 'claim');
  assert.ok(claim.includes('a/d1') && claim.includes('a/d2') && claim.includes('--holder-pid') && claim.includes('4242') && claim.includes('--wait'));
  assert.ok(c.some((a) => a[0] === 'heartbeat' && a.includes('--active')));
  assert.ok(c.filter((a) => a[0] === 'renew').length >= 5);   // 3 h, every 20 min
  assert.ok(c.some((a) => a[0] === 'release' && a.includes('--agent')));
  assert.deepEqual(h.ends, ['restore']);
});

test('hold cap on renew: release and re-claim immediately', async () => {
  let n = 0;
  const h = harness(o(), (a) => {
    if (a[0] === 'claim') return { code: 0, out: `a${++n}000000\n`, err: '' };
    if (a[0] === 'renew' && n === 1) return { code: 7, out: '', err: 'hold cap' };
    return { code: 0, out: 'ok', err: '' };
  });
  await keep(o(), h.deps);
  assert.ok(n >= 2, 'claimed again after the cap');
  assert.ok(h.calls.some((a) => a[0] === 'release' && a[1] === "a1000000"));
});

test('lost lease (heartbeat fails) is re-claimed; failed claim retries', async () => {
  let claims = 0, hbFail = true;
  const h = harness(o(), (a) => {
    if (a[0] === 'claim') { claims++; return claims === 1 ? { code: 3, out: '', err: 'busy' } : { code: 0, out: 'beef0001\n', err: '' }; }
    if (a[0] === 'heartbeat' && hbFail) { hbFail = false; return { code: 1, out: '', err: 'E_NOT_FOUND' }; }
    return { code: 0, out: 'ok', err: '' };
  });
  await keep(o(), h.deps);
  assert.ok(claims >= 3);
});

test('stop signal ends early and still releases + runs on-end', async () => {
  const h = harness(o(), (a) => ({ code: 0, out: a[0] === 'claim' ? 'abcdef12\n' : 'ok', err: '' }));
  const orig = h.deps.sleep; let k = 0;
  h.deps.sleep = async (ms) => { await orig(ms); if (++k === 2) h.deps.onStop(); };
  const r = await keep(o(), h.deps);
  assert.equal(r.stopped, true); assert.deepEqual(h.ends, ['restore']);
});
