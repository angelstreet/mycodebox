// Usage view helpers (TASK-44 phase 3 UI). Pure: no I/O, shared by the server (status payload, /api/usage) and the UI.
// Input is usage-summary.json as written by usage/ingest.js. All costs are API-equivalent (list prices), not money
// spent; a total that was never priced (MiniMax) has cost null, never 0.

const DAY_MS = 86400000;
const num = (x) => (Number.isFinite(x) ? x : 0);

// "12.3M", "845k", "312"
export function fmtTok(n) {
  n = num(n);
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}
// "$3.20"; "$1.2k" from 1000; null / undefined -> "—" (unpriced is never shown as $0)
export function fmtUsd(c) {
  if (c == null || !Number.isFinite(c)) return '—';
  if (c >= 1000) return `$${(c / 1000).toFixed(1)}k`;
  if (c >= 100) return `$${Math.round(c)}`;
  return `$${c.toFixed(2)}`;
}
// A usage entry's cost, or null when it has turns but none of them could be priced (cost 0 with unpriced > 0).
export function costOrNull(e) {
  if (!e) return null;
  return e.cost === 0 && e.unpriced > 0 ? null : num(e.cost);
}
// True when only some of an entry's turns were priced (the cost is a lower bound).
export const isPartial = (e) => !!e && e.unpriced > 0 && !(e.cost === 0);

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Is the summary's "today" still today (the tailer rewrites it every minute; a dead tailer leaves it stale)?
export const summaryFresh = (summary, now) => !!summary && !!summary.generatedAt && dayOf(Date.parse(summary.generatedAt)) === dayOf(now);

// label (tmux session name) -> { todayCost, todayTokens, totalCost, outlier } | each over all traces with that label.
// outlier is the reason string or null. todayCost / totalCost are null when unpriced only.
export function usageByLabel(summary, now = Date.now()) {
  const out = new Map();
  if (!summary || !Array.isArray(summary.perSession)) return out;
  const fresh = summaryFresh(summary, now);
  const reasons = new Map((summary.outliers || []).map((o) => [o.id, o.reason || `${o.ratio}x the project median per hour`]));
  const agg = new Map();
  for (const s of summary.perSession) {
    const a = agg.get(s.session) || { today: { cost: 0, unpriced: 0, tokens: 0, turns: 0 }, total: { cost: 0, unpriced: 0 }, outlier: null };
    const t = fresh && s.today ? s.today : null;
    if (t) { a.today.cost += num(t.cost); a.today.unpriced += num(t.unpriced); a.today.tokens += num(t.total); a.today.turns += num(t.turns); }
    a.total.cost += num(s.cost); a.total.unpriced += num(s.unpriced);
    if (fresh && reasons.has(s.id)) a.outlier = reasons.get(s.id);
    agg.set(s.session, a);
  }
  for (const [k, a] of agg) {
    out.set(k, {
      todayCost: costOrNull({ cost: a.today.cost, unpriced: a.today.unpriced }),
      todayTokens: a.today.tokens,
      totalCost: costOrNull({ cost: a.total.cost, unpriced: a.total.unpriced }),
      outlier: a.outlier,
    });
  }
  return out;
}

// The last `days` UTC days of one tmux session label, oldest first: [{ day, cost, total }] (cost null when unpriced).
export function sessionDays(summary, label, days = 14, now = Date.now()) {
  const list = [];
  for (let i = days - 1; i >= 0; i--) list.push({ day: dayOf(now - i * DAY_MS), cost: 0, total: 0, unpriced: 0 });
  const ix = new Map(list.map((d) => [d.day, d]));
  for (const s of (summary && summary.perSession) || []) {
    if (s.session !== label) continue;
    for (const [d, v] of Object.entries(s.days || {})) {
      const e = ix.get(d);
      if (e) { e.cost += num(v.cost); e.total += num(v.total); e.unpriced += num(v.unpriced); }
    }
  }
  return list.map((d) => ({ day: d.day, cost: costOrNull(d), total: d.total }));
}

