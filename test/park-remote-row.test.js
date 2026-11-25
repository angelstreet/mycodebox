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

test('the X on a Parked row posts JSON (the server refuses a POST without a JSON content-type)', () => {
  const i = app.indexOf('/forget-parked`');
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 160), /'content-type': 'application\/json'/);
});

test('Parked lists only the idlest live candidates: as many as are over the limit, none idle under 10 min, none pinned', () => {
  assert.match(app, /idleMin \?\? 0\) >= 10 && !state\.layout\.pins\.includes\(c\.name\)\)\.slice\(0, pk\.over\)/);
});
