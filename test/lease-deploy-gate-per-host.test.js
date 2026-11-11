// Owner 2026-11-11: four free STB boxes, 13 tickets (6 P1 at position 1, eta now), none granted because two strict catch-up deploys
// spanning other hosts waited on a Mi run. A deploy gates claims per host, a request blocked on some hosts starts on the free ones,
// an older ref never deploys over a newer one, and `list` says what gates a ticket. Fake registry replaying that evening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseService } from '../lease-service.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
function harness(isAncestor) {
  const clock = { t: Date.UTC(2026, 10, 11, 14, 0, 0), m: 5000 };
  const svc = createLeaseService({ dir: tmp('lease-gate-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['lab'], maxClaimMin: 1e6, ...(isAncestor ? { isAncestor } : {}) } });
  const h = { clock, svc, d: svc.deploy };
  h.advance = async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); };
  h.claim = (agent, res, o = {}) => svc.claim({ env: 'lab', resources: [].concat(res), agent, ...o });
  return h;
}
// today: a P3 Mi run on mf1/device5, the S21x on nipogi; the strict catch-ups arrive the way the registry makes them (a catch-up that skipped again)
async function evening(h) {
  const mi = (await h.claim('bot:mi', 'vpt-mf1/device5', { kind: 'host', priority: 'P1', ttl_min: 300 })).lease;
  const s21 = (await h.claim('agent:s21x', 'vpt-nipogi/device1', { kind: 'host', priority: 'P1', ttl_min: 300 })).lease;
  const mk = async (hosts, ref) => {
    const r = await h.d.request({ env: 'lab', scope: 'host', ref, agent: 'ag', hosts, approved: true, purpose: 'catch-up for x' });
    await h.d.start({ id: r.id, skip_leased: true });
    return (await h.d.finish({ id: r.id, status: 'done', skipped_hosts: hosts.join(',') })).catchup;
  };
  const small = await mk(['vpt-pi1', 'vpt-mf1'], 'c0ea83a1');
  return { mi, s21, small };
}
const stbTickets = async (h) => {
  const out = [];
  for (const [i, res] of ['vpt-pi1/device3', 'vpt-pi1/device4', 'vpt-mf1/device2', 'vpt-mf1/device3'].entries()) {
    const r = await h.claim(`agent:stb${i}`, res, { kind: 'host', priority: 'P1', wait: 'ticket' });
    out.push(r.ticket || r);
  }
  return out;
};

test('replay: tickets on a host that is busy for the deploy are granted once its window is over; free hosts get their deploy first, then the tickets', async () => {
  const h = harness();
  const { small } = await evening(h);
  await h.advance(11 * MIN);                                   // cooldown over: the strict catch-up is startable on pi1, blocked on mf1 (Mi run)
  const tks = await stbTickets(h);
  const st = await h.d.start({ id: small });                   // the runner's next tick: pi1 only, mf1 re-queued on its own
  assert.deepEqual(st.deploy.hosts, ['vpt-pi1']);
  await h.d.finish({ id: small, status: 'done' });
  await h.advance(1000);
  assert.equal((await h.svc.ticket(tks[0].id)).ticket.state, 'granted', 'pi1/device3 granted once pi1 is deployed');
  assert.equal((await h.svc.ticket(tks[1].id)).ticket.state, 'granted');
  assert.equal((await h.svc.ticket(tks[2].id)).ticket.state, 'waiting', 'mf1 is inside the 10 min window of the deploy blocked on the Mi run');
  for (let i = 0; i < 11; i++) { await h.advance(MIN); for (const t of tks.slice(2)) await h.svc.ticket(t.id); }   // the waiting clients poll their tickets
  for (const t of tks.slice(2)) assert.equal((await h.svc.ticket(t.id)).ticket.state, 'granted', `${t.resources} granted with the mf1 deploy still queued`);
  assert.equal((await h.d.list({ env: 'lab' })).deploys.filter((x) => x.state === 'queued').length, 1, 'the mf1 request is still queued, never cancelled');
});

test('a catch-up blocked on one host starts on the free ones and re-queues the busy one on its own', async () => {
  const h = harness();
  const { small } = await evening(h);
  await h.advance(11 * MIN);                                   // cooldown over
  const st = await h.d.start({ id: small });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual(st.deploy.hosts, ['vpt-pi1']);
  const q = (await h.d.list({ env: 'lab' })).deploys.filter((x) => x.state === 'queued');
  assert.equal(q.length, 1); assert.deepEqual(q[0].hosts, ['vpt-mf1']); assert.equal(q[0].strict, true); assert.equal(q[0].ref, 'c0ea83a1');
  assert.equal(st.deploy.splitTo, q[0].id);
  // the pi1 deploy gates pi1 only while it runs; mf1 is a separate request
  assert.equal((await h.claim('x', 'vpt-pi1/device3', { kind: 'host' })).code, 'E_DEPLOY_PENDING');
  await h.d.finish({ id: small, status: 'done' });
  assert.equal((await h.claim('x', 'vpt-pi1/device3', { kind: 'host' })).ok, true);
});

test('a deploy blocked on a lease gates only lower-priority claims on that host, for at most 10 min', async () => {
  const h = harness();
  const { small } = await evening(h);
  await h.advance(11 * MIN);                                   // ready (cooldown over); mf1 is blocked on the Mi run
  await h.d.start({ id: small });                              // pi1 runs, mf1 re-queued strict
  await h.d.finish({ id: small, status: 'done' });
  await h.advance(1000);
  const mf = (await h.d.list({ env: 'lab' })).deploys.find((x) => x.state === 'queued');
  assert.deepEqual(mf.hosts, ['vpt-mf1']);
  const p1 = await h.claim('agent:a', 'vpt-mf1/device2', { kind: 'host', priority: 'P1' });
  assert.equal(p1.code, 'E_DEPLOY_PENDING', 'inside the window a P1 yields to the deploy (P0)');
  assert.ok((await h.claim('agent:b', 'vpt-lenovo4/device1', { kind: 'host', priority: 'P1' })).ok, 'other hosts are never gated');
  await h.advance(11 * MIN);
  assert.ok((await h.claim('agent:a', 'vpt-mf1/device2', { kind: 'host', priority: 'P1' })).ok, 'after 10 min the claims go ahead');
});

test('an older ref never deploys over a newer one: the request ends superseded or loses the covered hosts', async () => {
  const h = harness((newer, older) => (newer === 'new' && older === 'old') || newer === older);
  const old = await h.d.request({ env: 'lab', scope: 'host', ref: 'old', agent: 'a', hosts: ['vpt-pi1', 'vpt-mf1'], approved: true, purpose: 'catch-up: a' });
  await h.d.request({ env: 'lab', scope: 'host', ref: 'new', agent: 'a', hosts: ['vpt-pi1'], approved: true, purpose: 'catch-up: b' });
  const st = await h.d.start({ id: old.id });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual(st.deploy.hosts, ['vpt-mf1'], 'pi1 is left to the newer ref');
  const h2 = harness((newer, older) => newer === 'new' && older === 'old');
  const o2 = await h2.d.request({ env: 'lab', scope: 'host', ref: 'old', agent: 'a', hosts: ['vpt-pi1'], approved: true, purpose: 'catch-up: a' });
  const n2 = await h2.d.request({ env: 'lab', scope: 'host', ref: 'new', agent: 'a', hosts: ['vpt-pi1', 'vpt-mf1'], approved: true, purpose: 'catch-up: b' });
  const s2 = await h2.d.start({ id: o2.id });
  assert.equal(s2.reason, 'covered'); assert.equal(s2.covered_by, n2.id);
  assert.equal((await h2.d.list({ env: 'lab', all: true })).deploys.find((x) => x.id === o2.id).state, 'cancelled');
});

test('a ticket that looks grantable but is gated says which deploy gates it', async () => {
  const h = harness();
  const q = await h.d.request({ env: 'lab', scope: 'host', ref: 'r', agent: 'a', hosts: ['vpt-pi1'], approved: true });
  const t = (await h.claim('agent:x', 'vpt-pi1/device3', { kind: 'host', wait: 'ticket' })).ticket;
  const v = (await h.svc.ticket(t.id)).ticket;
  assert.equal(v.position, 1);
  assert.equal(v.gated_by[0].deploy, q.id); assert.equal(v.gated_by[0].why, 'ready');
  assert.match(v.gate_note, new RegExp(`gated by deploy ${q.id}`));
  const l = (await h.svc.list()).tickets.find((x) => x.id === t.id);
  assert.ok(l.gate_note, 'list carries it too');
});

test('starvation guard: a deploy that waited 30 min behind overlapping P1 claims on two devices of its host wins the next gap (manager 2026-11-11, vpt-pi1)', async () => {
  const h = harness();
  const P1 = (n, dev) => h.claim(`agent:p${n}`, `vpt-pi1/device${dev}`, { kind: 'host', priority: 'P1', ttl_min: 300 });
  const lane = { 3: (await P1(0, 3)).lease, 4: null };
  const r0 = await h.d.request({ env: 'lab', scope: 'host', ref: 'r', agent: 'a', hosts: ['vpt-pi1'], approved: true, purpose: 'catch-up for x' });
  await h.d.start({ id: r0.id, skip_leased: true });
  const q = { id: (await h.d.finish({ id: r0.id, status: 'done', skipped_hosts: 'vpt-pi1' })).catchup };   // the strict re-arm that waits for pi1
  await h.advance(10 * MIN);                                      // cooldown over: ready now
  const t0 = h.clock.t;
  assert.equal((await h.d.start({ id: q.id })).code, 'E_HELD');
  await h.advance(11 * MIN);                                      // the 10 min window passes with device3 still held
  lane[4] = (await P1(99, 4)).lease;                              // P1 claims go ahead now
  assert.ok(lane[4], 'P1 on device4 after the window');
  // pi1 is never free: the two devices change hands 5 min apart, the next P1 claims before the other one releases
  let n = 1, started = null, chained = 0, firstRefusal = null;
  for (let step = 0; step < 24 && !started; step++) {
    await h.advance(5 * MIN);
    const dev = step % 2 ? 3 : 4, other = dev === 3 ? 4 : 3;
    const old = lane[dev];
    if (old) await h.svc.release({ id: old.id });                // this device's holder ends...
    const next = await P1(n++, dev);                              // ...and the next P1 takes it while the other device is still held
    if (next.ok) { lane[dev] = next.lease; chained++; continue; }
    assert.equal(next.code, 'E_DEPLOY_PENDING'); firstRefusal ??= Math.round((h.clock.t - t0) / MIN);
    lane[dev] = null;
    if (!lane[other]) { const st = await h.d.start({ id: q.id }); if (st.ok) started = Math.round((h.clock.t - t0) / MIN); }
    else await h.advance(1);                                      // the other holder ends at its next turn
  }
  assert.ok(chained >= 3, 'a chain of P1 claims went ahead after the 10 min window');
  assert.ok(firstRefusal >= 30, `new claims are refused from +${firstRefusal} min (starvation guard)`);
  assert.ok(started && started <= 45, `the deploy started in the gap at +${started} min`);
});
