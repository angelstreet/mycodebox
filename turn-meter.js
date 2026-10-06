// Per-turn meter: what a finished turn cost in wall time and tokens, shown next to the agent's own STATUS line.
//   STATUS: done · 4m 01s · 1.3M tok · branch x pushed (abc123), tsc+lint pass, left: 23 tables
// An agent cannot measure its own tokens or time, so ghosty does. A value that cannot be known is left out, never guessed.
//
// Sources:
//   Claude (reporter plugin): elapsed = prompt received -> turn end; tokens = the turn.complete usage (the API's own counts).
//   Codex / MiniMax (no hooks): elapsed = last owner/manager send -> the moment ghosty saw the stop;
//     tokens = usage ledger rows (usage-ledger.jsonl) labelled with the tmux session, dated inside that window.
//     The ledger is written by the usage tailer a few seconds after the model call: a stop seen sooner may undercount.
import { promises as fs } from 'node:fs';
import { statusLine, closingLines } from './stall.js';

export const INFO_MAX = 200;
export const LEDGER_TAIL_BYTES = 2 * 1024 * 1024;
const RECOMPUTE_MS = 2 * 60 * 1000;   // ledger rows trail the stop: a turn's tokens are re-read for this long after it
const SLACK_MS = 5000;                // a model call is dated when it finished, which can be just after the stop was seen

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

// { in, out, cacheRead, cacheWrite, total } from the reporter's usage ({input_tokens, ...}) or a ledger usage ({input, ...}).
// null when it holds no count at all.
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const inn = num(u.input_tokens ?? u.input), out = num(u.output_tokens ?? u.output);
  const cacheRead = num(u.cache_read_input_tokens ?? u.cache_read);
  const cacheWrite = u.cache_creation_input_tokens !== undefined ? num(u.cache_creation_input_tokens) : num(u.cache_write_5m) + num(u.cache_write_1h);
  const total = inn + out + cacheRead + cacheWrite;
  return total > 0 ? { in: inn, out, cacheRead, cacheWrite, total } : null;
}

export function addTokens(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { in: a.in + b.in, out: a.out + b.out, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total };
}

// Sum of the ledger rows of one tmux session label dated in [from, to]. null when no row falls inside.
export function ledgerTokens(rows, label, from, to) {
  let acc = null;
  for (const r of rows) {
    if (!r || r.label !== label || !(r.ts >= from && r.ts <= to)) continue;
    acc = addTokens(acc, normalizeUsage(r.usage));
  }
  return acc;
}

// 4m 01s, 45s, 1h 02m. null for an unknown or negative duration.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// 1.3M tok, 812k tok, 950 tok. null for an unknown count.
export function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k tok`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k tok`;
  return `${Math.round(n)} tok`;
}

export const clipInfo = (text) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > INFO_MAX ? `${t.slice(0, INFO_MAX - 1)}…` : t;
};

// The one line. Needs a verdict (null without one); every other part is left out when unknown.
export function statusMeterLine({ status, elapsedMs, tokens, info } = {}) {
  if (!status) return null;
  const parts = [`STATUS: ${status}`, formatDuration(elapsedMs), formatTokens(tokens?.total), clipInfo(info)].filter(Boolean);
  return parts.join(' · ');
}

// The agent's own verdict of the closing text: { status, info } or null. `lines` = closing lines (blank ones are dropped).
export function verdictOf(lines) {
  const st = statusLine((lines || []).filter((l) => String(l).trim()));
  return st ? { status: st.kind, info: clipInfo(st.text) } : null;
}

// The status payload / event field: { at, elapsedMs, tokens, status, info, line, source } or null when nothing is known.
export function buildLastTurn({ at, elapsedMs, tokens, verdict, source }) {
  const status = verdict?.status || null, info = verdict?.info || null;
  const e = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : null;
  const tk = tokens && tokens.total > 0 ? tokens : null;
  if (e == null && !tk && !status) return null;
  return { at: at ?? null, elapsedMs: e, tokens: tk, status, info, line: statusMeterLine({ status, elapsedMs: e, tokens: tk, info }), source };
}

export function createTurnMeter({ ledgerFile, now = () => Date.now(), ttlMs = 10000 } = {}) {
  let rows = [], loadedAt = 0, inflight = null;
  const turns = new Map();   // session -> { stopAt, lastTurn }

  async function load() {
    try {
      const fh = await fs.open(ledgerFile, 'r');
      try {
        const { size } = await fh.stat();
        const len = Math.min(size, LEDGER_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        let text = buf.toString('utf8');
        if (size > len) text = text.slice(text.indexOf('\n') + 1);
        rows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } finally { await fh.close(); }
    } catch { rows = []; }
    loadedAt = now();
  }
  // Re-read the ledger tail at most every ttlMs; never throws.
  const refresh = () => (now() - loadedAt < ttlMs ? Promise.resolve() : (inflight ||= load().finally(() => { inflight = null; })));

  // One poll of one stopped session (state done / waiting). Sync: call refresh() once per poll before.
  //   agent 'claude' with `claude` = reporter.meterOf(name) -> { endAt, elapsedMs, tokens, text }
  //   other agents: sentAt (last owner/manager send), stopAt (when the stop was first seen; null when it predates ghosty)
  //   plain = pane lines (the verdict source when there is no reporter text)
  function compute({ name, agent, sentAt = null, stopAt = null, claude = null, plain = [] }) {
    const t = now();
    const prev = turns.get(name);
    const key = claude ? `c${claude.endAt}` : `p${stopAt}|${sentAt}`;
    // the verdict is cheap and the pane may still change: always re-read; the metering is frozen once the ledger had time to settle
    const reported = claude?.text ? String(claude.text).split('\n') : null;
    const verdict = verdictOf(reported || closingLines(plain, 16));
    let m;
    if (claude) {
      m = { at: claude.endAt, elapsedMs: claude.elapsedMs, tokens: claude.tokens, source: 'reporter' };
    } else if (agent !== 'claude' && stopAt && sentAt && stopAt >= sentAt) {
      if (prev && prev.key === key && t - stopAt > RECOMPUTE_MS) m = prev.m;
      else m = { at: stopAt, elapsedMs: stopAt - sentAt, tokens: ledgerTokens(rows, name, sentAt, stopAt + SLACK_MS), source: 'ledger' };
    } else m = null;
    const lastTurn = m || verdict ? buildLastTurn({ at: m?.at ?? null, elapsedMs: m?.elapsedMs, tokens: m?.tokens, verdict, source: m?.source ?? null }) : null;
    turns.set(name, { key, m, lastTurn });
    return lastTurn;
  }

  return { refresh, compute, get: (name) => turns.get(name)?.lastTurn ?? null, forget: (name) => turns.delete(name), prune: (live) => { for (const k of [...turns.keys()]) if (!live.has(k)) turns.delete(k); } };
}
