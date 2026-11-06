// Claude account rotation (owner, 2026-11-06): several Claude subscriptions (a personal Max plan, then team seats) used one
// after the other. When the account in use runs out of its 5 h / weekly window, new Claude sessions start on the next
// account in the list, and a session stopped on the limit is restarted on it (park + `claude --resume`, same conversation).
// When an earlier account's window resets, new sessions go back to it (the list order is the preference order).
//
// One account = one Claude config dir (CLAUDE_CONFIG_DIR), logged in once with /login. The default account is ~/.claude
// (no CLAUDE_CONFIG_DIR). Extra dirs share the conversation data with ~/.claude through symlinks (projects, sessions,
// settings.json, ...), so a conversation started on one account resumes on another and the board still finds its sessions.
// Credentials (.credentials.json, .claude.json) are never shared, read or copied.
//
// State: $GHOSTY_STATE_DIR/claude-accounts.json { auto, autoSwapSessions, active, accounts:[{id,label,configDir}], marks:{id:{until,reason}} }
// Per-account limits: claude-rate-limits.json (default) / claude-rate-limits.<id>.json, written by the status-line script
// (scripts/claude-statusline-ratelimits.sh reads GHOSTY_CLAUDE_ACCOUNT, which the launch prefix sets).
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const LIMIT_PCT = 95;                 // a window at or above this counts as used up (quota.js CRIT_PCT)
export const MARK_DEFAULT_MS = 60 * 60e3;    // a limit stop with no known reset blocks the account this long
export const DEFAULT_ID = 'default';
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
// Shared with ~/.claude: conversation data and the owner's settings. Never the login.
export const SHARED = ['settings.json', 'CLAUDE.md', 'projects', 'sessions', 'todos', 'plans', 'file-history', 'shell-snapshots',
  'hooks', 'agents', 'commands', 'skills', 'plugins', 'output-styles', 'ide'];

