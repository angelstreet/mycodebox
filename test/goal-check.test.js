// Goal check (owner 2026-11-11, goal-check.js): the owner's "did you reach the goal?" asked by the harness, fix-first for filed leftovers,
// at most 2 bounces per session per day. The example done line from the owner's report is replayed through the gate and must bounce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createGoalGate, createGoalStore, goalReplyOf, taskPartsOf, partsWithoutEvidence, leftoverIdsOf, touchedLeftovers, evidenceOf, goalQuestion, BOUNCES_PER_DAY } from '../goal-check.js';
import { createDoneCheck } from '../done-check.js';

// the owner's example (2026-11-11): it passed the closing-review and STATUS-vocabulary checks
const EXAMPLE = 'Fixed three bugs in the lease lane.\n\nSTATUS: done — resolved bug-3fbdd970, bug-430a348e, bug-b6a0056d · closing review: docs none needed · leftovers bug-827764ef, bug-2f32e7a7, bug-8fc8fc0d, bug-03ccc6a7, bug-80bdcdc1 · unverified: none · bugs: none';
const LEFT = ['bug-827764ef', 'bug-2f32e7a7', 'bug-8fc8fc0d', 'bug-03ccc6a7', 'bug-80bdcdc1'];
const GOAL = 'Fix the lease deploy catch-up so a strict multi-host catch-up no longer blocks claims on every host';
const CLEAN = 'STATUS: done — catch-up fixed · goal: achieved · evidence: int-1a1cbfa071 · closing review: docs REFERENCE.md · leftovers none · unverified none · bugs: none';
const day0 = Date.parse('2026-11-11T09:00:00Z');

function gate({ bugs = [], touched = [], goal = GOAL, now } = {}) {
  const records = [];
  const g = createGoalGate({ stateDir: tmp('goal-check-'), goalOf: async () => goal, bugsOf: async () => bugs, touchedOf: async () => touched, record: async (e) => { records.push(e); }, now });
  return { g, records };
}

test('parsing: the example line lists five filed leftovers; none / text lists give none', () => {
  assert.deepEqual(leftoverIdsOf(EXAMPLE), LEFT);
  assert.deepEqual(leftoverIdsOf(CLEAN), []);
  assert.deepEqual(leftoverIdsOf('STATUS: waiting: int-1a2b3c4d · leftovers bug-827764ef, bug-2f32e7a7'), [], 'only a done line counts');
});

test('touched area: filed by the session or naming a changed file; host / credentials / owner-floor reasons and resolved bugs do not count', () => {
  const bugs = [
    { id: 'bug-827764ef', session: 'lease-fix', why: 'large', reason: 'needs a refactor', title: 'catch-up queue' },
    { id: 'bug-2f32e7a7', session: 'other', why: 'other-area', title: 'lease-service.js readyCatchUp holds every host' },
    { id: 'bug-8fc8fc0d', session: 'lease-fix', why: 'host-or-device', title: 'vpt-pi3 down' },
    { id: 'bug-03ccc6a7', session: 'lease-fix', why: 'large', resolved: true, title: 'x' },
    { id: 'bug-80bdcdc1', session: 'someone', why: 'large', title: 'unrelated dashboard css' },
  ];
  const got = touchedLeftovers(LEFT, { bugs, touched: ['lease-service.js', 'test/lease-service.test.js'], name: 'lease-fix' }).map((x) => x.id);
  assert.deepEqual(got, ['bug-827764ef', 'bug-2f32e7a7']);
  assert.equal(touchedLeftovers(['bug-deadbeef1'], {}).length, 1, 'an id the store does not know counts: the session named it');
});

