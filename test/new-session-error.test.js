import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRefusal } from '../public/new-session-error.js';
import { createDiskGuard } from '../disk-guard.js';

test('a full disk shows the disk guard\'s own message, never "already exists"', async () => {
  const guard = createDiskGuard({ configFile: '/nonexistent', env: {}, defaultPaths: ['/'], statfsImpl: async () => ({ bsize: 1, blocks: 100, bfree: 8, bavail: 8 }) });
  const err = await guard.assertStart('Starting a new session').then(() => null, (e) => e);
  assert.equal(err.status, 409);
  const toast = createRefusal(err.status, { ok: false, error: err.message, reason: err.reason }, 'fullscreen-pc2');
  assert.equal(toast, err.message);
  assert.doesNotMatch(toast, /already exists/);
});

test('only a taken name reads "already exists"; other answers keep their reason', () => {
  assert.equal(createRefusal(409, { ok: false, error: 'session already exists' }, 'a'), '"a" already exists');
  assert.equal(createRefusal(409, { ok: false, error: 'duplicate session: a' }, 'a'), '"a" already exists');
  assert.equal(createRefusal(409, { ok: false, error: 'something else' }, 'a'), 'create failed: something else');
  assert.equal(createRefusal(409, {}, 'a'), 'create refused (HTTP 409)');
  assert.equal(createRefusal(409, { reason: 'disk_low' }, 'a'), 'the disk is almost full: new sessions are paused');
  assert.equal(createRefusal(500, {}, 'a'), 'create failed: HTTP 500');
  assert.equal(createRefusal(200, { ok: true }, 'a'), null);
});

test('static: the new-session dialog uses it', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /createRefusal\(r\.status, j, name\)/);
  assert.doesNotMatch(app, /r\.status === 409\) \{ toast/);
});
