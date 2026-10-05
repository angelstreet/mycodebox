// Session cap + parking (TASK-58 C8). A parked Claude session = its conversation id and folder recorded in parked.json, Claude exited
// cleanly and the tmux session removed (RAM freed); the worktree is untouched. Resume recreates the tmux session in the same folder
// and runs `claude --resume <id>`.
//
// Facts come from Claude itself: ~/.claude/sessions/<pid>.json ({sessionId, cwd, name, status: idle|busy|shell, statusUpdatedAt}).
// The tmux name in that file goes stale when a session is renamed, so a pane is matched to its Claude through the process tree.
// Pure helpers are exported for tests; createParking() takes its IO (tmux, ps, files, leases) as injected functions.

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SESSION_CAP = 10;
const DIR_TTL_MS = 5000;

// Claude's own session files, cached a few seconds: Map<pid, {pid, sessionId, cwd, name, status, statusUpdatedAt, ...}>.
export function createClaudeIndex({ dir, now = Date.now, ttlMs = DIR_TTL_MS }) {
  let cache = { at: 0, map: new Map() };
  async function get(force = false) {
    if (!force && now() - cache.at < ttlMs) return cache.map;
    const map = new Map();
    try {
      for (const f of await readdir(dir)) {
        if (!/^\d+\.json$/.test(f)) continue;
        try {
          const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
          if (j && typeof j.sessionId === 'string' && Number.isInteger(j.pid)) map.set(j.pid, j);
        } catch { /* half-written or gone */ }
      }
    } catch { /* no dir: nothing known */ }
    cache = { at: now(), map };
    return map;
  }
  return { get };
}

// Pids under `root` (breadth first, depth <= 8) whose args look like claude; table = { children: Map, args: Map }.
export function claudePidsUnder(root, table) {
  const out = [];
  const seen = new Set();
  let level = [root];
  for (let d = 0; level.length && d < 8; d++) {
    const next = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      const a = table.args.get(p) || '';
      if (/(?:^|\/)claude(?:\s|$)/.test(a)) out.push(p);
      next.push(...(table.children.get(p) || []));
    }
    level = next;
  }
  return out;
}

// The Claude of a pane: the first claude-looking pid in its tree that has a Claude session file (skips `bash -c "claude ..."` wrappers).
export function claudeOfPane(panePid, table, index) {
  for (const pid of claudePidsUnder(panePid, table)) {
    const info = index.get(pid);
    if (info) return { pid, info, args: table.args.get(pid) || '' };
  }
  return null;
}

// Child processes of the Claude pid that are not MCP servers: a running background command / job.
export function busyChildren(pid, table) {
  return (table.children.get(pid) || []).map((c) => ({ pid: c, args: table.args.get(c) || '' })).filter((c) => !/mcp/i.test(c.args));
}

// Newest activity of a Claude session in ms: Claude's own idle/busy stamp, or the reporter's last turn / prompt, whichever is later.
export function lastActivityOf({ info, reporterAt }) {
  const a = Number(info?.statusUpdatedAt) || 0;
  const b = Number(reporterAt) || 0;
  if (!a && !b) return null;
  return b > a ? { at: b, source: 'reporter' } : { at: a, source: 'claude' };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Same launch as the session had: ghosty's claude command (AGENT_CMDS.claude) + the model and remote-control the old process had + --resume.
export function resumeCommand({ base, args, name, sessionId }) {
  const parts = [base];
  const model = /--model[= ]([A-Za-z0-9._\[\]-]+)/.exec(args || '');
  if (model && !/--model\b/.test(base)) parts.push('--model', model[1]);
  if (/--remote-control\b/.test(args || '') && name) parts.push('--remote-control', shq(name), '-n', shq(name));
  parts.push('--resume', sessionId);
  return parts.join(' ');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Leases (vpt-lease list) that belong to this session: agent / purpose / resource mentions its tmux name or its Claude name.
export function leasesOfSession(leases, names) {
  const keys = names.map(norm).filter((k) => k.length >= 4);
  return (leases || []).filter((l) => { const hay = norm(`${l.agent} ${l.purpose} ${l.id}`); return keys.some((k) => hay.includes(k)); });
}

// Cap view: live Claude sessions and, when over the cap, the idle-longest ones as parking candidates.
export function capView({ sessions, cap = SESSION_CAP, now = Date.now() }) {
  const live = sessions.filter((s) => s.agent === 'claude' && s.state !== 'offline');
  const over = Math.max(0, live.length - cap);
  const idleLongest = live
    .filter((s) => s.state === 'idle' || s.state === 'done')
    .sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0))
    .map((s) => ({ name: s.name, lastActivity: s.lastActivity ?? null, idleMin: s.lastActivity ? Math.round((now - s.lastActivity) / 60000) : null, rssMb: s.rssMb ?? null }));
  return { cap, live: live.length, over, candidates: over ? idleLongest.slice(0, Math.max(over + 3, 5)) : [] };
}

