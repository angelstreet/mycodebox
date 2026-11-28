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

// Quota-row chips for the API spend per Anthropic org this month (api-credit.js): "<org> $12/$200", one per org that has a
// reading; an org with no admin key (or never read) is left out, the quota popup says how to add the key.
const usd = (x) => `$${Number(x).toFixed(Number(x) >= 100 || Number.isInteger(Number(x)) ? 0 : 2)}`;
const orgName = (label) => String(label).replace(/\s+(API\s+)?(org|organi[sz]ation|account)$/i, '').trim() || String(label);
export function apiCreditChips(c) {
  if (!c?.ok || !Array.isArray(c.orgs)) return '';
  return c.orgs.filter((o) => o.spentUsd != null).map((o) => {
    const name = orgName(o.label || o.org);
    const pct = o.usedPercent ?? 0;
    const tip = `${o.label}: API spend this month ${usd(o.spentUsd)}${o.budgetUsd ? ` of ${usd(o.budgetUsd)} (${usd(o.leftUsd ?? 0)} left)` : ''}${o.stale ? `, not live: ${o.error || 'last pull failed'}` : ''}${o.note ? ` — ${o.note}` : ''}`;
    return `<span class="qi ${o.budgetUsd ? level(pct) : 'ok'}${o.stale ? ' old' : ''}" title="${esc(tip)}">${esc(name)} ${usd(o.spentUsd)}${o.budgetUsd ? `/${usd(o.budgetUsd)}` : ''}</span>`;
  }).join('<i class="sep">&middot;</i>');
}
