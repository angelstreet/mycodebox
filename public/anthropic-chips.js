// Quota-row groups for the monthly API spend per Anthropic org (api-credit.js), in the owner's words (2026-11-28):
// "Claude API 94/200$" and "Claude team API 212$"; with a credit reading both show spent / prepaid credit left, "Claude API 94/945$"
// ("show spending / credit ... we round numbers", 2026-11-28). Red at 95 % of the org's monthly limit (its API calls stop there) or with
// no credit left. An org never read shows "?"; the popup says how to add its key.
const level = (usedPct) => (usedPct >= 95 ? 'crit' : usedPct >= 80 ? 'warn' : 'ok');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const amount = (x) => (x == null ? '?' : String(Math.round(Number(x))));   // the title has the cents
const ORGS = { max: { name: 'Claude API', budget: true }, team: { name: 'Claude team API', budget: false } };
const exact = (x) => `$${Number(x).toFixed(2)}`;
export function apiCreditChips(c) {
  if (!c?.ok || !Array.isArray(c.orgs)) return '';
  return c.orgs.filter((o) => ORGS[o.org] || o.spentUsd != null).map((o) => {
    const { name, budget } = ORGS[o.org] || { name: String(o.label || o.org), budget: false };
    const credit = o.creditLeftUsd;
    const lv = o.spentUsd == null ? 'na' : credit != null && credit <= 0 ? 'crit' : o.budgetUsd ? level(o.usedPercent ?? 0) : 'ok';
    const tip = `${o.label}: API spend this month ${o.spentUsd == null ? 'not read' : exact(o.spentUsd)}${o.spentUsd != null && o.budgetUsd ? ` of the ${exact(o.budgetUsd)} limit (${Math.round(o.usedPercent ?? 0)}%${(o.usedPercent ?? 0) >= 100 ? ', API calls stopped until the 1st' : ''})` : ''}${credit != null ? `, credit left about ${exact(credit)}` : ''}${o.stale || o.error ? `, not live: ${o.error || 'last pull failed'}` : ''}${o.note ? ` — ${o.note}` : ''}`;
    const value = `${amount(o.spentUsd)}${credit != null ? `/${amount(credit)}` : budget && o.budgetUsd ? `/${amount(o.budgetUsd)}` : ''}$`;
    return `<span class="qg" title="${esc(tip)}"><b>${esc(name)}</b><span class="qi ${lv}${o.stale ? ' old' : ''}">${value}</span></span>`;
  }).join('');
}
