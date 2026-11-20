import test from 'node:test';
import assert from 'node:assert/strict';
import { stripResizeHint } from '../public/pane-hints.js';

const BOX = ['╭────────────────────╮', '│ Resize your terminal to at least 110 columns to show the diff panel │', '╰────────────────────╯'];

test('the resize hint box is removed, its rows go to the top of the screen, the row count is kept', () => {
  const text = ['done', ...BOX, '', '❯ '].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['', '', '', 'done', '', '❯ ']);
});

test('a narrow pane: the wrapped top border and the wrapped hint all go, no gap is left above the prompt', () => {
  const text = ['reply text', '╭──────────', '──────────', '─────×╮', '│ Resize your terminal to at least 110', 'columns to show the diff panel', '│', '── session ─', '❯ '].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['', '', '', '', '', '', 'reply text', '── session ─', '❯ ']);
});

test('the box drawn without the hint (only its border with the × mark) goes too; the empty rows are at the very top', () => {
  const text = ['h1', 'reply', '╭────────────────────×╮', '│', '── session ─', '❯ '].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['', '', 'h1', 'reply', '── session ─', '❯ ']);
});

test('colour codes around the hint do not hide it, other text is untouched', () => {
  const text = ['a', '\x1b[2m╭────╮\x1b[0m', '\x1b[2m│ Resize your terminal to at least 110 columns to show the diff panel │\x1b[0m', '\x1b[2m╰────╯\x1b[0m', 'b'].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['', '', '', 'a', 'b']);
  const plain = 'nothing to hide\n╭──╮\n│ other box │\n╰──╯';
  assert.equal(stripResizeHint(plain), plain);
});
