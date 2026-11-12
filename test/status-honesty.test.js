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
  assert.equal(proofWithoutEvidenceOf('STATUS: done — docs and skill match the proof bar, proven on stb4 · goal: achieved · evidence: merge 082d43609e7b · bugs: none'), null, 'an evidence segment naming a commit');
  assert.equal(proofWithoutEvidenceOf('STATUS: done — proven on stb4 · goal: achieved · evidence: integration int-1a1cbbd9c3fbdde01 · bugs: none'), null);
  assert.ok(proofWithoutEvidenceOf('STATUS: done — proven on stb4 · goal: achieved · evidence: it works · bugs: none'), 'words only are not evidence');
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

test('the STATUS table (docs/STATUS-TABLE.md, the seven words) is verbatim in AGENTS.md, the cbsession preamble, the MAC-HOOK snippet and REFERENCE', async () => {
  const { readFileSync } = await import('node:fs');
  const ROOT = join(import.meta.dirname, '..');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const table = norm(readFileSync(join(ROOT, 'docs/STATUS-TABLE.md'), 'utf8'));
  assert.match(table, /`running`/); assert.match(table, /`needs-manager`/);
  for (const f of ['AGENTS.md', 'scripts/cbsession', 'docs/MAC-HOOK.md', 'docs/REFERENCE.md']) assert.ok(norm(readFileSync(join(ROOT, f), 'utf8')).includes(table), f);
});

// harness-done-honest (2026-11-11): not-done phrases in a done line are refused with no AI and no goal needed
test('done line with a not-done phrase is caught', () => {
  for (const t of [
    'one node fully fingerprint-only, batches 4-5 and the stb4 tile job not done',
    'the tree publish is not done and waits for the manager',
    'new run not yet confirmed moving',
    "Gold's B3F stall is only partly fixed",
    'the safe-restart is still pending',
    'the monitor-path comparison is still open under bug-db063be2',
    'bug-9d7d5af5 NOT fixed, open as bug-d6d82374',
    'goal partly achieved',
  ]) assert.ok(doneButFailedOf(`STATUS: done — ${t} · closing review: docs none needed · leftovers none · unverified none · bugs: none`, ''), t);
});
test('done line that is clean, or names only closing-review leftovers, is not caught', () => {
  for (const t of [
    'merged at 03a97c530937 · goal: achieved · evidence: int-1a1cc5388f884ffdb · closing review: docs none needed · leftovers bug-1 filed · unverified: stb3 not run · bugs: none',
    'no tree change was needed, all checks done and deployed (int-1a1cc5388f884ffdb)',
    'fix merged; bug-db063be2 stays open for another area',
  ]) assert.equal(doneButFailedOf(`STATUS: done — ${t}`, ''), null, t);
});

