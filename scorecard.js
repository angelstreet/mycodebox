// Manager scorecard (TASK-44): performance and total cost of the AI manager, with the Jev integration
// (consulted / errored / agreed / overridden / cost per decision). Pure functions over arrays of records +
// a small loader that tails the ledger and reads stalls.jsonl + manager-runs.jsonl incrementally.
//
//   GET /api/manager/scorecard?days=7  -> { today: <scorecard>, days: [<scorecard per UTC day>] }
//   node usage/ingest.js               -> once per 15 min, posts the current day's scorecard as Langfuse scores
//
// What the scorecard counts:
//
//   1. cost.session   ledger rows for which label in config.managerSessions (default ["manager"])
//                     and agent in ('claude','codex'); subagents are reported separately as cost.subagents
//   2. cost.workers   minimax rows whose cwd is in any active manager-runs.jsonl window
//                     (kind:minimax, startedAt <= ts <= endedAt|now)
//   3. cost.jev       manager rows with name 'manager.jev'
//   4. cost.reviewer  manager rows with name 'manager.ai-review'
//   5. cost.judge     manager rows with name 'manager.judge' (written by usage/judge.js; see _judgeRows)
//
// Performance: counts of stall/outcome/escalated/send records from <state dir>/stalls.jsonl, with the
// "right" verdict for a stop being no_reason|legit (not wrong_case), case-correct (no correctCase), and
// the AI reviewer's "right" verdict when the owner marks aiVerdict:right.
//
// Jev integration: a stop was Jev-consulted when stall.source === 'jev' OR stall.jev?.choice is set.
// Agreement: Jev said `continue`/`take_recommended`/`ask_owner` and the owner's outcome matched (a `continue`
// outcome, the recommended option, or `ask_owner`-style = `owner_specific`/`unknown`).

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { effectiveLabels } from './decisions.js';

const DAY_MS = 86400000;
const AMBIGUOUS_CASES = new Set(['owner_decision', 'continue', 'menu_recommended']);
// Owner-action / menu / continue questions are the cases that genuinely need judgement;
// 'done'/'error'/'stopped_short'/'waiting_deploy'/'owner_action'/'background_wait' have their own path.
const JEV_MEANING = {
  continue: 'continue',
  take_recommended: 'take_recommended',
  ask_owner: 'ask_owner',
};
const SCORE_DEFAULTS = {
  scoreWeights: { quality: 0.4, coverage: 0.3, efficiency: 0.3 },
  costBudget: { sessionUsd: 10, aiUsd: 1 },
  managerSessions: ['manager'],
};

// ---------------------------------------------------------------------------
// Pure: one day's scorecard
// ---------------------------------------------------------------------------

// Manager "right" on a stop (label verdict). Definitions, in priority:
//   - `no_reason` and `legit` both mean "this stop was wanted" - the classifier / Jev was right.
//     `legit` is a positive accept of a question, `no_reason` rejects a stop-without-reason.
//   - `wrong_case` with `correctCase` means the classifier picked the wrong case -> not right.
//   - `wrong_case` without `correctCase` is rare but treated as not right (it is a complaint).
//   - the AI reviewer's own `aiVerdict:right` rides on any label; here we look at the label itself.
// When there is no label at all, agreement is null and quality falls back to jevAgreement (or is excluded).
function labelRight(r, ctx) {
  if (!r || !r.label) return null;
  const lab = r.label.label;
  if (lab === 'legit' || lab === 'no_reason') return true;
  if (lab === 'wrong_case') return false;     // either with or without correctCase -> not right
  return null;
}

// Was the outcome produced by the manager's own auto-send? manager.js writes outcome.via = 'manager' exactly when the
// pending stall had an auto-send (p.auto); otherwise via is 'reporter' | 'ghosty' | 'terminal' | 'unknown' (the owner moved it).
const wasAuto = (o) => o.via === 'manager';

