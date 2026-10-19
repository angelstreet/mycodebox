#!/usr/bin/env node
// Read-only cross-source scoring ledger (OWNER_DECISIONS §8; docs/v2/SCORING.md "Round 14"). It joins the integration
// lane, manager worker runs and game-dispatch into one normalized record per task/attempt and prints, per model and
// per runtime: attempts, verified completions, verified rate, cost per verified completion, median/p90 latency, rework.
// It only reads files: it never writes, never edits a config or prompt. A missing source is skipped, not an error.
// (scripts/v2-score.js scores the V2 task store; this one scores what actually ran on the box.)
//
//   node scripts/v2-ledger.js [--json] [--records] [--since ISO|date] [--by model|runtime|source|prompt_version] [--state-dir DIR]
//
// Unknown stays unknown: no price is null (never $0), an unattributable model is "unknown".
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { attribute } from '../usage-window.js';

const DAY = 864e5, WINDOW_CAP = DAY, STALE = 6 * 3600e3;

// Tolerant JSONL read: a torn or corrupt line is dropped, a missing file is null (= skipped).
export function readJsonl(path) {
  if (!existsSync(path)) return null;
  const out = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn tail */ } }
  return out;
}
const ms = (t) => (typeof t === 'number' ? t : t ? Date.parse(t) : NaN);
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

// usage-ledger rows indexed by session label and by cwd, sorted by ts; used to attribute model/cost/tokens to a window.
function indexUsage(rows) {
  const byLabel = new Map(), byCwd = new Map();
  for (const r of rows || []) {
    if (!Number.isFinite(r.ts)) continue;
    for (const [m, k] of [[byLabel, r.label], [byCwd, r.cwd]]) if (k) (m.get(k) || m.set(k, []).get(k)).push(r);
  }
  return { byLabel, byCwd };
}
// Recorded usage (written at request / run end, Round 14b) wins; otherwise the time-window join over the usage ledger, marked
// approximate. -> { a: attribution|null, how: 'recorded'|'time-window'|'none' }
function pick(recorded, windowFn) {
  if (recorded && typeof recorded === 'object') return { a: { agent: recorded.runtime ?? null, model: recorded.model ?? null, tokens: recorded.tokens ?? null, tokensIn: recorded.tokensIn ?? null, tokensOut: recorded.tokensOut ?? null, costUsd: recorded.costUsd ?? null, plan: recorded.plan ?? null, attribution: recorded.attribution ?? null }, how: 'recorded' };
  const a = windowFn();
  return { a, how: a ? 'time-window' : 'none' };
}
const usageFields = (a, how) => ({ costUsd: a?.costUsd ?? null, plan: a?.plan ?? null, tokens: a?.tokens ?? null, tokensIn: a?.tokensIn ?? null, tokensOut: a?.tokensOut ?? null, attribution: a?.attribution && how === 'recorded' ? a.attribution : how, approximate: how === 'time-window' });

// Integration lane: one record per request id (last snapshot wins). Verified = merged/deployed AND pushed AND the final
// test step green AND not alreadyMerged (the lane did not test those). returned/failed = unverified; queued/running = open.
function laneRecords(rows, usage, hist) {
  const last = new Map();
  for (const r of rows) if (r.id) last.set(r.id, r);   // file order = time order, last snapshot wins
  const reqs = [...last.values()].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const prev = new Map(), fails = new Map(), out = [];
  for (const r of reqs) {
    const created = ms(r.createdAt), key = `${r.repo}/${r.branch}`;
    const from = Math.max(prev.get(r.session) ?? -Infinity, created - WINDOW_CAP);
    prev.set(r.session, created);
    if (r.state === 'queued' || r.state === 'running') continue;   // open: not an attempt yet
    const tests = (r.steps || []).filter((s) => s.name === 'test');
    const testOk = tests.length > 0 && tests[tests.length - 1].ok === true;
    const done = r.state === 'merged' || r.state === 'deployed';
    const reviewFail = r.review?.pass === false;   // the lane's merge evaluation (floor, Jev or manager rating) said no
    const verified = done && r.pushed === true && testOk && !r.alreadyMerged && !reviewFail;
    const { a, how } = pick(r.usage, () => attribute(usage.byLabel.get(r.session), from, created));
    let model = a?.model, runtime = a?.agent;
    if (!model) { const h = (hist.get(r.session) || []).filter((x) => x.ts <= created).pop(); model = h?.model; runtime = h?.provider; }
    const prior = fails.get(key) || 0;
    if (!done) fails.set(key, prior + 1);
    out.push({
      source: 'lane', id: r.id, model: model || 'unknown', runtime: runtime || 'unknown', kind: 'merge-request', ref: key,
      started: iso(created), ended: iso(ms(r.endedAt)), latencyMs: ms(r.endedAt) - created,
      outcome: r.state, verified, evidence: verified ? `lane tests green + pushed${r.review?.pass ? ` + review pass (${r.review.source || 'floor'})` : ''}` : done ? (r.alreadyMerged ? 'already merged, lane did not test' : 'no green test step or not pushed') : (r.reason || r.state),
      ...usageFields(a, how), review: r.review ? (r.review.pass ? 'pass' : 'fail') : null, rework: prior, reworkEvent: !done,
    });
  }
  return out;
}

