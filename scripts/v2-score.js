#!/usr/bin/env node
// Read-only scoring report over the V2 task store (OWNER_DECISIONS §8; docs/v2/SCORING.md). Per model and per runtime:
// verified completion rate, cost per verified completion, median latency, rework count. It reads the per-task
// event logs and never writes, recovers or repairs anything. Unknown stays unknown: a missing price is null, never $0.
//
//   node scripts/v2-score.js [--store DIR] [--since ISO] [--json]
//
// Default store: $GHOSTY_STATE_DIR/v2 (or ~/.local/state/ghosty/v2). No self-modification: the output is data; the router
// only sees it if a human passes `router_history` to route({ history }).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStoreDir } from '../orchestration/store.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REWORK_STATES = ['repair', 'replan'];

// Valid lines up to the first torn or corrupt one. A corrupt line before the tail makes the task unreadable (excluded and
// listed), the same stance as the store: do not score what cannot be replayed.
function readLog(path) {
  const buf = readFileSync(path);
  const end = buf.lastIndexOf(0x0a) + 1;   // after the last newline is a torn, unacknowledged write
  const lines = buf.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try { const e = JSON.parse(lines[i]); if (!e || typeof e.kind !== 'string' || !Number.isInteger(e.seq)) throw new Error('shape'); events.push(e); }
    catch { return { events, corrupt: i + 1 }; }
  }
  return { events, corrupt: null };
}

const splitEntry = (id) => { const s = String(id || ''); const i = s.indexOf(':'); return i > 0 ? { runtime: s.slice(0, i), model: s.slice(i + 1) } : { runtime: 'unknown', model: s || 'unknown' }; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// One task -> a flat fact record, or null when the log has no task.created.
export function foldTask(events) {
  const created = events.find((e) => e.kind === 'task.created');
  if (!created?.payload?.task) return null;
  const f = { task_id: created.task_id, status: created.payload.task.status, created_at: created.timestamp, info: created.payload.task.review_policy?.mode === 'informational',
    completed_at: null, head_sha: null, producers: new Map(), usage: [], rework: 0, last_actor: null };
  for (const e of events) {
    const p = e.payload || {};
    if (['task.transitioned', 'task.completed', 'task.cancelled'].includes(e.kind) && typeof p.to === 'string') {
      f.status = p.to;
      if (p.to === 'accepted') f.completed_at = e.timestamp;
      if (REWORK_STATES.includes(p.to)) f.rework += 1;
    } else if (e.kind === 'task.head_changed') {
      if (p.sha !== f.head_sha) f.head_sha = p.sha;
      const id = typeof p.actor === 'string' ? p.actor : p.actor?.id;
      if (typeof id === 'string' && id) f.producers.set(p.sha, id);   // the last developer recorded for that SHA
      if (id) f.last_actor = id;
    } else if (e.kind === 'usage.recorded') {
      f.usage.push({ runtime: p.runtime ?? null, model: p.model ?? null, usd: Number.isFinite(p.usd) ? p.usd : null, input_tokens: p.input_tokens ?? null, output_tokens: p.output_tokens ?? null });
    }
  }
  return f;
}

// Who gets the credit (or the blame): the developer that produced the accepted head; for a failed task the last developer
// recorded, else the last model that ran, else unknown. Exactly one group per settled task, so rates never double count.
export function creditOf(f) {
  const id = (f.status === 'accepted' && f.producers.get(f.head_sha)) || f.last_actor;
  if (id) return { ...splitEntry(id), basis: 'developer' };
  const u = f.usage.at(-1);
  if (u?.runtime || u?.model) return { runtime: u.runtime ?? 'unknown', model: u.model ?? 'unknown', basis: 'last_usage' };
  return { runtime: 'unknown', model: 'unknown', basis: 'none' };
}

const blankGroup = (key, extra = {}) => ({ key, ...extra, settled: 0, verified: 0, failed: 0, _lat: [], _usd: 0, cost_known: 0, cost_unknown: 0, rework_transitions: 0 });

function finish(g) {
  const lat = median(g._lat);
  return { key: g.key, ...(g.runtime !== undefined ? { runtime: g.runtime } : {}), ...(g.model !== undefined ? { model: g.model } : {}),
    settled: g.settled, verified: g.verified, failed: g.failed,
    verified_rate: g.settled ? g.verified / g.settled : null,
    cost: { known_completions: g.cost_known, unknown_completions: g.cost_unknown, usd_known_total: g.cost_known ? g._usd : null,
      // a mean over a mixed known/unknown set would be fabricated, so one unknown makes the whole figure unknown
      per_verified_completion_usd: g.verified && !g.cost_unknown ? g._usd / g.verified : null },
    median_latency_ms: lat,
    rework: { transitions: g.rework_transitions, per_settled_task: g.settled ? g.rework_transitions / g.settled : null } };
}

export function scoreStore(dir, { since = null } = {}) {
  const tasksDir = join(dir, 'tasks');
  const out = { store: dir, tasks: { total: 0, accepted: 0, failed: 0, cancelled: 0, open: 0, informational: 0, unreadable: [] }, by_model: [], by_runtime: [], router_history: {}, caveats: [] };
  if (!existsSync(tasksDir)) { out.caveats.push('no task store at this path: nothing to score'); return out; }
  const models = new Map(), runtimes = new Map();
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) throw new Error(`--since is not an ISO timestamp: ${since}`);
  for (const id of readdirSync(tasksDir).sort()) {
    const log = join(tasksDir, id, 'events.jsonl');
    if (!ID_RE.test(id) || !existsSync(log)) continue;
    const { events, corrupt } = readLog(log);
    if (corrupt) { out.tasks.unreadable.push({ task_id: id, corrupt_line: corrupt }); continue; }
    const f = foldTask(events);
    if (!f) continue;
    if (sinceMs !== null && Date.parse(f.created_at) < sinceMs) continue;
    out.tasks.total += 1;
    if (f.info) { out.tasks.informational += 1; continue; }   // never dispatched to a developer: nothing to score
    if (f.status === 'cancelled') { out.tasks.cancelled += 1; continue; }   // an owner decision, not a model outcome
    if (f.status !== 'accepted' && f.status !== 'failed_unrecoverable') { out.tasks.open += 1; continue; }
    const accepted = f.status === 'accepted';
    out.tasks[accepted ? 'accepted' : 'failed'] += 1;
    const c = creditOf(f);
    const costKnown = f.usage.length > 0 && f.usage.every((u) => u.usd !== null);
    const taskUsd = costKnown ? f.usage.reduce((s, u) => s + u.usd, 0) : null;
    const latency = accepted && f.completed_at ? Date.parse(f.completed_at) - Date.parse(f.created_at) : null;
    for (const [map, key, extra] of [[models, `${c.runtime}:${c.model}`, { runtime: c.runtime, model: c.model }], [runtimes, c.runtime, { runtime: c.runtime }]]) {
      const g = map.get(key) || map.set(key, blankGroup(key, extra)).get(key);
      g.settled += 1;
      g.rework_transitions += f.rework;
      if (!accepted) { g.failed += 1; continue; }
      g.verified += 1;
      if (Number.isFinite(latency) && latency >= 0) g._lat.push(latency);
      if (costKnown) { g.cost_known += 1; g._usd += taskUsd; } else g.cost_unknown += 1;
    }
  }
  const order = (a, b) => b.settled - a.settled || a.key.localeCompare(b.key);
  out.by_model = [...models.values()].map(finish).sort(order);
  out.by_runtime = [...runtimes.values()].map(finish).sort(order);
  // Router input (orchestration/router.js `history`): { "<runtime>:<model>": { attempts, verified, errors, latency_ms, total_usd } }.
  // total_usd and latency_ms are omitted when unknown (the router then uses its priors), never filled with 0.
  for (const g of out.by_model) {
    if (g.runtime === 'unknown') continue;
    out.router_history[g.key] = { attempts: g.settled, verified: g.verified, errors: g.failed,
      ...(g.median_latency_ms !== null ? { latency_ms: g.median_latency_ms } : {}),
      ...(g.cost.usd_known_total !== null && !g.cost.unknown_completions ? { total_usd: g.cost.usd_known_total } : {}) };
  }
  if (out.tasks.unreadable.length) out.caveats.push(`${out.tasks.unreadable.length} task log(s) could not be replayed and are excluded, not counted as success or failure`);
  if (out.by_model.some((g) => g.cost.unknown_completions)) out.caveats.push('some verified completions have unknown cost (no usage record or an unpriced model); their groups show cost per completion as unknown');
  if (out.by_model.some((g) => g.settled < 5)) out.caveats.push('small samples: groups with fewer than 5 settled tasks are anecdotes, not rankings');
  if (out.by_model.some((g) => g.runtime === 'unknown')) out.caveats.push('some tasks have no recorded developer or usage: grouped under runtime "unknown"');
  return out;
}

