import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollPlan, wheelPlan, altScrollApplies, MAX_NOTCHES } from '../alt-scroll.js';

test('scrollPlan maps the four directions to PageUp / PageDown', () => {
  assert.deepEqual(scrollPlan('up'), { key: 'PageUp', count: 1 });
  assert.deepEqual(scrollPlan('down'), { key: 'PageDown', count: 1 });
  assert.equal(scrollPlan('top').key, 'PageUp');
  assert.ok(scrollPlan('top').count > 1);
  assert.equal(scrollPlan('bottom').key, 'C-End');
});
test('scrollPlan refuses anything else (no arbitrary keys, no prototype names)', () => {
  for (const d of ['', 'x', 'Enter', 'toString', '__proto__', undefined, null, 5]) assert.equal(scrollPlan(d), null);
});
test('the app scrolls only in the alternate screen with no tmux scrollback', () => {
  assert.equal(altScrollApplies({ alt: true, history: 0 }), true);
  assert.equal(altScrollApplies({ alt: true, history: 1857 }), false);
  assert.equal(altScrollApplies({ alt: false, history: 0 }), false);
  assert.equal(altScrollApplies({ alt: true, history: NaN }), true);
});
test('wheelPlan: n SGR wheel notches (64 up, 65 down) aimed at the upper third of the pane, capped; none for top / bottom', () => {
  const up = wheelPlan('up', 2, { cols: 80, rows: 30 });
  const bytes = Buffer.from(up.hex.join(''), 'hex').toString('latin1');
  assert.equal(bytes, '\x1b[<64;40;10M'.repeat(2));
  assert.equal(Buffer.from(wheelPlan('down', 1, { cols: 80, rows: 30 }).hex.join(''), 'hex').toString('latin1'), '\x1b[<65;40;10M');
  assert.equal(wheelPlan('up', 1e9).notches, MAX_NOTCHES);
  for (const n of [0, -3, 'x', undefined, NaN]) assert.equal(wheelPlan('up', n).notches, 1);
  for (const d of ['top', 'bottom', 'Enter', '__proto__']) assert.equal(wheelPlan(d, 3), null);
  assert.ok(wheelPlan('up', 3).hex.every((h) => /^[0-9a-f]{2}$/.test(h)), 'only hex byte arguments reach tmux');
});
