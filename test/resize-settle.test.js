// A window drag must lay the terminal out once it settles, not on every resize event or status tick (owner 2026-11-24: flashing, text size jumping,
// about 25 full repaints in a 5 s drag). app.js touches the DOM, so the source is checked; the measured drag is in the release note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the card observer and the window resize go through settled(), not a per-frame relayout', () => {
  assert.match(src, /entry\.ro = new ResizeObserver\(settled\(\(\) => relayoutTerm\(session\)\)\)/);
  assert.match(src, /window\.addEventListener\('resize', settled\(/);
});

test('layoutTerm keeps the last layout while a drag is going on, but never blocks the first layout', () => {
  assert.match(src, /if \(entry\.laidOut && dragging\(\)\) return false;/);
  assert.match(src, /const dragging = \(\) => Date\.now\(\) - lastSizeEvent < SETTLE_MS;/);
});
