import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBgAtNewlines } from '../public/term-sgr.js';

const BG = '\x1b[48;5;237m';
test('an open background is closed before a newline and re-opened after it', () => {
  assert.equal(closeBgAtNewlines(`${BG}hello\n\nworld`), `${BG}hello\x1b[49m\n${BG}\x1b[49m\n${BG}world`);
});
test('once the background is reset, newlines are left alone', () => {
  const t = `${BG}hi\x1b[49m\nnext\nmore`;
  assert.ok(closeBgAtNewlines(t).endsWith('\x1b[49m\nnext\nmore'));
});
test('text without a background is returned unchanged', () => {
  const t = '\x1b[38;5;246mgrey text\x1b[39m\nline two\n';
  assert.equal(closeBgAtNewlines(t), t);
});
test('0, empty and 49 all reset; truecolor and basic backgrounds are tracked', () => {
  for (const r of ['\x1b[0m', '\x1b[m', '\x1b[49m']) assert.ok(!closeBgAtNewlines(`${BG}a${r}\nb`).includes('\x1b[49m\n\x1b[48'));
  assert.ok(closeBgAtNewlines('\x1b[48;2;1;2;3ma\nb').includes('\x1b[49m\n\x1b[48;2;1;2;3m'));
  assert.ok(closeBgAtNewlines('\x1b[44ma\nb').includes('\x1b[49m\n\x1b[44m'));
});
test('a foreground 38;5;48 is not mistaken for a background', () => {
  const t = '\x1b[38;5;48mgreen\nnext';
  assert.equal(closeBgAtNewlines(t), t);
});
