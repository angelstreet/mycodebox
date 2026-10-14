// Voice mode page (public/voice-view.js): end-of-speech detector on synthetic levels, the loop with fake I/O, settings, media session, wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { endOfSpeech, rms, VAD, createVoiceLoop, loadSettings, saveSettings, setupMediaSession, setMediaMetadata, itemHtml, stateText } from '../public/voice-view.js';

const rep = (v, ms) => Array.from({ length: Math.round(ms / VAD.intervalMs) }, () => v);
const QUIET = 0.004, LOUD = 0.12;

test('endOfSpeech: silence after speech ends the recording about 1.2 s later', () => {
  const lv = [...rep(QUIET, 400), ...rep(LOUD, 1000), ...rep(QUIET, 2000)];
  const r = endOfSpeech(lv);
  assert.equal(r.done, true); assert.equal(r.reason, 'silence'); assert.equal(r.started, true);
  // done exactly when the quiet has lasted silenceMs
  let n = 0; while (!endOfSpeech(lv.slice(0, ++n)).done) { /* walk */ }
  assert.equal(n * VAD.intervalMs, 400 + 1000 + VAD.silenceMs);
});
test('endOfSpeech: not done mid-sentence, a short pause does not cut, a long one does', () => {
  const mid = [...rep(QUIET, 300), ...rep(LOUD, 800), ...rep(QUIET, 600), ...rep(LOUD, 800), ...rep(QUIET, 600)];
  assert.equal(endOfSpeech(mid).done, false);
  assert.equal(endOfSpeech([...mid, ...rep(QUIET, 700)]).done, true);
});
test('endOfSpeech: 8 s maximum, even while still talking', () => {
  const r = endOfSpeech([...rep(QUIET, 300), ...rep(LOUD, 9000)]);
  assert.equal(r.reason, 'max'); assert.equal(r.started, true);
  assert.equal(endOfSpeech(rep(LOUD, 7900)).done, false);
});
test('endOfSpeech: no speech at all gives up after 5 s; a click-sized blip is not speech', () => {
  assert.equal(endOfSpeech(rep(QUIET, 4900)).done, false);
  const r = endOfSpeech(rep(QUIET, 5200));
  assert.equal(r.reason, 'no-speech'); assert.equal(r.started, false);
  const blip = endOfSpeech([...rep(QUIET, 300), LOUD, ...rep(QUIET, 5000)]);
  assert.equal(blip.started, false); assert.equal(blip.reason, 'no-speech');
});
test('endOfSpeech: a noisy room raises the threshold (steady noise is not speech), still capped', () => {
  const noisy = 0.03;
  assert.equal(endOfSpeech(rep(noisy, 5200)).started, false);
  const r = endOfSpeech([...rep(noisy, 300), ...rep(0.15, 800), ...rep(noisy, 1500)]);
  assert.equal(r.reason, 'silence'); assert.equal(r.started, true);
  assert.ok(endOfSpeech(rep(0.5, 400)).threshold <= VAD.cap);
  assert.equal(endOfSpeech([]).done, false);
});
test('rms of a buffer', () => {
  assert.equal(rms([]), 0);
  assert.ok(Math.abs(rms([1, -1, 1, -1]) - 1) < 1e-9);
});

