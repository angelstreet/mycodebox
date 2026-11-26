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
import { isReflectionAsk, audienceFor, reflectionQuestion, reflectionReplyOf, ASK_WORDS } from '../reflection.js';
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
const day0 = Date.parse('2026-11-26T09:00:00Z');

function rig({ parts = [], audience = 'owner', goal = GOAL, ...over } = {}) {
  const dir = tmp('reflect-'), records = [], sent = [];
  let t = day0;
  const gate = createGoalGate({ stateDir: dir, goalOf: async () => goal, partsOf: async () => parts, audienceOf: async () => audience, record: async (e) => { records.push(e); }, now: () => t, ...over });
  const sessions = [], panes = new Set();
  const check = (extra = {}) => createDoneCheck({ stateDir: dir, git: async () => { throw new Error('not a repo'); }, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); },
    now: () => t, goalGate: gate, goalEntryOf: () => (parts.length ? { goal, parts } : null), liveNames: async () => [...panes, ...sessions.map((s) => s.name)], ...extra });
  const dc = check();
  const turn = (text, name = 'a', more = {}) => { t += 6 * 60e3; panes.add(name); sessions.length = 0; sessions.push({ name, cwd: '/w/a', text, doneAt: t, ...more }); };
  const working = () => { t += 6 * 60e3; sessions.length = 0; };
  const journal = () => readFileSync(join(dir, 'goal-check.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, gate, dc, check, turn, working, sent, records, journal, sessions, panes, now: () => t, advance: (ms) => { t += ms; } };
}
const reflections = (sent) => sent.filter(([, x]) => x.startsWith('Reflection ('));

test('the question: leftovers and suggestions apart, ranked list with one recommendation or "no suggestions", nothing built; fits the Mac answer', () => {
  for (const a of ['owner', 'manager']) {
    const q = reflectionQuestion(a);
    assert.ok(q.length < 2000, `${q.length} characters`);
    assert.match(q, /\(a\) Leftovers of THIS task.*your done is then not final\. Fix them now/);
    assert.match(q, /\(b\) Improvement suggestions.*build NONE of them and file none/);
    for (const re of [/`no suggestions`/, /`Worth doing:`/, /`Smaller:`/, /`Recommendation: <which numbers and why>\. Should I do them\?`/]) assert.match(q, re);
  }
  assert.match(reflectionQuestion('owner'), /`STATUS: needs-owner: improvement suggestions above, nothing built — should I do <numbers>\?` \(the owner picks\)/);
  assert.match(reflectionQuestion('manager'), /`STATUS: needs-manager: improvement suggestions above, nothing built/);
});

test('who picks: the owner for an owner chat or a Mac session; the manager for a worker the manager, a session or an automation started', () => {
  for (const sb of [null, 'owner', 'dashboard', 'cbsession', 'unknown']) assert.equal(audienceFor('a', sb), 'owner', String(sb));
  for (const sb of ['manager', 'mm-manager', 'some-parent', 'bug-drain-tick', 'v2']) assert.equal(audienceFor('a', sb), 'manager', sb);
  assert.equal(audienceFor('mac:x-abc123', 'manager'), 'owner');
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
  const rows = r.journal().filter((x) => x.kind === 'reflect' || x.reflectReply);
  assert.deepEqual(rows.map((x) => x.kind || `reply:${x.reflectReply}`), ['reflect', 'reply:none']);
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

test('the reply: the list is recognised; a done line over items worth doing is raised to the feed, nothing is typed', async () => {
  assert.deepEqual(reflectionReplyOf(ANSWER), { answer: 'list', worth: 2, smaller: 1 });
  assert.deepEqual(reflectionReplyOf('no suggestions\n' + DONE), { answer: 'none' });
  assert.deepEqual(reflectionReplyOf('**Suggestions:**\n**Worth doing:** \n- none\nSmaller:\n1. x\nSTATUS: done — x'), { answer: 'list', worth: 0, smaller: 1 });
  assert.deepEqual(reflectionReplyOf('Working on the leftover.'), { answer: null });
  const r = rig({ parts: PARTS });
  r.turn(VERIFIED); await r.dc.tick();
  r.turn(ANSWER.replace(/STATUS: .*$/, '') + VERIFIED); await r.dc.tick(); await r.dc.tick();
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.records.map((e) => e.key), ['reflection:a']);
  assert.match(r.records[0].title, /2 suggestion\(s\) worth doing/);
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
  const w = classifyStall({ plain: ANSWER.replace('needs-owner', 'needs-manager').split('\n'), state: 'done', fromReport: true });
  assert.equal(w.case, 'needs_manager');
  assert.equal(isReflectionAsk('STATUS: needs-owner: may I delete the old reports?'), false);
  assert.equal(isReflectionAsk('STATUS: done — improvement suggestions above'), false);
  // as a done reply (nothing worth doing) the leftovers watcher and done-check (B) find nothing to push
  assert.equal(pushableItems(`Leftovers: none\n\nSuggestions:\nWorth doing: none\nSmaller:\n1. shorter journal rows\nRecommendation: none.\n${DONE}`), null);
});

test('one rule text: AGENTS.md, REFERENCE, the cbsession preamble and the MAC-HOOK snippet carry it, and no old rule against it is left', () => {
  const ROOT = join(import.meta.dirname, '..');
  const RULE = '**Reflection after an accepted done** (owner 2026-11-26): suggestions for improvement (anything beyond the task\'s goal) are not leftovers: do not build or file them unasked, do not list them in the closing review; they never hold `done`. When a done is accepted with the goal met, the harness asks once, and only then: (a) leftovers of this task: the done is not final, fix them now; (b) improvement suggestions, none built: a ranked list split `Worth doing` / `Smaller` with one recommendation, or the single line `no suggestions`. With something worth doing end `STATUS: needs-owner: improvement suggestions above, nothing built — should I do <numbers>?` (a worker the manager or another session started: `needs-manager:`, same words); else repeat the done line. Whoever is asked picks; nothing answers it automatically.';
  const norm = (x) => x.replace(/\\047/g, "'").replace(/\s+/g, ' ');
  for (const f of ['AGENTS.md', 'docs/REFERENCE.md', 'scripts/cbsession', 'docs/MAC-HOOK.md']) {
    const text = norm(readFileSync(join(ROOT, f), 'utf8'));
    assert.ok(text.includes(RULE), f);
    assert.doesNotMatch(text, /file (?:each|them)(?: improvement idea)? (?:as|with) (?:a )?`?found-bug[^.]*idea|ideas are done or explained|file each improvement idea/i, f);
  }
});
