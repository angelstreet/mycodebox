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

test('the MD button: any session in the card (it may have written its own task doc), a prefixed task name (mm-task168) on the server', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\(\?:\^\|\[-_\]\)task\\d\+\/i\.test\(n\)\) \{ btn\.classList\.add\('hidden'\)/);   // no longer limited to taskNN names
  assert.match(app, /n\.startsWith\('mac:'\)\) \{ btn\.classList\.add\('hidden'\)/);
  assert.match(srv, /const m = \/\(\?:\^\|\[-_\]\)task0\*\(\\d\+\)\/i\.exec\(session\)/);
});
