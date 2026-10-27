import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLimit, decideQuotaResume, createQuotaResumer } from '../quota-resume.js';

const NOW = 1780000000000;
const LIMIT = ['× Error  Usage limit reached. Code: 42212 ... Your prompt is preserved.', '> do the thing'];
const LOGIN = ['Sign in to MiniMax to use Agent features. Run /login', '> do the thing'];
const st = (lines, extra = {}) => ({ name: 's1', agent: 'minimax', lines, input: '', closed: false, ...extra });
const win = (extra = {}) => ({ name: '5h', usedPercent: 10, resetsAt: null, ...extra });
const plan = (extra = {}, w = [win()]) => ({ plan: 'minimax', stale: false, at: NOW - 60e3, windows: w, ...extra });
const dec = (o = {}) => decideQuotaResume({ state: st(LIMIT), plan: plan(), now: NOW, ...o });

test('scanLimit tells a limit stop with a preserved prompt from a login stop and from nothing', () => {
  assert.deepEqual(scanLimit(LIMIT), { kind: 'limit', preserved: true });
  assert.deepEqual(scanLimit(['Usage limit reached.']), { kind: 'limit', preserved: false });
  assert.equal(scanLimit(LOGIN).kind, 'login');
  assert.equal(scanLimit(['all good', '> ']).kind, null);
});

test('window reset (reading under the limit or expired): resume', () => {
  assert.equal(dec().ok, true);
  assert.equal(dec({ plan: plan({}, [win({ usedPercent: 0, expired: true })]) }).ok, true);
});

test('window still full (even with resetsAt passed on a stale reading of the value): not yet', () => {
  assert.equal(dec({ plan: plan({}, [win({ usedPercent: 100, resetsAt: NOW / 1000 + 600 })]) }).reason, 'window-not-reset');
  assert.equal(dec({ plan: plan({}, [win({ usedPercent: 100, resetsAt: NOW / 1000 - 5 })]) }).reason, 'window-not-reset');
  assert.equal(dec({ plan: plan({}, [win(), win({ name: 'week', usedPercent: 99 })]) }).reason, 'window-not-reset');
});

test('stale, old or missing quota never triggers', () => {
  assert.equal(dec({ plan: plan({ stale: true }) }).reason, 'quota-stale');
  assert.equal(dec({ plan: plan({ at: NOW - 3600e3 }) }).reason, 'quota-stale');
  assert.equal(dec({ plan: null }).reason, 'quota-stale');
  assert.equal(dec({ plan: plan({}, []) }).reason, 'quota-stale');
});

test('a draft typed after the stop is foreign; the preserved prompt itself is not', () => {
  assert.equal(dec({ state: st(LIMIT, { input: 'do the thing' }), sighting: { draft: 'do the thing' } }).ok, true);
  assert.equal(dec({ state: st(LIMIT, { input: 'something else' }), sighting: { draft: 'do the thing' } }).reason, 'foreign-draft');
});

test('login stop is never handled', () => {
  assert.equal(dec({ state: st(LOGIN) }).reason, 'login-stop');
});

test('gates: manager session, paused, held, closed, no preserved prompt, unknown agent', () => {
  assert.equal(dec({ managerSessions: ['s1'] }).reason, 'manager-session');
  assert.equal(dec({ managerSessions: ['s1'], allowManager: true }).ok, true);
  assert.equal(dec({ paused: true }).reason, 'paused');
  assert.equal(dec({ held: true }).reason, 'held');
  assert.equal(dec({ state: st(LIMIT, { closed: true }) }).reason, 'closed');
  assert.equal(dec({ state: st(['Usage limit reached.']) }).reason, 'no-preserved-prompt');
  assert.equal(dec({ state: st(LIMIT, { agent: null }) }).reason, 'no-plan');
});

test('one resume per window; backoff holds until the time passes', () => {
  assert.equal(dec({ sighting: { reset: 100, firstSeen: NOW }, last: { at: NOW - 3600e3, key: 'r100' } }).reason, 'already-resumed');
  assert.equal(dec({ sighting: { reset: 200, firstSeen: NOW }, last: { at: NOW - 3600e3, key: 'r100' } }).ok, true);
  assert.equal(dec({ backoffUntil: NOW + 1000 }).reason, 'backoff');
  assert.equal(dec({ backoffUntil: NOW - 1 }).ok, true);
});

function harness(over = {}) {
  let t = NOW, sent = [], recs = [];
  const s = { state: st(LIMIT, { input: 'do the thing' }), quota: { plans: [plan({}, [win({ usedPercent: 100, resetsAt: NOW / 1000 + 60 })])] } };
  const r = createQuotaResumer({ getState: async () => s.state, getQuota: () => s.quota, sendEnter: async (n) => sent.push(n), record: async (e) => recs.push(e), now: () => t, ...over });
  return { r, s, sent, recs, at: (x) => { t = x; } };
}
const open = (s, t) => { s.quota = { plans: [plan({ at: t }, [win({ usedPercent: 0, expired: true })])] }; };

test('tick: waits for the reset, sends ONE Enter, journals it, and does not repeat', async () => {
  const h = harness();
  assert.equal((await h.r.tick(['s1']))[0].reason, 'window-not-reset');
  h.at(NOW + 120e3); open(h.s, NOW + 120e3);
  assert.equal((await h.r.tick(['s1']))[0].ok, true);
  assert.deepEqual(h.sent, ['s1']);
  assert.match(h.recs.at(-1).key, /^health:session-quota-resumed:s1$/);
  assert.equal((await h.r.tick(['s1']))[0].reason, 'already-resumed');
  assert.equal(h.sent.length, 1);
});

test('tick: limit hit again within 10 min of a resume backs off to the next reset', async () => {
  const h = harness();
  await h.r.tick(['s1']);                                          // seen while the window was still full
  h.at(NOW + 120e3); open(h.s, NOW + 120e3);
  await h.r.tick(['s1']);
  h.s.state = st(['no error', '> working']);                       // the stop cleared after the resume
  await h.r.tick(['s1']);
  h.at(NOW + 240e3);                                               // the limit comes back, the reading still says open
  h.s.state = st(LIMIT, { input: 'do the thing' }); open(h.s, NOW + 240e3);
  h.s.quota.plans[0].windows[0].resetsAt = undefined;
  const r = await h.r.tick(['s1']);
  assert.equal(r[0].reason, 'repeat-limit');
  assert.equal(h.sent.length, 1);
  h.at(NOW + 360e3); open(h.s, NOW + 360e3);
  assert.equal((await h.r.tick(['s1']))[0].reason, 'backoff');
  assert.equal(h.sent.length, 1);
});

test('tick: a login stop is escalated once and never answered', async () => {
  const h = harness();
  h.s.state = st(LOGIN);
  await h.r.tick(['s1']); await h.r.tick(['s1']);
  assert.equal(h.sent.length, 0);
  assert.equal(h.recs.filter((e) => /login-stop/.test(e.key)).length, 1);
});