export const fmtIdle = (min) => (min == null ? 'unknown' : min >= 2880 ? `${Math.round(min / 1440)}d` : min >= 120 ? `${Math.round(min / 60)}h` : `${min}m`);

export function createParking({ file, tmux, exitWaitMs = 30000, pollMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  // tmux = { exists(name), kill(name), sendText(name, text), sendEnter(name), create(name, cwd) }
  let data = { parked: {} };
  let loaded = false;
  async function load() {
    if (loaded) return;
    loaded = true;
    try { const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j.parked === 'object') data = { parked: j.parked }; } catch { /* first run */ }
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, file);
  }
  const err = (status, message, reasons) => Object.assign(new Error(message), { status, reasons });
  return {
    async list() { await load(); return Object.values(data.parked).sort((a, b) => b.parkedAt - a.parkedAt); },
    async get(name) { await load(); return data.parked[name] || null; },
    // facts = { claude: {pid, info, args}|null, state, attached, reporterWaiting, backgroundWork, busy[], leases[]|null, rssMb, priority }
    // Returns the list of reasons the session may not be parked (empty = ok).
    checks(facts) {
      const r = [];
      if (!facts.claude) return ['no Claude process with a session file in this pane'];
      if (facts.claude.info.status !== 'idle') r.push(`Claude status is "${facts.claude.info.status}", not idle`);
      if (facts.state && !['idle', 'done'].includes(facts.state)) r.push(`board state is ${facts.state}`);
      if (facts.attached) r.push('a terminal is attached');
      if (facts.reporterWaiting) r.push('a permission prompt / question is pending');
      if (facts.backgroundWork > 0) r.push(`${facts.backgroundWork} background job(s) reported`);
      if (facts.busy?.length) r.push(`running child process: ${facts.busy[0].args.slice(0, 80)}`);
      if (facts.leases == null) r.push('could not read vpt-lease (cannot prove no lease is held)');
      else if (facts.leases.length) r.push(`holds vpt-lease: ${facts.leases.map((l) => l.id).join(', ')}`);
      if (!facts.claude.info.sessionId) r.push('no resumable session id');
      return r;
    },
    // Records the session, exits Claude with /exit, kills the tmux session only once the claude process is gone.
    async park(name, facts, { claudeAlive }) {
      await load();
      const reasons = this.checks(facts);
      if (reasons.length) throw err(409, `not parked: ${reasons.join('; ')}`, reasons);
      const { info, args } = facts.claude;
      const rec = { session: name, cwd: info.cwd, sessionId: info.sessionId, claudeName: info.name || name, args: args.slice(0, 400), priority: facts.priority || null, rssMb: facts.rssMb ?? null, lastActivity: info.statusUpdatedAt || null, parkedAt: now() };
      data.parked[name] = rec;
      await save();                       // the id is on disk before anything is closed
      await tmux.sendText(name, '/exit');
      await sleep(300);
      await tmux.sendEnter(name);
      const t0 = now();
      let gone = false;
      while (now() - t0 < exitWaitMs) {
        if (!(await claudeAlive(facts.claude.pid))) { gone = true; break; }
        await sleep(pollMs);
      }
      if (!gone) {
        delete data.parked[name];
        await save();
        throw err(500, 'Claude did not exit within the wait; session left running, nothing killed');
      }
      await tmux.kill(name);
      return rec;
    },
    // Recreates the tmux session in the recorded folder and starts Claude with --resume.
    async resume(name, { base, start }) {
      await load();
      const rec = data.parked[name];
      if (!rec) throw err(404, 'not parked');
      if (await tmux.exists(name)) throw err(409, 'a tmux session with that name already exists');
      await tmux.create(name, rec.cwd);
      const cmd = resumeCommand({ base, args: rec.args, name: rec.claudeName, sessionId: rec.sessionId });
      await start(name, rec, cmd);
      delete data.parked[name];
      await save();
      return { ...rec, cmd };
    },
  };
}
