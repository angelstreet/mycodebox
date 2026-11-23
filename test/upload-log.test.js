import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientOf, logUpload, readUploadLog, cleanReport, MAX_LINES } from '../upload-log.js';
import { uploadOne, reportUploadFailure } from '../public/upload.js';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

test('clientOf: browser and system, enough to tell the Mac from the phone app', () => {
  assert.equal(clientOf(MAC), 'Chrome 142 · Mac');
  assert.equal(clientOf(PHONE), 'Chrome 141 · Android');
  assert.equal(clientOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Safari 18 · Mac');
  assert.equal(clientOf(''), '? · ?');
});

test('the ledger: appended, read newest last, trimmed to MAX_LINES, a torn line skipped', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'upload-log-')), 'uploads.jsonl');
  assert.deepEqual(readUploadLog(f), [], 'no file yet');
  for (let i = 0; i < 3; i++) logUpload(f, { side: 'server', ok: i !== 1, status: i === 1 ? 415 : 200, name: `f${i}.png` });
  assert.deepEqual(readUploadLog(f, 2).map((r) => r.name), ['f1.png', 'f2.png']);
  assert.ok(readUploadLog(f)[0].t);
  writeFileSync(f, readFileSync(f, 'utf8') + '{"torn":');
  assert.equal(readUploadLog(f).length, 3);
  const big = 'x'.repeat(2000);
  for (let i = 0; i < MAX_LINES + 200; i++) logUpload(f, { n: i, pad: big });
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= MAX_LINES + 130, `trimmed (${lines.length})`);
  assert.equal(JSON.parse(lines.at(-1)).n, MAX_LINES + 199, 'the newest line is kept');
});

test('cleanReport keeps only known fields, short, one line', () => {
  const r = cleanReport({ name: 'a\nb.png', type: 'image/heic', error: 'x'.repeat(999), bytes: '2048', online: false, evil: 'drop me', status: 'nope' }, MAC);
  assert.equal(r.side, 'client'); assert.equal(r.client, 'Chrome 142 · Mac'); assert.equal(r.name, 'a b.png');
  assert.equal(r.error.length, 200); assert.equal(r.bytes, 2048); assert.equal(r.online, false); assert.equal(r.status, undefined); assert.equal('evil' in r, false);
});

test('uploadOne: a failure is reported once to /api/upload-report; a server refusal carries its status; the test hook injects its own fetch', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { seen.push([u, o?.body && typeof o.body === 'string' ? JSON.parse(o.body) : null]); if (u === '/api/upload') throw new TypeError('Failed to fetch'); return { ok: true, json: async () => ({}) }; };
  try {
    await assert.rejects(uploadOne({ name: 'shot.png', type: 'image/png', size: 5000 }, { backoffMs: 1 }), /Failed to fetch/);
    await new Promise((r) => setTimeout(r, 20));
    const rep = seen.filter(([u]) => u === '/api/upload-report');
    assert.equal(seen.filter(([u]) => u === '/api/upload').length, 3, 'three tries');
    assert.equal(rep.length, 1);
    assert.equal(rep[0][1].name, 'shot.png'); assert.equal(rep[0][1].attempts, 3); assert.match(rep[0][1].error, /Failed to fetch/);
    seen.length = 0;
    await assert.rejects(uploadOne({ name: 'x.png', type: 'image/png', size: 1 }, { fetchImpl: async () => { throw new TypeError('no'); }, attempts: 1 }), /no/);
    assert.equal(seen.length, 0, 'an injected fetch (tests) reports nothing');
  } finally { globalThis.fetch = realFetch; }
});
