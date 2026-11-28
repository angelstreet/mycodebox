// Quota-row group for the monthly API spend of the Anthropic orgs (api-credit.js). One group, one value per org, in the owner's words
// (2026-11-28: "we take too much spaces ... Claude API 94/945 - 200/200 since 200 is max"): spent / prepaid credit left, whole dollars;
// once an org has reached its monthly limit (its API calls stop until the 1st) the value is spent / limit, red. Without a credit reading:
// spent / limit, or spent alone without a limit. Red also with no credit left, amber at 80 % of the limit. The org and the cents are in
// each value's title. An org never read shows "?"; the popup says how to add its key.
const level = (usedPct) => (usedPct >= 95 ? 'crit' : usedPct >= 80 ? 'warn' : 'ok');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const amount = (x) => (x == null ? '?' : String(Math.round(Number(x))));
const exact = (x) => `$${Number(x).toFixed(2)}`;
const KNOWN = ['max', 'team'];   // shown (with "?") even before their first reading

function value(o) {
  const credit = o.creditLeftUsd, pct = o.usedPercent ?? 0, capped = o.budgetUsd && pct >= 100;
  const lv = o.spentUsd == null ? 'na' : capped || (credit != null && credit <= 0) ? 'crit' : o.budgetUsd ? level(pct) : 'ok';
  const of = capped || credit == null ? o.budgetUsd : credit;
  const tip = `${o.label}: API spend this month ${o.spentUsd == null ? 'not read' : exact(o.spentUsd)}${o.spentUsd != null && o.budgetUsd ? ` of the ${exact(o.budgetUsd)} limit (${Math.round(pct)}%${capped ? ', API calls stopped until the 1st' : ''})` : ''}${credit != null ? `, credit left about ${exact(credit)}` : ''}${o.stale || o.error ? `, not live: ${o.error || 'last pull failed'}` : ''}${o.note ? ` — ${o.note}` : ''}`;
  return `<span class="qi ${lv}${o.stale ? ' old' : ''}" title="${esc(tip)}">${amount(o.spentUsd)}${of != null ? `/${amount(of)}` : ''}</span>`;
}

export function apiCreditChips(c) {
  if (!c?.ok || !Array.isArray(c.orgs)) return '';
  const orgs = c.orgs.filter((o) => KNOWN.includes(o.org) || o.spentUsd != null);
  if (!orgs.length) return '';
  return `<span class="qg"><b>Claude API</b>${orgs.map(value).join('<i class="dim">-</i>')}</span>`;
}
