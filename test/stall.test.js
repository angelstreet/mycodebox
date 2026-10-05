import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, applyJev, wouldSend, inputBox, outcomeKind, setForbiddenExtra } from '../stall.js';

const RULE = '─'.repeat(60);
// A synthetic Claude Code pane: reply, turn timer, input box, footer.
function claude(body, { input = '❯ ', done = true } = {}) {
  const lines = ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`))];
  if (done) lines.push('', '✻ Baked for 3m 31s · done 3:59 PM');
  lines.push(RULE, input, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc');
  return lines;
}
const classify = (plain, state = 'done', raw = null) => classifyStall({ plain, raw, state });

test('continue: a plain "shall I continue" is answered', () => {
  const s = classify(claude('Phase 1 works: all 5 tests pass and the strip renders.\nShall I continue with phase 2?'));
  assert.equal(s.case, 'continue');
  assert.equal(s.source, 'rule');
  assert.deepEqual(wouldSend(s).send, { text: 'Yes, continue.' });
});

test('continue look-alike: same question after a push to main is forbidden', () => {
  const s = classify(claude('Phase 1 is committed.\nWant me to push it to main and continue?'));
  assert.equal(s.case, 'continue');
  assert.match(s.forbidden, /push/i);
  assert.equal(wouldSend(s).send, null);
});

test('continue look-alike: continue and deploy is forbidden', () => {
  const s = classify(claude('The branch is green.\nShall I continue and deploy it to the hosts?'));
  assert.equal(wouldSend(s).send, null);
  assert.match(wouldSend(s).why, /forbidden: deploy/);
});

test('owner decision: "X, or leave it?"', () => {
  const s = classify(claude('Want me to clean up the worktree, or leave it for now?'));
  assert.equal(s.case, 'owner_decision');
  assert.equal(wouldSend(s).send, null);
});

test('owner decision: numbered options, none recommended', () => {
  const s = classify(claude('Three ways forward:\n1. Check the network theory.\n2. Use live streams in the browser.\n3. Use the operator box.\nWhich one?'));
  assert.equal(s.case, 'owner_decision');
});

test('menu with a recommended option after a finished turn', () => {
  const s = classify(claude('Two ways forward:\n1. Cache the tree per host (recommended)\n2. Rebuild it on every run\nWhich one?'));
  assert.equal(s.case, 'menu_recommended');
  assert.deepEqual(wouldSend(s).send, { text: 'Yes, go with your recommendation.' });
});

test('live AskUserQuestion menu: the recommended number is the key', () => {
  const plain = ['☐ Storage', '', 'Where should the log live?', '', '  1. A JSONL file (Recommended)', '     one line per stall',
    '❯ 2. SQLite', '  3. Type something.', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
  const s = classify(plain, 'waiting');
  assert.equal(s.case, 'menu_recommended');
  assert.deepEqual(wouldSend(s).send, { key: '1' });
});

test('permission prompt (Claude) is never answered', () => {
  const plain = ['⏺ Bash(ls /etc)', '', ' Bash command', '   ls /etc', ' Do you want to proceed?', ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for ls commands", '   3. No, and tell Claude what to do differently (esc)'];
  const s = classify(plain, 'waiting');
  assert.equal(s.case, 'permission');
  assert.equal(wouldSend(s).send, null);
});

test('permission prompt (Codex)', () => {
  const plain = ['Would you like to run the following command?', '  $ git status', '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for this command (a)", '  3. No, and tell Codex what to do differently (esc)'];
  assert.equal(classify(plain, 'waiting').case, 'permission');
});

test('usage limit is an error, not a question', () => {
  const plain = claude('I was about to run the suite.', { done: false });
  plain.splice(plain.length - 5, 0, "  ⎿  You've hit your weekly limit · resets 2pm (UTC)");
  const s = classify(plain);
  assert.equal(s.case, 'error');
  assert.match(s.question, /weekly limit/);
});

test('finished turn with no question is done', () => {
  const s = classify(claude('The handover doc is updated.\nI am stopping here.'));
  assert.equal(s.case, 'done');
  assert.equal(s.source, 'rule');
});

test('finished turn announcing a next step is ambiguous (Jev decides)', () => {
  const s = classify(claude('Phase 1 is live.\nNext is Phase 2: the stall watcher in shadow mode.'));
  assert.equal(s.case, 'done');
  assert.equal(s.source, 'ambiguous');
  assert.deepEqual(wouldSend(applyJev(s, 'continue')).send, { text: 'Yes, continue.' });
});

test('an unclassified question is ambiguous and defaults to the owner', () => {
  const s = classify(claude('The cache is warm now.\nGood to keep the same thresholds for the next run?'));
  assert.equal(s.source, 'ambiguous');
  assert.equal(wouldSend(s).send, null);
});

test('forbidden filter wins even when Jev says continue', () => {
  for (const q of ['Should I delete the old branches?', 'Can I run update_core main --host?', 'OK to copy the new .env to the VM?',
    'Shall I rotate the API key now?', 'Should I add credit to the account?', 'Should I send this to the customer?',
    'Shall I force-push the branch?', 'Ready to apply the migration?']) {
    const s = applyJev(classify(claude(`Everything else is ready.\n${q}`)), 'continue');
    assert.equal(wouldSend(s).send, null, q);
    assert.ok(s.forbidden, q);
  }
});

test('extra forbidden words from the environment', () => {
  setForbiddenExtra('\\bacme\\b');
  const s = classify(claude('Shall I continue with the acme report?'));
  assert.equal(wouldSend(s).send, null);
  setForbiddenExtra('');
});

test('a draft in the input box blocks sending; a dim suggestion does not', () => {
  const body = 'Tests pass.\nShall I continue?';
  const draft = classify(claude(body, { input: '❯ wait, first check the logs' }));
  assert.equal(draft.draft, 'wait, first check the logs');
  assert.equal(wouldSend(draft).send, null);

  const plain = claude(body, { input: '❯ yes continue' });
  const raw = plain.map((l) => (l === '❯ yes continue' ? '\x1b[39m❯\xa0\x1b[2myes continue\x1b[0m\x1b[39m' : l));
  const sug = classifyStall({ plain, raw, state: 'done' });
  assert.equal(sug.draft, null);
  assert.equal(sug.suggestion, 'yes continue');
  assert.deepEqual(wouldSend(sug).send, { text: 'Yes, continue.' });
});

test('MiniMax placeholder is not a draft', () => {
  const plain = ['Done, all green.', 'Shall I continue?', '└ Completed in 2min55s', 'Message · Enter send', RULE, '›  Ask Mcode to do anything', RULE, 'FULL │ ✦ M3 │ Ctx 88%'];
  assert.deepEqual(inputBox(plain), { draft: null, suggestion: null });
  assert.equal(classify(plain).case, 'continue');
});

test('outcomeKind maps the owner reply to the same vocabulary', () => {
  assert.equal(outcomeKind('yes'), 'continue');
  assert.equal(outcomeKind('Yes, continue.'), 'continue');
  assert.equal(outcomeKind('go ahead'), 'continue');
  assert.equal(outcomeKind('2'), 'take_recommended');
  assert.equal(outcomeKind('check the network theory first'), 'owner_specific');
});

test('Claude Code feedback survey (spinner + Tip + survey) is not a stall', () => {
  // The pane while the session is still working: spinner + Tip + the optional feedback
  // survey. The survey alone must not produce a question, menu, or owner_decision.
  const plain = [
    '✻ Synthesizing… (11s)',
    '⎿  Tip: Run /install-slack-app to use Claude in Slack',
    'How is Claude doing this session? (optional)',
    '1: Bad    2: Fine   3: Good   0: Dismiss',
    RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc',
  ];
  const s = classify(plain);
  assert.notEqual(s.case, 'owner_decision', `survey-only pane should not be owner_decision; got ${s.case}`);
  assert.notEqual(s.case, 'menu_recommended', `survey-only pane should not be a menu; got ${s.case}`);
  assert.notEqual(s.case, 'permission', `survey-only pane should not be a permission prompt; got ${s.case}`);
  assert.ok(!/how is claude doing/i.test(s.question || ''), `question should not be the survey header: ${s.question}`);
  assert.ok(!/\b(?:Bad|Fine|Good|Dismiss)\b/.test(s.question || ''), `question should not mention survey options: ${s.question}`);
  const optTexts = (s.options || []).map((o) => o.text);
  for (const word of ['Bad', 'Fine', 'Good', 'Dismiss']) {
    assert.ok(!optTexts.some((t) => t.includes(word)), `survey options should not include ${word}: ${JSON.stringify(optTexts)}`);
  }
});

test('Claude Code feedback survey: wrapped narrow-pane form is not a stall', () => {
  // Same pane in a narrow terminal: the rating line wraps so "3:    0: Dis" lands on one
  // row and "Good  miss" on the one below.
  const plain = [
    '✻ Synthesizing… (11s)',
    '⎿  Tip: Run /install-slack-app to use Claude in Slack',
    'How is Claude doing this session? (optional)',
    '1: Bad2: Fine3:    0: Dis',
    'Good  miss',
    RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc',
  ];
  const s = classify(plain);
  assert.notEqual(s.case, 'owner_decision', `wrapped survey pane should not be owner_decision; got ${s.case}`);
  assert.notEqual(s.case, 'menu_recommended', `wrapped survey pane should not be a menu; got ${s.case}`);
  assert.ok(!/how is claude doing/i.test(s.question || ''), `question should not be the survey header: ${s.question}`);
  assert.ok(!/\b(?:Bad|Fine|Good|Dismiss)\b/.test(s.question || ''), `question should not mention survey options: ${s.question}`);
  const optTexts = (s.options || []).map((o) => o.text);
  for (const word of ['Bad', 'Fine', 'Good', 'Dismiss']) {
    assert.ok(!optTexts.some((t) => t.includes(word)), `survey options should not include ${word}: ${JSON.stringify(optTexts)}`);
  }
});

test('Claude Code feedback survey: real (Recommended) menu above the survey is still menu_recommended', () => {
  // A real numbered menu with "(Recommended)" sits in the body; the survey is appended at
  // the bottom. The menu must still be classified exactly as before, and the survey's
  // Bad/Fine/Good/Dismiss words must not leak into the surfaced question / options.
  const plain = claude('Two ways forward:\n1. Cache the tree per host (Recommended)\n2. Rebuild it on every run\nWhich one?');
  const ruleIdx = plain.indexOf(RULE);
  plain.splice(ruleIdx, 0, '', 'How is Claude doing this session? (optional)', '1: Bad    2: Fine   3: Good   0: Dismiss');
  const s = classify(plain);
  assert.equal(s.case, 'menu_recommended', `menu above survey should still be menu_recommended; got ${s.case}`);
  assert.deepEqual(wouldSend(s).send, { text: 'Yes, go with your recommendation.' });
  // The detected menu options must not include any survey rating word; the survey text
  // must not leak into the surfaced question, excerpt, or closing text either.
  const haystack = [s.question, s.excerpt, s.closing].filter(Boolean).join('\n');
  assert.ok(!/how is claude doing/i.test(haystack), `survey header must not appear in output: ${haystack.slice(0, 160)}`);
  for (const word of ['Bad', 'Fine', 'Good', 'Dismiss']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(haystack), `survey word ${word} must not leak into output`);
  }
});
