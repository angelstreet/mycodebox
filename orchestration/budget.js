// Budget checks (ARCHITECTURE §8, OWNER_DECISIONS §4). Default { mode:'track' } measures and never stops. An explicit
// max_usd / max_input_tokens / max_output_tokens / max_duration_ms is a hard stop that leads to awaiting_approval,
// never silent overspend. Unknown spend stays unknown (null) and cannot satisfy a cap check. Pure.

export const DIMENSIONS = [
  { key: 'usd', cap: 'max_usd' },
  { key: 'input_tokens', cap: 'max_input_tokens' },
  { key: 'output_tokens', cap: 'max_output_tokens' },
  { key: 'duration_ms', cap: 'max_duration_ms' },
];
export const DEFAULT_BUDGET_POLICY = Object.freeze({ mode: 'track' });
const known = (v) => typeof v === 'number' && Number.isFinite(v);

export function normalizeBudgetPolicy(p) {
  const bp = p && typeof p === 'object' ? p : DEFAULT_BUDGET_POLICY;
  const out = { mode: bp.mode || 'track' };
  for (const d of DIMENSIONS) if (known(bp[d.cap])) out[d.cap] = bp[d.cap];
  if (bp.per_attempt && typeof bp.per_attempt === 'object') {
    out.per_attempt = {};
    for (const d of DIMENSIONS) if (known(bp.per_attempt[d.cap])) out.per_attempt[d.cap] = bp.per_attempt[d.cap];
  }
  return out;
}

// ledger = { entries: [{ attempt_id, kind, usd, input_tokens, output_tokens, duration_ms }] }. Every kind counts
// (developer, verifier, retry, repair...). Per dimension: value = sum of the known entries, or null when entries exist
// but none reported it; unknown_count = entries that did not report it (the sum is then a lower bound).
export function summarize(ledger) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const spent = {}; const unknown = []; const by_kind = {};
  for (const d of DIMENSIONS) {
    let sum = 0; let n = 0; let miss = 0;
    for (const e of entries) { if (known(e?.[d.key])) { sum += e[d.key]; n++; } else miss++; }
    spent[d.key] = entries.length === 0 ? 0 : (n ? sum : null);
    spent[`${d.key}_unknown_entries`] = miss;
    if (miss) unknown.push(d.key);
  }
  for (const e of entries) {
    const k = e?.kind || 'unspecified';
    by_kind[k] = by_kind[k] || { usd: 0, entries: 0 };
    by_kind[k].entries++;
    if (known(e?.usd)) by_kind[k].usd += e.usd;
  }
  return { spent, unknown, by_kind, entries: entries.length };
}

function verdict(allow, reason, state_hint, extra = {}) { return { allow, reason, state_hint, ...extra }; }

// check(task, ledger, estimate, { quota }) -> { allow, reason, state_hint, ... }
// estimate = { usd, input_tokens, output_tokens, duration_ms, attempt_id? } for the step about to start (null = unknown).
// quota = { status:'ok'|'unknown'|'exhausted', retry_after_ms? }: provider quota, separate from the owner's caps.
export function check(task, ledger, estimate = {}, { quota = null } = {}) {
  const bp = normalizeBudgetPolicy(task?.budget_policy);
  const sum = summarize(ledger);
  const base = { mode: bp.mode, spent: sum.spent, unknown_spend: sum.unknown, by_kind: sum.by_kind, warnings: [] };
  const est = estimate && typeof estimate === 'object' ? estimate : {};

  // Quota exhaustion is a wait, not a budget decision; missing quota data is only a warning.
  if (quota?.status === 'exhausted') {
    return verdict(false, 'provider quota exhausted: waiting with backoff', 'waiting', { ...base, backoff_ms: known(quota.retry_after_ms) ? quota.retry_after_ms : null, quota: 'exhausted' });
  }
  if (!quota || quota.status === 'unknown') base.warnings.push('quota unknown: could not observe provider quota');
  base.quota = quota?.status === 'ok' ? 'ok' : 'unknown';

  const stops = [];
  const attemptSpend = (key) => {
    const id = est.attempt_id;
    if (!id) return 0;
    return (ledger?.entries || []).filter((e) => e?.attempt_id === id && known(e[key])).reduce((a, e) => a + e[key], 0);
  };
  for (const d of DIMENSIONS) {
    // whole task
    const cap = bp[d.cap];
    if (cap != null) {
      const s = sum.spent[d.key];
      if (sum.spent[`${d.key}_unknown_entries`] > 0) stops.push(`${d.key}: spend unknown for ${sum.spent[`${d.key}_unknown_entries`]} ledger entr${sum.spent[`${d.key}_unknown_entries`] === 1 ? 'y' : 'ies'}, cannot verify against ${d.cap}=${cap}`);
      else if (s >= cap) stops.push(`${d.key}: cap ${d.cap}=${cap} reached (spent ${s})`);
      else if (!known(est[d.key])) stops.push(`${d.key}: estimate unknown, may exceed ${d.cap}=${cap}`);
      else if (s + est[d.key] > cap) stops.push(`${d.key}: ${s} spent + ${est[d.key]} estimated would exceed ${d.cap}=${cap}`);
    }
    // single attempt
    const acap = bp.per_attempt?.[d.cap];
    if (acap != null) {
      if (!known(est[d.key])) stops.push(`${d.key}: attempt estimate unknown, may exceed per-attempt ${d.cap}=${acap}`);
      else if (attemptSpend(d.key) + est[d.key] > acap) stops.push(`${d.key}: attempt would exceed per-attempt ${d.cap}=${acap}`);
    }
  }
  if (stops.length) return verdict(false, stops.join('; '), 'awaiting_approval', base);
  const caps = DIMENSIONS.some((d) => bp[d.cap] != null) || !!bp.per_attempt;
  return verdict(true, caps ? 'within explicit caps' : 'track mode: no caps set, spend is measured only', null, base);
}

// Remaining headroom per capped dimension (null = no cap or unknown spend). For display and estimates.
export function remaining(task, ledger) {
  const bp = normalizeBudgetPolicy(task?.budget_policy); const sum = summarize(ledger);
  const out = {};
  for (const d of DIMENSIONS) out[d.key] = bp[d.cap] != null && known(sum.spent[d.key]) && !sum.spent[`${d.key}_unknown_entries`] ? Math.max(0, bp[d.cap] - sum.spent[d.key]) : null;
  return out;
}
