import test from 'node:test';
import assert from 'node:assert/strict';
import { endsHandedOver, closingLines, noticeEnd, statusLine } from '../stall.js';

// A resumed Claude session: its needs-owner turn, then Claude Code's own notices (owner 2026-11-28: the stop showed idle and grey).
const pane = [
  '● Publish these 2 items to production.',
  '',
  '  STATUS: needs-owner: reply with example-tree to confirm publishing the',
  '  node example_node to production.',
  '',
  '✻ Cooked for 7m 7s · done 7:01 AM',
  '',
  '● Artifact comment monitor for',
  '  https://claude.ai/artifact/AAAA didn\'t resume: it',
  '  couldn\'t restart in this session. Publish the Artifact again to turn',
  '  automatic replies back on.',
  '',
  '● Artifact comment monitor for',
  '  https://claude.ai/artifact/BBBB didn\'t resume: it',
  '  couldn\'t restart in this session.',
  '',
  '  /remote-control is active · Continue here, on your phone, or at',
  '  https://claude.ai/code/session_FAKE',
  '',
  '──────────────────────────────────────── demo ─',
  '❯ ',
  '────────────────────────────────────────────────',
  '  Opus 5.5                                   /rc',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

test('trailing Claude Code notices do not hide the hand-over STATUS line', () => {
  assert.equal(endsHandedOver(pane), true);
  assert.equal(statusLine(closingLines(pane, 16))?.kind, 'needs-owner');
  assert.ok(!closingLines(pane, 16).some((l) => /Artifact comment monitor|remote-control/.test(l)));
});

test('noticeEnd stops at the first paragraph that is not a notice', () => {
  const end = noticeEnd(pane, 19);
  assert.equal(pane[end - 2], '✻ Cooked for 7m 7s · done 7:01 AM');
  const plain = ['● Done.', '', '  STATUS: done — x'];
  assert.equal(noticeEnd(plain), plain.length);
  // the agent's own words about the monitor (not at the paragraph start) are kept
  const quoted = ['● The Artifact comment monitor for X failed; I republished it.'];
  assert.equal(noticeEnd(quoted), 1);
});

// An MCP server's input form (elicitation): the question is the form field, not the key hint under it (owner 2026-11-28).
test('an MCP input form asks its field, not the menu footer', async () => {
  const { classifyStall } = await import('../stall.js');
  const form = [
    '● Calling example… (ctrl+o to expand)',
    '──────────────────────────────────────── demo ─',
    '',
    '────────────────────────────────────────────────',
    '  MCP server “example” requests your input',
    '',
    '  publish copies the dev version to prod.',
    '',
    "  ❯ * Type the name 'example-tree' to confirm: Type something…",
    '',
    '    Accept    Decline',
    '',
    '  Esc to cancel · ↑/↓ to navigate · Backspace to unset',
  ];
  const r = classifyStall({ plain: form, state: 'waiting' });
  assert.equal(r.case, 'owner_decision');
  assert.equal(r.question, "Type the name 'example-tree' to confirm:");
});
