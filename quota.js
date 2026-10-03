// Subscription quota (TASK-44 phase 5): how full the plans' windows are, read-only and cheap.
//   codex    `codex app-server` (JSON-RPC over stdio), method account/rateLimits/read: the account's live
//            5 h / weekly windows. Makes no model call. Polled every 5 minutes.
//   claude   $GHOSTY_STATE_DIR/claude-rate-limits.json, written by scripts/claude-statusline-ratelimits.sh
//            (Claude Code hands `rate_limits` to a status-line command; there is no limit file on disk)
//   minimax  the HTTPS calls mcode's /usage makes, with mcode's stored login (read at request time, in
//            memory only). Polled every 5 minutes. It never refreshes the login: an expired one is
//            reported as stale until mcode is opened once.
// Each plan: { plan, label, price, windows:[{name, usedPercent, resetsAt, unlimited?}], source, at, stale, error?, note? }
// A failed read keeps the last good value with stale:true and an error. Never types into a session.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const POLL_MS = 5 * 60e3;   // Codex and MiniMax are asked at most this often; polls in between serve the cache
const CODEX_TIMEOUT_MS = 20e3;
const HTTP_TIMEOUT_MS = 10e3;

export const WARN_PCT = 80;     // alert when a window crosses this
export const REARM_PCT = 70;    // and again only after it dropped below this

export function defaults(env = process.env) {
  const home = homedir();
  const stateDir = env.GHOSTY_STATE_DIR || join(home, '.local/state/ghosty');
  return {
    codexCmd: { file: env.CODEX_BIN || join(home, '.local/bin/codex'), args: ['app-server'] },
    minimaxAuthFile: env.MINIMAX_AUTH_FILE || join(home, '.minimax/auth/prod/en/mcode-public/auth.json'),
    claudeFile: env.CLAUDE_RATE_LIMITS_FILE || join(stateDir, 'claude-rate-limits.json'),
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
  };
}

const winName = (minutes) => (minutes === 300 ? '5h' : minutes === 10080 ? 'week' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);
const pctOf = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// A window whose reset time has passed has been refilled since the reading: report it as 0 / expired.
function finishWindow(w, now) {
  if (w.unlimited) return w;
  if (w.resetsAt != null && w.resetsAt * 1000 <= now) return { ...w, usedPercent: 0, resetsAt: null, expired: true };
  return w;
}

// ---- Codex ----
function windowsOf(rl) {
  const windows = [];
  for (const k of ['primary', 'secondary']) {
    const w = rl?.[k];
    if (!w || !Number.isFinite(w.windowDurationMins)) continue;
    windows.push({ name: winName(w.windowDurationMins), minutes: w.windowDurationMins, usedPercent: pctOf(w.usedPercent), resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null });
  }
  return windows;
}

