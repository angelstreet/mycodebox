// Quota-row chip for the Claude extra-usage budget (anthropic-spend.js).
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
  return out.join('<i class="sep">&middot;</i>');
}
