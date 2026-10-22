// Owner, 2026-10-22 (chat 1792667002291 / 1792667041426): on a wide browser the
// card text ran the full window width - 200+ character lines on a 2988px monitor.
// "in webbrwser only we need to restraiin the widh of the text content for
// reeadability in fact it should be like in virtualpytest or codex or claude ...
// they dont use the full area".
//
// The reader already capped its column at 820px through padding; the terminal body
// and the task-document view had no cap at all. This asserts one shared measure
// drives all three, so they cannot drift apart again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

// pull every @media block body out so we can assert on the wide-screen rules
const blocks = (feature) =>
  [...css.matchAll(new RegExp(`@media\\s*\\(\\s*${feature.replace(/[()]/g, '\\$&')}\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))]
    .map((m) => m[1]).join('\n');

const wide = blocks('min-width: 1100px');

test('a wide browser caps the card text to a reading column', () => {
  assert.ok(wide.length, 'the wide-screen media query must exist');
  assert.match(wide, /\.view-card[^{]*\.cell[^{]*>\s*\.b[^{]*\{[^}]*max-width:\s*var\(--measure\)/i,
    'the terminal body must be capped on a wide screen');
  assert.match(wide, /\.view-card[^{]*\.cell[^{]*>\s*\.docview[^{]*\{[^}]*max-width:\s*var\(--measure\)/i,
    'the task-document view must be capped on a wide screen');
});

test('the reading column is centred, not left-aligned', () => {
  assert.match(wide, /margin-inline:\s*auto/i, 'the capped column must be centred');
});

test('the reader uses the same measure as the terminal', () => {
  const reader = css.match(/\.cell\.rd-on \.reader\{([\s\S]*?)\n\}/);
  assert.ok(reader, 'the reader base rule must exist');
  assert.match(reader[1], /calc\(\(100%\s*-\s*var\(--measure\)\)\s*\/\s*2\)/i,
    'the reader must centre against the shared measure, not a hard-coded 820px');
});

test('the measure is a single tunable value', () => {
  assert.match(css, /--measure:\s*\d+px/i, '--measure must be defined once as a px width');
});

test('the jump cluster follows the column instead of drifting to the far edge', () => {
  assert.match(wide, /\.view-card[^{]*\.jump[^{]*\{[^}]*right:\s*max\(/i,
    '.jump is absolutely positioned on the card; it must track the column edge on a wide screen');
});

test('phones and grid cards are untouched', () => {
  const phone = blocks('max-width: 720px');
  assert.ok(!/\.view-card[^\n{]*>\s*\.b[^\n{]*\{[^\n}]*max-width:\s*var\(--measure\)/i.test(phone),
    'the cap must not be applied on phones, where the card is already narrow');
});