// blocked is not a wait (owner 2026-11-11 evening): fixtures are the real blocked lines of 2026-11-11, abridged
import { blockedHonestyOf, blockedHonestyMessage } from '../status-honesty.js';
test('blocked: a wait is told to restate as waiting; a line without tried:/need: is told to add them; a good one passes', () => {
  const waits = [
    'STATUS: blocked: waiting on the radio sweeps on stbv1+ then stbv1 (background b4q6r4fh1); then the final diff for the manager',
    'STATUS: blocked: Mi device5 is kept free for content-androidtv until 04:50 UTC; after that I re-claim and run the measurements',
    'STATUS: blocked: vpt-mf1/device5 is held by kpi-androidtv, so no missed-slot sweep has run; I hold no lease',
    'STATUS: blocked: waiting on the radio sweep on stbv1+ (execution ace72ddf), which gates step 2',
  ];
  for (const w of waits) { const f = blockedHonestyOf(w); assert.ok(f?.running.length, w); assert.match(blockedHonestyMessage(f), /restate it as `STATUS: (?:running|waiting):/); }
  assert.match(blockedHonestyMessage(blockedHonestyOf(waits[0])), /restate it as `STATUS: running:/, 'own background job: running');
  assert.match(blockedHonestyMessage(blockedHonestyOf(waits[2])), /restate it as `STATUS: waiting:/, 'lease held by another session: waiting');
  const noTried = blockedHonestyOf('STATUS: blocked: signed-out S21x, needs a verified-valid login (owner/manager)');
  assert.deepEqual(noTried.running, []); assert.deepEqual(noTried.missing, ['tried:', 'need:']);
  assert.match(blockedHonestyMessage(noTried), /lacks tried: and need:/);
  assert.equal(blockedHonestyOf('STATUS: blocked: stb3 IR dongle not enumerated on vpt-pi1 (no /dev/lirc-stb3) · tried: host recovery, hub-port reset, power cycle under lease · need: the owner replugs the dongle (bug-96551a80) · closing review: docs none needed'), null);
  assert.equal(blockedHonestyOf('STATUS: waiting: integration int-1a1cc61deccbb0995'), null, 'only blocked lines');
  assert.equal(blockedHonestyOf('STATUS: done — x · goal: achieved · evidence: int-1a1cc61deccbb0995'), null);
  // false-catch guards from the replay: "no bug is queued" and "no integration is pending" are not a queued lease
  assert.equal(blockedHonestyOf('STATUS: blocked: no integration is pending and no bug is queued for the next pick; lease run needed · tried: triage · need: the manager restarts the loop'), null);
});
test('done-check (I): blocked is dry by default (journal only), live sends once per line', async (t) => {
  const line = 'STATUS: blocked: waiting on the radio sweeps (background b4q6r4fh1)';
  const mk = (blockedMode) => { const dir = tmp('blocked-'), sent = []; const w = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('x'); }, listDone: async () => [], listBlocked: async () => [{ name: 'content-stb', text: line }], blockedMode: () => blockedMode, mode: () => 'live', log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), send: async (n, x) => { sent.push([n, x]); } }); return { w, sent }; };
  const dry = mk('dry'); await dry.w.tick(); assert.equal(dry.sent.length, 0);
  const live = mk('live'); await live.w.tick(); await live.w.tick();
  assert.equal(live.sent.length, 1); assert.match(live.sent[0][1], /restate it as `STATUS: running:/);
});

// harness-status-table (owner 2026-11-11): `running` is a known, non-finished, non-escalated state; an unknown word is sent back naming the seven
import { unknownStatusWordOf, unknownStatusWordMessage, SEVEN_WORDS } from '../status-honesty.js';
import { classifyStall as cs, statusLine as sl } from '../stall.js';
test('stall.js: `running` is parsed, never a finished turn and never an escalation; with a job ref it is a watched own job', () => {
  const pane = (line) => ['Working.', line, '✻ Baked for 1m', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on'];
  assert.equal(sl(['x', 'STATUS: running: replay sweep on vpt-mf1/device5 — VOD left']).kind, 'running');
  const a = cs({ plain: pane('STATUS: running: replay sweep on vpt-mf1/device5 under lease ad7984e6 — VOD and recording left'), raw: [], state: 'done' });
  assert.equal(a.status, 'running'); assert.equal(a.case, 'background_wait'); assert.equal(a.answer, null);
  const b = cs({ plain: pane('STATUS: running: pid 4242, log /tmp/run.log — the suite'), raw: [], state: 'done' });
  assert.equal(b.status, 'running'); assert.equal(b.case, 'own_job_wait');
});
test('an unknown STATUS word is sent back naming the seven words; the seven, the tolerated replies and a done alias are not', () => {
  const f = unknownStatusWordOf('Notes.\nSTATUS: finalizing — x');
  assert.equal(f.word, 'finalizing');
  const m = unknownStatusWordMessage(f);
  for (const w of SEVEN_WORDS) assert.ok(m.includes(w), w);
  for (const w of [...SEVEN_WORDS, 'acknowledged', 'handoff', 'ok', 'shipped']) assert.equal(unknownStatusWordOf(`STATUS: ${w}: x`), null, w);
  assert.equal(unknownStatusWordOf('no status here'), null);
});

// (J) a done line while the harness sees a running / waiting fact (stop-state.js): dry journals, live sends once and the goal question is not asked
test('done-check (J): done while a lane request is open is told it is waiting (live, once); dry only journals', async () => {
  const mk = (stateMode) => { const sent = []; const w = createDoneCheck({ stateDir: tmp('doneJ-'), git: async () => { throw new Error('x'); }, listDone: async () => [{ name: 'kpi', cwd: '/nowhere', text: 'STATUS: done — x merged · goal: achieved · evidence: int-1a1cc76f2cfaa4a04 · closing review: docs none needed · leftovers none · unverified none · bugs: none' }],
    stopFacts: async () => ({ bgJobs: 0, integrations: ['int-1a1cc7e0de12c0e88'], tickets: [], workers: [], timeMs: null }), stateMode: () => stateMode, mode: () => 'live', log: { error() {} },
    pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), send: async (n, x) => { sent.push([n, x]); } }); return { w, sent }; };
  const dry = mk('dry'); await dry.w.tick(); assert.equal(dry.sent.length, 0);
  const live = mk('live'); await live.w.tick(); await live.w.tick();
  assert.equal(live.sent.length, 1); assert.match(live.sent[0][1], /your STATUS says done, but the harness sees integration int-1a1cc7e0de12c0e88: that is waiting, not done/);
});

test('the goal-first / verification-last rule (docs/GOAL-RULE.md) is verbatim in AGENTS.md, the cbsession preamble, the MAC-HOOK snippet and REFERENCE', async () => {
  const { readFileSync } = await import('node:fs');
  const ROOT = join(import.meta.dirname, '..');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const rule = norm(readFileSync(join(ROOT, 'docs/GOAL-RULE.md'), 'utf8'));
  assert.match(rule, /Time box/); assert.match(rule, /Verification:/);
  for (const f of ['AGENTS.md', 'scripts/cbsession', 'docs/MAC-HOOK.md', 'docs/REFERENCE.md']) assert.ok(norm(readFileSync(join(ROOT, f), 'utf8')).includes(rule), f);
});

// goal first, verification last: Verification block per stored Done-when line, time box (docs/GOAL-RULE.md)
import { readFileSync } from 'node:fs';
import { verificationRowsOf, verificationOf, verificationMessage, timeBoxOf, timeBoxWakeMessage } from '../status-honesty.js';
const PARTS = ['merged and deployed', 'bug-1 resolved', 'replay: 26 caught'];
const V = (rows, st = 'STATUS: done — x · goal: achieved · evidence: int-1a1cc905977d8c7a9 · closing review: docs none needed · leftovers none · unverified none · bugs: none') => `Done.\n\nVerification:\n${rows.join('\n')}\n\n${st}`;
test('Verification: one row per stored Done-when line, same count and numbering, all pass; fail / not checked / missing / extra rows are refused; rows are counted', () => {
  const ok = verificationOf(V(['1. pass — int-1a1cc905977d8c7a9', '2. pass — bug-1 resolved', '3. pass — replay run']), PARTS);
  assert.deepEqual([ok.ok, ok.passed, ok.total], [true, 3, 3]);
  const bad = verificationOf(V(['1. pass — x', '2. fail — still open', '3. not checked — no device']), PARTS);
  assert.equal(bad.ok, false); assert.equal(bad.passed, 1); assert.match(bad.problems.join(' '), /row 2 is fail.*row 3 is not checked/);
  assert.match(verificationOf(V(['1. pass — x', '2. pass — y']), PARTS).problems.join(' '), /row 3 is missing/);
  assert.match(verificationOf(V(['1. pass — x', '2. pass — y', '3. pass — z', '4. pass — extra']), PARTS).problems.join(' '), /row 4 has no Done-when line/);
  assert.match(verificationOf('Done.\nSTATUS: done — x', PARTS).problems[0], /no `Verification:` block/);
  assert.equal(verificationOf(V(['1. pass — x', '2. dropped by owner — y', '3. pass — z']), PARTS).ok, true, 'a row the owner dropped counts');
  assert.equal(verificationOf('Done.\nSTATUS: failed — goal not achieved: x · tried: y', PARTS), null, 'only a done line');
  assert.equal(verificationOf(V(['1. pass']), []), null, 'no stored lines: nothing to check');
  assert.match(verificationMessage(bad, PARTS), /1 of 3 rows pass/);
});
test('time box parse and wake text', () => {
  assert.equal(timeBoxOf('Goal: x\nTime box: 2 h\n'), 2 * 3600e3); assert.equal(timeBoxOf('Time box: 90 min'), 90 * 60e3); assert.equal(timeBoxOf('time box: 6h'), 6 * 3600e3);
  assert.equal(timeBoxOf('no box'), null); assert.match(timeBoxWakeMessage(120 * 60e3), /Time box reached \(120 min\).*failed.*needs-manager/);
});
test('done-check (K)/(L): done without a complete Verification is sent back once and rows journalled; all pass skips the goal question; the time box wakes once (dry journals), then one manager item', async () => {
  const entry = { goal: 'ship it', parts: PARTS, timeBoxMs: 3600e3, at: new Date(Date.now() - 2 * 3600e3).toISOString() };
  const asked = []; const goalGate = { forget: async () => {}, evaluate: async (x) => { asked.push(x.name); return null; }, sent: async () => {} };
  const mk = (text, boxMode = 'live', sessions = []) => { const sent = [], events = []; const dir = tmp('doneK-'); let t = Date.now();
    const w = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('x'); }, listDone: async () => [{ name: 'k', cwd: '/nowhere', text }], goalGate, goalEntryOf: () => entry, timeBoxMode: () => boxMode, listSessions: async () => sessions, now: () => t, mode: () => 'live', log: { error() {} },
      pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), send: async (n, x) => { sent.push([n, x]); }, record: async (e) => { events.push(e); } }); return { w, sent, events, adv: (ms) => { t += ms; }, dir }; };
  const bad = mk(V(['1. pass — x', '2. fail — y', '3. pass — z']), 'off'); await bad.w.tick(); await bad.w.tick();
  assert.equal(bad.sent.length, 1); assert.match(bad.sent[0][1], /needs a `Verification:` block.*row 2 is fail.*2 of 3 rows pass/);
  assert.match(readFileSync(join(bad.dir, 'done-check.jsonl'), 'utf8'), /"verification":\{"passed":2,"total":3\}/);
  const good = mk(V(['1. pass — int-1a1cc905977d8c7a9', '2. pass — bug-1 resolved', '3. pass — replay run']), 'off'); const r = await good.w.tick();
  assert.equal(good.sent.length, 0); assert.ok(r.goalCheck.accepted.includes('k') && !asked.includes('k'), 'verified: the goal question is not asked');
  const idle = 'STATUS: running: pid 4242 — the suite';
  const tb = mk(idle, 'live', [{ name: 'k', working: false, text: idle }]); await tb.w.tick(); await tb.w.tick();
  assert.equal(tb.sent.filter(([, x]) => /Time box reached/.test(x)).length, 1);
  tb.adv(31 * 60e3); await tb.w.tick();
  assert.equal(tb.events.filter((e) => e.key === 'time-box:k').length, 1, 'a manager item, never a close');
  const dry = mk(idle, 'dry', [{ name: 'k', working: false, text: idle }]); await dry.w.tick();
  assert.equal(dry.sent.filter(([, x]) => /Time box reached/.test(x)).length, 0); assert.match(readFileSync(join(dry.dir, 'done-check.jsonl'), 'utf8'), /"timeBox":"reached"/);
});

