// Goal check on the Mac path (goal-check.js + remote-stops.js): a done stop from the Mac Stop hook is answered by the gate at once
// (the question, or the fix-first bounce), the first prompt the hook sends is the goal, and a loop-guarded stop is never answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { hashToken } from '../lease-routes.js';
import { tmp } from './helpers-tmp.js';

const stateDir = tmp('ghosty-goal-remote-');
Object.assign(process.env, { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '' });
const manager = await import('../manager.js');
const { createRemoteStops, PREFIX } = await import('../remote-stops.js');
const { createGoalGate, createGoalStore } = await import('../goal-check.js');

const REMOTE = 'tok-remote-0123456789abcdef';   // leak-scan: allow (fake test token)
const leasesDir = path.join(stateDir, 'leases');
fs.mkdirSync(leasesDir, { recursive: true });
fs.writeFileSync(path.join(leasesDir, 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-a', sha256: hashToken(REMOTE), remote: true }] }));

const goals = createGoalStore({ stateDir });
const records = [];
const goalGate = createGoalGate({ stateDir, goalOf: async (n) => goals.get(n)?.goal || '', record: async (e) => { records.push(e); } });
const remote = createRemoteStops({ manager, dir: leasesDir, stateDir, goalGate, goals, graceMs: 1500, pollWaitMs: 600 });
await manager.initManager({ onOwnerNeeded: () => {}, sendKey: async (n, k) => (remote.owns(n) ? remote.deliverKey(n, k) : null), sendKeys: async (n, t) => (remote.owns(n) ? remote.deliver(n, t) : null) });
await manager.setManagerConfig({ delayMs: 250, maxPerSessionPerHour: 50 });
fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));