// One round trip with `codex app-server`: initialize -> initialized -> account/rateLimits/read, then the
// child is killed. Resolves to result.rateLimits. No shell; the child never sees a model request.
export function askCodex(cmd, { timeoutMs = CODEX_TIMEOUT_MS, cwd = homedir() } = {}) {
  return new Promise((resolve, reject) => {
    let child, done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child?.kill('SIGKILL'); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`codex app-server timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    try { child = spawn(cmd.file, cmd.args || ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], shell: false }); }
    catch (e) { return finish(e); }
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`codex app-server exited (${code}) before answering`)));
    child.stdin.on('error', () => {});
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        if (m.error) return finish(new Error(`codex initialize: ${m.error.message || 'error'}`));
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' });
      } else if (m.id === 2) {
        if (m.error) return finish(new Error(`codex rateLimits: ${m.error.message || 'error'}`));
        const rl = m.result?.rateLimits;
        rl ? finish(null, rl) : finish(new Error('codex rateLimits: no rateLimits in the reply'));
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'ghosty-quota', version: '0.1' } } });
  });
}

// Last good reading per source, so a failed poll can still show it (stale) with the error.
const good = new WeakMap();   // keyed per cfg object
const stateOf = (cfg, key) => {
  let m = good.get(cfg); if (!m) good.set(cfg, m = {});
  return (m[key] ||= { value: null, at: 0 });
};
// Serve the cached reading inside POLL_MS; otherwise ask. On failure: last good + stale + error.
async function cachedRead(cfg, key, now, base, ask) {
  const st = stateOf(cfg, key);
  if (st.value && now - st.at < POLL_MS) return st.value;
  try {
    const value = await ask();
    st.value = value; st.at = now;
    return value;
  } catch (e) {
    const err = e?.message || String(e);
    if (!st.value) return { ...base, error: err };
    st.value = { ...st.value, stale: true, error: err };
    st.at = now - POLL_MS;   // a failure is not cached: the next poll asks again
    return st.value;
  }
}

export async function readCodex(cfg, now) {
  const base = { plan: 'codex', label: 'Codex', price: '20 EUR/month (ChatGPT Plus)', windows: [], source: 'codex app-server', at: null, stale: true };
  const out = await cachedRead(cfg, 'codex', now, base, async () => {
    const rl = await askCodex(cfg.codexCmd);
    const windows = windowsOf(rl);
    if (!windows.length) throw new Error('codex rateLimits: no windows in the reply');
    return { ...base, windows, at: now, stale: false, planType: rl.planType || null };
  });
  return { ...out, windows: out.windows.map((w) => finishWindow(w, now)) };
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

// ---- MiniMax ----
// The usage call mcode's /usage makes: a plain bearer-token GET on platform.minimax.io. (Plan name and
// expiry would need mcode's signed client calls; deliberately not replicated.)
const MM_QUOTA_URL = 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains';
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

// Default token reader: mcode's login file, read now and never kept. { accessToken, expiresAtMs } | null.
export async function readMinimaxLogin(file) {
  const j = JSON.parse(await fs.readFile(file, 'utf8'));
  const rec = Object.entries(j?.records || {}).find(([k, v]) => k.startsWith('com.minimax.mcode.oauth.') && typeof v?.accessToken === 'string');
  return rec ? { accessToken: rec[1].accessToken, expiresAtMs: Number(rec[1].expiresAtMs) || null } : null;
}

async function httpJson(cfg, url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await cfg.fetch(url, { ...init, signal: ac.signal });
    if (r.status === 401 || r.status === 403) throw new Error('mcode login expired — open mcode once');
    if (!r.ok) throw new Error(`minimax HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// One interval/weekly entry of model_remains -> window. status 3 = unlimited.
export function minimaxWindow(e, name, kind) {
  const p = kind === 'interval' ? 'current_interval' : 'current_weekly';
  const end = Number(e[kind === 'interval' ? 'end_time' : 'weekly_end_time']);
  const resetsAt = end > 0 ? Math.round(end / 1000) : null;
  if (e[`${p}_status`] === 3) return { name, usedPercent: null, resetsAt, unlimited: true };
  let remaining = Number(e[`${p}_remaining_percent`]);
  if (!Number.isFinite(remaining)) {
    const total = Number(e[`${p}_total_count`]), used = Number(e[`${p}_usage_count`]);
    remaining = total > 0 && Number.isFinite(used) ? 100 - (used / total) * 100 : NaN;
  }
  return { name, usedPercent: Number.isFinite(remaining) ? pctOf(100 - Math.min(100, Math.max(0, remaining))) : null, resetsAt };
}

export function parseMinimaxRemains(body) {
  const code = body?.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) throw new Error(`minimax status ${code}`);
  const e = Array.isArray(body?.model_remains) ? body.model_remains.find(isObj) : null;
  if (!e) throw new Error('minimax: no model_remains in the reply');
  return [minimaxWindow(e, '5h', 'interval'), minimaxWindow(e, 'week', 'weekly')];
}

export async function readMinimax(cfg, now) {
  const base = { plan: 'minimax', label: 'MiniMax', price: '40 EUR/month (Token Plan)', windows: [], source: 'minimax coding_plan/remains', at: null, stale: true };
  return cachedRead(cfg, 'minimax', now, base, async () => {
    const login = await (cfg.minimaxLogin ? cfg.minimaxLogin() : readMinimaxLogin(cfg.minimaxAuthFile));
    if (!login?.accessToken) throw new Error('mcode login expired — open mcode once');
    if (login.expiresAtMs && login.expiresAtMs <= now) throw new Error('mcode login expired — open mcode once');
    const body = await httpJson(cfg, MM_QUOTA_URL, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${login.accessToken}` } });
    return { ...base, windows: parseMinimaxRemains(body), at: now, stale: false };
  }).then((out) => ({ ...out, windows: out.windows.map((w) => finishWindow(w, now)) }));
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
