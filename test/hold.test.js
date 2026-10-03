import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionMeta } from '../session-meta.js';
import { evaluatePolicy } from '../public/policy.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-hold-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const meta = createSessionMeta({ file: join(dir, 'sessions.json') });
const keys = [], texts = [], alerts = [];
let quota = { plans: [] };
const setPct = (pct) => { quota = { plans: [{ plan: 'claude', label: 'Claude Max', stale: false, windows: [{ name: '5h', usedPercent: pct, resetsAt: Date.now() / 1000 + 3600 }] }] }; };
setPct(85);
await m.initManager({
  onOwnerNeeded: () => {},
  sendKey: async (s, k) => { keys.push([s, k]); },
  sendKeys: async (s, t, enter) => { texts.push([s, t, enter]); },
  paused: (n) => meta.isPaused(n),
  policy: (n, agent) => evaluatePolicy({ priority: meta.priority(n), agent, quota, now: Date.now(), config: m.policyConfig() }),
  heldStore: { get: (n) => meta.held(n), set: (n, h) => meta.setHeld(n, h) },
  onHold: (n, kind, reason) => alerts.push([n, kind, reason]),
});
const DELAY = 150;
await m.setManagerConfig({ enabled: true, autoSend: true, autoCases: ['continue', 'menu_recommended'], minConfidence: 0.8, delayMs: DELAY, maxPerSessionPerHour: 4, policyEnabled: true, p2MaxPct: 80 });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const CONTINUE = 'Step 1 is done.\nShall I continue with step 2?';
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, project: 'p', now });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(30);
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const rec = (type, n) => records().filter((r) => r.type === type && r.session === n);
const sentTo = (n) => [...keys, ...texts].filter((x) => x[0] === n);
async function stall(name, prio) {
  meta.sync([name]); meta.set(name, { priority: prio });
  tick(name, 'working', ['busy'], 0);
  tick(name, 'done', pane(CONTINUE), 1000);
  tick(name, 'done', pane(CONTINUE), 2500);
  await sleep(40);
}

test('P2 at 85 % is held: not scheduled, hold logged and pushed once, no key typed', async () => {
  setPct(85);
  await stall('h2', 'P2');
  assert.equal(m.autoOf('h2'), null);
  const h = meta.held('h2');
  assert.equal(h.by, 'manager');
  assert.match(h.reason, /Claude Max 5h 85%/);
  assert.equal(meta.isPaused('h2'), false, 'separate from the owner pause');
  await flush();
  assert.equal(rec('hold', 'h2').length, 1);
  assert.equal(rec('hold', 'h2')[0].by, 'manager');
  assert.deepEqual(alerts.filter((a) => a[0] === 'h2'), [['h2', 'hold', h.reason]]);
  await sleep(DELAY + 100);
  assert.equal(sentTo('h2').length, 0);
  // same hold re-evaluated while quota stays high: still one alert and one log line
  m.reevaluateHolds();
  assert.equal(rec('hold', 'h2').length, 1);
  assert.equal(alerts.filter((a) => a[0] === 'h2' && a[1] === 'hold').length, 1);
});

test('P0 at 85 % is scheduled and answered', async () => {
  await stall('h0', 'P0');
  assert.ok(m.autoOf('h0'));
  assert.equal(meta.held('h0'), null);
  await sleep(DELAY + 100);
  assert.deepEqual(texts.filter((x) => x[0] === 'h0'), [['h0', 'Yes, continue.', true]]);
  assert.equal(rec('hold', 'h0').length, 0);
});

test('a hold never sends Escape (nothing at all is typed by the manager)', () => {
  assert.equal(keys.filter((k) => k[1] === 'Escape').length, 0);
  assert.equal(sentTo('h2').length, 0);
});

test('the hold is released when quota drops: resume logged, pending stall scheduled and sent', async () => {
  setPct(30);
  m.reevaluateHolds();
  await flush();
  assert.equal(meta.held('h2'), null);
  const r = rec('resume', 'h2');
  assert.equal(r.length, 1);
  assert.equal(r[0].by, 'manager');
  assert.ok(alerts.some((a) => a[0] === 'h2' && a[1] === 'resume'));
  assert.ok(m.autoOf('h2'), 'scheduled with the usual countdown');
  assert.equal(sentTo('h2').length, 0);
  await sleep(DELAY + 100);
  assert.deepEqual(texts.filter((x) => x[0] === 'h2'), [['h2', 'Yes, continue.', true]]);
});

test('owner Resume clears a manager hold', async () => {
  setPct(90);
  await stall('h3', 'P2');
  assert.ok(meta.held('h3'));
  assert.equal(m.releaseHold('h3'), true);
  await flush();
  assert.equal(meta.held('h3'), null);
  assert.equal(rec('resume', 'h3').at(-1).by, 'owner');
  assert.equal(m.releaseHold('h3'), false, 'nothing left to release');
  m.reevaluateHolds();
  assert.equal(m.autoOf('h3'), null, 'owner resume sends continue itself; the manager does not also answer');
});

test('a hold set while the countdown runs (quota jumped) cancels the answer at fire time', async () => {
  setPct(30);
  await stall('h4', 'P2');
  assert.ok(m.autoOf('h4'));
  setPct(88);
  await sleep(DELAY + 100);
  assert.equal(sentTo('h4').length, 0);
  assert.ok(meta.held('h4'));
  await flush();
  assert.ok(rec('answer_cancelled', 'h4').some((r) => /held/.test(r.reason)));
});

test('a held session that moves on by itself loses the hold; policy off allows', async () => {
  tick('h4', 'working', ['busy'], 5000);
  assert.equal(meta.held('h4'), null);
  await m.setManagerConfig({ policyEnabled: false });
  assert.equal(m.policyConfig().policyEnabled, false);
  setPct(95);
  await stall('h5', 'P2');
  assert.ok(m.autoOf('h5'));
  m.cancelAuto('h5');
  await m.setManagerConfig({ policyEnabled: true });
});

test('hold survives a restart (persisted in session-meta)', () => {
  const again = createSessionMeta({ file: join(dir, 'sessions.json') });
  assert.ok(!again.held('h2'));
  meta.setHeld('hx', { by: 'manager', reason: 'x', at: 't' });
  assert.equal(createSessionMeta({ file: join(dir, 'sessions.json') }).held('hx').reason, 'x');
  meta.setHeld('hx', null);
});

test('config validation', async () => {
  await assert.rejects(m.setManagerConfig({ p2MaxPct: 500 }), /p2MaxPct/);
  assert.equal((await m.setManagerConfig({ p2MaxPct: 70 })).p2MaxPct, 70);
  await m.setManagerConfig({ p2MaxPct: 80 });
});
