import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock Jev: the probability it gives its choice ("continue") is set per test.
let jevProb = 0.95;
const jev = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ success: true, cost: 0, ms: 1, model: 'mock',
    answers: { choice: { choice: 'continue', confidence: jevProb, probabilities: { continue: jevProb, take_recommended: 0, ask_owner: 1 - jevProb } } } }));
});
await new Promise((r) => jev.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'ghosty-auto-'));
Object.assign(process.env, {
  GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: `http://127.0.0.1:${jev.address().port}/server/ai/decide`, JEV_API_KEY: 'test',
});
const m = await import('../manager.js');
const keys = [], texts = [], pushes = [];
await m.initManager({
  onOwnerNeeded: (s, st, why) => pushes.push([s, st.case, why]),
  sendKey: async (s, k) => { keys.push([s, k]); },
  sendKeys: async (s, t, enter) => { texts.push([s, t, enter]); },
});

const RULE = '─'.repeat(40);
const pane = (body, prompt = '❯ ') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, prompt, RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, project: 'p', now, ...extra });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = 150;
const CONTINUE = 'Step 1 is done.\nShall I continue with step 2?';
const AMBIGUOUS = 'All good.\nNext is the cleanup of the cache code.';

// Brings a session to a logged, settled stall (clock is synthetic; delays are real).
async function stall(name, plain, state = 'done') {
  tick(name, 'working', ['busy'], 0);
  tick(name, state, plain, 1000);
  tick(name, state, plain, 2500);
  await sleep(40);
}
const on = (extra = {}) => m.setManagerConfig({ enabled: true, autoSend: true, autoCases: ['continue', 'menu_recommended'], minConfidence: 0.8, delayMs: DELAY, maxPerSessionPerHour: 4, ...extra });
const sentTo = (name) => [...keys, ...texts].filter((x) => x[0] === name);
const rec = (type, name) => records().filter((r) => r.type === type && r.session === name);

test('config: defaults are safe, values are validated', async () => {
  const c = await m.setManagerConfig({ autoSend: false, autoCases: [] });
  assert.equal(c.autoSend, false);
  await assert.rejects(m.setManagerConfig({ autoCases: ['permission'] }), /autoCases/);
  await assert.rejects(m.setManagerConfig({ minConfidence: 2 }), /minConfidence/);
  await assert.rejects(m.setManagerConfig({ delayMs: 'x' }), /delayMs/);
});

test('auto-send is off by default: nothing is typed, the owner is told', async () => {
  await m.setManagerConfig({ autoSend: false, autoCases: ['continue'], delayMs: DELAY });
  await stall('off1', pane(CONTINUE));
  await sleep(DELAY + 100);
  assert.equal(sentTo('off1').length, 0);
  assert.equal(m.autoOf('off1'), null);
  assert.equal(pushes.at(-1)[0], 'off1');
  assert.match(pushes.at(-1)[2], /auto-answer is off/);
  assert.equal(rec('escalated', 'off1').length, 1);
});

test('an allowed case is typed after the delay, logged, and its outcome is via manager', async () => {
  await on();
  const p = pane(CONTINUE);
  await stall('a1', p);
  const pending = m.autoOf('a1');
  assert.equal(pending.answer, 'Yes, continue.');
  assert.equal(pending.case, 'continue');
  assert.ok(pending.sendAt > Date.now() && pending.sendAt <= Date.now() + DELAY);
  assert.equal(sentTo('a1').length, 0, 'not before the delay');
  await sleep(DELAY + 100);
  assert.deepEqual(texts.filter((x) => x[0] === 'a1'), [['a1', 'Yes, continue.', true]]);
  assert.equal(m.autoOf('a1'), null);
  const a = rec('answer', 'a1')[0];
  assert.equal(a.case, 'continue'); assert.equal(a.source, 'rule'); assert.equal(a.confidence, 1);
  assert.deepEqual(a.answer, { text: 'Yes, continue.' });
  tick('a1', 'working', [...p.slice(0, -4), '❯ Yes, continue.', '✶ Thinking…'], 9000, { lastSendAt: Date.now(), lastSendText: 'Yes, continue.' });
  await sleep(40);
  const out = rec('outcome', 'a1')[0];
  assert.equal(out.via, 'manager');
  assert.equal(out.kind, 'continue');
  assert.equal(pushes.filter((x) => x[0] === 'a1').length, 0, 'an auto-answered stall is not pushed');
});

