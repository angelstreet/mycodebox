// False "asks you" pushes: finished reports that only mention a restart / reload, tool-call chrome in the
// question, and mid-word excerpts. Synthetic text only. Real asks must still escalate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, wouldSend, tailSentences } from '../stall.js';

const RULE = '─'.repeat(60);
function claude(body, { tools = true } = {}) {
  const lines = tools ? ['⏺ Bash(npm test)', '  ⎿  5 passed', ''] : [];
  lines.push(...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)), '', '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on');
  return lines;
}
const classify = (body, state = 'done') => classifyStall({ plain: claude(body), raw: null, state });

test('1. a report that says no restart was needed is not waiting_deploy', () => {
  const s = classify([
    'Done: the badge shows who holds the lease.',
    '- When it appears: only while a deploy is queued or waiting for approval and a lease',
    '  is blocking it. It is hidden while a deploy is running.',
    "- Taking effect: it's static files only, so no restart was needed. The cache is now v34,",
    '  so reload the page to pick it up.',
  ].join('\n'));
  assert.equal(s.case, 'done');
  assert.equal(wouldSend(s).why, 'finished');
});

test('1b. past-tense deploy mention at the end is not a wait', () => {
  const s = classify('Tests pass: 12 passed.\nIt was deployed to the debug host earlier, no restart needed.');
  assert.notEqual(s.case, 'waiting_deploy');
});

test('2. "reload the page to pick it up" at the end of a done report is an FYI, not owner_action', () => {
  const s = classify("Done: the chip is wider on phones, 3 tests pass.\nIt's committed locally. Reload the page to pick it up, since the cache is now v35.");
  assert.equal(s.case, 'done');
  assert.equal(s.fyi, 'reload the page');
  assert.equal(s.no_status, false);
  assert.equal(wouldSend(s).send, null);
});

test('2b. a reload the agent needs before it can continue still escalates', () => {
  const s = classify('The change is in. Please reload the page and tell me what you see, then I can finish the check.');
  assert.equal(s.case, 'owner_action');
});

test('2c. physical actions still escalate', () => {
  for (const t of ['Almost there. Press PAIR on the remote, then say go.', 'Please plug in the HDMI cable and power-cycle the box.']) {
    const s = classify(t);
    assert.equal(s.case, 'owner_action', t);
  }
});

test('3. tool-call and tool-output lines never reach the question', () => {
  const plain = [
    '⏺ Bash(echo \'{"trigger":"asks","decision":"escalate","reason":"relo…)',
    '  ⎿  (No output)',
    '⏺ Bash(~/proj/scripts/wait.sh)',
    '  ⎿  Running in the background (↓ to manage)',
    '     … +22 lines (ctrl+o to expand)',
    '⏺ The other session shipped another change. The event wait is running again.',
    '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on',
  ];
  const s = classifyStall({ plain, raw: null, state: 'done' });
  assert.equal(s.question, 'The other session shipped another change. The event wait is running again.');
  assert.doesNotMatch(s.question, /Bash\(|⎿|No output|\{/);
});

test('3b. a question after tool output is still found', () => {
  const plain = ['⏺ Read(src/a.js)', '  ⎿  Read 40 lines', '⏺ Which approach do you prefer, A or B?', '', RULE, '❯ ', RULE, 'x'];
  const s = classifyStall({ plain, raw: null, state: 'done' });
  assert.equal(s.case, 'owner_decision');
  assert.equal(s.question, 'Which approach do you prefer, A or B?');
});

test('5. a long closing paragraph is cut at a sentence boundary, never mid-word', () => {
  const para = 'Alpha sentence about the collapsed state of the header. ' + 'Beta sentence that fills the space with words about the quota strip and its margins. '.repeat(3)
    + 'Gamma ends the report here. Can I go ahead and tidy it up?';
  const s = classify(para);
  assert.ok(s.question.length <= 300);
  assert.match(s.question, /^[A-Z]/);
  assert.match(s.question, /Can I go ahead and tidy it up\?$/);
  const q = tailSentences('x'.repeat(10) + ' ' + 'word '.repeat(100), 100);
  assert.match(q, /^… word/);
  assert.ok(q.length <= 105);
});

test('real asks still escalate: numbered owner decision menu', () => {
  const s = classify('Two ways to do this:\n1. Keep the old table and add a column\n2. Replace the table with a view\nWhich do you want?', 'waiting');
  assert.equal(s.case, 'owner_decision');
  assert.equal(wouldSend(s).send, null);
});

test('real asks still escalate: "Should I ...? 1. ... 2. ..."', () => {
  const s = classify('Should I split the file?\n1. Yes, split it now\n2. No, leave it as one file', 'waiting');
  assert.equal(s.case, 'owner_decision');
  assert.equal(wouldSend(s).send, null);
});

test('real asks still escalate: a real deploy wait', () => {
  for (const t of ['The build is green. I need a deploy of the frontend, may I queue it?', 'Committed. Waiting for your go-ahead to deploy.', 'Blocked by live runs: waiting for the leases to clear.']) {
    const s = classify(t);
    assert.equal(s.case, 'waiting_deploy', t);
    assert.equal(wouldSend(s).send, null);
  }
});
