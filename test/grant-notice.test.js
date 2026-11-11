// Grant notice (owner 2026-11-11): a live session whose ticket is granted while it is idle or waiting on it is told at once, through the
// parked-wake path. Case: mobile-orchtnet-owner held lease 1a79f027 for 30 min (granted 16:38 UTC) while its last stop still asked the manager
// about the "stuck" ticket t-779ac666. Fake host names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnJobs, grantOf, grantText } from '../own-jobs.js';
import { forbiddenMatch } from '../stall.js';

const MIN = 60e3;
function harness() {
  let t = Date.UTC(2026, 10, 11, 16, 30);
  const sent = [], logs = [];
  const st = { mode: 'live', waiting: new Set(), canSend: true, busy: false, view: { leases: [], tickets: [] } };
  const jobs = createOwnJobs({
    now: () => t, stillWaiting: (s, stopAt) => st.waiting.has(`${s}@${stopAt}`), canSend: () => st.canSend, busy: () => st.busy,
    leaseView: async () => st.view, parkMode: () => st.mode, sendParked: async (s, text) => { sent.push({ s, text }); }, log: (r) => logs.push(r),
  });
  const park = async (s, text, status, stopAt = `${s}-1`) => { st.waiting.add(`${s}@${stopAt}`); return jobs.park(s, { text, stopAt, status }); };
  const run = async (ms, step = MIN) => { const out = []; for (let x = 0; x < ms; x += step) { t += step; out.push(...await jobs.tick()); } return out; };
  return { jobs, sent, logs, st, park, run, now: () => t };
}
const ticket = { id: 't-779ac666', resources: ['lab-host-n/device50'], position: 1, state: 'waiting', agent: 'codebox:mobile-owner' };
const STOP = 'ticket t-779ac666 on lab-host-n/device50 is stuck at position 1 for 21 min with holder "?" and no visible lease. 1 let the deploys run now (recommended) / 2 clear the stale hold';

test('grantOf: only the session\'s own lease on the ticket\'s resources, granted after the park', () => {
  const now = Date.now();
  const v = { leases: [
    { id: 'old1', resources: ['lab-host-n/device50'], session: 'codebox:mobile-owner', sinceMs: now - 3600e3 },
    { id: 'other', resources: ['lab-host-n/device50'], session: 'codebox:someone-else', sinceMs: now },
    { id: '1a79f027', resources: ['lab-host-n/device50'], session: 'codebox:mobile-owner', agent: 'codebox:mobile-owner', sinceMs: now, ttlLeftMin: 28 },
  ] };
  const g = grantOf(v, 'mobile-owner', { res: ['lab-host-n/device50'], since: now - 60e3 });
  assert.equal(g.leaseId, '1a79f027');
  assert.ok(g.untilMs > now);
  assert.equal(grantOf(v, 'mobile', { res: ['lab-host-n/device50'], since: now - 60e3 }), null, 'a prefix of a name is not the session');
  assert.equal(grantOf(v, 'mobile-owner', { res: ['lab-host-x/device1'], since: now - 60e3 }), null);
});

test('a needs-manager stop that names its ticket is parked for the grant only, and told after the grace even with a busy pane', async () => {
  const h = harness();
  h.st.view = { leases: [{ id: 'L9', resources: ['lab-host-n'], session: 'codebox:deploy' }], tickets: [ticket] };
  const r = await h.park('mobile-owner', STOP, 'needs-manager');
  assert.deepEqual(r.deps.map((d) => [d.kind, d.id]), [['ticket', 't-779ac666']], 'grant-only: the resource dep is dropped');
  h.st.busy = true;   // the background `vpt-lease claim --wait` that holds the lease
  assert.deepEqual(await h.run(8 * MIN), []);
  h.st.view = { leases: [{ id: '1a79f027', resources: ['lab-host-n/device50'], session: 'codebox:mobile-owner', agent: 'codebox:mobile-owner', sinceMs: h.now(), ttlLeftMin: 28 }], tickets: [] };
  assert.deepEqual(await h.run(4 * MIN), [], 'the session\'s own --wait claim usually wakes it first');
  const woke = await h.run(2 * MIN);
  assert.equal(woke.length, 1, 'told after the 5 min grant grace');
  assert.equal(woke[0].why, 'grant');
  assert.equal(woke[0].lease, '1a79f027');
  assert.match(h.sent[0].text, /^harness: your claim t-779ac666 was granted: lab-host-n\/device50 until \d\d:\d\d UTC \(lease 1a79f027\)\. It is yours now/);
  assert.equal(forbiddenMatch(h.sent[0].text), null);
  assert.deepEqual(await h.run(4 * 60 * MIN, 10 * MIN), [], 'once, and no age backstop for a grant-only park');
});

test('dry mode logs the row it would send, with the text; a draft holds it', async () => {
  const h = harness();
  h.st.mode = 'dry';
  h.st.view = { leases: [], tickets: [ticket] };
  await h.park('mobile-owner', 'waiting: lease ticket t-779ac666 on lab-host-n/device50', 'waiting');
  h.st.view = { leases: [{ id: '1a79f027', resources: ['lab-host-n/device50'], session: 'codebox:mobile-owner', sinceMs: h.now(), ttlLeftMin: 30 }], tickets: [] };
  h.st.canSend = false;
  assert.deepEqual(await h.run(6 * MIN), []);
  h.st.canSend = true;
  const out = await h.run(MIN);
  assert.equal(h.sent.length, 0);
  const row = h.logs.find((x) => x.type === 'parked_wake_dry');
  assert.equal(row.why, 'grant');
  assert.match(row.text, /your claim t-779ac666 was granted/);
  assert.equal(out[0].dry, true);
});

test('a ticket that ended without a grant to this session keeps the neutral "left the queue" wake (after the grace)', async () => {
  const h = harness();
  h.st.view = { leases: [], tickets: [ticket] };
  await h.park('mobile-owner', 'waiting: lease ticket t-779ac666', 'waiting');
  h.st.view = { leases: [], tickets: [] };
  assert.deepEqual(await h.run(2 * MIN), []);
  const woke = await h.run(3 * MIN);
  assert.equal(woke[0].why, 'change');
  assert.match(h.sent[0].text, /left the queue \(granted or ended\)/);
});

test('grantText names the lease and how to check it', () => {
  const t = grantText('t-1', { leaseId: 'abc', resources: ['h/device1'], untilMs: Date.UTC(2026, 10, 11, 17, 6) }, (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC');
  assert.match(t, /until 17:06 UTC \(lease abc\).*vpt-lease validate abc/);
});

test('a session that resumed within the grace (its own claim woke it) is not told', async () => {
  const h = harness();
  h.st.view = { leases: [], tickets: [ticket] };
  await h.park('mobile-owner', 'waiting: lease ticket t-779ac666', 'waiting');
  h.st.view = { leases: [{ id: '1a79f027', resources: ['lab-host-n/device50'], session: 'codebox:mobile-owner', sinceMs: h.now(), ttlLeftMin: 30 }], tickets: [] };
  await h.run(2 * MIN);
  h.st.waiting.clear();   // it took a new turn
  assert.deepEqual(await h.run(10 * MIN), []);
  assert.equal(h.sent.length, 0);
});
