// MiniMax usage per session (owner 2026-10-27: "what is using MiniMax so much?"). Read-only metering over usage-ledger.jsonl.
// The plan's 5h window looks counted in model CALLS, not tokens (each call re-reads ~200K of cached context), so the
// meter ranks sessions by calls and shows new tokens (input+output) and cache reads next to them. MiniMax is unpriced,
// so nothing here is money. Pure functions plus a small cached reader; nothing here changes a session.
import { readLedgerTail } from './usage-window.js';

const H = 3600000, MIN = 60000;
export const WINDOW_MS = 5 * H;

export const METER_DEFAULTS = {
  pollLoopCalls: 40, pollLoopMinutes: 10, pollLoopMaxNewTokens: 300,   // N calls in M minutes at under T new tokens per call
  sharePct: 40, shareMinCalls: 50,                                      // alert when one session passes sharePct of the window's calls (and the window has shareMinCalls)
};

// manager.json keys minimaxPollLoopCalls / ...Minutes / ...MaxNewTokens, minimaxSharePct, minimaxShareMinCalls
export function meterConfig(j = {}) {
  const c = { ...METER_DEFAULTS }, pos = (v) => (Number(v) > 0 ? Number(v) : null);
  c.pollLoopCalls = pos(j.minimaxPollLoopCalls) ?? c.pollLoopCalls;
  c.pollLoopMinutes = pos(j.minimaxPollLoopMinutes) ?? c.pollLoopMinutes;
  c.pollLoopMaxNewTokens = pos(j.minimaxPollLoopMaxNewTokens) ?? c.pollLoopMaxNewTokens;
  c.sharePct = pos(j.minimaxSharePct) ?? c.sharePct;
  c.shareMinCalls = pos(j.minimaxShareMinCalls) ?? c.shareMinCalls;
  return c;
}

// 'm3' | 'flash' | 'other' (a row without a model field is 'other', still counted as a call)
export const modelClass = (m) => (/flash/i.test(m || '') ? 'flash' : /m3/i.test(m || '') ? 'm3' : 'other');

// Start of the current 5h window: the plan's resetsAt (epoch seconds) minus 5 h; now - 5 h when the plan is unknown or its reset already passed.
export function windowStart(resetsAtSec, now) {
  const end = Number(resetsAtSec) * 1000;
  return Number.isFinite(end) && end > now ? end - WINDOW_MS : now - WINDOW_MS;
}

const empty = () => ({ calls: 0, newTokens: 0, cacheRead: 0, byModel: { m3: { calls: 0, newTokens: 0, cacheRead: 0 }, flash: { calls: 0, newTokens: 0, cacheRead: 0 }, other: { calls: 0, newTokens: 0, cacheRead: 0 } } });
function add(acc, r) {
  const u = r.usage || {}, nt = (u.input || 0) + (u.output || 0), cr = u.cache_read || 0;
  const m = acc.byModel[modelClass(r.model)];
  acc.calls++; acc.newTokens += nt; acc.cacheRead += cr;
  m.calls++; m.newTokens += nt; m.cacheRead += cr;
}

// rows -> { window, h24, sessions[] } for MiniMax rows only. Window = (wStart, now], h24 = (now - 24 h, now].
// A session is its label (the tmux name) and falls back to the session id; rows of the same name merge.
// -> sessions sorted by window calls, then 24 h calls: { name, window, h24, share (0-100 of window calls), top, manager, pollLoop }
export function aggregate(rows, { now = Date.now(), wStart, isManager = () => false, config = METER_DEFAULTS } = {}) {
  wStart = Number.isFinite(wStart) ? wStart : now - WINDOW_MS;
  const per = new Map(), tot = { window: empty(), h24: empty() };
  const loopFrom = now - config.pollLoopMinutes * MIN;
  for (const r of rows || []) {
    if (r?.agent !== 'minimax' || !Number.isFinite(r.ts) || r.ts > now || r.ts <= now - 24 * H) continue;
    const name = r.label || r.session || 'unknown';
    const s = per.get(name) || { name, window: empty(), h24: empty(), recent: { calls: 0, newTokens: 0 } };
    per.set(name, s);
    add(s.h24, r); add(tot.h24, r);
    if (r.ts > wStart) { add(s.window, r); add(tot.window, r); }
    if (r.ts > loopFrom) { s.recent.calls++; s.recent.newTokens += ((r.usage || {}).input || 0) + ((r.usage || {}).output || 0); }
  }
  const sessions = [...per.values()].sort((a, b) => (b.window.calls - a.window.calls) || (b.h24.calls - a.h24.calls));
  const wc = tot.window.calls;
  for (const s of sessions) {
    s.share = wc ? Math.round((s.window.calls / wc) * 1000) / 10 : 0;
    s.manager = !!isManager(s.name);
    s.pollLoop = s.recent.calls >= config.pollLoopCalls && s.recent.newTokens / s.recent.calls < config.pollLoopMaxNewTokens;
    s.top = false;
    delete s.recent.newTokens;
  }
  if (sessions[0]?.window.calls) sessions[0].top = true;
  return { window: { start: wStart, ...tot.window }, h24: tot.h24, sessions };
}

// Sessions that crossed the share threshold in this window and were not announced yet. `told` is a Set of `${wStart}:${name}`, updated here.
export function newShareAlerts(snap, config, told) {
  const out = [];
  if (!snap || snap.window.calls < config.shareMinCalls) return out;
  for (const s of snap.sessions) {
    const key = `${snap.window.start}:${s.name}`;
    if (s.share > config.sharePct && !told.has(key)) { told.add(key); out.push(s); }
  }
  return out;
}

// Cached snapshot over the ledger tail. quota: () => plan list (quota.get()); cfg: () => meterConfig; isManager: (name) => bool.
export function createMinimaxMeter({ ledgerFile, quota, config = () => METER_DEFAULTS, isManager = () => false, ttlMs = 20000, now = () => Date.now(), read = readLedgerTail } = {}) {
  let cached = null, at = 0;
  const resetsAt = () => {
    const p = (quota?.()?.plans || []).find((x) => x.plan === 'minimax');
    return p?.windows?.find((w) => w.name === '5h') || null;
  };
  return {
    snapshot() {
      const t = now();
      if (cached && t - at < ttlMs) return cached;
      const w = resetsAt();
      cached = { ...aggregate(read(ledgerFile), { now: t, wStart: windowStart(w?.resetsAt, t), isManager, config: config() }),
        plan: w ? { usedPercent: w.usedPercent ?? null, resetsAt: w.resetsAt ?? null } : null,
        note: 'The plan window appears to count model calls, not tokens: each call re-reads the whole cached context. Calls rank who uses the window; new tokens = input + output, cache = cache reads.',
        at: t };
      at = t;
      return cached;
    },
    // card chip: window calls and flags for one session name, or null
    forSession(name) {
      const s = this.snapshot().sessions.find((x) => x.name === name);
      return s ? { calls: s.window.calls, share: s.share, pollLoop: s.pollLoop, top: s.top } : null;
    },
    invalidate() { at = 0; },
  };
}
