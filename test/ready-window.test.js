// Round 9 item 8: "ready for N minutes" on a device -> the manager answers hardware-step asks while the window is open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadyStore, parseReadySpeech, isHardwareAsk, readyReply, MAX_MINUTES } from '../ready-window.js';
import { matchSpokenAnswer, normalizeSpeech, createVoice } from '../voice.js';
import { decidedItems, decidedSummary } from '../decided.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-ready-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
let clock = Date.now();
const store = createReadyStore({ file: join(dir, 'ready-windows.json'), now: () => clock, timezone: 'UTC' });
const sent = [], pushes = [];
await m.initManager({ onOwnerNeeded: (s, st, why) => pushes.push({ s, why }), sendKey: async (s, k) => { sent.push([s, { key: k }]); }, sendKeys: async (s, t) => { sent.push([s, t]); }, readyStore: store });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: true, delayMs: 30, maxPerSessionPerHour: 50 });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
let seq = 0;
async function ask(name, text) {
  const t0 = Date.now() + (seq += 10000);
  tick(name, 'working', ['busy'], t0);
  tick(name, 'done', pane(text), t0 + 1000); tick(name, 'done', pane(text), t0 + 2500);
  for (let i = 0; i < 100 && !records().some((r) => r.session === name && r.type === 'stall' && r.excerpt?.includes(text.split('\n')[0].slice(0, 20)) && (seq || true)); i++) await sleep(20);
  await sleep(150);
}
const PAIR = (n) => `The remote test needs the device paired (attempt ${n}).\nPlease press the pair button on the pixel remote, then tell me when it is paired.`;
const sentTo = (n) => sent.filter((x) => x[0] === n);

test('store: window per target, expiry, clear, bounds, matching', () => {
  const w = store.set({ device: 'pixel', minutes: 30, by: 'owner' });
  assert.equal(w.scope, 'device'); assert.equal(w.until - w.set_at, 30 * 60e3); assert.match(w.until_hhmm, /^\d\d:\d\d$/);
  assert.throws(() => store.set({ device: 'x', minutes: 0 }), /minutes must be/);
  assert.throws(() => store.set({ device: 'x', minutes: MAX_MINUTES + 1 }), /minutes must be/);
  assert.throws(() => store.set({ device: 'a', host: 'b', minutes: 5 }), /name one of/);
  assert.throws(() => store.set({ device: '../../x', minutes: 5 }), /not allowed/);
  assert.ok(store.match({ session: 's', text: 'press the pair button on the Pixel remote' }), 'device named in the ask');
  assert.equal(store.match({ session: 's', text: 'press the button on the tablet' }), null, 'another device');
  assert.equal(store.match({ session: 's', text: 'pixels are fun' }), null, 'whole words only');
  const again = store.set({ device: 'Pixel', minutes: 10 });
  assert.equal(store.list().length, 1, 'a new window for the same target replaces the old one');
  clock += 11 * 60e3;
  assert.equal(store.list().length, 0, 'expired'); assert.equal(store.match({ session: 's', text: 'pixel' }), null);
  clock -= 11 * 60e3;
  assert.equal(store.clear('all'), 0);
  const s = store.set({ session: 'rig-1', minutes: 5 });
  assert.ok(store.match({ session: 'rig-1', text: '' })); assert.equal(store.match({ session: 'rig-2', text: '' }), null);
  assert.equal(store.clear(s.id), 1);
  const anyW = store.set({ minutes: 5 });
  assert.equal(anyW.scope, 'any'); assert.ok(store.match({ session: 'whatever', text: '' }));
  store.clear('all');
});

test('window state survives a restart (file)', () => {
  store.set({ host: 'bench-box', minutes: 20 });
  const again = createReadyStore({ file: join(dir, 'ready-windows.json'), now: () => clock });
  assert.equal(again.list()[0].target, 'bench-box');
  store.clear('all');
});

test('speech: "ready for N minutes [on <device>]" maps to the intent; nothing else does', () => {
  const p = (t) => parseReadySpeech(normalizeSpeech(t));
  assert.deepEqual(p('Ready for 30 minutes.'), { minutes: 30, device: null });
  assert.deepEqual(p("I'm ready for ten minutes on the pixel"), { minutes: 10, device: 'pixel' });
  assert.deepEqual(p('ready for 45 minutes on stb 3'), { minutes: 45, device: 'stb 3' });
  assert.deepEqual(p('ready for an hour'), { minutes: 60, device: null });
  assert.equal(p('ready for 0 minutes'), null); assert.equal(p('ready for 9999 minutes'), null);
  assert.equal(p('yes ready for dinner'), null); assert.equal(p('go with the recommendation'), null);
  assert.deepEqual(matchSpokenAnswer('Ready for 30 minutes on the pixel.', { options: [] }), { type: 'intent', intent: 'ready', minutes: 30, device: 'pixel' });
});

