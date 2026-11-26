// Reflection after an accepted done (owner 2026-11-26, reflection.js): "when a task is done we should always have that reflection, if and only if
// the goal was met: any leftover, suggestion of improvements". Asked once; never for a done that is not accepted; the reply is not questioned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createGoalGate, reflectionEligible } from '../goal-check.js';
import { createDoneCheck } from '../done-check.js';
import { createFinalAccept } from '../final-accept.js';
import { isReflectionAsk, reflectionQuestion, ASK_WORDS } from '../reflection.js';
import { ambiguousAnswer, bareNumbersOk, createSuggestions, suggestionsIn, saysNoSuggestions, answersOf, isOwnerTyped, createTypedLog } from '../suggestions.js';
import { createGoalStore, approvedRound, worthAGoal } from '../goal-check.js';
import { MAX_ASKS_PER_TICK, ASK_MAX_LOAD_PER_CORE } from '../done-check.js';
import { displayState } from '../public/state.js';
import { isOwnersTurn } from '../public/ask-model.js';
import { deriveButtons, needsOwner } from '../public/buttons.js';
import { stopOptions, stopItem } from '../voice.js';
import { pushableItems } from '../done-leftovers.js';
import { classifyStall } from '../stall.js';

const GOAL = 'Fix the lease deploy catch-up so a strict multi-host catch-up no longer blocks claims on every host';
const REVIEW = 'closing review: docs REFERENCE.md, release note none needed: test fixture · leftovers none · unverified none · bugs: none';
const DONE = `STATUS: done — catch-up fixed · goal: achieved · evidence: int-1a1cbfa071 · ${REVIEW}`;
const PARTS = ['catch-up no longer blocks claims', 'merged through the lane'];
const ROWS = 'Verification:\n1. pass — test/lease-service.test.js:40\n2. pass — int-1a1cbfa071\n';
const VERIFIED = ROWS + DONE;
const REPLY = `Goal: ${GOAL}. Reached.\n- catch-up fixed in lease-service.js:120, test/lease-service.test.js 12/12\n- merged int-1a1cbfa071\n${DONE.replace('catch-up fixed', 'catch-up fixed, proven')}`;
const ANSWER = [
  'Leftovers: none', '', 'Suggestions:', 'Worth doing:', '1. show the held host in the lease view (an owner could not tell why a claim waited)',
  '2. add a test for two catch-ups at once', 'Smaller:', '3. shorter journal rows', 'Recommendation: 1 and 2. Should I do them?', '',
  `STATUS: needs-owner: ${ASK_WORDS} — should I do 1 and 2?`,
].join('\n');
const STATUS_ONLY = 'STATUS: needs-owner: improvement suggestions above, nothing built — should I do 6?';
const day0 = Date.parse('2026-11-26T09:00:00Z');

