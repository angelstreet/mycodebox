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

test('the real box as captured on 2026-11-20 (✕ close mark, dim colour codes) goes whole', () => {
  const text = ['reply',
    '\x1b[2m╭──────────────────\x1b[0m\x1b[38;5;246m\x1b[49m✕\x1b[2m\x1b[39m─╮',
    '│\x1b[0m\x1b[39m\x1b[49m \x1b[38;5;246mResize your terminal to at least 110 columns to show the diff panel\x1b[39m   \x1b[2m│',
    '╰────────────────────╯', '', '── session ─', '❯ '].join('\n');
  assert.deepEqual(stripResizeHint(text).split('\n'), ['', '', '', 'reply', '', '── session ─', '❯ ']);
});

import { stripDiffPanel } from '../public/pane-hints.js';
test('the diff side panel is cut off at its border; the conversation on the left is kept, colours reset at the cut', () => {
  const L = (left, right) => left + ' '.repeat(20 - left.replace(/\x1b\[[0-9;]*m/g, '').length) + '│' + right;   // the border at visible column 20
  const text = ['above the panel',
    ''.padEnd(20) + '                     ✕',
    L('Limit of the', '   /diff to close  source: Current ▾'),
    L('\x1b[1mbold\x1b[0m text', ''),
    L('more text', '   No changes this session'),
    'prompt line ─────────────', '❯ '].join('\n');
  const out = stripDiffPanel(text).split('\n');
  assert.equal(out[0], 'above the panel');
  assert.equal(out[2], 'Limit of the\x1b[0m');
  assert.equal(out[3], '\x1b[1mbold\x1b[0m text\x1b[0m');
  assert.equal(out[4], 'more text\x1b[0m');
  assert.ok(!out.join('\n').includes('diff to close') && !out.join('\n').includes('No changes'));
  assert.equal(out[5], 'prompt line ─────────────'); assert.equal(out.length, 7);
});
test('no diff panel: the text is returned as it is', () => {
  const t = 'a │ b\n/diff is a command';
  assert.equal(stripDiffPanel(t), t);
});
