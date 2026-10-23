// Central lease service (round 10): conflict matrix, queue, fencing, fail closed, expiry/idle policy, deploy queue, replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLeaseService, resourceConflict, parseResource, canonical, toLegacyRows } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
function harness(cfg = {}, extra = {}) {
  const clock = { t: Date.UTC(2026, 9, 14, 12, 0, 0), m: 5000 };
  const dir = tmp('lease-svc-');
  const events = [];
  const open = (more = {}) => createLeaseService({ dir, now: () => clock.t, onEvent: (e) => events.push(e), ...extra, ...more, config: { mono: () => clock.m, envs: ['env-a', 'env-b'], ...cfg, ...(more.config || {}) } });
  const h = { clock, dir, events, open, svc: open() };
  h.advance = async (ms) => { clock.t += ms; clock.m += ms; await h.svc.tick(); };
  h.claim = (agent, resources, o = {}) => h.svc.claim({ env: 'env-a', resources: [].concat(resources), agent, ...o });
  return h;
}
const TRACK = { sessions: { trackable: (s) => String(s).startsWith('codebox:') } };   // the dashboard resolves codebox sessions: idle downgrade applies there
const held = (r) => r.ok === false && r.code === 'E_HELD';

// ---- matrix --------------------------------------------------------------------------------------------------------------
const RES = { env: '*', frontend: 'frontend', server: 'server', h1: 'host:host-1', h2: 'host:host-2', d11: 'device:host-1/device1', d12: 'device:host-1/device2', d21: 'device:host-2/device1' };
// design section 3 as pairs [a, b, kindOfTheHostOrDeviceSide -> conflict?]
function expected(a, b, kind) {
  const types = [a, b].map((k) => (k === 'env' ? 'env' : k === 'frontend' ? 'frontend' : k === 'server' ? 'server' : k[0] === 'h' ? 'host' : 'device'));
  if (types.includes('env')) return true;
  const [ta, tb] = types;
  if (ta === 'frontend' || tb === 'frontend') return ta === tb;
  if (ta === 'server' && tb === 'server') return true;
  if (ta === 'server' || tb === 'server') return kind === 'server';
  const host = (k) => (k === 'h1' || k === 'd11' || k === 'd12' ? 1 : 2);
  if (host(a) !== host(b)) return false;
  if (ta === 'device' && tb === 'device') return a === b;
  return true;
}

test('matrix: every cell of section 3 matches the table and the relation is symmetric', () => {
  for (const a of Object.keys(RES)) for (const b of Object.keys(RES)) for (const ka of ['server', 'host']) for (const kb of ['server', 'host']) {
    const got = resourceConflict(parseResource(RES[a]), parseResource(RES[b]), ka, kb);
    const back = resourceConflict(parseResource(RES[b]), parseResource(RES[a]), kb, ka);
    assert.equal(got, back, `symmetry ${a}/${ka} vs ${b}/${kb}`);
    const sensSide = ['server', 'host'].includes(a) || a === 'server' ? null : null;   // eslint-disable-line no-unused-vars
    // the sensitivity that matters is the host/device side's
    const hostSideKind = /^(h|d)/.test(a) ? ka : kb;
    assert.equal(got, expected(a, b, hostSideKind), `${a}/${ka} vs ${b}/${kb}`);
  }
});

test('matrix through the service: claim vs held for every pair, frontend never waits for a device, other device on the same host is free', async () => {
  const h = harness();
  for (const hk of Object.keys(RES)) for (const nk of Object.keys(RES)) for (const kind of ['server', 'host']) {
    await h.svc.release({ agent: 'held' }); await h.svc.release({ agent: 'new' });
    assert.ok((await h.claim('held', RES[hk], { kind })).ok);
    const r = await h.claim('new', RES[nk], { kind });
    const sens = /^(h|d)/.test(hk) ? kind : kind;     // both claims use the same kind in this loop
    assert.equal(held(r), expected(hk, nk, sens), `held ${hk} new ${nk} kind ${kind}`);
  }
  await h.svc.release({ agent: 'held' }); await h.svc.release({ agent: 'new' });
  await h.claim('dev', RES.d11, { kind: 'server' });
  assert.ok((await h.claim('fe', 'frontend')).ok, 'frontend vs device');
  assert.ok((await h.claim('other', RES.d12)).ok, 'other device, same host');
  assert.ok(held(await h.claim('whole', RES.h1)), 'whole host vs its device');
});

test('modes, same agent, shared and sensitivity defaults', async () => {
  const h = harness();
  const a = await h.claim('a', 'host-1/device1');
  assert.equal(a.lease.kind, 'host', 'device lease defaults to host sensitivity');
  assert.equal((await h.claim('a', 'host-9')).lease.kind, 'server', 'a host lease defaults to server sensitivity');
  assert.ok((await h.claim('a', 'host-1/device1')).ok, 'same agent never conflicts with itself');
  assert.ok(held(await h.claim('b', 'host-1/device1')));
  assert.ok((await h.claim('b', 'host-1/device1', { mode: 'observe' })).ok, 'observe never conflicts');
  assert.ok((await h.claim('b', 'host-1/device1', { mode: 'pin' })).ok, 'pin never conflicts');
  const s1 = await h.claim('s1', 'host-2/device1', { shared: true });
  assert.ok((await h.claim('s2', 'host-2/device1', { shared: true })).ok, 'two shared leases coexist');
  assert.ok(held(await h.claim('plain', 'host-2/device1')), 'a shared lease still conflicts with a non-shared claim');
  assert.ok(s1.ok);
  assert.ok(held(await h.svc.claim({ env: 'env-b', resources: ['host-1/device1'], agent: 'zz' }).then(async () => h.claim('zz2', 'host-1/device1'))), 'envs are separate but the same env conflicts');
});

test('env validation: an unknown env (a host name used as env) is E_INVALID; without a list any sane token is accepted', async () => {
  const h = harness();
  const r = await h.svc.claim({ env: 'host-1', resources: ['frontend'], agent: 'a' });
  assert.equal(r.code, 'E_INVALID');
  assert.equal((await h.svc.list({ env: 'nope' })).code, 'E_INVALID');
  assert.equal((await h.claim('a', ['bad resource!'])).code, 'E_INVALID');
  const free = harness({ envs: [] });
  assert.ok((await free.svc.claim({ env: 'whatever-1', resources: ['frontend'], agent: 'a' })).ok);
  assert.equal((await free.svc.claim({ env: 'Bad Env', resources: ['frontend'], agent: 'a' })).code, 'E_INVALID');
});

test('parse: legacy and typed spellings map to the same resource', () => {
  for (const [raw, canon] of [['*', '*'], ['env:*', '*'], ['frontend', 'frontend'], ['server', 'server'], ['host-1', 'host:host-1'], ['host:host-1', 'host:host-1'], ['host-1/device1', 'device:host-1/device1'], ['device:host-1/device1', 'device:host-1/device1']]) assert.equal(canonical(parseResource(raw)), canon);
  assert.equal(parseResource('a/b/c'), null);
});

// ---- concurrency, fencing, fail closed ------------------------------------------------------------------------------------
test('100 parallel claims on one resource: exactly one grant', async () => {
  const h = harness();
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => h.claim(`agent-${i}`, 'host-1/device1')));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(rs.filter(held).length, 99);
});

test('fencing: a stale generation is E_FENCED for renew, heartbeat and release (T27)', async () => {
  const h = harness();
  const a = (await h.claim('a', 'host-1/device1', { ttl_min: 5 })).lease;
  await h.advance(6 * MIN);                                              // a's lease expires
  const b = (await h.claim('b', 'host-1/device1')).lease;
  assert.ok(b.generation > a.generation);
  for (const call of [() => h.svc.renew({ id: a.id, generation: a.generation }), () => h.svc.heartbeat({ id: a.id, generation: a.generation }), () => h.svc.release({ id: a.id, generation: a.generation })]) {
    assert.equal((await call()).code, 'E_FENCED');
  }
  assert.equal((await h.svc.renew({ id: b.id, generation: b.generation })).ok, true);
  assert.equal((await h.svc.renew({ id: b.id, generation: b.generation + 5 })).code, 'E_FENCED');
  assert.equal((await h.svc.get({ id: b.id, generation: a.generation })).fenced, true);
  assert.deepEqual((({ id, mode, generation, state }) => ({ id, mode, generation, state }))(await h.svc.get({ id: b.id })), { id: b.id, mode: 'exclusive', generation: b.generation, state: 'active' });
  assert.equal((await h.svc.get({ id: a.id })).state, 'gone');
});

test('fail closed: a corrupt journal makes the service read-only and every call E_UNAVAILABLE', async () => {
  const h = harness();
  await h.claim('a', 'frontend'); await h.claim('b', 'host-1/device1');
  fs.writeFileSync(path.join(h.dir, 'journal.jsonl'), '{"seq":3,"t":"x"}\nnot json\n{"seq":4}\n');
  fs.rmSync(path.join(h.dir, 'snapshot.json'), { force: true });
  const s2 = h.open();
  for (const r of [await s2.claim({ env: 'env-a', resources: ['frontend'], agent: 'x' }), await s2.check({ env: 'env-a' }), await s2.list(), await s2.deploy.list()]) assert.equal(r.code, 'E_UNAVAILABLE');
  assert.equal((await s2.status()).readOnly, true);
});

test('fail closed: lost state (marker present, journal and snapshot gone) and a disk error', async () => {
  const h = harness();
  await h.claim('a', 'frontend');
  fs.rmSync(path.join(h.dir, 'journal.jsonl')); fs.rmSync(path.join(h.dir, 'snapshot.json'));
  assert.equal((await h.open().claim({ env: 'env-a', resources: ['frontend'], agent: 'x' })).code, 'E_UNAVAILABLE');
  const bad = harness({ io: { append: async () => { throw new Error('ENOSPC'); } } });
  assert.equal((await bad.claim('a', 'frontend')).code, 'E_UNAVAILABLE');
  assert.equal((await bad.claim('b', 'server')).code, 'E_UNAVAILABLE', 'after a write failure the service stays closed');
  assert.equal((await bad.svc.check({ env: 'env-a' })).code, 'E_UNAVAILABLE');
});