function rig({ parts = [], goal = GOAL, ...over } = {}) {
  const dir = tmp('reflect-'), records = [], sent = [], resolved = [];
  let t = day0;
  const ledger = createSuggestions({ stateDir: dir, now: () => t, active: () => (over.reflectMode?.() ?? 'live') === 'live' && (over.mode?.() ?? 'live') === 'live', onResolved: (n, how) => resolved.push([n, how]) });
  const gate = createGoalGate({ stateDir: dir, goalOf: async () => goal, partsOf: async () => parts, suggestions: ledger, record: async (e) => { records.push(e); }, now: () => t, ...over });
  const sessions = [], panes = new Set();
  const check = (extra = {}) => createDoneCheck({ stateDir: dir, git: async () => { throw new Error('not a repo'); }, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); },
    now: () => t, goalGate: gate, goalEntryOf: () => (parts.length ? { goal, parts } : null), liveNames: async () => [...panes, ...sessions.map((s) => s.name)], ...extra });
  const dc = check();
  const turn = (text, name = 'a', more = {}) => { t += 6 * 60e3; panes.add(name); sessions.length = 0; sessions.push({ name, cwd: '/w/a', text, doneAt: t, ...more }); };
  const working = () => { t += 6 * 60e3; sessions.length = 0; };
  const journal = () => readFileSync(join(dir, 'goal-check.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // what the server does with every hand-over turn it reads
  const read = (text, name = 'a') => ledger.observe(name, text, { at: t });
  const hold = (text, name = 'a') => ledger.hold(name, text, { at: t });
  return { dir, gate, ledger, resolved, read, hold, dc, check, turn, working, sent, records, journal, sessions, panes, now: () => t, advance: (ms) => { t += ms; } };
}
const reflections = (sent) => sent.filter(([, x]) => x.startsWith('Reflection ('));

test('the question: leftovers and suggestions apart; any item ends needs-owner, workers too; only `no suggestions` stays done; fits the Mac answer', () => {
  const q = reflectionQuestion();
  assert.ok(q.length < 2000, `${q.length} characters`);
  assert.match(q, /\(a\) Leftovers of THIS task.*your done is then not final\. Fix them now/);
  assert.match(q, /\(b\) Improvement suggestions.*build NONE of them and file none/);
  for (const re of [/`Worth doing:`/, /`Smaller:`/, /`Recommendation: <which numbers and why>\. Should I do them\?`/]) assert.match(q, re);
  assert.match(q, /With ANY item, worth doing or smaller, end `STATUS: needs-owner: improvement suggestions above, nothing built — should I do <numbers>\?`: the OWNER answers yes or no per item, also when you are a worker \(not the manager, not a peer\)/);
  assert.match(q, /`no suggestions`.*That is the only reply that leaves you done\.$/);
  assert.doesNotMatch(q, /needs-manager/);
});

test('eligible: only a done with the goal met and nothing open; partial, failed, blocked, waiting and open lines are not', () => {
  assert.equal(reflectionEligible(DONE, { goal: GOAL }), true);
  assert.equal(reflectionEligible(VERIFIED, { goal: GOAL, parts: PARTS }), true);
  for (const text of [
    'STATUS: failed — goal not achieved: x · tried: y · cause: z · plan: w', 'STATUS: blocked: x · tried: y · need: z', 'STATUS: waiting: integration int-1a1cbfa071',
    'STATUS: partial — half', 'STATUS: needs-manager: pick one', 'STATUS: running: job b1234567 — tests',
    'STATUS: done — merged, the deploy is not done yet · ' + REVIEW,
    DONE.replace('leftovers none', 'leftovers bug-1a2b3c4d'), DONE.replace('unverified none', 'unverified the Mac path'),
  ]) assert.equal(reflectionEligible(text, { goal: GOAL }), false, text);
  assert.equal(reflectionEligible(DONE, { goal: GOAL, parts: PARTS }), false, 'stored Done-when lines without a Verification block');
  assert.equal(reflectionEligible(VERIFIED.replace('2. pass', '2. not checked'), { goal: GOAL, parts: PARTS }), false);
});

test('done-check: every Verification row passes (goal question skipped) -> the reflection, exactly once; the reply asks nothing more', async () => {
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED);
  const first = await r.dc.tick();
  assert.deepEqual(first.goalCheck.accepted, ['a']);
  assert.deepEqual(first.goalCheck.reflected, ['a']);
  assert.deepEqual(first.goalCheck.asked, [], 'no goal question');
  await r.dc.tick();                     // same turn
  r.advance(30 * 60e3); await r.dc.tick();
  r.working(); await r.dc.tick();        // the session writes its reply
  r.turn(ROWS + DONE + '\nno suggestions'); await r.dc.tick();
  r.turn('no suggestions\n' + VERIFIED); await r.dc.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(reflections(r.sent).length, 1);
  assert.equal(r.journal().filter((x) => x.kind === 'reflect').length, 1);
});

