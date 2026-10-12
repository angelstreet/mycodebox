#!/usr/bin/env node
// Read-only scoring report over the V2 task store (OWNER_DECISIONS §8; docs/v2/SCORING.md). Per model and per runtime:
// verified completion rate, cost per verified completion, median latency, rework count. It reads the per-task
// event logs and never writes, recovers or repairs anything. Unknown stays unknown: a missing price is null, never $0.
//
//   node scripts/v2-score.js [--store DIR] [--since ISO] [--json]
//   node scripts/v2-score.js --scorecard [--suite MANIFEST] [--store DIR] [--since ISO] [--json]
//   node scripts/v2-score.js --tool-score --suite MANIFEST [--store DIR]           (JSON)
//   node scripts/v2-score.js --markdown --suite MANIFEST [--store DIR]            (round-4 tables: per model, task, task x model;
//                                                                                  the store defaults to the manifest's store_dir)
//   node scripts/v2-score.js --compare A.json B.json                              (two tool scores, same suite version only)
//   node scripts/v2-score.js --propose [--history FILE] [--store DIR] [--write-proposals --base-sha SHA [--project ID]]
//
// --propose prints proposals; it writes only with --write-proposals AND an explicit --store (never the default store):
// one informational task per proposal in awaiting_approval, plus journal.jsonl. Nothing applies a proposal.
//
// Default store: $GHOSTY_STATE_DIR/v2 (or ~/.local/state/ghosty/v2). No self-modification: the output is data; the router
// only sees it if a human passes `router_history` to route({ history }).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStoreDir } from '../orchestration/store.js';
import { RUNTIME_EFFORTS, loadRegistry } from '../orchestration/model-registry.js';
import { buildScorecard, toolScore, compareToolScores, taskSpecsOf } from '../orchestration/scorecard.js';
import { generateProposals, recordProposals } from '../orchestration/proposals.js';

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

// Only registry-shaped ids (<known runtime>:<model>) are models. Other actors (external:worktree, a human id) are not.
const isRegistryId = (id) => { const s = String(id || ''); const i = s.indexOf(':'); return i > 0 && s.length > i + 1 && Object.hasOwn(RUNTIME_EFFORTS, s.slice(0, i)); };
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
      if (isRegistryId(id)) { f.producers.set(p.sha, id); f.last_actor = id; }   // the last developer recorded for that SHA
    } else if (e.kind === 'usage.recorded') {
      f.usage.push({ runtime: p.runtime ?? null, model: p.model ?? null, incomplete: p.incomplete === true, usd: Number.isFinite(p.usd) && p.incomplete !== true ? p.usd : null, input_tokens: p.input_tokens ?? null, output_tokens: p.output_tokens ?? null });
    }
  }
  return f;
}

// Who gets the credit (or the blame): the developer that produced the accepted head; for a failed task the last developer
// recorded, else the last model that ran, else unknown. Exactly one group per settled task, so rates never double count.
export function creditOf(f) {
  const id = (f.status === 'accepted' && f.producers.get(f.head_sha)) || f.last_actor;
  if (id) return { ...splitEntry(id), basis: 'developer' };
  const u = f.usage.findLast((x) => isRegistryId(`${x.runtime}:${x.model}`));
  if (u) return { runtime: u.runtime ?? 'unknown', model: u.model ?? 'unknown', basis: 'last_usage' };
  return { runtime: 'unknown', model: 'unknown', basis: 'none' };
}

const blankGroup = (key, extra = {}) => ({ key, ...extra, settled: 0, verified: 0, failed: 0, _lat: [], _usd: 0, _usd_acc: 0, cost_known: 0, cost_unknown: 0, spend_unknown_tasks: 0, rework_transitions: 0 });