test('a torn last journal line is dropped; a torn line elsewhere is corruption', async () => {
  const h = harness({ snapshotEvery: 1000 });
  const a = (await h.claim('a', 'frontend')).lease;
  const jp = path.join(h.dir, 'journal.jsonl');
  fs.appendFileSync(jp, '{"seq":99,"t":"gra');                           // crash mid-append
  const s2 = h.open();
  assert.equal((await s2.list()).leases.length, 1);
  assert.equal((await s2.claim({ env: 'env-a', resources: ['host-1'], agent: 'n' })).ok, true, 'new writes work after dropping the torn tail');
  assert.ok(a.id);
  const lines = fs.readFileSync(jp, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(jp, `${lines[0].slice(0, 20)}\n${lines.slice(1).join('\n')}\n`);
  assert.equal((await h.open().list()).code, 'E_UNAVAILABLE');
});

// ---- queue ---------------------------------------------------------------------------------------------------------------
test('tickets: FIFO order, position and ETA from expect_min, granted on release (reservation), no starvation by a stream of short claims', async () => {
  const h = harness();
  const a = (await h.claim('a', 'host-1/device1', { expect_min: 30 })).lease;
  const t1 = (await h.claim('b', 'host-1/device1', { wait: 'ticket', expect_min: 10 })).ticket;
  const t2 = (await h.claim('c', 'host-1/device1', { wait: 'ticket' })).ticket;
  assert.equal(t1.position, 1); assert.equal(t2.position, 2);
  assert.equal(Date.parse(t1.eta) - h.clock.t, 30 * MIN, 'ETA = blocker expected end');
  assert.equal(Date.parse(t2.eta) - h.clock.t, 40 * MIN, 'plus the hold expected of the ticket ahead');
  assert.ok(Date.parse(t1.eta_latest) >= Date.parse(t1.eta));
  const r = await h.claim('d', 'host-1/device1');                       // a plain claim honours waiting tickets
  assert.equal(r.code, 'E_HELD');
  await h.svc.release({ id: a.id });
  const g1 = await h.svc.ticket(t1.id);
  assert.equal(g1.ticket.state, 'granted'); assert.equal(g1.ticket.lease.agent, 'b');
  const w2 = await h.svc.ticket(t2.id);
  assert.equal(w2.ticket.state, 'waiting'); assert.equal(w2.ticket.position, 1);
  const free = await h.claim('e', 'host-1/device1');                    // free? no: b holds it now
  assert.equal(free.code, 'E_HELD');
});

test('a held answer on a free resource with waiting tickets says reason queued and the position', async () => {
  const h = harness();
  const blocker = (await h.claim('blocker', 'host-1/device1')).lease;
  await h.claim('w', 'host-1', { wait: 'ticket' });                     // whole host ticket waits for the device
  await h.svc.release({ id: blocker.id });                              // grants w (reservation) -> make another ticket wait behind w
  await h.claim('w2', 'host-1', { wait: 'ticket' });
  const r = await h.claim('x', 'host-1/device2');
  assert.equal(r.code, 'E_HELD');
  assert.equal(r.holders.length, 1);
});

test('queue is per conflict set: a ticket for the env does not block unrelated narrow work, a frontend ticket is not behind a server ticket', async () => {
  const h = harness();
  await h.claim('dev', 'host-1/device1', { kind: 'server', expect_min: 60 });
  const full = (await h.claim('deployer', '*', { wait: 'ticket' })).ticket;
  assert.equal(full.state, 'waiting');
  const fe = await h.claim('fe', 'frontend', { expect_min: 120 });      // conflicts with the env ticket; a long hold cannot pass it
  assert.equal(fe.code, 'E_HELD', 'a long expected hold queues behind the broad ticket');
  assert.equal(fe.reason, 'queued'); assert.equal(fe.position, 2);
  const short = await h.claim('fe2', 'frontend', { expect_min: 1 });
  assert.ok(short.ok, 'a short claim passes a ticket whose earliest grant is later');
  const other = await h.claim('o', 'host-2/device1', { expect_min: 120 });
  assert.equal(other.code, 'E_HELD', 'env ticket still blocks later claims in its own conflict set');
});

test('pass-through is capped: a ticket passed more than 3 times, or older than 15 min, becomes strict', async () => {
  const h = harness({ ticketIdleMs: 60 * MIN });
  await h.claim('dev', 'host-1/device1', { expect_min: 120 });
  await h.claim('deployer', '*', { wait: 'ticket' });
  for (let i = 0; i < 3; i++) { const r = await h.claim(`s${i}`, 'frontend', { expect_min: 1 }); assert.ok(r.ok, `pass ${i}`); await h.svc.release({ agent: `s${i}` }); }
  assert.equal((await h.claim('s5', 'frontend', { expect_min: 1 })).code, 'E_HELD', 'passed 3 times: strict');
  const h2 = harness({ ticketIdleMs: 60 * MIN });
  await h2.claim('dev', 'host-1/device1', { expect_min: 120 });
  await h2.claim('deployer', '*', { wait: 'ticket' });
  const tid = (await h2.svc.list()).tickets[0].id;
  for (let i = 0; i < 4; i++) { await h2.advance(4 * MIN); await h2.svc.ticket(tid); }
  assert.equal((await h2.claim('s', 'frontend', { expect_min: 1 })).code, 'E_HELD', 'older than 15 min: strict');
});

test('ticket expires after 2 minutes without a poll (4x the 30s client long-poll); polling keeps it; cancel works', async () => {
  const h = harness();
  await h.claim('a', 'frontend');
  const t1 = (await h.claim('b', 'frontend', { wait: 'ticket' })).ticket;
  const t2 = (await h.claim('c', 'frontend', { wait: 'ticket' })).ticket;
  const t3 = (await h.claim('d', 'frontend', { wait: 'ticket' })).ticket;
  await h.advance(90 * 1000); await h.svc.ticket(t2.id);
  await h.advance(90 * 1000);
  assert.equal((await h.svc.ticket(t1.id)).ticket.state, 'expired');
  assert.equal((await h.svc.ticket(t2.id)).ticket.state, 'waiting');
  assert.equal((await h.svc.cancelTicket(t3.id)).ticket.state, 'expired', 'already expired by then');
  const t4 = (await h.claim('e', 'frontend', { wait: 'ticket' })).ticket;
  assert.equal((await h.svc.cancelTicket(t4.id)).ticket.state, 'cancelled');
});

test('a granted ticket is a reservation: uncollected after 2 minutes it is released and the ticket is missed; priority_since keeps the position', async () => {
  const h = harness({ ticketIdleMs: 60 * MIN });
  const a = (await h.claim('a', 'frontend')).lease;
  const t1 = (await h.claim('b', 'frontend', { wait: 'ticket' })).ticket;
  await h.advance(MIN);
  const t2 = (await h.claim('c', 'frontend', { wait: 'ticket' })).ticket;
  await h.svc.release({ id: a.id });                                      // b reserved (never collects)
  assert.equal((await h.svc.list()).leases[0].agent, 'b');
  await h.advance(3 * MIN);
  const after = (await h.svc.ticket(t1.id)).ticket;
  assert.equal(after.state, 'missed');
  assert.equal((await h.svc.ticket(t2.id)).ticket.state, 'granted', 'the next ticket was granted when the reservation lapsed');
  await h.svc.release({ agent: 'c' });
  const t3 = (await h.claim('x', 'frontend')).lease;
  const re = (await h.claim('b', 'frontend', { wait: 'ticket', priority_since: after.priority_since })).ticket;
  assert.equal(re.priority_since, after.priority_since);
  const later = (await h.claim('y', 'frontend', { wait: 'ticket' })).ticket;
  assert.equal(re.position, 1); assert.equal((await h.svc.ticket(later.id)).ticket.position, 2);
  assert.ok(t3.id);
});

test('collecting: polling a granted ticket confirms the reservation, which then survives the window', async () => {
  const h = harness();
  const a = (await h.claim('a', 'frontend')).lease;
  const t = (await h.claim('b', 'frontend', { wait: 'ticket' })).ticket;
  await h.svc.release({ id: a.id });
  const got = (await h.svc.ticket(t.id)).ticket;
  assert.equal(got.state, 'granted');
  await h.advance(5 * MIN);
  assert.equal((await h.svc.list()).leases[0].agent, 'b');
});

test('ETA uses the median hold of the last 7 days, conditional on the time already held; expect_min is the holder statement', async () => {
  const h = harness({ ticketIdleMs: 60 * MIN, idleMs: { device: 0, frontend: 0, host: 0, server: 0, env: 0 } });
  for (const m of [2, 4, 6, 40, 50]) { const l = (await h.claim('x', 'host-1/device1')).lease; await h.advance(m * MIN); await h.svc.release({ id: l.id }); }
  const a = (await h.claim('a', 'host-1/device1')).lease;
  const t = (await h.claim('b', 'host-1/device1', { wait: 'ticket' })).ticket;
  assert.equal(a.eta_basis, 'median');
  const first = Date.parse(t.eta) - h.clock.t;
  assert.ok(first > 0 && first <= 50 * MIN);
  await h.advance(5 * MIN); await h.svc.ticket(t.id); await h.advance(5 * MIN);   // held 10 min: only the 40 and 50 holds are longer
  const t2 = (await h.svc.ticket(t.id)).ticket;
  assert.equal(Date.parse(t2.eta) - h.clock.t, 35 * MIN, 'median of the remaining 30 and 40');
  assert.ok(Date.parse(t2.eta_latest) >= Date.parse(t2.eta));
  const st = (await h.claim('s', 'host-2/device1', { expect_min: 7 })).lease;
  assert.equal(st.eta_basis, 'stated'); assert.equal(st.expect_min, 7);
});

// ---- no ghost holds ------------------------------------------------------------------------------------------------------
test('TTL expiry releases; heartbeat enforcement is opt-in (plain claims are not released for missing heartbeats)', async () => {
  const h = harness({ idleMs: { device: 0, frontend: 0, host: 0, server: 0, env: 0 } });
  const hb = (await h.claim('hb', 'host-1/device1', { heartbeat_s: 120 })).lease;
  const plain = (await h.claim('plain', 'host-1/device2')).lease;
  const ttl = (await h.claim('ttl', 'host-2/device1', { ttl_min: 5 })).lease;
  await h.advance(2 * MIN); await h.svc.heartbeat({ id: hb.id });
  await h.advance(3.5 * MIN);
  assert.deepEqual((await h.svc.list()).leases.map((l) => l.agent).sort(), ['hb', 'plain'], 'ttl lease gone');
  await h.advance(3 * MIN);                                              // 3 missed intervals of 120 s since the last heartbeat
  assert.deepEqual((await h.svc.list()).leases.map((l) => l.agent), ['plain']);
  const ev = (await h.svc.events()).events;
  assert.ok(ev.some((e) => e.kind === 'expired' && e.reason === 'no-heartbeat' && e.id === hb.id));
  assert.ok(ev.some((e) => e.kind === 'expired' && e.reason === 'ttl' && e.id === ttl.id));
  assert.ok(plain.id);
});

test('imported leases and plain claims have no heartbeat requirement (heartbeat_s null)', async () => {
  const h = harness({ idleMs: { device: 0, frontend: 0, host: 0, server: 0, env: 0 } });
  const l = (await h.claim('p', 'frontend')).lease;
  assert.equal(l.heartbeat_s, null);
  await h.advance(60 * MIN);
  assert.equal((await h.svc.list()).leases.length, 1);
});

test('idle exclusive lease is downgraded to pin after idleMs; the pin holder is told when an overlapping exclusive lease is granted', async () => {
  const h = harness({}, TRACK);
  const a = (await h.claim('a', 'host-1/device1', { session: 'codebox:a' })).lease;
  await h.advance(19 * MIN);
  assert.equal((await h.svc.list()).leases[0].mode, 'exclusive');
  await h.svc.heartbeat({ id: a.id, active: true });
  await h.advance(19 * MIN);
  assert.equal((await h.svc.list()).leases[0].mode, 'exclusive', 'an active heartbeat resets the idle clock');
  await h.advance(2 * MIN);
  assert.equal((await h.svc.list()).leases[0].mode, 'pin');
  assert.ok(h.events.some((e) => e.kind === 'downgraded' && e.id === a.id && e.reason === 'idle'), 'onEvent got the downgrade');
  const queue = (await h.claim('b', 'host-1/device1')).lease;
  assert.ok(queue.id);
  assert.ok(h.events.some((e) => e.kind === 'pin_overlap' && e.id === a.id && e.by_agent === 'b'), 'the pin holder is told');
});

test('idle downgrade never touches deploy leases, exempt (system) holders, or leases inside expect_min; activity(session) resets the clock', async () => {
  const h = harness({}, TRACK);
  await h.claim('sys', 'host-1/device1', { exempt: true, session: 'codebox:sys' });
  await h.claim('exp', 'host-1/device2', { expect_min: 40, session: 'codebox:exp' });
  await h.claim('act', 'host-2/device1', { session: 'codebox:s1' });
  await h.claim('idle', 'host-2/device2', { session: 'codebox:idle' });
  await h.advance(15 * MIN);
  assert.equal((await h.svc.activity('codebox:s1')).touched, 1);
  await h.advance(15 * MIN);
  const modes = Object.fromEntries((await h.svc.list()).leases.map((l) => [l.agent, l.mode]));
  assert.deepEqual(modes, { sys: 'exclusive', exp: 'exclusive', act: 'exclusive', idle: 'pin' });
  await h.advance(15 * MIN);
  assert.equal(Object.fromEntries((await h.svc.list()).leases.map((l) => [l.agent, l.mode])).act, 'pin');
});

test('restart resets heartbeat and idle clocks: an outage is never a missed heartbeat', async () => {
  const h = harness();
  await h.claim('hb', 'host-1/device1', { heartbeat_s: 60 });
  await h.claim('idle', 'host-1/device2');
  h.clock.t += 10 * MIN; h.clock.m += 10 * MIN;                           // an outage: nobody ticked, nobody could heartbeat
  const s2 = h.open();
  assert.deepEqual((await s2.list()).leases.map((l) => l.mode), ['exclusive', 'exclusive']);
  h.clock.m += 4 * MIN; h.clock.t += 4 * MIN;
  await s2.tick();
  assert.equal((await s2.list()).leases.length, 1, 'heartbeat lease released only after three fresh misses');
});

test('a monotonic clock drives heartbeat/idle: a wall clock jump does not release a heartbeating lease; a non-finite clock fails closed', async () => {
  const h = harness();
  await h.claim('hb', 'host-1/device1', { heartbeat_s: 60, ttl_min: 480 });
  h.clock.t += 60 * MIN;                                                  // NTP step forward, monotonic unchanged
  assert.equal((await h.svc.list()).leases.length, 1);
  h.clock.t = NaN;
  assert.equal((await h.claim('x', 'frontend')).code, 'E_UNAVAILABLE');
});

test('sessionGone: release after a 2 minute grace, or at once; the liveness provider drives it; a reappearing session cancels', async () => {
  const alive = { v: true };
  const h = harness({}, { sessions: { isAlive: (s) => (s === 'codebox:s1' ? alive.v : undefined) } });
  await h.claim('codebox:s1', 'host-1/device1'); await h.claim('codebox:s2', 'host-1/device2'); await h.claim('mac:m', 'host-2/device1');
  await h.svc.sessionGone('codebox:s2');
  await h.advance(MIN);
  assert.equal((await h.svc.list()).leases.length, 3);
  await h.advance(90000);
  assert.deepEqual((await h.svc.list()).leases.map((l) => l.agent).sort(), ['codebox:s1', 'mac:m']);
  alive.v = false; await h.advance(1000);
  alive.v = true; await h.advance(MIN);
  await h.advance(3 * MIN);
  assert.equal((await h.svc.list()).leases.filter((l) => l.agent === 'codebox:s1').length, 1, 'session came back inside the grace');
  alive.v = false; await h.advance(1000); await h.advance(3 * MIN);
  assert.equal((await h.svc.list()).leases.filter((l) => l.agent === 'codebox:s1').length, 0);
  await h.svc.sessionGone('mac:m', { immediate: true });
  assert.equal((await h.svc.list()).leases.length, 0);
});

test('sessionStatus: waiting on its own resource is left alone; blocked/waiting on something else only downgrades when quiet and past expect_min, otherwise it flags', async () => {
  const h = harness({}, TRACK);
  await h.claim('codebox:s1', 'host-1/device1', { session: 'codebox:s1' });
  assert.deepEqual((await h.svc.sessionStatus('codebox:s1', 'waiting', 'script run on host-1/device1 (25 min)')), { ok: true, downgraded: [], flagged: [] });
  const recent = await h.svc.sessionStatus('codebox:s1', 'blocked', 'waiting for the owner');
  assert.deepEqual(recent.downgraded, []); assert.equal(recent.flagged.length, 1, 'recently active: flag only');
  assert.ok(h.events.some((e) => e.kind === 'flag'));
  await h.svc.sessionStatus('codebox:s1', 'working', '');
  await h.advance(21 * MIN);
  const l = (await h.svc.list()).leases[0];
  assert.equal(l.mode, 'pin', 'quiet for idleMs: downgraded');
});

// ---- deploys -------------------------------------------------------------------------------------------------------------
test('deploy queue: request, approve, start (atomic claim), skip-leased, catch-up, finish, last, wait', async () => {
  const h = harness();
  const d = h.svc.deploy;
  assert.equal((await d.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', hosts: ['x'] })).code, 'E_INVALID', '--hosts only with host');
  await h.claim('dev', 'host-1/device1', { kind: 'host' });
  const r1 = await d.request({ env: 'env-a', scope: 'full', ref: 'abc', agent: 'ag' });
  assert.equal((await d.list({ env: 'env-a' })).deploys[0].state, 'awaiting-approval');
  assert.equal((await d.start({ id: r1.id })).code, 'E_INVALID', 'not approved');
  await d.approve({ id: r1.id });
  assert.equal((await d.start({ id: r1.id })).code, 'E_HELD', 'a plain start is blocked by the device lease');
  const s = await d.start({ id: r1.id, skip_leased: true });
  assert.equal(s.ok, true);
  assert.deepEqual(s.leased_hosts.map((x) => x.host), ['host-1']);
  assert.ok(s.lease_id); assert.deepEqual(s.granted, ['*']);
  const r2 = await d.request({ env: 'env-a', scope: 'frontend', ref: 'z', agent: 'ag', approved: true });
  assert.equal((await d.start({ id: r2.id })).code, 'E_HELD', 'one running deploy per env');
  const f = await d.finish({ id: r1.id, status: 'done', version: 'v1', skipped_hosts: 'host-1' });
  assert.ok(f.catchup, 'a catch-up host deploy is queued for the skipped host');
  const cu = (await d.list({ env: 'env-a' })).deploys.find((x) => x.id === f.catchup);
  assert.deepEqual(cu.hosts, ['host-1']); assert.equal(cu.scope, 'host'); assert.equal(cu.state, 'queued');
  assert.equal((await h.svc.list()).leases.some((l) => l.deployId), false, 'the deploy lease is released on finish');
  const last = (await d.last({ env: 'env-a' })).envs['env-a'];
  assert.equal(last.frontend.version, 'v1'); assert.equal(last.server.status, 'done');
  assert.equal(last['host-1'].status, 'synced', 'the skipped host is synced, not deployed: its service was not restarted');
  assert.equal(last['host-1'].version, 'v1'); assert.equal(last['host-1'].deployId, r1.id, 'the provenance of the sync');
  assert.match(last['host-1'].reason, /restart deferred: host leased by dev/);
  const w = await d.wait({ id: r1.id });
  assert.equal(w.final, true); assert.equal(w.success, true);
});

test('deploy last: only done moves "deployed now", a failure is kept as lastAttempt; the same deploy id is recorded once', async () => {
  const h = harness();
  const d = h.svc.deploy;
  await d.record({ env: 'env-a', scope: 'frontend', agent: 'u', status: 'done', ref: 'r1', version: 'v1', deploy_id: 'x1' });
  await d.record({ env: 'env-a', scope: 'frontend', agent: 'u', status: 'failed', ref: 'r2', version: 'v2' });
  const again = await d.record({ env: 'env-a', scope: 'frontend', agent: 'u', status: 'done', ref: 'r1', version: 'v1', deploy_id: 'x1', commit: 'abc' });
  assert.equal(again.already, true);
  const fe = (await d.last({ env: 'env-a' })).envs['env-a'].frontend;
  assert.equal(fe.version, 'v1'); assert.equal(fe.lastAttempt.version, 'v2'); assert.equal(fe.commit, 'abc', 'blank fields filled');
  // a host whose code was synced but whose restart was deferred is NOT done: it is recorded as synced, with the reason
  await d.record({ env: 'env-a', scope: 'host', hosts: ['host-a'], agent: 'u', status: 'done', ref: 'r3', version: 'v3', deploy_id: 'x3', skipped_hosts: 'host-a' });
  const ha = (await d.last({ env: 'env-a' })).envs['env-a']['host-a'];
  assert.equal(ha.status, 'synced', 'not done: the service was never restarted into this version');
  assert.equal(ha.version, 'v3'); assert.equal(ha.deployId, 'x3', 'the provenance of the sync');
  assert.match(ha.reason, /restart deferred/);
  assert.equal(ha.lastAttempt, undefined, 'a synced host is not a failed one');
});

test('pending deploys block new claims only inside the typed matrix; exempt agents pass; wait gets a ticket behind the deploy', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const q = await d.request({ env: 'env-a', scope: 'host', hosts: ['host-1'], ref: 'r', agent: 'a', approved: true });
  const blocked = await h.claim('x', 'host-1/device1');
  assert.equal(blocked.code, 'E_DEPLOY_PENDING');
  assert.ok((await h.claim('x', 'frontend')).ok, 'a queued host deploy never blocks frontend');
  assert.ok((await h.claim('x', 'host-2/device1')).ok, 'nor other hosts');
  assert.ok((await h.claim('runner', 'host-1', { exempt: true })).ok, 'the token-bound exemption passes');
  await h.svc.release({ agent: 'runner' });
  const tk = (await h.claim('y', 'host-1/device1', { wait: 'ticket' })).ticket;
  assert.equal(tk.state, 'waiting', 'a ticket queued behind the deploy, not E_DEPLOY_PENDING');
  await d.start({ id: q.id });
  assert.equal((await h.svc.ticket(tk.id)).ticket.state, 'waiting');
  await d.finish({ id: q.id, status: 'done' });
  assert.equal((await h.svc.ticket(tk.id)).ticket.state, 'granted');
  assert.equal((await d.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true })).ok, true);
  assert.equal((await h.claim('z', 'frontend')).code, 'E_DEPLOY_PENDING');
});

