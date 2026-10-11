// V2 host/service telemetry with freshness (spec §12.4, T35). A reading is { name, value, unit, ts, source } plus
// computed freshness. Stale, future-dated, unreachable or non-numeric readings are `unknown`, never healthy, and a
// reading older than `since` (e.g. taken before a repair) can never count as recovery.
export const DEFAULT_THRESHOLDS = { cpu_pct: 90, mem_pct: 90, disk_pct: 90 };
export const METRIC_INCIDENT = { cpu_pct: 'host.cpu_pressure', mem_pct: 'host.memory_pressure', disk_pct: 'host.disk_pressure' };
const UNITS = { cpu_pct: '%', mem_pct: '%', disk_pct: '%', service_ready: 'bool' };

// Adapter: health.js sampleHealth() output -> readings (input only; health.js is unchanged).
export function readingsFromHealth(h, source = 'health.js') {
  const ts = Number.isFinite(h?.at) ? h.at : null;
  const disks = Array.isArray(h?.disks) ? h.disks.map((d) => d?.pct).filter(Number.isFinite) : [];
  return [
    { name: 'cpu_pct', value: h?.cpu?.pct ?? null, unit: '%', ts, source },
    { name: 'mem_pct', value: h?.mem?.pct ?? null, unit: '%', ts, source },
    { name: 'disk_pct', value: disks.length ? Math.max(...disks) : null, unit: '%', ts, source },
  ];
}

export function createTelemetry({
  probe, serviceProbe = null, thresholds = {}, maxAgeMs = 60_000, maxFutureMs = 5_000, now = Date.now,
  required = ['cpu_pct', 'mem_pct', 'disk_pct'],
} = {}) {
  if (typeof probe !== 'function') throw new Error('telemetry: probe required');
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };

  function classify(r, since) {
    const t = now();
    const ts = Number.isFinite(r?.ts) ? r.ts : null;
    let freshness = 'fresh';
    if (ts == null) freshness = 'unknown';
    else if (ts > t + maxFutureMs) freshness = 'unknown';
    else if (t - ts > maxAgeMs || (since != null && ts < since)) freshness = 'stale';
    const value = Number.isFinite(r?.value) ? r.value : null;
    const threshold = limits[r?.name] ?? null;
    let status = 'unknown';
    if (freshness === 'fresh' && value != null) {
      if (r.name === 'service_ready') status = value >= 1 ? 'ok' : 'pressure';
      else status = threshold != null && value >= threshold ? 'pressure' : 'ok';
    }
    return { name: String(r?.name), value, unit: r?.unit ?? UNITS[r?.name] ?? '', ts, source: r?.source ?? 'unknown', freshness, age_ms: ts == null ? null : t - ts, status, threshold };
  }

  // -> { status: 'healthy'|'unhealthy'|'unknown', pressures[], unknown[], readings[], at }
  async function assess(host_id, { service_id = null, since = null } = {}) {
    let raw = [];
    let hostErr = null;
    try {
      const out = await probe(host_id);
      raw = Array.isArray(out) ? out : [];
      if (!Array.isArray(out)) hostErr = 'unreadable';
    } catch (e) { hostErr = String(e?.code || 'unreachable'); }
    const byName = new Map(raw.map((r) => [r?.name, r]));
    const readings = required.map((n) => classify(byName.get(n) || { name: n, value: null, ts: null, source: hostErr ? `unreachable:${hostErr}` : 'missing' }, since));
    for (const r of raw) if (!required.includes(r?.name) && r?.name in limits) readings.push(classify(r, since));
    if (service_id != null) {
      let s = null;
      try { s = serviceProbe ? await serviceProbe(host_id, service_id) : null; } catch { s = null; }
      readings.push(classify({ name: 'service_ready', value: s && typeof s.healthy === 'boolean' ? (s.healthy ? 1 : 0) : null, ts: s?.ts ?? null, source: s?.source ?? 'unreachable' }, since));
    }
    const pressures = [...new Set(readings.filter((r) => r.status === 'pressure').map((r) => (r.name === 'service_ready' ? 'service.unhealthy' : METRIC_INCIDENT[r.name] || 'health.unknown')))];
    const unknown = readings.filter((r) => r.status === 'unknown').map((r) => r.name);
    const status = pressures.length ? 'unhealthy' : unknown.length ? 'unknown' : 'healthy';
    return { status, pressures, unknown, readings, at: now() };
  }

  return { assess, classify, thresholds: { ...limits }, maxAgeMs };
}
