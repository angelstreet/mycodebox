// Time box after an accepted done (2026-11-26): a session whose done was accepted was woken 49 s after it answered a notice with
// `STATUS: acknowledged`, because the box only looked at the latest STATUS word. An accepted done closes the box of that task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { hashToken } from '../lease-routes.js';
import { createDoneCheck } from '../done-check.js';
import { createRemoteStops, PREFIX } from '../remote-stops.js';

const HOUR = 3600e3;
const PARTS = ['a works', 'b is deployed'];
const doneText = (second = 'pass') => `Verification:\n1. pass — int-1a1cc905977d8c7a9\n2. ${second} — int-1a1cc905977d8c7a9\nSTATUS: done — shipped · goal: achieved · evidence: int-1a1cc905977d8c7a9 · closing review: docs none needed · leftovers none · unverified none · bugs: none`;
const ACK = 'STATUS: acknowledged';

function harness({ gate = null, parts = PARTS, stateDir = tmp('ghosty-tb-') } = {}) {
  const s = { text: 'STATUS: running: pid 1 — the suite', sent: [], events: [], t: Date.now() };
  s.entry = { goal: 'ship it', parts, timeBoxMs: HOUR, at: new Date(s.t - HOUR / 2).toISOString() };
  const row = () => ({ name: 'k', cwd: '/nowhere', working: false, text: s.text });
  const make = () => createDoneCheck({
    stateDir, git: async () => { throw new Error('no repo'); }, log: { error() {} }, now: () => s.t, mode: () => 'live', timeBoxMode: () => 'live',
    pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), draftNow: async () => false,
    listDone: async () => (/^STATUS: done/m.test(s.text) ? [row()] : []), listSessions: async () => [row()], liveNames: async () => ['k'],
    goalEntryOf: () => s.entry, goalGate: gate || { forget: async () => {}, evaluate: async () => null, sent: async () => {} },
    send: async (n, x) => { s.sent.push(x); }, record: async (e) => { s.events.push(e.key); },
  });
  let w = make();
  s.restart = () => { w = make(); };
  s.say = async (text, afterMs = 0) => { s.t += afterMs; s.text = text; await w.tick(); };
  s.wakes = () => s.sent.filter((x) => /Time box reached/.test(x)).length;
  s.items = () => s.events.filter((k) => k === 'time-box:k').length;
  return s;
}

test('an accepted done, then "STATUS: acknowledged" past the box: no wake, no manager item, also after a restart', async () => {
  const s = harness();
  await s.say(doneText());                 // inside the box
  await s.say(ACK, HOUR);                  // past it
  await s.say(ACK, HOUR);
  s.restart(); await s.say(ACK, HOUR);
  await s.say('STATUS: needs-manager: improvement suggestions above, nothing built — should I do 1?', HOUR);
  assert.equal(s.wakes(), 0);
  assert.equal(s.items(), 0);
});

test('accepted after the wake had gone out: no manager item once the later reply replaces the done line', async () => {
  const s = harness();
  await s.say('STATUS: running: pid 1', HOUR);
  assert.equal(s.wakes(), 1);
  await s.say(doneText(), 60e3);
  await s.say(ACK, HOUR);
  assert.equal(s.wakes(), 1);
  assert.equal(s.items(), 0);
});

test('a done the goal gate accepts (no stored Done-when rows) closes the box too', async () => {
  const s = harness({ parts: [], gate: { forget: async () => {}, evaluate: async () => ({ kind: 'accepted' }), sent: async () => {} } });
  await s.say(doneText());
  await s.say(ACK, HOUR);
  assert.equal(s.wakes(), 0);
});

test('controls: a done that was not accepted, no done at all, and a new task under the same name are still woken', async () => {
  const failedRow = harness();
  await failedRow.say(doneText('fail'));
  await failedRow.say(ACK, HOUR);
  assert.equal(failedRow.wakes(), 1, 'a done with a failing row closes nothing');

  const leftovers = harness();
  await leftovers.say(doneText().replace('leftovers none', 'leftovers bug-0a1b2c3d'));
  await leftovers.say(ACK, HOUR);
  assert.equal(leftovers.wakes(), 1, 'a done with leftovers closes nothing');

  const never = harness();
  await never.say(ACK, HOUR);
  assert.equal(never.wakes(), 1);

  const next = harness();
  await next.say(doneText());
  next.entry = { ...next.entry, at: new Date(next.t).toISOString() };
  await next.say('STATUS: running: pid 2', 2 * HOUR);
  assert.equal(next.wakes(), 1, 'the new task has its own box');
});

test('Mac stop hook: no time-box answer after an accepted done; an open Mac session still gets one', async (t) => {
  const dir = tmp('ghosty-tb-mac-'), token = 'tok-tbox-0123456789abcdef';   // leak-scan: allow (fake test token)
  writeFileSync(join(dir, 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-a', sha256: hashToken(token), remote: true }] }));
  let clock = Date.now();
  const entry = { goal: 'ship it', parts: PARTS, timeBoxMs: HOUR, at: new Date(clock - HOUR / 2).toISOString() };
  const manager = { sessionOn: () => true, observe() {}, pendingIdOf: () => null, forget() {}, setRemoteHooks() {}, cancelAuto() {}, stallOf: () => null, triageOf: () => null, autoOf: () => null };
  const make = () => createRemoteStops({ manager, dir, stateDir: dir, goals: { get: () => entry, capture() {} }, timeBoxMode: () => 'live', now: () => clock, graceMs: 100, pollWaitMs: 100 });
  let remote = make();
  const server = http.createServer((req, res) => { remote.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const stop = async (n, text) => {
    const posted = await (await fetch(`${base}/stops`, { method: 'POST', headers, body: JSON.stringify({ machine: 'mac-test', project: 'demo', session_id: `sid-${n}-aaaaaaaa`, session_name: `m${n}`, text }) })).json();
    return String((await (await fetch(`${base}/stops/${posted.id}/answer?wait=1`, { headers })).json()).answer || '');
  };
  assert.doesNotMatch(await stop(1, doneText()), /Time box reached/);
  clock += HOUR;
  assert.doesNotMatch(await stop(1, ACK), /Time box reached/);
  assert.match(await stop(2, ACK), /Time box reached/, 'control: no accepted done');
  remote = make();   // a server restart: the Mac session rows are new, the closed box is not
  assert.doesNotMatch(await stop(1, ACK), /Time box reached/);
});