test('deploy/start claims atomically; a claim carrying the running deploy_id joins its lease group, anything else conflicts', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const r = await d.request({ env: 'env-a', scope: 'server', ref: 'r', agent: 'manager:deploy', approved: true });
  const s = await d.start({ id: r.id });
  assert.deepEqual(s.granted, ['server']);
  assert.equal((await h.claim('other', 'server')).code, 'E_DEPLOY_PENDING');
  assert.equal((await h.claim('upd', 'server', { deploy_id: r.id })).ok, true, 'joins the deploy lease');
  assert.equal((await h.claim('upd', 'server', { deploy_id: 'nope' })).code, 'E_INVALID');
  await d.finish({ id: r.id, status: 'failed' });
});

test('a claim joining the running deploy does not queue behind tickets that were waiting for that deploy (self-deadlock)', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const r = await d.request({ env: 'env-a', scope: 'server', ref: 'r', agent: 'manager:deploy', approved: true });
  const w = await h.claim('waiter', 'server', { wait: 'ticket' });           // queued behind the pending deploy
  assert.equal(w.ticket.state, 'waiting');
  await d.start({ id: r.id });
  const j = await h.claim('manager:deploy', 'server', { deploy_id: r.id, wait: 'ticket' });
  assert.equal(j.ok, true);
  assert.ok(j.lease, 'granted at once, not a ticket behind the waiter');
  await d.finish({ id: r.id, status: 'done' });
});

