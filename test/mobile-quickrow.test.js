// The second filter row (all / status / agent / project chips): shown on the web, hidden on phones (owner 2026-10-22: too much on a small screen). The status dots in the top bar still filter there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('the quick filter row shows on the web and is display:none on phones', () => {
  assert.match(css, /\n\.qrow\{\s*display:flex;/, 'web: shown');
  assert.match(css, /@media \(max-width: 720px\)\{ \.qrow\{ display:none; \} \}/, 'phones: hidden');
  assert.ok(css.indexOf('\n.qrow{ display:flex') < css.indexOf('@media (max-width: 720px){ .qrow{ display:none; } }'), 'the phone rule comes after the web rule');
});

test('docked on the web, the chip row and the disk banner start right of the session list, like the other bars', () => {
  assert.match(css, /body\.side-docked > :is\([^)]*#quickRow[^)]*\)\{ margin-left:var\(--sidew\); \}/);
  assert.match(css, /body\.side-docked > :is\([^)]*#diskBanner[^)]*\)\{ margin-left:var\(--sidew\); \}/);
});
