// Round 12 (b): the orchestrator asks the holder to release or narrow (lease-nudge.js). Fake snapshots and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNudges, createLeaseNudge, reasonsOf } from '../lease-nudge.js';
import { classifyKey } from '../manager-events.js';

const NOW = 1_800_000_000_000, MIN = 60000;
const lease = (o = {}) => ({ id: 'L1', env: 'env-a', resources: ['server'], mode: 'exclusive', kind: 'server', agent: 'codebox:worker', session: '', purpose: 'full run', sinceMs: NOW - 90 * MIN, expectMin: null, idleMin: null, ...o });
const deploy = (o = {}) => ({ id: 'd1', env: 'env-a', scope: 'full', ref: 'main', state: 'queued', created: (NOW - 15 * MIN) / 1000, blocking: [{ id: 'L1', env: 'env-a', resource: 'server', kind: 'server', agent: 'codebox:worker' }], ...o });
const view = (leases, tickets = []) => ({ ok: true, leases, tickets });
const sessions = (a) => (a === 'codebox:worker' ? 'worker' : null);
const base = (o = {}) => ({ now: NOW, deploys: [deploy()], view: view([lease()]), sessionOf: sessions, idleMinOf: () => 25, last: new Map(), ...o });

test('nudge when blocked > 10 min and the holder is idle', () => {
  const [n] = planNudges(base());
  assert.equal(n.leaseId, 'L1'); assert.equal(n.session, 'worker'); assert.deepEqual(n.reasons, ['idle 25 min']);
  assert.equal(n.text, 'Your lease L1 on env-a/server blocks deploy d1 (full main to env-a) (waiting 15 min). Release it if you are done (vpt-lease release L1), or narrow it to what you use (vpt-lease narrow L1 --resource <host/device> --kind host).');
});
test('no nudge: not waiting long enough, not blocking, not queued, holder busy, system holders', () => {
  assert.equal(planNudges(base({ deploys: [deploy({ created: (NOW - 5 * MIN) / 1000 })] })).length, 0);
  assert.equal(planNudges(base({ deploys: [deploy({ blocking: [] })] })).length, 0);
  assert.equal(planNudges(base({ deploys: [deploy({ state: 'running' })] })).length, 0);
  assert.equal(planNudges(base({ idleMinOf: () => 3 })).length, 0);
  assert.equal(planNudges(base({ idleMinOf: () => 0 })).length, 0);
  const sys = lease({ agent: 'manager:deploy' });
  assert.equal(planNudges(base({ view: view([sys]), deploys: [deploy({ blocking: [{ id: 'L1', agent: 'manager:deploy', resource: 'server', kind: 'server' }] })] })).length, 0);
  assert.equal(planNudges(base({ view: { ok: false } })).length, 1);   // a lease missing from the view still uses the runner's blocking row
});
test('reasons: past expect_min, idle, broader than its purpose', () => {
  assert.deepEqual(reasonsOf(lease({ expectMin: 30 }), { now: NOW }), ['past its expected 30 min']);
  assert.deepEqual(reasonsOf(lease({ expectMin: 120 }), { now: NOW }), []);
  assert.deepEqual(reasonsOf(lease({ resources: ['*'], purpose: 'frontend e2e' }), { now: NOW }), ['broader than its purpose']);
  assert.deepEqual(reasonsOf(lease({ resources: ['host-1'], kind: 'host', purpose: 'host-1 run' }), { now: NOW }), []);
  assert.deepEqual(reasonsOf(lease({ resources: ['*'], purpose: 'full server and frontend run' }), { now: NOW }), []);
});
test('a waiting ticket nudges its holders (matched by lease id)', () => {
  const t = { id: 'T9', env: 'env-a', resources: ['server'], agent: 'codebox:other', holders: ['codebox:worker'], holderIds: ['L1'], createdMs: NOW - 12 * MIN };
  const [n] = planNudges(base({ deploys: [], view: view([lease()], [t]) }));
  assert.match(n.text, /blocks codebox:other's claim T9 on env-a\/server \(waiting 12 min\)/);
  assert.equal(planNudges(base({ deploys: [], view: view([lease()], [{ ...t, createdMs: NOW - 4 * MIN }]) })).length, 0);
});

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-nudge-'));
  const sent = [], events = [];
  let t = NOW;
  const n = createLeaseNudge({ stateDir: dir, getInputs: async () => ({ deploys: [deploy({ blocking: [...deploy().blocking, { id: 'M1', env: 'env-a', resource: '*', kind: 'server', agent: 'mac:laptop' }] })], view: view([lease(), lease({ id: 'M1', agent: 'mac:laptop', resources: ['*'], purpose: 'frontend check' })]) }),
    sessionOf: sessions, idleMinOf: (l, s) => (s ? 25 : null), canSend: () => true, send: async (s, x) => { sent.push([s, x]); }, record: async (e) => { events.push(e); },
    mode: () => 'live', now: () => t, log: { log() {}, error() {} }, ...over });
  return { n, dir, sent, events, advance: (ms) => { t += ms; } };
}
test('codebox holder gets one line; mac holder gets a lease manager event instead; once per 30 min', async () => {
  const h = harness();
  const s1 = await h.n.tick();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0][0], 'worker');
  assert.equal(h.events.length, 1); assert.equal(classifyKey(h.events[0].key).kind, 'lease'); assert.match(h.events[0].body, /Your lease M1 on env-a\/\* blocks/);
  assert.equal(s1.sent, 1); assert.equal(s1.events, 1);
  h.advance(2 * MIN); await h.n.tick();
  h.advance(20 * MIN); await h.n.tick();
  assert.equal(h.sent.length, 1); assert.equal(h.events.length, 1);
  h.advance(10 * MIN); await h.n.tick();   // 32 min after the first
  assert.equal(h.sent.length, 2); assert.equal(h.events.length, 2);
  assert.ok(existsSync(join(h.dir, 'lease-nudges.jsonl')));
});
test('a working session, a draft or a menu gets no send and is retried; dry and off send nothing', async () => {
  let ok = false;
  const h = harness({ canSend: () => ok });
  await h.n.tick(); assert.equal(h.sent.length, 0);
  ok = true; h.advance(2 * MIN); await h.n.tick(); assert.equal(h.sent.length, 1);   // not marked while it could not be sent
  const d = harness({ mode: () => 'dry' }); await d.n.tick(); assert.equal(d.sent.length + d.events.length, 0);
  assert.equal(readFileSync(join(d.dir, 'lease-nudges.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
  const o = harness({ mode: () => 'off' }); await o.n.tick(); assert.equal(o.sent.length + o.events.length, 0);
  assert.equal(existsSync(join(o.dir, 'lease-nudges.jsonl')), false);
});