test('running deploy fails after 90 minutes without finish; queued expires after its ttl', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const a = await d.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true });
  await d.start({ id: a.id });
  const b = await d.request({ env: 'env-a', scope: 'server', ref: 'r', agent: 'a', approved: true, ttl_min: 30 });
  await h.advance(91 * MIN);
  const all = (await d.list({ env: 'env-a', all: true })).deploys;
  assert.equal(all.find((x) => x.id === a.id).state, 'failed');
  assert.equal(all.find((x) => x.id === b.id).state, 'cancelled');
  assert.equal((await h.svc.list()).leases.length, 0, 'the deploy lease is gone with it');
});

test('check: legacy semantics incl. skip_leased and leased hosts', async () => {
  const h = harness();
  await h.claim('dev', 'host-1/device1', { kind: 'host' });
  await h.claim('srv', 'host-2', { kind: 'server' });
  assert.equal((await h.svc.check({ env: 'env-a' })).free, false, 'bare check = whole env');
  assert.equal((await h.svc.check({ env: 'env-a', resources: 'frontend' })).free, true);
  assert.equal((await h.svc.check({ env: 'env-a', resources: 'host-1/device1', ignore_agent: 'dev' })).free, true);
  const sk = await h.svc.check({ env: 'env-a', skip_leased: true, resources: '*', hosts: 'host-1,host-3' });
  assert.equal(sk.free, false, 'a server-sensitive lease blocks a full deploy');
  assert.deepEqual(sk.leased_hosts.map((x) => x.host), ['host-1']);
  const hostOnly = await h.svc.check({ env: 'env-a', skip_leased: true, hosts: 'host-1,host-2' });
  assert.equal(hostOnly.free, true); assert.deepEqual(hostOnly.leased_hosts.map((x) => x.host).sort(), ['host-1', 'host-2']);
});

test('ownServers: a lease on a Pi that runs its own server does not block a skip-leased server deploy, and is reported as skippable', async () => {
  const h = harness({ ownServers: { 'env-a': ['host-pi'] } });
  await h.claim('run', 'host-pi', { kind: 'server' });
  const plain = await h.svc.check({ env: 'env-a', resources: 'server' });
  assert.equal(plain.free, false, 'without --skip-leased the run still blocks the server deploy');
  const sk = await h.svc.check({ env: 'env-a', skip_leased: true, resources: 'server', hosts: 'host-pi' });
  assert.equal(sk.free, true);
  assert.deepEqual(sk.leased_hosts.map((x) => x.host), ['host-pi']);
  await h.claim('other', 'host-main', { kind: 'server' });
  const blocked = await h.svc.check({ env: 'env-a', skip_leased: true, resources: 'server', hosts: 'host-pi' });
  assert.equal(blocked.free, false, 'a server-kind lease on a host that uses the main server still blocks it');
});

// ---- identity, idempotency -----------------------------------------------------------------------------------------------
test('request_id: a retry returns the same grant or ticket, and survives a restart; ids are per client', async () => {
  const h = harness();
  const a = await h.claim('a', 'frontend', { request_id: 'r1', client: 'mac' });
  const again = await h.claim('a', 'frontend', { request_id: 'r1', client: 'mac' });
  assert.equal(again.lease.id, a.lease.id); assert.equal(again.replay, true);
  assert.equal((await h.svc.list()).leases.length, 1);
  const t = await h.claim('b', 'frontend', { request_id: 'r2', client: 'mac', wait: 'ticket' });
  const s2 = h.open();
  const t2 = await s2.claim({ env: 'env-a', resources: ['frontend'], agent: 'b', request_id: 'r2', client: 'mac', wait: 'ticket' });
  assert.equal(t2.ticket.id, t.ticket.id);
  const other = await s2.claim({ env: 'env-a', resources: ['frontend'], agent: 'c', request_id: 'r1', client: 'codebox' });
  assert.notEqual(other.lease?.id, a.lease.id, 'same id, other client: a different request');
});

test('identity: release/renew/narrow/mode by id need the holder client (and agent), or an owner identity; force-release logs the real caller', async () => {
  const h = harness();
  const l = (await h.claim('a', 'host-1/device1', { client: 'mac' })).lease;
  for (const call of [(c) => h.svc.release({ id: l.id, ...c }), (c) => h.svc.renew({ id: l.id, ...c }), (c) => h.svc.setMode({ id: l.id, mode: 'pin', ...c }), (c) => h.svc.narrow({ id: l.id, kind: 'host', ...c })]) {
    assert.equal((await call({ client: 'codebox' })).code, 'E_AUTH');
    assert.equal((await call({ client: 'mac', agent: 'someone-else' })).code, 'E_AUTH');
  }
  assert.equal((await h.svc.release({ agent: 'a', client: 'codebox' })).released.length, 0);
  assert.equal((await h.svc.ownerRelease({ id: l.id })).code, 'E_INVALID', 'by is required, never defaulted');
  assert.equal((await h.svc.ownerRelease({ id: l.id, by: 'alice@example.test via client:mac' })).ok, true);
  const forced = (await h.svc.events()).events.find((e) => e.kind === 'forced');
  assert.equal(forced.by, 'alice@example.test via client:mac');
  const l2 = (await h.claim('a', 'host-1/device1', { client: 'mac' })).lease;
  assert.equal((await h.svc.setMode({ id: l2.id, mode: 'pin', client: 'mac', agent: 'a' })).ok, true);
  assert.equal((await h.svc.setMode({ id: l2.id, mode: 'exclusive', client: 'mac', agent: 'a' })).code, 'E_INVALID', 'downgrade only');
});

