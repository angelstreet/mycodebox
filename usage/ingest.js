// Usage tailer: reads Claude Code / Codex / MiniMax usage logs incrementally and sends one Langfuse
// generation per assistant turn (usage numbers + ids only, never prompt or response text).
// Also writes a local summary (usage-summary.json) the ghosty UI can read.
//
//   node usage/ingest.js            run forever (the ghosty-usage unit)
//   node usage/ingest.js --once     one pass, then exit
//   node usage/ingest.js --backfill rescan the last BACKFILL_DAYS days (forget offsets; ids are deterministic, so Langfuse upserts)
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { traceIdOf, genIdOf, postBatch as postBatchRaw } from './lf-common.js';
import { createEvalSync } from './lfeval.js';
import { createJudge } from './judge.js';
import { parseManagerLine } from './manager-parse.js';
import { buildScorecard, langfuseScoreEvents, scorecardTraceId, foldRuns } from '../scorecard.js';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const LIVE_MS = 10 * 60000;   // a trace with a record this recent is "live" -> try to map it to a tmux session

export function defaults(env = process.env) {
  const home = homedir();
  const stateDir = env.GHOSTY_STATE_DIR || join(home, '.local/state/ghosty');
  return {
    langfuseUrl: (env.LANGFUSE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, ''),
    publicKey: env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: env.LANGFUSE_SECRET_KEY || '',
    claudeDir: env.CLAUDE_PROJECTS_DIR || join(home, '.claude/projects'),
    codexDir: env.CODEX_SESSIONS_DIR || join(home, '.codex/sessions'),
    minimaxDb: env.MINIMAX_DB || join(home, '.minimax/v2/sqlite/runtime-state.sqlite'),
    minimaxModel: env.MINIMAX_DEFAULT_MODEL || 'MiniMax-M3',   // the runtime table stores no model; this is its configured default
    stateDir,
    offsetsFile: join(stateDir, 'usage-offsets.json'),
    ledgerFile: join(stateDir, 'usage-ledger.jsonl'),
    summaryFile: join(stateDir, 'usage-summary.json'),
    evalStateFile: join(stateDir, 'lfeval-state.json'),   // scores + dataset the eval sync already sent (its own file: the tailer's offsets are never touched)
    evalEnabled: env.LFEVAL !== '0',
    judgeStateFile: join(stateDir, 'lfeval-judge.json'),
    jevUrl: env.JEV_URL || '',   // the in-ghosty AI-proposal judge is opt-in (LFEVAL_JUDGE=1) and uses the same VPT server as the AI reviewer
    jevApiKey: env.LFEVAL_JUDGE === '1' ? env.JEV_API_KEY || '' : '',
    judgeMaxPerDay: Number(env.LFEVAL_JUDGE_MAX_PER_DAY || 400),
    judgeSampling: Number(env.LFEVAL_JUDGE_SAMPLING || 1),
    stallsFile: join(stateDir, 'stalls.jsonl'),   // the AI manager's log: its Jev and AI-reviewer calls become generations of agent "manager"
    pricesFile: env.USAGE_PRICES || join(HERE, 'prices.json'),
    backfillDays: Number(env.BACKFILL_DAYS || 14),
    pollMs: Number(env.USAGE_POLL_MS || 15000),
    summaryMs: Number(env.USAGE_SUMMARY_MS || 60000),
    batchSize: 100,
    paceMs: Number(env.USAGE_PACE_MS || 1500),   // pause between ingestion requests so Langfuse stays light
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export function priceFor(prices, model) {
  if (!model) return null;
  let best = null;
  for (const k of Object.keys(prices.models || {})) {
    if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? prices.models[best] : null;
}

// u = { input, output, cache_read, cache_write_5m, cache_write_1h }. null when the model has no price.
export function costOf(price, u) {
  if (!price) return null;
  const M = 1e6;
  const r = (x) => Math.round(x * 1e9) / 1e9;
  const input = (u.input * price.input) / M;
  const output = (u.output * price.output) / M;
  const cache_read = (u.cache_read * price.cache_read) / M;
  const cache_creation = (u.cache_write_5m * price.cache_write + u.cache_write_1h * (price.cache_write_1h ?? price.cache_write)) / M;
  return { input: r(input), output: r(output), cache_read: r(cache_read), cache_creation: r(cache_creation), total: r(input + output + cache_read + cache_creation) };
}

// ---------------------------------------------------------------------------
// Source parsers (pure)
// ---------------------------------------------------------------------------

const n = (x) => (Number.isFinite(x) ? x : 0);

// One Claude Code transcript line -> record | null. A message can be written as several lines with the
// same message.id; callers dedupe on record.id.
export function parseClaudeLine(o, { subagent = false } = {}) {
  const m = o && o.message;
  if (!m || typeof m !== 'object' || !m.usage || !m.id || !m.model || m.model === '<synthetic>') return null;
  const u = m.usage;
  const cc = u.cache_creation || {};
  const w5 = n(cc.ephemeral_5m_input_tokens), w1 = n(cc.ephemeral_1h_input_tokens);
  const created = n(u.cache_creation_input_tokens);
  const usage = {
    input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens),
    // when the 5m/1h split is missing, treat the whole creation as 5m
    cache_write_5m: w5 + w1 ? w5 : created, cache_write_1h: w5 + w1 ? w1 : 0,
  };
  if (!(usage.input + usage.output + usage.cache_read + usage.cache_write_5m + usage.cache_write_1h)) return null;
  const ts = Date.parse(o.timestamp);
  if (!o.sessionId || !Number.isFinite(ts)) return null;
  return { id: `claude:${m.id}`, agent: 'claude', session: o.sessionId, cwd: o.cwd || null, ts, model: m.model, usage, subagent };
}

// Codex rollout file: stateful (session_meta + turn_context precede the usage lines). Feed lines in order.
export function codexReader() {
  const st = { session: null, cwd: null, model: null };
  return function feed(o) {
    if (o.type === 'session_meta') { st.session = o.payload.session_id || o.payload.id || st.session; st.cwd = o.payload.cwd || st.cwd; return null; }
    if (o.type === 'turn_context') { st.model = o.payload.model || st.model; st.cwd = o.payload.cwd || st.cwd; return null; }
    if (o.type !== 'token_usage_record') return null;
    const p = o.payload, u = p.usage;
    if (!u || !st.session) return null;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return null;
    const cached = n(u.cached_input_tokens);
    return {
      id: `codex:${p.response_id || `${st.session}:${o.ordinal}`}`, agent: 'codex', session: st.session, cwd: st.cwd, ts,
      model: st.model || 'unknown',
      // codex input_tokens includes the cached part; Langfuse/price "input" is the uncached remainder
      usage: { input: Math.max(0, n(u.input_tokens) - cached), output: n(u.output_tokens), cache_read: cached, cache_write_5m: n(u.cache_write_input_tokens), cache_write_1h: 0 },
      subagent: false,
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers: project (GitHub repo name), tmux mapping
// ---------------------------------------------------------------------------

// Mirrors gitInfo() in server.js: GitHub repo name from origin, else folder of the main checkout.
export async function gitProject(cwd) {
  try {
    const run = (args) => exec('git', ['-C', cwd, ...args], { timeout: 4000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).then((r) => r.stdout.trim());
    const [top, gitDir, commonDir] = (await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])).split('\n');
    let project = null;
    try {
      const url = await run(['remote', 'get-url', 'origin']);
      const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
      project = m ? m[2] : basename(url.replace(/\.git\/?$/, ''));
    } catch {}
    const worktree = gitDir && commonDir && gitDir !== commonDir;
    return project || basename(worktree ? dirname(commonDir) : top);
  } catch { return null; }
}

async function tmuxPanes() {
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}\t#{session_activity}'], { timeout: 4000 });
    return stdout.trim().split('\n').filter(Boolean).map((l) => { const [name, cwd, act] = l.split('\t'); return { name, cwd, activity: Number(act) * 1000 }; });
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Summary (pure)
// ---------------------------------------------------------------------------

const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, cost: 0, unpriced: 0, turns: 0 });
function add(t, r) {
  const u = r.usage, c = u.cache_write_5m + u.cache_write_1h;
  t.input += u.input; t.output += u.output; t.cache_read += u.cache_read; t.cache_creation += c;
  t.total += u.input + u.output + u.cache_read + c; t.turns++;
  if (r.cost) t.cost += r.cost.total; else t.unpriced++;
}
const round = (t) => ({ ...t, cost: Math.round(t.cost * 1e6) / 1e6 });
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildSummary(records, now, days = 14) {
  const since = now - days * DAY_MS, today = dayOf(now);
  const by = { session: new Map(), project: new Map(), agent: new Map(), model: new Map(), day: new Map(), dayModel: new Map() };
  const tdy = { total: zero(), agent: new Map(), project: new Map(), model: new Map() };   // today (UTC day) only
  const total = zero();
  const modelAgent = new Map();
  const get = (m, k, init) => { let v = m.get(k); if (!v) { v = init(); m.set(k, v); } return v; };
  for (const r of records) {
    if (r.ts < since) continue;
    add(total, r);
    add(get(by.project, r.project || 'unknown', zero), r);
    add(get(by.agent, r.agent, zero), r);
    add(get(by.model, r.model, zero), r);
    modelAgent.set(r.model, r.agent);
    add(get(by.day, dayOf(r.ts), zero), r);
    add(get(get(by.dayModel, dayOf(r.ts), () => new Map()), r.model, zero), r);
    const s = get(by.session, r.trace, () => ({ ...zero(), id: r.trace, session: r.label, agent: r.agent, project: r.project || 'unknown', first: r.ts, last: r.ts, models: new Set(), days: new Map(), slots: new Set(), today: { ...zero(), slots: new Set() } }));
    add(s, r);
    s.first = Math.min(s.first, r.ts); s.last = Math.max(s.last, r.ts); s.models.add(r.model);
    const slot = Math.floor(r.ts / 300000);   // 5-minute slots with activity
    s.slots.add(slot);
    add(get(s.days, dayOf(r.ts), zero), r);
    if (dayOf(r.ts) === today) {
      add(s.today, r);
      s.today.slots.add(slot);
      add(tdy.total, r);
      add(get(tdy.agent, r.agent, zero), r);
      add(get(tdy.project, r.project || 'unknown', zero), r);
      add(get(tdy.model, r.model, zero), r);
    }
  }
  // OUTLIER RULE: for every session active today (UTC day), rate = cost today / active hours today, where
  // active hours = (number of distinct 5-minute slots with a record) * 5/60, floored at 0.1 h. Within each project
  // that has >= 3 priced sessions active today, a session is an outlier when rate > 3 x the median rate of that
  // project's sessions (itself included) and it spent >= $1 today. Unpriced sessions are ignored.
  const rates = new Map();
  for (const s of by.session.values()) {
    if (!s.today.slots.size || s.today.cost <= 0) continue;
    const hours = Math.max(0.1, (s.today.slots.size * 5) / 60);
    s.today.rate = s.today.cost / hours;
    (rates.get(s.project) || rates.set(s.project, []).get(s.project)).push(s);
  }
  const outliers = [];
  for (const [project, list] of rates) {
    if (list.length < 3) continue;
    const med = median(list.map((s) => s.today.rate));
    for (const s of list) if (s.today.rate > 3 * med && s.today.cost >= 1) {
      outliers.push({ session: s.session, id: s.id, project, agent: s.agent, costToday: Math.round(s.today.cost * 100) / 100, costPerHour: Math.round(s.today.rate * 100) / 100, projectMedianPerHour: Math.round(med * 100) / 100, ratio: Math.round((s.today.rate / med) * 10) / 10 });
    }
  }
  const obj = (m) => Object.fromEntries([...m].map(([k, v]) => [k, round(v)]).sort((a, b) => b[1].cost - a[1].cost));
  return {
    generatedAt: new Date(now).toISOString(), windowDays: days, total: round(total),
    perAgent: obj(by.agent), perProject: obj(by.project), perModel: Object.fromEntries(Object.entries(obj(by.model)).map(([k, v]) => [k, { ...v, agent: modelAgent.get(k) }])),
    perDay: Object.fromEntries([...by.day].sort().map(([k, v]) => [k, round(v)])),
    // per day, per model: { total tokens, cost (null-ish 0 when unpriced), unpriced } for the usage view's token chart
    perDayModel: Object.fromEntries([...by.dayModel].sort().map(([d, m]) => [d, Object.fromEntries([...m].map(([k, v]) => [k, { total: v.total, cost: Math.round(v.cost * 1e6) / 1e6, unpriced: v.unpriced }]))])),
    // today = the UTC day's totals, per agent / project / model (the usage view's "Today" tab)
    today: { day: today, total: round(tdy.total), perAgent: obj(tdy.agent), perProject: obj(tdy.project), perModel: obj(tdy.model) },
    // per session: 14-day totals + activeHours (5-minute slots with a record), `today` (null when idle today; rate = cost
    // per active hour, null when unpriced) and `days` (day -> {cost, total, unpriced}, for the per-session history)
    perSession: [...by.session.values()].map(({ today: t, days: dm, slots, models, first, last, ...rest }) => ({
      ...round(rest), models: [...models], first: new Date(first).toISOString(), last: new Date(last).toISOString(),
      activeHours: Math.round(slots.size * 5 / 60 * 100) / 100,
      today: t.slots.size ? { ...round((({ slots: _s, ...x }) => x)(t)), hours: Math.max(0.1, Math.round(t.slots.size * 5 / 60 * 100) / 100), rate: t.rate != null ? Math.round(t.rate * 100) / 100 : null } : null,
      days: Object.fromEntries([...dm].sort().map(([k, v]) => [k, { cost: Math.round(v.cost * 1e6) / 1e6, total: v.total, unpriced: v.unpriced }])),
    })).sort((a, b) => b.cost - a.cost),
    outliers: outliers.map((o) => ({ ...o, reason: `${o.ratio}x the ${o.project} median: $${o.costPerHour}/h vs $${o.projectMedianPerHour}/h` })),
  };
}

// ---------------------------------------------------------------------------
// Langfuse
// ---------------------------------------------------------------------------

export { traceIdOf, genIdOf, parseManagerLine };

export function langfuseEvents(records, traces, sentAt = Date.now()) {
  // envelope timestamp = send time: Langfuse orders events of one entity by it, so a re-sent (updated) generation must be newer
  const stamp = new Date(sentAt).toISOString();
  const events = [];
  const seen = new Set();
  for (const r of records) {
    if (!seen.has(r.trace)) {
      seen.add(r.trace);
      const t = traces.get(r.trace);
      events.push({ id: randomUUID(), type: 'trace-create', timestamp: stamp, body: {
        id: r.trace, name: `${r.agent}:${r.label}`, timestamp: new Date(t.first).toISOString(), sessionId: r.trace,
        tags: [`agent:${r.agent}`, ...(r.project ? [`project:${r.project}`] : []), `session:${r.label}`, ...[...t.models].map((m) => `model:${m}`), ...[...t.days].map((d) => `day:${d}`)],
        metadata: { agent: r.agent, project: r.project || null, session: r.label, sourceSession: r.session },
      } });
    }
    const u = r.usage;
    const usageDetails = { input: u.input, output: u.output, cache_read: u.cache_read, cache_creation: u.cache_write_5m + u.cache_write_1h };
    events.push({ id: randomUUID(), type: 'generation-create', timestamp: stamp, body: {
      id: genIdOf(r.id), traceId: r.trace, name: r.name || (r.subagent ? `${r.agent}-subagent-turn` : `${r.agent}-turn`),
      ...(r.error ? { level: 'ERROR', statusMessage: String(r.error).slice(0, 500) } : {}),
      startTime: new Date(r.ts).toISOString(), endTime: new Date(r.ts).toISOString(), model: r.model, usageDetails,
      ...(r.prompt ? { promptName: r.prompt.name, promptVersion: r.prompt.version } : {}),
      ...(r.input !== undefined ? { input: r.input } : {}), ...(r.output !== undefined ? { output: r.output } : {}),
      ...(r.cost ? { costDetails: { input: r.cost.input, output: r.cost.output, cache_read: r.cost.cache_read, cache_creation: r.cost.cache_creation, total: r.cost.total } } : {}),
      metadata: { agent: r.agent, project: r.project || null, session: r.label, model: r.model, day: dayOf(r.ts), source: r.id.split(':')[0], subagent: !!r.subagent, priced: !!r.cost,
        ...(r.agent === 'manager' ? { ms: r.ms ?? null, costEstimated: !!r.costEstimated, ...r.extra } : {}) },
    } });
  }
  return events;
}

async function postBatch(cfg, batch) {
  const errors = await postBatchRaw(cfg, batch);
  if (errors.length) console.error('[usage] langfuse rejected events:', JSON.stringify(errors.slice(0, 3)));
}

// ---------------------------------------------------------------------------
// Ingester
// ---------------------------------------------------------------------------

async function listFiles(dir, match, minMtime) {
  const out = [];
  async function walk(d, depth) {
    let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 6) await walk(p, depth + 1);
      else if (e.isFile() && match(p)) { try { const st = await fs.stat(p); if (st.mtimeMs >= minMtime) out.push({ path: p, size: st.size }); } catch {} }
    }
  }
  await walk(dir, 0);
  return out;
}

