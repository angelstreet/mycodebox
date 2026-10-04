// Tests for the manager scorecard (scorecard.js + scripts/manager-run.js + usage/judge.js ledger row).
// Pure functions get fixtures; the CLI and the judge get a tmp state dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildScorecard, scorecardDays, foldRuns, langfuseScoreEvents, scorecardTraceId } from '../scorecard.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const now = new Date('2026-10-04T12:00:00Z').getTime();
const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
const t = (ms) => new Date(ms).toISOString();

const baseUsage = (over = {}) => ({ input: 100, output: 50, cache_read: 200, cache_write_5m: 10, cache_write_1h: 0, ...over });
const baseCost = (total = 0.01) => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, total });

function managerRow({ id, ts = now - 1000, name, label = 'manager', subagent = false, usage = baseUsage(), cost = baseCost(0.001), error = null, ms = 200, model = 'claude-sonnet-4.5' } = {}) {
  return { id: `manager:${id}`, agent: 'manager', session: label, label, subagent, name, ts, model, usage, cost, error, ms, cwd: null };
}
function claudeRow({ id, ts = now - 1000, label, subagent = false, usage = baseUsage({ input: 500, output: 200 }), cost = baseCost(0.02) } = {}) {
  return { id: `claude:${id}`, agent: 'claude', session: `s-${id}`, label, subagent, ts, model: 'claude-sonnet-4.5', usage, cost, cwd: null };
}
function codexRow({ id, ts = now - 1000, label, usage = baseUsage({ input: 400, output: 150 }), cost = baseCost(0.015) } = {}) {
  return { id: `codex:${id}`, agent: 'codex', session: `s-${id}`, label, ts, model: 'gpt-5-codex', usage, cost, cwd: null };
}
function minimaxRow({ id, ts = now - 1000, cwd, subagent = false, usage = baseUsage({ input: 1000, output: 400 }), cost = null } = {}) {
  return { id: `minimax:${id}`, agent: 'minimax', session: `m-${id}`, label: `m-${id}`, subagent, ts, model: 'MiniMax-M3', usage, cost, cwd };
}
function stall({ id, at = t(now - 1000), session = 'task1', kase = 'continue', source = 'rule', jev, forbidden, agent = 'claude', state = 'done' } = {}) {
  return { type: 'stall', id, at, session, case: kase, source, jev, forbidden, agent, state, excerpt: '...' };
}
function outcome({ id, at = t(now - 100), session = 'task1', kind = 'continue', via = 'ghosty', reply = 'Yes, continue', afterSec = 60 } = {}) {
  return { type: 'outcome', id, at, session, kind, via, reply, afterSec };
}
function label({ id, label: l = 'legit', at = t(now - 50), by = 'owner' } = {}) {
  return { type: 'label', id, label: l, at, by };
}
function send({ at = t(now - 90), session = 'task1', by = 'manager' } = {}) {
  return { type: 'send', session, by, at, keys: 'Yes, continue' };
}
function escalated({ at = t(now - 80), session = 'task1', kase = 'owner_decision', reason = 'needs you' } = {}) {
  return { type: 'escalated', at: typeof at === 'number' ? t(at) : at, session, case: kase, reason };
}

const emptyRuns = [];

// ---------------------------------------------------------------------------
// 1. cost buckets
// ---------------------------------------------------------------------------

test('cost: manager session (claude) is counted under session, subagent under subagents', () => {
  const ledger = [
    claudeRow({ id: 'a1', label: 'manager', subagent: false }),                  // session
    claudeRow({ id: 'a2', label: 'manager', subagent: true }),                   // subagents
    codexRow({ id: 'a3', label: 'manager' }),                                    // session
    claudeRow({ id: 'a4', label: 'task05' }),                                    // not counted
    managerRow({ id: 'j1', name: 'manager.jev' }),                               // jev
    managerRow({ id: 'r1', name: 'manager.ai-review' }),                         // reviewer
    managerRow({ id: 'g1', name: 'manager.judge' }),                             // judge
    minimaxRow({ id: 'w1', cwd: '/home/me/worktree-1' }),                        // workers (inside run)
    minimaxRow({ id: 'w2', cwd: '/home/me/worktree-1/sub', subagent: true }),    // workers (subagent still inside run)
    minimaxRow({ id: 'w3', cwd: '/home/me/worktree-other' }),                    // workers (different run)
    minimaxRow({ id: 'x1', cwd: '/home/me/elsewhere' }),                        // outside any run -> not counted
  ];
  const runs = [
    { id: 'r1', kind: 'minimax', worktree: '/home/me/worktree-1', startedAt: now - 5000, endedAt: null },
    { id: 'r2', kind: 'minimax', worktree: '/home/me/worktree-other', startedAt: now - 4000, endedAt: now - 1000 },   // ended; row w3 is in window
  ];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: foldRuns(runs), config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.session.calls, 2, `session calls: ${sc.cost.session.calls}`);          // claude non-sub + codex
  assert.equal(sc.cost.subagents.calls, 1, 'subagents only');
  assert.equal(sc.cost.jev.calls, 1);
  assert.equal(sc.cost.reviewer.calls, 1);
  assert.equal(sc.cost.judge.calls, 1);
  assert.equal(sc.cost.workers.calls, 3, 'workers inside the active run windows only');
  assert.ok(sc.cost.session.tokens.input > 0);
  assert.equal('usd' in sc.cost.workers, false);
  assert.equal('usd' in sc.cost.session, false);
});

