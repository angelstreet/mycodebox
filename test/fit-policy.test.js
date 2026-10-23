// Who may resize a shared tmux window: claim once, then only a client in use fights back, a bounded number of times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAction, IDLE_MS, MAX_RECLAIMS, GAP_MS } from '../public/fit-policy.js';

const NOW = 1_000_000;
const base = { now: NOW, lastInput: 0, asked: false, askedSame: false, taken: true, hasFocus: true, reqAt: 0, reclaims: 0 };

test('fitAction: a card claims the size once when first shown, with no input needed', () => {
  assert.equal(fitAction({ ...base }), 'ask');
  assert.equal(fitAction({ ...base, askedSame: false, asked: false, lastInput: 0 }), 'ask');
});

test('fitAction: an idle client that already asked never fights for the size back (the phone / desktop ping-pong)', () => {
  const idle = { ...base, asked: true, askedSame: true, reqAt: NOW - 60000, lastInput: NOW - IDLE_MS - 1 };
  assert.equal(fitAction(idle), 'wait');
  assert.equal(fitAction({ ...idle, lastInput: 0 }), 'wait', 'no input at all');
  assert.equal(fitAction({ ...idle, askedSame: false }), 'wait', 'not even for a new size while idle');
});

test('fitAction: a client in use reclaims after the gap, at most MAX_RECLAIMS times, only when focused and actually taken', () => {
  const use = { ...base, asked: true, askedSame: true, reqAt: NOW - GAP_MS - 1, lastInput: NOW - 1000 };
  assert.equal(fitAction(use), 'reclaim');
  assert.equal(fitAction({ ...use, reqAt: NOW - 500 }), 'wait', 'inside the 3 s gap');
  assert.equal(fitAction({ ...use, reclaims: MAX_RECLAIMS }), 'wait', 'bounded');
  assert.equal(fitAction({ ...use, hasFocus: false }), 'wait');
  assert.equal(fitAction({ ...use, taken: false }), 'wait', 'a one-column difference is not taken');
});

test('fitAction: two clients cannot ping-pong: simulate a phone in use and an idle desktop for two minutes', () => {
  let size = 'desktop', t = NOW, flips = 0;
  const phone = { asked: true, askedSame: true, reqAt: t, reclaims: 0 }, desk = { asked: true, askedSame: true, reqAt: t, reclaims: 0 };
  for (let i = 0; i < 120; i++) {
    t += 1000;
    const pa = fitAction({ now: t, lastInput: t - 500, ...phone, taken: size !== 'phone' });   // the phone is touched every second
    if (pa === 'reclaim' || pa === 'ask') { size = 'phone'; flips++; phone.reqAt = t; phone.reclaims++; }
    const da = fitAction({ now: t, lastInput: 1, ...desk, taken: size !== 'desktop' });           // the desktop got its last input long ago
    if (da === 'reclaim' || da === 'ask') { size = 'desktop'; flips++; desk.reqAt = t; desk.reclaims++; }
  }
  assert.ok(flips <= MAX_RECLAIMS + 1, `${flips} flips in two minutes`);
  assert.equal(size, 'phone', 'the client in use ends up with the size');
});

import { fitSatisfied, ROW_SLACK } from '../public/fit-policy.js';

test('fitSatisfied: at our width and about our height is good enough (an address bar sliding in and out is not a reason to resize the window)', () => {
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 53, curR: 30 }), true);
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 53, curR: 30 - ROW_SLACK }), true, 'a few rows off: still fine');
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 53, curR: 30 - ROW_SLACK - 1 }), false, 'a real height change asks again');
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 188, curR: 30 }), false, 'another client widened it: not satisfied');
});

test('fitSatisfied: the 60-column minimum: asked 53, granted 60, the pane is at 60 -> satisfied, so a touch does not ask again', () => {
  const granted = { cols: 60, rows: 30, askedCols: 53, askedRows: 30 };
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 60, curR: 30, granted }), true);
  assert.equal(fitSatisfied({ cols: 53, rows: 34, curC: 60, curR: 31, granted }), true, 'address bar: rows moved a little');
  assert.equal(fitSatisfied({ cols: 49, rows: 30, curC: 60, curR: 30, granted }), false, 'we want another width now');
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 188, curR: 30, granted }), false, 'the pane is no longer at what the server granted');
  assert.equal(fitSatisfied({ cols: 53, rows: 30, curC: 60, curR: 30, granted: null }), false, 'no grant to lean on');
});
