#!/usr/bin/env node
// Hourly token-fix check (owner + manager 2026-11-28, after docs/token-audit-20261128.md): did the fixes cut the waste?
// Reads what already exists: /api/usage `waste` (finding counts, 48 h window, so it moves slowly) and the last hour of
// usage-ledger.jsonl (moves at once). Appends one JSON line to <state>/token-watch.jsonl and prints a short report.
// Detectors are NOT redone here: the hour metrics are plain sums over the same ledger rows the audit used.
//   node scripts/token-watch.js [--json] [--hours N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLedgerTail } from '../usage-window.js';
import { ctxOf } from '../usage/waste.js';

const H = 3600000;
// The audit's 48 h figures (2026-11-26 00:00 to 2026-11-28 00:14 UTC), as per-hour or share baselines.
export const AUDIT_BASELINE = {
  wasteFindings: 18, claudeCostPerHour: 1423 / 48, fableCostShare: 0.32, over300kCostShare: 0.135,
  pollCallShare: 0.108, subagentCtxShare: 0.306, minimaxPollShare: 0.33,
};

const r3 = (x) => Math.round(x * 1000) / 1000;
const isPoll = (r) => (r.usage?.output || 0) < 150 && ctxOf(r) > 100e3;

// Metrics of the ledger rows with from < ts <= to.
export function hourMetrics(rows, from, to) {
  const inWin = rows.filter((r) => r.ts > from && r.ts <= to && r.agent !== 'manager');
  const cl = inWin.filter((r) => r.agent === 'claude'), mm = inWin.filter((r) => r.agent === 'minimax');
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  const cost = (r) => r.cost?.total || 0;
  const ctx = sum(cl, ctxOf), c = sum(cl, cost);
  const fable = cl.filter((r) => /fable/i.test(r.model || ''));
  const big = cl.filter((r) => ctxOf(r) > 300e3);
  const polls = cl.filter(isPoll);
  const read = sum(cl, (r) => r.usage?.cache_read || 0);
  const sessions = new Map();
  for (const r of cl) {
    const k = r.label || String(r.session || '').slice(0, 8);
    const s = sessions.get(k) || { session: k, calls: 0, cost: 0, ctx: 0, fable: 0, polls: 0, sub: 0 };
    s.calls++; s.cost += cost(r); s.ctx += ctxOf(r); if (/fable/i.test(r.model || '')) s.fable++; if (isPoll(r)) s.polls++; if (r.subagent) s.sub++;
    sessions.set(k, s);
  }
  const top = [...sessions.values()].sort((a, b) => b.cost - a.cost).slice(0, 5)
    .map((s) => ({ ...s, cost: r3(s.cost), avgCtx: Math.round(s.ctx / s.calls), ctx: undefined }));
  const mmSessions = new Map();
  for (const r of mm) { const k = r.label || String(r.session || '').slice(0, 8); const s = mmSessions.get(k) || { session: k, calls: 0, polls: 0 }; s.calls++; if (isPoll(r)) s.polls++; mmSessions.set(k, s); }
  return {
    from, to,
    claude: {
      calls: cl.length, cost: r3(c), avgCtx: cl.length ? Math.round(ctx / cl.length) : 0,
      cacheHit: ctx ? r3(read / ctx) : null,
      fableCalls: fable.length, fableCostShare: c ? r3(sum(fable, cost) / c) : 0,
      over300kCalls: big.length, over300kCallCostShare: c ? r3(sum(big, cost) / c) : 0,
      // the audit's measure: the cost of the context ABOVE 300k in each call (13.5% in the audit)
      over300kCostShare: c ? r3(sum(big, (r) => cost(r) * (ctxOf(r) - 300e3) / ctxOf(r)) / c) : 0,
      pollCalls: polls.length, pollCallShare: cl.length ? r3(polls.length / cl.length) : 0,
      subagentCtxShare: ctx ? r3(sum(cl.filter((r) => r.subagent), ctxOf) / ctx) : 0,
      subagentModels: Object.fromEntries(Object.entries(cl.filter((r) => r.subagent).reduce((m, r) => { m[r.model] = (m[r.model] || 0) + 1; return m; }, {}))),
      cacheWrite1h: sum(cl, (r) => r.usage?.cache_write_1h || 0), cacheWrite5m: sum(cl, (r) => r.usage?.cache_write_5m || 0),
      top,
    },
    minimax: { calls: mm.length, pollCalls: mm.filter(isPoll).length, pollShare: mm.length ? r3(mm.filter(isPoll).length / mm.length) : 0,
      top: [...mmSessions.values()].sort((a, b) => b.calls - a.calls).slice(0, 3) },
  };
}