test('cost: a MiniMax row outside any run window is not counted; a subagent inside the run is still counted under workers', () => {
  const runs = [{ id: 'r1', kind: 'minimax', worktree: '/home/me/tree', startedAt: now - 2000, endedAt: now - 1000 }];   // already ended
  const ledger = [
    minimaxRow({ id: 'in', ts: now - 1500, cwd: '/home/me/tree' }),          // inside (the window)
    minimaxRow({ id: 'out1', ts: now - 2001, cwd: '/home/me/tree' }),        // before start
    minimaxRow({ id: 'out2', ts: now - 999, cwd: '/home/me/tree' }),         // after end
    minimaxRow({ id: 'elsewhere', ts: now - 1500, cwd: '/home/me/other' }),   // different worktree
    minimaxRow({ id: 'sub', ts: now - 1500, cwd: '/home/me/tree/sub', subagent: true }), // inside
  ];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: foldRuns(runs), config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.workers.calls, 2, `workers.calls=${sc.cost.workers.calls}`);
});

test('cost: total.tokens are the sum of every bucket (session/subagents/jev/reviewer/judge/workers); no USD anywhere', () => {
  const ledger = [
    claudeRow({ id: 'a1', label: 'manager', cost: baseCost(0.01) }),
    claudeRow({ id: 'a2', label: 'manager', subagent: true, cost: baseCost(0.005) }),
    managerRow({ id: 'j1', name: 'manager.jev', cost: baseCost(0.001) }),
    managerRow({ id: 'r1', name: 'manager.ai-review', cost: baseCost(0.002) }),
    managerRow({ id: 'gd', name: 'manager.judge', cost: baseCost(0.003) }),
    minimaxRow({ id: 'w1', cwd: '/home/me/tree' }),
  ];
  const runs = [{ id: 'r1', kind: 'minimax', worktree: '/home/me/tree', startedAt: now - 2000, endedAt: null }];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: foldRuns(runs), config: {}, from: dayStart, to: now + 1 });
  assert.equal('usd' in sc.cost.total, false, 'no USD field anywhere on the bucket');
  for (const k of ['session', 'subagents', 'workers', 'jev', 'reviewer', 'judge', 'total']) assert.equal('usd' in sc.cost[k], false, `${k} has no USD`);
  assert.equal(sc.cost.total.tokens.input, sc.cost.session.tokens.input + sc.cost.subagents.tokens.input + sc.cost.jev.tokens.input + sc.cost.reviewer.tokens.input + sc.cost.judge.tokens.input + sc.cost.workers.tokens.input);
  assert.equal(sc.cost.total.calls, 6);
});

test('cost: jev/reviewer/judge rows are tokens + calls only (OpenRouter calls, no USD in the manager block)', () => {
  const ledger = [managerRow({ id: 'j1', name: 'manager.jev' }), managerRow({ id: 'r1', name: 'manager.ai-review' }), managerRow({ id: 'g1', name: 'manager.judge' })];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.jev.calls, 1);
  assert.equal(sc.cost.reviewer.calls, 1);
  assert.equal(sc.cost.judge.calls, 1);
  assert.equal('usd' in sc.cost.jev, false);
  assert.equal('usd' in sc.cost.reviewer, false);
  assert.equal('usd' in sc.cost.judge, false);
});

test('cost: when manager.json sets managerSessions=["ops"], only "ops" counts', () => {
  const ledger = [claudeRow({ id: 'a1', label: 'manager' }), claudeRow({ id: 'a2', label: 'ops' })];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: { managerSessions: ['ops'] }, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.session.calls, 1);
});

// ---------------------------------------------------------------------------
// 2. performance: stops / outcomes / labels / sends
// ---------------------------------------------------------------------------

