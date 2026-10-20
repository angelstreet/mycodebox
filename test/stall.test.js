import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, applyJev, wouldSend, inputBox, outcomeKind, setForbiddenExtra, statusLine, forbiddenMatch, ownerFloorMatch, OWNER_FLOOR_RE, FORBIDDEN_RE } from '../stall.js';

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

test('continue look-alike: same question after a push to main is forbidden (round 13: FORBIDDEN_RE restored; safety filter still catches push to main)', () => {
  // Round 13 (2026-10-18): FORBIDDEN_RE (the auto-answer safety filter) is restored exactly as on main -- push to main
  // is back in the safety filter. The stop is escalated (wouldSend is null) and ops-ask routes it as a manager item
  // because the push topic is set in out.topics. The owner floor (OWNER_FLOOR_RE) does NOT match push to main.
  const s = classify(claude('Phase 1 is committed.\nWant me to push it to main and continue?'));
  assert.equal(s.case, 'continue');
  assert.ok(s.forbidden, 'push to main is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  assert.ok(s.topics?.push, 'the push topic is set so ops-ask routes it as a manager item');
  assert.equal(ownerFloorMatch('push to main'), null, 'OWNER_FLOOR does NOT match push to main -- it routes to the manager');
  assert.equal(wouldSend(s).send, null);
});

test('continue look-alike: continue and deploy is forbidden (round 13: FORBIDDEN_RE restored; safety filter still catches deploy)', () => {
  // Round 13: deploy is back in FORBIDDEN_RE. The stop is escalated and ops-ask routes it as a manager item
  // because the deploy topic is set in out.topics. The owner floor does NOT match deploy.
  const s = classify(claude('The branch is green.\nShall I continue and deploy it to the hosts?'));
  assert.ok(s.forbidden, 'deploy is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  assert.ok(s.topics?.deploy, 'the deploy topic is set so ops-ask routes it as a manager item');
  assert.equal(ownerFloorMatch('deploy it to the hosts'), null, 'OWNER_FLOOR does NOT match deploy -- it routes to the manager');
  assert.equal(wouldSend(s).send, null);
  assert.match(s.question || '', /continue|deploy/);
});

test('owner decision: "X, or leave it?"', () => {
  const s = classify(claude('Want me to clean up the worktree, or leave it for now?'));
  assert.equal(s.case, 'owner_decision');
  assert.equal(wouldSend(s).send, null);
});

test('owner decision: numbered options, none recommended, option 1 is a way out or a hard topic', () => {
  for (const first of ['Skip it and move on.', 'Delete the old streams.', 'Cancel the run.']) {
    const s = classify(claude(`Three ways forward:\n1. ${first}\n2. Use live streams in the browser.\n3. Use the operator box.\nWhich one?`));
    assert.equal(s.case, 'owner_decision', first);
    assert.equal(wouldSend(s).send, null);
  }
});
test('unmarked menu (round 9): a safe first option is the recommendation (source unmarked-first)', () => {
  const s = classify(claude('Three ways forward:\n1. Check the network theory.\n2. Use live streams in the browser.\n3. Use the operator box.\nWhich one?'));
  assert.equal(s.case, 'menu_recommended'); assert.equal(s.source, 'unmarked-first');
  assert.deepEqual(wouldSend(s).send, { text: 'Go with option 1.' });
  assert.deepEqual(s.options.map((o) => o.recommended), [true, false, false]);
  const live = classify('Which approach?\n ❯ 1. Check the network theory\n   2. Use live streams\n Enter to select · ↑/↓ to navigate · Esc to cancel'.split('\n'), 'waiting');
  assert.equal(live.case, 'menu_recommended'); assert.deepEqual(wouldSend(live).send, { key: '1' });
});
test('unmarked menu: only a clean 1..N list counts, a marked one keeps its marker', () => {
  const gap = classify(claude('Ways forward:\n2. Check it.\n3. Use live streams.\nWhich one?'));
  assert.equal(gap.case, 'owner_decision');
  const marked = classify(claude('Two ways:\n1. Rebuild it\n2. Cache the tree (recommended)\nWhich one?'));
  assert.equal(marked.options.find((o) => o.recommended).n, 2);
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

test('forbidden filter wins even when Jev says continue (round 13: FORBIDDEN_RE is the safety filter; owner-list topics stay in the routing floor too)', () => {
  // Round 13 (2026-10-18): FORBIDDEN_RE (the safety filter) is restored exactly as on main -- it catches deploy, push,
  // merge, sudo, migration, money, customers, destructive data, third-party credentials, and physical actions.
  // OWNER_FLOOR is a narrower, routing-only set; both money/customers/credentials/shared_data_delete/physical AND
  // deploy/push/migration/sudo/etc. are caught by FORBIDDEN_RE and never auto-answered.
  for (const q of ['Should I delete the old branches?', 'OK to copy the new .env to the VM?',
    'Shall I rotate the API key now?', 'Should I add credit to the account?', 'Should I send this to the customer?',
    'Should I drop the old test table from the DB?',
    'Can I run update_core main --host?', 'Shall I force-push the branch?', 'Ready to apply the migration?']) {
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

test('Claude Code feedback survey: quoted header text and "N:" menu lines are not stripped', () => {
  const plain = claude('Should the detector ignore "How is Claude doing this session? (optional)" in a quote?\n1: Yes (Recommended)\n2: No\n0: Skip');
  const s = classify(plain);
  assert.ok(/1: Yes/.test(s.excerpt) && /How is Claude doing/.test(s.excerpt) && /0: Skip/.test(s.excerpt), `nothing may be stripped: ${s.excerpt}`);
});

// ---- STATUS line (last line of a Claude turn) decides first; regexes stay for turns without it ----
test('STATUS: done is not an ask, even when the text above contains a question mark', () => {
  const s = classify(claude('Merged. Why did the old path fail? Because of the cache.\n\nSTATUS: done'));
  assert.equal(s.case, 'done');
  assert.equal(s.status, 'done');
  assert.equal(s.no_status, false);
  assert.equal(wouldSend(s).send, null);
});

test('STATUS: needs-owner is the owner question, never auto-answered', () => {
  const s = classify(claude('Two ways to do it.\nSTATUS: needs-owner: Ship the migration now or after the deploy? [1 now, 2 after]'));
  assert.equal(s.case, 'owner_decision');
  assert.equal(s.status, 'needs-owner');
  assert.match(s.question, /^Ship the migration now or after the deploy/);
  assert.equal(wouldSend(s).send, null);
});

test('STATUS: blocked needs the owner', () => {
  const s = classify(claude('Cannot proceed.\nSTATUS: blocked: lease held by task42'));
  assert.equal(s.case, 'owner_decision');
  assert.equal(s.blocked, 'lease held by task42');
  assert.equal(wouldSend(s).send, null);
});

test('STATUS: handoff is not an ask', () => {
  const s = classify(claude('Passing the box on.\nSTATUS: handoff: lease -> task58-b by 14:30'));
  assert.equal(s.case, 'done');
  assert.equal(s.handoff, 'lease -> task58-b by 14:30');
  assert.equal(s.no_status, false);
});

test('STATUS: waiting: deploy is the deploy case with the id', () => {
  const s = classify(claude('Queued.\nSTATUS: waiting: deploy d-42'));
  assert.equal(s.case, 'waiting_deploy');
  assert.equal(s.deployHint.id, 'd-42');
});

// A queued wait (ticket / queue position / `claim --wait` / a deploy already queued or awaiting approval) is not an
// escalation: the session is in a line and no agent makes it move faster (router wake point, 2026-10-20).
test('queued wait: a ticket, a queue position, --wait or a queued/awaiting deploy sets queued', () => {
  const waits = [
    'STATUS: waiting: deploy t-9f21 ticket',                       // ticket id
    'STATUS: waiting: the lease ticket t-4c1 is not free yet',
    'STATUS: waiting: deploy queue position 2',
    'STATUS: waiting: running lease-claim box-1 unit-2 --wait',    // the queueing call itself
    'STATUS: waiting: the deploy is queued behind the CI run',
    'STATUS: waiting: deploy d-42 awaiting approval',
    'STATUS: waiting: in the deploy queue since 14:02',
  ];
  for (const text of waits) {
    const s = classify(claude(`Queued.\n${text}`));
    assert.equal(s.case, 'waiting_deploy', text);
    assert.equal(s.queued, true, text);
  }
  const noStatus = classify(claude('Tests pass.\nWaiting on the box-1 lease ticket t-4c1 before I can run the suite.'));
  assert.equal(noStatus.case, 'waiting_deploy');
  assert.equal(noStatus.queued, true);
});
test('queued wait: a plain go-ahead wait is NOT queued (nothing to queue behind)', () => {
  const waits = [
    'STATUS: waiting: deploy go-ahead for the server restart',
    'STATUS: waiting: your go-ahead to run update_core.sh --server',
  ];
  for (const text of waits) {
    const s = classify(claude(`Queued.\n${text}`));
    assert.equal(s.case, 'waiting_deploy', text);
    assert.equal(s.queued, undefined, text);
  }
  const plain = classify(claude('Tests pass.\nI need your go-ahead to deploy the server.'));
  assert.equal(plain.case, 'waiting_deploy');
  assert.equal(plain.queued, undefined);
});

test('STATUS line is read from report text lines too (fromReport)', () => {
  const s = classifyStall({ plain: ['Did a thing?', 'STATUS: done'], state: 'done', fromReport: true });
  assert.equal(s.case, 'done');
});

test('no STATUS line: the regex fallback is unchanged (Codex / MiniMax panes)', () => {
  const s = classify(claude('Phase 1 works: all 5 tests pass and the strip renders.\nShall I continue with phase 2?'));
  assert.equal(s.case, 'continue');
  assert.equal(s.status, undefined);
});

// 2026-10-15: TASK33 (MiniMax) answered a reminder with "STATUS: acknowledged. ... I will ask before any future force-push",
// then mcode printed its todo panel. The STATUS line was missed (panel under it, and "acknowledged" was not a verdict), the
// heuristics read "I will ask" as stopped_short, proposed "Yes, continue." and the hard floor then asked the owner.
const T33 = [
  '  └ • Thought for 9.4s',
  'STATUS: acknowledged. Force-push and history rewrites are owner-gated; I will ask before any future force-push, even when undoing my own mistake. No code or host action taken.',
  '    ✓ Note surf-hunt give-up fix + TASK-35 follow-up in TASK-33-handover.md',
  'Monitor next */15 slot at 06:00 UTC for surf/strength milestones',
  '    ○ If a run ends STALLED again, run scripts/pokemon_stall_review.py',
  '    … +17 more · 18/20 done · 1 pending · Ctrl+T expand',
];

test('STATUS above the MiniMax todo panel is read; an acknowledgement is a finished turn, never a question', () => {
  const r = classifyStall({ plain: T33, state: 'done' });
  assert.equal(r.status, 'done');
  assert.equal(r.case, 'done');
  assert.equal(r.answer, null);
});

test('done aliases (acknowledged, noted, shipped, ...) read as done; one that still asks falls back to the heuristics', () => {
  for (const v of ['acknowledged.', 'ack', 'noted', 'OK', 'shipped:', 'completed', 'finished']) assert.equal(statusLine([`STATUS: ${v} x`])?.kind, 'done', v);
  assert.equal(statusLine(['STATUS: okay so I will push']), null);
  assert.equal(statusLine(['STATUS: ok — should I force-push to main?']), null);
  assert.equal(statusLine(['STATUS: shipped, see https://x.example/a?b=1'])?.kind, 'done');
  assert.equal(statusLine(['STATUS: needs-owner: force-push? [yes / no]'])?.kind, 'needs-owner');
});

test('round 13: force-push / migration / deploy ARE in the safety filter (FORBIDDEN_RE restored); an acknowledgement that names them is not an ask', () => {
  // Round 13 (2026-10-18): FORBIDDEN_RE is restored exactly as on main. force-push / migration / deploy / sudo are
  // back in the safety filter -- they are NEVER auto-answered. The routing (OWNER_FLOOR) still treats them as
  // manager items (ops-ask routes them to the manager), but the safety filter is the hard gate.
  assert.ok(forbiddenMatch(T33.join('\n')), 'force-push is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  // A direct "Should I force-push?" question is caught by the safety filter (and routes to the manager).
  const ask = classifyStall({ plain: ['I reset the branch locally.', 'Should I force-push fix-x to origin now?'], state: 'done' });
  assert.ok(ask.forbidden, 'force-push question IS flagged as forbidden (safety filter)');
  // The panel question is still unanswered (no recommendation, no reversible option) and the safety filter also blocks it.
  const panel = classifyStall({ plain: ['STATUS: ok — should I force-push fix-x?', '    ○ next', '    … +2 more · 1/3 done · 1 pending · Ctrl+T expand'], state: 'done' });
  assert.notEqual(panel.case, 'done');
  assert.ok(panel.forbidden, 'force-push IS forbidden -- the safety filter blocks auto-answering');
  // But the routing treats it as a manager item, not an owner item.
  assert.equal(ownerFloorMatch('Should I force-push fix-x to origin now?'), null, 'force-push is NOT in OWNER_FLOOR -- it routes to the manager');
});

test('a todo panel without a STATUS line above it changes nothing', () => {
  assert.equal(statusLine(['I will now run the suite.', '    ○ run suite', '    … +2 more · 1/3 done · 1 pending · Ctrl+T expand']), null);
});

// ---- round 13 (2026-10-18, owner rule) -------------------------------------------------------------------
// FORBIDDEN_RE is the AUTO-ANSWER SAFETY FILTER (restored exactly as on main -- it catches every topic it caught
// before, including deploy / push / merge / sudo / migration / money / customers / destructive data / credentials /
// physical). OWNER_FLOOR is the NARROWER, ROUTING-ONLY set the manager uses to decide OWNER-vs-MANAGER escalation:
// money, customers, deleting shared data, owner-held credentials (third-party logins, keys to rotate -- with the
// generated-secret exception), and physical actions. Migrations, generated app secrets, merge/push, deploys/restarts,
// sudo / systemctl, infra config and tests/CI are manager items and route to the manager, never the owner. The five
// representative cases:
test('round 13 case 1: "apply migration 0018 to Neon" -- FORBIDDEN_RE catches it (safety filter); OWNER_FLOOR does not (routing = manager)', () => {
  const s = classify(claude('All reviews are in.\nShould I apply migration 0018 to Neon?'));
  assert.equal(s.case, 'owner_decision', 'plain yes/no question is an owner_decision, not a menu');
  // The safety filter (FORBIDDEN_RE) catches migration -- it is never auto-answered.
  assert.ok(s.forbidden, 'migration IS in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  // But the routing floor (OWNER_FLOOR) does NOT match migration -- it routes to the manager, not the owner.
  assert.equal(ownerFloorMatch('Should I apply migration 0018 to Neon?'), null, 'migration is NOT in OWNER_FLOOR -- routing treats it as a manager item');
  assert.equal(wouldSend(s).send, null);
});

test('round 13 case 2: "set CRON_SECRET (generate)" -- FORBIDDEN_RE catches it (safety filter); OWNER_FLOOR does not (generated-secret exception)', () => {
  const s = classify(claude('Plan: rotate the cron secret.\nSet CRON_SECRET (generate a new value) and roll the service?'));
  // FORBIDDEN_RE catches "secret" -- the safety filter blocks auto-answering.
  assert.ok(s.forbidden, 'a secret is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  // But the routing floor (OWNER_FLOOR) drops the credentials part for a generated app secret -- it routes to the manager.
  assert.equal(ownerFloorMatch('Set CRON_SECRET (generate a new value) and roll the service?'), null, 'a generated app secret is NOT in OWNER_FLOOR -- routing treats it as a manager item');
});

test('round 13 case 3: "rotate the Stripe API key" -- BOTH FORBIDDEN_RE and OWNER_FLOOR catch it (owner item, never auto-answered)', () => {
  const s = classify(claude('Stripe asked us to rotate.\nRotate the Stripe API key now?'));
  assert.ok(s.forbidden, 'third-party credential rotation is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  assert.ok(ownerFloorMatch('Rotate the Stripe API key now?'), 'third-party credential rotation is ALSO in OWNER_FLOOR -- routing escalates to the owner');
  assert.equal(wouldSend(s).send, null);
});

test('round 13 case 4: "buy a domain" -- BOTH FORBIDDEN_RE and OWNER_FLOOR catch it (owner item, never auto-answered)', () => {
  const s = classify(claude('We need a stable URL.\nBuy a domain today?'));
  assert.ok(s.forbidden, 'a purchase is in FORBIDDEN_RE (the safety filter) -- never auto-answered');
  assert.ok(ownerFloorMatch('Buy a domain today?'), 'a purchase is ALSO in OWNER_FLOOR -- routing escalates to the owner');
  assert.equal(wouldSend(s).send, null);
});

test('round 13 case 5: needs-manager STATUS line is a regular owner question on main (round 3: needs-manager was out of scope and was removed from stall.js; ops-ask.js still handles the status if it ever arrives)', () => {
  // Round 3 (2026-10-18, owner-ask-narrow): stall.js is reset to main. The needs-manager STATUS line support
  // (added in round 13) was out of scope for this round and was removed -- stall.js on main only recognises
  // needs-owner, blocked, handoff, waiting in the STATUS line. ops-ask.js still has the `status === 'needs-manager'`
  // check (kept as a no-op safety net in case the status is set by a future caller).
  const s = classify(claude('Two ways to do it.\n1. Run the suite locally\n2. Push the branch and let CI run\nWhich one?\nSTATUS: needs-manager: pick option 1 or 2'));
  // The STATUS line is not recognised as needs-manager on main: it falls through to the heuristics, which see a
  // numbered menu and pick the recommended / unmarked-first case.
  assert.notEqual(s.status, 'needs-manager', 'on main, the STATUS line does not recognise needs-manager');
  assert.equal(s.case, 'menu_recommended', 'the menu heuristic picks the recommended option');
});

// ---- round 13 regression: FORBIDDEN_RE still catches push-to-main / update_core / sudo / migration -------------
test('round 13 regression: FORBIDDEN_RE (the safety filter) still matches "push to main", "update_core", "sudo", "migration"', () => {
  for (const q of ['push to main now', 'git push origin main', 'update_core main --host', 'force-push the branch', 'run sudo apt install', 'apply the migration', 'drop the test table']) {
    assert.ok(forbiddenMatch(q), `FORBIDDEN_RE must catch "${q}" (the safety filter blocks auto-answering)`);
    assert.ok(FORBIDDEN_RE.test(q), `FORBIDDEN_RE.test must catch "${q}"`);
  }
});

test('round 13 regression: OWNER_FLOOR does NOT match push-to-main / update_core / sudo / migration (routing = manager)', () => {
  for (const q of ['push to main now', 'git push origin main', 'update_core main --host', 'force-push the branch', 'run sudo apt install', 'apply the migration']) {
    assert.equal(ownerFloorMatch(q), null, `OWNER_FLOOR must NOT match "${q}" -- it routes to the manager, not the owner`);
    assert.equal(OWNER_FLOOR_RE.test(q), false, `OWNER_FLOOR_RE.test must NOT match "${q}"`);
  }
});

test('round 13 regression: OWNER_FLOOR matches "rotate the Stripe API key", "buy a domain", "delete the shared bucket" (routing = owner)', () => {
  for (const q of ['rotate the Stripe API key', 'buy a domain today', 'delete the shared bucket', 'send this email to the customer', 'plug in the device', 'OK to copy the new .env to the VM?']) {
    assert.ok(ownerFloorMatch(q), `OWNER_FLOOR must catch "${q}" -- routing escalates to the owner`);
    assert.ok(OWNER_FLOOR_RE.test(q), `OWNER_FLOOR_RE.test must catch "${q}"`);
  }
});

test('the todo panel may be followed by the background-tasks line', () => {
  assert.equal(statusLine([...T33, '  ◐ Tasks · 1 agent active · /tasks details'])?.kind, 'done');
});

test('merge_wait: a STATUS waiting / blocked / needs-owner on a merge or PR decision is never a deploy wait or an owner question', () => {
  for (const [kind, text] of [['waiting', 'your merge decision on PR #22'], ['blocked', 'merge decision on PR #22'], ['needs-owner', 'merge PR #22?']]) {
    const s = classify(claude(`Branch pushed.\nSTATUS: ${kind} — ${text}`));
    assert.equal(s.case, 'merge_wait', `${kind}: ${text}`);
    assert.equal(s.mergeAsk.pr, 22);
    assert.ok(s.topics.merge, 'the merge topic is set even for the noun use');
    assert.equal(s.answer, null);
  }
  assert.equal(classify(claude('Queued.\nSTATUS: waiting: deploy d-1')).case, 'waiting_deploy');
  const i = classify(claude('Queued.\nSTATUS: waiting: integration int-abc123'));
  assert.notEqual(i.case, 'merge_wait');
  assert.equal(classify(claude('Queued.\nSTATUS: waiting: integration int-abc123 to merge')).case !== 'merge_wait', true);
});

test('review fixes: a numbered plan is not a menu, and the continue floor reads the whole closing text', () => {
  const plan = classify(claude('Plan:\n1. Add the index\n2. Drop the legacy_users table\n3. Run the suite\nShall I proceed?'));
  assert.notEqual(plan.source, 'unmarked-first'); assert.equal(wouldSend(plan).send, null);
  const pick = classify(claude('Two ways:\n1. Add the index\n2. Drop the legacy_users table\nWhich one?'));
  assert.equal(pick.case, 'owner_decision', 'another option holds a hard word: not a default pick');
  const far = classify(claude('Next I will drop the legacy_users table and rebuild it.\n' + 'Phase 1 notes.\n'.repeat(8) + 'Shall I continue?'));
  assert.equal(far.case, 'continue'); assert.ok(far.forbidden, 'the destructive step eight lines up is still seen');
  assert.equal(wouldSend(far).send, null);
});

// ---- the forbidden scan reads the ask, not the pane (the stop that was tagged "sudo" / "Deploy") ------------------
// A stop was escalated because the scan read the whole closing text: an earlier tool line (ssh ... sudo -n -u x ...) and a
// background shell named "...Deploy..." sat above a plain UI question. The filter reads the question, its option labels and the
// STATUS line only: tool-call lines, command outputs and background-task listings are chrome, never the ask.
test('a tool line holding "sudo -n -u x" above a plain UI question is not forbidden', () => {
  const s = classifyStall({ plain: [
    '⏺ Bash(ssh vpt-node1 "sudo -n -u deploy systemctl restart ghosty")',
    '  ⎿  ok',
    '',
    '⏺ The review page is ready.',
    '  Shall I continue with phase 2?',
    '', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE,
  ], state: 'done' });
  assert.equal(s.case, 'continue');
  assert.equal(s.forbidden, null, 'the sudo command line is tool chrome, not the ask');
  assert.deepEqual(wouldSend(s).send, { text: 'Yes, continue.' }, 'a plain question after a sudo tool line still auto-answers');
});

test('a background-shell list mentioning "Deploy" with an exit menu is not forbidden', () => {
  const s = classifyStall({ plain: [
    '⏺ Bash(npm run deploy:watch)',
    '  ⎿  Running in background shell tmux_Deploy_watch_3',
    '',
    '⏺ Everything is merged and the checks are green.',
    '  How do you want to finish?',
    '  1. Exit the session (recommended)',
    '  2. Keep the pane open',
    '', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE,
  ], state: 'done' });
  assert.equal(s.case, 'menu_recommended');
  assert.equal(s.forbidden, null, 'the background-shell listing is chrome, not the ask');
  assert.ok(wouldSend(s).send, 'the exit menu still auto-answers');
});

test('a question that itself asks to deploy is still forbidden', () => {
  const s = classify(claude('The branch is green.\nShall I deploy it to the hosts?'));
  assert.ok(s.forbidden, 'the ask itself names the deploy -- the safety filter still blocks it');
  assert.ok(s.topics?.deploy, 'the deploy topic is set so ops-ask routes it as a manager item');
  assert.equal(wouldSend(s).send, null);
});

// The scoping must not blind the live-menu path: a permission prompt does not end on "?", so the question fallback takes the
// chrome line ("Esc to cancel") and the prompt above the options is the only place the ask is written.
test('a live menu still reads the prompt line above its options', () => {
  const s = classifyStall({ plain: [
    'Run this command? deploy the frontend to production',
    '❯ 1. Yes', "  2. Yes, and don't ask again", '  3. No', 'Esc to cancel',
  ], state: 'waiting' });
  assert.ok(s.forbidden, 'the prompt above the options is the ask -- deploy is still forbidden');
  assert.ok(s.topics?.deploy, 'the deploy topic is set so every key needs a confirm');
  assert.equal(wouldSend(s).send, null);
});
