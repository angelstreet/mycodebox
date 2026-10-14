// Budget checks (ARCHITECTURE §8, OWNER_DECISIONS §4). Default { mode:'track' } measures and never stops. An explicit
// max_usd / max_input_tokens / max_output_tokens / max_duration_ms / max_turns is a hard stop that leads to awaiting_approval,
// never silent overspend. Unknown spend stays unknown (null) and cannot satisfy a cap check. Pure.

export const DIMENSIONS = [
  { key: 'usd', cap: 'max_usd' },
  { key: 'input_tokens', cap: 'max_input_tokens' },
  { key: 'output_tokens', cap: 'max_output_tokens' },
  { key: 'duration_ms', cap: 'max_duration_ms' },
  { key: 'turns', cap: 'max_turns' },
];
export const DEFAULT_BUDGET_POLICY = Object.freeze({ mode: 'track' });
const known = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;   // negative = invalid, treated as unknown
const present = (v) => v !== undefined && v !== null;
const invalid = (v) => present(v) && !known(v);

// Caps the owner set but that are not usable numbers (string, NaN, negative): they must stop, never become track mode.
export function malformedCaps(p) {
  if (!present(p)) return [];
  if (typeof p !== 'object' || Array.isArray(p)) return ['budget_policy'];
  const bad = [];
  for (const d of DIMENSIONS) if (invalid(p[d.cap])) bad.push(d.cap);
  if (present(p.per_attempt)) {
    if (typeof p.per_attempt !== 'object' || Array.isArray(p.per_attempt)) bad.push('per_attempt');
    else for (const d of DIMENSIONS) if (invalid(p.per_attempt[d.cap])) bad.push(`per_attempt.${d.cap}`);
  }
  return bad;
}

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
  const ledger_invalid = !(ledger && typeof ledger === 'object' && Array.isArray(ledger.entries));
  const entries = ledger_invalid ? [] : ledger.entries;
  const spent = {}; const unknown = []; const by_kind = {}; const negative = [];
  for (const d of DIMENSIONS) {
    let sum = 0; let n = 0; let miss = 0;
    for (const e of entries) {
      const v = e?.[d.key];
      if (known(v)) { sum += v; n++; } else { miss++; if (invalid(v)) negative.push(d.key); }
    }
    // A missing/malformed ledger is unknown spend, not zero.
    spent[d.key] = ledger_invalid ? null : entries.length === 0 ? 0 : (n ? sum : null);
    spent[`${d.key}_unknown_entries`] = ledger_invalid ? 1 : miss;
    if (miss || ledger_invalid) unknown.push(d.key);
  }
  for (const e of entries) {
    const k = e?.kind || 'unspecified';
    by_kind[k] = by_kind[k] || { usd: 0, entries: 0 };
    by_kind[k].entries++;
    if (known(e?.usd)) by_kind[k].usd += e.usd;
  }
  return { spent, unknown, by_kind, entries: entries.length, ledger_invalid, invalid_dimensions: [...new Set(negative)] };
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

  const stops = [];
  const bad = malformedCaps(task?.budget_policy);
  if (bad.length) stops.push(`malformed cap ${bad.join(', ')}: not a non-negative number, cannot enforce`);
  base.quota = quota?.status === 'ok' ? 'ok' : quota?.status === 'exhausted' ? 'exhausted' : 'unknown';
  if (base.quota === 'unknown') base.warnings.push('quota unknown: could not observe provider quota');

  const attemptEntries = (est.attempt_id && sum.entries) ? ledger.entries.filter((e) => e?.attempt_id === est.attempt_id) : [];
  for (const d of DIMENSIONS) {
    const cap = bp[d.cap];
    const acap = bp.per_attempt?.[d.cap];
    if (cap == null && acap == null) continue;
    if (invalid(est[d.key])) { stops.push(`${d.key}: negative or invalid estimate rejected`); continue; }
    if (cap != null) {   // whole task
      const s = sum.spent[d.key]; const miss = sum.spent[`${d.key}_unknown_entries`];
      if (sum.ledger_invalid) stops.push(`${d.key}: ledger missing or malformed, spend unknown, cannot verify against ${d.cap}=${cap}`);
      else if (sum.invalid_dimensions.includes(d.key)) stops.push(`${d.key}: negative or invalid ledger amount, cannot verify against ${d.cap}=${cap}`);
      else if (miss > 0) stops.push(`${d.key}: spend unknown for ${miss} ledger entr${miss === 1 ? 'y' : 'ies'}, cannot verify against ${d.cap}=${cap}`);
      else if (s >= cap) stops.push(`${d.key}: cap ${d.cap}=${cap} reached (spent ${s})`);
      else if (!known(est[d.key])) stops.push(`${d.key}: estimate unknown, may exceed ${d.cap}=${cap}`);
      else if (s + est[d.key] > cap) stops.push(`${d.key}: ${s} spent + ${est[d.key]} estimated would exceed ${d.cap}=${cap}`);
    }
    if (acap != null) {   // single attempt
      if (sum.ledger_invalid) { stops.push(`${d.key}: ledger missing or malformed, spend unknown, cannot verify against per-attempt ${d.cap}=${acap}`); continue; }
      const own = attemptEntries.filter((e) => known(e[d.key])).reduce((a, e) => a + e[d.key], 0);
      if (attemptEntries.some((e) => !known(e[d.key]))) stops.push(`${d.key}: spend unknown inside this attempt, cannot verify against per-attempt ${d.cap}=${acap}`);
      else if (!known(est[d.key])) stops.push(`${d.key}: attempt estimate unknown, may exceed per-attempt ${d.cap}=${acap}`);
      else if (own + est[d.key] > acap) stops.push(`${d.key}: attempt would exceed per-attempt ${d.cap}=${acap}`);
    }
  }
  // A reached/unverifiable cap wins over a quota wait: spending needs the owner either way.
  if (stops.length) return verdict(false, stops.join('; '), 'awaiting_approval', base);
  if (quota?.status === 'exhausted') {
    return verdict(false, 'provider quota exhausted: waiting with backoff', 'waiting', { ...base, backoff_ms: known(quota.retry_after_ms) ? quota.retry_after_ms : null });
  }
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