test('perf: stops, resolved, resolvedFast, auto, escalated', () => {
  // 4 stalls: id1..id4. id1 resolved in 60s (fast) by an auto send; id2 resolved in 600s (slow); id3 escalated; id4 never resolved.
  const r1 = stall({ id: 'id1', at: t(now - 5000) }); const o1 = outcome({ id: 'id1', at: t(now - 4940), afterSec: 60, via: 'manager' });   // via 'manager' = manager.js auto-send
  const r2 = stall({ id: 'id2', at: t(now - 20000) }); const o2 = outcome({ id: 'id2', at: t(now - 19400), afterSec: 600 });
  const r3 = stall({ id: 'id3', at: t(now - 800) }); const e3 = escalated({ at: now - 700 });
  const r4 = stall({ id: 'id4', at: t(now - 600) });
  const s1 = send({ at: t(now - 4945), by: 'manager' });        // auto-send 5s before id1's outcome, far from id2
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [r1, o1, r2, o2, r3, e3, r4, s1], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.perf.stops, 4);
  assert.equal(sc.perf.resolved, 2);
  assert.equal(sc.perf.resolvedFast, 1);
  assert.equal(sc.perf.auto, 1);
  assert.equal(sc.perf.escalated, 1);
  assert.equal(sc.perf.medianTtrSec, 330, `median = (60+600)/2, got ${sc.perf.medianTtrSec}`);
  assert.equal(sc.perf.p90TtrSec, 600);
});

test('perf: labels -> legacyLabelAgreement (no_reason|legit = right, wrong_case = wrong)', () => {
  // Labels no longer drive quality — popup choices do (phase 11). The label verdict is still
  // exposed as legacyLabelAgreement for callers that want it; agreement (the owner-vs-AI rate
  // from choices) is null when no popup choices have been recorded.
  const recs = [
    stall({ id: 'a' }), outcome({ id: 'a' }),
    stall({ id: 'b' }), outcome({ id: 'b' }),
    stall({ id: 'c' }), outcome({ id: 'c' }),
    stall({ id: 'd' }), outcome({ id: 'd' }),
    label({ id: 'a', label: 'legit' }),
    label({ id: 'b', label: 'no_reason' }),
    label({ id: 'c', label: 'wrong_case', correctCase: 'permission' }),
    // id d unlabelled
  ];
  const sc = buildScorecard({ ledgerRows: [], stallRecs: recs, runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.perf.labelledCount, 3);
  // 2/3 rounds to 0.667 (3dp). The scorecard rounds to 3dp for the response shape.
  assert.ok(Math.abs(sc.perf.legacyLabelAgreement - 0.667) < 0.001, `legacyLabelAgreement ~ 2/3, got ${sc.perf.legacyLabelAgreement}`);
  assert.equal(sc.perf.agreement, null, 'no popup choices -> agreement is null (quality signal is gone)');
  assert.equal(sc.perf.ownerChoices, 0);
});

test('perf: agreement null when no labels and no choices (falls back to jevAgreement; null when both null)', () => {
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [stall({ id: 'a' })], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.perf.agreement, null);
  assert.equal(sc.components.quality, null, 'quality is null with no choices and no jev agreement');
});

// ---------------------------------------------------------------------------
// 3. Jev agreement mapping (take_recommended/continue vs owner; ask_owner vs owner_specific/unknown)
// ---------------------------------------------------------------------------

