// Harness review 2026-11-11, Q5 item 3: the keyword floor reads the PROPOSED ACTION (the ask, the option on offer, the command), never the
// narration around it. Cases are shaped on the labelled regression set (389 [hard: X] escalations); host, branch and account names are neutral.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, askHardOf, neutralizeReport, relaxCodeEdits, readAsk, floorAction, forbiddenMatch, ownerFloorMatch } from '../stall.js';
import { opsAsk } from '../ops-ask.js';

const RULE = '─'.repeat(60);
const claude = (body) => ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)), '', '✻ Baked for 1m', RULE, '❯ ', RULE];
const classify = (body) => classifyStall({ plain: claude(body), raw: null, state: 'done' });

test('report forms are not the action: negated, "X no", and finished verbs with no ask word in their clause', () => {
  assert.doesNotMatch(neutralizeReport('Validated no, published no, bugs: none'), /publish/i);
  assert.doesNotMatch(neutralizeReport('Apple TV tile check waits for the IR stick; nothing deleted.'), /delet/i);
  assert.doesNotMatch(neutralizeReport('the login has not dropped so far'), /drop/i);
  assert.doesNotMatch(neutralizeReport('fixes deployed main-2026.11.07-1; no deploy needed, nothing published'), /deploy|publish/i);
  // an ask word earlier in the clause keeps the finished form: it is the request
  assert.match(neutralizeReport('should the old rows be deleted?'), /deleted/);
  assert.match(neutralizeReport('want the table dropped?'), /dropped/);
  assert.match(neutralizeReport('I force-pushed main'), /force-pushed/, 'a force-push report is never neutralized');
  // the present tense and the imperative stay
  assert.match(neutralizeReport('delete the stale backups on <host>?'), /delete/);
  // a sentence boundary survives the edit ("no deploy." keeps its full stop)
  assert.match(neutralizeReport('Still nothing pushed, no merge, no deploy. Then +2 more'), /\. Then/);
});

test('a code or tree edit is not a data deletion; a data object, a pronoun or "all" keeps the verb', () => {
  assert.doesNotMatch(relaxCodeEdits('remove the image checks from node-a, publish v16, then delete both references?'), /remov|delet/i);
  assert.doesNotMatch(relaxCodeEdits('remove the old voice panel and route'), /remov/i);
  for (const t of ['delete the 14 edges from prod tree t-1', 'delete the image references by raw SQL on the 2 DEV rows', 'delete all four TestFlight tiles',
    'delete it', 'remove the panel and the database', 'delete the old backups', 'remove the nearly-clean worktrees']) assert.equal(relaxCodeEdits(t), t, t);
});

test('the owner example of 2026-11-11 07:16: an own-tree edit is not tagged "remove"; the prod publish in the same ask still is', () => {
  const s = classify('Plan below.\nSTATUS: needs-owner: remove the image checks from node-a and node-b, switch the loop to the focused-tile text check, test on stb-a, publish v16, then delete both references? [go / nodes only / hold]');
  assert.equal(askHardOf(s), 'publish');
  assert.equal(readAsk('remove the image checks from node-a and node-b, then delete both references?').match(/remov|delet/i), null);
});

test('narration above the ask no longer makes the stop hard, nor keeps a lease / deploy ask with the owner', () => {
  // 2026-10-15: a "dropped Q166" / "removed the old script" report above a plain plan question
  const s = classify('I set WORKDIR in the start script; the old script was removed and I dropped Q166 since it is resolved.\nThe nightly fresh start still reads the old brief.\nSTATUS: needs-owner: build the CI loop and move tmux into its own unit? [both / CI loop only / neither]');
  assert.equal(s.topics.hard, null);
  assert.equal(askHardOf(s), null);
  assert.equal(s.floorOwner, null);
  assert.equal(s.forbidden, 'removed', 'the auto-answer safety filter still reads the whole text');
  const lease = classify('The run on host-a finished; the stale lock was removed earlier and I dropped Q166.\nSTATUS: needs-owner: claim the host-a lease now, or wait for the queued deploy? [claim / wait]');
  assert.equal(lease.floorOwner, null);
  assert.ok(opsAsk(lease), 'a lease / deploy question is the manager\'s once the narration is not read');
});

test('a hard word in the ask, an option or a command still escalates', () => {
  const del = classify('Disk at 91%.\nSTATUS: needs-owner: delete the stale local backups on the hypervisor (137 GB)? [1 yes, all four (recommended) / 2 keep]');
  assert.equal(askHardOf(del), 'delete');
  assert.equal(opsAsk(del), null);
  const opt = { case: 'owner_decision', status: 'needs-owner', question: 'Which way?', options: [{ n: 1, text: 'git push --force origin feat (recommended)', recommended: true }, { n: 2, text: 'wait' }], topics: {} };
  assert.ok(askHardOf(opt));
  const cmd = classify('Next step below.\nSTATUS: needs-owner: run `sudo visudo -f /etc/sudoers.d/agent` on host-a?');
  assert.ok(cmd.topics.hard, 'a command in the ask is the action');
  const rewrite = classify('Three ways.\nSTATUS: needs-owner: option 1 (accept) / 2 (force 7 commits through) / 3 (history rewrite)');
  assert.ok(rewrite.topics.hard, 'a history rewrite in either word order');
});

test('a question that only points back reads the whole text, as before', () => {
  const s = classify('Next: I will delete the old backups on the storage host and then deploy.\nShall I go ahead with it?');
  assert.ok(s.forbidden);
  const act = floorAction({ case: 'owner_decision', question: 'Shall I do it?' }, 'Plan: delete the old backups.\nShall I do it?');
  assert.match(act, /delete the old backups/);
  // the auto-answer cases keep the whole text (round 9): a "Yes, continue." approves the plan around the question
  assert.equal(floorAction({ case: 'continue', question: 'Continue?' }, 'Next I delete X.\nContinue?'), 'Next I delete X.\nContinue?');
});

test('a reported data loss is an incident the owner hears about, in any spelling', () => {
  const a = classify('Should I merge feat into main? Note: the customer\'s data was wiped by the migration.');
  assert.ok(a.topics.hard || a.floorOwner);
  const b = classify('Should I merge feat into main? The backups were d e l e t e d already.');
  assert.ok(b.topics.hard || b.floorOwner);
});

test('asks the narration used to catch by luck: named logins and keys, money amounts, a client host, owner-only hands', () => {
  for (const t of ['may I read the balance with your Claude login token?', 'it needs an Anthropic Admin key from your console', 'create the Google Cloud OAuth client',
    'play one live game with a $0.25 cap?', 'run patch-3 on the client with the commands above', 'supply a valid web test account', 'approve the retention change (keep-last=1)'])
    assert.ok(forbiddenMatch(t) && ownerFloorMatch(t), t);
  for (const t of ['send the 6 digits from the SMS', 'connect a real Android TV device to a lab host', 'a phone plugged into a host', 'power on the house host'])
    assert.ok(ownerFloorMatch(t), t);
  // a shell variable is not money
  assert.equal(forbiddenMatch("awk '{print $1}' then $2"), null);
});