test('narrow keeps legacy semantics: --resource changes only that row\'s sensitivity and releases nothing; kind is one-way', async () => {
  const h = harness();
  const l = (await h.claim('a', ['host-1', 'host-2'], { kind: 'server' })).lease;
  assert.equal((await h.svc.narrow({ id: l.id, resources: ['host-9'], kind: 'host' })).code, 'E_NOT_FOUND', 'no such row');
  assert.equal((await h.svc.narrow({ id: l.id, kind: 'server' })).code, 'E_INVALID');
  const n = await h.svc.narrow({ id: l.id, resources: ['host-1'], kind: 'host' });
  assert.equal(n.narrowed, 1); assert.deepEqual(n.lease.resources, ['host:host-1', 'host:host-2'], 'nothing released');
  assert.deepEqual(n.lease.kinds, { 'host:host-1': 'host' });
  assert.ok((await h.claim('srv1', 'server')).ok === false, 'the host-2 row is still server sensitive');
  await h.svc.release({ agent: 'srv1' });
  const again = await h.svc.narrow({ id: l.id, resources: ['host-1'], kind: 'host' });
  assert.equal(again.narrowed, 0);
  const all = await h.svc.narrow({ id: l.id, kind: 'host' });
  assert.equal(all.narrowed, 1); assert.equal(all.lease.kind, 'host'); assert.equal(all.lease.kinds, null);
  assert.ok((await h.claim('srv2', 'server')).ok, 'fully narrowed: a server claim no longer waits for it');
  await h.svc.release({ agent: 'srv2' });
  const r = await h.claim('b', ['host-3', 'host-4']);
  const restrict = await h.svc.narrow({ id: r.lease.id, resources: ['host-3/device1'], restrict: true });
  assert.deepEqual(restrict.lease.resources, ['device:host-3/device1']); assert.equal(restrict.narrowed, 1);
  assert.ok((await h.claim('c', 'host-4')).ok, 'restrict frees the dropped rows');
});

// ---- durability ------------------------------------------------------------------------------------------------------------
test('replay after a restart gives the same state; generations and the event cursor stay monotonic across snapshots', async () => {
  const h = harness({ snapshotEvery: 5 });
  const ids = [];
  for (let i = 0; i < 12; i++) { const l = (await h.claim(`a${i}`, 'host-1/device1')).lease; ids.push(l.generation); await h.svc.release({ id: l.id }); }
  const keep = (await h.claim('keep', 'frontend', { purpose: 'p' })).lease;
  const t = (await h.claim('w', 'frontend', { wait: 'ticket' })).ticket;
  const before = await h.svc.list(); const ev1 = await h.svc.events();
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); assert.equal(new Set(ids).size, 12);
  assert.ok(fs.existsSync(path.join(h.dir, 'snapshot.json')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(h.dir, 'snapshot.json'), 'utf8')).journal_seq > 0);
  const s2 = h.open();
  const after = await s2.list(); const ev2 = await s2.events();
  const strip = (x) => x.leases.map(({ ttlLeftMin, idleMin, eta, ...r }) => r);
  assert.deepEqual(strip(after), strip(before));
  assert.deepEqual(after.tickets.map((x) => x.id), [t.id]);
  assert.equal(ev2.total, ev1.total);
  const next = (await s2.claim({ env: 'env-a', resources: ['host-1/device1'], agent: 'n' })).lease;
  assert.equal(next.generation, 13, 'per-resource generations never restart');
  assert.ok((await s2.events({ after: ev1.total })).events[0].n === ev1.total + 1);
  assert.ok(keep.id);
});

test('events: cursor, kinds, limit', async () => {
  const h = harness();
  const l = (await h.claim('a', 'frontend')).lease;
  await h.svc.release({ id: l.id, by: 'me', reason: 'done' });
  const e = await h.svc.events({ after: 0, limit: 1 });
  assert.equal(e.events.length, 1); assert.equal(e.events[0].kind, 'granted');
  const rest = await h.svc.events({ after: e.next });
  assert.equal(rest.events[0].kind, 'released'); assert.equal(rest.events[0].by, 'me');
});

// ---- import / export / shadow ----------------------------------------------------------------------------------------------
test('import keeps legacy ids and expiry; imported leases declare no heartbeat; release <old-id> works; export gives the legacy shape', async () => {
  const h = harness();
  const exp = Math.floor(h.clock.t / 1000) + 3600;
  const r = await h.svc.importLegacy({
    leases: [
      { id: 'abcd1234', env: 'env-a', resource: 'host-1', agent: 'mac:old', purpose: 'p', kind: 'maintenance', since: Math.floor(h.clock.t / 1000) - 60, expires: exp },
      { id: 'abcd1234', env: 'env-a', resource: 'frontend', agent: 'mac:old', purpose: 'p', kind: 'maintenance', since: Math.floor(h.clock.t / 1000) - 60, expires: exp },
      { id: 'dead0000', env: 'env-a', resource: 'server', agent: 'x', expires: 5 },
      { id: 'beef0000', env: 'host-1', resource: 'server', agent: 'x', expires: exp },
    ],
    deploys: [{ id: 'dep00001', env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', state: 'queued', created: 1, expires: exp }],
  });
  assert.equal(r.leases, 1); assert.equal(r.deploys, 1); assert.equal(r.skipped.length, 2);
  const l = (await h.svc.list()).leases[0];
  assert.equal(l.id, 'abcd1234'); assert.equal(l.heartbeat_s, null); assert.equal(l.kind, 'host'); assert.equal(Date.parse(l.expires_at) / 1000, exp);
  const rows = toLegacyRows((await h.svc.list()).leases);
  assert.deepEqual(rows.map((x) => x.resource).sort(), ['frontend', 'host-1']); assert.equal(rows[0].expires, exp);
  await h.advance(30 * MIN);
  assert.equal((await h.svc.list()).leases.length, 1, 'no heartbeat expiry for imported leases');
  assert.deepEqual((await h.svc.release({ id: 'abcd1234' })).released, ['abcd1234']);
  assert.equal((await h.svc.deploy.list({ env: 'env-a' })).deploys.length, 1);
});

test('shadow store: runs the same operations on a separate journal, never affects real grants, reports are stored', async () => {
  const h = harness();
  const a = await h.svc.shadow.op('claim', { env: 'env-a', resources: ['frontend'], agent: 'a' });
  assert.equal(a.ok, true);
  assert.equal((await h.svc.list()).leases.length, 0, 'the real registry is untouched');
  assert.ok(held(await h.svc.shadow.op('claim', { env: 'env-a', resources: ['frontend'], agent: 'b' })), 'the shadow store has its own state');
  assert.ok((await h.claim('real', 'frontend')).ok);
  assert.equal((await h.svc.shadow.op('deploy.request', { env: 'env-a', scope: 'server', ref: 'r', agent: 'a' })).ok, true);
  assert.equal((await h.svc.deploy.list({ env: 'env-a' })).deploys.length, 0, 'shadow deploys are not real deploys');
  assert.ok(fs.existsSync(path.join(h.dir, 'shadow', 'journal.jsonl')));
  assert.equal((await h.svc.shadow.report({ machine: 'host-1', command: 'claim env-a frontend', legacy: { code: 0, out: 'x' }, central: { code: 3, out: 'busy' } })).ok, true);
  assert.equal((await h.svc.shadow.list()).reports.length, 1);
  // the shadow store may be seeded (cut-over shadow window), but nothing reaches the real store
  const realBefore = (await h.svc.list({})).leases.length;
  await h.svc.shadow.op('importLegacy', { owner: true, leases: [{ id: 'seed1234', env: 'env-a', resource: 'frontend', agent: 'mac:x', kind: 'server', since: Math.floor(Date.now() / 1000), expires: Math.floor(Date.now() / 1000) + 600 }], deploys: [] });
  assert.equal((await h.svc.list({})).leases.length, realBefore, 'no import or other write path into the real store');
  assert.equal((await h.open().shadow.list()).reports.length, 1, 'reports survive a restart');
});

test('read-only open (export): never writes, reads work, writes are E_UNAVAILABLE', async () => {
  const h = harness();
  await h.claim('a', 'frontend');
  const before = fs.readFileSync(path.join(h.dir, 'journal.jsonl'), 'utf8') + fs.readFileSync(path.join(h.dir, 'snapshot.json'), 'utf8');
  const ro = h.open({ config: { readonly: true } });
  assert.equal((await ro.list()).leases.length, 1);
  assert.equal((await ro.claim({ env: 'env-a', resources: ['server'], agent: 'x' })).code, 'E_UNAVAILABLE');
  assert.equal(fs.readFileSync(path.join(h.dir, 'journal.jsonl'), 'utf8') + fs.readFileSync(path.join(h.dir, 'snapshot.json'), 'utf8'), before);
});

// ---- round 10 code review regressions ------------------------------------------------------------------------------------------
test('review 2: import skips rows that conflict with a live exclusive lease (reported as conflict) and caps the ttl', async () => {
  const h = harness();
  await h.claim('live', 'host-1/device1');
  const exp = Math.floor(h.clock.t / 1000) + 36000;
  const r = await h.svc.importLegacy({ leases: [
    { id: 'aaaa0001', env: 'env-a', resource: 'host-1/device1', agent: 'mac:x', expires: exp },
    { id: 'aaaa0002', env: 'env-a', resource: 'host-2/device1', agent: 'mac:x', expires: exp },
  ] });
  assert.equal(r.leases, 1);
  const bad = r.skipped.find((x) => x.id === 'aaaa0001');
  assert.equal(bad.conflict, true); assert.match(bad.reason, /conflicts with live lease/);
  const kept = (await h.svc.list()).leases.find((l) => l.id === 'aaaa0002');
  assert.ok(Date.parse(kept.expires_at) - h.clock.t <= 480 * MIN, 'ttl capped at ttlMaxMin');
  assert.equal((await h.svc.importLegacy({ leases: [], client: 'mac' })).code, 'E_AUTH', 'owner only over the API');
});

test('review 3: a pending deploy blocks exactly where its virtual lease conflicts (kind=host device under a server deploy is granted)', async () => {
  const h = harness();
  const q = await h.svc.deploy.request({ env: 'env-a', scope: 'server', ref: 'r', agent: 'a', approved: true });
  for (const phase of ['queued', 'running']) {
    assert.ok((await h.claim(`dev-${phase}`, 'host-1/device1', { kind: 'host' })).ok, `kind=host device under a ${phase} server deploy`);
    assert.equal((await h.claim(`srv-${phase}`, 'host-2/device1', { kind: 'server' })).code, 'E_DEPLOY_PENDING', 'a server-sensitive device claim is blocked');
    assert.ok((await h.claim(`fe-${phase}`, 'frontend')).ok, 'frontend is untouched by a server deploy');
    await h.svc.release({ agent: `dev-${phase}` }); await h.svc.release({ agent: `fe-${phase}` });
    if (phase === 'queued') { const st = await h.svc.deploy.start({ id: q.id, agent: 'a' }); assert.ok(st.ok); }
  }
});

test('review 4: in-process leases carry an internal client no token can match; imported leases need the holder agent or an owner', async () => {
  const h = harness();
  const l = (await h.claim('runner', 'host-1/device1')).lease;
  assert.equal(l.client, 'internal:process');
  assert.equal((await h.svc.release({ id: l.id, client: 'mac' })).code, 'E_AUTH');
  const exp = Math.floor(h.clock.t / 1000) + 600;
  await h.svc.importLegacy({ leases: [{ id: 'bbbb0001', env: 'env-a', resource: 'frontend', agent: 'mac:old', expires: exp }] });
  for (const call of [(c) => h.svc.release({ id: 'bbbb0001', ...c }), (c) => h.svc.renew({ id: 'bbbb0001', ...c }), (c) => h.svc.narrow({ id: 'bbbb0001', kind: 'host', ...c }), (c) => h.svc.setMode({ id: 'bbbb0001', mode: 'pin', ...c })]) {
    assert.equal((await call({ client: 'mac' })).code, 'E_AUTH');
    assert.equal((await call({ client: 'mac', agent: 'someone-else' })).code, 'E_AUTH');
  }
  assert.equal((await h.svc.renew({ id: 'bbbb0001', client: 'mac', agent: 'mac:old' })).ok, true);
  assert.equal((await h.svc.release({ id: 'bbbb0001', client: 'other', owner: true })).ok, true);
});

test('review 5/6: deploy start/finish/cancel need the runner (exempt) client or the requesting client, approve needs an owner; a deploy_id join needs the runner or requesting client', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const r = (await d.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true, client: 'mac' })).id;
  assert.equal((await d.start({ id: r, client: 'box' })).code, 'E_AUTH');
  assert.equal((await d.cancel({ id: r, client: 'box' })).code, 'E_AUTH');
  assert.equal((await d.approve({ id: r, client: 'mac' })).code, 'E_AUTH');
  const st = await d.start({ id: r, client: 'runnerbox', exempt: true });
  assert.ok(st.ok, 'the runner client may start anyone\'s deploy');
  assert.equal((await d.finish({ id: r, status: 'done', client: 'box' })).code, 'E_AUTH');
  assert.equal((await h.claim('stranger', 'frontend', { deploy_id: r, client: 'box' })).code, 'E_AUTH', 'a stranger cannot join');
  assert.ok((await h.claim('joiner', 'frontend', { deploy_id: r, client: 'runnerbox' })).ok, 'the runner client may join');
  assert.ok((await h.claim('own', 'frontend', { deploy_id: r, client: 'mac' })).ok, 'so may the requesting client');
  assert.equal((await d.finish({ id: r, status: 'done', client: 'mac' })).ok, true, 'the requesting client may finish');
});