const server = http.createServer((req, res) => { remote.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${REMOTE}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
test.after(() => new Promise((r) => server.close(r)));

const EXAMPLE = 'STATUS: done — resolved bug-3fbdd970, bug-430a348e, bug-b6a0056d · closing review: docs none needed · leftovers bug-827764ef, bug-2f32e7a7, bug-8fc8fc0d, bug-03ccc6a7, bug-80bdcdc1 · unverified: none · bugs: none';
const CLEAN = 'STATUS: done — menu edge fixed · goal: achieved · evidence: int-1a1cbfa071 · closing review: docs none needed · leftovers none · unverified none · bugs: none';

test('Mac: the first prompt is the goal; a done stop is answered with the owner\'s question at once, quoting it', async () => {
  const r = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-goal-1aaaa', session_name: 'menu', text: CLEAN,
    first_prompt: 'Fix the Apple TV menu edge on appletv-orchtnet so goto home passes three runs in a row.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.answerable, true);
  assert.equal(goals.get(r.body.session).source, 'mac-first-prompt');
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.equal(a.body.state, 'answered');
  assert.match(a.body.answer, /^Goal check: Goal as given: "Fix the Apple TV menu edge on appletv-orchtnet so goto home passes three runs in a row\."\. Did you reach it\?/);
  // the reply comes back with stop_hook_active (Claude Code continues because of the hook): judged, never answered (loop guard)
  const r2 = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-goal-1aaaa', session_name: 'menu', text: 'Yes.\n' + CLEAN, stop_hook_active: true });
  assert.equal(r2.body.answerable, false);
  assert.equal(records.length, 1, 'the rejected reply went to the manager');
  assert.match(records[0].title, /SendMessage to the session name/);
});

test('Mac: the owner\'s example line is bounced by the fix-first rule', async () => {
  const r = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-goal-2bbbb', session_name: 'lease', text: EXAMPLE });
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.equal(a.body.state, 'answered');
  assert.match(a.body.answer, /^Goal check: your done line lists 5 filed leftovers/);
  await new Promise((res) => setTimeout(res, 100));   // the gate records the sent bounce in the background
  assert.equal((await goalGate.snapshot()).sessions[r.body.session].bouncedToday, 1);
});

test('Mac: a done line that says the work is not done is refused through the hook at once, once per line (deterministic, no goal check state)', async () => {
  const LINE = 'The tree publish is waiting.\nSTATUS: done — dev tree fixed, the tree publish is not done and waits for approval · closing review: docs none needed · leftovers none · unverified none · bugs: none';
  const post = (text, extra = {}) => call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-honest-3cccc', session_name: 'honest', text, ...extra });
  const r = await post(LINE);
  assert.equal(r.body.answerable, true);
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.equal(a.body.state, 'answered');
  assert.match(a.body.answer, /^Status check: your STATUS says done, but your own text says the goal was not achieved/);
  assert.match(a.body.answer, /STATUS: failed — goal not achieved/);
  const again = await post(LINE, { stop_hook_active: true });
  assert.equal(again.body.answerable, false, 'the loop guard still holds');
});

test('Mac: a blocked line that is a wait is journalled only while blockedCheck is dry (default)', async () => {
  const r = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-blocked-4dddd', session_name: 'blk', text: 'STATUS: blocked: waiting on the radio sweeps (background b4q6r4fh1)' });
  assert.equal(r.status, 200);
  const j = fs.readFileSync(path.join(stateDir, 'blocked-check.jsonl'), 'utf8');
  assert.match(j, /"dry":true/); assert.match(j, /background job/);
});

test('Mac: a done line needs a Verification block per stored Done-when line (answered once through the hook, rows journalled); all pass is accepted without the goal question', async () => {
  const first = 'Goal: ship the menu fix.\nDone when:\n1. merged, integration id\n2. goto home passes three runs, run id\nTime box: 2 h';
  const DONE = 'STATUS: done — menu fixed · goal: achieved · evidence: int-1a1cbfa071 · closing review: docs none needed · leftovers none · unverified none · bugs: none';
  const post = (text, extra = {}) => call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-verify-5eeee', session_name: 'verify', first_prompt: first, text, ...extra });
  const r = await post(DONE);
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.equal(a.body.state, 'answered');
  assert.match(a.body.answer, /needs a `Verification:` block.*no `Verification:` block \(0 of 2 rows pass\)/);
  assert.equal(goals.get(r.body.session).timeBoxMs, 2 * 3600e3);
  const j = fs.readFileSync(path.join(stateDir, 'verification.jsonl'), 'utf8');
  assert.match(j, /"passed":0,"total":2/);
  const ok = await post('Verification:\n1. pass — int-1a1cbfa071\n2. pass — run 1a2b3c4d5e6f\n' + DONE.replace('menu fixed', 'menu fixed again'));
  assert.equal(ok.status, 200);
  const b = await call('GET', `/stops/${ok.body.id}/answer?wait=1`);
  assert.ok(!/Verification/.test(b.body.answer || ''), 'verified: no verification refusal and no goal question');
  assert.match(fs.readFileSync(path.join(stateDir, 'verification.jsonl'), 'utf8'), /"passed":2,"total":2/);
});

test('Mac: a failed line without cause: / plan: is journalled while blockedCheck is dry (default)', async () => {
  const r = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-failed-5eeee', session_name: 'fld', text: 'STATUS: failed — goal not achieved: empty wakes 54% against 25% · tried: four wake rules' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(stateDir, 'blocked-check.jsonl'), 'utf8'), /"missing":\["cause:","plan:"\]/);
});

test('Mac: a done line with leftovers or an unverified list is refused once (done only with nothing open)', async () => {
  const text = 'All merged.\n\nSTATUS: done — rules merged · goal: achieved · evidence: int-1a1ceef9ed9027539 · closing review: docs none needed · leftovers bug-67c65223 · unverified: live wake share · bugs: none';
  const r = await call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: 'sid-open-6ffff', session_name: 'opn', text });
  assert.equal(r.status, 200);
  const w = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.match(JSON.stringify(w.body), /done is only for a task with nothing open/);
});