// The pane's last lines say Claude stopped on a usage limit. Claude Code has printed several forms over time:
// "Claude usage limit reached. Your limit will reset at 5pm", "5-hour limit reached ∙ resets 3pm",
// "Weekly limit reached", "You've hit your limit · resets 4pm".
const LIMIT_RE = /\b(?:claude(?: ai)? usage limit reached|usage limit reached|(?:5-hour|weekly|session|opus(?: weekly)?|sonnet(?: weekly)?) limit reached|you(?:'|’)ve hit your (?:usage )?limit)\b/i;
const TAIL = 12;
export function scanClaudeLimit(lines) {
  const tail = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((x) => String(x ?? '')).filter((l) => l.trim()).slice(-TAIL);
  return tail.some((l) => LIMIT_RE.test(l));
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

export function rateFile(stateDir, id) {
  return join(stateDir, id === DEFAULT_ID ? 'claude-rate-limits.json' : `claude-rate-limits.${id}.json`);
}

// A clean config: the default account first unless listed, valid unique ids, absolute config dirs.
export function normalize(raw, home = homedir()) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const accounts = [];
  for (const a of Array.isArray(cfg.accounts) ? cfg.accounts : []) {
    const id = String(a?.id || '').toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const configDir = id === DEFAULT_ID ? null : (a.configDir ? resolve(expandHome(String(a.configDir), home)) : join(home, '.claude-accounts', id));
    accounts.push({ id, label: String(a.label || id).slice(0, 80), configDir });
  }
  if (!seen.has(DEFAULT_ID)) accounts.unshift({ id: DEFAULT_ID, label: 'Default (~/.claude)', configDir: null });
  const marks = {};
  for (const [id, m] of Object.entries(cfg.marks || {})) if (seen.has(id) || id === DEFAULT_ID) if (Number.isFinite(m?.until)) marks[id] = { until: m.until, reason: String(m.reason || '').slice(0, 200) };
  const ids = new Set(accounts.map((a) => a.id));
  return {
    auto: cfg.auto !== false,
    autoSwapSessions: cfg.autoSwapSessions !== false,
    active: ids.has(cfg.active) ? cfg.active : accounts[0].id,
    accounts, marks,
  };
}

// windows of one claude-rate-limits file (the status-line JSON): [{name, usedPercent, resetsAt, expired?}]
export function windowsOf(j, now) {
  const rl = j?.rate_limits || j || {};
  const out = [];
  for (const [k, name] of [['five_hour', '5h'], ['seven_day', 'week']]) {
    const w = rl[k];
    if (!w || !Number.isFinite(w.used_percentage)) continue;
    const resetsAt = Number.isFinite(w.resets_at) ? w.resets_at : null;
    if (resetsAt != null && resetsAt * 1000 <= now) out.push({ name, usedPercent: 0, resetsAt: null, expired: true });
    else out.push({ name, usedPercent: Math.round(w.used_percentage * 10) / 10, resetsAt });
  }
  return out;
}

// Is this account usable now? { exhausted, reset (ms | null), why }. No reading at all = usable (a fresh seat).
export function accountState({ windows = [], mark = null, now }) {
  const full = windows.filter((w) => !w.expired && Number.isFinite(w.usedPercent) && w.usedPercent >= LIMIT_PCT);
  const resets = full.map((w) => (w.resetsAt ? w.resetsAt * 1000 : null)).filter(Number.isFinite);
  if (mark && mark.until > now) {
    return { exhausted: true, reset: Math.max(mark.until, ...resets), why: mark.reason || 'limit reached' };
  }
  if (full.length) return { exhausted: true, reset: resets.length ? Math.max(...resets) : null, why: full.map((w) => `${w.name} ${Math.round(w.usedPercent)}%`).join(', ') };
  return { exhausted: false, reset: null, why: null };
}

// Which account new sessions use. auto off: the chosen one. Auto: the first usable one in list order; none usable: the one
// that frees up first (unknown reset last), so a session started anyway waits the least.
export function pickAccount(cfg, states, { exclude = [] } = {}) {
  if (!cfg.auto) return cfg.active;
  const list = cfg.accounts.filter((a) => !exclude.includes(a.id));
  const free = list.find((a) => !states[a.id]?.exhausted);
  if (free) return free.id;
  if (exclude.length) return null;   // a swap needs another usable account, not the least bad one
  const byReset = [...list].sort((x, y) => (states[x.id]?.reset ?? Infinity) - (states[y.id]?.reset ?? Infinity));
  return byReset[0]?.id ?? cfg.active;
}

// What goes in front of the claude command to run it on this account.
export function launchPrefix(acct) {
  if (!acct || !acct.configDir) return '';
  return `CLAUDE_CONFIG_DIR=${shq(acct.configDir)} GHOSTY_CLAUDE_ACCOUNT=${acct.id} `;
}

// The account a running claude process was started on (its environment). Default when unset or unreadable.
export function accountOfPid(pid, read = (p) => readFileSync(p, 'utf8')) {
  if (!pid) return null;
  try {
    const env = read(`/proc/${pid}/environ`).split('\0');
    const v = env.find((e) => e.startsWith('GHOSTY_CLAUDE_ACCOUNT='));
    const id = v ? v.slice('GHOSTY_CLAUDE_ACCOUNT='.length) : DEFAULT_ID;
    return ID_RE.test(id) ? id : DEFAULT_ID;
  } catch { return null; }
}

// Create an account's config dir and link the shared parts of ~/.claude into it. Existing entries are left alone.
export async function setupConfigDir(dir, { home = homedir(), base = join(home, '.claude') } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const linked = [];
  for (const name of SHARED) {
    const src = join(base, name), dst = join(dir, name);
    try { await fs.lstat(src); } catch { continue; }
    try { await fs.lstat(dst); continue; } catch { /* missing: link it */ }
    await fs.symlink(src, dst);
    linked.push(name);
  }
  return linked;
}

export function createClaudeAccounts({ file, stateDir, home = homedir(), now = Date.now } = {}) {
  let cfg = null, states = {}, readings = {};
  const load = () => {
    if (cfg) return cfg;
    try { cfg = normalize(JSON.parse(readFileSync(file, 'utf8')), home); } catch { cfg = normalize({}, home); }
    return cfg;
  };
  async function save() {
    const out = { ...cfg, accounts: cfg.accounts.map((a) => ({ id: a.id, label: a.label, ...(a.configDir ? { configDir: a.configDir } : {}) })) };
    await fs.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  const byId = (id) => load().accounts.find((a) => a.id === id) || null;
  const httpErr = (status, message) => Object.assign(new Error(message), { status });

  // Read every account's limits, drop expired marks, re-pick the active account. Returns { changed, from, to }.
  async function refresh() {
    const c = load(), t = now();
    for (const a of c.accounts) {
      let j = null, at = null;
      try { j = JSON.parse(await fs.readFile(rateFile(stateDir, a.id), 'utf8')); at = Number(j.at) || null; } catch { /* no reading yet */ }
      readings[a.id] = { windows: j ? windowsOf(j, t) : [], at };
    }
    let dirty = false;
    for (const [id, m] of Object.entries(c.marks)) if (m.until <= t) { delete c.marks[id]; dirty = true; }
    states = Object.fromEntries(c.accounts.map((a) => [a.id, accountState({ windows: readings[a.id].windows, mark: c.marks[a.id], now: t })]));
    const from = c.active, to = pickAccount(c, states);
    if (to && to !== from) { c.active = to; dirty = true; }
    if (dirty) await save();
    return { changed: !!to && to !== from, from, to: c.active };
  }

  return {
    config: () => load(),
    active: () => byId(load().active),
    byId,
    states: () => states,
    commandFor(base, id = load().active) { return `${launchPrefix(byId(id))}${base}`; },
    claudeJsonFor(id = load().active) { const a = byId(id); return a?.configDir ? join(a.configDir, '.claude.json') : null; },
    refresh,
    // The account behind `id` hit its limit: block it until `until` (ms) or its window's reset, then re-pick.
    async markExhausted(id, { until = null, reason = 'usage limit reached' } = {}) {
      const c = load(), t = now();
      if (!byId(id)) return null;
      const reset = accountState({ windows: readings[id]?.windows || [], now: t }).reset;
      c.marks[id] = { until: until || reset || t + MARK_DEFAULT_MS, reason };
      await save();
      return refresh();
    },
    // Another usable account than `id`, or null (none left: the session waits for its reset).
    nextFor(id) { return pickAccount({ ...load(), auto: true }, states, { exclude: [id] }); },
    view() {
      const c = load();
      return {
        auto: c.auto, autoSwapSessions: c.autoSwapSessions, active: c.active,
        accounts: c.accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir, active: a.id === c.active,
          windows: readings[a.id]?.windows || [], at: readings[a.id]?.at ?? null, ...(states[a.id] || { exhausted: false, reset: null, why: null }) })),
      };
    },
    async add({ id, label, configDir } = {}) {
      id = String(id || '').toLowerCase();
      if (!ID_RE.test(id) || id === DEFAULT_ID) throw httpErr(400, 'id must be a-z 0-9 _ - (max 24), not "default"');
      const c = load();
      if (byId(id)) throw httpErr(409, 'account already exists');
      const dir = configDir ? resolve(expandHome(String(configDir), home)) : join(home, '.claude-accounts', id);
      if (dir === join(home, '.claude')) throw httpErr(400, 'that is the default account dir');
      const linked = await setupConfigDir(dir, { home });
      c.accounts.push({ id, label: String(label || id).slice(0, 80), configDir: dir });
      await save();
      await refresh();
      return { id, configDir: dir, linked };
    },
    async remove(id) {
      const c = load();
      if (id === DEFAULT_ID) throw httpErr(400, 'the default account cannot be removed');
      if (!byId(id)) throw httpErr(404, 'no such account');
      c.accounts = c.accounts.filter((a) => a.id !== id);
      delete c.marks[id];
      if (c.active === id) c.active = c.accounts[0].id;
      await save();   // the config dir (and its login) stays on disk: deleting a login is the owner's call
      await refresh();
      return { ok: true };
    },
    // Owner settings: { active } (turns auto off unless auto is given too), { auto }, { autoSwapSessions }, { order:[ids] }, { clearMark: id }.
    async set(body = {}) {
      const c = load();
      if (Array.isArray(body.order)) {
        const pos = new Map(body.order.map((id, i) => [id, i]));
        c.accounts.sort((x, y) => (pos.get(x.id) ?? 1e9) - (pos.get(y.id) ?? 1e9));
      }
      if (typeof body.autoSwapSessions === 'boolean') c.autoSwapSessions = body.autoSwapSessions;
      if (typeof body.clearMark === 'string') delete c.marks[body.clearMark];
      if (body.active !== undefined) {
        if (!byId(body.active)) throw httpErr(404, 'no such account');
        c.active = body.active;
        c.auto = typeof body.auto === 'boolean' ? body.auto : false;
      } else if (typeof body.auto === 'boolean') c.auto = body.auto;
      await save();
      await refresh();
      return this.view();
    },
  };
}