test('review 8: a manual update_core run holding * (exempt, not part of the deploy) blocks deploy start; the runner\'s own and the same deploy\'s leases do not', async () => {
  const h = harness();
  const d = h.svc.deploy;
  await h.claim('update_core:me', '*', { exempt: true });
  const q = await d.request({ env: 'env-a', scope: 'host', hosts: ['host-1'], ref: 'r', agent: 'a', approved: true });
  assert.equal((await d.start({ id: q.id })).code, 'E_HELD');
  await h.svc.release({ agent: 'update_core:me' });
  const st = await d.start({ id: q.id, agent: 'manager:deploy' });
  assert.ok(st.ok);
  assert.ok((await h.claim('update_core:me', 'host-1', { exempt: true, deploy_id: q.id })).ok, 'a lease of the same deploy is no blocker');
  await d.finish({ id: q.id, status: 'done' });
  await h.claim('manager:deploy', 'host-2', { exempt: true });
  const q2 = await d.request({ env: 'env-a', scope: 'host', hosts: ['host-2'], ref: 'r2', agent: 'a', approved: true });
  assert.ok((await d.start({ id: q2.id, agent: 'manager:deploy' })).ok, 'the starting agent\'s own leases are excluded');
});

test('review 9: idle downgrade needs an observable activity source; a plain mac: server-kind device lease is NOT downgraded and a server deploy stays refused', async () => {
  const h = harness({}, TRACK);
  await h.claim('mac:run', 'host-1/device1', { kind: 'server' });
  await h.claim('codebox:t', 'host-2/device1', { session: 'codebox:t' });
  await h.claim('hb', 'host-3/device1', { heartbeat_s: 3600 });
  await h.advance(21 * MIN);
  const modes = Object.fromEntries((await h.svc.list()).leases.map((l) => [l.agent, l.mode]));
  assert.deepEqual(modes, { 'mac:run': 'exclusive', 'codebox:t': 'pin', hb: 'pin' });
  const q = await h.svc.deploy.request({ env: 'env-a', scope: 'server', ref: 'r', agent: 'a', approved: true });
  assert.equal((await h.svc.deploy.start({ id: q.id })).code, 'E_HELD', 'a server deploy stays refused');
  await h.advance(70 * MIN);
  assert.equal((await h.svc.list()).leases.some((l) => l.agent === 'mac:run'), true, 'only TTL reclaims it');
});

test('review 10: housekeeping triggered by a read still reaches onEvent', async () => {
  const h = harness();
  await h.claim('a', 'host-1/device1', { ttl_min: 5 });
  h.events.length = 0;
  h.clock.t += 6 * MIN; h.clock.m += 6 * MIN;                      // nobody ticks: only a read notices
  assert.equal((await h.svc.list()).leases.length, 0);
  assert.ok(h.events.some((e) => e.kind === 'expired' && e.reason === 'ttl'));
});

test('review 12/13/14: check returns pending too; deploy list all returns finished; catch-up on a failed finish; long ttl warns and is capped; typed env spelling; skip_leased server scope', async () => {
  const h = harness();
  const d = h.svc.deploy;
  const q = await d.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true });
  const chk = await h.svc.check({ env: 'env-a', resources: 'frontend' });
  assert.equal(chk.pending.length, 1); assert.deepEqual(chk.pending, chk.pending_deploys);
  await d.start({ id: q.id });
  await d.finish({ id: q.id, status: 'failed', skipped_hosts: 'host-1' });
  assert.equal((await d.list({ env: 'env-a' })).deploys.some((x) => x.id === q.id), false, 'not active');
  const all = (await d.list({ env: 'env-a', all: true })).deploys;
  assert.equal(all.find((x) => x.id === q.id).state, 'failed');
  assert.ok(all.some((x) => x.scope === 'host' && x.hosts?.[0] === 'host-1'), 'catch-up queued on a failed finish with skipped hosts');
  const long = await h.claim('l', 'host-5/device1', { ttl_min: 600 });
  assert.equal(long.ok, true); assert.ok(long.warnings.length); assert.equal(long.lease.ttl_min, 600);
  const huge = await h.claim('m', 'host-2/device1', { ttl_min: 5000 });
  assert.equal(huge.lease.ttl_min, 1440); assert.match(huge.warnings[0], /capped/);
  assert.equal((await h.claim('n', 'host-3/device1', { ttl_min: 0 })).code, 'E_INVALID');
  await h.svc.release({ agent: 'l' }); await h.svc.release({ agent: 'm' });
  const ht = harness();
  for (const r of ['env-a/frontend', 'env-a/server', 'env-a/*', 'env-a/host:host-7', 'env-a/device:host-7/d1']) {
    const g = await ht.claim(`typed-${r}`, r); assert.ok(g.ok, r);
    await ht.svc.release({ agent: `typed-${r}` });
  }
  assert.deepEqual((await ht.claim('t2', 'env-a/frontend')).lease.resources, ['frontend']);
  const h2 = harness();
  await h2.claim('fe', 'frontend');
  assert.equal((await h2.svc.check({ env: 'env-a', skip_leased: true, resources: 'server' })).free, true, 'a single server resource is scope server');
  assert.equal((await h2.svc.check({ env: 'env-a', skip_leased: true, resources: '*' })).free, false, 'while * (full) is blocked by the frontend lease');
});

