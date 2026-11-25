// Manager cost section of the daily report: what the manager's wakes cost in the last 24 h against the 7 days before.
// Pure functions over the wakes of manager-wakes.js (each carries usd, ctxMax, nothing); no I/O, no AI calls.
//
// Why these four numbers: a wake re-reads the whole conversation, so cost = wakes x context. Cache reads were 89 % of the
// manager's cost the week this was written (2026-11-25), cache misses under 1 %. Quality is NOT measured here.

const DAY_MS = 86400000;

// A finding needs enough wakes to mean something; ratios compare the last 24 h with the daily average of the 7 days before.
export const COST_DEFAULTS = { p90CtxMax: 400000, idleShareMax: 0.7, costPerWakeRatio: 1.5, wakesRatio: 2, minWakes: 20 };

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// { wakes, usd, usdPerWake, ctxMedian, ctxP90, idle, idleShare }. Context is each wake's largest model call; a wake with no
// model call (or logged before ctxMax existed) has no context and is left out of the percentiles, never counted as 0.
export function costStats(wakes) {
  const n = wakes.length;
  const usd = wakes.reduce((s, w) => s + (w.usd || 0), 0);
  const ctx = wakes.map((w) => w.ctxMax).filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  const idle = wakes.filter((w) => w.nothing).length;
  return {
    wakes: n, usd: Math.round(usd * 1000) / 1000, usdPerWake: n ? Math.round((usd / n) * 1000) / 1000 : null,
    ctxMedian: percentile(ctx, 0.5), ctxP90: percentile(ctx, 0.9), idle, idleShare: n ? Math.round((idle / n) * 1000) / 1000 : null,
  };
}

// today = the last 24 h, week = the 7 days before it. `days` = how many of those 7 days the log really covers (a young
// log must not dilute the daily average), at least 1.
export function costWindows(wakes, now) {
  const at = (w) => Date.parse(w.start);
  const today = wakes.filter((w) => at(w) > now - DAY_MS && at(w) <= now);
  const before = wakes.filter((w) => at(w) > now - 8 * DAY_MS && at(w) <= now - DAY_MS);
  const first = before.length ? Math.min(...before.map(at)) : null;
  const days = first === null ? 0 : Math.max(1, Math.min(7, Math.ceil((now - DAY_MS - first) / DAY_MS)));
  const week = costStats(before);
  return { today: costStats(today), week: { ...week, days, wakesPerDay: days ? Math.round((week.wakes / days) * 10) / 10 : null } };
}

const k = (n) => (n == null ? 'n/a' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const usd = (n) => (n == null ? 'n/a' : `$${n.toFixed(2)}`);
const pct = (n) => (n == null ? 'n/a' : `${Math.round(n * 100)} %`);

// Which thresholds the last 24 h crossed: [{ what, text }]. Nothing below minWakes; ratios need a baseline of minWakes too.
export function costCrossed({ today, week }, thresholds = {}) {
  const t = { ...COST_DEFAULTS, ...thresholds };
  const out = [];
  if (today.wakes < t.minWakes) return out;
  if (today.ctxP90 != null && today.ctxP90 > t.p90CtxMax) out.push({ what: 'context', text: `p90 context ${k(today.ctxP90)} is over ${k(t.p90CtxMax)}` });
  if (today.idleShare != null && today.idleShare > t.idleShareMax) out.push({ what: 'idle', text: `idle share ${pct(today.idleShare)} is over ${pct(t.idleShareMax)}` });
  if (week.wakes >= t.minWakes) {
    if (week.usdPerWake > 0 && today.usdPerWake > week.usdPerWake * t.costPerWakeRatio) out.push({ what: 'cost-per-wake', text: `cost per wake ${usd(today.usdPerWake)} is over ${t.costPerWakeRatio}x the 7-day average ${usd(week.usdPerWake)}` });
    if (week.wakesPerDay > 0 && today.wakes > week.wakesPerDay * t.wakesRatio) out.push({ what: 'wakes', text: `${today.wakes} wakes is over ${t.wakesRatio}x the 7-day average ${week.wakesPerDay} a day` });
  }
  return out;
}

// One finding for the whole section (one wake of the manager, not four), or null. Shape of a daily-checks finding.
export function costFinding(windows, thresholds = {}) {
  const crossed = costCrossed(windows, thresholds);
  if (!crossed.length) return null;
  return {
    key: 'manager-cost', priority: 'default', title: `Manager cost: ${crossed.map((c) => c.what).join(', ')} past the threshold`,
    body: `Last 24 h: ${crossed.map((c) => c.text).join('; ')}. Short context and fewer wakes that do nothing are the two levers.`,
  };
}

// The report section (markdown lines).
export function costLines(windows, thresholds = {}) {
  const { today, week } = windows;
  const t = { ...COST_DEFAULTS, ...thresholds };
  const L = ['## Manager cost (last 24 h against the 7 days before)', ''];
  if (!today.wakes && !week.wakes) return L.concat('No manager wake found (no usage ledger or no manager transcript): nothing measured.', '');
  const crossed = costCrossed(windows, thresholds);
  L.push(
    '| | last 24 h | 7-day average | finding past |', '|---|---|---|---|',
    `| wakes | ${today.wakes} | ${week.wakesPerDay ?? 'n/a'} a day | ${t.wakesRatio}x the average |`,
    `| cost per wake (API-equivalent) | ${usd(today.usdPerWake)} | ${usd(week.usdPerWake)} | ${t.costPerWakeRatio}x the average |`,
    `| context, median | ${k(today.ctxMedian)} | ${k(week.ctxMedian)} | |`,
    `| context, p90 | ${k(today.ctxP90)} | ${k(week.ctxP90)} | ${k(t.p90CtxMax)} |`,
    `| idle share | ${pct(today.idleShare)} (${today.idle} wakes) | ${pct(week.idleShare)} | ${pct(t.idleShareMax)} |`, '',
    crossed.length ? `Finding: ${crossed.map((c) => c.text).join('; ')}.` : today.wakes < t.minWakes ? `No finding: fewer than ${t.minWakes} wakes in the last 24 h, too few to judge.` : 'No finding: every number is under its threshold.', '',
    'Context is the largest model call of a wake. Idle = the wake sent no alert, no message to a session, started no worker and wrote no file; a wake that only answers the owner in text also counts, so idle overstates waste.',
    'These numbers are cost, not quality. Quality becomes real only when the owner taps "wrong" on a bad manager action in the manager panel (the regret figure in Decision share above).', '',
  );
  return L;
}
