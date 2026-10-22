// Touch scrolling of a card's terminal. xterm scrolls by touch in JS (viewport.scrollTop += delta on each touchmove). Two things killed
// that after the first row: the browser took the gesture over natively (pointercancel, no more touch events), and xterm's DOM renderer
// replaced the touched row span after the first scroll step, so the rest of the touch events went to a detached node. Both are CSS:
// the focused card's screen takes no native pan, and the rows are not hit-test targets (touches land on the stable .xterm-screen).
// Reproduced in a headless mobile browser: 1 row (17 px) per swipe before, the full 238 px after. Links are clicked by coordinates, not by target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const media = (() => {
  const i = css.indexOf('@media (max-width: 720px), (pointer: coarse){');
  assert.ok(i >= 0, 'the touch media block exists');
  let depth = 0, j = css.indexOf('{', i);
  for (let k = j; k < css.length; k++) { if (css[k] === '{') depth++; else if (css[k] === '}' && --depth === 0) return css.slice(j, k + 1); }
  throw new Error('unterminated media block');
})();

test('card terminal: no native pan over the focused card screen (touch events must keep reaching xterm)', () => {
  assert.match(media, /\.cell\.focus \.xterm-screen\s*\{[^}]*touch-action:\s*none/);
});

test('card terminal: the rows are not touch targets (xterm replaces the row spans mid-gesture)', () => {
  assert.match(media, /\.cell \.xterm-rows,\s*\.cell \.xterm-rows \*\s*\{[^}]*pointer-events:\s*none/);
});

test('the rules are touch-only: a desktop pointer keeps its rows interactive', () => {
  const outside = css.replace(media, '');
  assert.ok(!/\.xterm-rows[^{]*\{[^}]*pointer-events:\s*none/.test(outside), 'no unconditional pointer-events:none on the rows');
});