// ---- the loop with fake speak / listen / api ----
function rig({ queues, answers = [], heard = [], autoListen = true }) {
  const log = [], skippedWait = [];
  const qs = [...queues]; const ans = [...answers]; const said = [...heard];
  let stopLoop = null;
  const deps = {
    api: {
      queue: async () => ({ items: qs.length > 1 ? qs.shift() : qs[0] }),
      answer: async (b) => { log.push(['answer', b]); return ans.shift() || { status: 'sent', say: 'Sent.' }; },
      digest: async () => ({ text: 'Digest text.' }),
    },
    speak: async (t) => { log.push(['speak', t]); },
    listen: async () => { log.push(['listen']); const h = said.shift(); if (h === undefined && stopLoop) stopLoop(); return h ?? ''; },
    chime: async () => { log.push(['chime']); },
    sleep: (ms) => new Promise((r) => { log.push(['sleep', ms]); setTimeout(r, 1); }),
    onState: () => {}, pollMs: 20000, autoListen: () => autoListen, waitTap: async () => 'listen',
  };
  const loop = createVoiceLoop(deps);
  stopLoop = () => loop.stop();
  return { loop, log };
}
const until = async (f, n = 200) => { for (let i = 0; i < n && !f(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(f(), 'condition not reached'); };
const IT = (id, session = 's') => ({ id, session, kind: 'stop', script: `${session} needs you. Say a number.`, question: 'q?', options: [{ n: 1, label: 'a' }] });

test('loop: speaks the item, listens, posts the transcript, speaks the reply, then reports empty and polls every 20 s', async () => {
  const { loop, log } = rig({ queues: [[IT('a')], []], heard: ['Option one.'], answers: [{ status: 'sent', say: 'Sent a to s.' }] });
  loop.start();
  await until(() => log.some((l) => l[0] === 'sleep'));
  loop.stop();
  const flat = log.map((l) => l[0] === 'speak' ? `speak:${l[1]}` : l[0] === 'answer' ? `answer:${l[1].id}:${l[1].transcript}` : l[0] === 'sleep' ? `sleep:${l[1]}` : l[0]);
  assert.deepEqual(flat.slice(0, 6), ['speak:s needs you. Say a number.', 'listen', 'answer:a:Option one.', 'speak:Sent a to s.', 'speak:Nothing needs you.', 'sleep:20000']);
});
test('loop: a new item after an empty queue is announced with a chime first', async () => {
  const { loop, log } = rig({ queues: [[], [], [IT('n')]], heard: ['skip'], answers: [{ status: 'intent', intent: 'skip', say: 'Skipping.' }] });
  loop.start();
  await until(() => log.some((l) => l[0] === 'answer'));
  loop.stop();
  const names = log.map((l) => l[0]);
  assert.ok(names.indexOf('chime') > -1 && names.indexOf('chime') < names.findIndex((n, i) => n === 'speak' && log[i][1].startsWith('s needs')));
});
test('loop: heard nothing twice then gives up on the item; a skipped item is not read again', async () => {
  const { loop, log } = rig({ queues: [[IT('a')]], heard: ['', '', ''] });
  loop.start();
  await until(() => log.some((l) => l[0] === 'speak' && l[1] === 'No answer. Skipping.'));
  assert.ok(log.some((l) => l[0] === 'speak' && l[1] === 'I did not hear you.'));
  await until(() => log.some((l) => l[0] === 'sleep'));
  loop.stop();
  assert.equal(log.filter((l) => l[0] === 'speak' && l[1].startsWith('s needs')).length, 1);
  assert.deepEqual(loop.skippedIds(), ['a']);
});
test('loop: confirm round trip sends the pending option; repeat re-reads; stop stops', async () => {
  const { loop, log } = rig({ queues: [[IT('a')]], heard: ['one', 'confirm'], answers: [{ status: 'confirm', option: 1, say: 'You chose a. Say confirm to send, or cancel.' }, { status: 'sent', say: 'Sent a to s.' }] });
  loop.start();
  await until(() => log.some((l) => l[0] === 'speak' && l[1] === 'Sent a to s.'));
  loop.stop();
  const answers = log.filter((l) => l[0] === 'answer').map((l) => l[1]);
  assert.equal(answers[0].pending, undefined); assert.equal(answers[1].pending, 1);
  const r2 = rig({ queues: [[IT('a')]], heard: ['repeat', 'stop'], answers: [{ status: 'intent', intent: 'repeat', say: '' }, { status: 'intent', intent: 'stop', say: 'Stopping.' }] });
  r2.loop.start();
  await until(() => !r2.loop.running);
  assert.equal(r2.log.filter((l) => l[0] === 'speak' && l[1].startsWith('s needs')).length, 2, 'read twice');
});
test('loop: stale and draft answers skip the item and say why', async () => {
  const { loop, log } = rig({ queues: [[IT('a')]], heard: ['one'], answers: [{ status: 'draft', say: 's has a draft in its input box. I did not send anything.' }] });
  loop.start();
  await until(() => log.some((l) => l[0] === 'sleep'));
  loop.stop();
  assert.ok(log.some((l) => l[0] === 'speak' && /draft/.test(l[1])));
});
test('loop: with auto-listen off it waits for a tap before listening', async () => {
  const { loop, log } = rig({ queues: [[IT('a')]], heard: ['one'], autoListen: false });
  loop.start();
  await until(() => log.some((l) => l[0] === 'answer'));
  loop.stop();
  assert.ok(log.some((l) => l[0] === 'listen'));
});

// ---- settings ----
test('settings: remembered, validated, and safe without storage', () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadSettings(st), { rate: 1, autoListen: true });
  saveSettings(st, { rate: 1.5, autoListen: false });
  assert.deepEqual(loadSettings(st), { rate: 1.5, autoListen: false });
  mem.set('ghosty.voice.settings', JSON.stringify({ rate: 9, autoListen: 'x' }));
  assert.deepEqual(loadSettings(st), { rate: 1, autoListen: true });
  mem.set('ghosty.voice.settings', '{torn');
  assert.deepEqual(loadSettings(st), { rate: 1, autoListen: true });
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadSettings(boom), { rate: 1, autoListen: true });
  assert.equal(saveSettings(boom, { rate: 1 }), false);
});

