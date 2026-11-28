// The dashboard's /ws/status socket backs off while the server is away (owner triage 2026-11-28): it retried every 2 s forever,
// 30 attempts a minute per open dashboard during a restart. Checked from the app.js source (it runs in the browser only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('status socket: growing retry delay, capped, reset once connected', () => {
  const src = /function statusRetryDelay\(tries\) \{[^\n]*\}/.exec(app)?.[0];
  assert.ok(src, 'statusRetryDelay is defined');
  const delay = new Function(`${src}; return statusRetryDelay;`)();
  assert.deepEqual([1, 2, 3, 4].map((n) => Math.round(delay(n))), [1000, 1600, 2560, 4096]);
  assert.equal(delay(50), 15000);
  const body = app.slice(app.indexOf('function connectStatus()'), app.indexOf('// ---------- server event hooks'));
  assert.match(body, /ws\.onopen = \(\) => \{ state\.statusTries = 0; \}/);
  assert.match(body, /setTimeout\(connectStatus, statusRetryDelay\(state\.statusTries = \(state\.statusTries \|\| 0\) \+ 1\)\)/);
  assert.doesNotMatch(body, /setTimeout\(connectStatus, 2000\)/);
});
