import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSentEcho, ECHO_WINDOW_MS } from '../public/sent-echo.js';

test('the whole sent text coming back is dropped', () => {
  assert.equal(stripSentEcho('hello', 'hello', 1000, 1500), '');
});
test('the echo followed by a newly typed character keeps only the new character', () => {
  assert.equal(stripSentEcho('hellox', 'hello', 1000, 1500, 'insertText'), 'x');
});
test('unrelated text is untouched', () => {
  assert.equal(stripSentEcho('other', 'hello', 1000, 1500), 'other');
});
test('after the window the same text is allowed again', () => {
  assert.equal(stripSentEcho('hello', 'hello', 1000, 1000 + ECHO_WINDOW_MS + 1), 'hello');
});
test('a paste is never stripped', () => {
  assert.equal(stripSentEcho('hello', 'hello', 1000, 1500, 'insertFromPaste'), 'hello');
});
test('nothing sent yet', () => {
  assert.equal(stripSentEcho('abc', '', 0, 10), 'abc');
});