test('jev.agreement: jev continue matches outcome continue; ask_owner matches owner_specific; unknown and manager-typed outcomes are excluded', () => {
  const cases = [
    { id: 'c', jev: 'continue', kind: 'continue', expect: true },
    { id: 'c2', jev: 'continue', kind: 'take_recommended', expect: false },
    { id: 'r', jev: 'take_recommended', kind: 'take_recommended', expect: true },
    { id: 'r2', jev: 'take_recommended', kind: 'continue', expect: false },
    { id: 'a', jev: 'ask_owner', kind: 'owner_specific', expect: true },
    { id: 'a2', jev: 'ask_owner', kind: 'unknown', expect: null },    // unknown is left out
    { id: 'm', jev: 'continue', kind: 'continue', via: 'manager', expect: null },   // manager-typed: would agree with itself
    { id: 'a3', jev: 'ask_owner', kind: 'continue', expect: false },     // owner said continue despite Jev asking -> disagreement
  ];
  const recs = [];
  for (const c of cases) {
    recs.push(stall({ id: c.id, source: 'jev', jev: { choice: c.jev } }));
    recs.push(outcome({ id: c.id, kind: c.kind, via: c.via || 'ghosty' }));
  }
  const sc = buildScorecard({ ledgerRows: [], stallRecs: recs, runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  const counted = cases.filter((c) => c.expect !== null);
  const trueCount = counted.filter((c) => c.expect).length;
  assert.ok(Math.abs(sc.jev.agreement - trueCount / counted.length) < 0.001, `agreement ~ ${trueCount}/${counted.length}, got ${sc.jev.agreement}`);
  assert.equal(sc.jev.agreementN, counted.length);
});

test('jev.consulted: ambiguous = owner_decision|continue|menu; jevOverridden when the pick is blocked by the forbidden filter', () => {
  const recs = [
    stall({ id: 'a1', kase: 'continue', source: 'jev', jev: { choice: 'continue' } }),                              // consulted
    stall({ id: 'a2', kase: 'menu_recommended', source: 'rule', jev: { choice: 'take_recommended' } }),               // jev consulted even though source is rule
    stall({ id: 'a3', kase: 'owner_decision', source: 'jev', jev: { choice: 'ask_owner' } }),                         // consulted
    stall({ id: 'a4', kase: 'error', source: 'rule' }),                                                                // not consulted (no jev)
    stall({ id: 'a5', kase: 'continue', source: 'jev', jev: { choice: 'continue' }, forbidden: 'push to main' }),    // overridden by forbidden
    stall({ id: 'a6', kase: 'done', source: 'rule' }),
  ];
  const sc = buildScorecard({ ledgerRows: [], stallRecs: recs, runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.jev.consulted.count, 4, 'consulted count');
  assert.equal(sc.jev.overridden, 1, 'forbidden blocks 1 pick');
  assert.ok(Math.abs(sc.jev.consulted.share - 4 / 6) < 0.001, `share ~ 4/6, got ${sc.jev.consulted.share}`);
  // ambiguous = continue|menu_recommended|owner_decision = a1,a2,a3,a5 -> 4
  assert.equal(sc.jev.consulted.ambiguousShare, 1, 'share of ambiguous stops');
});

// ---------------------------------------------------------------------------
// 4. score with a null component (renormalised) + efficiency at 1x/2x/3x
// ---------------------------------------------------------------------------

test('score: no owner choices -> quality null even when Jev agreed (no fallback)', () => {
  const recs = [stall({ id: 'a', source: 'jev', jev: { choice: 'ask_owner' } }), outcome({ id: 'a', kind: 'owner_specific' })];
  const sc = buildScorecard({ ledgerRows: [], stallRecs: recs, runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.jev.agreement, 1);
  assert.equal(sc.components.quality, null);
});

test('score: an empty day has no components -> score null (not 0)', () => {
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.score, null);
});

test('efficiency: an active day with no quota data -> null (quota unknown)', () => {
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [stall({ id: 'a' })], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.components.efficiency, null);
  assert.equal(sc.claude_weekly_pct, null);
});

test('score: quality, coverage and efficiency all 1 -> 100 (with quota data so efficiency has a value)', () => {
  // quality is driven by popup choice records (phase 11), not labels. A single choice that
  // agrees with the AI gives agreeAi=1, coverage=1; no Claude rows -> claude_weekly_pct=0 < budget
  // -> efficiency=1; quality 1, coverage 1 -> score 100.
  const recs = [stall({ id: 'a' }), outcome({ id: 'a' })];
  for (let i = 0; i < 10; i++) recs.push({ type: 'choice', id: `c${i}`, at: t(now - 100 - i), session: 's', kind: 'yesno', owner: 'yes', ai: 'yes', agreeAi: true, jev: null });
  const sc = buildScorecard({ ledgerRows: [], stallRecs: recs, runs: emptyRuns, config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 50, resets_at: Math.floor((now + DAY_MS) / 1000) } });
  assert.equal(sc.components.quality, 1);
  assert.equal(sc.components.coverage, 1);
  assert.equal(sc.components.efficiency, 1);
  assert.equal(sc.score, 100);
});

test('score: all components null -> score null (no components)', () => {
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.components.quality, null);
  assert.equal(sc.components.coverage, null);
  assert.equal(sc.components.efficiency, null);
  assert.equal(sc.score, null);
});

test('efficiency: 1x pro-rated budget -> 1.0; 2x -> 0.5; 3x -> 0.0 (linearly)', () => {
  // plan-week ends at floor(now/1s)*1s -> elapsed = 1, pro-rated budget = 10.
  // Manager owns 1, 2, 3 of every 10 units of Claude cost this week -> weeklyPct = 10, 20, 30.
  const weekEndSec = Math.floor(now / 1000);
  const make = (managerCost) => buildScorecard({
    ledgerRows: [
      claudeRow({ id: 'm', label: 'manager', cost: baseCost(managerCost), ts: now - 1000 }),
      claudeRow({ id: 'o', label: 'task', cost: baseCost(10 - managerCost), ts: now - 1000 }),
    ],
    stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1,
    claudeRateLimits: { used_percentage: 100, resets_at: weekEndSec }, now,
  });
  assert.equal(Math.round(make(1).components.efficiency * 1000) / 1000, 1, '1x -> 1');
  assert.equal(Math.round(make(2).components.efficiency * 1000) / 1000, 0.5, '2x -> 0.5');
  assert.equal(make(3).components.efficiency, 0, '3x -> 0');
  assert.equal(make(1000).components.efficiency, 0, 'way above -> 0');
});

// ---------------------------------------------------------------------------
// 4b. Claude weekly plan share (no USD: weight = cost.total; never displayed)
// ---------------------------------------------------------------------------

