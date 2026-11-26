// The second filter row (all / status / agent / project chips): shown on the web, hidden on phones (owner 2026-10-22: too much on a small screen). The status dots in the top bar still filter there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function shownSessions(names, { hidden = [], status = [], task = true } = {}) {
  const state = {
    sessions: names.map((name) => ({ name })), layout: { hidden },
    fTask: task, filter: status, fProject: [], fAgent: [],
  };
  const logic = app.slice(app.indexOf('function isTaskSession('), app.indexOf('// ---------- data ----------'));
  return [...runInNewContext(`${logic}\nvisibleSessions().map(({ name }) => name)`, {
    state, displayName: (name) => name, filterStateOf: () => 'working',
  })];
}

test('the Tasks preference applies only when an unhidden task is available', () => {
  const names = ['example', 'TASK-demo'];
  assert.deepEqual(shownSessions(['example']), ['example']);
  assert.deepEqual(shownSessions(names, { hidden: ['TASK-demo'] }), ['example']);
  assert.deepEqual(shownSessions(names), ['TASK-demo']);
  assert.deepEqual(shownSessions(names, { task: false }), names);
  assert.deepEqual(shownSessions(['example'], { status: ['done'] }), []);
});

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
  const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\(\?:\^\|\[-_\]\)task\\d\+\/i\.test\(n\)\) \{ btn\.classList\.add\('hidden'\)/);   // no longer limited to taskNN names
  assert.match(app, /n\.startsWith\('mac:'\)\) \{ btn\.classList\.add\('hidden'\)/);
  assert.match(srv, /const m = \/\(\?:\^\|\[-_\]\)task0\*\(\\d\+\)\/i\.exec\(session\)/);
});