// ---- media session ----
test('media session: play/pause start and stop, next skips, previous repeats; metadata is the session', () => {
  const handlers = {}, calls = [];
  const nav = { mediaSession: { setActionHandler: (a, f) => { handlers[a] = f; }, metadata: null } };
  const loop = { start: () => calls.push('start'), stop: () => calls.push('stop'), next: () => calls.push('next'), repeat: () => calls.push('repeat') };
  assert.equal(setupMediaSession(nav, loop), true);
  for (const a of ['play', 'pause', 'nexttrack', 'previoustrack']) handlers[a]();
  assert.deepEqual(calls, ['start', 'stop', 'next', 'repeat']);
  class MD { constructor(o) { Object.assign(this, o); } }
  setMediaMetadata(nav, MD, { session: 'alpha', kind: 'stop' });
  assert.equal(nav.mediaSession.metadata.title, 'alpha'); assert.equal(nav.mediaSession.metadata.artist, 'mycodebox');
  assert.equal(setupMediaSession({}, loop), false);
  assert.equal(setupMediaSession({ mediaSession: { setActionHandler() { throw new Error('unsupported'); } } }, loop), true, 'an unknown action never throws');
});

test('itemHtml escapes; stateText', () => {
  const h = itemHtml({ session: '<b>x</b>', question: 'a & b', options: [{ n: 1, label: '"q"', recommended: true }] });
  assert.doesNotMatch(h, /<b>x/); assert.match(h, /&lt;b&gt;x/); assert.match(h, /recommended/);
  assert.match(itemHtml(null), /Nothing needs you/);
  assert.equal(stateText('listening'), 'Listening');
});

test('static: wired in the More menu and ?voice=1, precached, icons only from icons.js, no emoji', () => {
  const rd = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(rd('public/index.html'), /id="voiceBtn"/);
  assert.match(rd('public/app.js'), /voiceBtn'\)\.onclick = openVoiceMode/);
  assert.match(rd('public/app.js'), /get\('voice'\)\) openVoiceMode\(\)/);
  assert.match(rd('public/sw.js'), /'\/voice-view\.js'/);
  assert.doesNotMatch(rd('public/voice-view.js'), /\p{Extended_Pictographic}|<svg/u);
  const src = rd('public/voice-view.js');
  assert.match(src, /wakeLock\.request\('screen'\)/); assert.match(src, /visibilitychange/);
  assert.doesNotMatch(src, /webkitSpeechRecognition|SpeechRecognition/);
});