// Manager worker runs (manager-runs.jsonl: start line + end line per id). Verified = the manager ended the run with
// accepted or fixed; rejected = unverified; no verdict = unverified (still open or never closed). fixed counts as rework.
function managerRecords(rows, usage) {
  const runs = new Map();
  for (const r of rows) if (r.id) runs.set(r.id, { ...(runs.get(r.id) || {}), ...r });
  const out = [], now = Date.now();
  for (const r of runs.values()) {
    if (!Number.isFinite(r.startedAt)) continue;
    const ended = Number.isFinite(r.endedAt) ? r.endedAt : NaN;
    if (!Number.isFinite(ended) && now - r.startedAt < STALE) continue;   // still running
    const { a, how } = pick(r.usage, () => attribute(usage.byCwd.get(r.worktree), r.startedAt, Number.isFinite(ended) ? ended : r.startedAt + STALE));
    // A reviewer pass is evidence by itself when the manager gave no verdict; a reviewer fail blocks verification.
    const verified = r.review !== 'fail' && (r.verdict === 'accepted' || r.verdict === 'fixed' || (!r.verdict && r.review === 'pass'));
    out.push({
      source: 'manager', id: r.id, model: a?.model || 'unknown', runtime: r.kind === 'minimax' ? 'minimax' : (a?.agent || r.runtime || r.kind || 'unknown'), kind: r.kind || 'unknown',
      ref: r.worktree ? r.worktree.split('/').pop() : null, started: iso(r.startedAt), ended: iso(ended), latencyMs: ended - r.startedAt,
      outcome: r.verdict || 'no-verdict', verified, evidence: verified ? (r.verdict ? `manager verdict ${r.verdict}` : 'reviewer pass') + (r.verdict && r.review === 'pass' ? ' + reviewer pass' : '') : r.review === 'fail' ? 'reviewer fail' : r.verdict ? `manager verdict ${r.verdict}` : 'no manager verdict',
      ...usageFields(a, how), review: r.review || null, rework: r.verdict === 'fixed' ? 1 : 0, reworkEvent: r.verdict === 'fixed' || r.verdict === 'rejected',
    });
  }
  return out;
}

// game-dispatch runs (epoch seconds). Verified = completed with a recorded script result id (the evidence). A second run of
// the same job after a non-completed one is rework. A "started" run older than 6 h is abandoned; a younger one is open.
function gameRecords(rows) {
  const out = [], fails = new Map(), now = Date.now();
  for (const r of rows.slice().sort((a, b) => (a.started || 0) - (b.started || 0))) {
    const s = (r.started || NaN) * 1000, e = r.ended ? r.ended * 1000 : NaN, key = r.job || r.game || 'unknown';
    if (!Number.isFinite(s)) continue;
    if (r.status === 'started' && now - s < STALE) continue;
    const done = r.status === 'completed', verified = done && !!r.script_result_id;
    const prior = fails.get(key) || 0;
    if (!done) fails.set(key, prior + 1);
    out.push({
      source: 'game-dispatch', id: r.task_id || `${key}@${r.started}`, model: r.model && r.model !== 'none' ? r.model : 'none', runtime: 'game-dispatch', kind: r.game || 'game',
      ref: key, started: iso(s), ended: iso(e), latencyMs: e - s, outcome: r.status === 'started' ? 'abandoned' : r.status || 'unknown', verified,
      evidence: verified ? 'completed with script result' : done ? 'completed without script result' : (r.error ? 'error recorded' : r.status || 'no status'),
      costUsd: null, plan: null, tokens: null, tokensIn: null, tokensOut: null, attribution: 'none', approximate: false, promptVersion: r.prompt_version && r.prompt_version !== '-' ? r.prompt_version : null,
      review: null, rework: prior, reworkEvent: !done,
    });
  }
  return out;
}

const pct = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

const FIELD = { model: 'model', runtime: 'runtime', source: 'source', prompt_version: 'promptVersion' };