// Jev's pick mapped to the owner's reply kind.
//   jev 'continue'        -> outcome.kind === 'continue'
//   jev 'take_recommended' -> outcome.kind === 'take_recommended'
//   jev 'ask_owner'       -> outcome.kind === 'owner_specific' | 'unknown' (owner picked something else / nothing)
// Owner_specific covers "owner wrote something else" — Jev said ask_owner and the owner did answer; that is
// the expected outcome of an ask_owner pick.
function jevAgrees(jevChoice, outcomeKind) {
  if (!jevChoice || !outcomeKind) return null;
  if (jevChoice === 'continue') return outcomeKind === 'continue';
  if (jevChoice === 'take_recommended') return outcomeKind === 'take_recommended';
  if (jevChoice === 'ask_owner') return outcomeKind === 'owner_specific' || outcomeKind === 'unknown';
  return null;
}

// Time-to-resolution stats from a list of numeric seconds (outcome.afterSec). null when empty.
// p90 uses ceil so a small sample (1-2) still maps to the upper tail — the floor default would land on the lower
// value for n=2, which is unintuitive for "90 % of resolutions are at most this".
function pctStats(xs) {
  if (!xs || !xs.length) return { median: null, p90: null, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const idx = Math.min(s.length - 1, Math.ceil(0.9 * (s.length - 1)));
  return { median, p90: s[idx], n: s.length };
}

// Adds one ledger row's tokens + cost to a bucket.
//   { tokens:{input,output,cache_read,cache_write}, usd|null, calls }
function addBucket(b, r) {
  if (!r) return;
  const u = r.usage || {};
  b.tokens.input += u.input || 0;
  b.tokens.output += u.output || 0;
  b.tokens.cache_read += u.cache_read || 0;
  b.tokens.cache_write += u.cache_write_5m || 0;        // we fold 5m + 1h into cache_write for the scorecard
  if (r.usage?.cache_write_1h) b.tokens.cache_write += r.usage.cache_write_1h;
  if (r.cost && Number.isFinite(r.cost.total)) b.usd = (b.usd || 0) + r.cost.total;   // unpriced rows add tokens only; usd stays null until a priced row appears
  b.calls++;
}
const emptyBucket = () => ({ tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, usd: null, calls: 0 });

// Reads cfg.config with defaults. cfg.config may be a managerConfig() snapshot or a slice of one.
export function resolveConfig(cfg) {
  const scoreWeights = { ...SCORE_DEFAULTS.scoreWeights, ...(cfg?.config?.scoreWeights || {}) };
  const costBudget = { ...SCORE_DEFAULTS.costBudget, ...(cfg?.config?.costBudget || {}) };
  const managerSessions = Array.isArray(cfg?.config?.managerSessions) && cfg.config.managerSessions.length
    ? cfg.config.managerSessions : SCORE_DEFAULTS.managerSessions;
  const judgeMean = (cfg?.judgeScores && Number.isFinite(cfg.judgeScores.mean)) ? cfg.judgeScores.mean : null;
  const deploys = cfg?.deploys && (Number.isFinite(cfg.deploys.run) || Number.isFinite(cfg.deploys.failed)) ? cfg.deploys : null;
  return { scoreWeights, costBudget, managerSessions, judgeMean, deploys };
}

// main builder. cfg = { ledgerRows, stallRecs, runs, config, from, to, judgeScores?, deploys? }
//   ledgerRows   : array of usage-ledger records (the same shape as usage-summary.json: {agent, name, subagent, ts, model, usage, cost|null, cwd, ...})
//   stallRecs    : array of stalls.jsonl records (mixed types: stall/outcome/send/escalated/label/...)
//   runs         : array of manager-runs.jsonl records (already folded; start + end merged)
//   config       : manager config snapshot (managerSessions, scoreWeights, costBudget)
//   from, to     : ms epoch window; records with ts in [from,to) are counted (to is exclusive)
// Returns the scorecard object.
export function buildScorecard({ ledgerRows = [], stallRecs = [], runs = [], config = {}, from, to } = {}) {
  const { scoreWeights, costBudget, managerSessions, judgeMean, deploys } = resolveConfig({ config });
  const cost = {
    session: emptyBucket(),
    subagents: emptyBucket(),
    workers: emptyBucket(),
    jev: emptyBucket(),
    reviewer: emptyBucket(),
    judge: emptyBucket(),
    total: emptyBucket(),
  };
  const labels = effectiveLabels(stallRecs);
  const labelled = new Map();   // stopId -> effectiveLabel
  for (const [id, lab] of labels) labelled.set(id, lab);

  // index manager-runs by worktree path -> runs[] (start, end inclusive of startedAt, [endedAt|now])
  const runByWorktree = new Map();
  for (const r of runs) {
    if (!r || !r.worktree) continue;
    const arr = runByWorktree.get(r.worktree) || [];
    arr.push({ startedAt: r.startedAt, endedAt: r.endedAt || null, kind: r.kind || 'minimax' });
    runByWorktree.set(r.worktree, arr);
  }
  const inRunWindow = (cwd, ts) => {
    if (!cwd) return false;
    for (const [key, list] of runByWorktree) {
      if (cwd === key || cwd.startsWith(key + '/')) {
        for (const r of list) {
          if (r.kind && r.kind !== 'minimax' && r.kind !== 'other') continue;
          const e = r.endedAt == null ? Number.MAX_SAFE_INTEGER : r.endedAt;
          if (ts >= r.startedAt && ts <= e) return true;
        }
      }
    }
    return false;
  };

  // ledger cost buckets
  for (const r of ledgerRows || []) {
    if (typeof r.ts !== 'number' || (from != null && r.ts < from) || (to != null && r.ts >= to)) continue;
    if (r.agent === 'claude' || r.agent === 'codex') {
      if (managerSessions.includes(r.label || r.session)) {
        if (r.subagent) addBucket(cost.subagents, r);
        else addBucket(cost.session, r);
      }
    } else if (r.agent === 'minimax') {
      if (inRunWindow(r.cwd, r.ts)) addBucket(cost.workers, r);
    } else if (r.agent === 'manager') {
      if (r.name === 'manager.jev') addBucket(cost.jev, r);
      else if (r.name === 'manager.ai-review') addBucket(cost.reviewer, r);
      else if (r.name === 'manager.judge') addBucket(cost.judge, r);
    }
  }
  // total = sum of priced buckets (MiniMax workers' cost stays null since MiniMax has no price)
  const sumBucket = (b) => ({
    tokens: { ...b.tokens },
    usd: b.usd == null ? null : Math.round(b.usd * 1000) / 1000,
    calls: b.calls,
  });
  const pricedBuckets = [cost.session, cost.subagents, cost.jev, cost.reviewer, cost.judge].filter((b) => b.usd != null);
  const totalUsd = pricedBuckets.length ? pricedBuckets.reduce((a, b) => a + b.usd, 0) : null;
  cost.total = { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, usd: totalUsd == null ? null : Math.round(totalUsd * 1000) / 1000, calls: 0 };
  for (const k of ['session', 'subagents', 'jev', 'reviewer', 'judge', 'workers']) {
    cost.total.tokens.input += cost[k].tokens.input;
    cost.total.tokens.output += cost[k].tokens.output;
    cost.total.tokens.cache_read += cost[k].tokens.cache_read;
    cost.total.tokens.cache_write += cost[k].tokens.cache_write;
    cost.total.calls += cost[k].calls;
  }
  // round USD to 3dp so the values don't drift
  for (const k of Object.keys(cost)) cost[k] = sumBucket(cost[k]);

  // ---- performance ----
  // index records by id (latest wins; same convention as the rest of the manager code).
  const byId = new Map();
  for (const r of stallRecs || []) {
    if (!r || r.type !== 'stall' || !r.id) continue;
    const prev = byId.get(r.id);
    if (!prev || (Date.parse(r.at) || 0) >= (Date.parse(prev.at) || 0)) byId.set(r.id, r);
  }
  const outcomes = new Map();
  for (const r of stallRecs || []) if (r && r.type === 'outcome' && r.id) outcomes.set(r.id, r);
  const sends = [];
  for (const r of stallRecs || []) if (r && r.type === 'send' && r.at) sends.push(r);
  const escalated = (stallRecs || []).filter((r) => r && r.type === 'escalated');

  let stops = 0, resolved = 0, resolvedFast = 0, autoCount = 0;
  const ttrs = [];
  let consulted = 0, consultedOfAmbiguous = 0;
  const ambigTotal = { count: 0 };
  let jevOverridden = 0;
  let jevConsultedStops = 0;
  let jevAgreedCount = 0, jevAgreeTotal = 0;
  let rightCount = 0, labCount = 0;

  for (const [id, s] of byId) {
    if (from != null && (Date.parse(s.at) || 0) < from) continue;
    if (to != null && (Date.parse(s.at) || 0) >= to) continue;
    stops++;
    const ambig = AMBIGUOUS_CASES.has(s.case);
    if (ambig) ambigTotal.count++;
    const jevConsultedHere = !!(s.jev && (s.jev.choice || s.jev.error !== undefined));
    const sourceIsJev = s.source === 'jev';
    if (sourceIsJev || jevConsultedHere) {
      consulted++;
      jevConsultedStops++;
      if (ambig) consultedOfAmbiguous++;
      if (s.forbidden && s.jev?.choice && (s.jev.choice === 'continue' || s.jev.choice === 'take_recommended')) jevOverridden++;
    }
    const o = outcomes.get(id);
    if (o) {
      resolved++;
      const sec = Number.isFinite(o.afterSec) ? o.afterSec : null;
      if (sec != null) ttrs.push(sec);
      if (sec != null && sec <= 300) resolvedFast++;
      if (wasAuto(o)) autoCount++;
      if (sourceIsJev && s.jev?.choice) {
        const a = jevAgrees(s.jev.choice, o.kind);
        if (a != null) { jevAgreeTotal++; if (a) jevAgreedCount++; }
      }
    }
    const lab = labelled.get(id);
    if (lab) {
      labCount++;
      const r = labelRight({ label: lab }, {});
      if (r === true) rightCount++;
    }
  }

  const ttr = pctStats(ttrs);
  const escalatedCount = escalated.filter((e) => from == null || (Date.parse(e.at) || 0) >= from).filter((e) => to == null || (Date.parse(e.at) || 0) < to).length;

  // ---- Jev own stats from ledger rows ----
  const jevRows = (ledgerRows || []).filter((r) => r.agent === 'manager' && r.name === 'manager.jev' && (from == null || r.ts >= from) && (to == null || r.ts < to));
  let jevErrors = 0, jevMsSum = 0, jevMsCount = 0, jevMsSamples = [];
  for (const r of jevRows) {
    if (r.error) jevErrors++;
    if (Number.isFinite(r.ms)) { jevMsSum += r.ms; jevMsCount++; jevMsSamples.push(r.ms); }
  }
  const sortedMs = jevMsSamples.slice().sort((a, b) => a - b);
  const jevP50ms = sortedMs.length ? sortedMs[Math.floor((sortedMs.length - 1) / 2)] : null;
  // cost per jev decision
  const jevCostPerDecision = jevRows.length ? (cost.jev.usd != null ? cost.jev.usd / jevRows.length : null) : null;

  // tokensPerResolvedStop = worker tokens / resolved
  const tokensPerResolvedStop = resolved ? Math.round(cost.workers.tokens.input + cost.workers.tokens.output + cost.workers.tokens.cache_read + cost.workers.tokens.cache_write) / resolved : null;

  // ---- score ----
  const agreement = labCount ? rightCount / labCount : null;
  const jevAgreement = jevAgreeTotal ? jevAgreedCount / jevAgreeTotal : null;
  // sessionUsd = session + subagents (the manager's *own* sessions, including subagents)
  const sessionUsd = (cost.session.usd != null || cost.subagents.usd != null) ? Math.round(((cost.session.usd || 0) + (cost.subagents.usd || 0)) * 1000) / 1000 : null;
  const aiUsd = (cost.jev.usd != null || cost.reviewer.usd != null || cost.judge.usd != null)
    ? Math.round(((cost.jev.usd || 0) + (cost.reviewer.usd || 0) + (cost.judge.usd || 0)) * 1000) / 1000 : null;
  const coverage = stops ? resolvedFast / stops : null;
  // efficiency is null when we have no priced data for either bucket — otherwise use the worse of the two ratios.
  let efficiency;
  if (sessionUsd == null && aiUsd == null) efficiency = null;
  else {
    const ratios = [];
    if (sessionUsd != null) ratios.push(sessionUsd / Math.max(1e-9, costBudget.sessionUsd));
    if (aiUsd != null) ratios.push(aiUsd / Math.max(1e-9, costBudget.aiUsd));
    const r = Math.max(...ratios);
    efficiency = Math.max(0, Math.min(1, (3 - r) / 2));
  }
  // quality falls back to jevAgreement when agreement is null; null when both are null
  const qualityRaw = agreement != null ? agreement : jevAgreement;
  const hasQuality = qualityRaw != null;
  // components used to score, with weights renormalised when one is null
  const components = { quality: hasQuality ? qualityRaw : null, coverage, efficiency };
  const used = Object.entries(components).filter(([, v]) => v != null);
  const totalW = used.reduce((a, [,], _i, arr) => a + scoreWeights[arr[_i][0]], 0);
  let score = 0;
  if (totalW > 0) {
    for (const [k, v] of used) score += scoreWeights[k] * v;
    score = Math.max(0, Math.min(1, score / totalW)) * 100;
  }
  const budget = {
    session: { usd: sessionUsd, budget: costBudget.sessionUsd },
    ai: { usd: aiUsd, budget: costBudget.aiUsd },
    weights: scoreWeights,
  };

  return {
    from: from != null ? new Date(from).toISOString() : null,
    to: to != null ? new Date(to).toISOString() : null,
    score: Math.round(score * 10) / 10,
    components: { quality: hasQuality ? Math.round(qualityRaw * 1000) / 1000 : null, coverage: coverage != null ? Math.round(coverage * 1000) / 1000 : null, efficiency: efficiency != null ? Math.round(efficiency * 1000) / 1000 : null },
    cost,
    perf: {
      stops, resolved, resolvedFast, auto: autoCount, escalated: escalatedCount,
      medianTtrSec: ttr.median != null ? Math.round(ttr.median) : null,
      p90TtrSec: ttr.p90 != null ? Math.round(ttr.p90) : null,
      agreement: agreement != null ? Math.round(agreement * 1000) / 1000 : null,
      judgeMean: judgeMean != null ? Math.round(judgeMean * 1000) / 1000 : null,
      deploys,
      labelledCount: labCount,
      tokensPerResolvedStop: tokensPerResolvedStop != null ? Math.round(tokensPerResolvedStop) : null,
    },
    jev: {
      consulted: { count: consulted, share: stops ? Math.round((consulted / stops) * 1000) / 1000 : null, ambiguousShare: ambigTotal.count ? Math.round((consultedOfAmbiguous / ambigTotal.count) * 1000) / 1000 : null },
      errors: jevErrors,
      errorRate: jevRows.length ? Math.round((jevErrors / jevRows.length) * 1000) / 1000 : null,
      p50ms: jevP50ms != null ? Math.round(jevP50ms) : null,
      agreement: jevAgreement != null ? Math.round(jevAgreement * 1000) / 1000 : null,
      agreementN: jevAgreeTotal,
      overridden: jevOverridden,
      costPerDecision: jevCostPerDecision != null ? Math.round(jevCostPerDecision * 10000) / 10000 : null,
    },
    budget,
  };
}

// Build one scorecard per UTC day in the window [now-days*DAY_MS, now], oldest first.
export function scorecardDays({ ledgerRows = [], stallRecs = [], runs = [], config = {}, days = 7, now = Date.now(), judgeScoresByDay = null, deploysByDay = null } = {}) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const to = Math.floor((now - i * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS * (i === 0 ? 1 : 1);   // end of that UTC day
    // simpler: align from/to to UTC day boundaries
    const day = Math.floor((now - i * DAY_MS) / DAY_MS);
    const from = day * DAY_MS;
    const end = from + DAY_MS;
    const dayKey = new Date(from).toISOString().slice(0, 10);
    const judgeScores = judgeScoresByDay?.[dayKey] || null;
    const deploys = deploysByDay?.[dayKey] || null;
    out.push(buildScorecard({ ledgerRows, stallRecs, runs, config, from, to: end, judgeScores, deploys }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loader: tails the ledger and reads stalls.jsonl + manager-runs.jsonl
// ---------------------------------------------------------------------------

function hash16(s) { return createHash('sha1').update(s).digest('hex').slice(0, 16); }

// One JSONL file -> array of objects (skip blank lines, swallow JSON errors, fail open on ENOENT).
async function readJsonl(path, opts = {}) {
  let text = '';
  try { text = await fs.readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { if (opts.silent) continue; else throw new Error(`bad json in ${path}: ${l.slice(0, 80)}`); }
  }
  return out;
}

// Resolves the state dir the way other modules do (manager.js, usage/ingest.js).
export function stateDir(env = process.env) {
  return env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
}

// Folds manager-runs.jsonl: each line is either a `start` ({id, kind, worktree, task, startedAt, by}) or an `end`
// ({id, endedAt, verdict?}). Pre-folded records (both startedAt and endedAt) pass through unchanged.
export function foldRuns(lines) {
  const ends = new Map();
  for (const l of lines || []) {
    if (!l || !l.id) continue;
    if (l.endedAt != null && l.startedAt == null) {
      const prev = ends.get(l.id) || {};
      ends.set(l.id, { ...prev, endedAt: l.endedAt, verdict: l.verdict || prev.verdict });
    }
  }
  const out = [];
  const seen = new Set();
  for (const l of lines || []) {
    if (!l || !l.id) continue;
    if (l.endedAt != null && l.startedAt != null) { out.push(l); seen.add(l.id); continue; }   // pre-folded
    if (l.endedAt != null) continue;
    if (!l.worktree || !l.startedAt) continue;
    const e = ends.get(l.id);
    out.push({ id: l.id, kind: l.kind || 'minimax', worktree: l.worktree, task: l.task || null, startedAt: l.startedAt, endedAt: e ? e.endedAt : null, verdict: e ? e.verdict : null, by: l.by || null });
    seen.add(l.id);
  }
  // End records whose start never matched (rare; defensive)
  for (const [id, e] of ends) if (!seen.has(id)) out.push({ id, kind: 'minimax', worktree: null, task: null, startedAt: 0, endedAt: e.endedAt, verdict: e.verdict, by: null });
  return out;
}

// Build the scorecard for one UTC day boundary [from, to). All I/O.
export async function loadScorecard({ from, to, env = process.env, fsLib = fs, log = console.log } = {}) {
  const dir = stateDir(env);
  const [ledgerRows, stallRecs, runsLines, judgeLines] = await Promise.all([
    readJsonl(join(dir, 'usage-ledger.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'stalls.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-runs.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'lfeval-judge.json')).catch(() => []),
  ]);
  const runs = foldRuns(runsLines);
  // judge scores: lfeval-judge.json is the judge's own state file (day, calls, done: {stopId: state});
  // the scorecard only reads the cached `mean` if the writer saved one. Not invented otherwise.
  const judgeScores = judgeLines.find?.((r) => r && r.mean) || null;
  const config = await readConfig(env, fsLib);
  return buildScorecard({ ledgerRows, stallRecs, runs, config, from, to, judgeScores, deploys: null });
}

// days=1..30. Returns { today, days: [oldest..today] } for the UI.
export async function loadScorecardDays({ days = 7, env = process.env, fsLib = fs } = {}) {
  const dir = stateDir(env);
  const [ledgerRows, stallRecs, runsLines] = await Promise.all([
    readJsonl(join(dir, 'usage-ledger.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'stalls.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-runs.jsonl'), { silent: true }).catch(() => []),
  ]);
  const runs = foldRuns(runsLines);
  const config = await readConfig(env, fsLib);
  const all = scorecardDays({ ledgerRows, stallRecs, runs, config, days, now: Date.now() });
  return { today: all[all.length - 1], days: all };
}

async function readConfig(env, fsLib) {
  try {
    const txt = await fsLib.readFile(join(stateDir(env), 'manager.json'), 'utf8');
    return JSON.parse(txt);
  } catch { return {}; }
}

// Cache wrapper: < 60 s we serve from the in-memory map.
const cache = new Map();      // key -> { at, value }
export async function cachedScorecard({ days = 7, ttlMs = 60000, env = process.env } = {}) {
  const key = `${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loadScorecardDays({ days, env });
  cache.set(key, { at: Date.now(), value });
  return value;
}

// A small helper used by the Langfuse posting: build the events for one scorecard.
export function langfuseScoreEvents(scorecard, { traceId = 'manager-scorecard', traceName = 'manager-scorecard', sentAt = Date.now() } = {}) {
  const stamp = new Date(sentAt).toISOString();
  const events = [];
  // one trace-create per day (deterministic id so replays upsert)
  events.push({ id: hash16(`ev:trace:${traceId}`), type: 'trace-create', timestamp: stamp, body: {
    id: traceId, name: traceName, timestamp: stamp, sessionId: traceId,
    tags: ['manager-scorecard'], metadata: { day: (scorecard.to || '').slice(0, 10), score: scorecard.score, stops: scorecard.perf.stops },
  } });
  const score = (name, value) => {
    if (value == null || !Number.isFinite(value)) return;
    events.push({ id: hash16(`ev:score:${traceId}:${name}`), type: 'score-create', timestamp: stamp, body: {
      id: hash16(`score:${traceId}:${name}`), traceId, name, dataType: 'NUMERIC', value,
    } });
  };
  score('manager.score', scorecard.score);
  score('manager.quality', scorecard.components.quality);
  score('manager.coverage', scorecard.components.coverage);
  score('manager.efficiency', scorecard.components.efficiency);
  score('manager.cost_usd', scorecard.cost.total.usd);
  score('manager.tokens', scorecard.cost.total.tokens.input + scorecard.cost.total.tokens.output + scorecard.cost.total.tokens.cache_read + scorecard.cost.total.tokens.cache_write);
  score('manager.workers_tokens', scorecard.cost.workers.tokens.input + scorecard.cost.workers.tokens.output + scorecard.cost.workers.tokens.cache_read + scorecard.cost.workers.tokens.cache_write);
  const j = scorecard.jev || {};
  score('jev.consulted_rate', j.consulted ? j.consulted.share : null);
  score('jev.error_rate', j.errorRate);
  score('jev.agreement', j.agreement);
  score('jev.p50_ms', j.p50ms);
  return events;
}

// Trace id for one UTC day (so the Langfuse trace name is "manager-scorecard" and the id is
// `manager-scorecard-<YYYY-MM-DD>`; upserts overwrite).
export const scorecardTraceId = (ts = Date.now()) => `manager-scorecard-${new Date(ts).toISOString().slice(0, 10)}`;