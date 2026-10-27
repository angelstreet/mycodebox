import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, windowStart, modelClass, meterConfig, newShareAlerts, createMinimaxMeter, WINDOW_MS, METER_DEFAULTS } from '../minimax-meter.js';
import { minimaxHtml } from '../public/usage-view.js';

const NOW = 1_800_000_000_000, MIN = 60000;
const row = (o) => ({ agent: 'minimax', label: 'a', session: 'mvs_1', model: 'MiniMax-M3', ts: NOW - MIN, usage: { input: 1000, output: 500, cache_read: 200000 }, ...o });

test('window boundary: (start, now] counts, a row at start does not, 24 h still does', () => {
  const wStart = NOW - 2 * 3600000;
  const s = aggregate([row({ ts: wStart }), row({ ts: wStart + 1 }), row({ ts: NOW - 23 * 3600000 }), row({ ts: NOW - 25 * 3600000 })], { now: NOW, wStart });
  assert.equal(s.window.calls, 1);
  assert.equal(s.h24.calls, 3);
  assert.equal(s.sessions[0].window.newTokens, 1500);
  assert.equal(s.sessions[0].window.cacheRead, 200000);
});

test('M3 vs Flash split, a row without a model is "other" but still a call', () => {
  const s = aggregate([row({}), row({ model: 'MiniMax-M2-Flash' }), row({ model: undefined })], { now: NOW, wStart: NOW - WINDOW_MS });
  const w = s.sessions[0].window;
  assert.deepEqual([w.byModel.m3.calls, w.byModel.flash.calls, w.byModel.other.calls, w.calls], [1, 1, 1, 3]);
  assert.equal(modelClass('minimax-flash'), 'flash');
});

test('label wins over session id, id is the fallback, other agents are ignored', () => {
  const s = aggregate([row({ label: 'x' }), row({ label: 'x', session: 'mvs_2' }), row({ label: undefined, session: 'mvs_9' }), row({ agent: 'claude', label: 'c' })], { now: NOW, wStart: NOW - WINDOW_MS });
  assert.deepEqual(s.sessions.map((x) => [x.name, x.window.calls]), [['x', 2], ['mvs_9', 1]]);
  assert.equal(s.sessions[0].share, 66.7);
  assert.equal(s.sessions[0].top, true);
});

test('manager marking', () => {
  const s = aggregate([row({ label: 'mm-manager' })], { now: NOW, isManager: (n) => n === 'mm-manager' });
  assert.equal(s.sessions[0].manager, true);
});

test('poll loop: many calls with tiny new tokens in the recent minutes; real work is not flagged', () => {
  const tiny = Array.from({ length: 50 }, (_, i) => row({ label: 'poller', ts: NOW - i * 5000, usage: { input: 20, output: 10, cache_read: 200000 } }));
  const busy = Array.from({ length: 50 }, (_, i) => row({ label: 'worker', ts: NOW - i * 5000, usage: { input: 2000, output: 1000, cache_read: 200000 } }));
  const few = Array.from({ length: 5 }, (_, i) => row({ label: 'quiet', ts: NOW - i * 5000, usage: { input: 1, output: 1 } }));
  const s = aggregate([...tiny, ...busy, ...few], { now: NOW });
  const by = Object.fromEntries(s.sessions.map((x) => [x.name, x.pollLoop]));
  assert.deepEqual(by, { poller: true, worker: false, quiet: false });
  const old = aggregate(tiny.map((r) => ({ ...r, ts: r.ts - 30 * MIN })), { now: NOW });
  assert.equal(old.sessions[0].pollLoop, false);
});

test('windowStart: resetsAt minus 5 h, else now minus 5 h', () => {
  assert.equal(windowStart((NOW + 3600000) / 1000, NOW), NOW + 3600000 - WINDOW_MS);
  assert.equal(windowStart(null, NOW), NOW - WINDOW_MS);
  assert.equal(windowStart((NOW - 1000) / 1000, NOW), NOW - WINDOW_MS);
});

test('share alert fires once per session and window, needs a minimum of calls', () => {
  const cfg = { ...METER_DEFAULTS, shareMinCalls: 10 };
  const mk = (n, m) => aggregate([...Array.from({ length: n }, () => row({ label: 'big' })), ...Array.from({ length: m }, () => row({ label: 'small' }))], { now: NOW, wStart: NOW - WINDOW_MS });
  const told = new Set();
  assert.equal(newShareAlerts(mk(5, 1), cfg, told).length, 0);          // too few calls
  assert.deepEqual(newShareAlerts(mk(8, 4), cfg, told).map((s) => s.name), ['big']);   // 66 %
  assert.equal(newShareAlerts(mk(9, 4), cfg, told).length, 0);          // already told
  assert.equal(newShareAlerts(mk(5, 5), cfg, new Set()).length, 2);     // both sit at 50 % > 40 in a fresh window
});

test('config overrides', () => {
  assert.equal(meterConfig({ minimaxSharePct: 25, minimaxPollLoopCalls: 'x' }).sharePct, 25);
  assert.equal(meterConfig({ minimaxPollLoopCalls: 'x' }).pollLoopCalls, 40);
});

test('meter reads the plan window from quota and caches', () => {
  let reads = 0;
  const quota = () => ({ plans: [{ plan: 'minimax', windows: [{ name: '5h', usedPercent: 42, resetsAt: (NOW + 3600000) / 1000 }] }] });
  const m = createMinimaxMeter({ ledgerFile: 'x', quota, now: () => NOW, read: () => { reads++; return [row({ ts: NOW - 3 * 3600000 }), row({ ts: NOW - 4.5 * 3600000 })]; } });
  const s = m.snapshot(); m.snapshot();
  assert.equal(reads, 1);
  assert.equal(s.window.calls, 1);   // 4.5 h ago is before windowStart = now - 4 h
  assert.equal(s.plan.usedPercent, 42);
  assert.deepEqual(m.forSession('a'), { calls: 1, share: 100, pollLoop: false, top: true });
  assert.equal(m.forSession('nope'), null);
});

test('minimaxHtml renders the bar, the top consumer and the loop chip, and escapes names', () => {
  const s = aggregate(Array.from({ length: 50 }, (_, i) => row({ label: '<b>', ts: NOW - i * 1000, usage: { input: 1, output: 1 } })), { now: NOW });
  const html = minimaxHtml({ ...s, plan: { usedPercent: 63, resetsAt: null }, note: 'calls' });
  assert.match(html, /63%/); assert.match(html, /possible poll loop/); assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b><b>/);
  assert.match(minimaxHtml(null), /no MiniMax meter/);
});
