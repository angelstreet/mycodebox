// The card repaint plan: only rows of the visible screen changed -> overwrite in place (no clear, scrollback untouched);
// anything else -> full repaint. A tiny screen emulator proves the in-place result equals the full repaint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPaint } from '../public/term-paint.js';

// Minimal terminal: rows x cols screen + scrollback, handles \x1b[H \x1b[2J \x1b[3J \x1b[K \x1b[J, \r, \n (convertEol), SGR ignored, no wrap.
function term(rows) {
  const t = { rows, screen: Array.from({ length: rows }, () => ''), back: [], r: 0, c: 0 };
  t.write = (s) => {
    const parts = s.split(/(\x1b\[[0-9;:?]*[A-Za-z]|\r\n|\n|\r)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\n' || p === '\r\n') { t.c = 0; if (t.r === rows - 1) { t.back.push(t.screen.shift()); t.screen.push(''); } else t.r++; continue; }
      if (p === '\r') { t.c = 0; continue; }
      const m = /^\x1b\[([0-9;:?]*)([A-Za-z])$/.exec(p);
      if (m) {
        const [, a, f] = m;
        if (f === 'H') { t.r = 0; t.c = 0; }
        else if (f === 'J' && a === '2') t.screen = Array.from({ length: rows }, () => '');
        else if (f === 'J' && a === '3') t.back = [];
        else if (f === 'J' && (a === '' || a === '0')) { t.screen[t.r] = t.screen[t.r].slice(0, t.c); for (let i = t.r + 1; i < rows; i++) t.screen[i] = ''; }
        else if (f === 'K') t.screen[t.r] = t.screen[t.r].slice(0, t.c);
        continue;   // m, h, l and the rest: no effect on the text
      }
      t.screen[t.r] = t.screen[t.r].slice(0, t.c) + p; t.c += p.length;
    }
  };
  return t;
}
const FULL = '\x1b[?25l\x1b[3J\x1b[2J\x1b[H';
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i));
const text = (ls) => ls.join('\n');

test('planPaint: nothing painted yet, a tiny grid, or no change', () => {
  assert.equal(planPaint(null, 'a', 10).mode, 'full');
  assert.equal(planPaint('a', 'b', 1).mode, 'full');
  assert.equal(planPaint('a\nb', 'a\nb', 10).mode, 'skip');
});

test('planPaint: a change in the visible rows is in place, with no clear and no scrollback wipe', () => {
  const a = lines(100), b = a.slice(); b[99] = 'Running 5min48s'; b[97] = 'Thought for 0.2s';
  const plan = planPaint(text(a), text(b), 24);
  assert.equal(plan.mode, 'inplace');
  assert.ok(!/\x1b\[[23]J/.test(plan.data), 'no 2J / 3J');
  assert.ok(plan.data.startsWith('\x1b[?25l\x1b[H'));
  assert.ok(!plan.data.includes('line 10\x1b'), 'the head (scrollback) is not rewritten');
});

test('planPaint: a history line changed, or lines scrolled, is a full repaint', () => {
  const a = lines(100), b = a.slice(); b[3] = 'edited in the scrollback';
  assert.equal(planPaint(text(a), text(b), 24).mode, 'full');
  assert.equal(planPaint(text(a), text(lines(101)), 24).mode, 'full', 'one more line scrolls everything');
  assert.equal(planPaint(text(lines(30)), text(lines(29)), 24).mode, 'full');
});

test('planPaint: the in-place screen equals a full repaint (growing, shrinking and ticking panes), scrollback unchanged', () => {
  for (const [n0, n1] of [[100, 100], [10, 10], [10, 14], [14, 10], [24, 24], [5, 3], [3, 5]]) {
    const rows = 24;
    const a = lines(n0), b = lines(n1, (i) => (i >= n1 - 6 ? `tick ${i} ${n1}` : `line ${i}`));
    const t = term(rows); t.write(FULL + text(a));
    const backBefore = t.back.slice();
    const plan = planPaint(text(a), text(b), rows);
    const ref = term(rows); ref.write(FULL + text(b));
    if (plan.mode === 'inplace') {
      t.write(plan.data);
      assert.deepEqual(t.screen, ref.screen, `${n0}->${n1}: screen`);
      assert.deepEqual(t.back, backBefore, `${n0}->${n1}: scrollback untouched`);
      assert.deepEqual(t.back, ref.back, `${n0}->${n1}: scrollback equals the full repaint's`);
    } else assert.equal(plan.mode, 'full', `${n0}->${n1}`);
  }
});

test('planPaint: the head SGR codes are replayed so the first in-place row keeps its colour state', () => {
  const a = lines(60), b = a.slice(); a[10] = '\x1b[1;31mred bold starts'; b[10] = a[10]; b[59] = 'tick';
  const plan = planPaint(text(a), text(b), 24);
  assert.equal(plan.mode, 'inplace');
  assert.ok(plan.data.includes('\x1b[1;31m'), 'carried');
});
