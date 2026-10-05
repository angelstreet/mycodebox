// TASK-58 C9: G8 measurement wired in. Owner "wrong" taps (regret.js) are the regret; the pause / "no, stop" guess is a
// separate number; autonomy + regret show in the scorecard and the daily report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRegret, readRegrets, effectiveRegrets, regretAppliesTo, regretKey } from '../regret.js';
import { computeShare, summarizeShare, dailyRollup, loadShare } from '../scripts/decision-share.js';
import { buildScorecard } from '../scorecard.js';
import { g8Summary } from '../public/usage.js';
import { g8Lines, run } from '../scripts/daily-checks.js';

const T = (hm, day = 4) => `2026-10-0${day}T${hm}:00.000Z`;
const stall = (o) => ({ type: 'stall', excerpt: o.question, agent: 'claude', ...o });
// two autonomous decisions (manager-actions "answer"), one with an owner pause 5 min later (heuristic regret)
const stalls = [
  stall({ id: 'a', session: 's1', at: T('10:00'), case: 'owner_decision', question: 'ship it?' }),
  stall({ id: 'b', session: 's2', at: T('11:00'), case: 'owner_decision', question: 'merge it?' }),
  { type: 'pause', session: 's2', by: 'owner', at: T('11:05') },
];
const actions = [
  { at: T('10:01'), session: 's1', decision: 'answer: yes ship', trigger: 'event' },
  { at: T('11:01'), session: 's2', decision: 'answer: yes merge', trigger: 'event' },
];
const opts = { days: 7, now: T('23:00'), managerSessions: ['manager'] };

async function tmp() { const d = mkdtempSync(join(tmpdir(), 'g8-')); return d; }

test('regret.js: append, newest line wins, unregret withdraws, bad input is a 400, file is append-only jsonl', async () => {
  const stateDir = await tmp();
  const a = await appendRegret({ stateDir, at: T('10:01'), session: 's1', decision: 'answer: yes' });
  assert.equal(a.type, 'regret');
  await appendRegret({ stateDir, at: T('11:01'), session: 's2' });
  assert.equal(effectiveRegrets(await readRegrets({ stateDir })).length, 2);
  await appendRegret({ stateDir, at: T('11:01'), session: 's2', undo: true });
  const eff = effectiveRegrets(await readRegrets({ stateDir }));
  assert.deepEqual(eff.map((r) => regretKey(r.at, r.session)), [regretKey(T('10:01'), 's1')]);
  assert.equal(readFileSync(join(stateDir, 'manager-regret.jsonl'), 'utf8').trim().split('\n').length, 3);
  await assert.rejects(appendRegret({ stateDir, at: 'nope', session: 's1' }), (e) => e.status === 400);
  await assert.rejects(appendRegret({ stateDir, at: T('10:01'), session: '' }), (e) => e.status === 400);
});

test('regretAppliesTo: session list matches, fleet-wide never, window enforced', () => {
  const l = { at: T('10:01'), session: 's1,s3' };
  const from = Date.parse(T('10:00')), to = Date.parse(T('10:30'));
  assert.equal(regretAppliesTo(l, 's3', from, to), true);
  assert.equal(regretAppliesTo(l, 's2', from, to), false);
  assert.equal(regretAppliesTo({ at: T('10:01'), session: 'all' }, 'all', from, to), false);
  assert.equal(regretAppliesTo({ at: T('12:00'), session: 's1' }, 's1', from, to), false);
});