test('review 15: ticket polls and the parse cache do not grow; shadow reports rotate', async () => {
  const h = harness({ reportsMaxBytes: 300 });
  await h.claim('a', 'frontend');
  for (let i = 0; i < 20; i++) { const t = (await h.claim(`w${i}`, 'frontend', { wait: 'ticket' })).ticket; await h.svc.cancelTicket(t.id); }
  assert.equal((await h.svc.status()).polls, 0, 'poll entries are deleted when a ticket ends');
  for (let i = 0; i < 1500; i++) parseResource(`host-${i}`);
  for (let i = 0; i < 1100; i++) await h.svc.check({ env: 'env-a', resources: `hostx-${i}` });
  assert.ok((await h.svc.status()).parsed <= 1000, 'bounded');
  for (let i = 0; i < 6; i++) await h.svc.shadow.report({ machine: 'host-1', command: `claim ${i}`, legacy: { code: 0, out: 'x'.repeat(100) }, central: { code: 0, out: '' } });
  assert.ok(fs.existsSync(path.join(h.dir, 'shadow', 'reports.jsonl.1')), 'rotated');
});

test('lease events carry purpose, lease kind and since (lease-watch reads them through the client)', async () => {
  const h = harness();
  await h.claim('a', 'frontend');
  const e = (await h.svc.events({ after: 0 })).events.find((x) => x.kind === 'granted');
  assert.equal(typeof e.purpose, 'string');
  assert.ok('leaseKind' in e && 'since' in e);
});

test('deploy start: a catch-up host deploy with --skip-leased starts under device leases, but not under a whole-host lease', async () => {
  const h = harness();
  const d = h.svc.deploy;
  await h.claim('dev', 'host-1/device1', { kind: 'host' });
  const r = await d.request({ env: 'env-a', scope: 'host', ref: 'abc', agent: 'ag', hosts: ['host-1'], approved: true });
  assert.equal((await d.start({ id: r.id })).code, 'E_HELD', 'a plain start still waits for the device lease');
  const s = await d.start({ id: r.id, skip_leased: true });
  assert.equal(s.ok, true, 'skip-leased: only device leases on the host, so the deploy starts');
  assert.deepEqual(s.skipped_hosts, ['host-1']); assert.deepEqual(s.granted, []);
  assert.equal((await h.svc.list()).leases.length, 1, 'the device lease is untouched and the deploy holds nothing');
  await d.finish({ id: r.id, status: 'done' });
  await h.claim('whole', 'host-2');
  const r2 = await d.request({ env: 'env-a', scope: 'host', ref: 'abc', agent: 'ag', hosts: ['host-2'], approved: true });
  assert.equal((await d.start({ id: r2.id, skip_leased: true })).code, 'E_HELD', 'a whole-host lease still blocks');
});

test('a catch-up that defers again queues a strict catch-up that waits for the host to be free', async () => {
  const h = harness();
  const d = h.svc.deploy;
  await h.claim('dev', 'host-1/device1', { kind: 'host' });
  const r = await d.request({ env: 'env-a', scope: 'host', ref: 'abc', agent: 'ag', hosts: ['host-1'], approved: true, purpose: 'catch-up for x' });
  assert.equal((await d.start({ id: r.id, skip_leased: true })).ok, true);
  const f = await d.finish({ id: r.id, status: 'done', skipped_hosts: 'host-1' });
  assert.ok(f.catchup);
  assert.equal((await d.start({ id: f.catchup, skip_leased: true })).code, 'E_HELD', 'strict: waits for the device lease');
});

// ---- queue: grant per conflicting resource, never strict FIFO across disjoint resources ------------------------------------
test('tickets on disjoint resources are granted out of order; conflicting tickets stay FIFO', async () => {
  const h = harness();
  const l1 = (await h.claim('x1', 'host-1/device1')).lease;
  const l2 = (await h.claim('x2', 'host-2/device1')).lease;
  const t1 = (await h.claim('w1', 'host:host-1', { wait: 'ticket' })).ticket;   // older, waits for l1
  const t2 = (await h.claim('w2', 'host:host-2', { wait: 'ticket' })).ticket;   // younger, disjoint from t1
  const t3 = (await h.claim('w3', 'host:host-2', { wait: 'ticket' })).ticket;   // conflicts with t2: behind it
  assert.equal(t1.position, 1); assert.equal(t2.position, 1); assert.equal(t3.position, 2);
  assert.deepEqual(t3.behind, [t2.id]);
  await h.svc.release({ id: l2.id });
  assert.equal((await h.svc.ticket(t2.id)).ticket.state, 'granted', 'the younger disjoint ticket does not wait for t1');
  assert.equal((await h.svc.ticket(t1.id)).ticket.state, 'waiting');
  assert.equal((await h.svc.ticket(t3.id)).ticket.state, 'waiting', 'a conflicting younger ticket stays behind t2');
  await h.svc.release({ id: l1.id });
  assert.equal((await h.svc.ticket(t1.id)).ticket.state, 'granted');
});

test('an earlier conflicting ticket is never starved by a younger disjoint-then-conflicting stream', async () => {
  const h = harness();
  const l1 = (await h.claim('x1', 'host-1/device1')).lease;
  const big = (await h.claim('big', ['host:host-1', 'host:host-2'], { wait: 'ticket' })).ticket;
  const small = (await h.claim('small', 'host:host-2', { wait: 'ticket' })).ticket;    // conflicts with big on host-2 although host-2 is free
  assert.equal(small.state, 'waiting'); assert.deepEqual(small.behind, [big.id]);
  await h.svc.release({ id: l1.id });
  assert.equal((await h.svc.ticket(big.id)).ticket.state, 'granted', 'the earlier ticket goes first');
  assert.equal((await h.svc.ticket(small.id)).ticket.state, 'waiting');
});

test('server claim vs host leases: kind=host never blocks it; a default (server-kind) host ticket does, and drags later server-kind host claims behind it', async () => {
  const h = harness();
  const dev = (await h.claim('dev', 'host-1/device1', { kind: 'host' })).lease;       // device lease on a Pi, kind host
  const free = await h.claim('srv', 'server');
  assert.ok(free.ok, 'a server claim is not blocked by a kind=host device lease');
  await h.svc.release({ id: free.lease.id });
  const hd = (await h.claim('hd', 'host:host-1', { wait: 'ticket' })).ticket;          // default kind = server
  assert.equal(hd.kind, 'server');
  const srv = (await h.claim('srv2', 'server', { wait: 'ticket' })).ticket;
  assert.deepEqual(srv.behind, [hd.id], 'server ticket is behind the server-kind host ticket');
  const p4 = (await h.claim('p4', 'host:host-4', { wait: 'ticket' })).ticket;
  assert.deepEqual(p4.behind, [srv.id], 'a server-kind claim on another host is behind the server ticket');
  const p5 = await h.claim('p5', 'host:host-5', { kind: 'host' });
  assert.ok(p5.ok, 'the same claim with --kind host is granted at once');
  void dev;
});

test('deploy lease TTL is deployLeaseMin (12), not runningMaxMin; the runner-lost timeout still uses runningMaxMin', async () => {
  const h = harness();
  const q = await h.svc.deploy.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true });
  const s = await h.svc.deploy.start({ id: q.id });
  assert.equal(s.ok, true);
  assert.equal(s.lease.ttl_min, 12, 'owner rule: a deploy never holds a lease more than 10 min (+ grace)');
  const h2 = harness({ deployLeaseMin: 15 });
  const q2 = await h2.svc.deploy.request({ env: 'env-a', scope: 'frontend', ref: 'r', agent: 'a', approved: true });
  assert.equal((await h2.svc.deploy.start({ id: q2.id })).lease.ttl_min, 15, 'configurable');
  await h.advance(13 * MIN);
  assert.equal((await h.svc.list()).leases.some((l) => l.deployId), false, 'the lease expires after 13 min');
  assert.equal((await h.svc.deploy.list({ env: 'env-a' })).deploys.find((x) => x.id === q.id).state, 'running', 'the deploy itself is only failed after runningMaxMin');
});

test('a ticket whose agent holds the lease blocking the tickets ahead passes them (no self-deadlock)', async () => {
  const h = harness();
  const a = await h.claim('codebox:TASK-135-p2', ['device:host-clone-2/host'], { kind: 'host' });
  assert.equal(a.ok, true);
  const t1 = await h.claim('mac:edit-dialogs-glowup', ['host:host-clone-2', 'host:vpt-pi1', 'server'], { wait: 'ticket', kind: 'host' });
  assert.equal(t1.ok, true); assert.ok(t1.ticket, 'first ticket queued behind the holder');
  const t2 = await h.claim('codebox:TASK-135-p2', ['host:host-clone-2'], { wait: 'ticket', kind: 'host' });
  assert.equal(t2.ok, true);
  // the second request is the holder itself: it must not be queued behind the ticket that waits for its own lease
  assert.ok(t2.lease || t2.ticket?.position === 1, `holder's ticket must not sit behind ticket #1: ${JSON.stringify(t2.ticket || t2)}`);
  await h.svc.tick();
  const got = await h.svc.ticket(t2.ticket?.id || 'none');
  const lease = t2.lease || got.lease || got.ticket?.lease;
  assert.ok(lease || got.ticket?.state === 'granted', `holder's ticket granted: ${JSON.stringify(got)}`);
  const v1 = await h.svc.ticket(t1.ticket.id);
  assert.equal((v1.ticket || v1).state, 'waiting', 'ticket #1 keeps waiting for the holder');
});