const pct = (x) => (x == null ? '-' : `${Math.round(x * 1000) / 10}%`);
const arrow = (now, base, lowerIsBetter = true) => (now == null ? '' : (lowerIsBetter ? now < base : now > base) ? ' (better)' : now > base * 1.05 ? ' (worse)' : ' (same)');

export function report(entry, prev) {
  const b = AUDIT_BASELINE, h = entry.hour.claude, m = entry.hour.minimax, w = entry.waste;
  const delta = prev?.waste ? ` (last check ${prev.waste.total}, ${w.total - prev.waste.total >= 0 ? '+' : ''}${w.total - prev.waste.total})` : '';
  return [
    `Token watch ${new Date(entry.at).toISOString().slice(0, 16)}Z`,
    `waste findings (48 h window): ${w.total}${delta}, audit ${b.wasteFindings}${arrow(w.total, b.wasteFindings)}: ${Object.entries(w.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `last hour Claude: ${h.calls} calls, $${h.cost} (audit avg $${b.claudeCostPerHour.toFixed(1)}/h), avg ctx ${Math.round(h.avgCtx / 1000)}k, cache hit ${pct(h.cacheHit)}`,
    `  Fable ${h.fableCalls} calls, ${pct(h.fableCostShare)} of cost (audit ${pct(b.fableCostShare)})${arrow(h.fableCostShare, b.fableCostShare)}`,
    `  >300k ctx ${h.over300kCalls} calls (${pct(h.over300kCallCostShare)} of cost); context above 300k ${pct(h.over300kCostShare)} of cost (audit ${pct(b.over300kCostShare)})${arrow(h.over300kCostShare, b.over300kCostShare)}`,
    `  poll-size calls ${h.pollCalls}, ${pct(h.pollCallShare)} of calls (audit ${pct(b.pollCallShare)})${arrow(h.pollCallShare, b.pollCallShare)}`,
    `  subagent ctx ${pct(h.subagentCtxShare)} (audit ${pct(b.subagentCtxShare)})${arrow(h.subagentCtxShare, b.subagentCtxShare)}; subagent models ${JSON.stringify(h.subagentModels)}`,
    `  cache writes 1h ${Math.round(h.cacheWrite1h / 1000)}k / 5m ${Math.round(h.cacheWrite5m / 1000)}k`,
    `  top: ${h.top.map((s) => `${s.session} $${s.cost} ${s.calls}c ${Math.round(s.avgCtx / 1000)}k${s.fable ? ` fable${s.fable}` : ''}${s.polls ? ` poll${s.polls}` : ''}`).join('; ')}`,
    `last hour MiniMax: ${m.calls} calls, polls ${pct(m.pollShare)} (audit ~${pct(b.minimaxPollShare)})${m.calls ? arrow(m.pollShare, b.minimaxPollShare) : ''}; ${m.top.map((s) => `${s.session} ${s.calls}c poll${s.polls}`).join('; ')}`,
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const hours = Number(args[args.indexOf('--hours') + 1]) || 1;
  const state = process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
  const base = process.env.GHOSTY_URL || `http://127.0.0.1:${process.env.GHOSTY_PORT || process.env.PORT || 7777}`;
  let waste = { total: null, counts: {}, error: null };
  try {
    const res = await fetch(`${base}/api/usage`, { signal: AbortSignal.timeout(60000) });
    const u = await res.json();
    const counts = u.waste?.counts || {};
    waste = { total: (u.waste?.findings || []).length, counts, sessions: (u.waste?.findings || []).map((f) => `${f.kind}:${f.session}`) };
  } catch (e) { waste.error = String(e.message || e); }
  const now = Date.now();
  const rows = readLedgerTail(path.join(state, 'usage-ledger.jsonl'), 40 * 1024 * 1024);
  const entry = { at: now, waste, hour: hourMetrics(rows, now - hours * H, now) };
  const log = path.join(state, 'token-watch.jsonl');
  let prev = null;
  try { const lines = fs.readFileSync(log, 'utf8').trim().split('\n'); prev = JSON.parse(lines.at(-1)); } catch { /* first run */ }
  fs.appendFileSync(log, JSON.stringify(entry) + '\n');
  process.stdout.write(args.includes('--json') ? JSON.stringify(entry, null, 1) + '\n' : report(entry, prev) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exit(1); });
