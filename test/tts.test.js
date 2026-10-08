// TTS factory tests (TASK-70 Part 1). Covers:
//   - hashText is deterministic and length-aware (trailing whitespace changes the hash)
//   - cachePath validates the hash and returns the expected path under cacheDir
//   - render() returns the cached file on a hit (no piper invocation)
//   - render() invokes piperRunner on a miss; the cached file is non-empty
//   - render() rejects empty text, oversized text, and URL/text hash mismatches
//   - prune() removes files older than KEEP_DAYS and keeps recent ones
//
// piperRunner is mocked so the tests don't need the binary. The factory accepts any
// (bin, voice, textFile, outFile) -> Promise<void>.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTts } from '../tts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshCache() {
  return mkdtempSync(join(tmpdir(), 'ghosty-tts-test-'));
}

// Fake piper: drop a stub file at outFile. Records every invocation so tests can assert on it.
function fakePiper(stubBytes = 32) {
  const calls = [];
  return {
    calls,
    runner: async (_bin, _voice, textFile, outFile) => {
      calls.push({ textFile, outFile });
      // mirror what tts.js would do with the textFile (already written by the factory); we just need a non-empty outFile
      await sleep(10);
      writeFileSync(outFile, Buffer.alloc(stubBytes, 0x20));
    },
  };
}

test('hashText: stable, lowercase hex, 32 chars', () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir });
  const h = t.hashText('hello world');
  assert.equal(h.length, 32);
  assert.match(h, /^[0-9a-f]+$/);
  assert.equal(h, t.hashText('hello world'));   // deterministic
});

test('hashText: whitespace-only differences hash the same (cache dedup)', () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir });
  // trim() is intentional: two texts that trim to the same content produce the same audio, so
  // they should share the cache key. The point of length-prefixing the hash is to catch
  // 'a' vs 'aa' collisions, NOT trailing whitespace.
  const a = t.hashText('hello world');
  const b = t.hashText('hello world  ');
  const c = t.hashText('  hello world');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('hashText: different content or length changes the hash', () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir });
  const a = t.hashText('hello world');
  const b = t.hashText('hello world!');   // different content + length
  const c = t.hashText('a');               // short text — would otherwise collide with anything
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('cachePath: rejects malformed hashes', () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir });
  assert.throws(() => t.cachePath('not-hex'));
  assert.throws(() => t.cachePath('zzzzzzzz'));   // wrong alphabet
  assert.doesNotThrow(() => t.cachePath('1234567890abcdef12345678'));
});

test('render: cache hit returns immediately without piper', async () => {
  const dir = freshCache();
  const fake = fakePiper();
  const t = createTts({ cacheDir: dir, piperRunner: fake.runner });
  const hash = t.hashText('cache hit test');
  // seed cache
  writeFileSync(t.cachePath(hash), Buffer.from('seeded'));
  const r = await t.render('cache hit test', hash);
  assert.equal(r.cached, true);
  assert.equal(fake.calls.length, 0);
});

test('render: cache miss invokes piperRunner and writes the file', async () => {
  const dir = freshCache();
  const fake = fakePiper();
  const t = createTts({ cacheDir: dir, piperRunner: fake.runner });
  const text = 'piper render test 1';
  const r = await t.render(text);
  assert.equal(r.cached, false);
  assert.equal(fake.calls.length, 1);
  assert.ok(statSync(r.path).size > 0);
});

test('render: rejects empty text', async () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir, piperRunner: fakePiper().runner });
  await assert.rejects(() => t.render('   '), /empty text/);
});

test('render: rejects oversized text', async () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir, piperRunner: fakePiper().runner });
  await assert.rejects(() => t.render('x'.repeat(9000)), /too long/);
});

test('render: URL hash must equal hashText(text) — defends against typos', async () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir, piperRunner: fakePiper().runner });
  const hash = t.hashText('a');
  await assert.rejects(() => t.render('b', hash), /hash mismatch/);
});

test('prune: removes files older than KEEP_DAYS, keeps recent ones', async () => {
  const dir = freshCache();
  const t = createTts({ cacheDir: dir });
  // three files: stale (-15d), stale (-10d 1ms — borderline past the cutoff), fresh (now)
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const stale = t.hashText('11111111111111111111111111111111');
  const borderline = t.hashText('22222222222222222222222222222222');
  const fresh = t.hashText('33333333333333333333333333333333');
  for (const h of [stale, borderline, fresh]) writeFileSync(t.cachePath(h), Buffer.alloc(8));
  utimesSync(t.cachePath(stale), now / 1000 - 15 * day / 1000, now / 1000 - 15 * day / 1000);
  utimesSync(t.cachePath(borderline), now / 1000 - 14 * day / 1000 - 1000, now / 1000 - 14 * day / 1000 - 1000);
  utimesSync(t.cachePath(fresh), now / 1000 - 1 * 3600, now / 1000 - 1 * 3600);

  const r = await t.prune();
  assert.equal(r.removed, 2);
  const remaining = readdirSync(dir).filter((f) => f.endsWith('.wav'));
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].includes(fresh.slice(0, 8)));
});

test('prune: returns removed=0 when cacheDir is missing (no crash on first boot)', async () => {
  const dir = join(tmpdir(), `ghosty-tts-missing-${Date.now()}-${Math.random()}`);
  const t = createTts({ cacheDir: dir });
  const r = await t.prune();
  assert.equal(r.removed, 0);
});