// failed is not an ending (owner 2026-11-12): a failed line carries cause: and plan:
import { failedHonestyOf, failedHonestyMessage } from '../status-honesty.js';
test('failedHonestyOf: a failed line without cause: / plan: is caught; a complete one and other words are not', () => {
  const bare = failedHonestyOf('STATUS: failed — goal not achieved: empty wakes 54% against 25% · tried: four wake rules · closing review: docs none · plan: nothing');
  assert.deepEqual(bare.missing, ['cause:', 'plan:'], 'a plan: after the closing review does not count');
  assert.match(failedHonestyMessage(bare), /lacks cause: and plan:/);
  assert.match(failedHonestyMessage(bare), /Failing is not an ending/);
  assert.deepEqual(failedHonestyOf('STATUS: failed — goal not achieved: x').missing, ['tried:', 'cause:', 'plan:']);
  assert.equal(failedHonestyOf('STATUS: failed — goal not achieved: 54% against 25% · tried: four rules · cause: 60 of 109 empty wakes are asks stops the manager reads and leaves (replay 2026-11-11) · plan: a rules table per stop class, built by me, replay first'), null);
  assert.equal(failedHonestyOf('STATUS: blocked: x · tried: y · need: z'), null);
  assert.equal(failedHonestyOf('STATUS: done — x · goal: achieved · evidence: int-1a1cc61deccbb0995'), null);
});
test('done-check (I): a failed line without cause: / plan: is sent back once when blockedCheck is live, journalled when dry', async () => {
  const line = 'STATUS: failed — goal not achieved: anchor not valid on stb4 · tried: 5 goto runs';
  const mk = (blockedMode, text = line) => { const dir = tmp('failed-'), sent = []; const w = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('x'); }, listDone: async () => [], listBlocked: async () => [{ name: 'content-stb', text }], blockedMode: () => blockedMode, mode: () => 'live', log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), send: async (n, x) => { sent.push([n, x]); } }); return { w, sent, dir }; };
  const dry = mk('dry'); await dry.w.tick(); assert.equal(dry.sent.length, 0);
  assert.match(readFileSync(join(dry.dir, 'done-check.jsonl'), 'utf8'), /"failedHonesty":"lacks cause: plan:/);
  const live = mk('live'); await live.w.tick(); await live.w.tick();
  assert.equal(live.sent.length, 1); assert.match(live.sent[0][1], /your STATUS is failed, but it lacks cause: and plan:/);
  const good = mk('live', line + ' · cause: the stb4 anchor frame predates the firmware update (frame 2026-11-02 vs build 11-09) · plan: recapture the anchor under lease, then rerun'); await good.w.tick();
  assert.equal(good.sent.length, 0);
});
