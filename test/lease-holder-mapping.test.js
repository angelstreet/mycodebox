import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyHolders, createLeaseWatch } from '../lease-watch.js';
import { leaseLines } from '../lease-stats.js';
import { machinesOf } from '../public/platforms.js';
import { tmp } from './helpers-tmp.js';

// E47: a lease says "somebody is working on this host". The dashboard must be able to say WHO.
// The agent names that really appear in this fleet: sessions, the platform's own workers, system agents, a Mac.
const M = machinesOf('codebox-vm');
const NOW = 1_800_000_000_000;
const MIN = 60000;
const SESSIONS = ['mm-manager', 'manager', 'coc-hourly-run', 'pokemon-stall', 'TASK146-parallel-browser', 'flash-host-registration'];
const lease = (agent, o = {}) => ({ id: 'l1', env: 'node1-vpt', resource: 'vpt-pi1/device1', agent, kind: 'server', since: (NOW - 60 * MIN) / 1000, ...o });
const one = (agent, extra = {}) => classifyHolders({ leases: [lease(agent)], sessionNames: SESSIONS, knownNames: SESSIONS, machines: M, now: NOW, ...extra })[0];
const who = (agent, extra = {}) => { const h = one(agent, extra); return [h.status, h.session]; };

test('E47: the eight real agent names are classified, none of them "unknown"', () => {
  const table = [
    ['mm-manager', 'live', 'mm-manager'],
    ['manager:deploy', 'system', null],
    ['update_core:someone@example-host', 'system', null],
    ['running-execution', 'platform', null],
    ['codebox:coc-hourly-run', 'live', 'coc-hourly-run'],
    ['codebox:pokemon-stall', 'live', 'pokemon-stall'],
    ['mac:studio', 'remote', null],
    ['flash-host-registration', 'live', 'flash-host-registration'],
  ];
  assert.deepEqual(table.map(([agent]) => [agent, ...who(agent)]), table);
});

test('E47: a bare session name maps to its session; a machine prefix still maps the same way', () => {
  assert.deepEqual(who('flash-host-registration'), ['live', 'flash-host-registration']);
  assert.deepEqual(who('codebox:flash-host-registration'), ['live', 'flash-host-registration']);
  assert.deepEqual(who('FLASH-HOST-REGISTRATION'), ['live', 'flash-host-registration']);   // case and punctuation do not matter
  assert.deepEqual(who('codebox:coc-hourly'), ['live', 'coc-hourly-run']);                 // the existing unique-prefix rule
  assert.deepEqual(who('never-heard-of-it'), ['unknown', null]);
});

test('E47: a bare-named session that ended is released (the leak is closed)', () => {
  const h = classifyHolders({ leases: [lease('flash-host-registration')], sessionNames: ['mm-manager', 'manager'], knownNames: SESSIONS, machines: M, now: NOW })[0];
  assert.equal(h.status, 'ended');
  assert.equal(h.session, 'flash-host-registration');
  assert.deepEqual(h.plan, { type: 'release', reason: 'session-ended' });
});

test('E47: the platform\'s own agent is identifiable and is never released or narrowed', () => {
  const h = one('running-execution');
  assert.equal(h.status, 'platform');
  assert.equal(h.agent, 'running-execution');       // the dashboard shows who holds it
  assert.equal(h.session, null);
  assert.equal(h.plan, null);
  assert.equal(one('running-execution', { activity: () => ({ turnAt: NOW - 90 * MIN, promptAt: 0, working: false }) }).plan, null);
});

test('E47: a holder that is neither a session nor a platform agent is still unknown and never released', () => {
  const h = one('stb4-anchor-run');
  assert.equal(h.status, 'unknown');
  assert.equal(h.session, null);
  assert.equal(h.plan, null);
  assert.equal(one('mac:studio').plan, null);          // a Mac holder is never released from here
  assert.equal(one('manager:deploy').plan, null);       // a system holder is never touched
});

test('E47: the dashboard data names every holder and the report counts only the unidentifiable ones', async () => {
  const dir = tmp('e47-');
  const agents = ['mm-manager', 'manager:deploy', 'update_core:someone@example-host', 'running-execution',
    'codebox:coc-hourly-run', 'codebox:pokemon-stall', 'mac:studio', 'flash-host-registration', 'stb4-anchor-run'];
  const leases = agents.map((agent, i) => lease(agent, { id: `l${i}` }));
  const run = async (args) => (args[0] === 'list' ? { code: 0, stdout: JSON.stringify({ leases }) } : { code: 0, stdout: 'ok' });
  const w = createLeaseWatch({ stateDir: dir, run, machines: M, listSessionNames: async () => SESSIONS, mode: () => 'dry', now: () => NOW, log: { log() {}, error() {} } });
  const s = await w.poll();
  assert.equal(s.holders.length, agents.length);
  assert.ok(s.holders.every((h) => typeof h.agent === 'string' && h.agent.length > 0), 'every lease carries its holder\'s name');
  assert.deepEqual(s.holders.map((h) => [h.agent, h.status]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['codebox:coc-hourly-run', 'live'], ['codebox:pokemon-stall', 'live'], ['flash-host-registration', 'live'],
    ['mac:studio', 'remote'], ['manager:deploy', 'system'], ['mm-manager', 'live'],
    ['running-execution', 'platform'], ['stb4-anchor-run', 'unknown'], ['update_core:someone@example-host', 'system'],
  ]);
  assert.equal(s.unknown, 1);                                   // only the free-form name is unknown
  const day = w.state().days[new Date(NOW).toISOString().slice(0, 10)];
  assert.equal(day.unknownMax, 1);
  const zero = { deploys: 0, p95Min: null, blockedCount: 0, blockedMinutes: 0 };
  const report = leaseLines(zero, zero, { last: day.last, unknownMax: day.unknownMax }).join('\n');
  assert.match(report, /unknown-holder leases .*now 1, max today 1/);
});
