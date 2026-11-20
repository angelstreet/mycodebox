// Event-loop lag recorder (manager 2026-11-20): on 2026-11-20 the page's own API calls stayed pending for 15 s while curl answered in 4 ms,
// and nothing recorded whether the server loop stalled. A timer that should fire every `intervalMs` reports how late it was; the worst
// lags are kept in a small list with their timestamps (GET /api/health -> eventLoop), and every lag of `spikeMs` or more is one journal line.
export const INTERVAL_MS = 100;
export const SPIKE_MS = 500;
export const KEEP = 20;

export function createLagMonitor({ intervalMs = INTERVAL_MS, spikeMs = SPIKE_MS, keep = KEEP, now = Date.now, onSpike = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let last = now(), timer = null, worst = [], total = 0;
  const tick = () => {
    const t = now(), lag = Math.max(0, t - last - intervalMs);
    last = t;
    if (lag < 50) return lag;   // timer jitter, not a stall
    total += 1;
    const rec = { at: new Date(t).toISOString(), lagMs: Math.round(lag) };
    worst.push(rec); worst.sort((a, b) => b.lagMs - a.lagMs); if (worst.length > keep) worst.length = keep;
    if (lag >= spikeMs) { try { onSpike(rec); } catch { /* the journal must never break the loop */ } }
    return lag;
  };
  return {
    tick,
    start() { if (!timer) { last = now(); timer = setTimer(tick, intervalMs); timer.unref?.(); } },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    snapshot() { return { intervalMs, spikeMs, stalls: total, worst: worst.map((w) => ({ ...w })) }; },
  };
}
