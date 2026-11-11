// STATUS honesty (owner 2026-11-11): done only when the goal was achieved; `failed` is a manager item; proofs need evidence.
// Fixtures: closing lines of 2026-11-11, abridged and sanitised (codenames, no hosts, no signed URLs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { goalOf, headlineOf, doneButFailedOf, doneButFailedMessage, proofWithoutEvidenceOf, failedOf } from '../status-honesty.js';
import { createDoneCheck } from '../done-check.js';
import { classifyStall } from '../stall.js';

const PRE = 'Ship rule (owner 2026-11-11): after a change run the touched tests/typecheck yourself, commit, push your branch; end with a STATUS line.\n\n';

// opus-openexit, 17:16 UTC: the goal (TC310 / Open_Exit_App v3 on the Apps anchor) was NOT achieved, the line said done
const OPENEXIT = 'I filed two bugs:\n- bug-d2a924a9 (blocking): the tile goto fails with the right tile focused.\n\n'
  + 'STATUS: done — anchor not valid on stb4 today, so v2 stays and no v3 was built: tile gotos fail their fingerprint check with the right tile focused (Netflix, Joyn), `apps_radio` passed 1/1 from Home, goto Home from Apps failed 2/2 · closing review: docs none needed (no change) · leftovers bug-d2a924a9, bug-8a3b0568 · unverified: `apps_radio` from inside Apps, any box other than stb4 (none was free) · bugs: reported bug-d2a924a9, bug-8a3b0568';
// task208-pick5, 00:40 UTC: "green" from success flags, no playback evidence and no link
const PICK5 = 'The v14 record is now in the TASK-208 doc.\n'
  + 'STATUS: done — stb-orchtnet v14 diff, the 14 edge ids, rollback and the four carried changes are in the doc (merged at 03a97c530937); no further tree publish; `play_radio`, `play_replay` and `play_vod` are on prod and green on stbv1, `play_radio` also on stb4 and stbv1+ · closing review: docs updated: TASK-208-first-five-virtual-scripts.md · leftovers filed: bug-96551a80 (stb3 IR dongle, physical) · unverified: stb3 not run, 17 of 23 trees not diffed against v13 · bugs: fixed bug-dce832b0, reported bug-96551a80';
// task208-pick5, 15:33 UTC: the same claim with report links: accepted
const PICK5_LINKS = '| `apps_radio` | stbv1+, prod | pass | [b12b39b1](https://example.invalid/script-reports/stb/goto_b12b39b1/report.html) |\n'
  + 'STATUS: done — report links for every passing script run, one per box · closing review: docs none needed · leftovers none · unverified play_replay and play_vod not run on stbv1+ or stb4 · bugs: none';
// kpi-stb, 16:52 UTC: measured on four boxes, zap / radio filed with owners: a scoped done, not a failure of the goal itself
const KPISTB = 'STATUS: done — TASK-232 merged at 69bbf37631c4: wake, Replay, Movies, Recordings, Settings and Replay playback start measured on stb4, stbv1, stbv1+ and stb3; v18 published with `standby_to_home`; nightly campaigns carry the KPI steps · closing review: docs updated TASK-232-kpi-stb.md · leftovers bug-6d19debf (zap, worker kpi-zap-fix) · unverified: Movies/Recordings/Settings frames not checked by eye on stbv1, radio not measured · bugs: fixed the HDMI-static false match in `playback_start`; reported bug-6d19debf';
// content-mobile, 12:15 UTC; kpi-zap-fix, 13:56 UTC; fix-ci-parallel-timing, 05:35 UTC (goal: CI red -> the CI job is "unverified")
const CONTENTMOBILE = 'STATUS: done — stood down on the phone per the owner decision; docs on main (3d170c57bf84), no leases held; goal not met: 5 distinct contents played (not 10, correct the record), no daily deployment · closing review: docs TASK-233 on main · unverified: sweep fixes on the phone · bugs: bug-d88db9b5';
const ZAPFIX = 'STATUS: done — all zap fix commits are on main (docs follow-up 444d8810bfba) and deployed; the 5-zap proof is incomplete, filed as bug-db063be2 · closing review: docs none needed · leftovers bug-db063be2 · unverified the monitor fix over 5 zaps · bugs: reported bug-db063be2';
const CIFIX = 'STATUS: done — Deploy harness timing assertion replaced with a host-overlap check, merged to main at 537946e9d9ff · closing review: docs none needed · leftovers none · unverified: the Deploy harness CI job on 537946e9d9ff · bugs: fixed flaky wall-clock assertion';
const CIGOAL = 'CI on main is red (manager sweep 2026-11-11 05:30 UTC): "Deploy harness" run on a merge commit, job "update_core harnesses".';

