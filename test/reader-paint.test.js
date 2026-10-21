// Tests for the pure helper that decides what paintReader() should do with a
// fresh html payload. Bug 1792615055496-11750f: the reader was flashing on
// every status tick because it rebuilt innerHTML under the user's thumb when
// they had scrolled up to read. The helper keeps the rebuild, but only swaps
// when the user is at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReaderPaint } from '../public/reader-paint.js';

test('no html change -> skip', () => {
  assert.deepEqual(
    decideReaderPaint({ scrollTop: 100, scrollHeight: 800, clientHeight: 400, isFirst: false, htmlChanged: false }),
    { action: 'skip' },
  );
});

test('first paint -> rebuild and jump to bottom', () => {
  assert.deepEqual(
    decideReaderPaint({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, isFirst: true, htmlChanged: true }),
    { action: 'rebuild', scroll: 'bottom' },
  );
});

test('user at the bottom on a returning rebuild -> bottom', () => {
  // scrollHeight 1000, clientHeight 400, scrollTop 600 -> 1000 - 600 - 400 = 0 (atBottom)
  assert.deepEqual(
    decideReaderPaint({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true }),
    { action: 'rebuild', scroll: 'bottom' },
  );
});

test('user at the bottom within 24px slack -> still bottom', () => {
  // 1000 - 580 - 400 = 20 (under 24)
  assert.deepEqual(
    decideReaderPaint({ scrollTop: 580, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true }),
    { action: 'rebuild', scroll: 'bottom' },
  );
});

test('user scrolled up away from bottom -> defer so they keep reading what is on screen', () => {
  // user has scrolled to read; we must NOT swap content under their thumb.
  const d = decideReaderPaint({ scrollTop: 250, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true });
  assert.deepEqual(d, { action: 'defer' });
});

test('user idle at the very top of a long body -> defer', () => {
  const d = decideReaderPaint({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true });
  assert.deepEqual(d, { action: 'defer' });
});

test('mid-touch (busy) -> defer past the touch window', () => {
  const now = 1_000_000;
  const d = decideReaderPaint({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true, busyUntil: now + 1200, now });
  assert.equal(d.action, 'defer');
  assert.equal(d.until, now + 1200);
});

test('busy window expired -> run the normal decision', () => {
  const now = 1_000_000;
  const d = decideReaderPaint({ scrollTop: 250, scrollHeight: 1000, clientHeight: 400, isFirst: false, htmlChanged: true, busyUntil: now - 1, now });
  // not at the bottom, so defer
  assert.deepEqual(d, { action: 'defer' });
});
