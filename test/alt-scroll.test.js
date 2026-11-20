import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollPlan, altScrollApplies } from '../alt-scroll.js';

test('scrollPlan maps the four directions to PageUp / PageDown', () => {
  assert.deepEqual(scrollPlan('up'), { key: 'PageUp', count: 1 });
  assert.deepEqual(scrollPlan('down'), { key: 'PageDown', count: 1 });
  assert.equal(scrollPlan('top').key, 'PageUp');
  assert.ok(scrollPlan('top').count > 1);
  assert.equal(scrollPlan('bottom').key, 'PageDown');
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
