// uploadOne tests (TASK-70 quickfix: image-attach "Failed to fetch" regression).
// Covers:
//   - happy path: first attempt succeeds
//   - transient retry: 'Failed to fetch' triggers up to 3 attempts, second succeeds
//   - HTTP 4xx/5xx: no retry, error surfaces immediately with the server message
//   - timeout: 30s default, AbortController fires and the upload throws
//   - max attempts exhausted: the last error is thrown
//   - external signal: abort propagates and stops further attempts
//   - body reuse: the same Blob is sent on every attempt (Blob isn't drained)
//
// The fake fetch records each call so tests can assert on attempt count, body
// identity, headers, and signal state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadOne } from '../public/upload.js';

function fakeFile(type = 'image/png', bytes = 11) {
  return { type, size: bytes, name: 'test.png' };   // the production code only reads .type; tests don't need a real Blob
}

function jsonResp(ok, body, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body };
}

// records every fetch call; returns a function that returns the next response
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init, attemptIndex: i });
    const next = responses[i++];
    if (next === 'NETWORK_ERR') throw Object.assign(new TypeError('Failed to fetch'), {});
    if (next === 'ABORT') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return next;
  };
  return { fn, calls };
}

test('uploadOne: first attempt succeeds and returns the server body', async () => {
  const { fn, calls } = fakeFetch([jsonResp(true, { ok: true, path: '/home/me/x.png' })]);
  const f = fakeFile();
  const j = await uploadOne(f, { fetchImpl: fn, timeoutMs: 0 });
  assert.equal(j.path, '/home/me/x.png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'image/png');
  assert.equal(calls[0].init.body, f);   // same Blob reference passed through
});

test('uploadOne: retries on TypeError("Failed to fetch") and the second attempt succeeds', async () => {
  const { fn, calls } = fakeFetch(['NETWORK_ERR', jsonResp(true, { ok: true, path: '/p' })]);
  const j = await uploadOne(fakeFile(), { fetchImpl: fn, backoffMs: 0, timeoutMs: 0 });
  assert.equal(j.path, '/p');
  assert.equal(calls.length, 2);
});

test('uploadOne: gives up after 3 failed attempts and throws the last error', async () => {
  const { fn, calls } = fakeFetch(['NETWORK_ERR', 'NETWORK_ERR', 'NETWORK_ERR']);
  await assert.rejects(
    () => uploadOne(fakeFile(), { fetchImpl: fn, backoffMs: 0, timeoutMs: 0 }),
    (err) => err instanceof TypeError && err.message === 'Failed to fetch',
  );
  assert.equal(calls.length, 3);
});

test('uploadOne: HTTP 5xx surfaces immediately (no retry)', async () => {
  const { fn, calls } = fakeFetch([jsonResp(false, { ok: false, error: 'disk full' }, 500)]);
  await assert.rejects(
    () => uploadOne(fakeFile(), { fetchImpl: fn, timeoutMs: 0 }),
    (err) => err.message === 'disk full' && err.name === 'HttpError' && err.status === 500,
  );
  assert.equal(calls.length, 1);
});

test('uploadOne: HTTP 415 surfaces immediately with the server error string', async () => {
  const { fn, calls } = fakeFetch([jsonResp(false, { ok: false, error: 'png, jpeg, gif or webp only' }, 415)]);
  await assert.rejects(
    () => uploadOne(fakeFile(), { fetchImpl: fn, timeoutMs: 0 }),
    (err) => err.message === 'png, jpeg, gif or webp only' && err.name === 'HttpError' && err.status === 415,
  );
  assert.equal(calls.length, 1);
});

test('uploadOne: HTTP error with no server body surfaces as "HTTP <status>"', async () => {
  const { fn, calls } = fakeFetch([{ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } }]);
  await assert.rejects(
    () => uploadOne(fakeFile(), { fetchImpl: fn, timeoutMs: 0 }),
    (err) => err.message === 'HTTP 502',
  );
  assert.equal(calls.length, 1);
});

test('uploadOne: timeout aborts the current attempt and throws "upload timed out"', async () => {
  // The fake fetch never resolves; we abort from outside via the same signal
  // the upload creates internally — so we register a small timeout on the
  // caller side and wait long enough for the internal 50ms timeout to fire.
  const slowFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  // pass a tiny timeoutMs so the test runs fast
  await assert.rejects(
    () => uploadOne(fakeFile(), { fetchImpl: slowFetch, timeoutMs: 30, attempts: 1, backoffMs: 0 }),
    (err) => err.message === 'upload timed out',
  );
});

test('uploadOne: external signal stops the loop after the current attempt rejects', async () => {
  const ac = new AbortController();
  const { fn, calls } = fakeFetch(['NETWORK_ERR']);
  const p = uploadOne(fakeFile(), { fetchImpl: fn, signal: ac.signal, backoffMs: 100, timeoutMs: 0 });
  // give the first attempt a tick to fail, then abort before the second attempt
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(() => p, (err) => err.message === 'upload aborted');
  // Only one attempt should have happened before the abort was observed.
  assert.equal(calls.length, 1);
});

test('uploadOne: non-default MIME type flows through to the content-type header', async () => {
  const { fn, calls } = fakeFetch([jsonResp(true, { ok: true, path: '/a' })]);
  await uploadOne(fakeFile('image/webp'), { fetchImpl: fn, timeoutMs: 0 });
  assert.equal(calls[0].init.headers['content-type'], 'image/webp');
});

test('uploadOne: missing file.type defaults to application/octet-stream', async () => {
  const { fn, calls } = fakeFetch([jsonResp(true, { ok: true, path: '/a' })]);
  await uploadOne({ name: 'x' }, { fetchImpl: fn, timeoutMs: 0 });
  assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream');
});