test('goalOf: the explicit Goal line wins; else the first task line after the cbsession preamble, one sentence', () => {
  assert.equal(goalOf(PRE + '# Task: re-execute and fix the two TASK-208 POC testcases (owner 2026-11-10)\n\nOwner: "..."'), 're-execute and fix the two TASK-208 POC testcases (owner 2026-11-10)');
  assert.equal(goalOf(PRE + 'SHIP RULE: you may commit.\nOwner (2026-11-11): "x". Second sentence here.\nGoal: build v3 of Open_Exit_App on the Apps anchor\n'), 'build v3 of Open_Exit_App on the Apps anchor');
  assert.equal(goalOf(PRE + 'Fix the STB zap KPI (TASK-232 follow-up, owner priority: KPI incl. zap). Then more.'), 'Fix the STB zap KPI (TASK-232 follow-up, owner priority: KPI incl. zap).');
  assert.equal(goalOf(''), '');
});

test('headlineOf: the claim before the closing review / bugs segments', () => {
  assert.equal(headlineOf('x merged · closing review: docs none · bugs: none'), 'x merged');
  assert.equal(headlineOf('a; b · leftovers none · unverified: c'), 'a; b');
});

test('done but failed: the four real lines of 2026-11-11 are caught, the achieved ones are not', () => {
  const o = doneButFailedOf(OPENEXIT, 'build v3 of Open_Exit_App on the Apps anchor');
  assert.ok(o, 'opus-openexit');
  assert.deepEqual(o.hits.map((h) => h.label).slice(0, 2), ['not valid', 'no X was built']);
  assert.ok(o.hits.every((h) => h.strong));
  assert.ok(doneButFailedOf(CONTENTMOBILE, 'Daily content testing: at least 10 contents per day on each platform'), 'content-mobile "goal not met"');
  assert.ok(doneButFailedOf(ZAPFIX, 'Fix the STB zap KPI'), 'kpi-zap-fix "proof is incomplete"');
  assert.ok(doneButFailedOf(CIFIX, CIGOAL), 'CI fix whose goal (the CI job) is the unverified part');
  assert.equal(doneButFailedOf(CIFIX, ''), null, 'without a goal the unverified segment is not judged');
  assert.equal(doneButFailedOf(PICK5_LINKS, 'pick the 5 easiest testcases'), null);
  assert.equal(doneButFailedOf(KPISTB, 'KPI coverage on orchtnet, one agent per platform'), null);
  assert.equal(doneButFailedOf('STATUS: done — no tree change and no prod publish was needed · bugs: none'), null, '"no X was needed" is not a failure');
  assert.equal(doneButFailedOf(OPENEXIT.replace('STATUS: done', 'STATUS: failed')), null, 'only a done line is judged');
  assert.equal(doneButFailedOf('STATUS: blocked: anchor not valid'), null);
});

test('done but failed: the wake names the agent\'s words, the goal and the three honest lines', () => {
  const m = doneButFailedMessage(doneButFailedOf(OPENEXIT), 'build v3 of Open_Exit_App');
  assert.match(m, /"anchor not valid on stb4 today"/);
  assert.match(m, /goal of this session: "build v3 of Open_Exit_App"/);
  assert.match(m, /STATUS: failed — goal not achieved: <why> · tried:/);
  assert.match(m, /STATUS: blocked:/);
  assert.match(m, /goal: achieved · evidence:/);
});

test('goal: achieved silences the soft signals, never the strong ones', () => {
  const soft = 'STATUS: done — zap KPI measured on three boxes, stb3 blocked on the zap KPI dongle · goal: achieved · evidence: run 7f503fec · bugs: none';
  assert.equal(doneButFailedOf(soft, 'measure the zap KPI on every box'), null);
  assert.ok(doneButFailedOf(soft.replace(' · goal: achieved · evidence: run 7f503fec', ''), 'measure the zap KPI on every box'));
  assert.ok(doneButFailedOf('STATUS: done — no v3 was built · goal: achieved · bugs: none'));
});

test('proof without evidence: "green" with no link / id / frame is flagged; links, run ids, frames and test suites are evidence', () => {
  assert.match(proofWithoutEvidenceOf(PICK5).claim, /green on stbv1/);
  assert.equal(proofWithoutEvidenceOf(PICK5_LINKS), null);
  assert.equal(proofWithoutEvidenceOf('STATUS: done — apps_radio stays proven on prod (result b12b39b1) · bugs: none'), null);
  assert.equal(proofWithoutEvidenceOf('STATUS: done — playback proven on stb4, frames in /tmp/x/frame_0003.jpg · bugs: none'), null);
  assert.equal(proofWithoutEvidenceOf('STATUS: done — fix merged, npm test green · bugs: none'), null);
  assert.ok(proofWithoutEvidenceOf('STATUS: done — standby migrated and proven 3/3 on stbv1 only · bugs: none'));
  assert.equal(proofWithoutEvidenceOf('STATUS: waiting: run 12 to pass'), null);
});

