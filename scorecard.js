// Manager scorecard (TASK-44): performance of the AI manager and its share of the Claude weekly plan, with
// the Jev integration (consulted / errored / agreed / overridden). Pure functions over arrays of records +
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
//                     (kind:minimax, startedAt <= ts <= endedAt|now) — tokens only, MiniMax has no price
//   3. cost.jev       manager rows with name 'manager.jev' — OpenRouter, tokens + calls only (no USD)
//   4. cost.reviewer  manager rows with name 'manager.ai-review' — tokens + calls only (no USD)
//   5. cost.judge     manager rows with name 'manager.judge' — tokens + calls only (no USD)
//
// claude_weekly_pct / claude_today_pct: the manager's share of the Claude Max weekly plan. The API-equivalent
// cost per ledger row is the internal weight (it reflects how the plan limits weigh models, output and cache)
// and is never displayed. Manager weight = sum of cost.total for Claude rows whose label is in managerSessions
// (incl. subagents) in the plan-week (the 7 days ending at the Claude seven_day resets_at, or the last 7 days
// if unknown). All Claude weight = sum of cost.total for every Claude row in the plan-week. Today uses the
// same denominator against rows in [from, to).
//
// Performance: counts of stall/outcome/escalated/send records from <state dir>/stalls.jsonl, with the
// "right" verdict for a stop being no_reason|legit (not wrong_case), case-correct (no correctCase), and
// the AI reviewer's "right" verdict when the owner marks aiVerdict:right.
//
// Jev integration: a stop was Jev-consulted when stall.source === 'jev' OR stall.jev?.choice is set.
// Agreement: Jev said `continue`/`take_recommended`/`ask_owner` and the owner's outcome matched
// (outcomeFromReplyKind of the outcome kind; `unknown` outcomes and manager-typed outcomes are left out).
//
// Owner choice (popup, phase 11): {type:'choice', id, owner:<button|reply>, ai:<button|null>, agreeAi,
// jev, agreeJev}. The popup records every owner tap so we measure owner-vs-AI agreement BEFORE
// auto-answering is switched on; quality is now driven by these choice records (not by label verdicts).
// Multi-question form (kind 'multi'): owner/ai are { "<question n>": "<option n>" }; the record carries agreeAiQ (per question),
// aiQs (questions the AI picked) and agreeQs (of those, how many the owner matched). The scorecard counts one AI vote per
// covered question (agreeAiTotal += aiQs, agreeAiCount += agreeQs), so a 6-question form weighs 6, not 1; no AI picks = no votes.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { effectiveLabels, outcomeFromReplyKind } from './decisions.js';
import { OWNER_THRESHOLD } from './router-shadow.js';
import { computeShare, summarizeShare } from './scripts/decision-share.js';

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
  planBudget: { claudeWeeklyPct: 10 },
  managerSessions: ['manager'],
};

// ---------------------------------------------------------------------------
// Pure: one day's scorecard
// ---------------------------------------------------------------------------

// labelRight is kept only for legacy use elsewhere; the scorecard quality now comes from the
// owner's choice records (`agreeAi`), not from label verdicts. The function returns null when
// no label verdict applies so the scorecard can fall back to jevAgreement or stay null.
function labelRight(r, ctx) {
  if (!r || !r.label) return null;
  const lab = r.label.label;
  if (lab === 'legit' || lab === 'no_reason') return true;
  if (lab === 'wrong_case') return false;     // either with or without correctCase -> not right
  return null;
}

// Dedupes ledger rows by id, keeping the latest (a single call can rewrite the same row with a
// growing id). Returns the array unchanged when no id field exists.
function dedupeLedgerById(rows) {
  const byId = new Map();
  const noId = [];
  for (const r of rows || []) {
    if (!r || typeof r.id !== 'number' && typeof r.id !== 'string') { noId.push(r); continue; }
    const prev = byId.get(r.id);
    if (!prev || (Number(r.ts) || 0) >= (Number(prev.ts) || 0)) byId.set(r.id, r);
  }
  return noId.concat([...byId.values()]);
}

