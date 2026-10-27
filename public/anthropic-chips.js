// Quota-row chips for the Anthropic money (anthropic-spend.js): the Claude extra-usage budget and the team's Console credit.
const sym = { USD: '$', EUR: '€', GBP: '£' };
const money = (x, cur) => `${sym[cur] || ''}${Math.max(0, x).toFixed(0)}${sym[cur] ? '' : ` ${cur}`}`;
const level = (usedPct) => (usedPct >= 95 ? 'crit' : usedPct >= 80 ? 'warn' : 'ok');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// '' without a reading
export function anthropicChips(a) {
  if (!a || !a.ok) return '';
  const out = [];
  const x = a.extra;
  if (x && x.limit != null) {
    const pct = x.limit > 0 ? (x.used / x.limit) * 100 : 0;
    out.push(`<span class="qi ${level(pct)}${x.stale ? ' old' : ''}" title="${esc(`Claude extra usage this month: ${money(x.used, x.currency)} used of ${money(x.limit, x.currency)}${x.stale ? ` (stale: ${x.stale})` : ''}`)}">extra ${money(x.left, x.currency)} left</span>`);
  }
  const t = a.team;
  if (t && t.credit != null) {
    const pct = t.credit > 0 ? (t.spent / t.credit) * 100 : 0;
    out.push(`<span class="qi ${level(pct)}${t.stale ? ' old' : ''}" title="${esc(`Team credit: ${money(t.spent, 'USD')} spent of ${money(t.credit, 'USD')} since ${String(t.since).slice(0, 10)}${t.stale ? ` (stale: ${t.stale})` : ''}`)}">team ${money(t.left, 'USD')} left</span>`);
  }
  return out.join('<i class="sep">&middot;</i>');
}
