// Parked-session wake (harness review 2026-11-11, Q5 item 5): a STATUS blocked / waiting stop that the own-job watch does not follow is woken
// once when what it names changes, or at its maximum age. Cases from the night of 2026-11-10 to 11, with fake host names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnJobs, parkedDeps, parkGate, resourceHeld, dependencyText } from '../own-jobs.js';
import { classifyStall, forbiddenMatch, ownerFloorMatch } from '../stall.js';

const MIN = 60e3;
function harness(over = {}) {
  let t = Date.UTC(2026, 10, 10, 22, 0);
  const sent = [], logs = [];
  const st = { mode: 'live', waiting: new Set(), canSend: true, busy: false, view: { leases: [], tickets: [] }, integrations: {}, bugs: {} };
  const jobs = createOwnJobs({
    now: () => t, stillWaiting: (s, stopAt) => st.waiting.has(`${s}@${stopAt}`), canSend: () => st.canSend, busy: () => st.busy,
    leaseView: async () => st.view, integrationState: async (id) => st.integrations[id] || null, bugState: async (id) => st.bugs[id] || null,
    parkMode: () => st.mode, sendParked: async (s, text) => { sent.push({ s, text }); }, log: (r) => logs.push(r), ...over,
  });
  const park = async (s, text, status = 'blocked', stopAt = `${s}-1`) => { st.waiting.add(`${s}@${stopAt}`); return jobs.park(s, { text, stopAt, status }); };
  const run = async (ms, step = MIN) => { const out = []; for (let x = 0; x < ms; x += step) { t += step; out.push(...await jobs.tick()); } return out; };
  return { jobs, sent, logs, st, park, run, now: () => t };
}
const lease = (id, resources, session) => ({ id, resources, mode: 'exclusive', kind: 'device', agent: session, session: `codebox:${session}` });

test('two sessions blocked ~11 h on a device that became free are each woken once, after the grace', async () => {
  const h = harness();
  h.st.view = { leases: [lease('L1', ['lab-host1/device5'], 'content-tv')], tickets: [{ id: 't-d6429025', resources: ['lab-host1/device5'], position: 1, state: 'waiting' }] };
  // kpi-tv: names its ticket; content-tv's sibling names the device itself
  await h.park('kpi-tv', 'Mi device5 held by content-tv; my ticket t-d6429025 is 1st (eta ~22:12 UTC, no equivalent box exists), waiting for the grant.');
  await h.park('sweep-tv', 'lab-host1/device5 is held by content-tv; I re-claim when it is free.');
  assert.deepEqual(await h.run(30 * MIN), []);
  h.st.view = { leases: [], tickets: [] };   // the lease ends; the ticket is granted and leaves the queue
  assert.deepEqual(await h.run(2 * MIN), []);   // inside the 3 min grace
  const woke = await h.run(3 * MIN);
  assert.deepEqual(woke.map((w) => w.session).sort(), ['kpi-tv', 'sweep-tv']);
  assert.match(h.sent.find((x) => x.s === 'kpi-tv').text, /^harness: lease ticket t-d6429025 left the queue \(granted or ended\) at \d\d:\d\d UTC while you were parked on STATUS blocked\. Re-check and continue/);
  assert.match(h.sent.find((x) => x.s === 'sweep-tv').text, /lab-host1\/device5 is free \(no lease holds it\)/);
  assert.deepEqual(await h.run(11 * 60 * MIN, 10 * MIN), []);   // ONE wake per stop, never again for it
  assert.equal(h.sent.length, 2);
});

test('a session parked on "waiting: integration <id>" is woken when the integration ends (the lane result was dropped)', async () => {
  const h = harness();
  h.st.integrations['int-1a1c36daf99e2939c'] = { id: 'int-1a1c36daf99e2939c', state: 'testing' };
  const r = await h.park('coc-audit', 'integration int-1a1c36daf99e2939c · bugs: fixed bug-dce7d104', 'waiting');
  assert.deepEqual(r.deps.map((d) => d.kind), ['integration']);   // the bug in the done tail is not a dependency
  assert.deepEqual(await h.run(20 * MIN), []);
  h.st.integrations['int-1a1c36daf99e2939c'] = { id: 'int-1a1c36daf99e2939c', state: 'merged', endedAt: new Date(h.now()).toISOString() };
  const woke = await h.run(5 * MIN);
  assert.equal(woke.length, 1);
  assert.match(h.sent[0].text, /^harness: integration int-1a1c36daf99e2939c ended \(merged\) at \d\d:\d\d UTC while you were parked on STATUS waiting\./);
  assert.equal(forbiddenMatch(h.sent[0].text), null);
});

