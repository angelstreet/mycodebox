import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, wouldSend, applyJev, ASK_STATUS_TEXT } from '../stall.js';

const RULE = '─'.repeat(60);
// A synthetic Claude Code pane: reply, turn timer, input box, footer. Fixtures are paraphrases.
function claude(body) {
  const lines = ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`))];
  lines.push('', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)');
  return lines;
}
const cls = (body, state = 'done') => classifyStall({ plain: claude(body), state });

test('stopped_short: announces the next step and stops (flagged real stop, paraphrased)', () => {
  const s = cls("Next improvement: I'll start adding the script's arguments to what the judge sees, so a case like this becomes visible. Once it's built I'll rerun the backfill and the judges to check it helps before it changes any verdicts.");
  assert.equal(s.case, 'stopped_short');
  assert.equal(s.source, 'rule');
  assert.deepEqual(wouldSend(s).send, { text: 'Yes, continue.' });
  assert.equal(wouldSend(s).why, 'stopped_short');
});

test('stopped_short variants', () => {
  for (const t of ["Parser is in. Next I'll wire it into the reader.", "Tests are written. I'll do the cleanup pass next.", "Once the build is green I'll rerun the suite."]) {
    assert.equal(cls(t).case, 'stopped_short', t);
  }
});

test('stopped_short about a forbidden topic is never sent', () => {
  const s = cls("Branch is ready. I'll deploy it to the hosts next.");
  assert.equal(s.case, 'stopped_short');
  assert.equal(wouldSend(s).send, null);
  assert.match(wouldSend(s).why, /forbidden: deploy/);
});

test('look-alikes that must not become stopped_short', () => {
  const not = [
    "Refactor finished and tested. I'll wait for your answer before deploying.",
    "That is all for now. I'm stopping here.",
    "I'll wait for you to pick a direction.",
    "I'll report the result once the run finishes.",
    "As soon as you give me the address, I'll resume.",
    "Phase 1 is done. Do you want me to start phase 2?",
    "Blocked: I can't reach the box. I'll retry when it is back.",
    "If you want, I'll add a retry too.",
  ];
  for (const t of not) assert.notEqual(cls(t).case, 'stopped_short', t);
  assert.equal(cls('Phase 1 is done. Do you want me to start phase 2?').case, 'continue');
});

test('waiting_deploy: restart blocked by live runs, scope and ref hinted, never sent', () => {
  const s = cls('Not deployed yet: the proxy timeout fix (600 s) is in main but needs a server restart, blocked by two live runs (one ~30 min, one ~2 h). I\'ll do the server deploy once those leases clear, if you want. My lease is released.');
  assert.equal(s.case, 'waiting_deploy');
  assert.deepEqual(s.deployHint, { scope: 'server', ref: 'main' });
  assert.equal(wouldSend(s).send, null);
  assert.equal(wouldSend(s).why, 'deploy waiting');
});

test('waiting_deploy: waiting on a go-ahead for update_core --host', () => {
  const s = cls("I'm still waiting on your go-ahead for update_core main --host. It restarts every host. Once you approve, I'll check leases, deploy, then update the entry edge, rerun generation and validate.");
  assert.equal(s.case, 'waiting_deploy');
  assert.deepEqual(s.deployHint, { scope: 'host', ref: 'main' });
  assert.equal(wouldSend(s).send, null);
  assert.equal(s.no_status, false);
});

test('waiting_deploy without a hint has an empty hint; a plain continue-question is not one', () => {
  const s = cls('Fix is merged. Waiting for the leases to clear before I can restart.');
  assert.equal(s.case, 'waiting_deploy');
  assert.deepEqual(s.deployHint, {});
  assert.equal(cls('Phase 1 passes. Shall I continue with phase 2?').case, 'continue');
});

test('owner_action: reload the page (flagged real stop, paraphrased)', () => {
  const s = cls("Review page: the earlier fixes are live, so reload it. You'll see one Yes and one Fix per sample, and the counts update as you go.");
  assert.equal(s.case, 'owner_action');
  assert.equal(s.action, 'reload the review page');
  assert.equal(wouldSend(s).send, null);
  assert.equal(s.no_status, false);
});

test('owner_action variants: plug, press, check the phone', () => {
  assert.equal(cls('Everything is wired. Please plug the capture dongle back in, then I can test.').case, 'owner_action');
  assert.equal(cls('Done on my side. Press the power button on the TV and tell me what you see.').case, 'owner_action');
  assert.match(cls('Installed. Can you check the phone for the prompt?').action, /check the phone/);
});

test('owner_action look-alike: describing what the agent pressed is not a request', () => {
  assert.notEqual(cls('The test pressed the OK button and the page reloaded. All 12 checks pass, nothing left.').case, 'owner_action');
});

test('no_status: a few lines of what changed, nothing about tested or left', () => {
  const s = cls('Changed the retry delay to 5 s.\nRenamed the helper to fetchTree.\nMoved the constants to their own module.');
  assert.equal(s.case, 'done');
  assert.equal(s.no_status, true);
  assert.deepEqual(s.answer, { text: ASK_STATUS_TEXT });
  assert.equal(wouldSend(s).why, 'ask_status');
});

test('no_status is false when the text says what is done / tested / left', () => {
  assert.equal(cls('Changed the retry delay. All 12 tests pass. Nothing left.').no_status, false);
  assert.equal(cls('Moved the constants. Not tested yet.').no_status, false);
  const asked = cls('Which of the two layouts do you prefer?');
  assert.equal(asked.no_status, false);
  assert.equal(asked.case, 'owner_decision');
});

test('no_status only on finished turns; a live menu has none', () => {
  const s = classifyStall({ plain: ['Allow this edit?', '1. Yes', '2. No'], state: 'waiting' });
  assert.equal(s.no_status, undefined);
});

test('a Jev "ask_owner" on a statusless done turn drops the ask_status candidate', () => {
  const s = applyJev(cls('Changed the retry delay.\nRenamed a helper.'), 'ask_owner');
  assert.equal(s.answer, null);
  assert.equal(wouldSend(s).send, null);
});

test('existing cases keep working', () => {
  assert.equal(cls('Which one do you prefer, A or B?').case, 'owner_decision');
  assert.equal(cls('Phase 1 done and tested. Anything else left? Shall I continue?').case, 'continue');
});