test('done-check: after a passed goal check -> the reflection, once; the busy turns between do not lose the state', async () => {
  const r = rig();
  r.turn(DONE); await r.dc.tick();
  assert.match(r.sent[0][1], /^Goal check: Goal as given/);
  r.working(); await r.dc.tick();        // before the fix the goal gate forgot the session here and asked it again
  r.turn(REPLY);
  const second = await r.dc.tick();
  assert.deepEqual(second.goalCheck.accepted, ['a']);
  assert.deepEqual(second.goalCheck.reflected, ['a']);
  assert.match(r.sent[1][1], /^Reflection \(/);
  r.working(); await r.dc.tick();
  r.turn(`Leftovers: none\nno suggestions\n${DONE}`); await r.dc.tick(); await r.dc.tick();
  assert.equal(r.sent.length, 2, 'no second goal question, no second reflection');
  // a leftover found by the reflection is fixed and the done line written again: nothing more is asked
  r.turn(DONE.replace('catch-up fixed', 'catch-up fixed, leftover fixed too')); await r.dc.tick();
  assert.equal(r.sent.length, 2);
});

test('done-check: failed, blocked, waiting, partial and a bounced done get no reflection', async () => {
  for (const text of [
    'STATUS: failed — goal not achieved: x · tried: y · cause: the lane · plan: me', 'STATUS: blocked: x · tried: y · need: z', 'STATUS: waiting: integration int-1a1cbfa071', 'STATUS: partial — half done',
    'STATUS: done — merged',                                             // no closing review
    DONE.replace('leftovers none', 'leftovers bug-1a2b3c4d'),            // something open
    'STATUS: done — merged, the deploy is not done yet · ' + REVIEW,      // done but failed
    VERIFIED.replace('2. pass', '2. fail'),                              // a Verification row fails
  ]) {
    const r = rig({ parts: /Verification/.test(text) ? PARTS : [] });
    r.turn(text); await r.dc.tick(); r.advance(10 * 60e3); await r.dc.tick();
    assert.equal(reflections(r.sent).length, 0, text);
  }
  // a goal reply that is rejected, and the cap after it
  const r = rig();
  r.turn(DONE); await r.dc.tick();
  r.turn('yes\nSTATUS: done — x · ' + REVIEW); await r.dc.tick();
  assert.match(r.sent[1][1], /your reply is not accepted/);
  r.turn('really\nSTATUS: done — y · ' + REVIEW); await r.dc.tick();
  r.turn('truly\nSTATUS: done — z · ' + REVIEW); await r.dc.tick();
  assert.equal(reflections(r.sent).length, 0);
});

test('done-check: a result the manager accepted as final gets no reflection, verified or not', async () => {
  for (const parts of [[], PARTS]) {
    const r = rig({ parts });
    const final = createFinalAccept({ stateDir: r.dir });
    final.accept('a', { by: 'manager-agent' });
    const dc = r.check({ finalAccepted: (n) => final.has(n) });
    r.turn(parts.length ? VERIFIED : DONE); await dc.tick(); await dc.tick();
    assert.equal(r.sent.length, 0);
  }
});

test('done-check: a failed send is retried and counted once; dry, off and a draft send nothing', async () => {
  for (const parts of [[], PARTS]) {
    const r = rig({ parts });
    let fail = true;
    const dc = r.check({ send: async (n, x) => { if (fail && x.startsWith('Reflection (')) throw new Error('pane busy'); r.sent.push([n, x]); }, log: { error() {} } });
    if (!parts.length) { r.turn(DONE); await dc.tick(); r.turn(REPLY); } else r.turn(VERIFIED);
    await dc.tick();
    assert.equal(reflections(r.sent).length, 0);
    fail = false; await dc.tick(); await dc.tick();
    assert.equal(reflections(r.sent).length, 1, `parts ${parts.length}`);
    assert.equal(r.sent.filter(([, x]) => x.startsWith('Goal check')).length, parts.length ? 0 : 1);
  }
  for (const over of [{ reflectMode: () => 'dry' }, { reflectMode: () => 'off' }, { mode: () => 'off' }]) {
    const r = rig({ parts: PARTS, ...over });
    r.turn(VERIFIED); await r.dc.tick(); assert.equal(r.sent.length, 0);
  }
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED, 'a', { draft: true }); await r.dc.tick();
  assert.equal(r.sent.length, 0);
});

test('rollout and reuse: a done turn from before the rollout is not asked; a new session under the name, or another goal, is', async () => {
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED); r.sessions[0].doneAt = day0 - 3600e3; await r.dc.tick();
  assert.equal(r.sent.length, 0);
  r.turn(VERIFIED); await r.dc.tick();
  assert.equal(r.sent.length, 1);
  await r.gate.drop('a');
  r.turn(VERIFIED); await r.dc.tick();
  assert.equal(r.sent.length, 2);
  // gone for good: the state goes with the pane
  r.panes.clear(); r.working(); await r.dc.tick();
  assert.deepEqual((await r.gate.snapshot()).sessions, {});
  r.turn(VERIFIED); await r.dc.tick();
  assert.equal(r.sent.length, 3);
});

