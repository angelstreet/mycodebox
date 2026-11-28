#!/usr/bin/env node
// The token audit's figures for any time window, from usage-ledger.jsonl (read-only, no model call). Method and traps:
// docs/TOKEN-AUDIT.md. The output names sessions and costs: keep it out of this public repo.
//   node scripts/token-audit.js --window FROM,TO [--window FROM,TO ...] [--ledger FILE]   (ISO times, UTC; default: last 48 h)
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ledgerLines } from '../usage/ingest.js';
import { buildWaste, ctxOf } from '../usage/waste.js';

const H = 3600000;
const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
const cost = (r) => r.cost?.total || 0;
const out = (r) => r.usage?.output || 0;
const hit = (rows) => pct(sum(rows, (r) => r.usage?.cache_read || 0), sum(rows, ctxOf));
const p95 = (rows) => { const a = rows.map(ctxOf).sort((x, y) => x - y); return a.length ? a[Math.ceil(a.length * 0.95) - 1] : 0; };
const k = (n) => `${Math.round(n / 1e3)}k`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
const table = (heads, rows) => [`| ${heads.join(' | ')} |`, `|${'---|'.repeat(heads.length)}`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// The rows the audit counts: from <= ts < to, no manager bookkeeping rows, no errors, one row per id (the last wins).
export function windowRows(all, from, to) {
  const byId = new Map();
  for (const r of all) if (r.ts >= from && r.ts < to && r.agent !== 'manager' && !r.error) byId.set(r.id, r);
  return [...byId.values()];
}

export function metrics(rows, from, to) {
  const hours = (to - from) / H;
  const cl = rows.filter((r) => r.agent === 'claude'), mm = rows.filter((r) => r.agent === 'minimax');
  const big = cl.filter((r) => /opus|fable/i.test(r.model || ''));
  const ctx = sum(cl, ctxOf), c = sum(cl, cost);
  return {
    'Claude calls per hour': (cl.length / hours).toFixed(0),
    'Context M tokens per hour': (ctx / 1e6 / hours).toFixed(1),
    'Avg context per call': k(cl.length ? ctx / cl.length : 0),
    'p95 context per call': k(p95(cl)),
    'Calls above 300k': pct(cl.filter((r) => ctxOf(r) > 300e3).length, cl.length),
    'Cache hit': hit(cl),
    'Subagent share of context': pct(sum(cl.filter((r) => r.subagent), ctxOf), ctx),
    'Tiny turns (<150 out) of Opus/Fable calls': pct(big.filter((r) => out(r) < 150).length, big.length),
    'API-equivalent cost per hour': `$${(c / hours).toFixed(1)}`,
    'Fable share of cost': pct(sum(cl.filter((r) => /fable/i.test(r.model || '')), cost), c),
    'Manager-labelled calls per hour': (cl.filter((r) => /manager/i.test(r.label || '')).length / hours).toFixed(0),
    'MiniMax calls per hour': (mm.length / hours).toFixed(0),
    'MiniMax calls under 150 out': pct(mm.filter((r) => out(r) < 150).length, mm.length),
  };
}

function grouped(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const id = key(r);
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(r);
  }
  return [...m].map(([id, a]) => ({ id, a, cost: sum(a, cost), ctx: sum(a, ctxOf) })).sort((x, y) => y.cost - x.cost || y.ctx - x.ctx);
}

export function report(all, windows) {
  const sets = windows.map(([from, to]) => ({ from, to, rows: windowRows(all, from, to) }));
  const title = (s) => `${new Date(s.from).toISOString().slice(0, 16)} to ${new Date(s.to).toISOString().slice(0, 16)}`;
  const values = sets.map((s) => metrics(s.rows, s.from, s.to));
  const parts = ['# Token audit', '## Windows compared (UTC; Claude unless named)',
    table(['Metric', ...sets.map(title)], Object.keys(values[0]).map((name) => [name, ...values.map((v) => v[name])]))];
  for (const s of sets) {
    parts.push(`## ${title(s)}: ${s.rows.length} calls`, '### Per agent and model',
      table(['agent / model', 'calls', 'context', 'avg', 'p95', 'cache hit', 'cost'], grouped(s.rows, (r) => `${r.agent} / ${r.model}`)
        .map((g) => [g.id, g.a.length, M(g.ctx), k(g.ctx / g.a.length), k(p95(g.a)), hit(g.a), `$${g.cost.toFixed(0)}`])),
      '### Top 10 sessions (by cost, then context)',
      table(['session', 'calls', 'avg context', 'subagent share', 'cache hit', 'cost'], grouped(s.rows, (r) => r.label || String(r.session || '').slice(0, 8))
        .slice(0, 10).map((g) => [g.id, g.a.length, k(g.ctx / g.a.length), pct(sum(g.a.filter((r) => r.subagent), ctxOf), g.ctx), hit(g.a), `$${g.cost.toFixed(0)}`])));
    const found = buildWaste(s.rows, s.to, { windowH: (s.to - s.from) / H }).findings;
    parts.push(`### Waste findings (usage/waste.js thresholds): ${found.length}`, found.map((f) => `- ${f.kind} · ${f.session} · ${f.detail}`).join('\n') || 'none');
  }
  return parts.join('\n\n');
}

export function parseWindow(text) {
  const [from, to] = String(text).split(',').map((t) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) || t.length === 10 ? t : `${t}Z`));
  if (!(to > from)) throw new Error(`bad --window "${text}" (want FROM,TO)`);
  return [from, to];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2), windows = [];
  let ledger = path.join(process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local/state/ghosty'), 'usage-ledger.jsonl');
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--window') windows.push(parseWindow(argv[i + 1]));
    else if (argv[i] === '--ledger') ledger = argv[i + 1];
    else { console.error('usage: token-audit.js [--window FROM,TO ...] [--ledger FILE]'); process.exit(2); }
  }
  if (!windows.length) windows.push([Date.now() - 48 * H, Date.now()]);
  const first = Math.min(...windows.map((w) => w[0])), last = Math.max(...windows.map((w) => w[1])), rows = [];
  for await (const line of ledgerLines(ledger)) {
    try {
      const r = JSON.parse(line);
      if (r.ts >= first && r.ts < last) rows.push(r);
    } catch { /* torn line */ }
  }
  if (!rows.length) { console.error(`no ledger rows in these windows (${ledger})`); process.exit(1); }
  console.log(report(rows, windows));
}