// Rows for the usage sheet. tab: 'today' | '14d'. Sorted: outliers first, then by cost (unpriced last, by tokens).
// -> [{ id, session, project, agent, models, cost, tokens, rate, outlier, in, out, cr, cw }]
export function sessionRows(summary, tab, now = Date.now()) {
  const fresh = summaryFresh(summary, now);
  const reasons = new Map((summary?.outliers || []).map((o) => [o.id, o.reason || '']));
  const rows = [];
  for (const s of summary?.perSession || []) {
    const e = tab === 'today' ? (fresh ? s.today : null) : s;
    if (!e) continue;
    const cost = costOrNull(e);
    const hours = tab === 'today' ? e.hours : s.activeHours;
    rows.push({
      id: s.id, session: s.session, project: s.project, agent: s.agent, models: s.models || [],
      cost, tokens: num(e.total), turns: num(e.turns),
      rate: cost != null && hours > 0 ? Math.round((cost / hours) * 100) / 100 : null,
      outlier: fresh && reasons.has(s.id) ? reasons.get(s.id) || 'outlier' : null,
      in: num(e.input), out: num(e.output), cr: num(e.cache_read), cw: num(e.cache_creation),
    });
  }
  rows.sort((a, b) => (!!b.outlier - !!a.outlier) || ((b.cost ?? -1) - (a.cost ?? -1)) || (b.tokens - a.tokens));
  return rows;
}

// Map of name -> entry as an array sorted by cost (unpriced last), top n. Used for per agent / project / model.
export function topEntries(map, n = Infinity) {
  return Object.entries(map || {})
    .map(([name, e]) => ({ name, ...e, cost: costOrNull(e) }))
    .sort((a, b) => ((b.cost ?? -1) - (a.cost ?? -1)) || (b.total - a.total))
    .slice(0, n);
}

// Last `days` days from perDay as bars, oldest first, with each day's share of the busiest day (0..1).
export function dayBars(summary, days = 14, now = Date.now()) {
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayOf(now - i * DAY_MS), e = summary?.perDay?.[d] || null;
    rows.push({ day: d, cost: e ? costOrNull(e) : 0, total: e ? num(e.total) : 0, turns: e ? num(e.turns) : 0 });
  }
  const max = Math.max(0, ...rows.map((r) => r.cost || 0));
  const maxTok = Math.max(0, ...rows.map((r) => r.total));
  return rows.map((r) => ({ ...r, frac: max > 0 ? (r.cost || 0) / max : maxTok > 0 ? r.total / maxTok : 0 }));
}