const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const usd = (v) => (v === null ? 'unknown' : `$${v.toFixed(4)}`);
const dur = (ms) => (ms === null ? 'n/a' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

export function renderTable(r) {
  const rows = (list, title) => {
    const head = [title, 'settled', 'verified', 'rate', 'cost/verified', 'median latency', 'rework'];
    const body = list.map((g) => [g.key, String(g.settled), String(g.verified), pct(g.verified_rate), usd(g.cost.per_verified_completion_usd), dur(g.median_latency_ms), String(g.rework.transitions)]);
    const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd();
    return [line(head), line(w.map((n) => '-'.repeat(n))), ...(body.length ? body.map(line) : ['(no settled tasks)'])].join('\n');
  };
  const t = r.tasks;
  return [`V2 scoring report (read-only) for ${r.store}`,
    `tasks: ${t.total} total, ${t.accepted} accepted, ${t.failed} failed, ${t.cancelled} cancelled, ${t.open} open, ${t.informational} informational, ${t.unreadable.length} unreadable`,
    '', rows(r.by_model, 'model (runtime:model)'), '', rows(r.by_runtime, 'runtime'),
    ...(r.caveats.length ? ['', 'caveats:', ...r.caveats.map((c) => `  - ${c}`)] : [])].join('\n');
}

function main(argv) {
  const a = { store: defaultStoreDir(), json: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--store' && argv[i + 1]) a.store = argv[++i];
    else if (argv[i] === '--since' && argv[i + 1]) a.since = argv[++i];
    else { console.error('usage: v2-score.js [--store DIR] [--since ISO] [--json]'); return 2; }
  }
  const r = scoreStore(a.store, { since: a.since });
  console.log(a.json ? JSON.stringify(r, null, 2) : renderTable(r));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
