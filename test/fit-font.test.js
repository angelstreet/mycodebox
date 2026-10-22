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
