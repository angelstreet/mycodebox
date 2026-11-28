// The reader's mode switch also lives under the composer, left of the provider/model label (owner 2026-11-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(root, 'app.js'), 'utf8'), css = readFileSync(join(root, 'style.css'), 'utf8');
test('the dock model line carries the reader switch before the provider label and wires it to switchReaderMode', () => {
  assert.match(app, /const html = PROVIDER_LABEL\[a\] \? `\$\{sw\}<span class="dp/);
  assert.match(app, /dk\.dmodel\.onclick = .*switchReaderMode\(b\.dataset\.n, b\.dataset\.act\)/);
  assert.match(app, /async function switchReaderMode\(n, act\)/);
  assert.match(css, /\.dock \.dmodel \.rd-mode\{[^}]*margin-right:auto/);
});