test('failedOf: the new verdict parses into why + tried', () => {
  assert.deepEqual(failedOf('STATUS: failed — goal not achieved: anchor not valid on stb4, no v3 built · tried: 5 goto runs, anchor-R2 · bugs: reported bug-d2a924a9'),
    { why: 'anchor not valid on stb4, no v3 built', tried: '5 goto runs, anchor-R2' });
  assert.equal(failedOf('STATUS: done'), null);
});

test('stall: STATUS failed is a manager item (needs_manager + failed), never a finished turn', () => {
  const RULE = '─'.repeat(40);
  const r = classifyStall({ plain: ['⏺ Tried five runs.', '', 'STATUS: failed — goal not achieved: anchor not valid on stb4 · tried: anchor-R2, 5 gotos', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], raw: null, state: 'done' });
  assert.equal(r.case, 'needs_manager');
  assert.equal(r.failed, true);
  assert.equal(r.status, 'failed');
  assert.match(r.managerAsk, /^goal not achieved: anchor not valid on stb4/);
});

function doneCheck(t, sessions, { mode = 'live', goal = '' } = {}) {
  const dir = tmp('honesty-');
  const sent = [], events = [];
  const w = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('not a repo'); }, listDone: async () => sessions, mode: () => mode, log: { error() {} },
    goalOf: async () => goal, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), send: async (n, x) => { sent.push([n, x]); }, record: async (e) => { events.push(e); } });
  return { w, sent, events };
}

test('done-check (F): one wake + one manager event per done line; the same line never twice', async (t) => {
  const h = doneCheck(t, [{ name: 'opus-openexit', cwd: '/nowhere', text: OPENEXIT }], { goal: 'build v3 of Open_Exit_App on the Apps anchor' });
  const r = await h.w.tick(); await h.w.tick(); await h.w.tick();
  assert.deepEqual(r.doneButFailed, ['opus-openexit']);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][1], /your own text says the goal was not achieved/);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].key, 'done-but-failed:opus-openexit');
  assert.match(h.events[0].body, /not valid: anchor not valid/);
});

test('done-check (G): a proof without evidence is warned once; (F) wins on the same line; dry and drafts send nothing', async (t) => {
  const h = doneCheck(t, [{ name: 'task208-pick5', cwd: '/nowhere', text: PICK5 }]);
  const r = await h.w.tick(); await h.w.tick(); await h.w.tick();
  assert.deepEqual(r.proofWithoutEvidence, ['task208-pick5']);
  const proof = h.sent.filter(([, x]) => /claims a proof .* names no evidence/.test(x));
  assert.equal(proof.length, 1, 'once');
  assert.ok(h.sent.length <= 3, 'never two pushes in one tick');
  assert.equal(h.events.length, 0, 'a warning, not a manager event');
  const both = doneCheck(t, [{ name: 'x', cwd: '/nowhere', text: 'STATUS: done — play_radio green on stb4, no v3 was built · bugs: none' }]);
  await both.w.tick();
  assert.equal(both.sent.length, 1);
  assert.match(both.sent[0][1], /goal was not achieved/);
  const dry = doneCheck(t, [{ name: 'a', cwd: '/nowhere', text: OPENEXIT }], { mode: 'dry' });
  await dry.w.tick();
  assert.equal(dry.sent.length, 0);
  const draft = doneCheck(t, [{ name: 'a', cwd: '/nowhere', text: OPENEXIT, draft: true }]);
  const d = await draft.w.tick();
  assert.equal(draft.sent.length, 0);
  assert.deepEqual(d.doneButFailed, ['a']);
});

test('the canonical STATUS vocabulary sentence is in AGENTS.md, the cbsession preamble, the MAC-HOOK snippet and REFERENCE', async () => {
  const { readFileSync } = await import('node:fs');
  const ROOT = join(import.meta.dirname, '..');
  const RULE = "STATUS vocabulary (owner 2026-11-11): `done` only when the task's goal was achieved, with `goal: achieved · evidence: <links / run ids / frames>`; `failed — goal not achieved: <why> · tried: <list>` when it was not (the manager is told and helps); `blocked: <system id or reason + what you tried>`; `waiting: <system id>`; `needs-owner:` only for a hard-floor item. A green / pass / proven claim carries its evidence. Before you fix a filed bug, run `found-bug --claim <id>` (exit 3: someone else is fixing it).";
  const norm = (x) => x.replace(/'"'"'/g, "'").replace(/\s+/g, ' ');
  for (const f of ['AGENTS.md', 'scripts/cbsession', 'docs/MAC-HOOK.md', 'docs/REFERENCE.md']) assert.ok(norm(readFileSync(join(ROOT, f), 'utf8')).includes(RULE), f);
});