async function readFrom(path, offset, size) {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    return buf;
  } finally { await fh.close(); }
}

// complete lines only: the byte after the last '\n' is a partial line and is left for the next pass
function* completeLines(buf, base) {
  let start = 0;
  for (;;) {
    const i = buf.indexOf(10, start);
    if (i < 0) return;
    yield { text: buf.toString('utf8', start, i), start: base + start, end: base + i + 1 };
    start = i + 1;
  }
}

export function createIngester(cfg, hooks = {}) {
  const projectOf = hooks.projectOf || gitProject;
  const panesOf = hooks.tmuxPanes || tmuxPanes;
  let prices = null;
  let state = null;            // { files:{path:offset}, minimaxLastId, cwdProject, traceLabel }
  const byId = new Map();      // committed records within the window, by record id
  const traces = new Map();    // trace -> { first, models:Set, days:Set }

  async function init(forceBackfill) {
    prices = JSON.parse(await fs.readFile(cfg.pricesFile, 'utf8'));
    await fs.mkdir(cfg.stateDir, { recursive: true });
    state = { files: {}, minimaxLastId: null, cwdProject: {}, traceLabel: {} };
    if (!forceBackfill) { try { state = { ...state, ...JSON.parse(await fs.readFile(cfg.offsetsFile, 'utf8')) }; } catch {} }
    const since = cfg.now() - cfg.backfillDays * DAY_MS;
    let text = ''; try { text = await fs.readFile(cfg.ledgerFile, 'utf8'); } catch {}
    // later lines for the same id are updates (a message's output_tokens grows while it streams): last one wins
    if (!forceBackfill) for (const l of text.split('\n')) { try { const r = JSON.parse(l); if (r.ts >= since) remember(r.agent === 'manager' && !r.trace ? { ...r, trace: traceIdOf('manager', r.session) } : r); } catch {} }
    await fs.writeFile(cfg.ledgerFile, [...byId.values()].map((r) => JSON.stringify(r) + '\n').join(''));
  }

  function remember(r) {
    byId.set(r.id, r);
    let t = traces.get(r.trace);
    if (!t) traces.set(r.trace, t = { first: r.ts, models: new Set(), days: new Set() });
    t.first = Math.min(t.first, r.ts); t.models.add(r.model); t.days.add(dayOf(r.ts));
  }

  async function collect() {
    const since = cfg.now() - cfg.backfillDays * DAY_MS;
    const fresh = [];             // records not yet committed
    const nextFiles = { ...state.files };
    // A Claude message is written as several lines sharing message.id while output_tokens grows (first line is partial),
    // so the line with the most tokens wins; a larger one for an already-committed id is sent again (Langfuse upserts by id).
    const size = (r) => r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write_5m + r.usage.cache_write_1h;
    const pending = new Map();
    const push = (r) => {
      if (!r || r.ts < since) return;
      const old = pending.get(r.id) || byId.get(r.id);
      if (old && size(r) <= size(old)) return;
      if (old) r.ts = old.ts;          // keep the first line's timestamp as the turn start
      pending.set(r.id, r);
    };

    // Claude Code (main + subagent transcripts)
    const claude = await listFiles(cfg.claudeDir, (p) => p.endsWith('.jsonl'), since);
    for (const f of claude) {
      let off = nextFiles[f.path] ?? 0;
      if (f.size < off) off = 0;                       // truncated / rewritten
      if (f.size === off) continue;
      const sub = f.path.includes('/subagents/');
      const buf = await readFrom(f.path, off, f.size);
      let end = off;
      for (const l of completeLines(buf, off)) {
        end = l.end;
        if (!l.text.includes('"usage"')) continue;
        try { push(parseClaudeLine(JSON.parse(l.text), { subagent: sub })); } catch {}
      }
      nextFiles[f.path] = end;
    }

    // Codex: context lines (session_meta, turn_context) precede usage, so always parse from byte 0 and emit past the offset
    const codex = await listFiles(cfg.codexDir, (p) => p.endsWith('.jsonl'), since);
    for (const f of codex) {
      let off = nextFiles[f.path] ?? 0;
      if (f.size < off) off = 0;
      if (f.size === off) continue;
      const buf = await readFrom(f.path, 0, f.size);
      const feed = codexReader();
      let end = 0;
      for (const l of completeLines(buf, 0)) {
        let o; try { o = JSON.parse(l.text); } catch { continue; }
        const r = feed(o);
        end = l.end;
        if (l.start >= off) push(r);
      }
      nextFiles[f.path] = end;
    }

    // The AI manager's own calls (Jev, AI reviewer): its stalls.jsonl, read incrementally like the transcripts above
    try {
      const st = await fs.stat(cfg.stallsFile);
      let off = nextFiles[cfg.stallsFile] ?? 0;
      if (st.size < off) off = 0;
      if (st.size > off) {
        const buf = await readFrom(cfg.stallsFile, off, st.size);
        let end = off;
        for (const l of completeLines(buf, off)) {
          end = l.end;
          if (!l.text.includes('"jev"') && !l.text.includes('"triage"')) continue;
          try { push(parseManagerLine(JSON.parse(l.text))); } catch {}
        }
        nextFiles[cfg.stallsFile] = end;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.error('[usage] manager log:', e.message); }

    // MiniMax: sqlite table local_runtime_token_usage (no model column, session -> workspace_dir)
    let minimaxLastId = state.minimaxLastId;
    try {
      await fs.access(cfg.minimaxDb);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(cfg.minimaxDb, { readOnly: true });
      try {
        if (minimaxLastId == null) {
          const r = db.prepare('SELECT MIN(id) AS id FROM local_runtime_token_usage WHERE ts >= ?').get(since);
          minimaxLastId = r && r.id != null ? r.id - 1 : (db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM local_runtime_token_usage').get().id);
        }
        const sess = new Map();
        for (const s of db.prepare('SELECT session_id, parent_session_id, workspace_dir FROM local_runtime_sessions').all()) sess.set(s.session_id, s);
        const root = (id) => { let s = sess.get(id), guard = 0; while (s && s.parent_session_id && sess.get(s.parent_session_id) && guard++ < 10) { id = s.parent_session_id; s = sess.get(id); } return id; };
        for (const row of db.prepare('SELECT * FROM local_runtime_token_usage WHERE id > ? ORDER BY id').all(minimaxLastId)) {
          minimaxLastId = row.id;
          const rid = root(row.session_id);
          push({
            id: `minimax:${row.id}`, agent: 'minimax', session: rid, cwd: (sess.get(rid) || sess.get(row.session_id) || {}).workspace_dir || null,
            ts: row.ts, model: row.model || cfg.minimaxModel,
            usage: { input: row.input_tokens, output: row.output_tokens, cache_read: row.cache_read_tokens, cache_write_5m: row.cache_write_tokens, cache_write_1h: 0 },
            subagent: rid !== row.session_id,
          });
        }
      } finally { db.close(); }
    } catch (e) { if (e.code !== 'ENOENT') console.error('[usage] minimax:', e.message); }

    return { fresh: [...pending.values()], nextFiles, minimaxLastId };
  }

  async function enrich(fresh, nextState) {
    const projects = nextState.cwdProject, tried = new Set();
    for (const r of fresh) {
      if (r.agent === 'manager') { r.trace = traceIdOf('manager', r.session); continue; }   // cost, project and label are set by the parser
      if (r.cwd && projects[r.cwd] == null && !tried.has(r.cwd)) { tried.add(r.cwd); projects[r.cwd] = await projectOf(r.cwd); }
      r.project = (r.cwd && projects[r.cwd]) || (r.cwd ? basename(r.cwd) : null);
      r.trace = traceIdOf(r.agent, r.session);
      r.cost = costOf(priceFor(prices, r.model), r.usage);
    }
    // tmux session names: only for traces with a live record; closest pane activity wins when several share a cwd
    const newest = new Map();
    for (const r of fresh) if (!newest.get(r.trace) || r.ts > newest.get(r.trace).ts) newest.set(r.trace, r);
    let panes = null;
    for (const [trace, r] of newest) {
      if (r.agent === 'manager') { nextState.traceLabel[trace] = { label: r.session, tmux: true }; continue; }
      if (nextState.traceLabel[trace] && nextState.traceLabel[trace].tmux) continue;
      if (cfg.now() - r.ts < LIVE_MS && r.cwd) {
        panes = panes || await panesOf();
        const c = panes.filter((p) => p.cwd === r.cwd);
        if (c.length) { c.sort((a, b) => Math.abs(a.activity - r.ts) - Math.abs(b.activity - r.ts)); nextState.traceLabel[trace] = { label: c[0].name, tmux: true }; continue; }
      }
      if (!nextState.traceLabel[trace]) nextState.traceLabel[trace] = { label: r.cwd ? basename(r.cwd) : r.session.slice(0, 8), tmux: false };
    }
    for (const r of [...fresh, ...byId.values()]) { const l = nextState.traceLabel[r.trace]; if (l) r.label = l.label; }
  }

  // Folds fresh (enriched) records into the traces, posts them to Langfuse as generations and appends them to the ledger.
  async function send(fresh) {
    if (!fresh.length) return;
    // traces.get() needs the new records folded in for tags; do it on a copy so a failed send leaves state untouched
    const tmpTraces = new Map([...traces].map(([k, v]) => [k, { first: v.first, models: new Set(v.models), days: new Set(v.days) }]));
    for (const r of fresh) {
      let t = tmpTraces.get(r.trace);
      if (!t) tmpTraces.set(r.trace, t = { first: r.ts, models: new Set(), days: new Set() });
      t.first = Math.min(t.first, r.ts); t.models.add(r.model); t.days.add(dayOf(r.ts));
    }
    const events = langfuseEvents(fresh, tmpTraces, cfg.now());
    if (!cfg.publicKey || !cfg.secretKey) throw new Error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set');
    for (let i = 0; i < events.length; i += cfg.batchSize) {
      if (i && cfg.paceMs) await new Promise((r) => setTimeout(r, cfg.paceMs));
      await postBatch(cfg, events.slice(i, i + cfg.batchSize));
    }
    await fs.appendFile(cfg.ledgerFile, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const r of fresh) remember(r);
    console.log(`[usage] sent ${fresh.length} generations`);
  }

  // Records another component produced (the in-ghosty judge's manager.judge calls): same path as the manager's own
  // lines in collect(): enrich (trace id + label), generation to Langfuse, ledger append, remembered in byId.
  async function commitRows(rows) {
    if (!rows.length) return 0;
    if (!state) await init(false);
    const nextState = { ...state, traceLabel: { ...state.traceLabel } };
    const fresh = rows.filter((r) => r && r.id && !byId.has(r.id)).sort((a, b) => a.ts - b.ts);
    await enrich(fresh, nextState);
    await send(fresh);
    state = nextState;
    await atomicWrite(cfg.offsetsFile, JSON.stringify(state));
    return fresh.length;
  }

  async function tick() {
    if (!state) await init(false);
    const { fresh, nextFiles, minimaxLastId } = await collect();
    const nextState = { ...state, files: nextFiles, minimaxLastId, cwdProject: { ...state.cwdProject }, traceLabel: { ...state.traceLabel } };
    fresh.sort((a, b) => a.ts - b.ts);
    await enrich(fresh, nextState);
    await send(fresh);
    state = nextState;
    await atomicWrite(cfg.offsetsFile, JSON.stringify(state));
    return fresh.length;
  }

  // Owner labels / verdicts -> Langfuse scores + the ghosty-stops dataset. Never lets a failure break the usage pass.
  let evalSync = null, judge = null;
  async function evalPass() {
    if (!cfg.evalEnabled || !cfg.publicKey || !cfg.secretKey) return null;
    try {
      evalSync = evalSync || createEvalSync(cfg, { traceKnown: (t) => traces.has(t) });
      const r = await evalSync.sync();
      if (cfg.jevUrl && cfg.jevApiKey) { judge = judge || createJudge(cfg, { commit: commitRows }); const j = await judge(); if (j.judged) console.log(`[usage] judged ${j.judged} AI proposals`); }
      if (r && !r.skipped && (r.scores || r.spans || r.items || r.deleted)) console.log(`[usage] eval sync ${JSON.stringify(r)}`);
      return r;
    } catch (e) { console.error('[usage] eval sync:', e.message); return null; }
  }

  async function summary() {
    if (!state) await init(false);
    const s = buildSummary([...byId.values()], cfg.now(), cfg.backfillDays);
    await atomicWrite(cfg.summaryFile, JSON.stringify(s, null, 1));
    return s;
  }

  return { init, tick, summary, evalPass, commitRows, ledger: byId };
}

// ---------------------------------------------------------------------------
// Manager scorecard -> Langfuse scores (manager.score, manager.cost_usd, jev.*).
// Runs in the tailer's main loop, once per cfg.pollMs * 4 (or on a hard cadence when --once).
// Same trace id each UTC day -> Langfuse upserts (a refresh overwrites yesterday's values too).
// ---------------------------------------------------------------------------
const SCORECARD_MS = 15 * 60 * 1000;

export function createScorecardPoster(cfg, { ing, log = console.log } = {}) {
  let lastAt = 0;
  return async function postScorecard({ force = false } = {}) {
    if (!cfg.publicKey || !cfg.secretKey) return { skipped: 'no langfuse keys' };
    const now = cfg.now ? cfg.now() : Date.now();
    if (!force && now - lastAt < SCORECARD_MS) return { skipped: 'throttled' };
    try {
      // Read the file, not ing.ledger: the file is the full record (the ingester's map only covers its window).
      const text = await fs.readFile(cfg.ledgerFile, 'utf8').catch(() => '');
      const ledgerRows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let stallRecs = [], runsLines = [];
      try { stallRecs = (await fs.readFile(cfg.stallsFile, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
      try { runsLines = (await fs.readFile(join(cfg.stateDir, 'manager-runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
      const runs = foldRuns(runsLines);
      let cfg_json = {};
      try { cfg_json = JSON.parse(await fs.readFile(join(cfg.stateDir, 'manager.json'), 'utf8')); } catch {}
      // today = [dayStart, now] so a fresh tailer still has *something* even mid-day.
      const dayStart = Math.floor(now / 86400000) * 86400000;
      const today = buildScorecard({ ledgerRows, stallRecs, runs, config: cfg_json, from: dayStart, to: now + 1 });
      const traceId = scorecardTraceId(now);
      const events = langfuseScoreEvents(today, { traceId, traceName: 'manager-scorecard', sentAt: now });
      if (events.length) {
        const errs = await postBatchRaw(cfg, events);
        if (errs.length) log('[usage] scorecard langfuse rejected:', JSON.stringify(errs.slice(0, 3)));
        else log(`[usage] posted ${events.length} scorecard events (${today.perf.stops} stops, score ${today.score})`);
      }
      lastAt = now;
      return { traceId, posted: events.length, score: today.score };
    } catch (e) { log('[usage] scorecard post failed:', e.message); return { error: 'failed' }; }
  };
}

// Re-export so the scorecard tests can call buildScorecard without importing the full module.
export { buildScorecard } from '../scorecard.js';

async function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path);
}

async function main() {
  const cfg = defaults();
  const ing = createIngester(cfg);
  await ing.init(process.argv.includes('--backfill'));
  const once = process.argv.includes('--once') || process.argv.includes('--backfill');
  const postScore = createScorecardPoster(cfg, { ing });
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try { await ing.tick(); await ing.evalPass(); await ing.summary(); await postScore(); } catch (e) { console.error('[usage] pass failed:', e.message); }
    busy = false;
  };
  await pass();
  if (once) return;
  setInterval(pass, cfg.pollMs).unref?.();
  setInterval(() => ing.summary().catch((e) => console.error('[usage] summary:', e.message)), cfg.summaryMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