test('claude_weekly_pct: manager share of Claude week = (manager weight / total weight) * used_percentage', () => {
  // Plan-week ends in 4 days: window = [now-3d, now+4d). All three rows fall inside.
  const weekEndSec = Math.floor((now + 4 * DAY_MS) / 1000);
  // Manager owns 25% of the total Claude spend this week (cost.total):
  //  manager rows sum to 0.025, all rows sum to 0.100. used_percentage = 40 -> 0.25 * 40 = 10.
  const ledger = [
    claudeRow({ id: 'm1', label: 'manager', cost: baseCost(0.01), ts: now - 2 * DAY_MS }),
    claudeRow({ id: 'm2', label: 'manager', cost: baseCost(0.015), ts: now - 1 * DAY_MS }),
    claudeRow({ id: 'o1', label: 'task07', cost: baseCost(0.075), ts: now - 2 * DAY_MS + 3600000 }),
  ];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 40, resets_at: weekEndSec }, now });
  assert.equal(sc.claude_weekly_pct, 10, `manager share = 0.25 * 40 = 10, got ${sc.claude_weekly_pct}`);
  // Today: only m1 and o1 are in [dayStart, now+1); m2 is now-1d which is within today if dayStart is recent.
  // dayStart = floor(now / DAY_MS) * DAY_MS; now is at noon UTC, so dayStart ≈ now - 12h.
  // m1 is now-2d (outside today), m2 is now-1d (outside today), o1 is now-2d+1h (outside today).
  // So manager today weight = 0, but manager weekly = 0.025, total weekly = 0.10 -> todayPct = 0.
  assert.equal(sc.claude_today_pct, 0, `today share = 0, got ${sc.claude_today_pct}`);
  assert.equal(sc.budget.claudeWeeklyPct, 10);
});

test('claude_weekly_pct: rows outside the plan-week are excluded from the weights', () => {
  // Plan-week ends in 1 day (covers [now-6d, now+1d)). A row 8 days old is outside -> ignored.
  const weekEndSec = Math.floor((now + DAY_MS) / 1000);
  const ledger = [
    claudeRow({ id: 'old', label: 'manager', cost: baseCost(1), ts: now - 8 * DAY_MS }),    // outside
    claudeRow({ id: 'in',  label: 'manager', cost: baseCost(0.01), ts: now - DAY_MS }),
  ];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 80, resets_at: weekEndSec }, now });
  assert.equal(sc.claude_weekly_pct, 80, 'only the in-window row counts -> manager owns all Claude spend -> weeklyPct = 80');
});

test('claude_weekly_pct: no quota data -> weekly_pct null + efficiency null', () => {
  const ledger = [claudeRow({ id: 'm1', label: 'manager', cost: baseCost(0.01) })];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.claude_weekly_pct, null);
  assert.equal(sc.claude_today_pct, null);
  assert.equal(sc.components.efficiency, null);
});

test('claude_weekly_pct: when quota exists but no Claude rows, share is 0 (not null)', () => {
  const ledger = [managerRow({ id: 'j1', name: 'manager.jev' })];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 60, resets_at: Math.floor((now + 2 * DAY_MS) / 1000) }, now });
  assert.equal(sc.claude_weekly_pct, 0);
  assert.equal(sc.claude_today_pct, 0);
});

test('claude_weekly_pct: unknown resets_at falls back to the rolling last 7 days', () => {
  // No resets_at -> plan-week = [now-7d, now). A row 8 days old is outside; a row 1 day old is inside.
  const ledger = [
    claudeRow({ id: 'm1', label: 'manager', cost: baseCost(0.01), ts: now - DAY_MS }),
    claudeRow({ id: 'old', label: 'manager', cost: baseCost(1), ts: now - 8 * DAY_MS }),
  ];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 30 }, now });
  // Only m1 counts -> manager owns all of the in-window Claude spend -> weeklyPct = 30.
  assert.equal(sc.claude_weekly_pct, 30);
});

test('cost: no USD field anywhere in the scorecard output', () => {
  // One of every bucket with a priced ledger row.
  const ledger = [
    claudeRow({ id: 'a1', label: 'manager', cost: baseCost(0.01) }),
    claudeRow({ id: 'a2', label: 'manager', subagent: true, cost: baseCost(0.005) }),
    managerRow({ id: 'j1', name: 'manager.jev', cost: baseCost(0.001) }),
    managerRow({ id: 'r1', name: 'manager.ai-review', cost: baseCost(0.002) }),
    managerRow({ id: 'gd', name: 'manager.judge', cost: baseCost(0.003) }),
    minimaxRow({ id: 'w1', cwd: '/home/me/tree' }),
  ];
  const runs = [{ id: 'r1', kind: 'minimax', worktree: '/home/me/tree', startedAt: now - 2000, endedAt: null }];
  const sc = buildScorecard({ ledgerRows: ledger, stallRecs: [], runs: foldRuns(runs), config: {}, from: dayStart, to: now + 1, claudeRateLimits: { used_percentage: 50, resets_at: Math.floor((now + 3 * DAY_MS) / 1000) }, now });
  const asJson = JSON.stringify(sc);
  assert.equal(/\busd\b/.test(asJson), false, 'no "usd" anywhere in the JSON: ' + asJson.slice(0, 200));
  assert.equal(/\$\d/.test(JSON.stringify(sc.budget)), false, 'no $ in budget');
  assert.equal('claudeWeeklyPct' in sc.budget, true);
  assert.equal('session' in sc.budget, false, 'no budget.session anymore');
  assert.equal('ai' in sc.budget, false, 'no budget.ai anymore');
});

