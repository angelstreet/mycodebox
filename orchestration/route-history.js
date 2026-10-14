// Router history from the V2 scorecard (OWNER_DECISIONS §12.3, D-025). Pure: a scorecard (orchestration/scorecard.js
// buildScorecard) plus, optionally, per-entry developer token totals from the task logs -> the router's `history`
// ({ "<runtime>:<model>": { attempts, verified, errors, latency_ms, total_usd, first_pass_rate, input_tokens,
// output_tokens, token_attempts } }). Unknown stays unknown (null), never 0.
//
// Cost by billing: per_token entries carry their known USD (total_usd, null when any settled task's spend is unknown);
// subscription entries carry no USD (total_usd null) and the router prices their tokens at the quota share or the
// nominal SUBSCRIPTION_NOMINAL_USD_PER_MTOK. quota_share_usd shows that figure here for reports; the router recomputes it.
import { SUBSCRIPTION_NOMINAL_USD_PER_MTOK } from './router.js';

const known = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// logs: [{ task_id, events }] -> { "<runtime>:<model>": { input_tokens, output_tokens, token_attempts } } over DEVELOPER runs
// whose usage reports both counts (incomplete records are left out: their totals are lower bounds).
export function tokenTotals(logs = []) {
  const out = {};
  for (const { events = [] } of logs) {
    const dev = new Map(events.filter((e) => e.kind === 'task.started' && e.payload?.role === 'developer' && typeof e.payload.entry === 'string').map((e) => [e.payload.run_id, e.payload.entry]));
    for (const e of events) {
      if (e.kind !== 'usage.recorded') continue;
      const p = e.payload || {};
      const id = dev.get(p.run_id);
      if (!id || p.incomplete === true || !known(p.input_tokens) || !known(p.output_tokens)) continue;
      const t = out[id] || (out[id] = { input_tokens: 0, output_tokens: 0, token_attempts: 0 });
      t.input_tokens += p.input_tokens; t.output_tokens += p.output_tokens; t.token_attempts += 1;
    }
  }
  return out;
}

// registry (optional): billing and quota per entry. -> router history
export function routeHistory(scorecard, { tokens = {}, registry = null } = {}) {
  const out = {};
  for (const g of scorecard?.by_model || []) {
    if (!g || g.runtime === 'unknown' || !Number.isInteger(g.settled) || g.settled < 1) continue;
    const id = g.key;
    const entry = registry?.get?.(id) || null;
    const billing = entry?.billing ?? 'unknown';
    const t = tokens[id] || (g.tokens && known(g.tokens.input) && known(g.tokens.output) && Number.isInteger(g.tokens.runs) ? { input_tokens: g.tokens.input, output_tokens: g.tokens.output, token_attempts: g.tokens.runs } : null);
    const usd = g.cost?.spend_unknown_tasks === 0 && known(g.cost?.usd_known_total) ? g.cost.usd_known_total : null;
    const h = {
      attempts: g.settled, verified: g.verified, errors: Number.isInteger(g.failed) ? g.failed : null,
      first_pass_rate: known(g.first_pass_rate) ? g.first_pass_rate : null,
      latency_ms: known(g.median_latency_ms) ? g.median_latency_ms : null,
      // A subscription's USD is not a measured spend: the router prices its tokens instead (D-025).
      total_usd: billing === 'subscription' ? null : usd,
      billing,
    };
    if (t && t.token_attempts > 0) {
      Object.assign(h, { input_tokens: t.input_tokens, output_tokens: t.output_tokens, token_attempts: t.token_attempts });   // runs, not tasks
      if (billing === 'subscription') {
        const q = entry?.quota;
        const perM = q && known(q.usd) && known(q.tokens) && q.tokens > 0 ? (q.usd / q.tokens) * 1e6 : SUBSCRIPTION_NOMINAL_USD_PER_MTOK;
        h.quota_share_usd = Math.round(((t.input_tokens + t.output_tokens) / 1e6) * perM * 1e6) / 1e6;
        h.quota_share_basis = perM === SUBSCRIPTION_NOMINAL_USD_PER_MTOK ? 'nominal' : 'quota';
      }
    }
    out[id] = h;
  }
  return out;
}
