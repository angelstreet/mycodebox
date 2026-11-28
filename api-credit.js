// API credit per Anthropic org: what this month's API (pay-as-you-go) usage cost, against a monthly budget.
//   source   the org's Admin API cost report: GET api.anthropic.com/v1/organizations/analytics/cost (Usage and Cost
//            Analytics API), falling back to the older /v1/organizations/cost_report when that is not open to the org.
//            Each org needs an admin key (sk-ant-admin..., or an organization-scoped sk-ant-usr key) in ~/.config/anthropic/<org>.admin.key, read at request time,
//            never logged, never cached, sent only to api.anthropic.com. No key = a row that says how to add one.
//   budgets  $GHOSTY_STATE_DIR/quota-budgets.json (not secret), e.g. {"max":{"label":"Max account","budgetUsd":200,"period":"month"}};
//            the defaults below when the file is absent.
// Asked at most every 15 minutes, cached on disk; a failed pull keeps the last good figure marked stale.
// Amounts in both reports are decimal strings in cents (USD), after discounts and before credits.
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const POLL_MS = 15 * 60e3;
export const FORCE_MIN_MS = 60e3; // the popup's refresh button: a forced pull at most once a minute
export const DEFAULT_BUDGETS = {
  max: { label: 'Max account', budgetUsd: 200, period: 'month' },
  team: { label: 'Team account', budgetUsd: 1000, period: 'month' },
};
const API = 'https://api.anthropic.com';
const ORG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_PAGES = 12;

export const monthStart = (t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().replace('.000Z', 'Z'); };
export const keyHint = (org) => `no admin key: add ~/.config/anthropic/${org}.admin.key`;
const cents = (x) => {
  const v = typeof x === 'object' && x !== null ? x.amount ?? x.value : x;
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? 0 : n;
};

// One page of either report -> { cents, rows, hasMore, nextPage, refreshedAt }.
//   analytics: { data:[{ amount, list_amount, ... }], data_refreshed_at, has_more, next_page }
//   legacy:    { data:[{ starting_at, ending_at, results:[{ amount, currency, ... }] }], has_more, next_page }
export function parseCostReport(body) {
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data) throw new Error('unexpected cost report');
  let total = 0, rows = 0;
  for (const d of data) {
    if (Array.isArray(d?.results)) for (const r of d.results) { total += cents(r?.amount); rows++; }
    else if (d && 'amount' in d) { total += cents(d.amount); rows++; }
  }
  return { cents: total, rows, hasMore: !!body.has_more, nextPage: body.next_page || null, refreshedAt: body.data_refreshed_at ?? null };
}

export function normalizeBudgets(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length ? raw : DEFAULT_BUDGETS;
  const out = [];
  for (const [org, b] of Object.entries(src)) {
    if (!ORG_RE.test(org) || !b || typeof b !== 'object') continue;
    const budget = Number(b.budgetUsd);
    out.push({ org, label: String(b.label || DEFAULT_BUDGETS[org]?.label || org), budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null, period: 'month' });
  }
  return out;
}

