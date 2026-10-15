import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLeaseSource, centralRegistry, createSessionTracker, normLease, normTicket, legacyRows, fromLegacyRows, legacyResource, summarize, eventRecord, eventNote, eventSession, isNoteEvent, noteAllowed, activeHolds, parseArgs, exitOf, LEGACY_REFUSAL } from '../lease-source.js';
import { createLeaseWatch } from '../lease-watch.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const rows = [{ id: 'a1', env: 'env-a', resource: 'frontend', agent: 'codebox:dev1', purpose: 'ui', kind: 'host', ttlLeftMin: 50 }];
const legacyStore = { calls: 0, get: async function () { this.calls++; return { ok: true, leases: rows, waiters: [{ agent: 'x' }] }; }, peek: () => ({ ok: true, leases: rows, waiters: [] }) };
const svcLease = { id: 'L1', env: 'env-a', resources: ['env-a/device:host-1/device2', 'env-a/frontend'], mode: 'exclusive', kind: 'host', agent: 'codebox:dev1', session: 'codebox:dev1', purpose: 'run', since: NOW - 600000, expires_at: NOW + 3600000, idleMin: 12, lastHeartbeatAt: NOW - 60000 };
const pinLease = { id: 'L2', env: 'env-a', resources: ['env-a/host:host-1'], mode: 'pin', agent: 'mac:x', since: NOW - 1000, ttlLeftMin: 30 };
function fakeService(over = {}) {
  const calls = [];
  const svc = {
    calls,
    list: async () => ({ ok: true, leases: [svcLease, pinLease], tickets: [{ id: 'T1', env: 'env-a', resources: ['env-a/frontend'], agent: 'codebox:dev2', position: 1, eta: NOW + 120000, holders: ['codebox:dev1'] }], deploys: [] }),
    ownerRelease: async (a) => { calls.push(['ownerRelease', a]); return { ok: true, released: [a.id] }; },
    setMode: async (a) => { calls.push(['setMode', a]); return { ok: true }; },
    sessionGone: async (s, o) => { calls.push(o ? ['sessionGone', s, o] : ['sessionGone', s]); },
    activity: async (s) => { calls.push(['activity', s]); return { ok: true, touched: 2 }; },
    sessionStatus: async (s, st, t) => { calls.push(['sessionStatus', s, st, t]); },
    heartbeat: async (a) => { calls.push(['heartbeat', a]); return { ok: true }; },
    shadow: { list: async () => ({ reports: [{ machine: 'host-1', command: 'claim', legacy: { code: 0 }, central: { code: 3 } }] }) },
    deploy: {
      list: async () => ({ ok: true, deploys: [{ id: 'd1', env: 'env-a', state: 'queued' }] }), last: async () => ({ ok: true, envs: { 'env-a': {} } }),
      request: async (a) => { calls.push(['request', a]); return { ok: true, id: 'abc123' }; }, approve: async (a) => { calls.push(['approve', a]); return { ok: true }; },
      cancel: async (a) => { calls.push(['cancel', a]); return { ok: true }; },
      start: async (a) => { calls.push(['start', a]); return a.id === 'busy' ? { ok: false, code: 'E_HELD', error: 'held' } : { ok: true, lease: { id: 'L9' } }; },
      finish: async (a) => { calls.push(['finish', a]); return { ok: true }; },
    },
    ...over,
  };
  return svc;
}

test('shapes: typed resources map to the legacy spelling; rows are exclusive-only', () => {
  assert.equal(legacyResource('env-a', 'env-a/*'), '*');
  assert.equal(legacyResource('env-a', 'env-a/frontend'), 'frontend');
  assert.equal(legacyResource('env-a', 'env-a/host:host-1'), 'host-1');
  assert.equal(legacyResource('env-a', 'device:host-1/device2'), 'host-1/device2');
  const l = normLease(svcLease, NOW);
  assert.deepEqual(l.resources, ['host-1/device2', 'frontend']);
  assert.equal(l.ttlLeftMin, 60); assert.equal(l.idleMin, 12);
  const r = legacyRows([l, normLease(pinLease, NOW)]);
  assert.equal(r.length, 2); assert.ok(r.every((x) => x.id === 'L1'));
  assert.deepEqual(Object.keys(r[0]).sort(), ['agent', 'env', 'id', 'kind', 'purpose', 'resource', 'ttlLeftMin']);
  assert.equal(fromLegacyRows(rows)[0].mode, 'exclusive');
  assert.equal(normTicket({ id: 't', env: 'e', resources: ['e/frontend'], eta: 2 }, NOW).etaMs, NOW + 120000);
});