// ---------------------------------------------------------------------------
// 5. scorecardDays
// ---------------------------------------------------------------------------

test('scorecardDays: one card per UTC day, oldest first', () => {
  const cards = scorecardDays({ ledgerRows: [], stallRecs: [], runs: emptyRuns, config: {}, days: 3, now });
  assert.equal(cards.length, 3);
  for (let i = 1; i < cards.length; i++) assert.ok(cards[i].from > cards[i - 1].from);
});

// ---------------------------------------------------------------------------
// 6. scripts/manager-run.js CLI: start / end fold
// ---------------------------------------------------------------------------

test('manager-run.js: start prints id; end folds by id; list reads back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-run-'));
  const prev = process.env.GHOSTY_STATE_DIR; process.env.GHOSTY_STATE_DIR = dir;
  try {
    const id = execFileSync('node', ['scripts/manager-run.js', 'start', '--kind', 'minimax', '--worktree', '/tmp/foo', '--task', 'demo'], { encoding: 'utf8' }).trim();
    assert.match(id, /^[0-9a-f-]{36}$/);
    execFileSync('node', ['scripts/manager-run.js', 'end', id, '--verdict', 'accepted'], { encoding: 'utf8' });
    const file = readFileSync(join(dir, 'manager-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(file.length, 2);
    const folded = foldRuns(file);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].id, id);
    assert.equal(folded[0].kind, 'minimax');
    assert.equal(folded[0].worktree, '/tmp/foo');
    assert.equal(folded[0].verdict, 'accepted');
    assert.ok(folded[0].endedAt > folded[0].startedAt);
  } finally { if (prev) process.env.GHOSTY_STATE_DIR = prev; else delete process.env.GHOSTY_STATE_DIR; }
});

test('manager-run.js: rejects unknown kind and bad verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-run-'));
  const prev = process.env.GHOSTY_STATE_DIR; process.env.GHOSTY_STATE_DIR = dir;
  try {
    assert.throws(() => execFileSync('node', ['scripts/manager-run.js', 'start', '--kind', 'wrong', '--worktree', '/tmp/x'], { encoding: 'utf8' }));
    assert.throws(() => execFileSync('node', ['scripts/manager-run.js', 'end', 'abc', '--verdict', 'meh'], { encoding: 'utf8' }));
  } finally { if (prev) process.env.GHOSTY_STATE_DIR = prev; else delete process.env.GHOSTY_STATE_DIR; }
});

// ---------------------------------------------------------------------------
// 7. usage/judge.js writes one manager.judge ledger row per call (success + unparsable)
// ---------------------------------------------------------------------------