// Was the outcome produced by the manager's own auto-send? manager.js writes outcome.via = 'manager' exactly when the
// pending stall had an auto-send (p.auto); otherwise via is 'reporter' | 'ghosty' | 'terminal' | 'unknown' (the owner moved it).
const wasAuto = (o) => o.via === 'manager';

// Jev's pick vs what the owner really did. The outcome kind goes through outcomeFromReplyKind (continue |
// take_recommended | ask_owner | null); `unknown` maps to null and is left out of the comparison, and so are outcomes the
// manager typed itself (outcome.via === 'manager': Jev's continue would agree with itself).
function jevAgrees(jevChoice, outcome) {
  if (!jevChoice || !outcome || wasAuto(outcome)) return null;
  const truth = outcomeFromReplyKind(outcome.kind);
  if (!truth) return null;
  return truth === jevChoice;
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

// 7-day plan window ending at the Claude seven_day resets_at; if unknown (status-line hook not installed),
// fall back to the rolling last 7 days from `now` so the share + efficiency still report something.
function planWeekOf(claudeRateLimits, now) {
  if (claudeRateLimits && Number.isFinite(claudeRateLimits.resets_at) && claudeRateLimits.resets_at > 0) {
    const end = claudeRateLimits.resets_at * 1000;
    return { start: end - 7 * DAY_MS, end };
  }
  return { start: now - 7 * DAY_MS, end: now };
}

// Adds one ledger row's tokens to a bucket.
//   { tokens:{input,output,cache_read,cache_write}, calls }
function addBucket(b, r) {
  if (!r) return;
  const u = r.usage || {};
  b.tokens.input += u.input || 0;
  b.tokens.output += u.output || 0;
  b.tokens.cache_read += u.cache_read || 0;
  b.tokens.cache_write += u.cache_write_5m || 0;        // we fold 5m + 1h into cache_write for the scorecard
  if (r.usage?.cache_write_1h) b.tokens.cache_write += r.usage.cache_write_1h;
  b.calls++;
}
const emptyBucket = () => ({ tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 0 });

// Reads cfg.config with defaults. cfg.config may be a managerConfig() snapshot or a slice of one.
export function resolveConfig(cfg) {
  const scoreWeights = { ...SCORE_DEFAULTS.scoreWeights, ...(cfg?.config?.scoreWeights || {}) };
  const planBudget = { ...SCORE_DEFAULTS.planBudget, ...(cfg?.config?.planBudget || {}) };
  const managerSessions = Array.isArray(cfg?.config?.managerSessions) && cfg.config.managerSessions.length
    ? cfg.config.managerSessions : SCORE_DEFAULTS.managerSessions;
  return { scoreWeights, planBudget, managerSessions };
}

// main builder. cfg = { ledgerRows, stallRecs, runs, config, from, to, deployList?, claudeRateLimits?, now? }
//   deployList       : the deploy runner's registry rows ({state:'done'|'failed', finished}); perf.deploys = {run, failed} finished in the window, null without any
//   ledgerRows       : array of usage-ledger records (the same shape as usage-summary.json: {agent, name, subagent, ts, model, usage, cost|null, cwd, ...})
//   stallRecs        : array of stalls.jsonl records (mixed types: stall/outcome/send/escalated/label/...)
//   runs             : array of manager-runs.jsonl records (already folded; start + end merged)
//   config           : manager config snapshot (managerSessions, scoreWeights, planBudget)
//   from, to         : ms epoch window; records with ts in [from,to) are counted (to is exclusive)
//   claudeRateLimits : { used_percentage, resets_at } from claude-rate-limits.json seven_day window, or null
//   now              : ms epoch used for the plan-week and pro-rated efficiency; defaults to Date.now()
// Returns the scorecard object.
export function buildScorecard({ ledgerRows = [], stallRecs = [], eventRecs = [], runs = [], config = {}, from, to, deployList = null, claudeRateLimits = null, now = Date.now(), actionRecs = [], regretRecs = [] } = {}) {
  const { scoreWeights, planBudget, managerSessions } = resolveConfig({ config });
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
          const e = r.endedAt == null ? Number.MAX_SAFE_INTEGER : r.endedAt;
          if (ts >= r.startedAt && ts <= e) return true;
        }
      }
    }
    return false;
  };

  // ledger cost buckets (dedupe rows that share an id — a growing-id writer rewrites the same row)
  const ledger = dedupeLedgerById(ledgerRows);
  for (const r of ledger) {
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
  // total = sum of every bucket (no USD anywhere: Claude/Codex buckets weight the weekly share internally,
  // MiniMax workers have no price, Jev/reviewer/judge are OpenRouter real-money and tokens-only).
  const sumBucket = (b) => ({ tokens: { ...b.tokens }, calls: b.calls });
  cost.total = { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 0 };
  for (const k of ['session', 'subagents', 'jev', 'reviewer', 'judge', 'workers']) {
    cost.total.tokens.input += cost[k].tokens.input;
    cost.total.tokens.output += cost[k].tokens.output;
    cost.total.tokens.cache_read += cost[k].tokens.cache_read;
    cost.total.tokens.cache_write += cost[k].tokens.cache_write;
    cost.total.calls += cost[k].calls;
  }
  for (const k of Object.keys(cost)) cost[k] = sumBucket(cost[k]);

  // judge mean: the score carried by the manager.judge ledger rows of the window (unparsable / failed rows carry none)
  const judgeScoreList = ledger.filter((r) => r.agent === 'manager' && r.name === 'manager.judge' && typeof r.ts === 'number' && (from == null || r.ts >= from) && (to == null || r.ts < to)
    && Number.isFinite(r.extra?.score)).map((r) => r.extra.score);
  const judgeMean = judgeScoreList.length ? judgeScoreList.reduce((a, b) => a + b, 0) / judgeScoreList.length : null;
  // deploys the runner finished in the window (registry times may be seconds or ms)
  let deploys = null;
  if (Array.isArray(deployList)) {
    const fin = deployList.filter((d) => d && (d.state === 'done' || d.state === 'failed') && d.finished > 0)
      .map((d) => ({ state: d.state, at: d.finished < 1e12 ? d.finished * 1000 : d.finished }))
      .filter((d) => (from == null || d.at >= from) && (to == null || d.at < to));
    if (fin.length) deploys = { run: fin.length, failed: fin.filter((d) => d.state === 'failed').length };
  }

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
  // owner-vs-AI agreement from popup choice records (phase 11): each {type:'choice', id} becomes
  // one vote. agreeAi=true when owner===ai (ai is null on the popup when there was no AI highlight).
  const choicesById = new Map();
  for (const r of stallRecs || []) {
    if (r && r.type === 'choice' && r.id) {
      const prev = choicesById.get(r.id);
      if (!prev || (Date.parse(r.at) || 0) >= (Date.parse(prev.at) || 0)) choicesById.set(r.id, r);
    }
  }
  let ownerChoices = 0, agreeAiCount = 0, agreeAiTotal = 0;
  let popupJevAgreeCount = 0, popupJevAgreeTotal = 0;
  for (const [, c] of choicesById) {
    if (from != null && (Date.parse(c.at) || 0) < from) continue;
    if (to != null && (Date.parse(c.at) || 0) >= to) continue;
    ownerChoices++;
    if (c.kind === 'multi') {   // multi-question form: one vote per AI-covered question (aiQs / agreeQs), not one per stop
      if (c.aiQs > 0) { agreeAiTotal += c.aiQs; agreeAiCount += c.agreeQs || 0; }
    } else if (c.ai != null) { agreeAiTotal++; if (c.agreeAi === true) agreeAiCount++; }
    if (typeof c.agreeJev === 'boolean') { popupJevAgreeTotal++; if (c.agreeJev) popupJevAgreeCount++; }
  }

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
        const a = jevAgrees(s.jev.choice, o);
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
  const jevRows = ledger.filter((r) => r.agent === 'manager' && r.name === 'manager.jev' && (from == null || r.ts >= from) && (to == null || r.ts < to));
  let jevErrors = 0, jevMsSum = 0, jevMsCount = 0, jevMsSamples = [];
  for (const r of jevRows) {
    if (r.error) jevErrors++;
    if (Number.isFinite(r.ms)) { jevMsSum += r.ms; jevMsCount++; jevMsSamples.push(r.ms); }
  }
  const sortedMs = jevMsSamples.slice().sort((a, b) => a - b);
  const jevP50ms = sortedMs.length ? sortedMs[Math.floor((sortedMs.length - 1) / 2)] : null;

  // tokensPerResolvedStop = worker tokens / resolved
  const tokensPerResolvedStop = resolved ? Math.round(cost.workers.tokens.input + cost.workers.tokens.output + cost.workers.tokens.cache_read + cost.workers.tokens.cache_write) / resolved : null;

  // ---- Claude weekly plan share ----
  // Internal weight per ledger row = cost.total (how the Claude plan limits weigh models, output and cache); never
  // displayed. Plan-week = 7 days ending at the Claude seven_day resets_at (or last 7 days if unknown). Manager
  // rows = Claude rows with label in managerSessions (subagents included); total = every Claude row in the week.
  const planWeek = planWeekOf(claudeRateLimits, now);
  const dailyStart = from != null ? from : Math.floor(now / DAY_MS) * DAY_MS;
  const dailyEnd = to != null ? to : Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  let managerWeekWeight = 0, totalWeekWeight = 0, managerTodayWeight = 0;
  for (const r of ledger) {
    if (r.agent !== 'claude') continue;
    if (typeof r.ts !== 'number') continue;
    const w = r.cost && Number.isFinite(r.cost.total) ? r.cost.total : 0;
    const isManager = managerSessions.includes(r.label || r.session);
    if (r.ts >= planWeek.start && r.ts < planWeek.end) {
      totalWeekWeight += w;
      if (isManager) managerWeekWeight += w;
    }
    if (r.ts >= dailyStart && r.ts < dailyEnd && isManager) managerTodayWeight += w;
  }
  const weeklyUsedPct = claudeRateLimits && Number.isFinite(claudeRateLimits.used_percentage) ? claudeRateLimits.used_percentage : null;
  const hasQuota = weeklyUsedPct != null;
  const claude_weekly_pct = hasQuota
    ? (totalWeekWeight > 0 ? (managerWeekWeight / totalWeekWeight) * weeklyUsedPct : 0)
    : null;
  const claude_today_pct = hasQuota
    ? (totalWeekWeight > 0 ? (managerTodayWeight / totalWeekWeight) * weeklyUsedPct : 0)
    : null;

  // ---- score ----
  // Quality is the share of popup choices where the owner agreed with the AI's pick (ai != null, agreeAi === true),
  // once >= MIN_CHOICES of them exist; null before that (weights renormalised).
  const ownerAgreementAi = agreeAiTotal ? agreeAiCount / agreeAiTotal : null;
  const jevAgreement = jevAgreeTotal ? jevAgreedCount / jevAgreeTotal : null;
  const agreement = ownerAgreementAi;        // legacy field = the popup quality signal
  const legacyLabelAgreement = labCount ? rightCount / labCount : null;   // kept for any caller that still wants it
  const coverage = stops ? resolvedFast / stops : null;
  // Efficiency = 1 when the manager's weekly % is at or under the budget pro-rated to the elapsed fraction of the
  // plan-week, linearly to 0 at 3x; null when no Claude quota data (the status line hook isn't installed or is stale).
  let efficiency;
  if (!hasQuota) efficiency = null;
  else {
    const weekMs = planWeek.end - planWeek.start;
    const elapsed = weekMs > 0 ? Math.max(0, Math.min(1, (now - planWeek.start) / weekMs)) : 0;
    const prorated = elapsed * planBudget.claudeWeeklyPct;
    if (prorated <= 0) efficiency = claude_weekly_pct <= 0 ? 1 : 0;
    else efficiency = Math.max(0, Math.min(1, (3 - claude_weekly_pct / prorated) / 2));
  }
  // quality = owner-vs-AI agreement only, and only from MIN_CHOICES popup answers on: a handful of samples (or Jev's
  // outcome agreement, reported in the jev block) must not stand in for the owner's judgement.
  const MIN_CHOICES = 10;
  const qualityRaw = agreement != null && agreeAiTotal >= MIN_CHOICES ? agreement : null;
  const hasQuality = qualityRaw != null;
  // components used to score, with weights renormalised when one is null
  const components = { quality: hasQuality ? qualityRaw : null, coverage, efficiency };
  const used = Object.entries(components).filter(([, v]) => v != null);
  const totalW = used.reduce((a, [,], _i, arr) => a + scoreWeights[arr[_i][0]], 0);
  let score = null;
  if (totalW > 0) {
    for (const [k, v] of used) score += scoreWeights[k] * v;
    score = Math.max(0, Math.min(1, score / totalW)) * 100;
  }
  const budget = {
    claudeWeeklyPct: planBudget.claudeWeeklyPct,
    planWeek: { start: new Date(planWeek.start).toISOString(), end: new Date(planWeek.end).toISOString(), elapsed: weeklyUsedPct != null ? Math.round((planWeek.end - planWeek.start > 0 ? Math.max(0, Math.min(1, (now - planWeek.start) / (planWeek.end - planWeek.start))) : 0) * 1000) / 1000 : null },
    weights: scoreWeights,
  };

  return {
    from: from != null ? new Date(from).toISOString() : null,
    to: to != null ? new Date(to).toISOString() : null,
    score: score == null ? null : Math.round(score * 10) / 10,
    components: { quality: hasQuality ? Math.round(qualityRaw * 1000) / 1000 : null, coverage: coverage != null ? Math.round(coverage * 1000) / 1000 : null, efficiency: efficiency != null ? Math.round(efficiency * 1000) / 1000 : null },
    cost,
    claude_weekly_pct: claude_weekly_pct != null ? Math.round(claude_weekly_pct * 1000) / 1000 : null,
    claude_today_pct: claude_today_pct != null ? Math.round(claude_today_pct * 1000) / 1000 : null,
    perf: {
      stops, resolved, resolvedFast, auto: autoCount, escalated: escalatedCount,
      medianTtrSec: ttr.median != null ? Math.round(ttr.median) : null,
      p90TtrSec: ttr.p90 != null ? Math.round(ttr.p90) : null,
      // agreement is the owner-vs-AI rate from the popup choices (phase 11). jevAgreement stays
      // here too as a fallback (the Jev integration stats).
      agreement: agreement != null ? Math.round(agreement * 1000) / 1000 : null,
      legacyLabelAgreement: legacyLabelAgreement != null ? Math.round(legacyLabelAgreement * 1000) / 1000 : null,
      judgeMean: judgeMean != null ? Math.round(judgeMean * 1000) / 1000 : null,
      deploys,
      labelledCount: labCount,
      tokensPerResolvedStop: tokensPerResolvedStop != null ? Math.round(tokensPerResolvedStop) : null,
      // popup-choice fields (owner vs AI vs Jev)
      ownerChoices,
      agreeAi: ownerAgreementAi != null ? Math.round(ownerAgreementAi * 1000) / 1000 : null,
      agreeAiN: agreeAiTotal,
      agreeJev: popupJevAgreeTotal ? Math.round((popupJevAgreeCount / popupJevAgreeTotal) * 1000) / 1000 : null,
      agreeJevN: popupJevAgreeTotal,
    },
    jev: {
      consulted: { count: consulted, share: stops ? Math.round((consulted / stops) * 1000) / 1000 : null, ambiguousShare: ambigTotal.count ? Math.round((consultedOfAmbiguous / ambigTotal.count) * 1000) / 1000 : null },
      errors: jevErrors,
      errorRate: jevRows.length ? Math.round((jevErrors / jevRows.length) * 1000) / 1000 : null,
      p50ms: jevP50ms != null ? Math.round(jevP50ms) : null,
      agreement: jevAgreement != null ? Math.round(jevAgreement * 1000) / 1000 : null,
      agreementN: jevAgreeTotal,
      overridden: jevOverridden,
    },
    budget,
    // G8 (autonomy >= 80 %, regret <= 5 %): same numbers as scripts/decision-share.js, for this window. regretPct = owner
    // "wrong" taps only; guessPct = the old pause / "no, stop" heuristic, a separate number. Null without a window.
    g8: from != null && to != null ? g8Section({ stallRecs, actionRecs, regretRecs, from, to, managerSessions }) : null,
    router: routerSection({ stallRecs, from, to }),
    wakeShadow: wakeShadowSection({ eventRecs, stallRecs, from, to }),
  };
}

