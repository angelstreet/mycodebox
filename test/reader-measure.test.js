// Desktop reader: the reading column is centred by side padding on .reader itself (.cell.rd-on .reader). The wide-window rule that caps
// boxes at --measure must not list .reader as well: the text was centred twice, in a column of ~170-430 px on a wide window (reproduced at
// 1515 and 1920 px: text width 433 / 28 px; with the fix 820 px).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('the wide-window --measure cap does not include the reader (it pads itself to the measure)', () => {
  const i = css.indexOf('@media (min-width: 1100px){\n');
  assert.ok(i >= 0, 'the wide-window block exists');
  const rule = css.slice(i, css.indexOf('}', css.indexOf('max-width:var(--measure)', i)) + 1);
  assert.ok(rule.includes('.view-card .card-pane .cell > .b'), 'the terminal host is still capped');
  assert.ok(!/cell > \.reader/.test(rule), '.reader is not capped');
});

test('the reader pads itself to the measure', () => {
  assert.match(css, /\.cell\.rd-on \.reader\{[^}]*padding:12px max\(14px, calc\(\(100% - var\(--measure\)\) \/ 2\)\) 16px/);
});
