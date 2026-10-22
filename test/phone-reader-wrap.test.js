// Bug 1792614614185-0c230c: on a phone the reader forced horizontal scrolling —
// 'i should be able to read without scrolling horizontal'. The reader's code
// block was `white-space:pre; overflow-x:auto`, so any reply with a fenced code
// block, a long inline `code` span, or a wide table pushed the text sideways and
// the owner had to swipe the paragraph to read the end of a line.
//
// These are static CSS assertions on public/style.css: the fix is a stylesheet
// rule, and asserting the rule keeps the intent readable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

// Grab every @media (max-width: 720px) block body.
const phoneBlocks = [...css.matchAll(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
const phoneCss = phoneBlocks.join('\n');
assert.ok(phoneBlocks.length, 'the phone media query must exist');

test('on a phone a reader code block wraps instead of scrolling sideways', () => {
  const rules = phoneCss.match(/\.reader\s+pre[^{]*\{[^}]*\}/gi) || [];
  assert.ok(rules.length, 'a .reader pre override for phones must exist');
  const combined = rules.join(' ');
  assert.match(combined, /white-space:\s*pre-wrap/i, 'code block must wrap on a phone');
  assert.match(combined, /overflow-wrap:\s*(anywhere|break-word)/i, 'long tokens must break, not overflow');
});

test('on a phone inline code breaks long paths instead of widening the column', () => {
  const rules = phoneCss.match(/\.reader\s+code[^{]*\{[^}]*\}/gi) || [];
  assert.ok(rules.length, 'a .reader code override for phones must exist');
  assert.match(rules.join(' '), /overflow-wrap:\s*(anywhere|break-word)/i);
});

test('the desktop reader code block keeps its horizontal scroll', () => {
  // Wide code is genuinely easier to read with a scrollbar on a big screen, so
  // only the phone gets wrapping. Guard against "fixing" it globally.
  const base = css.match(/^\.reader pre\{([\s\S]*?)\}/m);
  assert.ok(base, 'the base .reader pre rule must still exist');
  assert.match(base[1], /white-space:\s*pre\b/i);
  assert.match(base[1], /overflow-x:\s*auto/i);
});