export function createApiCredit({
  stateDir, keyDir = join(homedir(), '.config', 'anthropic'),
  fetchFn = (...a) => fetch(...a), now = () => Date.now(), ttlMs = POLL_MS, onChange = () => {},
} = {}) {
  const ttl = Math.max(POLL_MS, ttlMs);
  const file = stateDir ? join(stateDir, 'api-credit.json') : null;
  const budgetsFile = stateDir ? join(stateDir, 'quota-budgets.json') : null;
  let cached = null, inflight = null;

  async function budgets() {
    try { return normalizeBudgets(JSON.parse(await fs.readFile(budgetsFile, 'utf8'))); } catch { return normalizeBudgets(null); }
  }
  async function readKey(org) {
    try { return (await fs.readFile(join(keyDir, `${org}.admin.key`), 'utf8')).trim() || null; } catch { return null; }
  }
  async function pages(path, params, key) {
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
    let total = 0, rows = 0, refreshedAt = null, page = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams(params);
      if (page) q.set('page', page);
      const r = await fetchFn(`${API}${path}?${q}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { const j = await r.json().catch(() => null); return { status: r.status, reason: String(j?.error?.message || '').replace(/sk-ant-[\w-]+/g, '***').slice(0, 200) }; }
      const p = parseCostReport(await r.json().catch(() => null));
      total += p.cents; rows += p.rows; refreshedAt = p.refreshedAt ?? refreshedAt;
      if (!p.hasMore || !p.nextPage) return { cents: total, rows, refreshedAt };
      page = p.nextPage;
    }
    return { cents: total, rows, refreshedAt, partial: true };
  }
  async function spentOf(org, t) {
    const key = await readKey(org);
    if (!key) return { error: keyHint(org), noKey: true };
    const from = monthStart(t);
    try {
      let r = await pages('/v1/organizations/analytics/cost', { starting_at: from }, key), source = 'Admin API cost analytics';
      if (r.status === 404 || r.status === 400) { r = await pages('/v1/organizations/cost_report', { starting_at: from, bucket_width: '1d', limit: '31' }, key); source = 'Admin API cost report (to last UTC midnight)'; }
      if (r.status === 401 || r.status === 403) return { error: `key refused (http ${r.status})${r.reason ? `: ${r.reason}` : ''} — ~/.config/anthropic/${org}.admin.key needs an sk-ant-admin key or an org-scoped key` };
      if (r.status) return { error: `http ${r.status}${r.reason ? `: ${r.reason}` : ''}` };
      return { value: { spentUsd: Math.round(r.cents) / 100, source, refreshedAt: r.refreshedAt, ...(r.rows ? {} : { note: 'no cost recorded yet this month (data lands 4 to 24 h late)' }) } };
    } catch (e) { return { error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e).replace(/sk-ant-[\w-]+/g, '***') }; }
  }
  async function load() {
    const t = now(), month = monthStart(t).slice(0, 7), prev = cached?.month === month ? cached : null;
    const orgs = [];
    for (const b of await budgets()) {
      const x = await spentOf(b.org, t), old = prev?.orgs?.find((o) => o.org === b.org && o.spentUsd != null);
      let row;
      if (x.value) row = { ...b, ...x.value };
      else if (old && !x.noKey) row = { ...b, spentUsd: old.spentUsd, source: old.source, refreshedAt: old.refreshedAt ?? null, stale: true, error: x.error };
      else row = { ...b, spentUsd: null, error: x.error, ...(x.noKey ? { noKey: true } : {}) };
      if (row.spentUsd != null && row.budgetUsd) { row.leftUsd = Math.round((row.budgetUsd - row.spentUsd) * 100) / 100; row.usedPercent = Math.round((row.spentUsd / row.budgetUsd) * 1000) / 10; }
      orgs.push(row);
    }
    const before = cached;
    cached = { ok: true, at: t, month, orgs };
    if (file) { try { await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(cached)); } catch { /* cache only */ } }
    if (JSON.stringify({ ...before, at: 0 }) !== JSON.stringify({ ...cached, at: 0 })) onChange(cached);
    return cached;
  }
  const refresh = () => (inflight ||= load().finally(() => { inflight = null; }));
  async function seed() {
    if (cached || !file) return;
    try { cached = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none yet */ }
  }
  const due = () => !cached || now() - cached.at >= ttl || cached.month !== monthStart(now()).slice(0, 7);
  return {
    peek: () => cached,
    refresh,
    // force (the quota popup's refresh button): pull now unless the last pull is under a minute old, so a new key shows at once
    async get({ force = false } = {}) { await seed(); if (due() || (force && now() - cached.at >= FORCE_MIN_MS)) await refresh(); return cached; },
    start() {
      seed().then(() => { if (due()) return refresh(); onChange(cached); }).catch(() => {});
      setInterval(() => refresh().catch(() => {}), ttl).unref?.();
    },
  };
}