// ---------------------------------------------------------------------------
// Manager scorecard block (the "Manager" row at the top of the Usage overview).
// score = { score, components:{quality,coverage,efficiency}, cost:{session,subagents,workers,jev,reviewer,judge,total},
//          perf:{stops,resolved,resolvedFast,auto,escalated,medianTtrSec,p90TtrSec,agreement,judgeMean,tokensPerResolvedStop},
//          jev:{consulted:{count,share,ambiguousShare},errors,errorRate,p50ms,agreement,overridden,costPerDecision},
//          budget:{session,ai} }, days: [{ score, ... }]   (oldest first)
// helpers: { fmtTok, fmtUsd, costOrNull }  (passed in to avoid duplicating here)
export function managerBlockHtml(score, days, { fmtTok, fmtUsd, costOrNull } = {}) {
  if (!score) return '';
  const tok = fmtTok || ((n) => `${Math.round(n || 0)}`);
  const usd = (c) => c == null || !Number.isFinite(c) ? '—' : (fmtUsd ? fmtUsd(c) : `$${(c || 0).toFixed(2)}`);
  const pct = (p) => p == null ? '—' : `${Math.round(p * 100)}%`;
  const c = score.components || {};
  const bucket = (b) => b ? `<span class="ut">in ${tok(b.tokens?.input)} &middot; out ${tok(b.tokens?.output)} &middot; cr ${tok(b.tokens?.cache_read)} &middot; cw ${tok(b.tokens?.cache_write)}</span>` : '<span class="dim">—</span>';
  const bucketUsd = (b) => b ? `${usd(b.usd)}${b.usd != null ? '' : ''} · ${b.calls} calls` : '';
  const sessionLine = usd(score.cost.session.usd);
  const workersLine = `${tok((score.cost.workers.tokens.input || 0) + (score.cost.workers.tokens.output || 0) + (score.cost.workers.tokens.cache_read || 0) + (score.cost.workers.tokens.cache_write || 0))} worker tokens · ${score.cost.workers.calls} calls`;
  const jevLine = `${usd(score.cost.jev.usd)} Jev · ${usd(score.cost.reviewer.usd)} reviewer${Number.isFinite(score.cost.judge.calls) ? ` · ${usd(score.cost.judge.usd)} judge` : ''}`;
  const jev = score.jev || {};
  const consulted = jev.consulted || {};
  const perf = score.perf || {};
  const scoreN = score.score == null ? '—' : `${Math.round(score.score)}`;
  const miniBars = (Array.isArray(days) ? days : []).slice(-7).map((d, i, arr) => {
    const h = d && Number.isFinite(d.score) ? Math.max(2, Math.round((d.score / 100) * 22)) : 2;
    const isLast = i === arr.length - 1;
    return `<span class="msbar${isLast ? ' last' : ''}" style="height:${h}px" title="${d ? `${(d.day || (d.to || '').slice(0,10))}: ${d.score == null ? '—' : Math.round(d.score)}` : ''}"></span>`;
  }).join('');
  return `<div class="usec-wrap"><button class="usec" data-sec="manager"><i class="uch on"></i><span>Manager</span><span class="dim">today</span><span class="grow"></span><b class="tk">${scoreN}</b></button><div class="usec-body">
    <div class="mscore"><div class="mscore-num"><b>${scoreN}</b><span class="dim">/ 100</span></div><div class="mscore-comp"><div><span class="dim">quality</span><b>${pct(c.quality)}</b></div><div><span class="dim">coverage</span><b>${pct(c.coverage)}</b></div><div><span class="dim">efficiency</span><b>${pct(c.efficiency)}</b></div></div><div class="mscore-bars" aria-label="last 7 days">${miniBars || '<span class="dim">—</span>'}</div></div>
    <div class="urow"><div class="u1"><b>Session</b><span class="grow"></span><b class="tk">${sessionLine}</b></div>${bucket(score.cost.session)}</div>
    <div class="urow"><div class="u1"><b>Subagents</b><span class="grow"></span><b class="tk">${usd(score.cost.subagents.usd)}</b></div>${bucket(score.cost.subagents)}</div>
    <div class="urow"><div class="u1"><b>Workers (MiniMax)</b><span class="grow"></span><b class="tk">${workersLine}</b></div>${bucket(score.cost.workers)}</div>
    <div class="urow"><div class="u1"><b>Jev</b><span class="grow"></span><b class="tk">${usd(score.cost.jev.usd)}</b></div>${bucket(score.cost.jev)}</div>
    <div class="urow"><div class="u1"><b>Reviewer</b><span class="grow"></span><b class="tk">${usd(score.cost.reviewer.usd)}</b></div>${bucket(score.cost.reviewer)}</div>
    <div class="urow"><div class="u1"><b>Judge</b><span class="grow"></span><b class="tk">${usd(score.cost.judge.usd)}</b></div>${bucket(score.cost.judge)}</div>
    <div class="urow"><div class="u1"><b>Total today</b><span class="grow"></span><b class="tk">${usd(score.cost.total.usd)}</b></div>${bucket(score.cost.total)}</div>
    <div class="urow jev"><div class="u1"><b>Jev</b><span class="grow"></span><b class="tk">${pct(consulted.share)} consulted</b></div><div class="u2">consulted ${consulted.count || 0} of ${perf.stops || 0} stops${consulted.ambiguousShare != null ? ` · ${pct(consulted.ambiguousShare)} of ambiguous` : ''} · errors ${pct(jev.errorRate)} · agreement ${pct(jev.agreement)} · p50 ${jev.p50ms != null ? jev.p50ms + 'ms' : '—'}${Number.isFinite(jev.overridden) && jev.overridden ? ` · ${jev.overridden} overridden by forbidden` : ''}</div></div>
    <div class="urow"><div class="u1"><b>Performance</b><span class="grow"></span><b class="tk">${perf.stops || 0} stops</b></div><div class="u2">${perf.stops ? `${perf.resolved || 0} resolved (${pct(perf.resolvedFast != null && perf.stops ? perf.resolvedFast / perf.stops : null)} &le;5min) · ${perf.auto || 0} auto · ${perf.escalated || 0} escalated · median ${perf.medianTtrSec != null ? perf.medianTtrSec + 's' : '—'} · p90 ${perf.p90TtrSec != null ? perf.p90TtrSec + 's' : '—'}${perf.judgeMean != null ? ` · judge mean ${(perf.judgeMean).toFixed(2)}` : ''}${perf.agreement != null ? ` · agreement ${pct(perf.agreement)}` : ''}` : 'no stops today'}</div></div>
  </div></div>`;
}
