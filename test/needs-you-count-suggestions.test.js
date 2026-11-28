// The NEEDS YOU headline counts sessions and manager questions only; the parked-suggestions chip is quiet (owner 2026-11-27) and
// must not add 1 (owner 2026-11-28: "needs you shows 1 when should show 0").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

test('renderAttention total does not count the suggestions chip', () => {
  const m = app.match(/const total = ([^;\n]+);/g).find((l) => l.includes('mgrAsks'));
  assert.ok(m, 'total line found');
  assert.doesNotMatch(m, /parked/);
  assert.match(app, /parkedChipHtml\(parked\)/);   // the chip itself is still drawn
});

test('a count of 0 does not hide the strip that holds the suggestions chip (desktop)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.alertrow \.attention\.none:not\(:has\(\[data-parked\]\)\)\{ display:none; \}/);
  assert.doesNotMatch(css, /\.alertrow \.attention\.none\{ display:none; \}/);
});
