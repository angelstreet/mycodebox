import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryOf, spokenSummaryOf, SUMMARY_MAX_LINES } from '../public/reader-summary.js';

const TURN = `The fix is in.

Summary:
- Resume failed when the folder was gone.
- 390 parked sessions had that problem.
- Resume now rebuilds the folder first.

Verification:
1. pass — tests green

STATUS: done — resume fix merged`;

test('summaryOf: the lines between Summary: and Verification:, bullets stripped', () => {
  assert.deepEqual(summaryOf(TURN), { lines: ['Resume failed when the folder was gone.', '390 parked sessions had that problem.', 'Resume now rebuilds the folder first.'], lineCount: 3, tooLong: false });
});

test('summaryOf: none, the last block wins, markdown header, ends at STATUS without a blank line', () => {
  assert.equal(summaryOf('just a reply\nSTATUS: done — x'), null);
  assert.equal(summaryOf(''), null);
  const two = 'Summary:\n- old turn\n\n> next prompt\n\n**Summary:**\n- new turn\nSTATUS: done — y';
  assert.deepEqual(summaryOf(two).lines, ['new turn']);
  assert.deepEqual(summaryOf('**Summary**:\nPlain sentence one.\nPlain sentence two.\nSTATUS: waiting: x').lines, ['Plain sentence one.', 'Plain sentence two.']);
});

test('summaryOf: 11 lines or a 161-character line is too long; an empty block has no lines', () => {
  const eleven = 'Summary:\n' + Array.from({ length: SUMMARY_MAX_LINES + 1 }, (_, i) => `- line ${i}`).join('\n');
  assert.equal(summaryOf(eleven).tooLong, true);
  assert.equal(summaryOf(eleven).lineCount, 11);
  assert.equal(summaryOf('Summary:\n- ' + 'a'.repeat(161)).tooLong, true);
  assert.equal(summaryOf('Summary:\n- ' + 'a'.repeat(160)).tooLong, false);
  assert.deepEqual(summaryOf('Summary:\n\nVerification:\n1. pass').lines, []);
});

test('summaryOf: a narrow pane wraps a bullet over rows; the wrapped rows join the line above', () => {
  const pane = [
    '⏺ Summary:',
    '  - Resume failed when the folder of a parked',
    '    session was gone.',
    '  - Merged and live.',
    '',
    '  Verification:',
    '  STATUS: done — x',
  ].join('\n');
  assert.deepEqual(summaryOf(pane).lines, ['Resume failed when the folder of a parked session was gone.', 'Merged and live.']);
});

test('spokenSummaryOf: the lines as sentences, nothing without lines', () => {
  assert.equal(spokenSummaryOf(['It works', 'Try it now.']), 'It works. Try it now.');
  assert.equal(spokenSummaryOf(null), '');
  assert.equal(spokenSummaryOf([]), '');
});
