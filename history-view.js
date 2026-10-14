// GET /api/history: one row per session instance (session-history.js) joined with the usage ledger.
// Join: a ledger row belongs to an instance when its `label` equals the session name (V2 runs: its `cwd` equals the
// run's worktree) and its ts is inside [start, end) (end exclusive, so a superseded end is not double counted). The
// ledger is read incrementally (no day cap).
// active_ms = sum of the gaps between consecutive turns of the instance, each gap capped at ACTIVE_GAP_CAP_MS (5 min),
// so idle waiting does not count. Unknown stays null: no turns -> tokens/cost null; any unpriced turn -> cost null.
import { promises as fsp } from 'node:fs';

export const ACTIVE_GAP_CAP_MS = 5 * 60000;
const SUBSCRIPTION = new Set(['minimax', 'mcode']);   // flat-rate plans: per-token cost is not meaningful
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// Incremental: the ledger is append-only, so only bytes past the last complete line are read (async). A shrunk file, a new
// inode or a changed first 128 bytes (the tailer compacts it in place) means a full reread. Rows are deduped by id, last
// wins (the tailer re-appends a larger record under an existing id); the per-label/cwd lists are rebuilt when that happens.
export function createLedgerIndex(file) {
  let ino = null, offset = 0, head = '', rows = new Map(), byLabel = new Map(), byCwd = new Map(), busy = Promise.resolve();
  const reset = () => { rows = new Map(); byLabel = new Map(); byCwd = new Map(); offset = 0; head = ''; };
  const index = () => {
    byLabel = new Map(); byCwd = new Map();
    for (const row of rows.values()) {
      if (row.label) (byLabel.get(row.label) || byLabel.set(row.label, []).get(row.label)).push(row);
      if (row.cwd) (byCwd.get(row.cwd) || byCwd.set(row.cwd, []).get(row.cwd)).push(row);
    }
    for (const m of [byLabel, byCwd]) for (const l of m.values()) l.sort((a, b) => a.ts - b.ts);
  };
  async function refresh() {
    let st; try { st = await fsp.stat(file); } catch { reset(); ino = null; index(); return; }
    const fh = await fsp.open(file, 'r');
    try {
      if (st.ino !== ino || st.size < offset) { reset(); ino = st.ino; }
      else if (offset > 0) {
        const hb = Buffer.alloc(Math.min(128, offset)); await fh.read(hb, 0, hb.length, 0);
        if (hb.toString('latin1') !== head.slice(0, hb.length)) reset();
      }
      if (st.size === offset) return;
      const buf = Buffer.alloc(st.size - offset); const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const text = buf.subarray(0, bytesRead);
      const nl = text.lastIndexOf(10);
      if (nl < 0) return;   // no complete line yet
      if (offset === 0) head = text.toString('latin1', 0, Math.min(128, nl + 1));
      offset += nl + 1;
      for (const line of text.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r || !r.usage || !Number.isFinite(r.ts)) continue;
        const u = r.usage;
        rows.set(r.id ?? `${r.ts}:${rows.size}`, { ts: r.ts, label: r.label || null, cwd: r.cwd || null, agent: r.agent || null, model: r.model || null, input: u.input || 0, output: u.output || 0,
          cache_read: u.cache_read || 0, cache_write: (u.cache_write_5m || 0) + (u.cache_write_1h || 0), cost: r.cost && Number.isFinite(r.cost.total) ? r.cost.total : null });
      }
      index();
    } finally { await fh.close(); }
  }
  return async function get() {
    const run = busy.then(refresh);
    busy = run.catch(() => {});   // one failed refresh must not poison later calls
    await run;
    return { byLabel, byCwd };
  };
}

export function summarize(inst, led, nowMs) {
  const end = inst.end ?? Infinity;
  const pool = inst.started_by === 'v2' ? (inst.cwd ? led.byCwd.get(inst.cwd) : null) : led.byLabel.get(inst.name);
  const mine = (pool || []).filter((r) => r.ts >= inst.start && r.ts < end);
  const tokens = mine.length ? mine.reduce((t, r) => ({ input: t.input + r.input, output: t.output + r.output, cache_read: t.cache_read + r.cache_read, cache_write: t.cache_write + r.cache_write }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 }) : null;
  let active = 0;
  for (let i = 1; i < mine.length; i++) active += Math.min(mine[i].ts - mine[i - 1].ts, ACTIVE_GAP_CAP_MS);
  const sub = SUBSCRIPTION.has(inst.provider) || (mine.length > 0 && mine.every((r) => SUBSCRIPTION.has(r.agent)));
  const priced = mine.length > 0 && mine.every((r) => r.cost != null);
  const cost = sub || !priced ? null : r6(mine.reduce((a, r) => a + r.cost, 0));
  const days = new Map();
  for (const r of mine) {
    const d = days.get(day(r.ts)) || days.set(day(r.ts), { day: day(r.ts), turns: 0, tokens: 0, cost_usd: 0, unpriced: false }).get(day(r.ts));
    d.turns++; d.tokens += r.input + r.output + r.cache_read + r.cache_write;
    if (r.cost == null) d.unpriced = true; else d.cost_usd += r.cost;
  }
  const counts = new Map(); for (const r of mine) if (r.model) counts.set(r.model, (counts.get(r.model) || 0) + 1);
  const seen = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    name: inst.name, provider: inst.provider, model: inst.model ?? seen, started_by: inst.started_by, cwd: inst.cwd, prompt_ref: inst.prompt_ref,
    handover_ref: inst.handover_ref, remote_control_url: inst.remote_control_url, start: inst.start, end: inst.end,
    elapsed_ms: Math.max(0, (inst.end ?? nowMs) - inst.start), active_ms: mine.length ? active : null, turns: mine.length, tokens,
    billing: sub ? 'subscription' : 'metered', cost_usd: cost,
    days: [...days.values()].map((d) => ({ day: d.day, turns: d.turns, tokens: d.tokens, cost_usd: sub || d.unpriced ? null : r6(d.cost_usd) })),
  };
}

const tsParam = (v) => { if (v == null || v === '') return null; const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); return Number.isFinite(n) ? n : NaN; };

export function createHistoryView({ history, ledgerFile, now = Date.now }) {
  const ledger = createLedgerIndex(ledgerFile);
  async function list(q = {}) {
    const from = tsParam(q.from), to = tsParam(q.to);
    if (Number.isNaN(from) || Number.isNaN(to)) throw Object.assign(new Error('from/to must be ms or ISO date'), { status: 400 });
    if (q.status && !['running', 'ended'].includes(q.status)) throw Object.assign(new Error('status must be running|ended'), { status: 400 });
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50)), offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
    const led = await ledger(), t = now();
    const all = history.instances().map((i) => summarize(i, led, t));
    const rows = all.filter((r) => (!q.provider || r.provider === q.provider) && (!q.model || r.model === q.model) && (!q.started_by || r.started_by === q.started_by)
      && (from == null || r.start >= from) && (to == null || r.start <= to) && (!q.status || (q.status === 'running') === (r.end == null)))
      .sort((a, b) => b.start - a.start);
    return { ok: true, total: rows.length, offset, limit, sessions: rows.slice(offset, offset + limit) };
  }
  async function detail(name, start) {
    const l = history.instances().filter((i) => i.name === name);
    const inst = start != null && start !== '' ? l.find((i) => i.start === Number(start)) : l[l.length - 1];
    return inst ? summarize(inst, await ledger(), now()) : null;
  }
  return { list, detail };
}
