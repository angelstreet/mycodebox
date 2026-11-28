// The reader's two fetches (reply, transcript) must carry a deadline: a request stalled on a relayed link otherwise keeps `busy` set for good
// and the reader stays on "no reply yet" (owner 2026-11-23). app.js is not importable (it touches the DOM), so the source is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('reply and transcript go through getJson with an abort deadline', () => {
  assert.match(src, /function getJson\(url, ms, signal = null\)[\s\S]{0,200}ac\.abort\(\)/);
  assert.match(src, /getJson\(`\/api\/reply\//);
  assert.match(src, /getJson\(`\/api\/transcript\//);
  assert.doesNotMatch(src, /fetch\(`\/api\/(reply|transcript)\//);
});

test('an outstanding or failed load is not reported as "no reply yet"', () => {
  assert.match(src, /c\.busy \|\| c\.failed[\s\S]{0,200}loading/);
});

test('a parked (or already gone) session leaves the list at once, not on the next status frame', () => {
  assert.match(src, /async function parkSession[\s\S]{0,900}delete state\.status\[name\]; onStatus\(\)/);
});
