// Token waste detectors, per-account split and burn-vs-limit view over usage ledger rows (owner 2026-11-28: "where do the tokens go,
// what is waste"). Pure functions: rows in, findings out. Nothing here changes a session; findings are for the manager / owner.
//
// A row: { agent, session, label, model, ts, subagent, usage:{input,output,cache_read,cache_write_5m,cache_write_1h}, cost:{total}|null }.
// "context" of a call = input + cache_read + cache writes (what the model had to read), the number the plans burn on.

const H = 3600000;
export const WASTE_DEFAULTS = {
  windowH: 48,
  minTurns: 30,                 // a session needs this many calls in the window to be judged
  avgCtx: 300e3,                // avg context per call above this = a session that should be restarted / compacted
  hitBelow: 0.90,               // cache hit (read / (read + write + input)) below this, with at least cacheMinWrite written
  cacheMinWrite: 300e3,
  churnWrite: 3e6,              // cache_creation tokens in the window at or above this = churn (context re-written, not re-read)
  subShare: 0.5, subMinCtx: 100e6,   // subagents read at least this share of the session's context, and this much in total
  pollMaxOut: 150, pollMinCtx: 100e3, pollShare: 0.2,   // calls under pollMaxOut output tokens on a big context: idle polling
  cheapMaxOut: 150, cheapMinShare: 0.15, cheapMinCost: 5,   // Opus / Fable calls this small are Sonnet/Haiku work
};

export const ctxOf = (r) => { const u = r.usage || {}; return (u.input || 0) + (u.cache_read || 0) + (u.cache_write_5m || 0) + (u.cache_write_1h || 0); };
const writeOf = (r) => (r.usage?.cache_write_5m || 0) + (r.usage?.cache_write_1h || 0);
const costOf = (r) => r.cost?.total || 0;
const nameOf = (r) => r.label || String(r.session || '').slice(0, 8);
const isBig = (m) => /opus|fable/i.test(m || '');
const r1 = (x) => Math.round(x * 10) / 10;

// session -> [{account, at}] (ascending). The account a Claude session ran on at time ts: the latest entry at or before ts, else the first.
export function accountAt(map, session, ts) {
  const h = map?.[session];
  if (!h?.length) return null;
  let a = h[0].account;
  for (const e of h) { if (e.at <= ts) a = e.account; else break; }
  return a;
}

// Fold one scan of the live sessions (sessionId -> account) into the history. A swap appends an entry; a repeat does nothing.
export function foldAccounts(map, seen, now) {
  const out = { ...map };
  for (const [sid, account] of Object.entries(seen)) {
    if (!account) continue;
    const h = out[sid] || [];
    if (!h.length || h[h.length - 1].account !== account) out[sid] = [...h, { account, at: now }];
  }
  return out;
}

export function accountOfRow(r, map) {
  if (r.agent === 'claude') return accountAt(map, r.session, r.ts) || 'unknown';
  return r.agent;   // codex / minimax / manager judge: one login each
}

