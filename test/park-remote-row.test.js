// Park on a `mac:` row removes it (owner 2026-11-25: "Can't park mac:...: invalid session name" left the row listed): server route + client list drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the park route answers a mac: name by dropping the row, before the tmux name check', () => {
  const i = server.indexOf("name.startsWith('mac:')) { const had = remote.drop(name)");
  assert.ok(i > 0);
  assert.ok(i < server.indexOf('await parkSession(name, { force })'));
});

test('the client drops a row the server calls an invalid session name, like "no such session"', () => {
  assert.match(app, /no such session\|invalid session name/);
  assert.match(app, /removed from the list/);
});