test('a live menu with a recommended option sends the key, not text', async () => {
  await on();
  const menu = ['How should I proceed?', '❯ 1. Option A', '  2. Option B (Recommended)', '  3. Option C', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
  await stall('k1', menu, 'waiting');
  assert.equal(m.autoOf('k1').answer, 'option 2');
  await sleep(DELAY + 100);
  assert.deepEqual(keys.filter((x) => x[0] === 'k1'), [['k1', '2']]);
  assert.equal(texts.filter((x) => x[0] === 'k1').length, 0);
  assert.equal(rec('answer', 'k1')[0].case, 'menu_recommended');
});

test('cancel stops it and logs why', async () => {
  await on();
  await stall('c1', pane(CONTINUE));
  assert.ok(m.autoOf('c1'));
  assert.equal(m.cancelAuto('c1'), true);
  assert.equal(m.cancelAuto('c1'), false);
  await sleep(DELAY + 100);
  assert.equal(sentTo('c1').length, 0);
  assert.equal(rec('answer_cancelled', 'c1')[0].reason, 'cancelled by owner');
});

test('the pane changing meanwhile cancels it', async () => {
  await on();
  await stall('p1', pane(CONTINUE));
  tick('p1', 'done', pane('Step 1 is done.\nActually here is more output.\nShall I continue with step 2?'), 3000);
  assert.equal(m.autoOf('p1'), null);
  await sleep(DELAY + 100);
  assert.equal(sentTo('p1').length, 0);
  assert.equal(rec('answer_cancelled', 'p1')[0].reason, 'pane changed');
});

test('the clock line changing is not a pane change', async () => {
  await on();
  const p = pane(CONTINUE);
  await stall('t1', p);
  tick('t1', 'done', p.map((l) => l.replace('done 3:59 PM', 'done 4:00 PM')), 3000);
  await sleep(DELAY + 100);
  assert.equal(sentTo('t1').length, 1);
});

test('a draft in the input box cancels it (also when it appears just before firing)', async () => {
  await on();
  await stall('d1', pane(CONTINUE));
  tick('d1', 'done', pane(CONTINUE, '❯ git commit -m wip'), 3000);
  await sleep(DELAY + 100);
  assert.equal(sentTo('d1').length, 0);
  assert.equal(rec('answer_cancelled', 'd1')[0].reason, 'draft in the input box');
});

test('the session moving on or the owner sending cancels it', async () => {
  await on();
  await stall('m1', pane(CONTINUE));
  tick('m1', 'working', ['✶ Thinking… esc to interrupt'], 3000);
  await sleep(DELAY + 100);
  assert.equal(sentTo('m1').length, 0);
  assert.equal(rec('answer_cancelled', 'm1')[0].reason, 'session moved on');
  await stall('m2', pane(CONTINUE));
  tick('m2', 'done', pane(CONTINUE), 3000, { lastSendAt: Date.now() + 5 });
  await sleep(DELAY + 100);
  assert.equal(sentTo('m2').length, 0);
  assert.equal(rec('answer_cancelled', 'm2')[0].reason, 'owner sent something');
});

test('forbidden topics are never auto-answered, even when Jev says continue with probability 1', async () => {
  await on();
  jevProb = 1;
  await stall('f1', pane('Branch is ready.\nNext I will deploy it to the hosts.'));
  assert.equal(m.autoOf('f1'), null);
  await stall('f2', pane('Migration written.\nShall I continue and delete the old table?'));
  assert.equal(m.autoOf('f2'), null);
  await sleep(DELAY + 100);
  assert.equal(sentTo('f1').length + sentTo('f2').length, 0);
  const r = rec('stall', 'f1')[0];
  assert.equal(r.source, 'jev'); assert.equal(r.jev.choice, 'continue'); assert.match(r.why, /forbidden/);
  assert.match(pushes.filter((x) => x[0] === 'f1').at(-1)[2], /deploy question/);
  jevProb = 0.95;
});

test('a case not in autoCases is not sent', async () => {
  await on({ autoCases: ['menu_recommended'] });
  await stall('n1', pane(CONTINUE));
  assert.equal(m.autoOf('n1'), null);
  await sleep(DELAY + 100);
  assert.equal(sentTo('n1').length, 0);
  assert.match(pushes.filter((x) => x[0] === 'n1').at(-1)[2], /not an auto-answer case/);
});

test('Jev below minConfidence is escalated; above it is sent', async () => {
  await on();
  jevProb = 0.6;
  await stall('j1', pane(AMBIGUOUS));
  assert.equal(m.autoOf('j1'), null);
  assert.match(pushes.filter((x) => x[0] === 'j1').at(-1)[2], /confidence 0\.60 below 0\.8/);
  jevProb = 0.9;
  await stall('j2', pane(AMBIGUOUS));
  assert.equal(m.autoOf('j2').case, 'continue');
  await sleep(DELAY + 100);
  assert.equal(sentTo('j2').length, 1);
  assert.equal(rec('answer', 'j2')[0].confidence, 0.9);
  assert.equal(rec('answer', 'j2')[0].source, 'jev');
  jevProb = 0.95;
});

test('the hourly cap holds', async () => {
  await on({ maxPerSessionPerHour: 1 });
  await stall('h1', pane(CONTINUE));
  await sleep(DELAY + 100);
  assert.equal(sentTo('h1').length, 1);
  tick('h1', 'working', ['✶ Thinking… esc to interrupt'], 5000);
  const p2 = pane('Step 2 is done.\nShall I continue with step 3?');
  tick('h1', 'done', p2, 6000); tick('h1', 'done', p2, 7500);
  await sleep(40);
  assert.equal(m.autoOf('h1'), null);
  await sleep(DELAY + 100);
  assert.equal(sentTo('h1').length, 1);
  assert.match(pushes.filter((x) => x[0] === 'h1').at(-1)[2], /hourly cap/);
});

test('global off or a disabled session at fire time sends nothing', async () => {
  await on();
  await stall('g1', pane(CONTINUE));
  await m.setManagerConfig({ autoSend: false });
  await sleep(DELAY + 100);
  assert.equal(sentTo('g1').length, 0);
  assert.equal(rec('answer_cancelled', 'g1')[0].reason, 'auto-answer turned off');
  await on();
  await stall('g2', pane(CONTINUE));
  await m.setManagerConfig({ session: 'g2', sessionEnabled: false });
  await sleep(DELAY + 100);
  assert.equal(sentTo('g2').length, 0);
  assert.match(rec('answer_cancelled', 'g2')[0].reason, /disabled/);
  await stall('g3', pane(CONTINUE));   // a disabled session is not even classified
  await m.setManagerConfig({ session: 'g3', sessionEnabled: false });
  await m.setManagerConfig({ session: 'g4', sessionEnabled: false });
  await stall('g4', pane(CONTINUE));
  assert.equal(rec('stall', 'g4').length, 0);
});

test('today counts', async () => {
  const c = await m.todayCounts();
  assert.ok(c.answered >= 3 && c.cancelled >= 3 && c.escalated >= 3, JSON.stringify(c));
});

test.after(() => jev.close());
