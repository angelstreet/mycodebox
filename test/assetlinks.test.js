import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssetlinks, loadAssetlinks, publicLinks } from '../assetlinks.js';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP2 = Array(32).fill('AB').join(':');
const PKG = 'test.example.app';

test('assetlinks: unset env builds nothing', () => assert.equal(buildAssetlinks({}), null));

test('assetlinks: env builds the statement, several fingerprints allowed, lowercase normalised', () => {
  const r = buildAssetlinks({ ANDROID_APP_PACKAGE: PKG, ANDROID_APP_SHA256: `${FP}, ${FP2.toLowerCase()}` });
  const j = JSON.parse(r.json);
  assert.equal(j[0].target.package_name, PKG);
  assert.deepEqual(j[0].target.sha256_cert_fingerprints, [FP, FP2]);
  assert.equal(j[0].target.namespace, 'android_app');
});

test('assetlinks: invalid or half-set values are refused', () => {
  for (const env of [
    { ANDROID_APP_PACKAGE: PKG },
    { ANDROID_APP_SHA256: FP },
    { ANDROID_APP_PACKAGE: 'bad package', ANDROID_APP_SHA256: FP },
    { ANDROID_APP_PACKAGE: 'nodots', ANDROID_APP_SHA256: FP },
    { ANDROID_APP_PACKAGE: PKG, ANDROID_APP_SHA256: 'AB:CD' },
    { ANDROID_APP_PACKAGE: PKG, ANDROID_APP_SHA256: `${FP},nope` },
  ]) assert.ok(buildAssetlinks(env).error, JSON.stringify(env));
});

test('assetlinks: state-dir file is served verbatim; env wins; bad file or none -> error/null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-al-'));
  assert.equal(await loadAssetlinks({}, dir), null);
  writeFileSync(join(dir, 'assetlinks.json'), '[ {"x": 1} ]\n');
  assert.equal((await loadAssetlinks({}, dir)).json, '[ {"x": 1} ]\n');
  const env = { ANDROID_APP_PACKAGE: PKG, ANDROID_APP_SHA256: FP };
  assert.equal(JSON.parse((await loadAssetlinks(env, dir)).json)[0].target.package_name, PKG);
  assert.ok((await loadAssetlinks({ ANDROID_APP_PACKAGE: 'x' }, dir)).error);   // invalid env is not masked by the file
  writeFileSync(join(dir, 'assetlinks.json'), 'not json');
  assert.ok((await loadAssetlinks({}, dir)).error);
  rmSync(join(dir, 'assetlinks.json')); mkdirSync(join(dir, 'assetlinks.json'));   // unreadable (EISDIR): warn, not silent 404
  assert.match((await loadAssetlinks({}, dir)).error, /unreadable/);
});

test('publicLinks: langfuse from LANGFUSE_PUBLIC_URL, else non-loopback LANGFUSE_URL, else null', () => {
  assert.deepEqual(publicLinks({}), { langfuse: null, publicUrl: null });
  assert.equal(publicLinks({ LANGFUSE_PUBLIC_URL: 'https://lf.example.test/' }).langfuse, 'https://lf.example.test');
  assert.equal(publicLinks({ LANGFUSE_URL: 'http://127.0.0.1:3100' }).langfuse, null);
  assert.equal(publicLinks({ LANGFUSE_URL: 'http://localhost:3100' }).langfuse, null);
  for (const h of ['[::]', '[::1]', '[::ffff:7f00:1]', 'localhost.', 'lf.localhost', '0.0.0.0', '0177.0.0.1']) {
    assert.equal(publicLinks({ LANGFUSE_URL: `http://${h}:3100` }).langfuse, null, h);
  }
  assert.equal(publicLinks({ LANGFUSE_URL: 'http://lf.example.test:3100' }).langfuse, 'http://lf.example.test:3100');
  assert.equal(publicLinks({ LANGFUSE_URL: 'http://127.0.0.1:3100', LANGFUSE_PUBLIC_URL: 'https://lf.example.test' }).langfuse, 'https://lf.example.test');
  assert.equal(publicLinks({ LANGFUSE_PUBLIC_URL: 'javascript:alert(1)' }).langfuse, null);
});

test('publicLinks: PUBLIC_URL only when https', () => {
  assert.equal(publicLinks({ PUBLIC_URL: 'https://box.example.test/' }).publicUrl, 'https://box.example.test');
  assert.equal(publicLinks({ PUBLIC_URL: 'http://box.example.test' }).publicUrl, null);
  assert.equal(publicLinks({ PUBLIC_URL: 'garbage' }).publicUrl, null);
});
