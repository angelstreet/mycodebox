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
