// Bug (chat 1792615165829-f41fbb): on phones there is no grid view, so the lock
// has nothing to pin against. Drop the lock and show the fullscreen / open
// button instead so the owner has a one-tap way into the focused card from
// any row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

// Find the body of the @media (max-width: 720px) block that contains the
// `.cell .h` rules (we have several phone media queries; the right one is the
// one near the top of the file with the card-row header simplification).
const mediaRe = /@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\n\}/g;
let blockBody = '';
for (const m of css.matchAll(mediaRe)) {
  if (m[1].includes('.cell .h .pr') && m[1].includes('.cell .h .rd')) { blockBody = m[1]; break; }
}
assert.ok(blockBody.length > 0, 'phone card-header simplification media query must be present');

test('the lock is hidden on phones', () => {
  assert.match(blockBody, /\.cell\s+\.h\s+\.lk[^{]*\{\s*display:\s*none/i,
    'expected a rule that hides .cell .h .lk on phones');
});

test('the fullscreen / open button stays visible inside the focused card on phones', () => {
  assert.match(blockBody, /\.card-pane\s+\.cell\s+\.h\s+\.open[^{]*\{\s*display:\s*inline-flex/i,
    'expected a rule that shows .card-pane .cell .h .open on phones');
});