test('a P3 session that yielded to a P1 claim is woken when the device is free again', async () => {
  const h = harness();
  h.st.view = { leases: [lease('Lci', ['lab-host1/device5'], 'ci-runner')], tickets: [] };
  const line = 'P1 CI claims on `lab-host1/device5` yielded my P3 sweep, so no missed-slot run completed; the scheduled ticks stay the real run · closing review: docs unchanged · unverified: replay · bugs: none';
  const r = await h.park('content-tv', line);
  assert.deepEqual(r.deps.map((d) => [d.kind, d.id, d.before]), [['resource', 'lab-host1/device5', 'held']]);
  assert.deepEqual(await h.run(60 * MIN), []);
  h.st.view = { leases: [], tickets: [] };
  await h.run(2 * MIN);
  h.st.view = { leases: [lease('L2', ['lab-host1'], 'deployer')], tickets: [] };   // taken again (a host lease covers its devices): the grace starts over
  assert.deepEqual(await h.run(10 * MIN), []);
  h.st.view = { leases: [], tickets: [] };
  assert.equal((await h.run(5 * MIN)).length, 1);
  assert.match(h.sent[0].text, /lab-host1\/device5 is free/);
});

test('a change detail with a forbidden word is sent in the neutral form', async () => {
  const h = harness();
  h.st.integrations['int-ffffff1'] = { state: 'testing' };
  await h.park('s', 'integration int-ffffff1', 'waiting');
  h.st.integrations['int-ffffff1'] = { state: 'deployed' };
  await h.run(5 * MIN);
  assert.match(h.sent[0].text, /^harness: integration int-ffffff1 changed at \d\d:\d\d UTC while/);
  assert.equal(forbiddenMatch(h.sent[0].text), null);
});

test('no change: one wake at the maximum age, with the equivalent-device hint; then nothing for that stop', async () => {
  const h = harness();
  h.st.view = { leases: [], tickets: [] };
  await h.park('kpi-tv', 'Mi device5 is kept free for content-tv until 04:50 UTC; after that I re-claim and run the measurements.', 'blocked');
  // the device is already free at park time: not a change; the 04:50 time is (22:00 -> 04:50 next day)
  const d = h.jobs.parkedOf('kpi-tv').deps;
  assert.deepEqual(d.map((x) => x.kind), ['time']);
  const h2 = harness();
  await h2.park('idle', 'waiting for the next window to run the sweep', 'waiting');
  assert.deepEqual(await h2.run(170 * MIN, 10 * MIN), []);
  const woke = await h2.run(10 * MIN);
  assert.equal(woke.length, 1); assert.equal(woke[0].why, 'age');
  assert.match(h2.sent[0].text, /^harness: you have been parked on STATUS waiting for 3 h and nothing you named changed\./);
  assert.doesNotMatch(h2.sent[0].text, /vpt-lease/);
  const h3 = harness();
  h3.st.view = { leases: [lease('L1', ['lab-host1/device5'], 'other')], tickets: [] };
  await h3.park('dev', 'lab-host1/device5 held by other');
  await h3.run(185 * MIN, 5 * MIN);
  assert.match(h3.sent[0].text, /vpt-lease claim <env> --any <group> --wait/);
  assert.equal(forbiddenMatch(h3.sent[0].text), null);
});

test('a named UTC time that passes is a change', async () => {
  const h = harness();
  await h.park('kpi-tv', 'device kept free for content-tv until 22:30 UTC; after that I re-claim.');
  assert.deepEqual(await h.run(30 * MIN), []);
  const woke = await h.run(5 * MIN);
  assert.equal(woke.length, 1);
  assert.match(h.sent[0].text, /the time you named \(22:30 UTC\) has passed/);
});

test('gates: moved on, draft / paused, live background work, 2 per hour, off and dry modes', async () => {
  // moved on: a new stop (or a working session) drops the entry
  let h = harness();
  h.st.integrations['int-aaaaaa1'] = { state: 'merged' };
  h.st.integrations['int-bbbbbb2'] = { state: 'testing' };
  await h.park('s', 'integration int-bbbbbb2', 'waiting');
  h.st.waiting.clear(); h.st.integrations['int-bbbbbb2'] = { state: 'merged' };
  assert.deepEqual(await h.run(10 * MIN), []); assert.equal(h.jobs.parkedOf('s'), null);
  // already over at park time: not a change (the session knew it when it stopped)
  h = harness(); h.st.integrations['int-aaaaaa1'] = { state: 'merged' };
  await h.park('s', 'integration int-aaaaaa1', 'waiting');
  assert.deepEqual(await h.run(30 * MIN), []);
  // canSend false (draft, paused, hourly cap of manager replies) and live background work defer, never drop
  h = harness(); h.st.integrations['int-bbbbbb2'] = { state: 'testing' };
  await h.park('s', 'integration int-bbbbbb2', 'waiting');
  h.st.integrations['int-bbbbbb2'] = { state: 'returned' };
  h.st.canSend = false; assert.deepEqual(await h.run(10 * MIN), []);
  h.st.canSend = true; h.st.busy = true; assert.deepEqual(await h.run(10 * MIN), []);
  h.st.busy = false; assert.equal((await h.run(2 * MIN)).length, 1);
  // at most 2 parked wakes per session per rolling hour
  h = harness();
  for (let i = 0; i < 3; i++) {
    h.st.integrations[`int-ccccc${i}`] = { state: 'testing' };
    await h.park('s', `integration int-ccccc${i}`, 'waiting', `stop${i}`);
    h.st.integrations[`int-ccccc${i}`] = { state: 'merged' };
    await h.run(5 * MIN);
  }
  assert.equal(h.sent.length, 2);
  assert.ok(h.logs.some((l) => l.type === 'parked_wake_capped'));
  assert.equal((await h.run(60 * MIN)).length, 1);   // the hour rolls over: the third stop is woken
  // off (the default): nothing is parked
  h = harness(); h.st.mode = 'off';
  assert.equal((await h.park('s', 'integration int-ddddd1', 'waiting')).parked, false);
  // dry: logs what it WOULD send, once per stop, types nothing
  h = harness(); h.st.mode = 'dry'; h.st.integrations['int-eeeee1'] = { state: 'testing' };
  await h.park('s', 'integration int-eeeee1', 'waiting');
  h.st.integrations['int-eeeee1'] = { state: 'merged' };
  const dry = await h.run(30 * MIN);
  assert.equal(dry.length, 1); assert.equal(dry[0].dry, true); assert.equal(h.sent.length, 0);
  assert.equal(h.logs.filter((l) => l.type === 'parked_wake_dry').length, 1);
  assert.match(h.logs.find((l) => l.type === 'parked_wake_dry').text, /^harness: integration int-eeeee1 ended \(merged\)/);
});

