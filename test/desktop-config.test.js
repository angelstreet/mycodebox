import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { parseServerUrl, sameOrigin, loadConfig, saveConfig, sanitizeBounds } =
  createRequire(import.meta.url)('../desktop/lib/config.cjs');

test('parseServerUrl normalises and validates', () => {
  assert.deepEqual(parseServerUrl('https://box.example.ts.net:7443/some/path?x=1'),
    { url: 'https://box.example.ts.net:7443/', origin: 'https://box.example.ts.net:7443', host: 'box.example.ts.net:7443' });
  assert.equal(parseServerUrl('  box.example:7443 ').url, 'https://box.example:7443/');
  assert.equal(parseServerUrl('http://192.0.2.1:7777').url, 'http://192.0.2.1:7777/');
  for (const bad of ['', '   ', null, undefined, 'ftp://x', 'javascript:alert(1)', 'https://u:p@host', 'https://']) {
    assert.equal(parseServerUrl(bad), null, String(bad));
  }
});

test('sameOrigin is exact on scheme, host and port', () => {
  const s = 'https://box.example:7443/';
  assert.equal(sameOrigin('https://box.example:7443/api/x', s), true);
  assert.equal(sameOrigin('https://box.example:7444/', s), false);
  assert.equal(sameOrigin('http://box.example:7443/', s), false);
  assert.equal(sameOrigin('https://evil.example/', s), false);
  assert.equal(sameOrigin('garbage', s), false);
  assert.equal(sameOrigin('https://box.example:7443/', undefined), false);
});

test('config round-trips and tolerates missing or corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cfg-'));
  const file = path.join(dir, 'sub', 'config.json');
  assert.deepEqual(loadConfig(file), {});
  saveConfig(file, { serverUrl: 'https://box.example:7443/', bounds: { width: 900, height: 700 } });
  assert.equal(loadConfig(file).serverUrl, 'https://box.example:7443/');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadConfig(file), {});
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(loadConfig(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeBounds falls back to defaults on junk', () => {
  assert.deepEqual(sanitizeBounds(undefined), { width: 1280, height: 860 });
  assert.deepEqual(sanitizeBounds({ width: 10, height: 10, x: 5, y: 6 }), { width: 1280, height: 860, x: 5, y: 6 });
  assert.deepEqual(sanitizeBounds({ width: 900.4, height: 700, x: 'a', y: 1 }), { width: 900, height: 700 });
});
