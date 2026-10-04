// OpenRouter credit (TASK-44): the VPT server's GET /server/ai/credits (service X-API-Key, no params), polled every
// 10 minutes and cached. 404 / 400 (an older server) = "not available", never an error. Edge alerts at <= $2 and <= $0.
import { serverBase } from './decisions.js';

export const LOW_USD = 2;
const MIN = 60e3;
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// { ok:true, at, endpoints:[{ endpoint, balance, total_credits, total_usage, key:{limit, limit_remaining, usage, usage_daily, usage_monthly}|null, errors[] }], balance }
export function normalizeCredits(j) {
  const endpoints = (Array.isArray(j?.endpoints) ? j.endpoints : []).map((e) => ({
    endpoint: String(e.endpoint || '?'), has_key: e.has_key !== false,
    balance: num(e.balance), total_credits: num(e.total_credits), total_usage: num(e.total_usage),
    key: e.key && typeof e.key === 'object' ? { limit: num(e.key.limit), limit_remaining: num(e.key.limit_remaining), usage: num(e.key.usage), usage_daily: num(e.key.usage_daily), usage_monthly: num(e.key.usage_monthly), is_free_tier: !!e.key.is_free_tier } : null,
    errors: [e.credits_error, e.key_error].filter(Boolean).map(String),
  }));
  const withBalance = endpoints.filter((e) => e.balance != null);
  // the headline balance: the lowest one (the endpoint that runs dry first)
  const balance = withBalance.length ? Math.min(...withBalance.map((e) => e.balance)) : null;
  return { ok: true, at: j?.at || null, endpoints, balance };
}

export const fmtUsd = (x) => (x == null ? '?' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);

// level: 0 fine, 1 low (<= $2), 2 empty (<= $0). Alerts when the level rises; falls back (re-arms) when it drops.
// The first reading only seeds (a restart while empty is not news).
export function createCreditAlerts(alert) {
  let level = null;
  return {
    check(balance) {
      if (balance == null) return;
      const now = balance <= 0 ? 2 : balance <= LOW_USD ? 1 : 0;
      if (level !== null && now > level) {
        alert('openrouter:credits', {
          title: now === 2 ? `OpenRouter credit is used up (${fmtUsd(balance)})` : `OpenRouter credit is low (${fmtUsd(balance)})`,
          body: now === 2 ? 'Jev and AI calls fail with 402 until credit is added.' : 'Add credit before Jev and AI calls start failing.',
          priority: 'high', ntfyTags: 'warning', url: '/', tag: `ghosty-credits-${now}`,
        }, 0);
      }
      level = now;
    },
  };
}

export function createCredits({ jevUrl, apiKey, alert = () => {}, onChange = () => {}, fetchFn = (...a) => fetch(...a), now = () => Date.now(), ttlMs = 10 * MIN } = {}) {
  const base = serverBase(jevUrl);
  const alerts = createCreditAlerts(alert);
  let cached = null, at = 0, inflight = null;
  async function load() {
    let res;
    if (!base || !apiKey) res = { ok: false, error: 'server not configured' };
    else {
      try {
        const r = await fetchFn(`${base}/server/ai/credits`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10000) });
        const j = await r.json().catch(() => null);
        res = r.ok && j && j.success !== false ? normalizeCredits(j) : { ok: false, status: r.status, error: String(j?.error || `http ${r.status}`).slice(0, 200) };
      } catch (e) { res = { ok: false, error: e.message }; }
    }
    at = now();
    const before = JSON.stringify(cached);
    // a failed refresh after a good reading keeps the last good one (marked stale)
    cached = !res.ok && cached?.ok ? { ...cached, stale: res.error } : res;
    if (res.ok) alerts.check(res.balance);
    if (JSON.stringify(cached) !== before) onChange(cached);
    return cached;
  }
  const refresh = () => (inflight ||= load().finally(() => { inflight = null; }));
  return {
    peek: () => cached,
    async get() { if (!cached || now() - at > ttlMs) await refresh(); return cached; },
    refresh,
    start() { refresh().catch(() => {}); setInterval(() => refresh().catch(() => {}), ttlMs).unref?.(); },
  };
}
