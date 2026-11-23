import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { acceptsGzip, compressible, maybeGzip, MIN_BYTES } from '../gzip-send.js';

test('gzip: only text over the threshold, only when the browser accepts it, never a bigger result', async () => {
  assert.equal(acceptsGzip({ 'accept-encoding': 'gzip, deflate, br' }), true);
  assert.equal(acceptsGzip({ 'accept-encoding': 'identity' }), false);
  assert.equal(acceptsGzip({}), false);
  assert.equal(compressible('application/json', MIN_BYTES), true);
  assert.equal(compressible('text/javascript; charset=utf-8', 5000), true);
  assert.equal(compressible('image/png', 5000), false);
  assert.equal(compressible('application/vnd.android.package-archive', 9e6), false);
  assert.equal(compressible('application/json', MIN_BYTES - 1), false);
  const text = JSON.stringify({ text: 'the quick brown fox '.repeat(500) });
  const g = await maybeGzip({ 'accept-encoding': 'gzip' }, 'application/json', text);
  assert.equal(g.headers['content-encoding'], 'gzip'); assert.equal(g.headers.vary, 'accept-encoding');
  assert.ok(g.body.length < text.length / 5);
  assert.equal(gunzipSync(g.body).toString(), text);
  const plain = await maybeGzip({}, 'application/json', text);
  assert.deepEqual(plain.headers, {}); assert.equal(plain.body.toString(), text);
  const small = await maybeGzip({ 'accept-encoding': 'gzip' }, 'application/json', '{"ok":true}');
  assert.deepEqual(small.headers, {});
});
