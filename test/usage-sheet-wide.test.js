// The Usage & cost page is wide and centered, and its name cells cannot overlap the token columns (owner 2026-11-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');
test('uv-sheet is wide and centered', () => {
  const rule = css.split('\n').find((l) => l.startsWith('.sheet.uv-sheet'));
  assert.ok(rule);
  assert.match(rule, /1180px/);
  assert.match(rule, /margin-left:auto/);
});
test('the plan label inside the name cell shrinks with an ellipsis', () => {
  const rule = css.split('\n').find((l) => l.startsWith('.uv-name .dim'));
  assert.match(rule, /text-overflow:ellipsis/);
  assert.match(rule, /min-width:0/);
});
