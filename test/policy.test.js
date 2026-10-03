import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePolicy as ev, suggestAgent, shortPercent } from '../public/policy.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = 86400;
const nowS = NOW / 1000;
const win = (name, usedPercent, extra = {}) => ({ name, usedPercent, resetsAt: nowS + 3600, ...extra });
const plan = (p, label, windows, extra = {}) => ({ plan: p, label, windows, stale: false, ...extra });
// week window `elapsed` of the way through with `used` % used
const week = (used, elapsed) => win('week', used, { resetsAt: nowS + (1 - elapsed) * 7 * DAY });
const q = (...plans) => ({ at: NOW, plans });
const claude = (h, wk = week(10, 0.5)) => plan('claude', 'Claude Max', [win('5h', h), wk]);
const run = (priority, quota, agent = 'claude', config) => ev({ priority, agent, quota, now: NOW, config });

test('P0 is always allowed, even at 99 %', () => {
  assert.equal(run('P0', q(claude(99))).action, 'allow');
  assert.equal(run('P0', q(claude(99, week(99, 0.2)))).action, 'allow');
});

test('P1: allowed under the threshold, held at and above it', () => {
  assert.equal(run('P1', q(claude(79.9))).action, 'allow');
  const h = run('P1', q(claude(80)));
  assert.equal(h.action, 'hold');
  assert.match(h.reason, /Claude Max 5h 80%/);
  assert.equal(run('P1', q(claude(95))).action, 'hold');
  assert.equal(run('P1', q(claude(60)), 'claude', { p1MaxPct: 50 }).action, 'hold');
});

test('P1 ignores the weekly projection', () => {
  assert.equal(run('P1', q(claude(10, week(90, 0.2)))).action, 'allow');
});

test('P2: held on the 5h window at 80 %, allowed under', () => {
  assert.equal(run('P2', q(claude(79))).action, 'allow');
  const h = run('P2', q(claude(86)));
  assert.equal(h.action, 'hold');
  assert.match(h.reason, /5h 86%/);
  assert.equal(run('P2', q(claude(70)), 'claude', { p2MaxPct: 60 }).action, 'hold');
});

test('P2: weekly window projected to run out before reset is held', () => {
  // 30 % used at 25 % elapsed -> 120 % projected
  const h = run('P2', q(claude(10, week(30, 0.25))));
  assert.equal(h.action, 'hold');
  assert.match(h.reason, /week 30%/);
  // 40 % used at 50 % elapsed -> 80 %: fine
  assert.equal(run('P2', q(claude(10, week(40, 0.5)))).action, 'allow');
  // exactly 100 % projected is not "more than" the window
  assert.equal(run('P2', q(claude(10, week(50, 0.5)))).action, 'allow');
});

test('P2: weekly projection needs 10 % of the window elapsed', () => {
  assert.equal(run('P2', q(claude(10, week(9, 0.05)))).action, 'allow');   // would project 180 %
  assert.equal(run('P2', q(claude(10, week(9, 0.09)))).action, 'allow');   // 100 % exactly
  assert.equal(run('P2', q(claude(10, week(20, 0.1)))).action, 'hold');
});

test('unknown quota never holds', () => {
  for (const priority of ['P1', 'P2']) {
    assert.deepEqual(run(priority, q()), { action: 'allow', reason: 'quota unknown' });
    assert.equal(run(priority, q(plan('claude', 'Claude Max', [win('5h', 99)], { stale: true }))).reason, 'quota unknown');
    assert.equal(run(priority, q(plan('claude', 'Claude Max', [win('5h', null)]))).reason, 'quota unknown');
    assert.equal(run(priority, q(plan('claude', 'Claude Max', [win('5h', 0, { expired: true, resetsAt: null })]))).reason, 'quota unknown');
    assert.equal(run(priority, q(plan('claude', 'Claude Max', []))).reason, 'quota unknown');
    assert.equal(run(priority, null).action, 'allow');
  }
  // an unknown 5h window does not hide a weekly overrun
  assert.equal(run('P2', q(plan('claude', 'Claude Max', [win('5h', null), week(30, 0.25)]))).action, 'hold');
});

