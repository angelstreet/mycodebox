// Subscription quota (TASK-44 phase 5): how full the plans' windows are, read-only and cheap.
//   codex    newest `rate_limits` event at the tail of the newest ~/.codex/sessions/**/*.jsonl
//   claude   $GHOSTY_STATE_DIR/claude-rate-limits.json, written by scripts/claude-statusline-ratelimits.sh
//            (Claude Code hands `rate_limits` to a status-line command; there is no limit file on disk)
//   minimax  token counts from ~/.minimax/v2/sqlite/runtime-state.sqlite (it stores no plan limit,
//            so usedPercent is null and the tokens are reported instead)
// Each plan: { plan, label, price, windows:[{name, usedPercent, resetsAt, ...}], source, at, stale, note? }
// Never reads credentials and never types into a session.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAIL_BYTES = 256 * 1024;
const HOUR = 3600e3;

export const WARN_PCT = 80;     // alert when a window crosses this
export const REARM_PCT = 70;    // and again only after it dropped below this

export function defaults(env = process.env) {
  const home = homedir();
  const stateDir = env.GHOSTY_STATE_DIR || join(home, '.local/state/ghosty');
  return {
    codexDir: env.CODEX_SESSIONS_DIR || join(home, '.codex/sessions'),
    minimaxDb: env.MINIMAX_DB || join(home, '.minimax/v2/sqlite/runtime-state.sqlite'),
    claudeFile: env.CLAUDE_RATE_LIMITS_FILE || join(stateDir, 'claude-rate-limits.json'),
    now: () => Date.now(),
  };
}

const winName = (minutes) => (minutes === 300 ? '5h' : minutes === 10080 ? 'week' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);
const pctOf = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// A window whose reset time has passed has been refilled since the reading: report it as 0 / expired.
function finishWindow(w, now) {
  if (w.resetsAt != null && w.resetsAt * 1000 <= now) return { ...w, usedPercent: 0, resetsAt: null, expired: true };
  return w;
}

// Newest `rate_limits` object in a chunk of rollout text: { at, plan_type, windows[] } | null.
export function parseCodexRateLimits(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"rate_limits"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }   // the first line of a tail can be cut off
    const rl = o?.payload?.rate_limits || o?.rate_limits;
    if (!rl || typeof rl !== 'object') continue;
    const windows = [];
    for (const k of ['primary', 'secondary']) {
      const w = rl[k];
      if (!w || !Number.isFinite(w.window_minutes)) continue;
      windows.push({ name: winName(w.window_minutes), minutes: w.window_minutes, usedPercent: pctOf(w.used_percent), resetsAt: Number.isFinite(w.resets_at) ? w.resets_at : null });
    }
    if (windows.length) return { at: Date.parse(o.timestamp) || null, planType: rl.plan_type || null, windows };
  }
  return null;
}