test('legacy authority: everything is the store, nothing touches a service', async () => {
  const src = createLeaseSource({ authority: 'legacy', legacy: { store: legacyStore, registry: 'REG' }, getService: () => { throw new Error('no service in legacy'); }, now: () => NOW });
  assert.deepEqual(await src.get(), { ok: true, leases: rows, waiters: [{ agent: 'x' }] });
  assert.deepEqual(src.peek(), { ok: true, leases: rows, waiters: [] });
  assert.equal(src.deployRegistry(), 'REG');
  assert.equal(src.acts(), true);
  const v = await src.view();
  assert.equal(v.authority, 'legacy'); assert.equal(v.leases[0].id, 'a1'); assert.deepEqual(v.tickets, []);
  assert.equal(await src.sessionGone('x'), false); assert.equal(await src.sessionStatus('x', 'waiting'), false);
  assert.equal(await src.activity('x', ['a1']), 0);
  assert.deepEqual(await src.ownerRelease('a1'), { ok: false, status: 409, error: LEGACY_REFUSAL });
  assert.deepEqual(await src.ownerMode('a1', 'pin'), { ok: false, status: 409, error: LEGACY_REFUSAL });
});

test('central authority: get() has the legacy shape from the service; the registry is never used', async () => {
  const svc = fakeService();
  const src = createLeaseSource({ authority: 'central', legacy: { store: { get: () => { throw new Error('registry read'); }, peek: () => { throw new Error('registry read'); } }, registry: 'REG' }, getService: () => svc, now: () => NOW });
  assert.equal(src.peek(), null);
  const g = await src.get();
  assert.equal(g.ok, true); assert.deepEqual(g.leases.map((x) => x.resource), ['host-1/device2', 'frontend']);
  assert.equal(src.peek().leases.length, 2);
  assert.equal(src.acts(), false);
  assert.notEqual(src.deployRegistry(), 'REG');
  const v = await src.view();
  assert.equal(v.authority, 'central'); assert.equal(v.tickets[0].position, 1); assert.equal(v.shadow.length, 1); assert.equal(v.leases.length, 2);
  assert.deepEqual(summarize(v, NOW), { ok: true, held: 1, pins: 1, queued: 1, idle: 1, head: { resource: 'frontend', env: 'env-a', count: 1, etaMin: 2 } });
});

test('central: an unavailable or failing service is a failure, never "free"', async () => {
  const none = createLeaseSource({ authority: 'central', getService: () => null });
  assert.deepEqual(await none.get(), { ok: false, error: 'lease service not available' });
  const bad = createLeaseSource({ authority: 'central', getService: () => fakeService({ list: async () => ({ ok: false, code: 'E_UNAVAILABLE', error: 'journal corrupt' }) }) });
  assert.equal((await bad.get()).ok, false);
  const boom = createLeaseSource({ authority: 'central', getService: () => fakeService({ list: async () => { throw new Error('x'); } }) });
  assert.equal((await boom.view()).ok, false);
  assert.equal(summarize({ ok: false }).ok, false);
});

test('owner actions call the service with by owner and the identity (central); only pin is a valid mode', async () => {
  const svc = fakeService();
  const src = createLeaseSource({ authority: 'central', getService: () => svc });
  assert.equal((await src.ownerRelease('L1', 'me@example.test')).ok, true);
  assert.deepEqual(svc.calls[0], ['ownerRelease', { id: 'L1', by: 'owner:me@example.test', identity: 'me@example.test' }]);
  assert.equal((await src.ownerMode('L1', 'pin')).ok, true);
  assert.deepEqual(svc.calls[1], ['setMode', { id: 'L1', mode: 'pin', by: 'owner', owner: true, identity: 'loopback' }]);
  assert.equal((await src.ownerMode('L1', 'exclusive')).status, 400);
  const nf = createLeaseSource({ authority: 'central', getService: () => fakeService({ ownerRelease: async () => ({ ok: false, code: 'E_NOT_FOUND', error: 'no such lease' }) }) });
  assert.equal((await nf.ownerRelease('zz')).status, 404);
});

test('sessionGone / sessionStatus reach the service with codebox:<name> (central only); STATUS text rides along', async () => {
  const svc = fakeService();
  const src = createLeaseSource({ authority: 'central', getService: () => svc });
  await src.sessionGone('dev1'); await src.sessionStatus('dev1', 'blocked', 'waiting on CI');
  assert.deepEqual(svc.calls, [['sessionGone', 'codebox:dev1'], ['sessionStatus', 'codebox:dev1', 'blocked', 'waiting on CI']]);
  assert.equal(await createLeaseSource({ authority: 'central', getService: () => ({ sessionGone: async () => { throw new Error('x'); } }) }).sessionGone('a'), false);
});