export function buildWaste(records, now, opts = {}, accountMap = {}) {
  const o = { ...WASTE_DEFAULTS, ...opts };
  const since = now - o.windowH * H;
  const rows = records.filter((r) => r.ts >= since && r.ts <= now + H && r.agent !== 'manager');
  const perAccount = {}, bySession = new Map(), hourly = new Map();
  for (const r of rows) {
    const c = ctxOf(r), acc = accountOfRow(r, accountMap);
    const pa = perAccount[acc] || (perAccount[acc] = { turns: 0, context: 0, cost: 0, cacheWrite: 0, subagentContext: 0 });
    pa.turns++; pa.context += c; pa.cost += costOf(r); pa.cacheWrite += writeOf(r); if (r.subagent) pa.subagentContext += c;
    const hk = `${Math.floor(r.ts / H)}|${acc}`;
    const h = hourly.get(hk) || { hour: Math.floor(r.ts / H) * H, account: acc, turns: 0, context: 0, cost: 0 };
    h.turns++; h.context += c; h.cost += costOf(r); hourly.set(hk, h);
    const key = `${r.agent}|${r.session}`;
    let s = bySession.get(key);
    if (!s) bySession.set(key, s = { trace: r.trace, agent: r.agent, session: nameOf(r), account: acc, turns: 0, ctx: 0, write: 0, read: 0, input: 0, subCtx: 0, cost: 0, polls: 0, pollCtx: 0, cheap: 0, cheapCost: 0, models: new Set() });
    s.account = acc; s.turns++; s.ctx += c; s.write += writeOf(r); s.read += r.usage?.cache_read || 0; s.input += r.usage?.input || 0; s.cost += costOf(r); s.models.add(r.model);
    if (r.subagent) s.subCtx += c;
    const out = r.usage?.output || 0;
    if (out < o.pollMaxOut && c >= o.pollMinCtx) { s.polls++; s.pollCtx += c; }
    if (isBig(r.model) && out < o.cheapMaxOut) { s.cheap++; s.cheapCost += costOf(r); }
  }
  const findings = [];
  const add = (kind, s, value, detail, tokens) => findings.push({ kind, id: s.trace, session: s.session, agent: s.agent, account: s.account, value, detail, tokens: Math.round(tokens), cost: Math.round(s.cost * 100) / 100 });
  for (const s of bySession.values()) {
    if (s.turns < o.minTurns) continue;
    const avg = s.ctx / s.turns, hit = s.read / Math.max(1, s.read + s.write + s.input);
    if (avg > o.avgCtx) add('high-avg-context', s, Math.round(avg), `avg context ${Math.round(avg / 1e3)}k per call over ${s.turns} calls (limit ${o.avgCtx / 1e3}k): compact or restart the session`, s.ctx);
    if (hit < o.hitBelow && s.write >= o.cacheMinWrite) add('low-cache-hit', s, r1(hit * 100), `cache hit ${r1(hit * 100)}% (below ${o.hitBelow * 100}%), ${r1(s.write / 1e6)}M tokens written: the context is being re-sent, not re-read`, s.write);
    if (s.write >= o.churnWrite) add('cache-churn', s, Math.round(s.write), `${r1(s.write / 1e6)}M cache_creation tokens in ${o.windowH} h (${r1((s.write / s.ctx) * 100)}% of its context)`, s.write);
    if (s.subCtx >= o.subMinCtx && s.subCtx / s.ctx >= o.subShare) add('subagent-heavy', s, r1((s.subCtx / s.ctx) * 100), `subagents read ${r1(s.subCtx / 1e6)}M of ${r1(s.ctx / 1e6)}M context tokens (${r1((s.subCtx / s.ctx) * 100)}%)`, s.subCtx);
    if (s.polls / s.turns >= o.pollShare) add('idle-polling', s, r1((s.polls / s.turns) * 100), `${s.polls} of ${s.turns} calls wrote under ${o.pollMaxOut} tokens on a ${Math.round(s.pollCtx / s.polls / 1e3)}k context (${r1(s.pollCtx / 1e6)}M tokens re-read for almost nothing)`, s.pollCtx);
    if (s.cheap / s.turns >= o.cheapMinShare && s.cheapCost >= o.cheapMinCost) add('expensive-model-cheap-work', s, r1((s.cheap / s.turns) * 100), `${s.cheap} Opus/Fable calls under ${o.cheapMaxOut} output tokens cost $${Math.round(s.cheapCost)}: Sonnet/Haiku work`, s.cheapCost * 1e3);
  }
  findings.sort((a, b) => b.tokens - a.tokens);
  const pr = (x) => ({ ...x, context: Math.round(x.context), cost: Math.round(x.cost * 100) / 100 });
  const totalCtx = Object.values(perAccount).reduce((n, a) => n + a.context, 0) || 1;
  return {
    windowH: o.windowH,
    perAccount: Object.fromEntries(Object.entries(perAccount).map(([k, v]) => [k, { ...pr(v), share: r1((v.context / totalCtx) * 100) }]).sort((a, b) => b[1].context - a[1].context)),
    hourly: [...hourly.values()].sort((a, b) => a.hour - b.hour || a.account.localeCompare(b.account)).map(pr),
    findings,
    counts: findings.reduce((m, f) => { m[f.kind] = (m[f.kind] || 0) + 1; return m; }, {}),
    thresholds: { avgCtx: o.avgCtx, hitBelow: o.hitBelow, churnWrite: o.churnWrite, subShare: o.subShare, pollShare: o.pollShare },
  };
}