test('the answer with choices: an owner\'s turn with no auto-answer words; the list is not read as leftovers', () => {
  const lines = ANSWER.split('\n');
  const c = classifyStall({ plain: lines, state: 'done', fromReport: true });
  assert.equal(c.case, 'owner_decision');
  assert.equal(c.status, 'needs-owner');
  assert.equal(c.answer, null);
  assert.equal(isReflectionAsk(ANSWER), true);
  // topic words in a suggestion do not turn the fixed line into a merge or system wait
  const t = ANSWER.replace('add a test for two catch-ups at once', 'merge the two deploy checks, then push and deploy');
  const c2 = classifyStall({ plain: t.split('\n'), state: 'done', fromReport: true });
  assert.equal(c2.case, 'owner_decision');
  assert.ok(!c2.systemWait);
  assert.equal(isReflectionAsk('STATUS: needs-owner: may I delete the old reports?'), false);
  assert.equal(isReflectionAsk('STATUS: done — improvement suggestions above'), false);
  // as a done reply (nothing worth doing) the leftovers watcher and done-check (B) find nothing to push
  assert.equal(pushableItems(`Leftovers: none\n\nSuggestions:\nWorth doing: none\nSmaller:\n1. shorter journal rows\nRecommendation: none.\n${DONE}`), null);
});

// ---- no done while a suggestion has no yes / no from the owner (owner 2026-11-26: "we should not say done until i say yes or no") ----
// the real turn of the owner's report (mcp-server-audit, 2026-11-26)
const AUDIT = [
  'Improvements raised by the audit that no worker has taken on:',
  '  • the prompt grew about 400 tokens since last night, from something',
  '    other than the descriptions;',
  '  • the screenshot-description answer took about 390 s;',
  '  • 105 tools sit on web routes with no permission check of their own.',
  '', DONE,
].join('\n');

test('reading lists: any wording, worth doing and smaller; a release note about improvements, a made list and "no suggestions" are not items', () => {
  assert.deepEqual(suggestionsIn(AUDIT).map((i) => i.text.slice(0, 30)), ['the prompt grew about 400 toke', 'the screenshot-description ans', '105 tools sit on web routes wi']);
  assert.deepEqual(suggestionsIn(ANSWER).map((i) => [i.num, i.tier]), [[1, 'worth'], [2, 'worth'], [3, 'smaller']]);
  assert.deepEqual(suggestionsIn('Smaller:\n1. shorter journal rows\n' + DONE).map((i) => i.tier), ['smaller']);
  assert.equal(suggestionsIn('Suggestions: add a retry on the walk\n' + DONE).length, 1);
  assert.equal(suggestionsIn('**Possible improvements**:\n- one\n- two\n' + DONE).length, 2);
  for (const text of ['Leftovers: none\nno suggestions\n' + DONE, 'Improvements shipped:\n- a faster list\n' + DONE, 'Suggestions: none\n' + DONE,
    'STATUS: done — x · closing review: docs release note (Improvements and Bug fixes lines) · leftovers none', ROWS + DONE,
    'Smaller changes:\n- error handling was tightened\n' + DONE, 'Smaller points:\n- if the step fails the script stops\n' + DONE]) assert.deepEqual(suggestionsIn(text), [], text);
  assert.equal(saysNoSuggestions('Leftovers: none\n\n**no suggestions**\n' + DONE), true);
  assert.equal(saysNoSuggestions('I have no suggestions about the other area.\n' + DONE), false);
});

test('the owner answers per item; a task, a question or a bare ok is not an answer', () => {
  const open = [1, 2, 3];
  const y = 'yes', n = 'no';
  for (const [text, want] of [
    ['yes 1 3, no 2', { 1: y, 2: n, 3: y }], ['1 yes, 2 no', { 1: y, 2: n }], ['1: yes 2: no', { 1: y, 2: n }], ['do 1 and 3', { 1: y, 3: y }],
    ['no all', { 1: n, 2: n, 3: n }], ['none', { 1: n, 2: n, 3: n }], ['yes', { 1: y, 2: y, 3: y }], ['no', { 1: n, 2: n, 3: n }], ['do them all', { 1: y, 2: y, 3: y }],
    ['only 1', { 1: y, 2: n, 3: n }], ['do 1, no to the rest', { 1: y, 2: n, 3: n }], ['no 2-3', { 2: n, 3: n }], ['do not do 2', { 2: n }], ['do 1 but not 3', { 1: y, 3: n }],
    ['Do 1 and 2. No to 3.', { 1: y, 2: y, 3: n }], ['ok no all', { 1: n, 2: n, 3: n }],
    ['ok', null], ['continue', null], ['1', null], ['what does 2 mean?', null], ['do task 3 of the doc', null], ['yes 7', null], ['fix the build and push', null],
  ]) assert.deepEqual(answersOf(text, open), want, text);
  assert.equal(answersOf('yes', []), null);
});

