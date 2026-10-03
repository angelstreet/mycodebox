// Server side of the usage view: reads usage-summary.json (written every minute by the ghosty-usage unit),
// caches it for ~30 s, and answers /api/usage and the per-session `usage` field of the status payload.
// Read-only; 404-safe (no file -> get() is null).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { usageByLabel, sessionDays } from './public/usage.js';

export function createUsage({ file, ttlMs = 30000, now = () => Date.now() } = {}) {
  let cached = null, at = 0, index = new Map(), inflight = null;
  async function load() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      cached = JSON.parse(raw);
    } catch { cached = null; }
    at = now();
    index = usageByLabel(cached, now());
  }
  const refresh = () => (inflight ||= load().finally(() => { inflight = null; }));
  return {
    // fresh-enough summary or null; never throws
    async get() { if (!at || now() - at > ttlMs) await refresh(); return cached; },
    // sync, no I/O: the status payload field for one tmux session, or null. Call refresh via get() on a timer.
    forSession(name) { const u = index.get(name); return u ? { todayCost: u.todayCost, todayTokens: u.todayTokens, totalCost: u.totalCost, outlier: u.outlier } : null; },
    // /api/usage body: the summary plus the live sessions' entries ({ today, days[14] }); null without a file
    async body(liveNames = []) {
      const summary = await this.get();
      if (!summary) return null;
      const sessions = {};
      for (const n of liveNames) {
        const u = index.get(n);
        if (u) sessions[n] = { ...u, days: sessionDays(summary, n, 14, now()) };
      }
      return { ...summary, sessions };
    },
    invalidate() { at = 0; },
  };
}
export const usageFile = (env = process.env, stateDir) => env.USAGE_SUMMARY || join(stateDir, 'usage-summary.json');
