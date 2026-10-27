// The Claude Max extra-usage budget, read at most once an hour (owner, 2026-10-27), cached on disk so a restart never refetches early:
// The Claude Max account's monthly extra-usage limit and what is used (the same figures /usage shows), from
//    GET api.anthropic.com/api/oauth/usage with the Claude Code login token (read here, never logged or sent anywhere else);
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const HOUR = 3600e3;
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// extra_usage: { monthly_limit, used_credits } in minor units (decimal_places, default 2), plus a currency
export function normalizeExtra(j) {
  const e = j?.extra_usage;
  const limit = num(e?.monthly_limit), used = num(e?.used_credits);
  if (limit == null || used == null) return null;
  const k = 10 ** (num(e.decimal_places) ?? 2);
  return { limit: limit / k, used: used / k, left: (limit - used) / k, currency: String(e.currency || 'USD'), enabled: e.is_enabled !== false, reason: e.disabled_reason || null };
}

export function createAnthropicSpend({
  stateDir, credentialsFile = join(homedir(), '.claude', '.credentials.json'),
  fetchFn = (...a) => fetch(...a), now = () => Date.now(), ttlMs = HOUR, onChange = () => {},
} = {}) {
  const ttl = Math.max(HOUR, ttlMs);   // never more than one pull an hour
  const file = stateDir ? join(stateDir, 'anthropic-spend.json') : null;
  let cached = null, inflight = null;

  async function loadExtra() {
    let tok;
    try {
      const c = JSON.parse(await fs.readFile(credentialsFile, 'utf8')), o = c.claudeAiOauth || c;
      if (o.expiresAt && o.expiresAt < now()) return { error: 'Claude login expired' };
      tok = o.accessToken;
    } catch { return { error: 'no Claude login on this host' }; }
    if (!tok) return { error: 'no Claude login on this host' };
    try {
      const r = await fetchFn('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { error: `http ${r.status}` };
      const v = normalizeExtra(await r.json().catch(() => null));
      return v ? { value: v } : { error: 'no extra-usage figure' };
    } catch (e) { return { error: e.message }; }
  }
  async function load() {
    const x = await loadExtra();
    const prev = cached;
    // a failed pull keeps the last good value, marked stale; the clock still advances so a failure is not retried in a loop
    const keep = (nw, old) => (nw.value ? { ...nw.value } : old ? { ...old, stale: nw.error } : { error: nw.error });
    cached = { ok: true, at: now(), extra: keep(x, prev?.extra) };
    if (file) { try { await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(cached)); } catch { /* cache only */ } }
    if (JSON.stringify(prev) !== JSON.stringify(cached)) onChange(cached);
    return cached;
  }
  const refresh = () => (inflight ||= load().finally(() => { inflight = null; }));
  async function seed() {
    if (cached || !file) return;
    try { cached = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none yet */ }
  }
  return {
    peek: () => cached,
    async get() { await seed(); if (!cached || now() - cached.at >= ttl) await refresh(); return cached; },
    start() {
      seed().then(() => { if (!cached || now() - cached.at >= ttl) return refresh(); onChange(cached); }).catch(() => {});
      setInterval(() => refresh().catch(() => {}), ttl).unref?.();
    },
  };
}