async function readTail(path, bytes = TAIL_BYTES) {
  const fh = await fs.open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

// Rollout files, newest day directory first (YYYY/MM/DD), each day's files newest mtime first.
async function* rolloutsNewestFirst(root) {
  const sub = async (d) => { try { return (await fs.readdir(d)).filter((x) => /^\d+$/.test(x)).sort().reverse(); } catch { return []; } };
  for (const y of await sub(root)) for (const m of await sub(join(root, y))) for (const d of await sub(join(root, y, m))) {
    const dir = join(root, y, m, d);
    let files = [];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const withTime = [];
    for (const f of files) { try { withTime.push([f, (await fs.stat(join(dir, f))).mtimeMs]); } catch {} }
    withTime.sort((a, b) => b[1] - a[1]);
    for (const [f, mtime] of withTime) yield { path: join(dir, f), mtime };
  }
}

export async function readCodex(cfg, now) {
  const base = { plan: 'codex', label: 'Codex', price: '20 EUR/month (ChatGPT Plus)', windows: [], source: 'codex rollout', at: null, stale: true };
  try {
    let tried = 0;
    for await (const f of rolloutsNewestFirst(cfg.codexDir)) {
      const r = parseCodexRateLimits(await readTail(f.path));
      if (r) {
        const at = r.at || f.mtime;
        return { ...base, windows: r.windows.map((w) => finishWindow(w, now)), at, stale: now - at > 10 * 60e3, planType: r.planType };
      }
      if (++tried >= 5) break;   // the newest few rollouts without a rate_limits event: give up for this poll
    }
    return { ...base, note: 'no rate_limits event in the newest Codex sessions' };
  } catch (e) { return { ...base, note: e.code === 'ENOENT' ? 'no Codex sessions directory' : `codex: ${e.message}` }; }
}

export async function readClaude(cfg, now) {
  const base = { plan: 'claude', label: 'Claude Max', price: '200 EUR/month', windows: [], source: 'status-line hook', at: null, stale: true };
  let j;
  try { j = JSON.parse(await fs.readFile(cfg.claudeFile, 'utf8')); }
  catch { return { ...base, note: 'not available: install scripts/claude-statusline-ratelimits.sh as the Claude Code status line' }; }
  const rl = j.rate_limits || j;
  const windows = [];
  for (const [k, name] of [['five_hour', '5h'], ['seven_day', 'week']]) {
    const w = rl[k];
    if (w && Number.isFinite(w.used_percentage)) windows.push(finishWindow({ name, usedPercent: pctOf(w.used_percentage), resetsAt: Number.isFinite(w.resets_at) ? w.resets_at : null }, now));
  }
  const at = Number(j.at) || (await fs.stat(cfg.claudeFile).then((s) => s.mtimeMs, () => null));
  return { ...base, windows, at, stale: !at || now - at > 30 * 60e3, note: windows.length ? undefined : 'no rate_limits in the last status-line input (needs a Pro/Max login and one reply)' };
}

export async function readMinimax(cfg, now) {
  const base = { plan: 'minimax', label: 'MiniMax', price: '40 EUR/month (Token Plan)', windows: [], source: 'minimax runtime sqlite', at: null, stale: true,
    note: 'no plan limit is stored locally - tokens only' };
  try {
    await fs.access(cfg.minimaxDb);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(cfg.minimaxDb, { readOnly: true });
    try {
      const d = new Date(now);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const q = db.prepare('SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COUNT(*) AS turns FROM local_runtime_token_usage WHERE ts >= ?');
      const last = db.prepare('SELECT MAX(ts) AS ts FROM local_runtime_token_usage').get().ts;
      const win = (name, since) => ({ name, usedPercent: null, resetsAt: null, ...q.get(since) });
      return { ...base, windows: [win('5h', now - 5 * HOUR), win('month', monthStart)], at: now, stale: false, lastUsedAt: last || null };
    } finally { db.close(); }
  } catch (e) { return { ...base, note: e.code === 'ENOENT' ? 'no MiniMax database' : `minimax: ${e.message}` }; }
}

// Edge-triggered alerts: one when a window crosses WARN_PCT, re-armed only after it is back under
// REARM_PCT. The first reading after start only seeds the state (an already-high window is not news).
export function createQuotaAlerts(alert) {
  const armed = new Map();   // "plan:window" -> true while above (already alerted)
  let seeded = false;
  return {
    check(plans) {
      for (const p of plans) for (const w of p.windows) {
        if (w.usedPercent == null) continue;
        const key = `${p.plan}:${w.name}`;
        const above = armed.get(key) === true;
        if (!above && w.usedPercent >= WARN_PCT) {
          armed.set(key, true);
          if (seeded) alert(`quota:${key}`, {
            title: `${p.label} ${w.name} quota at ${Math.round(w.usedPercent)}%`,
            body: w.resetsAt ? `resets ${new Date(w.resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'reset time unknown',
            priority: 'high', ntfyTags: 'warning', url: '/', tag: `ghosty-quota-${key}`,
          }, 0);
        } else if (above && w.usedPercent < REARM_PCT) armed.set(key, false);
      }
      seeded = true;
    },
  };
}

export function createQuota({ cfg = defaults(), alert = () => {}, onChange = () => {} } = {}) {
  let value = { at: 0, plans: [] };
  const alerts = createQuotaAlerts(alert);
  async function poll() {
    const now = cfg.now();
    const plans = await Promise.all([readCodex(cfg, now), readClaude(cfg, now), readMinimax(cfg, now)]);
    value = { at: now, plans };
    alerts.check(plans);
    onChange(value);
    return value;
  }
  return { poll, get: () => value };
}