test('record: held from the done line until `no suggestions`; with items until every one has the owner\'s yes or no; the session cannot remove them', async () => {
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED); r.read(VERIFIED);
  assert.deepEqual(r.hold(VERIFIED), { state: 'pending' }, 'before the question: not done yet');
  await r.dc.tick(); r.read(VERIFIED);
  assert.deepEqual(r.hold(VERIFIED), { state: 'pending' }, 'asked, no reply yet');
  r.turn('Leftovers: none\nno suggestions\n' + VERIFIED); r.read('Leftovers: none\nno suggestions\n' + VERIFIED);
  assert.equal(r.hold(VERIFIED), null);
  assert.deepEqual(r.resolved, [['a', 'none']]);
  // the journal counts the replies, whatever STATUS they end on
  assert.deepEqual(readFileSync(join(r.dir, 'suggestions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((x) => (x.asked ? 'asked' : `reply:${x.reply}`)), ['asked', 'reply:none']);

  const w = rig({ parts: PARTS });
  w.turn(VERIFIED); await w.dc.tick();
  w.turn(ANSWER); w.read(ANSWER);
  assert.deepEqual([w.hold(ANSWER).state, w.hold(ANSWER).open], ['open', 3]);
  // the session drops the list and says there is nothing: the items stay
  const dodge = 'no suggestions\n' + VERIFIED;
  w.turn(dodge); w.read(dodge);
  assert.equal(w.hold(dodge).open, 3);
  assert.deepEqual(w.resolved, []);
  assert.equal(w.ledger.awaiting('a'), true);
  // one item at a time
  assert.deepEqual(w.ledger.ownerMessage('a', 'yes 1', { via: 'dashboard' }).open, 2);
  assert.equal(w.hold(dodge).state, 'open');
  const end = w.ledger.ownerMessage('a', 'no to the rest', { via: 'typed' });
  assert.deepEqual([end.open, end.approved.map((i) => i.n)], [0, []], 'a no starts nothing new');
  assert.deepEqual(w.hold(dodge), { state: 'pending' }, 'approved work is not finished: not clear yet');
  assert.deepEqual(w.ledger.get('a').items.map((i) => [i.n, i.answer, i.by, i.via]), [[1, 'yes', 'owner', 'dashboard'], [2, 'no', 'owner', 'typed'], [3, 'no', 'owner', 'typed']]);
  assert.deepEqual(w.resolved, []);
  const only = rig({ parts: PARTS });
  only.turn(ANSWER); only.read(ANSWER); only.ledger.ownerMessage('a', 'no all');
  assert.equal(only.hold(dodge), null, 'all no: it can end done');
  assert.deepEqual(only.resolved, [['a', 'answered']]);
  // the same list shown again is not reopened; the record survives a restart
  w.turn('Built 1.\n' + ANSWER); w.read('Built 1.\n' + ANSWER);
  assert.equal(w.ledger.openOf('a').length, 0);
  assert.equal(createSuggestions({ stateDir: w.dir }).get('a').items.length, 3);
});

test('a list outside the reflection reply (above a done line) opens items: told to end needs-owner, once per turn; running turns and old turns are not read', async () => {
  const r = rig({ parts: PARTS });
  r.turn(AUDIT); r.read(AUDIT);
  assert.deepEqual([r.hold(AUDIT).state, r.hold(AUDIT).open], ['open', 3]);
  const dc = r.check({ goalEntryOf: () => null });
  const tick = await dc.tick(); await dc.tick();
  assert.deepEqual(tick.goalCheck.suggestions, ['a']);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0][1], /you cannot be done, 3 improvement suggestion.*end `STATUS: needs-owner: improvement suggestions above.*Only the owner answers.*writing `no suggestions` now does not remove them/);
  const other = rig();
  other.turn('Suggestions:\n1. x\nSTATUS: running: job b1234567 — tests', 'b'); other.read('Suggestions:\n1. x\nSTATUS: running: job b1234567 — tests', 'b');
  assert.equal(other.hold('x', 'b'), null);
  assert.equal(other.ledger.observe('b', AUDIT, { at: day0 - 3600e3 }).added.length, 0, 'a turn from before the rule');
});

test('a reply that answers neither way is asked once more and stays not done', async () => {
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED); r.read(VERIFIED); await r.dc.tick();
  const silent = 'All good.\n' + VERIFIED;
  r.turn(silent); r.read(silent); await r.dc.tick(); await r.dc.tick();
  r.turn('Really.\n' + VERIFIED); r.read('Really.\n' + VERIFIED); await r.dc.tick();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1][1], /your reply does not answer the reflection question, so you are not done/);
  assert.deepEqual(r.hold(silent), { state: 'pending' });
});

test('the dashboard: open suggestions read as the owner\'s turn, a pending reflection question still reads done (not green), workers too', () => {
  const row = (extra) => ({ state: 'done', stall: { case: 'done', source: 'rule', status: 'done', no_status: false }, ...extra });
  assert.equal(displayState(row()), 'done');
  assert.equal(displayState(row({ suggestions: { state: 'pending' } })), 'done', 'not asked yet: the led stays done, it turns green only when the question really runs');
  const open = row({ suggestions: { state: 'open', open: 2 } });
  assert.equal(displayState(open), 'waiting');
  assert.equal(isOwnersTurn(open), true);
  assert.equal(isOwnersTurn({ ...open, managerSession: false, stall: { ...open.stall, escalatedTo: 'manager' } }), true);
  assert.equal(displayState({ ...open, state: 'idle' }), 'waiting');
  assert.equal(displayState({ ...open, state: 'working' }), 'working');
  assert.equal(isOwnersTurn(row({ suggestions: { state: 'pending' } })), false);
});

test('each yes starts its work at once, keeps the unfinished approvals in the new task, and drops them once that work is asked about', () => {
  const r = rig();
  r.turn(ANSWER); r.read(ANSWER);
  const first = r.ledger.ownerMessage('a', 'yes 2');
  assert.deepEqual([first.open, first.approved.map((i) => i.n)], [2, [2]], 'two items still open, and the approved one starts');
  assert.deepEqual(r.ledger.ownerMessage('a', 'yes 1').approved.map((i) => i.n).sort(), [1, 2]);
  r.ledger.asked('a', DONE);   // the approved work's done was accepted
  assert.deepEqual(r.ledger.ownerMessage('a', 'yes 3').approved.map((i) => i.n), [3]);
});

test('a command that printed a list is not the session speaking: only what follows the last tool call is read', () => {
  const pane = [
    'Bash(cd repo && node -e "print(suggestionsIn(list))" )', '  ⎿  Suggestions:', "     1. [ 6, 'worth', 'Ask the question sooner' ]", '     … +16 lines (ctrl+o to expand)',
    'The list parses as intended.', STATUS_ONLY,
  ].join('\n');
  assert.deepEqual(suggestionsIn(pane), []);
  assert.deepEqual(suggestionsIn('…) ⎿  Suggestions:\n      1. printed by a command\nDone.\n' + STATUS_ONLY), []);
  assert.equal(suggestionsIn(pane.replace('The list parses as intended.', 'Suggestions:\n1. a real one')).length, 1);
});

test('the questions go out sooner: they pass at a load that holds back other pushes, with their own cap; bounces keep the old limits', async () => {
  const r = rig({ parts: PARTS });
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, cwd: '/w/a', text: VERIFIED }));
  const loaded = r.check({ pressure: () => ({ loadPerCore: 2.2, ramAvailPct: 60 }), listDone: async () => six.map((s) => ({ ...s, doneAt: r.now() + 1000 })), goalEntryOf: () => ({ goal: GOAL, parts: PARTS }) });
  r.advance(60e3);
  const t = await loaded.tick();
  assert.equal(t.goalCheck.reflected.length, MAX_ASKS_PER_TICK);
  const busy = r.check({ pressure: () => ({ loadPerCore: ASK_MAX_LOAD_PER_CORE + 1, ramAvailPct: 60 }) });
  r.turn(VERIFIED, 'z');
  assert.equal((await busy.tick()).goalCheck.reflected.length, 0, 'a really busy host still waits');
  assert.equal(typeof loaded.soon, 'function');
});

test('soon(): one early tick, however many sessions finish together', async () => {
  let ticks = 0;
  const dc = createDoneCheck({ stateDir: tmp('soon-'), git: async () => '', listDone: async () => { ticks++; return []; }, send: async () => {}, log: { error() {} } });
  dc.soon(20); dc.soon(20); dc.soon(20);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(ticks, 1);
  dc.stop();
});

test('a session without a goal takes the first real task the owner types: not a command, a yes or a word of steering', () => {
  for (const t of ['continue', 'yes all', 'yes 1 3, no 2', '/compact the conversation now please', 'ok do it now', 'Stop hook feedback: do the thing again now', 'no to the rest of them please']) assert.equal(worthAGoal(t), false, t);
  assert.equal(worthAGoal('show the model and effort in the dock for every Claude session'), true);
  const goals = createGoalStore({ stateDir: tmp('first-goal-') });
  const g = goals.capture('ghosty', 'review the menu and tell me what we can remove:\n1. rules\n2. usage', 'first-owner-prompt', { goalOnly: true });
  assert.match(g.goal, /^review the menu/);
  assert.deepEqual([g.parts, g.timeBoxMs], [[], null], 'a prompt typed mid-session is not a brief');
});

test('popup, notification and voice buttons say what they approve: no generic "Yes, continue" while suggestions are open', () => {
  const stall = { id: 's1', case: 'owner_decision', status: 'needs-owner', question: 'improvement suggestions above, nothing built — should I do 1?', excerpt: ANSWER };
  const held = { state: 'open', open: 2, items: [{ n: 1, text: 'add a retry' }, { n: 2, text: 'shorter rows' }] };
  const d = deriveButtons({ state: 'done', stall, triage: { ai: { proposed_reply: 'Yes, do 1.' } }, suggestions: held });
  assert.deepEqual(d.buttons.map((b) => [b.label, b.text]), [['Yes to all 2', 'yes all'], ['No to all 2', 'no all'], ['✎ yes / no per item…', undefined]]);
  assert.match(d.buttons[0].desc, /1\. add a retry · 2\. shorter rows/);
  assert.deepEqual(stopOptions({ state: 'done', stall, suggestions: held }).options.map((o) => [o.label, o.answer.text]), [['Yes to all 2', 'yes all'], ['No to all 2', 'no all']]);
  for (const b of d.buttons.filter((x) => x.text)) assert.ok(answersOf(b.text, [1, 2]), b.text);
  // a list above a plain done line asks too, by voice as well
  const done = { state: 'done', stall: { ...stall, case: 'done', status: 'done', question: 'catch-up fixed' }, suggestions: held };
  assert.equal(needsOwner(done), true);
  assert.equal(stopItem('a', done)?.options.length, 2);
  assert.ok(deriveButtons({ state: 'done', stall }).buttons.every((b) => !/to all/.test(b.label)), 'other stops keep their buttons');
});

test('approved items are a new task: its goal and Done-when lines are the approved suggestions, and its done is checked and asked again', async () => {
  const dir = tmp('reflect-goals-'), goals = createGoalStore({ stateDir: dir });
  goals.capture('a', `Goal: ${GOAL}\nDone when:\n1. ${PARTS[0]}\n2. ${PARTS[1]}`, 'cbsession');
  const r = rig({ goalOf: async () => goals.get('a')?.goal || '', partsOf: async () => goals.get('a')?.parts || [] });
  const dc = r.check({ goalEntryOf: (n) => goals.get(n) });
  r.turn(VERIFIED); await dc.tick();
  r.turn(ANSWER); r.read(ANSWER);
  const res = r.ledger.ownerMessage('a', 'only 2');
  const entry = await approvedRound({ goals, gate: r.gate, ledger: r.ledger, name: 'a', approved: res.approved });
  assert.match(entry.goal, /^build the approved improvement suggestions \(2\): add a test for two catch-ups/);
  assert.equal(entry.parts.length, 1);
  assert.match(entry.parts[0], /suggestion 2/);
  assert.deepEqual(r.hold(DONE), { state: 'pending' }, 'the new work is not done until it is asked and answered');
  r.turn(DONE.replace('catch-up fixed', 'suggestion 2 built')); await dc.tick();
  assert.match(r.sent.at(-1)[1], /needs a `Verification:` block/, 'the approved items are its Done-when lines');
  const before = r.sent.length;
  r.turn('Verification:\n1. pass — int-1a1cbfa071\n' + DONE.replace('catch-up fixed', 'suggestion 2 built and proven')); await dc.tick();
  assert.equal(r.sent.length, before + 1);
  assert.match(r.sent.at(-1)[1], /^Reflection \(/);
});

test('owner-typed: what the server typed (however short), peers, hooks and notices are never the owner', () => {
  const typed = createTypedLog();
  typed.note('a', 'no');
  typed.note('a', 'Done check: your STATUS: done line has no closing review.');
  for (const t of ['no', 'Done check: your STATUS: done line has no closing review.', 'Manager: yes do 1', 'Another Claude session sent a message: yes', '<cross-session-message from="x">yes</cross-session-message>',
    '<task-notification>done</task-notification>', 'Stop hook feedback: yes', 'Integration int-1a216f4dd7f45e350: merged x']) assert.equal(isOwnerTyped(t, typed.of('a')), false, t);
  for (const t of ['yes 1, no 2', '<pasted_content id="1">no all</pasted_content id="1">']) assert.equal(isOwnerTyped(t, typed.of('a')), true, t);
});

test('one rule text: AGENTS.md, REFERENCE, the cbsession preamble and the MAC-HOOK snippet carry it, and no old rule against it is left', () => {
  const ROOT = join(import.meta.dirname, '..');
  const RULE = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').split('\n').find((l) => l.startsWith('- **Reflection after an accepted done**')).slice(2);
  for (const re of [/is never done: any turn that lists one/, /the single line `no suggestions`, the only answer that leaves the session done/, /Only the owner answers, yes or no per item/, /workers too/]) assert.match(RULE, re);
  const norm = (x) => x.replace(/\\047/g, "'").replace(/\s+/g, ' ');
  for (const f of ['AGENTS.md', 'docs/REFERENCE.md', 'scripts/cbsession', 'docs/MAC-HOOK.md']) {
    const text = norm(readFileSync(join(ROOT, f), 'utf8'));
    assert.ok(text.includes(RULE), f);
    assert.doesNotMatch(text, /file (?:each|them)(?: improvement idea)? (?:as|with) (?:a )?`?found-bug[^.]*idea|ideas are done or explained|file each improvement idea/i, f);
  }
});

