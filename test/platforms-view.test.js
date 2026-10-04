import test from 'node:test';
import assert from 'node:assert/strict';
import { whoName, effectiveBlockers, envStatus, liveRows, platformsBlocks, etaText, leftText, kindLabel, resourceLabel } from '../public/platforms-view.js';
import { machinesOf } from '../public/platforms.js';

const M = machinesOf('codebox-vm');
const NAMES = ['TASK-28-tp-worker', 'task47-jev-routing', 'free-name'];
const NOW = 1_800_000_000_000;
const sec = NOW / 1000;
const E = 'node1-vpt';
const lease = (o = {}) => ({ id: 'l1', env: E, resource: 'vpt-pi1/device1', agent: 'codebox:TASK-28-tp-worker', kind: 'run', ttlLeftMin: 55, ...o });
const dep = (o = {}) => ({ id: 'd1', env: E, scope: 'full', ref: 'main', agent: 'codebox:task47-jev-routing', state: 'queued', created: 1, blocking: [], ...o });

test('whoName: plain session names', () => {
  assert.deepEqual(whoName('codebox:TASK-28-tp-worker', NAMES, M), { text: 'task28', gone: false, session: 'TASK-28-tp-worker' });
  assert.equal(whoName('codebox:task47-jev-routing', NAMES, M).text, 'task47');
  assert.equal(whoName('codebox:free-name', NAMES, M).text, 'free-name');
  assert.equal(whoName('claude-mac:labox-dongle-disk', NAMES, M).text, 'mac');
  assert.equal(whoName('manager:deploy', NAMES, M).text, 'manager');
  assert.equal(whoName('codebox-vm:task47-jev-routing', NAMES, M).text, 'task47');   // this host's name works like codebox
});
test('whoName: a codebox holder without a live tmux session is "gone", never unknown', () => {
  const w = whoName('codebox:task99-dead', NAMES, M);
  assert.equal(w.gone, true); assert.equal(w.text, '');
  assert.equal(whoName('codebox:', NAMES, M).gone, true);
});
test('kind label, time and resource text', () => {
  assert.equal(kindLabel('run'), 'test run'); assert.equal(kindLabel(undefined), 'test run'); assert.equal(kindLabel('maintenance'), 'maintenance');
  assert.equal(etaText(55), '~55 min'); assert.equal(etaText(100), '~1h40'); assert.equal(etaText(0), '<1 min'); assert.equal(etaText(null), '');
  assert.equal(leftText(20), '20 min left'); assert.equal(leftText(65), '1h05 left');
  assert.equal(resourceLabel(lease()), 'vpt-pi1 · device1'); assert.equal(resourceLabel(lease({ resource: '*' })), `${E} (all)`);
});
test('effectiveBlockers mirrors vpt-lease blockers(skip_leased): full = run leases + env-wide, host = env-wide only', () => {
  const run = lease({ id: 'a' }), maint = lease({ id: 'b', kind: 'maintenance' }), wide = lease({ id: 'c', resource: '*', kind: 'maintenance' }), fe = lease({ id: 'd', resource: 'frontend', kind: 'maintenance' });
  const blocking = [run, maint, wide, fe];
  assert.deepEqual(effectiveBlockers(dep({ scope: 'full', blocking })).map((l) => l.id), ['a', 'c']);
  assert.deepEqual(effectiveBlockers(dep({ scope: 'host', blocking })).map((l) => l.id), ['c']);
  assert.deepEqual(effectiveBlockers(dep({ scope: 'host', hosts: ['h1'], blocking })).map((l) => l.id), ['a', 'b', 'c', 'd']);   // catch-up: no skipping
  assert.deepEqual(effectiveBlockers(dep({ scope: 'server', blocking })).length, 4);
  assert.deepEqual(effectiveBlockers(dep({ scope: 'frontend', blocking: [fe] })).length, 1);
  assert.deepEqual(effectiveBlockers({ scope: 'full' }), []);
});
test('envStatus: running > blocked > free; a queued deploy with nothing in the way is FREE', () => {
  assert.equal(envStatus([]), 'FREE');
  assert.equal(envStatus([dep()]), 'FREE');
  assert.equal(envStatus([dep({ blocking: [lease()] })]), 'BLOCKED');
  assert.equal(envStatus([dep({ blocking: [lease({ kind: 'maintenance' })] })]), 'FREE');   // full skips a maintenance lease
  assert.equal(envStatus([dep({ state: 'running' }), dep({ id: 'd2', blocking: [lease()] })]), 'DEPLOYING');
  assert.equal(envStatus([dep({ state: 'done', blocking: [lease()] })]), 'FREE');
});
test('liveRows: every target, generic first, failed ones red with reason, stale attempts ignored', () => {
  const ent = (o = {}) => ({ at: sec - 2220, ref: 'main', version: 'main-9688', ...o });
  const rows = liveRows({
    'labox-tablet': ent({ at: sec - 6 * 3600, version: 'main-9669', lastAttempt: { at: sec - 60, reason: 'unreachable' } }),
    'host-clone-1': ent(), server: ent(), frontend: ent(),
    old: ent({ lastAttempt: { at: sec - 9999 } }),
    never: { lastAttempt: { at: sec - 5 } },
  }, NOW);
  assert.deepEqual(rows.map((r) => r.target), ['frontend', 'server', 'host-clone-1', 'labox-tablet', 'never', 'old']);
  const t = rows.find((r) => r.target === 'labox-tablet');
  assert.deepEqual([t.failed, t.reason, t.version, t.ago], [true, 'unreachable', 'main-9669', '6h ago']);
  assert.equal(rows.find((r) => r.target === 'server').failed, false);
  assert.equal(rows.find((r) => r.target === 'old').failed, false);
  const n = rows.find((r) => r.target === 'never');
  assert.deepEqual([n.deployed, n.failed, n.reason], [false, true, '']);
  assert.deepEqual(liveRows(null, NOW), []);
});
test('platformsBlocks: blocked env with next deploy, red blocking lease, normal maintenance lease', () => {
  const run = lease({ id: 'a', ttlLeftMin: 55 });
  const maint = lease({ id: 'b', resource: 'labox-dongle', agent: 'claude-mac:labox-dongle-disk', kind: 'maintenance', ttlLeftMin: 20 });
  const gone = lease({ id: 'c', resource: 'vpt-pi3/x', agent: 'codebox:task99-dead', ttlLeftMin: 5 });
  const d = dep({ blocking: [run, maint, gone], created: 5 });
  const [b] = platformsBlocks({ leases: [maint, run, gone], deploys: [d], deployed: { [E]: { server: { at: sec - 60, version: 'v' } } }, sessionNames: NAMES, machines: M, nowMs: NOW });
  assert.equal(b.status, 'BLOCKED');
  assert.deepEqual(b.inUse.map((r) => [r.id, r.blocks]), [['c', true], ['a', true], ['b', false]]);   // blockers first, then by time left
  assert.equal(b.inUse.find((r) => r.id === 'a').who.text, 'task28');
  assert.equal(b.inUse.find((r) => r.id === 'a').kindLabel, 'test run');
  assert.equal(b.inUse.find((r) => r.id === 'b').who.text, 'mac');
  assert.equal(b.inUse.find((r) => r.id === 'c').who.gone, true);
  assert.equal(b.next.length, 1);
  assert.deepEqual([b.next[0].scope, b.next[0].ref, b.next[0].who.text, b.next[0].eta, b.next[0].blocked], ['full', 'main', 'task47', '~55 min', true]);
  assert.equal(b.live.length, 1);
});
test('platformsBlocks: queued order, approve flag, history, deploying block, env ordering', () => {
  const deploys = [
    dep({ id: 'q2', created: 2, state: 'awaiting-approval', scope: 'frontend' }),
    dep({ id: 'q1', created: 1 }),
    dep({ id: 'h1', state: 'done', finished: sec - 2220, scope: 'server' }),
    dep({ id: 'h2', state: 'failed', finished: sec - 100 }),
    dep({ id: 'r', env: 'node3-qualiai', state: 'running', started: sec - 180, ref: 'main', scope: 'full', agent: 'manager:deploy' }),
  ];
  const out = platformsBlocks({ leases: [lease({ env: 'zzz-free', id: 'z' })], deploys, deployed: {}, sessionNames: NAMES, machines: M, nowMs: NOW });
  assert.deepEqual(out.map((e) => [e.env, e.status]), [['node3-qualiai', 'DEPLOYING'], [E, 'FREE'], ['zzz-free', 'FREE']]);
  assert.deepEqual(out[0].deploying && [out[0].deploying.startedAgo, out[0].deploying.who.text, out[0].deploying.scope], ['3m ago', 'manager', 'full']);
  const e = out[1];
  assert.deepEqual(e.next.map((n) => [n.id, n.approve, n.blocked]), [['q1', false, false], ['q2', true, false]]);
  assert.deepEqual(e.history.map((h) => [h.id, h.ok, h.ago]), [['h2', false, '2m ago'], ['h1', true, '37m ago']]);
  const blocked = platformsBlocks({ leases: [lease()], deploys: [dep({ env: 'a-free' }), dep({ blocking: [lease()] })], sessionNames: NAMES, machines: M, nowMs: NOW });
  assert.deepEqual(blocked.map((x) => x.status), ['BLOCKED', 'FREE']);
});