test('computeShare: regret comes from owner labels; the heuristic is a separate field and number', () => {
  const none = computeShare(stalls, actions, opts);
  assert.equal(none.decisions.every((d) => d.regret === null), true, 'no labels = no measured regret');
  assert.equal(none.decisions.find((d) => d.session === 's2').regretHeuristic?.via, 'pause');
  let s = summarizeShare(none);
  assert.equal(s.autonomyPct, 100);
  assert.equal(s.regretLabelled, 0); assert.equal(s.regretPct, 0);
  assert.equal(s.regretGuess, 1); assert.equal(s.guessPct, 50);
  // owner taps wrong on s1's action: s1 is a regret, s2 stays a guess only
  const lab = computeShare(stalls, actions, { ...opts, regretLabels: [{ type: 'regret', at: T('10:01'), session: 's1', labelledAt: T('12:00') }] });
  assert.equal(lab.decisions.find((d) => d.session === 's1').regret.via, 'label');
  assert.equal(lab.decisions.find((d) => d.session === 's2').regret, null);
  s = summarizeShare(lab);
  assert.equal(s.regretLabelled, 1); assert.equal(s.regretPct, 50);
  assert.equal(s.regretGuess, 1);
  const roll = dailyRollup(lab).total;
  assert.equal(roll.regret, 1); assert.equal(roll.regret_heuristic, 1);
  // a withdrawn tap does not count
  const undone = computeShare(stalls, actions, { ...opts, regretLabels: [{ type: 'regret', at: T('10:01'), session: 's1' }, { type: 'unregret', at: T('10:01'), session: 's1' }] });
  assert.equal(summarizeShare(undone).regretLabelled, 0);
  // a tap on an action outside every decision window is not a regret of that decision
  const off = computeShare(stalls, actions, { ...opts, regretLabels: [{ type: 'regret', at: T('20:00'), session: 's1' }] });
  assert.equal(summarizeShare(off).regretLabelled, 0);
});

test('loadShare reads the state dir including manager-regret.jsonl', async () => {
  const stateDir = await tmp();
  writeFileSync(join(stateDir, 'stalls.jsonl'), stalls.map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(stateDir, 'manager-actions.jsonl'), actions.map((x) => JSON.stringify(x)).join('\n') + '\n');
  await appendRegret({ stateDir, at: T('10:01'), session: 's1', now: () => Date.parse(T('12:00')) });
  const s = summarizeShare(loadShare({ stateDir, days: 7, now: T('23:00') }));
  assert.equal(s.decisions, 2); assert.equal(s.regretLabelled, 1);
});

test('scorecard: buildScorecard carries g8 (autonomy + regret) for its window; the UI sums days', () => {
  const day = Date.parse('2026-10-04T00:00:00Z');
  const regretRecs = [{ type: 'regret', at: T('10:01'), session: 's1' }];
  const sc = buildScorecard({ stallRecs: stalls, actionRecs: actions, regretRecs, from: day, to: day + 86400000, now: day + 86400000 });
  assert.equal(sc.g8.decisions, 2); assert.equal(sc.g8.autonomous, 2);
  assert.equal(sc.g8.autonomyPct, 100); assert.equal(sc.g8.regretPct, 50); assert.equal(sc.g8.guessPct, 50);
  const empty = buildScorecard({ stallRecs: stalls, actionRecs: actions, from: day + 86400000, to: day + 2 * 86400000 });
  assert.equal(empty.g8.decisions, 0);
  const g = g8Summary([sc, empty, { g8: null }]);
  assert.equal(g.decisions, 2); assert.equal(g.autonomyPct, 100); assert.equal(g.regretPct, 50);
  assert.equal(g8Summary([{}]), null);
});

test('daily report: run() writes the G8 section with autonomy, regret and the labelled guess', async () => {
  const home = mkdtempSync(join(tmpdir(), 'g8-daily-'));
  const dir = join(home, '.local/state/ghosty'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stalls.jsonl'), stalls.map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(dir, 'manager-actions.jsonl'), actions.map((x) => JSON.stringify(x)).join('\n') + '\n');
  await appendRegret({ stateDir: dir, at: T('10:01'), session: 's1' });
  const r = await run({ home, now: Date.parse(T('23:00')), argv: ['--dry-run'], out: () => {} });
  const md = readFileSync(r.reportPath, 'utf8');
  assert.match(md, /## Decision share \(G8/);
  assert.match(md, /last 7 days: autonomy 100 % \(2 of 2 stops\), regret 50 % \(1 owner "wrong" taps\), regret guess 50 %/);
  const lines = g8Lines(summarizeShare(computeShare([], [], opts)), summarizeShare(computeShare([], [], opts))).join('\n');
  assert.match(lines, /autonomy n\/a/);
  assert.match(lines, /No regret labels yet/);
});