test('ambiguousAnswer: "do the 4" of a list of 4 is asked back, clear replies are not', () => {
  const open = [1, 2, 3, 4];
  for (const s of ['do the 4', 'do 4', 'ok do the 4', 'Do the 4.', 'approve 4', 'yes build the 4']) assert.equal(ambiguousAnswer(s, open), 4, s);
  for (const s of ['do 1', 'do the 3', 'yes 4', 'yes 1 2 3 4', 'yes 4, no 1 2 3', 'do all', 'no', 'do 1 and 4', 'do the 4 and 2']) assert.equal(ambiguousAnswer(s, open), null, s);
  assert.equal(ambiguousAnswer('do 1', [1]), null, 'a single item: "do 1" is clear');
  assert.equal(ambiguousAnswer('do the 4', [2, 4]), null, 'N is not the list length');
  assert.equal(ambiguousAnswer('do the 4', [1, 2, 3, 4].slice(0, 3)), null, 'open does not contain N');
  assert.deepEqual(answersOf('do the 4', open), { 4: 'yes' }, 'the parser itself still reads item 4: the guard sits before it');
  assert.equal(ambiguousAnswer('4', open, { bare: true }), 4, 'a bare "4" of 4 is asked back when bare numbers count');
  assert.equal(ambiguousAnswer('4', open), null, 'a menu key is not asked back');
});