test('judge.js: appends manager.judge ledger rows for each call (success + unparsable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-judge-'));
  const ledgerFile = join(dir, 'usage-ledger.jsonl');
  const judgeStateFile = join(dir, 'lfeval-judge.json');
  // pre-populate one triage record so the judge has something to do
  const stallsFile = join(dir, 'stalls.jsonl');
  const triage = { type: 'triage', id: 'stop-j-1', session: 'task-x', at: t(now - 500), case: 'continue', mode: 'simulate',
    ai: { proposed_reply: 'Yes, continue.', reasoning: 'looks fine', confidence: 0.9, owner_needed: false, owner_needed_why: null } };
  writeFileSync(stallsFile, JSON.stringify(triage) + '\n');
  // callComplete in triage.js does `await r.json()`, so the fake fetch returns an object with a .json() method.
  // postBatch in lf-common.js does `r.text()` (we never send events in this test, but fetch still gets called when a score is created).
  // First pass: stop-j-1 -> parseable content -> one judge call -> one ledger row
  const mkRes = (jsonBody) => ({ ok: true, status: 200, json: async () => jsonBody, text: async () => JSON.stringify(jsonBody) });
  const fetchFn1 = async () => mkRes({ success: true, content: '{"score":0.8,"reasoning":"ok"}', model: 'judge', cost: 0.01, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  const { createJudge } = await import('../usage/judge.js');
  const commitTo = (f) => async (rows) => appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const j1 = createJudge({ stallsFile, judgeStateFile, jevUrl: 'http://x/server/ai/decide', jevApiKey: 'k', now: () => now }, { commit: commitTo(ledgerFile), fetchFn: fetchFn1, random: () => 0, log: () => {} });
  const pass1 = await j1();
  // Add a second triage record with unparsable content
  appendFileSync(stallsFile, JSON.stringify({ ...triage, id: 'stop-j-2', at: t(now - 400) }) + '\n');
  let n = 0;
  const fetchFn2 = async () => { n++; return mkRes({ success: true, content: n === 1 ? '{"score":0.9,"reasoning":"good"}' : 'not json', model: 'judge', cost: 0.015, usage: { prompt_tokens: 110, completion_tokens: 22, total_tokens: 132 } }); };
  const j2 = createJudge({ stallsFile, judgeStateFile, jevUrl: 'http://x/server/ai/decide', jevApiKey: 'k', now: () => now }, { commit: commitTo(ledgerFile), fetchFn: fetchFn2, random: () => 0, log: () => {} });
  const pass2 = await j2();
  assert.equal(pass1.judged, 1);
  assert.equal(pass2.judged, 1);
  assert.ok(existsSync(ledgerFile), 'ledger file written');
  const rows = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, `2 rows, got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.agent, 'manager');
    assert.equal(r.name, 'manager.judge');
    assert.ok(r.usage.input > 0 || r.usage.output > 0, 'usage tokens present');
    assert.ok(r.cost && r.cost.total > 0, 'cost present');
    assert.equal(r.subagent, false);
  }
  // the scorecard picks those up as cost.judge
  const sc = buildScorecard({ ledgerRows: rows, stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.judge.calls, 2);
  assert.ok(sc.cost.judge.tokens.input > 0, 'judge tokens present');
});

// ---------------------------------------------------------------------------
// 8. langfuseScoreEvents: deterministic ids, score names match the spec, null values skipped
// ---------------------------------------------------------------------------

test('langfuseScoreEvents: deterministic ids, score names from the spec; null values skipped; no USD', () => {
  const sc = { from: t(dayStart), to: t(dayStart + DAY_MS), score: 80, components: { quality: 0.9, coverage: 0.5, efficiency: 0.8 },
    cost: { total: { tokens: { input: 100, output: 50, cache_read: 0, cache_write: 0 } }, workers: { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } },
    claude_weekly_pct: 4.2, claude_today_pct: 0.8,
    perf: { stops: 10 } };
  const evs = langfuseScoreEvents(sc, { traceId: scorecardTraceId(now), traceName: 'manager-scorecard', sentAt: now });
  // 1 trace-create + 6 scores (score, quality, coverage, efficiency, claude_weekly_pct, claude_today_pct); manager.tokens included (non-zero), manager.workers_tokens skipped when 0; jev.* skipped when null
  const names = evs.filter((e) => e.type === 'score-create').map((e) => e.body.name);
  assert.ok(names.includes('manager.score'));
  assert.ok(names.includes('manager.quality'));
  assert.ok(names.includes('manager.coverage'));
  assert.ok(names.includes('manager.efficiency'));
  assert.ok(names.includes('manager.claude_weekly_pct'));
  assert.ok(names.includes('manager.claude_today_pct'));
  assert.ok(names.includes('manager.tokens'));
  assert.equal(names.includes('manager.cost_usd'), false, 'manager.cost_usd is gone');
  // deterministic ids
  const again = langfuseScoreEvents(sc, { traceId: scorecardTraceId(now), traceName: 'manager-scorecard', sentAt: now });
  for (let i = 0; i < evs.length; i++) assert.equal(evs[i].body.id, again[i].body.id);
});
// ---------------------------------------------------------------------------
// 9. popup choice records: quality = owner-vs-AI agreement (phase 11)
// ---------------------------------------------------------------------------

test('choice records: agreeAi drives quality, ownerChoices/agreeAi/agreeJev counted in perf', () => {
  // three choices: owner agreed with the AI twice, disagreed once; one jev agreement, one jev disagreement
  const recs = [
    { type: 'choice', id: 's1', at: t(now - 1000), session: 'a', kind: 'choice', owner: 'yes', ai: 'yes', agreeAi: true, jev: 'continue', agreeJev: true },
    { type: 'choice', id: 's2', at: t(now - 800), session: 'b', kind: 'choice', owner: 'no', ai: 'yes', agreeAi: false, jev: 'continue', agreeJev: false },
    // ai is null (no AI proposal): agreeAi stays null, not counted toward agreeAi
    { type: 'choice', id: 's3', at: t(now - 600), session: 'c', kind: 'choice', owner: 'reply', ai: null, agreeAi: null, jev: 'ask_owner', agreeJev: true },
    // duplicate (later write wins)
    { type: 'choice', id: 's2', at: t(now - 500), session: 'b', kind: 'choice', owner: 'yes', ai: 'yes', agreeAi: true, jev: 'continue', agreeJev: true },
  ];
  const sc = buildScorecard({ stallRecs: recs, ledgerRows: [], runs: [], from: dayStart, to: dayStart + DAY_MS });
  assert.equal(sc.perf.ownerChoices, 3);
  // 3 had ai != null across the two duplicate ids (latest s2 counts): s1 yes/yes, s2 yes/yes (latest), s3 null -> agreeAiTotal=2
  assert.equal(sc.perf.agreeAiN, 2);
  assert.equal(sc.perf.agreeAi, 1.0);    // both agreed
  // 4 jev votes after dedupe (s1 true, s2 latest true, s3 true) = 3 of 3
  assert.equal(sc.perf.agreeJevN, 3);
  assert.equal(sc.perf.agreeJev, 1.0);
  // fewer than 10 owner choices with an AI pick: quality stays null
  assert.equal(sc.components.quality, null);
});

test('choice records: no agreeAi votes -> quality null, Jev agreement only in the jev block', () => {
  const recs = [
    { type: 'stall', id: 's1', at: t(now - 1000), session: 'a', case: 'continue', source: 'jev', jev: { choice: 'continue', confidence: 0.9 } },
    { type: 'outcome', id: 's1', at: t(now - 500), session: 'a', kind: 'continue', afterSec: 5, via: 'reporter' },
  ];
  const sc = buildScorecard({ stallRecs: recs, from: dayStart, to: dayStart + DAY_MS });
  assert.equal(sc.perf.ownerChoices, 0);
  assert.equal(sc.perf.agreeAi, null);
  assert.equal(sc.jev.agreement, 1.0);    // Jev said continue, outcome was continue -> agree
  assert.equal(sc.components.quality, null);  // no fallback to jevAgreement
});

// ---------------------------------------------------------------------------
// 10. ledger dedupe by id: a growing-id writer rewrites the same row
// ---------------------------------------------------------------------------

test('ledger dedupe by id: a row re-written with a growing id is counted once (latest wins)', () => {
  // a single growing-id call: first write at t=10 (100 tokens / 0.01 usd), rewrite at t=20 (200 / 0.02)
  const rows = [
    { id: 1, agent: 'manager', name: 'manager.jev', label: 'manager', subagent: false, ts: now - 10000, usage: { input: 100, output: 0, cache_read: 0, cache_write: 0 }, cost: { total: 0.01 } },
    { id: 1, agent: 'manager', name: 'manager.jev', label: 'manager', subagent: false, ts: now - 9000,  usage: { input: 200, output: 0, cache_read: 0, cache_write: 0 }, cost: { total: 0.02 } },
  ];
  const sc = buildScorecard({ ledgerRows: rows, stallRecs: [], runs: [], from: dayStart, to: dayStart + DAY_MS });
  // after dedupe: one row, 200 input; tokens only — no USD on the bucket
  assert.equal(sc.cost.jev.tokens.input, 200);
  assert.equal(sc.cost.jev.calls, 1);
  assert.equal('usd' in sc.cost.jev, false);
});

test('ledger rows without an id pass through unchanged', () => {
  const rows = [
    { agent: 'manager', name: 'manager.jev', label: 'manager', ts: now - 5000, usage: { input: 50, output: 0, cache_read: 0, cache_write: 0 }, cost: { total: 0.005 } },
    { agent: 'manager', name: 'manager.jev', label: 'manager', ts: now - 4000, usage: { input: 70, output: 0, cache_read: 0, cache_write: 0 }, cost: { total: 0.007 } },
  ];
  const sc = buildScorecard({ ledgerRows: rows, stallRecs: [], runs: [], from: dayStart, to: dayStart + DAY_MS });
  assert.equal(sc.cost.jev.tokens.input, 120);
  assert.equal(sc.cost.jev.calls, 2);
});

test('judgeMean comes from the manager.judge ledger rows (extra.score); failed rows carry none', () => {
  const j = (id, score) => ({ ...managerRow({ id, name: 'manager.judge' }), extra: { score } });
  const sc = buildScorecard({ ledgerRows: [j('a', 0.5), j('b', 1), j('c', null)], stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.perf.judgeMean, 0.75);
});

test('deploys: run/failed from the runner rows finished in the window; null without any', () => {
  const dl = [{ state: 'done', finished: now - 1000 }, { state: 'failed', finished: Math.floor((now - 500) / 1000) }, { state: 'done', finished: now - 3 * DAY_MS }, { state: 'queued' }];
  const sc = buildScorecard({ ledgerRows: [], stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, deployList: dl });
  assert.deepEqual(sc.perf.deploys, { run: 2, failed: 1 });
  assert.equal(buildScorecard({ ledgerRows: [], stallRecs: [], runs: emptyRuns, config: {}, from: dayStart, to: now + 1, deployList: [] }).perf.deploys, null);
});

test('workers window includes runs of kind gate', () => {
  const runs = [{ id: 'g', kind: 'gate', worktree: '/home/me/gate', startedAt: now - 5000, endedAt: null }];
  const sc = buildScorecard({ ledgerRows: [minimaxRow({ id: 'w', cwd: '/home/me/gate' })], stallRecs: [], runs: foldRuns(runs), config: {}, from: dayStart, to: now + 1 });
  assert.equal(sc.cost.workers.calls, 1);
});