// Burn vs plan limit. limits: { <account>: { five_hour?:{used_percentage,resets_at}, seven_day?:{...} } } (resets_at in epoch seconds).
// Average burn = used% / hours since the window opened (resets_at - window length); eta = hours until 100% at that rate. It only
// says "at the average pace of this window"; `recentPerHour` (cost of the last 3 h / 3) is the live pace for comparison.
const WINDOW_H = { five_hour: 5, seven_day: 168 };
export function burnVsLimit(limits, hourly, now) {
  const out = [];
  for (const [account, lim] of Object.entries(limits || {})) {
    for (const [name, w] of Object.entries(lim || {})) {
      if (!WINDOW_H[name] || !w || !Number.isFinite(w.used_percentage) || !Number.isFinite(w.resets_at)) continue;
      const resetMs = w.resets_at * 1000, startMs = resetMs - WINDOW_H[name] * H;
      if (resetMs <= now) { out.push({ account, window: name, usedPct: w.used_percentage, resetsAt: resetMs, stale: true }); continue; }
      const elapsedH = Math.max(0.25, (now - startMs) / H), rate = w.used_percentage / elapsedH;
      const etaH = rate > 0 ? Math.max(0, (100 - w.used_percentage) / rate) : null;
      const leftH = (resetMs - now) / H;
      const recent = (hourly || []).filter((h) => h.account === account && h.hour >= now - 3 * H).reduce((n, h) => n + h.cost, 0) / 3;
      out.push({ account, window: name, usedPct: w.used_percentage, resetsAt: resetMs, avgPctPerHour: r1(rate), etaHours: etaH == null ? null : r1(etaH), hoursToReset: r1(leftH), hitsBeforeReset: etaH != null && etaH < leftH, recentCostPerHour: Math.round(recent * 100) / 100 });
    }
  }
  return out;
}

// One line for the scorecard / daily report.
export function wasteLine(w, loops = []) {
  if (!w) return 'waste: no data';
  const lp = loops.filter((l) => l.kind !== 'wait-loop').length;
  const top = w.findings.slice(0, 3).map((f) => `${f.session} ${f.kind}`).join(', ');
  const n = w.findings.length;
  const parts = Object.entries(w.counts).map(([k, v]) => `${v} ${k}`).join(', ');
  const tail = lp ? `; ${lp} test/command loop${lp === 1 ? '' : 's'}` : '';
  return n ? `waste (${w.windowH} h): ${n} finding${n === 1 ? '' : 's'} (${parts}); top: ${top}${tail}` : `waste (${w.windowH} h): none${tail}`;
}

// Rate-limit files -> { account: rate_limits }: claude-rate-limits.json (default), claude-rate-limits.<id>.json, minimax-rate-limits.json.
export async function readLimits(stateDir, fs, join) {
  const out = {};
  let names = [];
  try { names = await fs.readdir(stateDir); } catch { return out; }
  for (const n of names) {
    const m = n.match(/^claude-rate-limits(?:\.([a-z0-9_-]+))?\.json$/) || n.match(/^(minimax)-rate-limits\.json$/);
    if (!m) continue;
    try { const j = JSON.parse(await fs.readFile(join(stateDir, n), 'utf8')); if (j?.rate_limits) out[n.startsWith('minimax') ? 'minimax' : (m[1] || 'default')] = j.rate_limits; } catch { /* half-written */ }
  }
  return out;
}
