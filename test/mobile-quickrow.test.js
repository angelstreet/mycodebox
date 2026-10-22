// Phones: the second filter row (all / status / agent / project chips) is hidden (owner 2026-10-22: too much). The status dots in the top bar still filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('the quick filter row is display:none on phones and by default', () => {
  assert.match(css, /\n\.qrow\{\s*display:none;\s*\}/, 'default hidden');
  const i = css.indexOf('@media (max-width: 720px){\n  .qrow{');
  assert.ok(i >= 0, 'the phone rule exists');
  assert.match(css.slice(i, i + 80), /\.qrow\{\s*display:none;\s*\}/);
  assert.ok(!/\.qrow\{\s*display:flex/.test(css), 'nothing turns the row back on');
});
