// Round 12 (b): the orchestrator asks the holder to release or narrow (lease-nudge.js). Fake snapshots and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { planNudges, createLeaseNudge, reasonsOf } from '../lease-nudge.js';
import { classifyKey } from '../manager-events.js';
import { tmp } from './helpers-tmp.js';

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
test('a holder with no session that renews its lease is alive, not idle: the registry reports the time since the claim', () => {
  // the live case: a timer-driven bot holds a host lease, renews it every 3 min and is not idle at all
  const bot = lease({ id: 'LB', agent: 'codebox:pokemon-dispatch', kind: 'host', resources: ['host-1'], purpose: 'run on host-1', sinceMs: NOW - 33 * MIN, lastHeartbeatMs: NOW - 2 * MIN, idleMin: 33 });
  const t = { id: 'T9', env: 'env-a', resources: ['host-1'], agent: 'codebox:pokemon-stall', holders: ['codebox:pokemon-dispatch'], holderIds: ['LB'], createdMs: NOW - 12 * MIN };
  const plan = (l) => planNudges(base({ deploys: [], view: view([l], [t]), sessionOf: () => null, idleMinOf: (x) => x.idleMin ?? null }));
  assert.equal(plan(bot).length, 0);                                   // renewed 2 min ago: alive, nothing to ask
  assert.deepEqual(plan(lease({ ...bot, lastHeartbeatMs: NOW - 25 * MIN }))[0].reasons, ['idle 25 min']);   // the renewal stopped: stuck
  assert.deepEqual(plan(lease({ ...bot, lastHeartbeatMs: NOW - 33 * MIN }))[0].reasons, ['idle 33 min']);   // never renewed: a stale lease
});
test('a waiting ticket nudges its holders (matched by lease id)', () => {
  const t = { id: 'T9', env: 'env-a', resources: ['server'], agent: 'codebox:other', holders: ['codebox:worker'], holderIds: ['L1'], createdMs: NOW - 12 * MIN };
  const [n] = planNudges(base({ deploys: [], view: view([lease()], [t]) }));
  assert.match(n.text, /blocks codebox:other's claim T9 on env-a\/server \(waiting 12 min\)/);
  assert.equal(planNudges(base({ deploys: [], view: view([lease()], [{ ...t, createdMs: NOW - 4 * MIN }]) })).length, 0);
});

test('correctly scoped host lease on a device blocked by a deploy: no nudge, even when idle or past expect_min', () => {
  const row = { id: 'L7', env: 'env-a', resources: ['env-a/host-1/dev-3'], kind: 'host', agent: 'codebox:worker', purpose: 'script on dev-3', since: new Date(NOW - 90 * MIN).toISOString(), expect_min: 10 };
  const d = deploy({ blocking: [row] });
  assert.equal(planNudges(base({ deploys: [d], view: { ok: false } })).length, 0);
  assert.equal(planNudges(base({ deploys: [d], view: view([lease({ id: 'L7', kind: 'host', resources: ['host-1/dev-3'], purpose: 'script on dev-3', expectMin: 10 })]) })).length, 0);
});
test('an over-broad lease is nudged with its real resource, from the view or from the runner row', () => {
  const wide = lease({ id: 'L8', kind: 'server', resources: ['host-1'], purpose: 'host-1 script' });
  const [a] = planNudges(base({ deploys: [deploy({ blocking: [{ id: 'L8', agent: 'codebox:worker' }] })], view: view([wide]), idleMinOf: () => 0 }));
  assert.deepEqual(a.reasons, ['broader than its purpose']); assert.match(a.text, /lease L8 on env-a\/host-1 blocks/);
  const row = { id: 'L9', env: 'env-a', resources: ['env-a/host-1/dev-3'], kind: 'server', agent: 'codebox:worker', purpose: 'dev-3 run' };
  const [b] = planNudges(base({ deploys: [deploy({ blocking: [row] })], view: { ok: false } }));
  assert.match(b.text, /lease L9 on env-a\/host-1\/dev-3 blocks/);
  const [c] = planNudges(base({ deploys: [deploy({ blocking: [{ ...row, resources: ['env-a/*'] }] })], view: { ok: false } }));
  assert.match(c.text, /on env-a\/\* blocks/);
});

function harness(over = {}) {
  const dir = tmp('ghosty-nudge-');
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

// ---- wait watchdog (owner 2026-10-31): the waiter is told about a free equivalent; system-resolvable waits do not wake the manager ----
test('watchdog: a ticket waiting 5+ min while an equivalent is free gets one line in its own chat with the commands', async () => {
  const { planNudges, systemResolvable } = await import('../lease-nudge.js');
  const now = Date.UTC(2026, 9, 31, 18, 0, 0);
  const tk = (o = {}) => ({ id: 't-1', env: 'node1-vpt', resources: ['host-b'], agent: 'codebox:devinfo', createdMs: now - 6 * 60000, holderIds: [], holders: [], equivalents: ['host-a'], groups: ['web'], any: null, hint: '', ...o });
  const view = (tickets) => ({ ok: true, leases: [], tickets });
  const sessionOf = (a) => (a.startsWith('codebox:') ? a.slice(8) : null);
  const [n] = planNudges({ now, view: view([tk()]), sessionOf });
  assert.equal(n.session, 'devinfo');
  assert.ok(n.waiter);
  assert.match(n.text, /healthy equivalent is free now: host-a/);
  assert.match(n.text, /vpt-lease ticket t-1 --cancel/);
  assert.match(n.text, /vpt-lease claim node1-vpt host-a --agent codebox:devinfo --kind host --wait/);
  assert.match(n.text, /--any web/);
  assert.equal(planNudges({ now, view: view([tk({ createdMs: now - 20000 })]), sessionOf }).length, 0, 'under 30 s: nothing');
  assert.equal(planNudges({ now, view: view([tk({ equivalents: [] })]), sessionOf }).length, 0, 'unique hardware: nothing');
  assert.equal(planNudges({ now, view: view([tk({ any: 'web' })]), sessionOf }).length, 0, 'an --any ticket already waits on all of them');
  assert.equal(planNudges({ now, view: view([tk()]), sessionOf, last: new Map([['codebox:devinfo|t-1|waiter', now - 60000]]) }).length, 0, 'cooldown');
  const [h] = planNudges({ now, view: view([tk({ equivalents: [], hint: 'blocked only by device lease(s) on vpt-x/device5: ...' })]), sessionOf });
  assert.match(h.text, /only device runs block it/);
  assert.equal(planNudges({ now, view: view([tk({ equivalents: [], createdMs: now - 60 * 60000 })]), sessionOf }).length, 0, 'unique hardware / single-member group: no "pick another device" push, however long it waits');
  assert.equal(planNudges({ now, view: view([tk({ equivalents: [], any: 'web', createdMs: now - 16 * 60000 })]), sessionOf }).length, 0, 'an --any ticket: no probe advice');

  const v = view([tk()]);
  assert.match(systemResolvable({ session: 'devinfo', kind: 'lease', view: v, sessionOf }), /ticket t-1/);
  assert.equal(systemResolvable({ session: 'other', kind: 'lease', view: v, sessionOf }), null, 'no ticket of its own: the manager hears it');
  assert.match(systemResolvable({ session: 'x', kind: 'deploy', case: 'waiting_deploy', view: view([]), deploys: [{ id: 'd1', state: 'running', scope: 'host' }] }), /deploy d1/);
  assert.equal(systemResolvable({ session: 'x', kind: 'deploy', case: 'decision', deploys: [{ id: 'd1', state: 'running' }] }), null, 'a decision is not a system wait');
  assert.equal(systemResolvable({ session: 'x', kind: 'manager-item', view: v }), null);
});
test('an idle codebox holder whose chat cannot take the note is flagged to the manager once per cooldown (owner 2026-11-11)', async () => {
  const h = harness({ canSend: () => false });
  await h.n.tick();
  const flags = () => h.events.filter((e) => e.key === 'lease:idle-blocking');
  assert.equal(h.sent.length, 0);
  assert.equal(flags().length, 1);
  assert.match(flags()[0].title, /^worker holds L1 idle while deploy/);
  h.advance(2 * MIN); await h.n.tick();
  assert.equal(flags().length, 1, 'cooldown');
  const w = harness({ canSend: () => false, idleMinOf: () => 0 });   // working, not idle: no flag
  await w.n.tick();
  assert.equal(w.events.filter((e) => e.key === 'lease:idle-blocking').length, 0);
});

test('answerStop: a stop is answered at once (no 30 s age) with the free-equivalent line, only for that session, once', async () => {
  const sent = [];
  const tk = (agent, id) => ({ id, env: 'env-a', resources: ['host-1/device1'], agent, holders: [], createdMs: NOW - 2000, equivalents: ['host-1/device2'], groups: ['stb'] });
  const n = createLeaseNudge({ stateDir: tmp('ln-'), getInputs: async () => ({ deploys: [], view: view([], [tk('codebox:worker', 'T1'), tk('codebox:other', 'T2')]) }), sessionOf: (a) => a.replace('codebox:', ''), canSend: () => true, send: async (s, t) => { sent.push([s, t]); }, now: () => NOW, log: { log() {}, error() {} } });
  await n.tick();                                   // periodic tick: 2 s old, nothing yet
  assert.equal(sent.length, 0);
  await n.answerStop('worker');
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'worker');
  assert.match(sent[0][1], /STOP WAITING: your ticket T1 .* host-1\/device2/);
  assert.match(sent[0][1], /vpt-lease claim env-a host-1\/device2/);
  await n.answerStop('worker');
  assert.equal(sent.length, 1, 'cooldown: not twice');
});

test('a holder with no session (Mac) is nudged at 10 min without renewal, a codebox session still at 20', () => {
  const mac = lease({ id: 'LM', agent: 'mac:laptop', kind: 'host', resources: ['host-1'], purpose: 'run on host-1', sinceMs: NOW - 12 * MIN, lastHeartbeatMs: NOW - 12 * MIN });
  const t = { id: 'T9', env: 'env-a', resources: ['host-1'], agent: 'codebox:w', holders: ['mac:laptop'], holderIds: ['LM'], createdMs: NOW - 12 * MIN };
  const plan = planNudges(base({ deploys: [], view: view([mac], [t]), sessionOf: () => null, idleMinOf: () => 12 }));
  assert.deepEqual(plan[0].reasons, ['idle 12 min']);
  assert.deepEqual(reasonsOf(lease(), { now: NOW, idleMin: 12, minIdle: 20 }), []);
});
test('a waiter whose chat cannot take the note is journaled once as chat-cannot-take-note (bug-988c4f48)', async () => {
  const dir = tmp('ln-');
  const t = { id: 'T1', env: 'env-a', resources: ['host-1/device1'], agent: 'codebox:worker', holders: [], createdMs: NOW - 60000, equivalents: ['host-1/device2'], groups: ['stb'] };
  const n = createLeaseNudge({ stateDir: dir, getInputs: async () => ({ deploys: [], view: view([], [t]) }), sessionOf: (a) => a.replace('codebox:', ''), canSend: () => false, now: () => NOW, log: { log() {}, error() {} } });
  await n.tick(); await n.tick();
  const lines = readFileSync(join(dir, 'lease-nudges.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.match(lines[0], /"flag":"chat-cannot-take-note"/); assert.match(lines[0], /"ticketId":"T1"/);
});