function finish(g) {
  const lat = median(g._lat);
  return { key: g.key, ...(g.runtime !== undefined ? { runtime: g.runtime } : {}), ...(g.model !== undefined ? { model: g.model } : {}),
    settled: g.settled, verified: g.verified, failed: g.failed,
    verified_rate: g.settled ? g.verified / g.settled : null,
    // Cost per verified completion = ALL spend credited to the group (failed tasks too: a model that burns money on failures is
    // not cheap) / verified. One settled task with unknown cost makes the figure unknown; a partial mean is never reported.
    cost: { known_completions: g.cost_known, unknown_completions: g.cost_unknown, spend_unknown_tasks: g.spend_unknown_tasks,
      usd_known_total: g.settled - g.spend_unknown_tasks > 0 ? g._usd : null, spend_on_accepted: g.cost_known ? g._usd_acc : null,
      per_verified_completion_usd: g.verified && !g.spend_unknown_tasks ? g._usd / g.verified : null },
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
    const costKnown = f.usage.length > 0 && f.usage.every((u) => u.usd !== null && !u.incomplete);
    const taskUsd = costKnown ? f.usage.reduce((s, u) => s + u.usd, 0) : null;
    const latency = accepted && f.completed_at ? Date.parse(f.completed_at) - Date.parse(f.created_at) : null;
    for (const [map, key, extra] of [[models, `${c.runtime}:${c.model}`, { runtime: c.runtime, model: c.model }], [runtimes, c.runtime, { runtime: c.runtime }]]) {
      const g = map.get(key) || map.set(key, blankGroup(key, extra)).get(key);
      g.settled += 1;
      g.rework_transitions += f.rework;
      if (costKnown) g._usd += taskUsd; else g.spend_unknown_tasks += 1;
      if (!accepted) { g.failed += 1; continue; }
      g.verified += 1;
      if (Number.isFinite(latency) && latency >= 0) g._lat.push(latency);
      if (costKnown) { g.cost_known += 1; g._usd_acc += taskUsd; } else g.cost_unknown += 1;
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
      ...(g.cost.per_verified_completion_usd !== null ? { total_usd: g.cost.usd_known_total } : {}) };
  }
  if (out.tasks.unreadable.length) out.caveats.push(`${out.tasks.unreadable.length} task log(s) could not be replayed and are excluded, not counted as success or failure`);
  if (out.by_model.some((g) => g.spend_unknown_tasks || g.cost.spend_unknown_tasks)) out.caveats.push('some settled tasks have unknown cost (no usage record, an unpriced model or incomplete usage); their groups show cost per verified completion as unknown');
  if (out.by_model.some((g) => g.settled < 5)) out.caveats.push('small samples: groups with fewer than 5 settled tasks are anecdotes, not rankings');
  if (out.by_model.some((g) => g.runtime === 'unknown')) out.caveats.push('some tasks have no registry developer or usage (external or human actors are not models): grouped under runtime "unknown"');
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

// Every readable task log ({ task_id, events }) plus the unreadable ones, without the store's recovery (read-only).
export function readStoreLogs(dir) {
  const tasksDir = join(dir, 'tasks');
  const logs = [], unreadable = [];
  if (!existsSync(tasksDir)) return { logs, unreadable, missing: true };
  for (const id of readdirSync(tasksDir).sort()) {
    const log = join(tasksDir, id, 'events.jsonl');
    if (!ID_RE.test(id) || !existsSync(log)) continue;
    const { events, corrupt } = readLog(log);
    if (corrupt) unreadable.push({ task_id: id, corrupt_line: corrupt }); else logs.push({ task_id: id, events });
  }
  return { logs, unreadable, missing: false };
}

export function scorecardOf(dir, { manifest = null, since = null } = {}) {
  const { logs, unreadable, missing } = readStoreLogs(dir);
  const sc = buildScorecard(logs, { manifest, unreadable, since });
  if (missing) sc.caveats.unshift('no task store at this path: nothing to score');
  return { sc, logs };
}

const fmt = (v) => (v === null || v === undefined ? 'unknown' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
export function renderScorecard(sc) {
  const head = ['group', 'settled', 'verified', 'first pass', 'cost/verified', 'median latency', 'rework', 'owner', 'defects', 'regressions'];
  const rows = (list) => list.map((g) => [g.key, String(g.settled), pct(g.verified_rate), pct(g.first_pass_rate), usd(g.cost.per_verified_completion_usd), dur(g.median_latency_ms),
    String(g.rework.rounds), String(g.owner_interventions.interventions), String(g.reviewer_defects.caught), fmt(g.regressions.detected)]);
  const table = (title, list) => {
    const body = rows(list);
    const w = head.map((h, i) => Math.max(i ? h.length : title.length, ...body.map((b) => b[i].length)));
    const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd();
    return [line([title, ...head.slice(1)]), line(w.map((n) => '-'.repeat(n))), ...(body.length ? body.map(line) : ['(no settled tasks)'])].join('\n');
  };
  const t = sc.tasks;
  return [`V2 scorecard (read-only)${sc.suite ? ` for suite ${sc.suite.suite_id}@${sc.suite.suite_version}` : ''}`,
    `tasks: ${t.total} total, ${t.settled} settled, ${t.accepted} accepted, ${t.failed} failed, ${t.cancelled} cancelled, ${t.open} open, ${t.informational} informational, ${t.unreadable} unreadable`,
    '', table('model', sc.by_model), '', table('runtime', sc.by_runtime), '', table('role', sc.by_role), '', table('task class', sc.by_task_class),
    ...(sc.caveats.length ? ['', 'caveats:', ...sc.caveats.map((c) => `  - ${c}`)] : [])].join('\n');
}

// ---------- markdown report (round 4): per model, per task, per task x model; repetitions pooled ----------
const secs = (ms) => (ms === null || ms === undefined ? 'n/a' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`);
const rangeOf = (st) => (st.n ? `${secs(st.mean)} (${secs(st.min)} to ${secs(st.max)})` : 'n/a');
const num = (v) => (v === null || v === undefined ? 'unknown' : String(v));
const usdCell = (m) => {
  const meas = m.usd.measured, est = m.usd.estimated;
  const priced = `$${meas.toFixed(4)}${est > 0 ? ` (+ est. $${est.toFixed(4)})` : ''}`;
  if (m.cost_basis === 'subscription') return meas > 0 ? `subscription (+ $${meas.toFixed(4)} per-token reviews)` : 'subscription';
  return m.cost_basis === 'unknown' ? `unknown (measured $${meas.toFixed(4)})` : priced;
};
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
function mdRows(list, label) {
  return list.map((m) => [label(m), String(m.runs), m.reps ? String(m.reps) : '-', `${m.verified}/${m.runs} (${pct(m.verified_rate)})`, `${m.first_pass}/${m.runs} (${pct(m.first_pass_rate)})`,
    num(m.rework.mean_per_run), `${num(m.tokens.developer_input)} / ${num(m.tokens.developer_output)}`, rangeOf(m.wall_ms), usdCell(m), m.cost_basis, String(m.provider_waits.total), rangeOf(m.time_to_stop_no_progress_ms)]);
}
const MD_HEAD = ['', 'runs', 'reps', 'verified', 'first pass', 'rework rounds (mean)', 'tokens in / out (developer)', 'wall time mean (min to max)', 'USD', 'cost basis', 'provider waits', 'time to stop, impossible task'];
export function renderMarkdown(sc) {
  const t = sc.tasks;
  const out = ['# V2 benchmark report', '',
    `Suite ${sc.suite ? `${sc.suite.suite_id}@${sc.suite.suite_version}` : '(no manifest)'}: ${t.total} task(s) in the store, ${t.settled} settled, ${t.accepted} accepted, ${t.failed} failed, ${t.cancelled} cancelled, ${t.open} open${t.not_run ? `, ${t.not_run} never started` : ''}. Repetitions are pooled; wall time is creation to acceptance, or to the stop (waiting, approval, failure) for runs that did not finish.`, '',
    '## Per model (developer)', '', mdTable(['model', ...MD_HEAD.slice(1)], mdRows(sc.model_metrics, (m) => m.key)), '',
    '## Per task', '', mdTable(['task', ...MD_HEAD.slice(1)], mdRows(sc.task_metrics, (m) => m.key)), '',
    '## Per task and model', '', mdTable(['task | model', ...MD_HEAD.slice(1)], mdRows(sc.task_model_metrics, (m) => m.key))];
  if (sc.not_run?.length) {
    const by = {};
    for (const r of sc.not_run) { const k = `${r.runtime}:${r.model} ${r.outcome}`; by[k] = (by[k] || 0) + 1; }
    out.push('', '## Not run', '', ...Object.entries(by).map(([k, n]) => `- ${k}: ${n}`));
  }
  const waits = sc.model_metrics.filter((m) => Object.keys(m.provider_waits.by_entry).length);
  if (waits.length) out.push('', '## Provider waits (rate limit / quota)', '', ...waits.map((m) => `- ${m.key}: ${Object.entries(m.provider_waits.by_entry).map(([k, n]) => `${k} ${n}`).join(', ')}`));
  out.push('', '## Notes', '', '- `subscription`: flat plan, no marginal USD (billing field on the usage record; runtime minimax when the field is absent). Never $0 measured.',
    '- USD sums per-token usage records (developer and reviewer) as reported by the provider; `est.` is the bench estimate for unpriced per-token records, not measured spend.',
    '- Time to stop: wall time from task creation to `waiting` with reason no_progress.', ...sc.caveats.map((c) => `- ${c}`));
  return `${out.join('\n')}\n`;
}
// Manifest file -> markdown, scoring the store the manifest points at (store_dir relative to the manifest, or `store`).
export function markdownReport(manifestPath, { store = null } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dir = store ?? join(dirname(manifestPath), manifest.store_dir || 'store');
  return renderMarkdown(scorecardOf(dir, { manifest }).sc);
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const USAGE = 'usage: v2-score.js [--store DIR] [--since ISO] [--json] | --scorecard [--suite F] | --tool-score --suite F | --markdown --suite F [--store DIR] | --compare A B | --propose [--history F] [--write-proposals --store DIR --base-sha SHA [--project ID]]';

async function main(argv) {
  const a = { store: defaultStoreDir(), storeGiven: false, json: false, since: null, mode: 'report', suite: null, history: null, write: false, baseSha: null, project: 'mycodebox', compare: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i], next = argv[i + 1];
    if (x === '--json') a.json = true;
    else if (x === '--store' && next) { a.store = argv[++i]; a.storeGiven = true; }
    else if (x === '--since' && next) a.since = argv[++i];
    else if (x === '--scorecard') a.mode = 'scorecard';
    else if (x === '--tool-score') a.mode = 'tool-score';
    else if (x === '--markdown') a.mode = 'markdown';
    else if (x === '--propose') a.mode = 'propose';
    else if (x === '--compare' && next && argv[i + 2]) { a.mode = 'compare'; a.compare = [argv[++i], argv[++i]]; }
    else if (x === '--suite' && next) a.suite = argv[++i];
    else if (x === '--history' && next) a.history = argv[++i];
    else if (x === '--write-proposals') a.write = true;
    else if (x === '--base-sha' && next) a.baseSha = argv[++i];
    else if (x === '--project' && next) a.project = argv[++i];
    else { console.error(USAGE); return 2; }
  }
  if (a.mode === 'report') {
    const r = scoreStore(a.store, { since: a.since });
    console.log(a.json ? JSON.stringify(r, null, 2) : renderTable(r));
    return 0;
  }
  if (a.mode === 'compare') {
    try { console.log(JSON.stringify(compareToolScores(readJson(a.compare[0]), readJson(a.compare[1])), null, 2)); return 0; }
    catch (e) { console.error(`refused: ${e.message}`); return 3; }
  }
  const manifest = a.suite ? readJson(a.suite) : null;
  if (a.mode === 'markdown') {
    if (!a.suite) { console.error('--markdown needs --suite MANIFEST'); return 2; }
    try { process.stdout.write(markdownReport(a.suite, { store: a.storeGiven ? a.store : null })); return 0; } catch (e) { console.error(e.message); return 2; }
  }
  if (a.mode === 'tool-score' && !manifest) { console.error('--tool-score needs --suite MANIFEST'); return 2; }
  if (a.write && (a.mode !== 'propose' || !a.storeGiven || !a.baseSha)) { console.error('--write-proposals needs --propose, an explicit --store DIR and --base-sha SHA'); return 2; }
  let sc, logs;
  try { ({ sc, logs } = scorecardOf(a.store, { manifest, since: a.since })); } catch (e) { console.error(e.message); return 2; }
  if (a.mode === 'scorecard') { console.log(a.json ? JSON.stringify(sc, null, 2) : renderScorecard(sc)); return 0; }
  if (a.mode === 'tool-score') { console.log(JSON.stringify(toolScore(sc, manifest), null, 2)); return 0; }
  // propose
  const registry = loadRegistry();
  const routerHistory = scoreStore(a.store, { since: a.since }).router_history;
  const { proposals } = generateProposals(sc, { registry, tasks: taskSpecsOf(logs), routerHistory, currentHistory: a.history ? readJson(a.history) : {} });
  let recorded = null;
  if (a.write) {
    const [{ createTaskStore }, { createIntake }] = await Promise.all([import('../orchestration/store.js'), import('../orchestration/intake.js')]);
    const store = createTaskStore({ dir: a.store });
    recorded = await recordProposals(proposals, { store, intake: createIntake({ store, loadPolicy: () => ({ ok: false }) }), base_sha: a.baseSha, project_id: a.project });
  }
  if (a.json) console.log(JSON.stringify({ proposals, recorded }, null, 2));
  else {
    console.log(proposals.length ? proposals.map((p) => `- [${p.kind}] ${p.title}\n    ${p.rationale}${p.shadow ? `\n    shadow: ${p.shadow.changed.length} of ${p.shadow.evaluated} recorded task(s) would route differently` : ''}`).join('\n') : 'no proposal: no rule fired');
    console.log(recorded ? `recorded ${recorded.filter((r) => r.created).length} new proposal task(s) in awaiting_approval; nothing was applied` : 'not recorded (use --write-proposals --store DIR --base-sha SHA); nothing was applied');
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