test('policy is per agent: codex quota does not hold a claude session', () => {
  const cx = plan('codex', 'Codex', [win('5h', 90)]);
  assert.equal(run('P2', q(cx, claude(10)), 'claude').action, 'allow');
  assert.equal(run('P2', q(cx, claude(10)), 'codex').action, 'hold');
});

test('minimax: tokens only, unknown unless a monthly budget is set', () => {
  const mm = plan('minimax', 'MiniMax', [{ name: '5h', usedPercent: null, input: 1e6, output: 1e6 }, { name: 'month', usedPercent: null, input: 4e6, output: 4.5e6 }]);
  assert.equal(shortPercent(mm, {}), null);
  assert.equal(run('P2', q(mm), 'minimax').reason, 'quota unknown');
  const cfg = { minimaxMonthlyTokenBudget: 10e6 };
  assert.equal(shortPercent(mm, cfg), 85);
  assert.equal(run('P2', q(mm), 'minimax', cfg).action, 'hold');
  assert.equal(run('P1', q(mm), 'minimax', cfg).action, 'hold');
  assert.equal(run('P0', q(mm), 'minimax', cfg).action, 'allow');
  assert.equal(run('P2', q(mm), 'minimax', { minimaxMonthlyTokenBudget: 20e6 }).action, 'allow');
});

test('policyEnabled false allows everything', () => {
  assert.equal(run('P2', q(claude(99)), 'claude', { policyEnabled: false }).action, 'allow');
});

// ---- agent suggestion ----
const cx = (h) => plan('codex', 'Codex', [win('5h', h)]);
const mmp = (tokens) => plan('minimax', 'MiniMax', [{ name: 'month', usedPercent: null, input: tokens, output: 0 }]);
const sg = (p, quota, cfg) => suggestAgent(p, quota, cfg).agent;

test('suggest P2: MiniMax unless known to be under pressure', () => {
  assert.equal(sg('P2', q(claude(10), cx(10), mmp(1e6))), 'minimax');             // budget unset: unknown -> minimax
  assert.equal(sg('P2', q(claude(10), cx(10), mmp(1e6)), { minimaxMonthlyTokenBudget: 10e6 }), 'minimax');
  assert.equal(sg('P2', q(claude(40), cx(20), mmp(9e6)), { minimaxMonthlyTokenBudget: 10e6 }), 'codex');   // minimax at 90 %
  assert.equal(sg('P2', q(claude(10), cx(10), mmp(9e6)), { minimaxMonthlyTokenBudget: 10e6 }), 'claude');  // tie -> claude
  assert.equal(sg('P2', q()), 'minimax');
});
test('suggest P0: Claude unless it is at 95 % or more', () => {
  assert.equal(sg('P0', q(claude(94), cx(0))), 'claude');
  assert.equal(sg('P0', q(claude(95), cx(30))), 'codex');
  assert.equal(sg('P0', q(claude(97))), 'claude');                                   // nothing else known
  assert.equal(sg('P0', q()), 'claude');
});
test('suggest P1: most headroom among known plans, Claude on ties', () => {
  assert.equal(sg('P1', q(claude(50), cx(20))), 'codex');
  assert.equal(sg('P1', q(claude(20), cx(50))), 'claude');
  assert.equal(sg('P1', q(claude(30), cx(30))), 'claude');
  assert.equal(sg('P1', q(plan('claude', 'Claude Max', [win('5h', 10)], { stale: true }), cx(50))), 'codex');  // stale = unknown
  assert.equal(sg('P1', q()), 'claude');
  assert.match(suggestAgent('P1', q(claude(50), cx(20))).reason, /Codex 5h 20%/);
});