test('a bare number answers "only those" unless the closing question is a numbered menu (2026-11-26: "1" built item 1, the ledger kept 3 open)', () => {
  const open = [1, 2, 3], y = 'yes', n = 'no';
  assert.equal(answersOf('1', open), null, 'off by default');
  for (const [text, want] of [['1', { 1: y, 2: n, 3: n }], ['1 3', { 1: y, 2: n, 3: y }], ['1, 2', { 1: y, 2: y, 3: n }], ['7', null], ['1 yes', { 1: y }], ['ok', null]]) {
    assert.deepEqual(answersOf(text, open, { bare: true }), want, text);
  }
  assert.equal(bareNumbersOk('improvement suggestions above, nothing built — should I do 1 and 2? (manager recommends yes to 1, no to 2 and 3)'), true);
  assert.equal(bareNumbersOk(''), true);
  for (const q of ['should I do 1? [1 yes (recommended) / 2 no]', 'which: (1) merge (2) drop', 'Pick one:\n1. merge\n2. drop']) assert.equal(bareNumbersOk(q), false, q);
});

test('record: a bare "1" to "should I do 1 and 2?" clears the hold', async () => {
  const dir = tmp('sugg-bare-');
  const led = createSuggestions({ stateDir: dir, active: () => true });
  led.observe('s', 'Suggestions:\n1. one\n2. two\n3. three\nSTATUS: needs-owner: improvement suggestions above, nothing built — should I do 1 and 2?');
  assert.equal(led.openOf('s').length, 3);
  assert.equal(led.ownerMessage('s', '2', { question: 'should I do 1? [1 yes / 2 no]' }), null, 'a menu key records nothing');
  const r = led.ownerMessage('s', '1', { question: 'should I do 1 and 2?' });
  assert.deepEqual(r.answered.map((i) => `${i.n}:${i.answer}`), ['1:yes', '2:no', '3:no']);
  assert.equal(led.openOf('s').length, 0);
  assert.deepEqual(r.approved.map((i) => i.n), [1]);
});
