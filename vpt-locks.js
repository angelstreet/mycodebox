// VPT take-control locks, read-only, for the Platforms page (TASK-58 C10).
// Source: the VPT server's own GET /server/control/lockedDevices (in-memory device locks: manual take-control, script,
// deployment), called with the X-API-Key ghosty already uses for Jev (JEV_API_KEY, origin of JEV_URL). Only GET, no body.
// Note: that route also runs the server's opportunistic reaping of already-expired locks (the web UI calls it on every
// load); ghosty never takes, releases or forces a lock.
// Cached (ttlMs), timeout-guarded, one request in flight at a time; any failure is { ok: false, error } and the page shows
// "VPT lock: unknown". Never throws.

export const serverOrigin = (jevUrl) => { try { return new URL(jevUrl).origin; } catch { return ''; } };

// Pure: the server's {device_key: lock} map -> small rows (no session ids), newest first.
export function lockRows(map, nowSec) {
  return Object.values(map && typeof map === 'object' ? map : {}).filter((l) => l && l.host_name).map((l) => ({
    host: String(l.host_name), device: String(l.device_id || ''),
    ownerType: String(l.owner_type || 'unknown'),
    owner: String(l.owner_user_name || l.owner_user_id || '').slice(0, 40),
    reason: String(l.active_script_reason || l.lock_reason || '').slice(0, 80),
    ageMin: Number.isFinite(Number(l.locked_at)) && Number(l.locked_at) > 0 ? Math.max(0, Math.round((nowSec - Number(l.locked_at)) / 60)) : null,
  })).sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
}

export function createVptLockStore({ jevUrl = '', apiKey = '', fetchFn = (...a) => fetch(...a), now = Date.now, ttlMs = 15000, errorTtlMs = 10000, timeoutMs = 4000 } = {}) {
  const base = serverOrigin(jevUrl);
  let cache = null;      // { at, ttl, value }
  let inflight = null;
  async function fetchOnce() {
    if (!base || !apiKey) return { ok: false, error: 'VPT server not configured' };
    try {
      const r = await fetchFn(`${base}/server/control/lockedDevices`, { method: 'GET', headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.success === false) return { ok: false, error: String(j?.error || `http ${r.status}`).slice(0, 120) };
      return { ok: true, locks: lockRows(j.locked_devices, now() / 1000) };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }
  async function get() {
    if (cache && now() - cache.at < cache.ttl) return cache.value;
    if (!inflight) inflight = fetchOnce().then((value) => { cache = { at: now(), ttl: value.ok ? ttlMs : errorTtlMs, value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }
  return { get, peek: () => cache?.value || null };
}