test('a ticket that reaches position 1, a released lease id and a resolved bug are changes', async () => {
  const h = harness();
  h.st.view = { leases: [{ id: 'a1b2c3d4', resources: ['lab-host2'], session: 'codebox:x' }], tickets: [{ id: 't-0000abcd', resources: ['lab-host2'], position: 3, state: 'waiting' }] };
  h.st.bugs['bug-0badf00d'] = 'open';
  await h.park('t', 'my ticket t-0000abcd is 3rd for lab-host2', 'waiting');
  await h.park('b', 'blocked until bug-0badf00d is fixed', 'blocked');
  await h.park('l', 'waiting until lease a1b2c3d4 ends', 'waiting');
  h.st.view.tickets[0].position = 1; h.st.bugs['bug-0badf00d'] = 'fixed'; h.st.view.leases = [];
  await h.run(5 * MIN);
  assert.match(h.sent.find((x) => x.s === 'l').text, /lease a1b2c3d4 was released/);
  assert.match(h.sent.find((x) => x.s === 't').text, /lease ticket t-0000abcd reached position 1/);
  assert.match(h.sent.find((x) => x.s === 'b').text, /bug-0badf00d was resolved \(fixed\)/);
});

test('parkGate: open ask, hard floor and forbidden topics without a system id are never parked', () => {
  const g = (text, openAsk = false) => parkGate(text, { openAsk, floor: ownerFloorMatch, forbidden: forbiddenMatch });
  assert.equal(g('P1 CI claims on `lab-host1/device5` yielded my P3 sweep').ok, true);
  assert.equal(g('lab-host1/device5 held by content-tv', true).ok, false);
  assert.match(g('waiting for you to add credit on the provider account').why, /hard floor/);
  assert.match(g('waiting for your go to deploy the frontend').why, /forbidden topic/);
  assert.equal(g('waiting: integration int-1a1c42a8f600ae5ab --deploy frontend').ok, true);   // a queue wait whose words name a topic
});

test('the real STATUS lines classify with a blocked / waiting status the manager parks', () => {
  for (const [line, status] of [
    ['STATUS: blocked: P1 CI claims on `lab-host1/device5` yielded my P3 sweep, so no missed-slot run completed · bugs: none', 'blocked'],
    ['STATUS: blocked: Mi device5 held by content-tv; my ticket t-d6429025 is 1st (eta ~22:12 UTC), waiting for the grant.', 'blocked'],
    ['STATUS: waiting: integration int-1a1c36daf99e2939c', 'waiting'],
  ]) {
    const c = classifyStall({ plain: ['Done with this part.', line], state: 'done' });
    assert.equal(String(c.status).toLowerCase(), status, line);
  }
});

test('pure helpers: done tail stripped, host lease covers its devices, own lease never blocks', () => {
  assert.equal(dependencyText('x on lab-host1/device5 · closing review: docs none · bugs: reported bug-12345678'), 'x on lab-host1/device5');
  assert.deepEqual(parkedDeps('yielded lab-host1/device5 · bugs: reported bug-12345678').map((d) => d.kind), ['resource']);
  const v = { leases: [lease('L', ['lab-host1'], 'other'), lease('M', ['lab-host2/device1'], 'me')] };
  assert.equal(resourceHeld('lab-host1/device5', v, 'me'), true);
  assert.equal(resourceHeld('lab-host2/device1', v, 'me'), false);
  assert.equal(resourceHeld('lab-host3/device1', v, 'me'), false);
  // a resource the lease view knows is matched by name even without the host/device shape
  assert.deepEqual(parkedDeps('waiting for lab-host1 to come back', v).map((d) => d.id), ['lab-host1']);
});
