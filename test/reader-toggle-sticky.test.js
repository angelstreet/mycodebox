// The reader's "last reply only" switch must stay clickable while a long conversation scrolls (owner 2026-11-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');
test('the reader mode switch is sticky at the top of the scrolling reader', () => {
  const rule = css.split('\n').find((l) => l.includes('.rd-more[data-act=less]'));
  assert.ok(rule, 'rule exists');
  assert.match(rule, /position:sticky/);
  assert.match(rule, /top:0/);
});