test('REPLAY: the owner\'s example done line bounces with the fix-first rule and each bug\'s why-not-fixed text', async () => {
  const bugs = LEFT.map((id, i) => ({ id, session: 'lease-fix', why: i % 2 ? 'other-area' : 'large', reason: `reason ${i}`, title: `leftover ${i}` }));
  const { g } = gate({ bugs, now: () => day0 });
  const d = await g.evaluate({ name: 'lease-fix', text: EXAMPLE, doneAt: day0 });
  assert.equal(d.kind, 'fix-first');
  assert.equal(d.bounce, true);
  assert.deepEqual(d.leftovers, LEFT);
  assert.match(d.message, /lists 5 filed leftovers in the area you touched/);
  assert.match(d.message, /bug-827764ef \(why-not-fixed: large — "reason 0"/);
  assert.match(d.message, /small and you have the repro/);
  assert.match(d.message, /found-bug --claim <id>/);
  // the same replay with an empty bug store (Mac, or ids the store does not know) bounces too
  const { g: g2 } = gate({ now: () => day0 });
  assert.equal((await g2.evaluate({ name: 'mac:x-abc123', text: EXAMPLE, doneAt: day0, remote: true })).kind, 'fix-first');
});

test('the owner\'s question: asked once per done, quoting the goal; the reply needs the goal restated and evidence', async () => {
  let t = day0;
  const { g } = gate({ now: () => t });
  const s = { name: 'lease-fix', text: CLEAN, doneAt: t };
  const q = await g.evaluate(s);
  assert.equal(q.kind, 'ask');
  assert.equal(q.message, goalQuestion(GOAL));
  assert.match(q.message, /^Goal check: Goal as given: "Fix the lease deploy catch-up .*". Did you reach it\? Quote the evidence for each part.*If not, continue/);
  await g.sent('lease-fix', q);
  assert.equal(await g.evaluate(s), null, 'once per done: the same turn is not asked again');
  // the reply: "yes" with no restatement and no evidence -> bounced
  t += 60e3;
  const bad = await g.evaluate({ name: 'lease-fix', text: 'Yes, all done.\nSTATUS: done — catch-up fixed · goal: achieved · closing review: docs none needed · leftovers none · unverified none · bugs: none', doneAt: t });
  assert.equal(bad.kind, 'reply-rejected');
  assert.match(bad.message, /restatement of the goal/);
  assert.match(bad.message, /evidence for each part/);
  await g.sent('lease-fix', bad);
  // the reply that restates the goal and cites evidence -> accepted
  t += 60e3;
  const good = `Goal as given: fix the lease deploy catch-up so a strict multi-host catch-up no longer blocks claims on every host.
1. catch-up queued per skipped host: lease-service.js:412, test/lease-service.test.js 14/14 tests pass
2. claims on other hosts not blocked: integration int-1a1cbfa071dec326e merged, commit 3fa1004
STATUS: done — catch-up fixed · goal: achieved · evidence: int-1a1cbfa071dec326e · closing review: docs none needed · leftovers none · unverified none · bugs: none`;
  const ok = await g.evaluate({ name: 'lease-fix', text: good, doneAt: t });
  assert.equal(ok.kind, 'accepted');
  assert.ok(ok.evidence.includes('file') && ok.evidence.includes('run id'));
  assert.equal(await g.evaluate({ name: 'lease-fix', text: good, doneAt: t }), null, 'accepted: quiet');
  const snap = await g.snapshot();
  assert.equal(snap.sessions['lease-fix'].bouncedToday, 1, 'the question itself is not a bounce; the rejected reply is');
});

test('a reply that says part of the goal is not reached is not accepted, even with evidence', () => {
  const r = goalReplyOf('Goal: fix the lease deploy catch-up for multi-host claims. Part 2 is not yet verified, lease-service.js:412 changed.', GOAL);
  assert.equal(r.ok, false);
  assert.match(r.missing.join(' '), /not yet verified/);
  assert.deepEqual(evidenceOf('p95 1.8 s on stb4, screenshot frame_0012.png'), ['screenshot', 'KPI number']);
  assert.equal(goalReplyOf('Goal: ship the thing. Evidence: https://example.test/report/1', '').ok, true, 'no goal recorded: an explicit "Goal:" line restates it');
});

test('max 2 bounces per session per day, then the manager is told once; a new day starts again; nothing is closed', async () => {
  let t = day0;
  const { g, records } = gate({ now: () => t });
  for (let i = 0; i < BOUNCES_PER_DAY; i++) {
    t += 60e3;
    const d = await g.evaluate({ name: 's1', text: EXAMPLE.replace('Fixed', `Fixed ${i}`) + ` #${i}`, doneAt: t });
    assert.equal(d.kind, 'fix-first');
    await g.sent('s1', d);
  }
  t += 60e3;
  const c = await g.evaluate({ name: 's1', text: EXAMPLE + ' again', doneAt: t });
  assert.equal(c.kind, 'capped');
  assert.equal(c.message, undefined, 'nothing is typed once capped');
  assert.equal(records.length, 1);
  assert.match(records[0].title, /s1: done bounced 2 times today by the goal check/);
  t += 60e3;
  await g.evaluate({ name: 's1', text: EXAMPLE + ' once more', doneAt: t });
  assert.equal(records.length, 1, 'the manager is told once per day');
  assert.deepEqual((await g.snapshot()).sessions.s1, { bouncedToday: 2, capped: true, waitingForReply: false });
  t += 24 * 3600e3;
  assert.equal((await g.evaluate({ name: 's1', text: EXAMPLE + ' next day', doneAt: t })).kind, 'fix-first');
});

test('a Mac stop under the loop guard (stop_hook_active) is never answered; a bounce goes to the manager', async () => {
  const { g, records } = gate({ now: () => day0 });
  const d = await g.evaluate({ name: 'mac:x-abc123', text: EXAMPLE, doneAt: day0, remote: true, canAnswer: false });
  assert.equal(d.message, null);
  assert.equal(d.unanswerable, true);
  assert.equal(records.length, 1);
});

test('goal store: captured at start from the prompt (preamble skipped); the first capture wins unless a later one is an explicit Goal: line', () => {
  const store = createGoalStore({ stateDir: tmp('goals-') });
  const prompt = 'Ship rule (owner 2026-11-11): after a change run the touched tests.\nFix the Apple TV menu edge on appletv-orchtnet. More text.\nYour worktree is ready: /w';
  assert.equal(store.capture('s', prompt, 'cbsession').goal, 'Fix the Apple TV menu edge on appletv-orchtnet.');
  assert.equal(store.capture('s', 'something else', 'mac').goal, 'Fix the Apple TV menu edge on appletv-orchtnet.');
  assert.equal(store.capture('s', '# T\nGoal: the menu edge passes 3/3 runs', 'handover').goal, 'the menu edge passes 3/3 runs');
  assert.equal(store.get('s').source, 'handover');
  assert.equal(store.get('nobody'), null);
});

test('done-check (H): the example line on a codebox pane gets the fix-first push; a clean line gets the question; counts in the snapshot', async () => {
  const dir = tmp('done-goal-');
  const sent = [];
  const { g } = gate({ now: () => day0 });
  const sessions = [
    { name: 'lease-fix', cwd: '/w/none', text: EXAMPLE, doneAt: day0 },
    { name: 'clean', cwd: '/w/none', text: CLEAN, doneAt: day0 },
    { name: 'busy', cwd: '/w/none', text: CLEAN, doneAt: day0, working: true },
  ];
  const dc = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('not a repo'); }, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); }, now: () => day0, goalGate: g });
  const r = await dc.tick();
  assert.deepEqual(sent.map(([n]) => n), ['lease-fix', 'clean']);
  assert.match(sent[0][1], /^Goal check: your done line lists 5 filed leftovers/);
  assert.match(sent[1][1], /^Goal check: Goal as given: /);
  assert.deepEqual(r.goalCheck.bounced, ['lease-fix']);
  assert.deepEqual(r.goalCheck.asked, ['clean']);
  const r2 = await dc.tick();
  assert.equal(sent.length, 2, 'once per done turn');
  assert.deepEqual(r2.goalCheck.asked, []);
  assert.equal((await g.snapshot()).sessions['lease-fix'].bouncedToday, 1);
  assert.ok(JSON.parse(readFileSync(join(dir, 'done-check.json'), 'utf8')));
});

