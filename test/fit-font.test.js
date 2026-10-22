// A pane wider than the card shrinks the text until it fits (no cropped right edge, no sideways scroll), never below the floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitFont } from '../public/fit-font.js';

// columns that fit in a card `w` px wide at font f (a character is about 0.6 of the font size wide)
const colsAt = (w) => (f) => Math.floor(w / (f * 0.6));

test('fitFont: a pane that already fits keeps the chosen size', () => {
  assert.equal(fitFont({ cols: 50, base: 11, colsAt: colsAt(342) }), 11);
});

test('fitFont: the owner\'s phone (342 px card, 60-column minimum pane) shrinks until all 60 columns fit', () => {
  const f = fitFont({ cols: 60, base: 11, colsAt: colsAt(342) });
  assert.ok(f < 11 && f >= 8, `font ${f}`);
  assert.ok(colsAt(342)(f) >= 60, 'it fits');
  assert.ok(colsAt(342)(f + 0.5) < 60 || f === 11, 'and it is the largest half-point size that does');
});

test('fitFont: never below the floor, even for a very wide pane (it then scrolls, as before)', () => {
  assert.equal(fitFont({ cols: 188, base: 11, colsAt: colsAt(342) }), 8);
  assert.equal(fitFont({ cols: 188, base: 11, min: 9, colsAt: colsAt(342) }), 9);
});

test('card read-full-screen: the bars are hidden by body.reading, and the card header (with the button) is not', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = css.match(/body\.reading #topbar[^{]*\{[^}]*\}/);
  assert.ok(rule, 'a body.reading rule exists');
  for (const id of ['#topbar', '#health', '#alertRow', '#tabs', '#dock']) assert.ok(rule[0].includes(`body.reading ${id}`), `${id} hidden`);
  assert.ok(!/body\.reading[^{]*\.cell \.h|body\.reading[^{]*\.card-pane/.test(css), 'the card and its header stay');
});

import { canShrinkFont, isSettling } from '../public/fit-font.js';

test('canShrinkFont: not while our resize request is still on its way; yes once the server granted the pane width, or when we cannot resize', () => {
  assert.equal(canShrinkFont({ askable: true, granted: null, cols: 190 }), false, 'the pane is about to change width: no 8 px interim');
  assert.equal(canShrinkFont({ askable: true, granted: { cols: 60 }, cols: 60 }), true, 'the server could not go below 60: shrink to fit');
  assert.equal(canShrinkFont({ askable: true, granted: { cols: 53 }, cols: 190 }), false, 'the pane has not caught up with the grant yet');
  assert.equal(canShrinkFont({ askable: false, granted: null, cols: 190 }), true, 'attached or fit off: nothing will resize it, shrink');
});

test('isSettling: a card at the wrong width, or waiting for the repainted pane, stays hidden for at most 1.8 s', () => {
  assert.equal(isSettling({ askable: true, cols: 190, target: 111, ageMs: 300 }), true);
  assert.equal(isSettling({ askable: true, cols: 111, target: 111, ageMs: 300 }), false, 'already at the width');
  assert.equal(isSettling({ askable: true, cols: 110, target: 111, ageMs: 300 }), false, 'one column off is fine');
  assert.equal(isSettling({ askable: true, cols: 60, target: 60, awaitPane: true, ageMs: 300 }), true, 'granted, repaint pending');
  assert.equal(isSettling({ askable: true, cols: 190, target: 111, ageMs: 1800 }), false, 'never hidden longer than 1.8 s');
  assert.equal(isSettling({ askable: false, cols: 190, target: 111, ageMs: 100 }), false, 'a client that cannot resize shows what it has');
});