test('session tracker: first tick learns, a vanished session is reported once, a failed listing judges nothing, a re-created name is a new session', async () => {
  const gone = [];
  const opts = [];
  const src = { sessionGone: async (n, o) => { gone.push(n); opts.push(o); } };
  let ok = true;
  const t = createSessionTracker({ source: src, isListOk: () => ok });
  assert.deepEqual(await t.observe(new Map([['a', 1], ['b', 2]])), []);
  assert.deepEqual(await t.observe(new Map([['a', 1]])), ['b']);
  assert.deepEqual(await t.observe(new Map([['a', 1]])), []);
  ok = false; assert.deepEqual(await t.observe(new Map()), []);
  ok = true; assert.deepEqual(await t.observe(new Map([['a', 9]])), ['a']);   // same name, other tmux creation time
  assert.deepEqual(gone, ['b', 'a']);
  assert.deepEqual(opts, [undefined, { immediate: true }]);   // vanished: the service's grace; replaced: at once
  assert.deepEqual(await createSessionTracker({ source: src }).observe(['x']), []);   // plain names work too
});

test('activity: working or recently finished sessions keep their exclusive holds alive', async () => {
  const leases = [normLease(svcLease, NOW), normLease(pinLease, NOW), normLease({ ...svcLease, id: 'L3', session: 'codebox:dev9', agent: 'codebox:dev9' }, NOW)];
  const act = { dev1: { working: true, turnAt: 0 }, dev9: { working: false, turnAt: NOW - 3600000, promptAt: 0 } };
  const by = activeHolds({ leases, sessionOf: (l) => l.agent.replace('codebox:', ''), activityOf: (n) => act[n] || null, now: NOW });
  assert.deepEqual([...by], [['dev1', ['L1']]]);
  const svc = fakeService();
  assert.equal(await createLeaseSource({ authority: 'central', getService: () => svc }).activity('dev1'), 2);
  assert.deepEqual(svc.calls[0], ['activity', 'codebox:dev1']);
});

test('central deploy registry: argv in, registry-shaped answers out', async () => {
  const svc = fakeService();
  const reg = centralRegistry(() => svc, { now: () => NOW });
  const list = await reg(['deploy', 'list', '--json']);
  const j = JSON.parse(list.stdout);
  assert.equal(list.code, 0); assert.equal(j.deploys[0].id, 'd1'); assert.equal(j.leases[0].resource, 'host-1/device2');
  assert.equal(JSON.parse((await reg(['deploy', 'last', '--json'])).stdout).envs['env-a'] !== undefined, true);
  const req = await reg(['deploy', 'request', 'env-a', '--scope', 'host', '--ref', 'main', '--agent', 'manager:deploy', '--approved', '--hosts', 'host-1,host-2', '--purpose', 'catch-up']);
  assert.equal(req.stdout.trim(), 'abc123');
  assert.deepEqual(svc.calls.at(-1)[1], { exempt: true, env: 'env-a', scope: 'host', ref: 'main', agent: 'manager:deploy', approved: true, hosts: ['host-1', 'host-2'], purpose: 'catch-up', ttl: undefined });
  assert.equal((await reg(['deploy', 'start', 'busy', '--skip-leased'])).code, 3);
  const st = await reg(['deploy', 'start', 'd1', '--skip-leased']);
  assert.equal(st.code, 0); assert.equal(JSON.parse(st.stdout).lease.id, 'L9'); assert.equal(svc.calls.at(-1)[1].skip_leased, true);
  await reg(['deploy', 'finish', 'd1', '--status', 'done', '--version', 'v1.2.3', '--skipped-hosts', 'host-2', '--coalesced-into', 'd0', '--tail-stdin'], { stdin: 'tail text' });
  assert.deepEqual(svc.calls.at(-1)[1], { exempt: true, id: 'd1', status: 'done', version: 'v1.2.3', coalesced_into: 'd0', skipped_hosts: ['host-2'], tail: 'tail text' });
  await reg(['deploy', 'approve', 'd1']); await reg(['deploy', 'cancel', 'd1']);
  assert.deepEqual(svc.calls.slice(-2).map((c) => c[0]), ['approve', 'cancel']);
  assert.equal((await reg(['list', '--json'])).code, 1);
  assert.equal((await centralRegistry(() => null)(['deploy', 'list'])).code, 5);
  assert.equal((await centralRegistry(() => ({ deploy: { list: async () => { throw new Error('x'); } } }))(['deploy', 'list'])).code, 5);
  assert.deepEqual(parseArgs(['deploy', 'finish', 'x', '--status', 'done', '--tail-stdin']), { pos: ['deploy', 'finish', 'x'], flags: { status: 'done', 'tail-stdin': true } });
  assert.equal(exitOf({ ok: false, code: 'E_DEPLOY_PENDING' }), 4); assert.equal(exitOf({ ok: false, code: 'E_UNAVAILABLE' }), 5); assert.equal(exitOf({ ok: true }), 0);
});