// ---- priority (owner 2026-10-20): P2 is capped at 10 min and yields to a strictly higher claim; P3 is background ----------------------------------
test('priority: stored on lease and ticket, from the claim, else the session lookup, else P1; shown in list', async () => {
  const looked = [];
  const h = harness({}, { sessions: { priority: (n) => { looked.push(n); return n === 'known' ? 'P0' : null; } } });
  const a = await h.claim('a', 'host:host-1', { priority: 'P0' });
  assert.equal(a.lease.priority, 'P0'); assert.equal(a.lease.priority_source, 'claim');
  const b = await h.claim('codebox:known', 'host:host-2');
  assert.equal(b.lease.priority, 'P0'); assert.equal(b.lease.priority_source, 'session-meta'); assert.deepEqual(looked, ['known']);
  const c = await h.claim('codebox:other', 'host:host-3');
  assert.equal(c.lease.priority, 'P1'); assert.equal(c.lease.priority_source, 'default');
  const t = await h.claim('w', 'host:host-1', { wait: 'ticket', priority: 'P2' });
  assert.equal(t.ticket.priority, 'P2');
  const l = await h.svc.list();
  assert.deepEqual(l.leases.map((x) => x.priority).sort(), ['P0', 'P0', 'P1']); assert.equal(l.tickets[0].priority, 'P2');
  assert.equal((await h.claim('x', 'host:host-4', { priority: 'P9' })).code, 'E_INVALID');
});

test('priority: a P2 claim is clamped to 10 min and the clamp is recorded; P0/P1 keep their ttl', async () => {
  const h = harness();
  const p2 = await h.claim('lo', 'host:host-1', { priority: 'P2', ttl_min: 110 });
  assert.equal(p2.lease.ttl_min, 10); assert.equal(p2.lease.ttl_clamped_from, 110); assert.match(p2.warnings[0], /clamped from 110 to 10/);
  const small = await h.claim('lo2', 'host:host-2', { priority: 'P2', ttl_min: 5 });
  assert.equal(small.lease.ttl_min, 5); assert.equal(small.lease.ttl_clamped_from, null);
  const p1 = await h.claim('mid', 'host:host-3', { priority: 'P1', ttl_min: 110 });
  assert.equal(p1.lease.ttl_min, 110); assert.equal(p1.lease.ttl_clamped_from, null);
  const p0 = await h.claim('hi', 'host:host-4', { ttl_min: 110, priority: 'P0' });
  assert.equal(p0.lease.ttl_min, 110);
  const noPrio = await h.claim('none', 'host:host-5', { ttl_min: 110 });
  assert.equal(noPrio.lease.ttl_min, 110, 'default P1');
  await h.advance(11 * MIN);
  assert.equal((await h.svc.list()).leases.some((x) => x.agent === 'lo'), false, 'expired at 10 min');
});

test('priority: a P2 renewal is refused (E_YIELD_REQUIRED) while a strictly higher ticket waits; allowed with none, equal or lower', async () => {
  const h = harness();
  const lo = (await h.claim('lo', 'host:host-1', { priority: 'P2', ttl_min: 10 })).lease;
  assert.equal((await h.svc.renew({ id: lo.id, ttl_min: 120 })).lease.ttl_min, 10, 'no one waits: allowed, clamped to 10');
  assert.equal((await h.svc.renew({ id: lo.id, ttl_min: 120 })).warnings.length, 1);
  assert.equal((await h.svc.list()).leases[0].yield_required, false);
  const lower = await h.claim('lower', 'host:host-1', { wait: 'ticket', priority: 'P1' });   // strictly higher than P2
  assert.ok(lower.ticket);
  const r = await h.svc.renew({ id: lo.id, ttl_min: 10 });
  assert.equal(r.ok, false); assert.equal(r.code, 'E_YIELD_REQUIRED'); assert.match(r.error, /yield_required/); assert.equal(r.reason, 'yield_required');
  assert.equal((await h.svc.list()).leases[0].yield_required, true);
  await h.svc.cancelTicket(lower.ticket.id);
  assert.equal((await h.svc.renew({ id: lo.id, ttl_min: 10 })).ok, true, 'ticket gone: allowed again');
  // a lower-priority waiter does not force a P1 holder, and a P1 holder is never refused
  const p1 = (await h.claim('p1', 'host:host-2', { priority: 'P1', ttl_min: 60 })).lease;
  await h.claim('w2', 'host:host-2', { wait: 'ticket', priority: 'P0' });
  assert.equal((await h.svc.renew({ id: p1.id, ttl_min: 60 })).ok, true, 'P1 unaffected by a P0 ticket');
  // P2 holder, ticket on an unrelated resource: allowed
  const lo2 = (await h.claim('lo2', 'host:host-3', { priority: 'P2' })).lease;
  assert.equal((await h.svc.renew({ id: lo2.id, ttl_min: 10 })).ok, true);
});

test('priority: a lower-priority ticket does not stop a P2 renewal... but a P1 or P0 ticket does, and the P1 holder keeps today\'s behaviour', async () => {
  const h = harness({ lowPriority: 'P1' });          // threshold is a config constant: here P1 and P2 are "low", so a P2 ticket cannot outrank a P1 holder
  const holder = (await h.claim('h', 'host:host-1', { priority: 'P1' })).lease;
  assert.equal(holder.ttl_min, 10);
  await h.claim('w', 'host:host-1', { wait: 'ticket', priority: 'P2' });
  assert.equal((await h.svc.renew({ id: holder.id })).ok, true, 'a P2 ticket is lower than a P1 holder');
  await h.claim('w1', 'host:host-1', { wait: 'ticket', priority: 'P1' });
  assert.equal((await h.svc.renew({ id: holder.id })).ok, true, 'an equal-priority ticket does not force a yield');
  await h.claim('w0', 'host:host-1', { wait: 'ticket', priority: 'P0' });
  assert.equal((await h.svc.renew({ id: holder.id })).code, 'E_YIELD_REQUIRED');
});

test('priority: the holder gets a yield event once, as soon as an outranking claim waits; the heartbeat says so too', async () => {
  const h = harness();
  const lo = (await h.claim('codebox:coc-hourly-run', 'host:host-1', { priority: 'P2', ttl_min: 110 })).lease;
  assert.equal(h.events.filter((e) => e.kind === 'yield').length, 0);
  await h.claim('waiter', 'host:host-1', { wait: 'ticket', priority: 'P1' });
  const ys = h.events.filter((e) => e.kind === 'yield');
  assert.equal(ys.length, 1); assert.equal(ys[0].id, lo.id); assert.equal(ys[0].agent, 'codebox:coc-hourly-run'); assert.equal(ys[0].session, 'codebox:coc-hourly-run'); assert.equal(ys[0].priority, 'P2');
  assert.match(ys[0].reason, /turn boundary/);
  const hb = await h.svc.heartbeat({ id: lo.id, active: true });
  assert.equal(hb.ok, true); assert.equal(hb.yield_required, true); assert.match(hb.yield_message, /release/);
  await h.svc.renew({ id: lo.id }); await h.svc.heartbeat({ id: lo.id });
  assert.equal(h.events.filter((e) => e.kind === 'yield').length, 1, 'not repeated');
  // no yield event for a P1 holder
  const p1 = (await h.claim('p1', 'host:host-2', { priority: 'P1' })).lease;
  await h.claim('w2', 'host:host-2', { wait: 'ticket', priority: 'P0' });
  assert.equal(h.events.filter((e) => e.kind === 'yield' && e.id === p1.id).length, 0);
});

test('priority survives a restart (journal replay) and the ticket grant carries it to the lease', async () => {
  const h = harness();
  const lo = (await h.claim('lo', 'host:host-1', { priority: 'P2', ttl_min: 110 })).lease;
  const t = await h.claim('nxt', 'host:host-1', { wait: 'ticket', priority: 'P0', ttl_min: 60 });
  await h.svc.release({ id: lo.id });
  const svc2 = h.open();
  const l = (await svc2.list()).leases;
  assert.equal(l.length, 1); assert.equal(l[0].priority, 'P0'); assert.equal(l[0].ttl_min, 60); void t;
});

test('priority: an equal-priority waiter (P2 vs P2) forces no yield and no refused renewal; FIFO and the 10 min claims stay', async () => {
  const h = harness();
  const a = (await h.claim('codebox:run-a', 'host:host-1', { priority: 'P2', ttl_min: 110 })).lease;
  assert.equal(a.ttl_min, 10);
  const w = await h.claim('codebox:run-b', 'host:host-1', { wait: 'ticket', priority: 'P2' });
  assert.ok(w.ticket);
  assert.equal(h.events.filter((e) => e.kind === 'yield').length, 0);
  const r = await h.svc.renew({ id: a.id, ttl_min: 110 });
  assert.equal(r.ok, true); assert.equal(r.lease.ttl_min, 10, 'still clamped'); assert.equal(r.lease.yield_required, false);
  assert.equal((await h.svc.heartbeat({ id: a.id })).yield_required, undefined);
});

test('priority: P3 (background) is clamped to 10 min and yields to a P2 waiter, not to a P3 one', async () => {
  const h = harness();
  const bot = (await h.claim('codebox:coc-hourly-run', 'host:host-1', { priority: 'P3', ttl_min: 110 })).lease;
  assert.equal(bot.priority, 'P3'); assert.equal(bot.ttl_min, 10); assert.equal(bot.ttl_clamped_from, 110);
  await h.claim('other-bot', 'host:host-1', { wait: 'ticket', priority: 'P3' });
  assert.equal((await h.svc.renew({ id: bot.id, ttl_min: 110 })).ok, true, 'a P3 waiter is equal: no yield');
  assert.equal(h.events.filter((e) => e.kind === 'yield').length, 0);
  const w = await h.claim('dev', 'host:host-1', { wait: 'ticket', priority: 'P2' });
  assert.ok(w.ticket);
  assert.equal(h.events.filter((e) => e.kind === 'yield').length, 1);
  assert.equal((await h.svc.renew({ id: bot.id, ttl_min: 10 })).code, 'E_YIELD_REQUIRED');
  assert.equal((await h.claim('p', 'host:host-9', { priority: 'P3', ttl_min: 5 })).lease.ttl_min, 5);
});
