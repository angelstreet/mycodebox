import test from 'node:test';
import assert from 'node:assert/strict';
import { stripResizeHint } from '../public/pane-hints.js';

const BOX = ['╭────────────────────╮', '│ Resize your terminal to at least 110 columns to show the diff panel │', '╰────────────────────╯'];

test('the resize hint box is blanked and the row count is kept', () => {
  const text = ['done', ...BOX, '', '❯ '].join('\n');
  const out = stripResizeHint(text).split('\n');
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(1, 4), ['', '', '']);
  assert.equal(out[0], 'done'); assert.equal(out[5], '❯ ');
});

test('colour codes around the hint do not hide it, other text is untouched', () => {
  const text = ['a', '\x1b[2m╭────╮\x1b[0m', '\x1b[2m│ Resize your terminal to at least 110 columns to show the diff panel │\x1b[0m', '\x1b[2m╰────╯\x1b[0m', 'b'].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['a', '', '', '', 'b']);
  const plain = 'nothing to hide\n╭──╮\n│ other box │\n╰──╯';
  assert.equal(stripResizeHint(plain), plain);
});