test('service events: feed record, one-line note, only for downgrade and pin overlap, only to a stopped session without a draft', () => {
  const down = { kind: 'downgraded', id: 'L1', env: 'env-a', resources: ['device:host-1/device2'], agent: 'codebox:dev1', session: 'codebox:dev1', reason: 'no control activity for 20 min' };
  assert.equal(isNoteEvent(down), true); assert.equal(isNoteEvent({ kind: 'pin_overlap' }), true); assert.equal(isNoteEvent({ kind: 'released' }), false);
  assert.match(eventNote(down), /^Your exclusive lease on env-a\/device:host-1\/device2 became a pin \(no control activity for 20 min\)\. Claim again with vpt-lease claim \.\.\. --wait when you drive it\.$/);
  assert.match(eventNote({ kind: 'pin-overlap', env: 'env-a', resources: ['host:host-1'], by: 'codebox:dev2' }), /overlaps your pin/);
  assert.equal(eventNote({ kind: 'released' }), null);
  assert.equal(eventRecord({ kind: 'granted' }), null);
  assert.equal(eventRecord(down).key, 'lease:downgraded'); assert.equal(eventRecord({ kind: 'forced', id: 'x', env: 'e', agent: 'a' }).key, 'lease:forced');
  assert.equal(eventSession(down, (a) => (a === 'codebox:dev1' ? 'dev1' : null)), 'dev1');
  assert.equal(eventSession({ agent: 'mac:x' }, () => null), null);
  assert.equal(noteAllowed({ state: 'done', stall: {} }), true);
  assert.equal(noteAllowed({ state: 'done', stall: { draft: 'half typed' } }), false);
  assert.equal(noteAllowed({ state: 'waiting', stall: {} }), false);
  assert.equal(noteAllowed({ state: 'working' }), false);
  assert.equal(noteAllowed({ state: 'done', stall: { options: [{ n: 1 }] } }), false);
  assert.equal(noteAllowed(undefined), false);
});

test('lease-watch in central mode observes only: no narrow, no release, no registry call', async () => {
  const calls = [];
  const watch = createLeaseWatch({
    stateDir: '/nonexistent-for-test', run: async (a) => { calls.push(a); return { code: 1, stdout: '', stderr: '' }; }, machines: new Set(['codebox']),
    listSessionNames: async () => ['dev1'], activityOf: () => ({ working: false, turnAt: NOW - 3 * 3600000, promptAt: NOW - 3 * 3600000 }),
    observeOnly: () => true, listRows: async () => ({ ok: true, leases: [{ id: 'L1', env: 'env-a', resource: 'frontend', agent: 'codebox:dev1', kind: 'server', since: 1 }, { id: 'L2', env: 'env-a', resource: 'host-1', agent: 'codebox:gone', kind: 'host', since: 1 }] }),
    now: () => NOW, log: { log() {}, error() {} },
  });
  await watch.poll(); const snap = await watch.poll();
  assert.deepEqual(calls, []); assert.equal(snap.ok, true); assert.equal(snap.mode, 'central'); assert.deepEqual(snap.planned, []);
  assert.ok(snap.holders.every((h) => h.plan === null));
});

test('server wiring: the lease consumers go through the source; legacy keeps the registry paths', () => {
  const s = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /leaseStore\.(?:peek|get)\(/);
  assert.match(s, /const getLeases = \(force\) => leaseSource\.get\(force\)/);
  assert.match(s, /registry: leaseSource\.deployRegistry\(\)/);
  assert.match(s, /observeOnly: \(\) => !leaseSource\.acts\(\)/);
  assert.match(s, /assertAgentPane\(session, 'lease-service'\)/);
  assert.match(s, /\/api\/leases\/owner\/release/);
});