test('voice answer: the ready intent opens a window (device named, or the open item\'s session) and says until when', async () => {
  const calls = [];
  const voice = createVoice({
    status: async () => ({ 'rig-1': { state: 'done', agent: 'claude', stall: { id: 'st1', case: 'owner_decision', question: 'Which one?', options: [{ n: 1, text: 'A' }, { n: 2, text: 'B' }] } } }),
    ownerAsks: async () => [], managerSessions: () => [], send: async () => {}, setReady: async (a) => { calls.push(a); return { until_hhmm: '15:30', ...a }; },
  });
  const [item] = await voice.queue();
  const r1 = await voice.answer({ id: item.id, transcript: 'ready for 30 minutes on the pixel' });
  assert.equal(r1.body.intent, 'ready'); assert.match(r1.body.say, /pixel.*until 15:30/);
  const r2 = await voice.answer({ id: item.id, transcript: 'ready for 20 minutes' });
  assert.match(r2.body.say, /for rig-1.*until 15:30/);
  assert.deepEqual(calls.map((c) => [c.minutes, c.device, c.session, c.by]), [[30, 'pixel', null, 'owner-voice'], [20, null, 'rig-1', 'owner-voice']]);
  const none = await createVoice({ status: async () => ({ 'rig-1': { state: 'done', agent: 'claude', stall: { id: 'st1', case: 'owner_decision', question: 'Which one?', options: [{ n: 1, text: 'A' }, { n: 2, text: 'B' }] } } }), ownerAsks: async () => [], managerSessions: () => [], send: async () => {} });
  assert.match((await none.answer({ id: (await none.queue())[0].id, transcript: 'ready for 5 minutes' })).body.say, /not connected/);
});

test('isHardwareAsk: hardware steps yes, anything forbidden or unrelated no', () => {
  const a = (action, question = '', kase = 'owner_action') => isHardwareAsk({ kase, action, question, excerpt: `${action}\n${question}` });
  assert.equal(a('press the pair button on the remote'), true);
  assert.equal(a('', 'Is the remote paired?', 'owner_decision'), true);
  assert.equal(a('plug the cable back in'), true);
  assert.equal(a('power-cycle the box'), true);
  assert.equal(a('reload the page'), false);
  assert.equal(a('press the pair button, then deploy to prod'), false, 'a deploy word in the ask');
  assert.equal(a('plug in the cable', '', 'done'), false, 'only owner_action / owner_decision');
  assert.match(readyReply({ until_hhmm: '15:30' }), /^The owner is at the device until 15:30: retry the step yourself; stop after 2 failures\.$/);
});

test('manager: two hardware asks inside the window are answered, the third goes to the owner; outside the window nothing is answered', async () => {
  sent.length = 0; pushes.length = 0;
  const w = store.set({ device: 'pixel', minutes: 30 });
  await ask('hw1', PAIR(1)); await sleep(100);
  assert.equal(sentTo('hw1').length, 1, JSON.stringify(sent));
  assert.equal(sentTo('hw1')[0][1], readyReply(store.view ? { until_hhmm: w.until_hhmm } : w));
  await ask('hw1', PAIR(2)); await sleep(100);
  assert.equal(sentTo('hw1').length, 2);
  await ask('hw1', PAIR(3)); await sleep(100);
  assert.equal(sentTo('hw1').length, 2, 'the third ask is not answered');
  assert.ok(pushes.some((p) => p.s === 'hw1' && /ready window/.test(p.why)), 'the owner is told');
  const ans = records().filter((r) => r.type === 'answer' && r.session === 'hw1');
  assert.equal(ans.length, 2); assert.equal(ans[0].ready.target, 'pixel'); assert.equal(ans[1].ready.n, 2);
  // another session has its own count; a different device is not covered
  await ask('hw2', PAIR(1)); await sleep(100);
  assert.equal(sentTo('hw2').length, 1);
  await ask('hw3', 'The tablet is not responding.\nPlease press the power button on the tablet, then tell me.'); await sleep(100);
  assert.equal(sentTo('hw3').length, 0, 'a device without a window');
  store.clear('all');
  await ask('hw4', PAIR(1)); await sleep(100);
  assert.equal(sentTo('hw4').length, 0, 'no window open');
});

test('manager: a forbidden or hard topic in the ask is never waved through; autoSend off is respected', async () => {
  sent.length = 0;
  store.set({ minutes: 30 });
  await ask('hw5', 'The pairing is stuck.\nPlease press the pair button on the remote, then I will deploy to production.'); await sleep(100);
  assert.equal(sentTo('hw5').length, 0);
  await m.setManagerConfig({ autoSend: false });
  await ask('hw6', PAIR(1)); await sleep(100);
  assert.equal(sentTo('hw6').length, 0, 'auto-answer off');
  await m.setManagerConfig({ autoSend: true });
  store.clear('all');
});

test('decided for you: a ready answer is its own kind with a plain summary', async () => {
  const v = await m.decidedView({ hours: 24, limit: 50 });
  const items = v.items.filter((i) => i.kind === 'ready');
  assert.ok(items.length >= 2);
  assert.match(items[0].what, /retry the hardware step itself/);
  assert.match(v.summary.text, /hardware retries/);
  assert.equal(decidedSummary([], {}).count, 0);
  assert.ok(decidedItems({ recs: [] }).length === 0);
});
