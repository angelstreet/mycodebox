// Live mode (central-through-ssh / legacy): `vpt-lease list --json` carries tickets and the rich lease fields; the dashboard keeps them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseStore } from '../leases.js';
import { createLeaseSource } from '../lease-source.js';
import { planNudges } from '../lease-nudge.js';
import { answerLeaseAsk } from '../lease-ask.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const json = { now: NOW / 1000, leases: [{ id: 'L1', env: 'env-a', resource: 'frontend', agent: 'codebox:dev1', session: 'codebox:dev1', purpose: 'ui', kind: 'host', ttlLeftMin: 50, mode: 'exclusive', since: NOW / 1000 - 3600, idleMin: 12, expect_min: 30 }],
  waiters: [], tickets: [{ id: 'T1', env: 'env-a', resources: ['env-a/frontend'], agent: 'codebox:dev2', session: 'codebox:dev2', position: 1, eta: NOW / 1000 + 600, created: NOW / 1000 - 1800, holders: [{ id: 'L1', agent: 'codebox:dev1' }] }] };
const mk = () => createLeaseSource({ authority: 'central-through-ssh', now: () => NOW, legacy: { store: createLeaseStore({ run: async () => ({ code: 0, stdout: JSON.stringify(json), stderr: '' }), now: () => NOW }), registry: 'REG' } });

test('live view keeps tickets and idle/expect/session/mode from list --json', async () => {
  const v = await mk().view();
  assert.equal(v.tickets.length, 1); assert.equal(v.tickets[0].position, 1); assert.deepEqual(v.tickets[0].resources, ['frontend']);
  const l = v.leases[0];
  assert.equal(l.idleMin, 12); assert.equal(l.expectMin, 30); assert.equal(l.session, 'codebox:dev1'); assert.equal(l.sinceMs, NOW - 3600000);
});

test('live view: lease-ask says "you are #N" and lease-nudge nudges a waiting ticket and a holder past expect_min', async () => {
  const v = await mk().view();
  assert.match(answerLeaseAsk({ ask: 'is env-a frontend free', view: v, session: 'dev2', now: NOW }).text, /#1/);
  const plans = planNudges({ now: NOW, view: v, sessionOf: () => 'dev1', last: new Map() });
  assert.ok(plans.length >= 1); assert.ok(plans.some((p) => /past its expected 30 min/.test(p.reasons.join())));
});