// bug-15b77282: evidence per numbered part of the task, not one reference for the whole reply
const TASK = `Ship rule (owner 2026-11-11): after a change run the touched tests.
Owner (2026-11-11): agents say done too early.
Build (mycodebox repo):
1. Goal-check gate in the done-check: before a done line is accepted, ask the owner's question.
2. Capture the goal at session start so the question quotes it.
3. Works for codebox sessions and the Mac hook; count of bounced dones shown in manager-status-scan.
Report with evidence.
Your worktree is ready: /w

0. First command: git worktree list
1. Read the handover: x
2. Write a short summary of the current state
3. Then do the work`;

test('task parts: the first numbered list of the task, not the cbsession preamble steps; labels before a colon', () => {
  assert.deepEqual(taskPartsOf(TASK), ['Goal-check gate in the done-check', 'Capture the goal at session start so the question quotes it.', 'Works for codebox sessions and the Mac hook; count of bounced dones shown in manager-status-scan.']);
  assert.deepEqual(taskPartsOf('Fix the menu edge. 1. only one item'), []);
  assert.equal(createGoalStore({ stateDir: tmp('goals-p-') }).capture('s', TASK).parts.length, 3);
});

test('per-part evidence: one reference for the whole reply is not enough when the task has numbered parts; the question lists the parts', async () => {
  const parts = taskPartsOf(TASK);
  const goal = 'agents say done too early';
  const one = 'Goal: agents say done too early is fixed.\n1. gate: goal-check.js:150\n2. goal captured at start\n3. Mac hook works\nSTATUS: done';
  const r = goalReplyOf(one, goal, parts);
  assert.equal(r.ok, false);
  assert.deepEqual(r.partsMissing, [2, 3]);
  assert.match(r.missing.join(' '), /evidence for part 2 \(Capture the goal at session start/);
  const all = 'Goal: agents say done too early is fixed.\n1. gate: goal-check.js:150\n2. goal captured at session start: server.js:1040, test/goal-check.test.js\n- Mac hook and manager-status-scan count: int-1a1cc3a35a24de13d\nSTATUS: done';
  assert.deepEqual(partsWithoutEvidence(all, parts), [], 'by number or by two of the part\'s words');
  assert.equal(goalReplyOf(all, goal, parts).ok, true);
  const g2 = createGoalGate({ stateDir: tmp('goal-p-'), goalOf: async () => goal, partsOf: async () => parts });
  const q = await g2.evaluate({ name: 'p', text: CLEAN, doneAt: day0 });
  assert.match(q.message, /Parts: 1\. Goal-check gate in the done-check 2\. Capture the goal/);
  await g2.sent('p', q);
  assert.equal((await g2.evaluate({ name: 'p', text: one, doneAt: day0 + 60e3 })).kind, 'reply-rejected');
});
