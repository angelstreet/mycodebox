// Usage attribution shared by the integration lane, scripts/manager-run.js and scripts/v2-ledger.js (docs/v2/SCORING.md
// "Round 14b"): sums usage-ledger.jsonl rows inside a time window into model, runtime, tokens and cost. No price table
// here: cost is the row's own (usage/ingest.js priced it); an unpriced row stays unknown. A flat-plan model (registry
// billing "subscription", e.g. MiniMax) has no per-token cost: its cost is null with plan 'flat', never 0.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { readFileSync as readFile } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LEDGER_TAIL_BYTES = 16 * 1024 * 1024;   // a window is at most a day: the tail of the append-only ledger covers it

let flat = null;
// Runtimes/models whose registry billing is "subscription". The ledger's agent name equals the registry runtime.
export function flatPlan(agent, model) {
  if (!flat) {
    flat = { runtimes: new Set(), models: new Set() };
    // The registry file is read as data: server.js must load no V2 module statically (T16). Billing defaults by runtime as in model-registry.js.
    try {
      for (const e of JSON.parse(readFile(fileURLToPath(new URL('./orchestration/models.json', import.meta.url)), 'utf8')).models) {
        if ((e.billing ?? (e.runtime === 'minimax' ? 'subscription' : null)) === 'subscription') { flat.runtimes.add(e.runtime); flat.models.add(e.model); }
      }
    } catch { /* no registry: nothing is flat */ }
  }
  return flat.models.has(model) || flat.runtimes.has(agent);
}

// Parsed rows of the ledger's last `bytes`, or [] when the file is missing. Sync: callers are rare, one-shot events.
export function readLedgerTail(file, bytes = LEDGER_TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1);
    const out = [];
    for (const l of text.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn */ } }
    return out;
  } catch { return []; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* */ } }
}

// Dominant model/agent (by cost, then tokens) plus summed tokens and cost of the rows inside (from, to]; null with no rows.
// -> { agent, model, tokens (in+out+cache), tokensIn, tokensOut, costUsd (null = unknown or flat plan), plan: 'flat'|null, rows }
export function attribute(rows, from, to) {
  const m = new Map(); let cost = 0, priced = false, tokIn = 0, tokOut = 0, tokCache = 0, n = 0;
  for (const r of rows || []) {
    if (!Number.isFinite(r.ts) || r.ts <= from || r.ts > to) continue;
    n++;
    const u = r.usage || {}, cache = (u.cache_read || 0) + (u.cache_write_5m || 0) + (u.cache_write_1h || 0);
    tokIn += u.input || 0; tokOut += u.output || 0; tokCache += cache;
    const isFlat = flatPlan(r.agent, r.model);
    const c = !isFlat && r.cost && Number.isFinite(r.cost.total) ? r.cost.total : 0;
    if (c > 0) { cost += c; priced = true; }
    const key = `${r.agent || 'unknown'}\t${r.model || 'unknown'}`;
    const e = m.get(key) || { w: 0 }; e.w += c * 1e6 + (u.input || 0) + (u.output || 0) + cache; m.set(key, e);
  }
  if (!n) return null;
  const [agent, model] = [...m.entries()].sort((a, b) => b[1].w - a[1].w)[0][0].split('\t');
  const isFlat = flatPlan(agent, model);
  return { agent, model, tokens: tokIn + tokOut + tokCache, tokensIn: tokIn, tokensOut: tokOut, costUsd: priced ? cost : null, plan: isFlat && !priced ? 'flat' : null, rows: n };
}

// True when `row`'s working directory sits inside `wt`. Subagent rows carry workCwd (the directory the
// subagent tool actually ran in); `cwd` is the parent session's folder and is only used when workCwd is absent.
export function rowCwdMatchesWorktree(row, wt) {
  if (!row || !wt) return false;
  const c = row.workCwd || row.cwd;
  return !!(c && (c === wt || c.startsWith(`${wt}/`)));
}