export function g8Section({ stallRecs, actionRecs = [], regretRecs = [], from, to, managerSessions = [] }) {
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  return summarizeShare(computeShare(stallRecs, actionRecs, { days, now: to, until: to, managerSessions, regretLabels: regretRecs }));
}

// ---------------------------------------------------------------------------
// Router shadow (TASK-47 G2): Jev's 3 answers per stop vs what the rules did. Shadow only; nothing here is acted on.
// ---------------------------------------------------------------------------
const NEEDS_OWNER_CASES = new Set(['owner_decision', 'owner_action', 'permission', 'error', 'waiting_deploy']);
const MOVES_ON_CASES = new Set(['continue', 'stopped_short', 'menu_recommended', 'done', 'background_wait']);
// Did the case fit what is known about the stop? true / false / null (nothing known). An owner label beats the owner's
// next reply: wrong_case + correctCase is exact; legit = a case that needs the owner; no_reason = one that moves on.
// An outcome: "continue" -> continue / stopped_short; "take_recommended" -> menu_recommended; the owner typing something
// of their own -> anything except the three that move on by themselves.
function caseFits(kase, lab, o) {
  if (lab) {
    if (lab.label === 'wrong_case') return lab.correctCase ? kase === lab.correctCase : null;
    if (lab.label === 'legit') return NEEDS_OWNER_CASES.has(kase);
    if (lab.label === 'no_reason') return MOVES_ON_CASES.has(kase);
  }
  if (o && !wasAuto(o)) {
    if (o.kind === 'continue') return kase === 'continue' || kase === 'stopped_short';
    if (o.kind === 'take_recommended') return kase === 'menu_recommended';
    if (o.kind === 'owner_specific') return !['continue', 'stopped_short', 'menu_recommended'].includes(kase);
  }
  return null;
}
// The owner really was needed: a legit label, else the owner typing something of their own. null = unknown.
function ownerWasNeeded(lab, o) {
  if (lab?.label === 'legit') return true;
  if (lab?.label === 'no_reason') return false;
  if (o && !wasAuto(o) && o.kind === 'owner_specific') return true;
  if (o && !wasAuto(o) && (o.kind === 'continue' || o.kind === 'take_recommended')) return false;
  return null;
}
export function routerSection({ stallRecs = [], from, to } = {}) {
  const inWin = (at) => { const t = Date.parse(at) || 0; return (from == null || t >= from) && (to == null || t < to); };
  const routers = new Map(), outcomes = new Map(), escIds = new Set();
  const stalls = new Map();
  for (const r of stallRecs || []) {
    if (!r || !r.id) continue;
    if (r.type === 'router') routers.set(r.id, r);
    else if (r.type === 'outcome') outcomes.set(r.id, r);
    else if (r.type === 'escalated') escIds.add(r.id);
    else if (r.type === 'stall') stalls.set(r.id, r);
  }
  const labels = effectiveLabels(stallRecs);
  const out = { decisions: 0, errors: 0, skipped: 0, graded: { n: 0, ruleCaseRight: 0, jevCaseRight: 0 }, owner: { flagged: 0, flaggedNotEscalated: 0, confirmed: 0, known: 0 }, wake: { jevOpus: 0, ruleOpus: 0 } };
  for (const [id, r] of routers) {
    if (!inWin(r.at)) continue;
    const j = r.router || {};
    if (j.skipped) { out.skipped++; continue; }
    if (j.error || !j.case) { out.errors++; continue; }
    out.decisions++;
    const escalated = escIds.has(id) || r.escalated === true;
    const lab = labels.get(id), o = outcomes.get(id);
    const ruleCase = r.rule_case ?? stalls.get(id)?.case;
    const rf = caseFits(ruleCase, lab, o), jf = caseFits(j.case, lab, o);
    if (rf != null && jf != null) { out.graded.n++; if (rf) out.graded.ruleCaseRight++; if (jf) out.graded.jevCaseRight++; }
    if (j.owner != null && j.owner >= OWNER_THRESHOLD) {
      out.owner.flagged++;
      if (!escalated) {
        out.owner.flaggedNotEscalated++;
        const need = ownerWasNeeded(lab, o);
        if (need != null) { out.owner.known++; if (need) out.owner.confirmed++; }
      }
    }
    if (j.wake === 'wake_opus') out.wake.jevOpus++;
    if (escalated) out.wake.ruleOpus++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wake shadow (TASK-47 G10): Jev's opinion on each manager event (`jev` on the manager-events.jsonl line) vs what
// really happened 15 min later (`wake_outcome` records in stalls.jsonl). Shadow only. Jev "wakes" = pick wake_cheap |
// wake_opus; the rule default is compared on the same events (those that carry a `jev` block, so a rule default).
//   agreement  = share of labelled annotated events where "wake" == "needed"
//   misses     = said no wake, but it was needed; falseAlarms = said wake, but it was not needed (both counted by kind)
// ---------------------------------------------------------------------------
const wakes = (pick) => pick === 'wake_cheap' || pick === 'wake_opus';
const rate = (a, n) => (n ? Math.round((a / n) * 1000) / 1000 : null);
function judgeBlock(rows, say) {   // rows: [{ kind, needed }] ; say(row) -> bool (the thing being judged says "wake")
  const o = { n: rows.length, wake: 0, noWake: 0, agree: 0, agreement: null, misses: { count: 0, byKind: {} }, falseAlarms: { count: 0, byKind: {} } };
  for (const r of rows) {
    const w = say(r);
    if (w) o.wake++; else o.noWake++;
    if (w === r.needed) o.agree++;
    else {
      const b = w ? o.falseAlarms : o.misses;
      b.count++; b.byKind[r.kind] = (b.byKind[r.kind] || 0) + 1;
    }
  }
  o.agreement = rate(o.agree, o.n);
  return o;
}
export function wakeShadowSection({ eventRecs = [], stallRecs = [], from, to } = {}) {
  const labels = new Map();   // event_key -> 'needed' | 'not_needed' (newest wins)
  for (const r of stallRecs || []) if (r && r.type === 'wake_outcome' && r.event_key) labels.set(r.event_key, r.label);
  const out = { events: 0, annotated: 0, skipped: 0, errors: 0, unannotated: 0, jevSays: { wake: 0, noWake: 0 }, observed: { needed: 0, notNeeded: 0, pending: 0 }, jev: null, rule: null };
  const rows = [];
  for (const e of eventRecs || []) {
    if (!e || !e.at) continue;
    const t = Date.parse(e.at) || 0;
    if ((from != null && t < from) || (to != null && t >= to)) continue;
    out.events++;
    const j = e.jev;
    if (!j) out.unannotated++;
    else if (j.skipped) out.skipped++;
    else if (j.error) out.errors++;
    else if (j.pick) { out.annotated++; if (wakes(j.pick)) out.jevSays.wake++; else out.jevSays.noWake++; }
    const label = labels.get(`${e.at}|${e.key}`);
    if (label === 'needed') out.observed.needed++; else if (label === 'not_needed') out.observed.notNeeded++; else out.observed.pending++;
    if (label && j && j.ruleDefault) rows.push({ kind: e.kind, needed: label === 'needed', jev: j.pick || null, rule: j.ruleDefault });
  }
  out.jev = judgeBlock(rows.filter((r) => r.jev), (r) => wakes(r.jev));
  out.rule = judgeBlock(rows.filter((r) => r.jev), (r) => wakes(r.rule));   // same events as Jev, for comparison
  return out;
}

// Build one scorecard per UTC day in the window [now-days*DAY_MS, now], oldest first.
export function scorecardDays({ ledgerRows = [], stallRecs = [], eventRecs = [], runs = [], config = {}, days = 7, now = Date.now(), deployList = null, claudeRateLimits = null, actionRecs = [], regretRecs = [] } = {}) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const to = Math.floor((now - i * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS * (i === 0 ? 1 : 1);   // end of that UTC day
    // simpler: align from/to to UTC day boundaries
    const day = Math.floor((now - i * DAY_MS) / DAY_MS);
    const from = day * DAY_MS;
    const end = from + DAY_MS;
    out.push(buildScorecard({ ledgerRows, stallRecs, eventRecs, runs, config, from, to: end, deployList, claudeRateLimits, now, actionRecs, regretRecs }));
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

// Reads claude-rate-limits.json (written by scripts/claude-statusline-ratelimits.sh) and returns the seven_day
// window fields the scorecard needs for the weekly share. null when the file is missing or has no window.
async function readClaudeRateLimits(dir, fsLib = fs) {
  try {
    const j = JSON.parse(await fsLib.readFile(join(dir, 'claude-rate-limits.json'), 'utf8'));
    const rl = j.rate_limits || j;
    const w = rl.seven_day;
    if (!w || !Number.isFinite(w.used_percentage)) return null;
    return { used_percentage: w.used_percentage, resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null };
  } catch { return null; }
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
export async function loadScorecard({ from, to, env = process.env, fsLib = fs, deployList = null } = {}) {
  const dir = stateDir(env);
  const [ledgerRows, stallRecs, runsLines, eventsNow, eventsOld, claudeRateLimits, actionRecs, regretRecs] = await Promise.all([
    readJsonl(join(dir, 'usage-ledger.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'stalls.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-runs.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-events.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-events.jsonl.1'), { silent: true }).catch(() => []),
    readClaudeRateLimits(dir, fsLib),
    readJsonl(join(dir, 'manager-actions.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-regret.jsonl'), { silent: true }).catch(() => []),
  ]);
  const eventRecs = [...eventsOld, ...eventsNow];
  const runs = foldRuns(runsLines);
  const config = await readConfig(env, fsLib);
  return buildScorecard({ ledgerRows, stallRecs, eventRecs, runs, config, from, to, deployList, claudeRateLimits, actionRecs, regretRecs });
}

// days=1..30. Returns { today, days: [oldest..today] } for the UI.
export async function loadScorecardDays({ days = 7, env = process.env, fsLib = fs, deployList = null } = {}) {
  const dir = stateDir(env);
  const [ledgerRows, stallRecs, runsLines, eventsNow, eventsOld, claudeRateLimits, actionRecs, regretRecs] = await Promise.all([
    readJsonl(join(dir, 'usage-ledger.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'stalls.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-runs.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-events.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-events.jsonl.1'), { silent: true }).catch(() => []),
    readClaudeRateLimits(dir, fsLib),
    readJsonl(join(dir, 'manager-actions.jsonl'), { silent: true }).catch(() => []),
    readJsonl(join(dir, 'manager-regret.jsonl'), { silent: true }).catch(() => []),
  ]);
  const eventRecs = [...eventsOld, ...eventsNow];
  const runs = foldRuns(runsLines);
  const config = await readConfig(env, fsLib);
  const all = scorecardDays({ ledgerRows, stallRecs, eventRecs, runs, config, days, now: Date.now(), deployList, claudeRateLimits, actionRecs, regretRecs });
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
export async function cachedScorecard({ days = 7, ttlMs = 60000, env = process.env, deployList = null } = {}) {
  const key = `${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loadScorecardDays({ days, env, deployList: typeof deployList === 'function' ? deployList() : deployList });
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
  score('manager.claude_weekly_pct', scorecard.claude_weekly_pct);
  score('manager.claude_today_pct', scorecard.claude_today_pct);
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