// Flat-plan attempts (plan 'flat') have no per-token price: they stay out of cost and $/verified, and show tokens per verified.
export function summarize(records, by) {
  const g = new Map(), f = FIELD[by] || by;
  for (const r of records) { const k = r[f] ?? 'none'; (g.get(k) || g.set(k, []).get(k)).push(r); }
  return [...g.entries()].map(([k, rs]) => {
    const v = rs.filter((r) => r.verified), priced = rs.filter((r) => r.costUsd != null), lat = v.map((r) => r.latencyMs).filter(Number.isFinite);
    const flatN = rs.filter((r) => r.plan === 'flat').length, vMetered = v.filter((r) => r.plan !== 'flat').length;
    const cost = priced.reduce((s, r) => s + r.costUsd, 0), toks = rs.filter((r) => r.tokens != null);
    return {
      [by]: k, attempts: rs.length, verified: v.length, verifiedRate: rs.length ? v.length / rs.length : null,
      pricedAttempts: priced.length, flatPlanAttempts: flatN, costUsd: priced.length ? cost : null,
      costPerVerified: priced.length && vMetered ? cost / vMetered : null,
      tokens: toks.length ? toks.reduce((s, r) => s + r.tokens, 0) : null,
      tokensPerVerified: toks.length && v.length ? toks.reduce((s, r) => s + r.tokens, 0) / v.length : null,
      approximate: rs.filter((r) => r.approximate).length,
      medianMs: pct(lat, 0.5), p90Ms: pct(lat, 0.9), rework: rs.filter((r) => r.reworkEvent).length,
    };
  }).sort((a, b) => b.attempts - a.attempts);
}

export function buildLedger({ stateDir, home = homedir(), since = -Infinity } = {}) {
  const src = {
    lane: join(stateDir, 'integration', 'requests.jsonl'), manager: join(stateDir, 'manager-runs.jsonl'),
    'game-dispatch': join(home, '.cache', 'game-dispatch', 'runs.jsonl'),
  };
  const raw = Object.fromEntries(Object.entries(src).map(([k, p]) => [k, readJsonl(p)]));
  const usage = indexUsage(readJsonl(join(stateDir, 'usage-ledger.jsonl')));
  const hist = new Map();
  for (const h of readJsonl(join(stateDir, 'session-history.jsonl')) || []) if (h.kind === 'session.started') (hist.get(h.name) || hist.set(h.name, []).get(h.name)).push(h);
  const records = [], skipped = [];
  const fns = { lane: (r) => laneRecords(r, usage, hist), manager: (r) => managerRecords(r, usage), 'game-dispatch': gameRecords };
  for (const [k, rows] of Object.entries(raw)) { if (rows === null) skipped.push({ source: k, reason: 'file not found' }); else records.push(...fns[k](rows)); }
  if (!usage.byLabel.size && !usage.byCwd.size) skipped.push({ source: 'usage-ledger', reason: 'missing or empty: model and cost stay unknown' });
  return { records: records.filter((r) => Date.parse(r.started) >= since), skipped };
}

const fmtMs = (v) => (v == null ? '-' : v < 6e4 ? `${(v / 1e3).toFixed(1)}s` : v < 36e5 ? `${(v / 6e4).toFixed(1)}m` : `${(v / 36e5).toFixed(1)}h`);
const fmtUsd = (v, r) => (v != null ? `$${v.toFixed(2)}` : r.flatPlanAttempts && !r.pricedAttempts ? 'in plan' : 'n/a');
const fmtTok = (v) => (v == null ? '-' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(Math.round(v)));
function table(rows, by) {
  const head = [by, 'attempts', 'verified', 'rate', '$/verified', 'tok/verified', 'approx', 'median', 'p90', 'rework'];
  const body = rows.map((r) => [r[by], r.attempts, r.verified, r.verifiedRate == null ? '-' : `${(r.verifiedRate * 100).toFixed(0)}%`, fmtUsd(r.costPerVerified, r), fmtTok(r.tokensPerVerified), r.approximate, fmtMs(r.medianMs), fmtMs(r.p90Ms), r.rework].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  return [head, ...body].map((l) => l.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ')).join('\n');
}

function main(argv) {
  const o = { json: false, records: false, by: null, since: -Infinity, stateDir: process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--json') o.json = true; else if (a === '--records') o.records = true;
    else if (a === '--by') { o.by = next(); if (!['model', 'runtime', 'source', 'prompt_version'].includes(o.by)) throw new Error('--by must be model|runtime|source|prompt_version'); }
    else if (a === '--since') { o.since = Date.parse(next()); if (!Number.isFinite(o.since)) throw new Error('--since needs a date'); }
    else if (a === '--state-dir') o.stateDir = next();
    else throw new Error(`unknown option ${a}`);
  }
  const { records, skipped } = buildLedger({ stateDir: o.stateDir, since: o.since });
  const bys = o.by ? [o.by] : ['model', 'runtime'];
  const groups = Object.fromEntries(bys.map((b) => [b, summarize(records, b)]));
  if (o.json) { console.log(JSON.stringify({ generatedAt: new Date().toISOString(), records: records.length, skipped, groups, ...(o.records ? { ledger: records } : {}) }, null, 1)); return; }
  console.log(`ledger: ${records.length} attempts, ${records.filter((r) => r.verified).length} verified`);
  for (const s of skipped) console.log(`skipped: ${s.source} (${s.reason})`);
  for (const b of bys) console.log(`\nper ${b}\n${table(groups[b], b)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); } }
