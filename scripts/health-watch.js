#!/usr/bin/env node
// Token-free codebox health watchdog (run every 5 min by systemd/ghosty-health-watch.timer).
//
// 1. CHECK (cheap): disk % of /, load vs cores (sustained), RAM available %, runaway processes, stuck patterns.
//    Healthy -> exit 0, nothing written but the tiny state file.
// 2. INVESTIGATE (only when a check trips): markdown report in ~/.local/state/ghosty/health-reports/ (kept 7 days).
// 3. SAFE AUTO-FIX (only when the disk check trips): see fixLevel in the config file.
// 4. WAKE THE MANAGER (one line in manager-events.jsonl, kind 'health') only if a problem REMAINS after the
//    fixes or needs a decision. Debounced 6 h per issue key unless it worsened.
//
// Flags: --force   investigate even if healthy
//        --dry-run delete nothing, write no event (report + state sample are still written)
// No dependencies, no AI calls.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, statfsSync, rmSync, opendirSync, realpathSync, readlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, cpus, loadavg, tmpdir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = {
  diskPct: 85,            // trip when / is at least this full
  inodePct: 85,           // trip when / has at least this % of its inodes used
  loadPerCore: 1.0,       // trip when load1 AND load5 per core exceed this ...
  loadMinutes: 10,        // ... for this long (state file keeps the samples)
  ramAvailPct: 10,        // trip when MemAvailable is below this % of MemTotal
  runawayHours: 2,        // runaway = owned by this user, older than this, AND ...
  runawayRssMB: 1024,     // ... RSS above this, OR ...
  runawayCpu: 80,         // ... CPU above this % between two samples 5 s apart
  defunctMax: 50,         // stuck pattern: more defunct processes than this
  testLeftoverMin: 60,    // an orphaned test run (its parent gone) older than this is killed at fix level cleanup and up
  scratchMaxAgeDays: 2,   // /tmp/claude-1000 session scratch older than this (and session dead) is deletable
  npmCacheMB: 1024,       // npm cache is cleaned only above this size
  debounceHours: 6,       // same issue key is written to the manager feed at most once per this
  fixLevel: 'cleanup',    // report | cleanup | cleanup+orphans | cleanup+worktrees | cleanup+all (orphans and worktrees are separate opt-ins)
  // A worktree whose git state changed within this many minutes is never removed: an agent that just created it has
  // not written a file yet, so "clean" says nothing about whether anyone is working there (E51, 2026-10-23). The
  // timer runs every ~5 min, so 30 min (six ticks) still reclaims an abandoned worktree quickly.
  worktreeActiveMin: 30,
  // Which repos' REGISTERED worktrees may be considered, and where such a worktree may live.
  // Both live in the state-dir config (never in this tracked file): worktreeRepos = { label: '/abs/path/to/repo' },
  // worktreeRoots = ['/abs/root', ...]. No repo and no root => nothing is a candidate. The deletion criteria
  // (clean, merged, no live session) do not change; this only says WHICH paths are looked at.
  worktreeRepos: {},     // { label: '/abs/path/to/repo' } - only these repos' registered worktrees are candidates
  worktreeRoots: [],     // allowed roots: a candidate worktree must live under one of them
};
export const FIX_LEVELS = ['report', 'cleanup', 'cleanup+orphans', 'cleanup+worktrees', 'cleanup+all'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// How much worse an issue must get (severity units) to bypass the debounce.
const WORSEN_STEP = { disk: 3, ram: 5 };

// ---------------------------------------------------------------- pure helpers (tested)

// Load trips only when every sample of the last `minutes` is over the limit and the samples cover (almost) that span.
export function evalLoad(samples, now, cores, perCore, minutes) {
  const limit = perCore * cores;
  const spanMs = minutes * 60000;
  const win = samples.filter((s) => s.t >= now - spanMs - 90000);
  if (win.length < 2) return { tripped: false, limit };
  const covered = now - Math.min(...win.map((s) => s.t));
  if (covered < spanMs * 0.9) return { tripped: false, limit };
  const over = win.every((s) => s.load1 > limit && s.load5 > limit);
  return { tripped: over, limit };
}

export function isStuckNodeTest(args) {
  return /(^|\/)node(\s+--?[\w-]+(=\S+)?)*\s+--test\s*$/.test(String(args || '').trim());
}

// A test run whose parent is gone: node --test / test files, vitest and its tinypool workers, the fake git/tmux bins the
// mycodebox tests put in /tmp/*fresh-*/bin. 26 of them (88 processes with children) sat for up to 3.8 days on 2026-10-15.
const TEST_ARGS_RE = /(^|\/)node\b[^\n]*(?:\s--test\b|\stest\/\S+\.test\.[cm]?[jt]sx?\b)|\bvitest\b|\btinypool\b|\/tmp\/[\w.-]*fresh-\w+\/bin\/|freeze-assert/;
export const isTestArgs = (args) => TEST_ARGS_RE.test(String(args || ''));
// procs: [{pid, ppid, etimes, args, mine}] -> [{ pid, args, etimes, pids }] : orphan roots (ppid 1) older than minMin whose
// own args or any descendant's args look like a test run; pids = the root and all its descendants.
export function findTestLeftovers(procs, minMin, protectedPids = new Set()) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = [];
  for (const r of procs) {
    if (!r.mine || r.ppid !== 1 || r.etimes < minMin * 60 || protectedPids.has(r.pid) || SKIP_RUNAWAY(r, protectedPids)) continue;
    const tree = [], stack = [r];
    while (stack.length) { const x = stack.pop(); tree.push(x); stack.push(...(kids.get(x.pid) || [])); }
    if (tree.some((x) => isTestArgs(x.args))) out.push({ pid: r.pid, args: r.args, etimes: r.etimes, pids: tree.map((x) => x.pid) });
  }
  return out;
}

const SKIP_RUNAWAY = (p, protectedPids) =>
  protectedPids.has(p.pid) || /^(claude|tmux)\b/.test(basename(p.args.split(' ')[0] || '')) || /tmux: (server|client)/.test(p.args)
  || /ghosty-sessions\/server\.js/.test(p.args);

const AGENT_CMDS = new Set(['claude', 'minimax-code', 'mcode', 'codex']);
const AGENT_PKG = /@(anthropic-ai\/claude-code|minimax-ai\/code|openai\/codex)\b/;
// mcode and minimax-code are node CLIs here, so they show up as `node .../@minimax-ai/code/cli.js`, not as their own name.
export function isAgentCmd(args) {
  const argv = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return false;
  if (AGENT_CMDS.has(basename(argv[0]))) return true;
  if (basename(argv[0]) !== 'node') return false;
  return argv.slice(1).some((a) => AGENT_PKG.test(a) || AGENT_CMDS.has(basename(a)));
}

// The agent of a live tmux session is working, not stray: 3 false alerts on 2026-10-20 (MiniMax 4.3 h at 80 % CPU and
// 5.2 h at 114 %, an 88 h idle manager at 90 %). A pane's agent is reached through the pane pid or through the pane shell
// and its launch script (pane bash -> bash handover.launch.sh -> minimax-code), so walk up to the pane, not one level.
// Only agent commands are exempt; what the agent runs - node --test, npm, builds - is not an agent command and keeps the
// normal runaway rule.
// table: Map pid -> ppid (same shape resolveOwner takes).
export function isPaneAgent(p, panePids, table) {
  if (!panePids || !panePids.size || !isAgentCmd(p.args)) return false;
  if (panePids.has(p.pid)) return true;   // the pane process itself
  let cur = p.ppid, guard = 0;
  while (cur > 1 && guard++ < 64) {
    if (panePids.has(cur)) return true;   // child of the pane shell, or of its launch script
    const up = table && table.get(cur);
    if (!up) return false;
    cur = up;
  }
  return false;
}

// procs: [{pid, ppid, etimes, rssKB, args, stat, mine, cpu?}] ; cpu = % between two samples (optional)
export function findRunaways(procs, cfg, protectedPids = new Set(), panePids = new Set()) {
  const table = new Map(procs.map((p) => [p.pid, p.ppid]));
  return procs.filter((p) => p.mine && p.etimes > cfg.runawayHours * 3600 && !SKIP_RUNAWAY(p, protectedPids) && !isPaneAgent(p, panePids, table)
    && ((p.rssKB / 1024) > cfg.runawayRssMB || (p.cpu ?? 0) > cfg.runawayCpu));
}

// Walk the parent chain to a tmux pane pid or a Claude session pid.
//   table: Map pid -> ppid ; panes: Map pid -> tmux session name ; claude: Map pid -> {sessionId, cwd}
export function resolveOwner(pid, table, panes, claude) {
  const out = { tmux: null, claude: null };
  let cur = pid, guard = 0;
  while (cur && cur > 1 && guard++ < 64) {
    if (!out.tmux && panes.has(cur)) out.tmux = panes.get(cur);
    if (!out.claude && claude.has(cur)) out.claude = claude.get(cur);
    if (out.tmux && out.claude) break;
    cur = table.get(cur);
  }
  return out;
}
export const ownerLabel = (o) => o.tmux ? `tmux:${o.tmux}` : o.claude ? `claude:${String(o.claude.sessionId).slice(0, 8)}` : 'none';
export const hasLiveOwner = (o) => !!(o.tmux || o.claude);

// Scratch dir eligibility: UUID-named, not a live session, mtime older than maxAgeDays.
export function scratchEligible(entry, liveIds, now, maxAgeDays) {
  if (!entry || !UUID_RE.test(entry.name)) return { ok: false, why: 'not a session id' };
  if (!entry.isDir || entry.isSymlink) return { ok: false, why: 'not a plain directory' };
  if (liveIds.has(entry.name.toLowerCase())) return { ok: false, why: 'live session' };
  if (now - entry.mtimeMs < maxAgeDays * 86400000) return { ok: false, why: 'younger than ' + maxAgeDays + ' d' };
  return { ok: true, why: 'dead session, old' };
}

// ---------------------------------------------------------------- build artifacts
//
// `git worktree remove` (and rm -rf on a plain clone) deletes ignored files SILENTLY, so the only ignored files
// that may go with a removed worktree are build artifacts: directories and files a build tool writes and nobody
// edits by hand. A .env, a note or a downloaded dataset is not on the list and keeps its worktree alive (E37:
// the ignored-files guard blocked 9 merged worktrees / 2.2 GB that held nothing but build output, so the owner's
// configured reclaim freed 0 KB). The list is deliberately short: every entry is a name a build tool owns end
// to end, and nothing else.
export const BUILD_ARTIFACT_NAMES = new Set([
  'node_modules',   // npm / yarn / pnpm install output
  '__pycache__',    // python bytecode
  '.venv', 'venv',  // python virtualenvs
  'dist', 'build',  // js and python build output
  'target',         // rust and java build output
  '.next',          // next.js build
  'coverage',       // coverage report
  '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox',   // test and lint tool caches
  '.turbo', '.svelte-kit',                                 // frontend build caches
]);
// Build artifacts whose name carries a prefix: the compiled file and the packaging metadata.
export const BUILD_ARTIFACT_PATTERNS = ['*.pyc', '*.pyo', '*.egg-info'];
const BUILD_ARTIFACT_RES = BUILD_ARTIFACT_PATTERNS.map((p) =>
  new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));

// Is this file or directory name a build artifact?
export function isBuildArtifactName(name) {
  if (!name) return false;
  if (BUILD_ARTIFACT_NAMES.has(name)) return true;
  return BUILD_ARTIFACT_RES.some((re) => re.test(name));
}
// An ignored path is a build artifact when it IS one (node_modules) or sits inside one (build/out.js).
export function isBuildArtifactPath(p) {
  return String(p || '').split('/').filter(Boolean).some(isBuildArtifactName);
}

// Worktree classification. info: {isWorktree, clean, merged, liveSession, ignoredFiles?, ignoredOnlyBuildArtifacts?,
// recentActivity?, unstarted?}
// The three deletion conditions stay exactly as they were (clean, merged, no live session). ignoredFiles is a
// safety guard on top: `git worktree remove` silently deletes ignored files, so a worktree whose only content is
// ignored files is reported, never removed behind the owner's back - unless every ignored file is a build
// artifact, which is what a merged, dead, clean worktree of a build-heavy repo holds (E37). recentActivity (the
// worktree's git state moved in the last N minutes) and unstarted (the branch has no commits of its own) keep
// live work out of the reaper's way.
export function classifyWorktree(info) {
  if (!info.isWorktree) return 'not-worktree';
  if (info.liveSession) return 'live-session';
  if (!info.clean) return 'dirty';
  if (info.ignoredFiles && !info.ignoredOnlyBuildArtifacts) return 'ignored-files';
  if (info.recentActivity) return 'recent-activity';
  if (info.unstarted) return 'unstarted';
  if (!info.merged) return 'unmerged';
  return 'removable';
}

// tmux (and /proc/<pid>/cwd) append " (deleted)" to the cwd of a session whose directory was deleted and recreated
// under it: the session is alive, but the plain path comparison misses it (2026-10-23, ui-sunrise).
export const DELETED_SUFFIX = ' (deleted)';
export function stripDeletedSuffix(p) { return String(p || '').trim().replace(/ \(deleted\)$/, ''); }
export function safeRealpath(p) { try { return realpathSync(p); } catch { return null; } }
// p is inside dir (dir itself or a sub-directory of it); '/' is the root of everything.
export function pathInside(dir, p) {
  if (!dir || !p) return false;
  const d = resolve(dir), q = resolve(p);
  return d === '/' ? q.startsWith('/') : (q === d || q.startsWith(d + '/'));
}
export function underRoots(dir, roots, realpath = safeRealpath) {
  const d = resolve(dir), dr = realpath(d) || d;
  return (roots || []).some((r) => {
    const root = resolve(r), rootR = realpath(root) || root;
    return pathInside(root, d) || pathInside(rootR, d) || pathInside(root, dr) || pathInside(rootR, dr);
  });
}

// Is a session alive inside this worktree? A pane cwd, a Claude session cwd or ANY live process whose /proc cwd is
// inside the worktree counts. The " (deleted)" suffix is stripped and both sides are compared through realpath, so a
// re-spelled path or a symlink does not hide a live session.
// Two more traces of an agent that works in a worktree from ANOTHER directory (E51: a task-spawned worker runs
// `git -C <dir>` while its own cwd is the parent directory): its command line names the worktree, or it holds a file
// of the worktree open.
export function worktreeIsLive(dir, { panes = [], claude = [], procCwds = [], procArgs = [], procFds = [] } = {}) {
  const hit = (raw) => {
    if (!raw) return false;
    const p = stripDeletedSuffix(raw);
    if (!p) return false;
    if (pathInside(dir, p)) return true;
    const rp = safeRealpath(p);
    return !!rp && pathInside(safeRealpath(dir) || dir, rp);
  };
  const inArgs = (args) => String(args || '').split(/\s+/).some((tok) => {
    const t = tok.replace(/^["']|["']$/g, '');
    if (!t) return false;
    if (hit(t)) return true;
    const i = t.indexOf('=');       // --cwd=<dir>
    return i > 0 && hit(t.slice(i + 1));
  });
  return panes.some((p) => hit(p.path))
    || claude.some((c) => c.alive && hit(c.cwd))
    || procCwds.some((c) => hit(c.cwd))
    || procArgs.some((p) => inArgs(p.args))
    || procFds.some((f) => hit(f.path));
}

// The cwd of every own process: a session that cd'd elsewhere still holds the worktree open.
export function readProcCwds(procs, readlink = readlinkSync) {
  const out = [];
  for (const p of procs || []) {
    if (!p.mine) continue;
    try { const cwd = readlink(`/proc/${p.pid}/cwd`); if (cwd) out.push({ pid: p.pid, cwd }); } catch {}
  }
  return out;
}

// The files every own process holds open: a process with a file of the worktree open is working on it, whatever its
// cwd is. Bounded per process: the list is a liveness hint, not an inventory.
export function readProcFds(procs, readlink = readlinkSync, readdir = readdirSync, maxPerProc = 64) {
  const out = [];
  for (const p of procs || []) {
    if (!p.mine) continue;
    let fds = [];
    try { fds = readdir(`/proc/${p.pid}/fd`); } catch { continue; }
    for (const fd of fds.slice(0, maxPerProc)) {
      try { const path = readlink(`/proc/${p.pid}/fd/${fd}`); if (path) out.push({ pid: p.pid, fd, path }); } catch {}
    }
  }
  return out;
}

// Debounce: write when never written, or older than the window, or the severity worsened by its step.
export function shouldWake(issue, prev, now, debounceHours) {
  if (!prev) return { wake: true, why: 'new' };
  const step = WORSEN_STEP[issue.type];
  if (step !== undefined && Number(issue.severity) >= Number(prev.severity) + step) return { wake: true, why: 'worsened' };
  if (now - prev.at >= debounceHours * 3600000) return { wake: true, why: 'window elapsed' };
  return { wake: false, why: 'debounced' };
}

export function buildEvent(issue, fixedNote, reportPath, now) {
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const body = cut(`${issue.what}${fixedNote ? ' ' + fixedNote : ''} Report: ${reportPath}`, 300);
  return {
    at: new Date(now).toISOString(),
    key: `health:${issue.key}`,
    kind: 'health',
    title: cut(`Codebox health: ${issue.title}`, 80),
    body,
    url: '/',
    priority: issue.decision ? 'high' : 'default',
  };
}

// metrics: {diskPct, diskFreeGB, load1, load5, cores, ramAvailPct, runaways:[{p, owner}], stuck:[{p, owner}], defunct}
export function evaluate(m, cfg, loadTrip) {
  const issues = [];
  if (m.diskPct >= cfg.diskPct) issues.push({ type: 'disk', key: 'disk', severity: m.diskPct, title: `disk ${m.diskPct}% full`, what: `Disk / is ${m.diskPct}% full (${m.diskFreeGB} GB free, limit ${cfg.diskPct}%).` });
  if (loadTrip) issues.push({ type: 'load', key: 'load', severity: m.load5, decision: true, title: `load ${m.load5.toFixed(1)} on ${m.cores} cores`, what: `Load ${m.load1.toFixed(1)}/${m.load5.toFixed(1)} (1/5 min) on ${m.cores} cores, above ${cfg.loadPerCore}/core for ${cfg.loadMinutes} min.` });
  if (m.inodePct >= cfg.inodePct) issues.push({ type: 'inode', key: 'inode', severity: m.inodePct, title: `inodes ${m.inodePct}% used`, what: `Inodes on / are ${m.inodePct}% used (${m.inodeFree} free, limit ${cfg.inodePct}%).` });
  if (m.ramAvailPct < cfg.ramAvailPct) issues.push({ type: 'ram', key: 'ram', severity: 100 - m.ramAvailPct, decision: true, title: `RAM ${m.ramAvailPct.toFixed(0)}% available`, what: `Only ${m.ramAvailPct.toFixed(1)}% RAM available (limit ${cfg.ramAvailPct}%).` });
  for (const r of m.runaways) {
    const lbl = ownerLabel(r.owner), name = basename(r.p.args.split(' ')[0]);
    issues.push({ type: 'runaway', key: `runaway:${lbl}:${name}`, severity: 0, decision: hasLiveOwner(r.owner), orphan: !hasLiveOwner(r.owner), pid: r.p.pid,
      title: `runaway ${name} (${lbl})`, what: `Runaway ${name} pid ${r.p.pid} in ${lbl}: ${(r.p.etimes / 3600).toFixed(1)} h old, ${Math.round(r.p.rssKB / 1024)} MB RSS, ${Math.round(r.p.cpu ?? 0)}% CPU.` });
  }
  for (const s of m.stuck) {
    const lbl = ownerLabel(s.owner);
    issues.push({ type: 'stuck', key: `stuck-node-test:${lbl}`, severity: 0, decision: true, orphan: !hasLiveOwner(s.owner), pid: s.p.pid,
      title: `bare node --test (${lbl})`, what: `A 'node --test' with no file args runs (pid ${s.p.pid}, ${lbl}, ${(s.p.etimes / 60).toFixed(0)} min); it scans the whole tree and hangs.` });
  }
  if (m.leftovers?.length) {
    const n = m.leftovers.reduce((k, l) => k + l.pids.length, 0);
    issues.push({ type: 'test-leftover', key: 'test-leftover', severity: n, decision: false, leftovers: m.leftovers,
      title: `${m.leftovers.length} orphaned test run(s), ${n} processes`,
      what: `${m.leftovers.length} test run(s) whose parent is gone, older than ${cfg.testLeftoverMin} min (${n} processes): ${m.leftovers.slice(0, 3).map((l) => `pid ${l.pid} ${basename(l.args.split(' ')[0])} ${(l.etimes / 3600).toFixed(1)} h`).join(', ')}.` });
  }
  if (m.defunct > cfg.defunctMax) issues.push({ type: 'defunct', key: 'defunct', severity: m.defunct, decision: true, title: `${m.defunct} defunct processes`, what: `${m.defunct} defunct (zombie) processes, limit ${cfg.defunctMax}.` });
  return issues;
}

// ---------------------------------------------------------------- system access

const sh = (cmd, args, timeout = 20000) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
// du exits non-zero on unreadable entries but its stdout is still the answer
const shOut = (cmd, args, timeout) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return typeof e.stdout === 'string' ? e.stdout : null; } };
const duKB = (path) => { const o = shOut('du', ['-sk', path], 120000); const n = o ? parseInt(o, 10) : NaN; return Number.isFinite(n) ? n : 0; };
// Report-only sizes: they change slowly, but while the disk alarm stayed on, re-walking /tmp and 41 worktrees took ~60 s
// of every 5-min tick (2026-10-20). Cached for DU_TTL_MS in health-du-cache.json; cleanup steps still measure fresh.
export const DU_TTL_MS = 60 * 60 * 1000;
let duCache = null;   // { key: { at, v } }; null = uncached (tests)
export function cachedSize(key, fn, now = Date.now(), cache = duCache) {
  if (!cache) return fn();
  const e = cache[key];
  if (e && now - e.at < DU_TTL_MS) return e.v;
  const v = fn(); cache[key] = { at: now, v }; return v;
}
const duR = (path) => cachedSize(`du:${path}`, () => duKB(path));
const human = (kb) => kb >= 1048576 ? (kb / 1048576).toFixed(1) + ' GB' : kb >= 1024 ? (kb / 1024).toFixed(0) + ' MB' : kb + ' KB';

export function parsePs(text, myUid) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: +m[1], ppid: +m[2], etimes: +m[3], rssKB: +m[4], mine: +m[5] === myUid, pcpu: parseFloat(m[6]), stat: m[7], args: m[8] });
  }
  return out;
}
const readPs = () => parsePs(sh('ps', ['-eo', 'pid=,ppid=,etimes=,rss=,uid=,pcpu=,stat=,args='], 20000) || '', process.getuid());

const cpuTicks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = f.slice(f.lastIndexOf(')') + 2).split(' '); return (+r[11]) + (+r[12]); } catch { return null; } };
const pidAlive = (pid) => existsSync(`/proc/${pid}`);

function claudeSessions(home) {
  const dir = join(home, '.claude', 'sessions'), out = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try { const j = JSON.parse(readFileSync(join(dir, n), 'utf8')); if (j.pid && j.sessionId) out.push({ pid: j.pid, sessionId: j.sessionId, cwd: j.cwd || '', alive: pidAlive(j.pid) }); } catch {}
  }
  return out;
}
function tmuxPanes() {
  const o = sh('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_path}']) || '';
  return o.split('\n').filter(Boolean).map((l) => { const [name, pid, path] = l.split('\t'); return { name, pid: +pid, path: path || '' }; });
}

function readMem() {
  const t = readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => +(t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [0, 0])[1];
  return { total: g('MemTotal'), avail: g('MemAvailable') };
}
function readDisk() {
  const s = statfsSync('/');
  const total = s.blocks * s.bsize, free = s.bavail * s.bsize, used = total - s.bfree * s.bsize;
  return { pct: Math.round((used / (used + free)) * 100), freeGB: +(free / 1e9).toFixed(1) };
}

// ---------------------------------------------------------------- tmp auto-clean + inodes
// Test suites leak mkdtemp dirs in os.tmpdir() (2026-10-20: 186k entries ate every inode). Names of every
// mkdtemp prefix (join of tmpdir and a literal) in test/ and scripts/; test/health-watch.test.js asserts the list stays complete.
export const TMP_PREFIXES = ['owner-ask-', 'owner-ask-2-', 'owner-ask-badfloor-', 'owner-ask-d-', 'owner-ask-ok-', 
  'desktop-cfg-', 'full-suite-', 'full-suite-state-', 'gtr-',
  'appr-origin-', 'auto-origin-', 'cbs-', 'ci-watch-', 'cs-', 'daily-', 'dec-origin-', 'diskguard-', 'done-check-', 'dr-',
  'fake-proc-', 'fake-run-', 'fallback-', 'fallback-node-', 'g8-', 'g8-daily-', 'ghosty-adopt-', 'ghosty-al-',
  'ghosty-approved-', 'ghosty-auto-', 'ghosty-autonomy-', 'ghosty-dedupe-', 'ghosty-dep-', 'ghosty-ds-',
  'ghosty-ds-cli-', 'ghosty-fb-', 'ghosty-filt-', 'ghosty-fixes-', 'ghosty-form-', 'ghosty-hold-', 'ghosty-jevb-',
  'ghosty-jevb-cli-', 'ghosty-jevb-ev-', 'ghosty-jevdec-', 'ghosty-jevoff-', 'ghosty-judge-', 'ghosty-leaseask-',
  'ghosty-mactions-', 'ghosty-mergedec-', 'ghosty-mergewait-', 'ghosty-mevents-', 'ghosty-mgr-', 'ghosty-mgrsess-',
  'ghosty-mig-', 'ghosty-mig2-', 'ghosty-mn-', 'ghosty-mockups-', 'ghosty-mwait-', 'ghosty-nudge-', 'ghosty-opsask-',
  'ghosty-p5-', 'ghosty-p5mgr-', 'ghosty-push-', 'ghosty-r9review-', 'ghosty-ready-', 'ghosty-real-',
  'ghosty-remote-', 'ghosty-rep-', 'ghosty-repmgr-', 'ghosty-review-', 'ghosty-rpf-', 'ghosty-rprompt-',
  'ghosty-rt-', 'ghosty-rt2-', 'ghosty-run-', 'ghosty-selfcheck-', 'ghosty-shadow-', 'ghosty-tm-', 'ghosty-triage-',
  'ghosty-tts-test-', 'ghosty-wake-', 'ghosty-wakes-', 'ghosty-wk-', 'gu-', 'handoffs-', 'hv-', 'hv6b-',
  'info-plain-', 'int-wire-', 'ja-', 'jev-ask-', 'jev-ask-facts-', 'lane-', 'lane-api-', 'lane-cli-', 'lane-home-',
  'lane-restart-', 'lane-self-', 'lane-state-', 'launch-path-', 'layout-', 'lease-cssh-', 'lease-http-',
  'lease-integ-', 'lease-owner-', 'lease-scripts-', 'lease-serve-', 'lease-svc-', 'lfeval-', 'lw-', 'mac-checkout-',
  'mac-hook-', 'merge-pol-', 'meval-origin-', 'meval-reg-', 'meval-state-', 'mk-push-', 'mm-mgr-', 'mmmgr-fake-',
  'mycodebox-restart-', 'p1fix-fresh-', 'pk-', 'pk-mm-', 'render-skill-', 'rules-watch-', 'rv2-fresh-', 'self-out-',
  'self-root-', 'send-ui-shots-', 'send-ui-work-', 'sh-', 'slots-', 'trust-', 'trust-ctl-', 'usage-attr-',
  'usage-test-', 'v2-acc-fx-', 'v2-acc-runner-', 'v2-acc-state-', 'v2-acceptance-', 'v2-adapters-', 'v2-adverify-',
  'v2-bench-', 'v2-bench-http-', 'v2-bench-http-reap-', 'v2-bench-http-test-', 'v2-bench-out-', 'v2-bench-r4-test-',
  'v2-bench-test-', 'v2-d017-', 'v2-delivery-', 'v2-delivery-verify-', 'v2-gl-', 'v2-glstall-', 'v2-glv-',
  'v2-glv2-', 'v2-glv3-', 'v2-glv4-', 'v2-glv5-', 'v2-glv6-', 'v2-grants-', 'v2-http-', 'v2-int-', 'v2-intv-',
  'v2-lease-', 'v2-lease-verify-', 'v2-lease-verify2-', 'v2-lease-verify3-', 'v2-lease-verify4-',
  'v2-lease-verify5-', 'v2-live-smoke-', 'v2-loop-', 'v2-mcode-node-', 'v2-policy-', 'v2-r3-verify-', 'v2-r4-',
  'v2-r4gl-', 'v2-r5-', 'v2-score-', 'v2-score-v-', 'v2-store-', 'v2-store-api-', 'v2-sysops-', 'v2-sysops-verify-',
  'v2-sysops-verify2-', 'v2-ui-shots-', 'v2-ui-work-', 'v2-verify-', 'v2-verify06-', 'v2-verify2-', 'v2-verify3-',
  'v2-verify4-', 'v2-wiring-', 'v2-wt-', 'v2-wtr-', 'v2-wtverify-', 'voice-push-', 'vpt-lease-test-',
];
export const TMP_MAX_AGE_MS = 2 * 3600e3, TMP_MAX_REMOVALS = 2000, TMP_BUDGET_MS = 20000;

// Remove stale test dirs directly in `root`: own uid, known prefix, real directory (lstat: symlinks are never followed),
// mtime older than maxAgeMs. Bounded by count and time; the rest goes next tick. Never throws.
export function cleanTmp({ root = tmpdir(), uid = process.getuid?.(), now = Date.now(), prefixes = TMP_PREFIXES, maxAgeMs = TMP_MAX_AGE_MS,
  maxRemovals = TMP_MAX_REMOVALS, budgetMs = TMP_BUDGET_MS, clock = Date.now, dryRun = false } = {}) {
  const r = { removed: 0, failed: 0, truncated: false };
  try {
    const t0 = clock();
    const dir = opendirSync(root);
    try {
      for (let e; (e = dir.readSync());) {
        if (!e.isDirectory() || !prefixes.some((p) => e.name.startsWith(p))) continue;
        if (r.removed >= maxRemovals || clock() - t0 > budgetMs) { r.truncated = true; break; }
        const p = join(root, e.name);
        try {
          const st = lstatSync(p);
          if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs < maxAgeMs) continue;
          if (!dryRun) rmSync(p, { recursive: true, force: true });
          r.removed++;
        } catch { r.failed++; }
      }
    } finally { try { dir.closeSync(); } catch {} }
  } catch { r.failed++; }
  return r;
}

// Inode use of the mount holding `path`, same shape as readDisk (statfs: files = total inodes, ffree = free).
export function readInodes(path = '/', statfs = statfsSync) {
  try {
    const s = statfs(path);
    if (!s.files) return { pct: 0, free: 0 };
    return { pct: Math.round(((s.files - s.ffree) / s.files) * 100), free: s.ffree };
  } catch { return { pct: 0, free: 0 }; }
}

// ---------------------------------------------------------------- config / state

export function loadConfig(path) {
  let cfg = {};
  if (!existsSync(path)) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'); }
  else { try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { cfg = {}; } }
  const out = { ...DEFAULT_CONFIG, ...cfg };
  if (!FIX_LEVELS.includes(out.fixLevel)) out.fixLevel = 'report';   // unknown level: do nothing destructive
  return out;
}
function loadState(path) { try { const s = JSON.parse(readFileSync(path, 'utf8')); return { samples: s.samples || [], issues: s.issues || {} }; } catch { return { samples: [], issues: {} }; } }
const saveState = (path, s) => writeFileSync(path, JSON.stringify(s) + '\n');

// ---------------------------------------------------------------- investigation

function topProcs(procs, owners, by, n = 15) {
  const sorted = [...procs].sort((a, b) => (by === 'cpu' ? b.pcpu - a.pcpu : b.rssKB - a.rssKB)).slice(0, n);
  const rows = sorted.map((p) => `| ${p.pid} | ${p.pcpu} | ${Math.round(p.rssKB / 1024)} | ${(p.etimes / 3600).toFixed(1)} h | ${ownerLabel(owners(p.pid))} | \`${p.args.slice(0, 90).replace(/\|/g, '/')}\` |`);
  return ['| pid | %CPU | RSS MB | elapsed | owner | command |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

// ---------------------------------------------------------------- worktree scan
//
// The watcher used to look at ~/vpt-* and ~/ghosty-* only, so it never saw the worktrees that hold the space
// (~/virtualpytest-*, ~/evolai-*, ~/wt/*, ~/mycodebox-v2-wt/*, /tmp/*): it reported "0 removable" on a nearly full
// disk. The eligible set is now the REGISTERED worktrees of the repos the owner configured (state-dir config:
// worktreeRepos + worktreeRoots), deduped by path and bounded by the configured roots. The deletion CRITERIA do not
// change (clean, merged, no live session); only the set of paths that can be classified grows.

export function configRepos(cfg) {
  const raw = cfg?.worktreeRepos;
  const out = [];
  if (Array.isArray(raw)) raw.forEach((p, i) => out.push({ key: `repo-${i + 1}`, path: String(p || '') }));
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) out.push({ key: String(k), path: String(v || '') });
  return out.filter((r) => r.path.startsWith('/'));   // absolute paths only: a relative repo path is ambiguous
}
export function configRoots(cfg) {
  const raw = cfg?.worktreeRoots;
  return (Array.isArray(raw) ? raw : []).map((r) => String(r || '')).filter((r) => r.startsWith('/'));
}

// `git worktree list --porcelain`: one block per worktree, the first one is the repo's main worktree.
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) out.push(cur); cur = { path: line.slice('worktree '.length).trim(), branch: '', detached: false }; }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    else if (line.startsWith('detached') && cur) cur.detached = true;
  }
  if (cur) out.push(cur);
  return out;
}

// The merge target: the repo's own origin/main when it exists, else the local main. The name is reported.
export function mergeTarget(run, path) {
  if (run('git', ['-C', path, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']) !== null) return { name: 'origin/main', ref: 'refs/remotes/origin/main' };
  if (run('git', ['-C', path, 'rev-parse', '--verify', '--quiet', 'refs/heads/main']) !== null) return { name: 'main', ref: 'refs/heads/main' };
  return null;
}

// The commit a branch was created from: the OLDEST entry of its reflog ("branch: Created from ..."). git's own
// merge-base --fork-point wants the reflog of the merge TARGET, which a fresh clone may not have.
export function branchForkPoint(run, dir, branch) {
  if (!branch || branch === 'HEAD') return '';
  const out = run('git', ['-C', dir, 'reflog', 'show', '--format=%H', branch]);
  if (!out) return '';
  const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// A branch that was created from the merge target and never committed on it is UNSTARTED, not merged: its HEAD is
// the fork point, which is trivially an ancestor of the merge target, so "is HEAD an ancestor of origin/main" said
// yes for a branch with no work at all (E51, 2026-10-23: the watcher removed a live worktree twice). Without a
// reflog the branch counts as unstarted only when its HEAD is the merge target's own tip.
export function isUnstarted({ headSha = '', targetSha = '', forkPoint = '' } = {}) {
  if (!headSha) return false;
  if (forkPoint) return headSha === forkPoint;
  return headSha === targetSha;
}

// A linked worktree's .git is a FILE that names its own metadata dir (under the repo's common dir).
export function worktreeGitDir(dir, readFile = readFileSync) {
  try {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFile(join(dir, '.git'), 'utf8'));
    return m ? resolve(dir, m[1].trim()) : null;
  } catch { return null; }
}

// The files git writes in that metadata dir: a checkout, a commit, an index refresh. Their mtime is the last sign of
// life of a worktree whose owner has not written a file yet.
const GIT_STATE_FILES = ['HEAD', 'index', 'logs/HEAD', 'ORIG_HEAD'];
// A clone keeps its own metadata in .git: a fetch there rewrites FETCH_HEAD, so it counts as activity too.
const CLONE_STATE_FILES = [...GIT_STATE_FILES, 'FETCH_HEAD'];
export function worktreeGitState(gitDir, { stat = lstatSync, files = GIT_STATE_FILES } = {}) {
  let at = 0, source = null;
  for (const f of files) {
    try { const st = stat(join(gitDir, f)); if (st && st.mtimeMs > at) { at = st.mtimeMs; source = f; } } catch {}
  }
  return { at, source };
}

// Scan the configured repos. run() is injectable so the tests can drive the git calls without a real repo.
export function scanWorktrees({ cfg, panes = [], claude = [], procCwds = [], procArgs = [], procFds = [], run = sh, realpath = safeRealpath, stat = lstatSync, readFile = readFileSync, now = Date.now() } = {}) {
  const roots = configRoots(cfg);
  const repos = [], candidates = [], notConsidered = [];
  const seenCommon = new Map(), seenPaths = new Map();
  let entriesDropped = 0, reposDropped = 0, missing = 0, registered = 0;

  for (const { key, path } of configRepos(cfg)) {
    const commonOut = run('git', ['-C', path, 'rev-parse', '--git-common-dir']);
    if (commonOut === null) { repos.push({ key, path, error: 'not a git repository' }); continue; }
    const common = resolve(path, commonOut.trim());
    if (seenCommon.has(common)) {           // the same repo twice (e.g. a main checkout and one of its worktrees)
      reposDropped++;
      repos.push({ key, path, common, skipped: `same git common dir as ${seenCommon.get(common)}` });
      continue;
    }
    seenCommon.set(common, key);
    const listOut = run('git', ['-C', path, 'worktree', 'list', '--porcelain']);
    if (listOut === null) { repos.push({ key, path, common, error: 'git worktree list failed' }); continue; }
    const entries = parseWorktreePorcelain(listOut);
    const mergeRef = mergeTarget(run, path);
    const repo = { key, path, common, entries: entries.length, mergeRef: mergeRef ? mergeRef.name : null, candidates: 0, notConsidered: 0,
      worktreePaths: entries.map((e) => resolve(e.path)) };
    repos.push(repo);
    registered += entries.length;

    for (const [i, e] of entries.entries()) {
      const dir = resolve(e.path);
      const id = realpath(dir) || dir;
      if (seenPaths.has(id)) { entriesDropped++; continue; }   // dedupe by path: the same worktree listed twice
      seenPaths.set(id, key);
      if (!existsSync(dir)) { missing++; repo.missing = (repo.missing || 0) + 1; continue; }
      // git lists the main worktree of a repo first: that is the checkout itself, never a candidate. (The git common
      // dir cannot tell them apart - every linked worktree of a repo has the same one.)
      if (i === 0) {
        notConsidered.push({ name: basename(dir), dir, repo: key, reason: 'main worktree of the repo' });
        repo.notConsidered++;
        continue;
      }
      if (!underRoots(dir, roots, realpath)) {
        notConsidered.push({ name: basename(dir), dir, repo: key, reason: 'outside the allowed roots' });
        repo.notConsidered++;
        continue;
      }
      let st = null;
      try { st = stat(join(dir, '.git')); } catch {}
      const isWorktree = !!st && st.isFile();      // a linked worktree has a .git FILE, a clone has a .git DIRECTORY
      // --no-optional-locks: the watcher must not rewrite the index itself, or every worktree would look active.
      const status = run('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain', '--ignored']);
      const lines = status === null ? [] : status.split('\n').filter(Boolean);
      const ignoredPaths = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(2).trim());
      const ignoredFiles = ignoredPaths.length;
      // Only build artifacts may go with the worktree: one unknown ignored file (.env, a note) keeps it alive.
      const unknownIgnored = ignoredPaths.filter((p) => !isBuildArtifactPath(p));
      const clean = status !== null && lines.every((l) => l.startsWith('!!'));
      const branch = (run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
      const headSha = (run('git', ['-C', dir, 'rev-parse', 'HEAD']) || '').trim();
      const targetSha = mergeRef ? (run('git', ['-C', dir, 'rev-parse', mergeRef.ref]) || '').trim() : '';
      const ancestor = mergeRef ? run('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', mergeRef.ref]) !== null : false;
      const unstarted = isUnstarted({ headSha, targetSha, forkPoint: branchForkPoint(run, dir, branch) });
      const merged = ancestor && !unstarted;   // an unstarted branch has no work of its own to be merged
      // Recent activity: the worktree's own git metadata, or its last commit. "clean" only means "no tracked file is
      // modified", so a worktree whose owner has not written anything yet is still work in progress (E51).
      const gitDir = isWorktree ? worktreeGitDir(dir, readFile) : null;
      const state = gitDir ? worktreeGitState(gitDir, { stat }) : { at: 0, source: null };
      const lastCommitAt = Number((run('git', ['-C', dir, 'log', '-1', '--format=%ct', 'HEAD']) || '').trim()) * 1000 || 0;
      const activityAt = Math.max(state.at, lastCommitAt);
      const activeMin = Number(cfg.worktreeActiveMin ?? DEFAULT_CONFIG.worktreeActiveMin);
      const recentActivity = activityAt > 0 && now - activityAt < activeMin * 60000;
      const liveSession = worktreeIsLive(dir, { panes, claude, procCwds, procArgs, procFds });
      const info = { name: basename(dir), dir, branch, repo: key, isWorktree, clean, merged, unstarted,
        mergedRef: mergeRef ? mergeRef.name : null, ignoredFiles, ignoredOnlyBuildArtifacts: ignoredFiles > 0 && unknownIgnored.length === 0,
        unknownIgnored, liveSession, recentActivity, activeMin,
        activityAt, activityAgeMin: activityAt ? Math.max(0, Math.round((now - activityAt) / 60000)) : null,
        activitySource: state.source || (lastCommitAt ? 'last commit' : null) };
      info.kind = classifyWorktree(info);
      info.why = classifyWhy(info);
      candidates.push(info);
      repo.candidates++;
    }
  }
  return { candidates, notConsidered, repos, roots, registered,
    dedupe: { entriesDropped, reposDropped }, missing };
}

// ---------------------------------------------------------------- plain clones
//
// A plain `git clone` is not a REGISTERED worktree, so `git worktree list` never shows it and the reclaim never
// saw it: /tmp/vp-clone (547 MB) and /tmp/main-check (501 MB) were invisible to a reclaim that freed 0 KB
// (E37, 2026-10-24). A clone is a candidate only when it is a scratch copy of a repo this product manages:
// its origin is a configured repo (or that repo's own upstream), its tree is clean, it has no commits of its
// own, nobody works in it and its git state has not moved within the activity window.
export const CLONE_MAX_DEPTH = 2;    // the allowed roots and their direct children
// The directory budget is PER ROOT: one root must not consume the walk before the next one is looked at (E37:
// the home root held 5.3 k directories at depth 2 and starved /tmp, so the scratch clones the brief named were
// never reached). 6000 covers today's roots (5.3 k and 2.2 k) and a full walk of both costs about 0.2 s.
export const CLONE_MAX_DIRS = 6000;

// The directories under the allowed roots that may hold a clone. Symlinked directories are not followed and the
// walk stops at CLONE_MAX_DIRS per root, so a root full of data cannot turn the scan into a full disk walk.
export function findCloneDirs({ roots = [], excluded = new Set(), realpath = safeRealpath, readdir = readdirSync,
  maxDepth = CLONE_MAX_DEPTH, maxDirs = CLONE_MAX_DIRS } = {}) {
  const out = [];
  for (const r of roots) {
    let visited = 0;      // the budget is per root, so a big root cannot starve the next one
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries = [];
      try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '.git') continue;   // a symlinked directory is not followed
        const p = join(dir, e.name);
        if (visited >= maxDirs) return;
        visited++;
        const id = realpath(p) || p;
        if (excluded.has(id)) continue;    // a configured repo, one of its worktrees, or the lane's own directory
        out.push(p);
        walk(p, depth + 1);
      }
    };
    walk(r, 1);
  }
  return out;
}

// The integration lane's clones are machinery, not scratch: the lane fetches, merges and tests in exactly the
// directory the state-dir config names, and it never re-clones it (there is no `git clone` in integration-lane.js),
// so deleting one breaks every merge in the fleet. The lane's WHOLE directory is excluded, not only the configured
// clones: a clone the lane no longer lists is still the lane's (E37).
export function laneExclusions(stateDirs = [], { roots = [], repoPaths = [] } = {}) {
  const out = new Set();
  for (const stateDir of stateDirs || []) {
    let repos = {};
    try { repos = JSON.parse(readFileSync(join(stateDir, 'integration.json'), 'utf8'))?.repos || {}; } catch { continue; }
    for (const c of Object.values(repos || {})) {
      const clone = typeof c?.clone === 'string' ? resolve(c.clone) : null;
      if (!clone || !clone.startsWith('/')) continue;
      out.add(clone);                                    // the clone itself
      const dir = dirname(clone);                        // and the lane's own directory around it
      if (roots.some((r) => resolve(r) === dir)) continue;      // never exclude a whole allowed root
      if (repoPaths.some((p) => resolve(p) === dir)) continue;  // nor a configured repo checkout
      out.add(dir);
    }
  }
  return out;
}

// A remote url and a local path are written in different ways for the same repo: file:///p, /p, /p/.git.
export function normalizeRepoUrl(u) {
  return String(u || '').trim().replace(/^file:\/\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

// Which configured repo a clone's origin points at: the repo's own path, or the repo's own upstream (a clone made
// from the remote). null = a repo this product does not manage, which is never a candidate.
export function matchOriginRepo(origin, repos = [], realpath = safeRealpath) {
  const o = normalizeRepoUrl(origin);
  if (!o) return null;
  for (const r of repos) {
    const p = normalizeRepoUrl(r.path);
    if (!p) continue;
    if (p === o) return r.key;
    if (o.startsWith('/') && (realpath(o) || o) === (realpath(p) || p)) return r.key;
  }
  for (const r of repos) {
    const up = normalizeRepoUrl(r.origin);
    if (up && up === o) return r.key;
  }
  return null;
}

// The default branch of the clone's own remote: origin/HEAD when the clone has it, else origin/main, else
// origin/master. A clone without one cannot be compared with the remote, so it is not a candidate.
export function cloneRemoteRef(run, dir) {
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref]) !== null) return ref;
  }
  return null;
}

// The clone criteria, in the order the report names them. Every one of them must hold: a clone that fails any of
// them is reported, never removed. The protections come first: "it has uncommitted changes" says more to the owner
// than "it is not one of our repos", and both keep the clone alive.
export function classifyClone(info) {
  if (!info.isClone) return 'not-clone';
  if (info.liveSession) return 'clone-live-session';
  if (!info.clean) return 'clone-dirty';
  if (info.unknownIgnored?.length) return 'clone-ignored-files';
  if (info.recentActivity) return 'clone-recent-activity';
  if (!info.merged) return 'clone-unmerged';
  if (!info.repo || info.repo === 'unknown') return 'clone-unknown-repo';
  return 'removable';
}

// Scan the allowed roots for plain clones of the configured repos. run() is injectable, like scanWorktrees.
export function scanClones({ cfg, repos = [], stateDirs = [], panes = [], claude = [], procCwds = [], procArgs = [], procFds = [],
  run = sh, realpath = safeRealpath, stat = lstatSync, readdir = readdirSync, now = Date.now(),
  uid = process.getuid?.(), maxDepth = CLONE_MAX_DEPTH, maxDirs = CLONE_MAX_DIRS } = {}) {
  const roots = configRoots(cfg);
  const managed = repos.filter((r) => !r.error && !r.skipped && r.path);
  // No configured repo means no clone is a candidate: do not walk the roots for nothing (same rule as the
  // worktree scan: no repo and no root, nothing is a candidate).
  if (!managed.length) return { candidates: [], notConsidered: [], roots };
  // The main checkout and the registered worktrees of a configured repo are never clones of it.
  const excluded = new Set();
  for (const r of managed) {
    for (const p of [r.path, ...(r.worktreePaths || [])]) {
      const abs = resolve(p);
      excluded.add(realpath(abs) || abs);
    }
  }
  // The integration lane's own clones: machinery, not scratch (E37).
  const lane = [...laneExclusions(stateDirs, { roots, repoPaths: managed.map((r) => r.path) })];
  for (const p of lane) {
    const abs = resolve(p);
    excluded.add(abs);
    excluded.add(realpath(abs) || abs);
  }
  const known = managed.map((r) => ({ key: r.key, path: r.path,
    origin: (run('git', ['-C', r.path, 'remote', 'get-url', 'origin']) || '').trim() }));
  const candidates = [], notConsidered = [];
  for (const dir of findCloneDirs({ roots, excluded, realpath, readdir, maxDepth, maxDirs })) {
    let gitSt = null, dirSt = null;
    try { gitSt = stat(join(dir, '.git')); } catch {}
    try { dirSt = stat(dir); } catch {}
    if (!gitSt) continue;                                  // not a checkout at all
    if (!gitSt.isDirectory()) { notConsidered.push({ dir, reason: 'linked worktree, not a clone' }); continue; }
    if (uid != null && dirSt && dirSt.uid !== uid) { notConsidered.push({ dir, reason: 'not owned by this user' }); continue; }
    const origin = (run('git', ['-C', dir, 'remote', 'get-url', 'origin']) || '').trim();
    const repoKey = matchOriginRepo(origin, known, realpath);
    // The git state is read BEFORE the status call: an index rewritten by that call would make every clone look
    // like it moved (--no-optional-locks keeps git from writing it).
    const state = worktreeGitState(join(dir, '.git'), { stat, files: CLONE_STATE_FILES });
    const activityAt = Math.max(state.at, dirSt?.mtimeMs || 0);
    const activeMin = Number(cfg.worktreeActiveMin ?? DEFAULT_CONFIG.worktreeActiveMin);
    const recentActivity = activityAt > 0 && now - activityAt < activeMin * 60000;
    const status = run('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain', '--ignored']);
    const lines = status === null ? [] : status.split('\n').filter(Boolean);
    const ignoredPaths = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(2).trim());
    const unknownIgnored = ignoredPaths.filter((p) => !isBuildArtifactPath(p));
    const clean = status !== null && lines.every((l) => l.startsWith('!!'));
    const branch = (run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
    const remoteRef = cloneRemoteRef(run, dir);
    // No unique local commits: HEAD is an ancestor of the default branch the clone has of its own origin.
    const merged = !!remoteRef && run('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', remoteRef]) !== null;
    const liveSession = worktreeIsLive(dir, { panes, claude, procCwds, procArgs, procFds });
    const info = { name: basename(dir), dir, branch, repo: repoKey || 'unknown', isClone: true, isWorktree: false,
      origin, clean, merged, mergedRef: remoteRef ? remoteRef.replace('refs/remotes/', '') : null,
      ignoredFiles: ignoredPaths.length, unknownIgnored, liveSession, recentActivity, activeMin, activityAt,
      activityAgeMin: activityAt ? Math.max(0, Math.round((now - activityAt) / 60000)) : null,
      activitySource: state.source || 'directory mtime' };
    info.kind = classifyClone(info);
    info.why = classifyWhy(info);
    candidates.push(info);
  }
  return { candidates, notConsidered, roots, laneExcluded: lane };
}

// The clone section of the report: every candidate and the reason it was (not) removable.
export function cloneReport(scan, { du = duR } = {}) {
  const L = [];
  const cands = scan?.candidates || [];
  L.push('## Plain clones (git clones under the allowed roots)', '');
  L.push(`- clones found: ${cands.length} (${cands.filter((c) => c.kind === 'removable').length} removable)`);
  L.push(`- allowed roots: ${(scan?.roots || []).join(', ') || 'none configured'}`);
  if ((scan?.laneExcluded || []).length) {
    L.push(`- excluded: the integration lane's own clones (${scan.laneExcluded.join(', ')}) - the lane works in them and never re-clones them`);
  }
  L.push('', '| dir | repo | origin | size | clean | ignored files | merged into | merged | live session | class | why |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cands) {
    L.push(`| ${c.dir} | ${c.repo} | ${c.origin || 'n/a'} | ${human(du(c.dir))} | ${c.clean ? 'yes' : 'NO'} | ${c.ignoredFiles || 0} | ${c.mergedRef || 'n/a'} | ${c.merged ? 'yes' : 'NO'} | ${c.liveSession ? 'YES' : 'no'} | ${c.kind} | ${c.why} |`);
  }
  const nc = scan?.notConsidered || [];
  if (nc.length) {
    L.push('', '| not considered | reason | size |', '|---|---|---|');
    for (const x of nc) L.push(`| ${x.dir} | ${x.reason} | ${human(du(x.dir))} |`);
  }
  return L.join('\n');
}

// Which criterion kept the worktree, in words: the operator must be able to tell an abandoned worktree from a live
// one without reading the source (E51: the report only said "live session: no" and "merged: yes").
export function classifyWhy(info) {
  switch (info.kind) {
    case 'not-worktree': return 'not a linked worktree';
    case 'live-session': return 'a live session is using it';
    case 'dirty': return 'tracked or untracked changes';
    case 'ignored-files': return 'ignored files would be deleted (not build artifacts)';
    case 'recent-activity': return `git state changed ${info.activityAgeMin ?? 0} min ago`;
    case 'unstarted': return 'the branch has no commits of its own';
    case 'unmerged': return `commits are not in ${info.mergedRef || 'the merge target'}`;
    case 'clone-unknown-repo': return 'not a copy of a repo this product manages';
    case 'clone-live-session': return 'a live session is using it';
    case 'clone-dirty': return 'tracked or untracked changes';
    case 'clone-ignored-files': return 'ignored files would be deleted (not build artifacts)';
    case 'clone-recent-activity': return `git state changed ${info.activityAgeMin ?? 0} min ago`;
    case 'clone-unmerged': return 'the clone has commits of its own';
    default: return info.isClone ? 'scratch clone: clean, no commits of its own' : 'clean, merged, no session';
  }
}

// The worktree section of the report: every candidate, and the blind spot (registered worktrees NOT considered).
export function worktreeReport(scan, { du = duR } = {}) {
  const L = [];
  const repos = scan?.repos || [];
  const nc = scan?.notConsidered || [];
  const ncKB = nc.reduce((n, x) => n + du(x.dir), 0);
  L.push('## Worktrees (registered worktrees of the configured repos)', '');
  const repoDesc = repos.map((r) => r.error ? `${r.key}: ${r.error}`
    : r.skipped ? `${r.key}: skipped (${r.skipped})`
    : `${r.key}: merge target ${r.mergeRef || 'none'}`);
  L.push(`- repos scanned: ${repos.length}${repos.length ? ' (' + repoDesc.join('; ') + ')' : ''}`);
  L.push(`- registered worktrees: ${scan?.registered || 0} (${scan?.dedupe?.entriesDropped || 0} duplicate entries dropped, ${scan?.dedupe?.reposDropped || 0} repo(s) skipped as the same git common dir, ${scan?.missing || 0} missing on disk)`);
  L.push(`- not considered: ${nc.length} worktrees, ${human(ncKB)} (a repo main worktree, or outside the allowed roots)`);
  L.push(`- allowed roots: ${(scan?.roots || []).join(', ') || 'none configured'}`);
  L.push('', '| dir | repo | branch | size | git worktree | clean | ignored files | merged into | merged | live session | class | why |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of scan?.candidates || []) {
    L.push(`| ${w.dir} | ${w.repo} | ${w.branch} | ${human(du(w.dir))} | ${w.isWorktree ? 'yes' : 'no (main clone)'} | ${w.clean ? 'yes' : 'NO'} | ${w.ignoredFiles || 0} | ${w.mergedRef || 'n/a'} | ${w.merged ? 'yes' : 'NO'} | ${w.liveSession ? 'YES' : 'no'} | ${w.kind} | ${w.why} |`);
  }
  if (nc.length) {
    L.push('', '| not considered | repo | reason | size |', '|---|---|---|---|');
    for (const x of nc) L.push(`| ${x.dir} | ${x.repo} | ${x.reason} | ${human(du(x.dir))} |`);
  }
  return L.join('\n');
}

function scratchEntries(root) {
  const out = [];
  let projects = [];
  try { projects = readdirSync(root); } catch { return out; }
  for (const proj of projects) {
    const pdir = join(root, proj);
    let names = [];
    try { if (!lstatSync(pdir).isDirectory()) continue; names = readdirSync(pdir); } catch { continue; }
    for (const name of names) {
      const path = join(pdir, name);
      try { const st = lstatSync(path); out.push({ name, path, isDir: st.isDirectory(), isSymlink: st.isSymbolicLink(), mtimeMs: st.mtimeMs }); } catch {}
    }
  }
  return out;
}

function investigate(ctx) {
  const { home, procs, owners, wtScan, cloneScan } = ctx;
  const L = [];
  L.push('## Top 15 processes by CPU', '', topProcs(procs, owners, 'cpu'), '', '## Top 15 processes by RSS', '', topProcs(procs, owners, 'rss'), '');
  L.push('## Disk use of the usual suspects', '');
  // one `du -d1` per directory (children and total in a single walk), not one du per child
  const dirKids = (dir, n = 15) => cachedSize(`kids:${dir}`, () => {
    const o = shOut('du', ['-k', '-d1', dir], 180000) || '';
    const rows = o.split('\n').filter(Boolean).map((l) => { const m = l.match(/^(\d+)\t(.*)$/); return m ? { kb: +m[1], path: m[2] } : null; }).filter(Boolean);
    const total = rows.find((r) => r.path === dir);
    return { total: total ? total.kb : 0, kids: rows.filter((r) => r.path !== dir).sort((a, b) => b.kb - a.kb).slice(0, n) };
  });
  const tmpK = dirKids('/tmp');
  L.push(`- /tmp total: ${human(tmpK.total)}`);
  for (const k of tmpK.kids) L.push(`  - ${k.path}: ${human(k.kb)}`);
  const cacheK = dirKids(join(home, '.cache'));
  L.push(`- ~/.cache total: ${human(cacheK.total)}`);
  for (const k of cacheK.kids) L.push(`  - ${k.path.replace(home, '~')}: ${human(k.kb)}`);
  L.push(`- ~/.claude: ${human(duR(join(home, '.claude')))}`, `- ~/.npm: ${human(duR(join(home, '.npm')))}`, `- ~/.local/state/ghosty: ${human(duR(join(home, '.local/state/ghosty')))}`);
  const jd = sh('journalctl', ['--user', '--disk-usage']) || sh('journalctl', ['--disk-usage']);
  L.push(`- journal: ${jd ? jd.trim() : 'n/a'}`, '');
  L.push(worktreeReport(wtScan), '');
  L.push(cloneReport(cloneScan), '');
  const dk = sh('docker', ['system', 'df']);
  L.push('## Docker', '', dk ? '```\n' + dk.trim() + '\n```' : 'skipped (docker not usable without sudo)', '');
  return L.join('\n');
}

// ---------------------------------------------------------------- fixes

function runFixes(ctx) {
  const { cfg, dryRun, home, claude, now, log } = ctx;
  if (cfg.fixLevel === 'report') { log.push('- fixLevel "report": no fixes.'); return 0; }
  let freedKB = 0;
  const verb = dryRun ? 'WOULD delete' : 'deleted';
  // (a) dead-session scratch
  const liveIds = new Set(claude.filter((c) => c.alive).map((c) => String(c.sessionId).toLowerCase()));
  const root = '/tmp/claude-1000';
  for (const e of scratchEntries(root)) {
    const el = scratchEligible(e, liveIds, now, cfg.scratchMaxAgeDays);
    if (!el.ok) continue;
    if (!e.path.startsWith(root + '/')) continue;
    const kb = duKB(e.path);
    if (!dryRun) { try { rmSync(e.path, { recursive: true, force: true }); } catch (err) { log.push(`- FAILED ${e.path}: ${err.message}`); continue; } }
    freedKB += kb;
    log.push(`- ${verb} ${e.path} (${human(kb)}, ${((now - e.mtimeMs) / 86400000).toFixed(1)} d old)`);
  }
  // (b) user journal
  if (dryRun) log.push('- WOULD run `journalctl --user --vacuum-time=7d` (if it works without sudo)');
  else {
    const o = sh('journalctl', ['--user', '--vacuum-time=7d']);
    log.push(o === null ? '- journalctl --user --vacuum-time=7d: skipped (needs sudo / failed)' : '- journalctl --user --vacuum-time=7d: ' + (o.trim().split('\n').pop() || 'ok'));
  }
  // (c) npm cache
  const npmKB = duKB(join(home, '.npm'));
  if (npmKB > cfg.npmCacheMB * 1024) {
    if (dryRun) { freedKB += npmKB; log.push(`- WOULD run \`npm cache clean --force\` (~/.npm is ${human(npmKB)}, frees about that)`); }
    else {
      const o = sh('npm', ['cache', 'clean', '--force'], 300000);
      const after = duKB(join(home, '.npm'));
      freedKB += Math.max(0, npmKB - after);
      log.push(`- npm cache clean --force: ${o === null ? 'failed' : 'ok'}, ~/.npm ${human(npmKB)} -> ${human(after)}`);
    }
  } else log.push(`- npm cache ${human(npmKB)}: below ${cfg.npmCacheMB} MB, left alone`);
  return freedKB;
}

export function runOptionalFixes(ctx, issues) {
  const { cfg, dryRun, wts, log } = ctx;
  const verb = dryRun ? 'WOULD' : 'did';
  let freedKB = 0;
  if (cfg.fixLevel !== 'report') {   // an orphaned test run is never someone's work: killed at every cleanup level
    for (const i of issues.filter((x) => x.type === 'test-leftover')) {
      const pids = i.leftovers.flatMap((l) => l.pids);
      if (!dryRun) {
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }
      }
      i.fixed = true;
      log.push(`- ${verb} kill ${pids.length} processes of ${i.leftovers.length} orphaned test run(s): ${i.leftovers.map((l) => l.pid).join(', ')}`);
    }
  }
  if (cfg.fixLevel === 'cleanup+orphans' || cfg.fixLevel === 'cleanup+all') {   // killing orphans is its own opt-in
    for (const i of issues) {
      if ((i.type === 'runaway' || i.type === 'stuck') && i.orphan && i.pid) {
        if (!dryRun) { try { process.kill(i.pid, 'SIGTERM'); } catch {} }
        i.fixed = true;
        log.push(`- ${verb} SIGTERM pid ${i.pid} (${i.title}): no live tmux or Claude session owns it`);
      }
    }
  }
  if (cfg.fixLevel === 'cleanup+worktrees' || cfg.fixLevel === 'cleanup+all') {
    for (const w of wts.filter((x) => x.kind === 'removable')) {
      const kb = duKB(w.dir);
      if (w.isClone) {
        // A plain clone is in no worktree registry: the scratch directory itself is what goes.
        let st = null;
        try { st = lstatSync(w.dir); } catch {}
        if (!st || !st.isDirectory() || st.isSymbolicLink()) { log.push(`- FAILED to remove clone ${w.dir}: not a plain directory`); continue; }
        if (!dryRun) { try { rmSync(w.dir, { recursive: true, force: true }); } catch (err) { log.push(`- FAILED to remove clone ${w.dir}: ${err.message}`); continue; } }
        freedKB += kb;
        log.push(`- ${dryRun ? 'WOULD delete' : 'deleted'} clone ${w.dir} (${human(kb)}, scratch copy of ${w.repo}: clean, no commits of its own)`);
        continue;
      }
      const o = dryRun ? '' : sh('git', ['-C', w.dir, 'worktree', 'remove', w.dir], 120000);
      if (!dryRun && o === null) { log.push(`- FAILED to remove worktree ${w.dir}`); continue; }
      freedKB += kb;
      log.push(`- ${dryRun ? 'WOULD remove' : 'removed'} worktree ${w.dir} (${human(kb)}, clean, merged, no session)`);
    }
  }
  return freedKB;
}

// ---------------------------------------------------------------- main

export async function run({ home = homedir(), argv = process.argv.slice(2), now = Date.now(), out = console.log } = {}) {
  const force = argv.includes('--force'), dryRun = argv.includes('--dry-run');
  const stateDir = join(home, '.local/state/ghosty');
  mkdirSync(stateDir, { recursive: true });
  const cfg = loadConfig(join(stateDir, 'health-watch.json'));
  const statePath = join(stateDir, 'health-watch-state.json');
  const state = loadState(statePath);
  const cores = cpus().length, [l1, , ] = loadavg();
  const load5 = loadavg()[1];
  const tmpClean = cleanTmp({ dryRun });   // before the inode read, so a freed backlog counts
  if (tmpClean.removed || tmpClean.failed) out(`tmp auto-clean: ${dryRun ? 'would remove' : 'removed'} ${tmpClean.removed} stale test dirs${tmpClean.truncated ? ' (budget hit, rest next tick)' : ''}${tmpClean.failed ? `, ${tmpClean.failed} failed` : ''}`);
  const mem = readMem(), disk = readDisk(), inodes = readInodes('/');
  const procs = readPs();

  // Sustained CPU: only for processes already old enough to be runaway candidates.
  const cands = procs.filter((p) => p.mine && p.etimes > cfg.runawayHours * 3600);
  const t0 = new Map(cands.map((p) => [p.pid, cpuTicks(p.pid)]));
  if (cands.length) await new Promise((r) => setTimeout(r, 5000));
  for (const p of cands) { const a = t0.get(p.pid), b = cpuTicks(p.pid); p.cpu = a != null && b != null ? ((b - a) / 100 / 5) * 100 : 0; }

  const claude = claudeSessions(home);
  const panes = tmuxPanes();
  const table = new Map(procs.map((p) => [p.pid, p.ppid]));
  const paneMap = new Map(panes.map((p) => [p.pid, p.name]));
  const claudeMap = new Map(claude.filter((c) => c.alive).map((c) => [c.pid, c]));
  const owners = (pid) => resolveOwner(pid, table, paneMap, claudeMap);
  const protectedPids = new Set([process.pid, ...claudeMap.keys()]);

  const metrics = {
    diskPct: disk.pct, diskFreeGB: disk.freeGB, inodePct: inodes.pct, inodeFree: inodes.free, load1: l1, load5, cores,
    ramAvailPct: mem.total ? (mem.avail / mem.total) * 100 : 100,
    runaways: findRunaways(procs, cfg, protectedPids, new Set(paneMap.keys())).map((p) => ({ p, owner: owners(p.pid) })),
    stuck: procs.filter((p) => p.mine && p.pid !== process.pid && isStuckNodeTest(p.args)).map((p) => ({ p, owner: owners(p.pid) })),
    defunct: procs.filter((p) => p.stat.startsWith('Z')).length,
    leftovers: findTestLeftovers(procs, cfg.testLeftoverMin, protectedPids),
  };
  state.samples = [...state.samples, { t: now, load1: l1, load5 }].filter((s) => s.t >= now - (cfg.loadMinutes + 10) * 60000);
  const loadTrip = evalLoad(state.samples, now, cores, cfg.loadPerCore, cfg.loadMinutes).tripped;
  let issues = evaluate(metrics, cfg, loadTrip);

  if (!issues.length) {
    state.issues = {};   // everything recovered: a recurrence wakes the manager again
    if (!force) { saveState(statePath, state); return { status: 'healthy', issues: [] }; }
  }
  // Keep debounce entries only for issues still present.
  for (const k of Object.keys(state.issues)) if (!issues.some((i) => `health:${i.key}` === k)) delete state.issues[k];

  // INVESTIGATE
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  const reportsDir = join(stateDir, 'health-reports');
  const reportPath = join(reportsDir, `${iso}.md`);
  const duPath = join(stateDir, 'health-du-cache.json');
  try { duCache = Object.fromEntries(Object.entries(JSON.parse(readFileSync(duPath, 'utf8'))).filter(([, e]) => now - e.at < DU_TTL_MS)); } catch { duCache = {}; }
  const procCwds = readProcCwds(procs);
  const procArgs = procs.filter((p) => p.mine).map((p) => ({ pid: p.pid, args: p.args }));
  const procFds = readProcFds(procs);
  const wtScan = scanWorktrees({ cfg, panes, claude, procCwds, procArgs, procFds, now });
  // A plain clone is not a registered worktree: without this scan the reclaim never sees it (E37).
  // The state dirs are searched for the lane's config: its clones are machinery, not scratch.
  const stateDirs = [...new Set([stateDir, process.env.GHOSTY_STATE_DIR].filter(Boolean))];
  const cloneScan = scanClones({ cfg, repos: wtScan.repos, stateDirs, panes, claude, procCwds, procArgs, procFds, now });
  const wts = [...wtScan.candidates, ...cloneScan.candidates];
  const ctx = { cfg, dryRun, home, claude, now, procs, owners, panes, wts, wtScan, cloneScan, log: [] };
  const R = [`# Codebox health report ${new Date(now).toISOString()}${dryRun ? ' (DRY RUN)' : ''}${force ? ' (forced)' : ''}`, ''];
  R.push('## Checks', '', `- disk /: ${disk.pct}% (${disk.freeGB} GB free), limit ${cfg.diskPct}%`, `- inodes /: ${inodes.pct}% used (${inodes.free} free), limit ${cfg.inodePct}%`, `- load: ${l1.toFixed(2)} / ${load5.toFixed(2)} on ${cores} cores (limit ${cfg.loadPerCore}/core for ${cfg.loadMinutes} min, sustained: ${loadTrip})`,
    `- RAM available: ${metrics.ramAvailPct.toFixed(1)}%, limit ${cfg.ramAvailPct}%`, `- runaways: ${metrics.runaways.length}, stuck node --test: ${metrics.stuck.length}, orphaned test runs: ${metrics.leftovers.length}, defunct: ${metrics.defunct}`, '',
    '**Tripped:** ' + (issues.length ? issues.map((i) => i.title).join('; ') : 'none (forced run)'), '');
  R.push(investigate({ home, procs, owners, panes, claude, wtScan, cloneScan }));
  try { writeFileSync(duPath, JSON.stringify(duCache)); } catch {}

  // SAFE AUTO-FIX
  let freedKB = 0;
  const diskIssue = issues.find((i) => i.type === 'disk');
  R.push(`## Auto-fix (fixLevel "${cfg.fixLevel}"${dryRun ? ', dry run' : ''})`, '');
  if (diskIssue) freedKB = runFixes(ctx);
  else ctx.log.push('- disk check not tripped: no cleanup');
  freedKB += runOptionalFixes(ctx, issues) || 0;   // the removed worktrees and clones count as freed too
  R.push(...ctx.log, '', `Freed${dryRun ? ' (would free)' : ''}: ${human(freedKB)}`, '');

  // RE-CHECK
  let remaining = issues;
  if (!dryRun) {
    const d2 = readDisk();
    R.push(`Disk after fixes: ${d2.pct}% (${d2.freeGB} GB free)`, '');
    remaining = issues.filter((i) => !(i.type === 'disk' && d2.pct < cfg.diskPct) && !i.fixed);
    for (const i of remaining) if (i.type === 'disk') { i.severity = d2.pct; i.title = `disk ${d2.pct}% full`; i.what = `Disk / is ${d2.pct}% full (${d2.freeGB} GB free, limit ${cfg.diskPct}%).`; }
  } else if (diskIssue) {
    const totalGB = disk.freeGB / Math.max(0.01, 1 - disk.pct / 100);
    const wouldPct = Math.round(disk.pct - (freedKB * 1024 / 1e9 / totalGB) * 100);
    R.push(`Estimated disk after fixes: ~${wouldPct}%`, '');
    if (wouldPct < cfg.diskPct) remaining = issues.filter((i) => i.type !== 'disk');
  }

  // WAKE
  const fixedNote = freedKB > 0 && !dryRun ? `Auto-freed ${human(freedKB)}.` : (dryRun ? '' : 'Nothing safe to auto-clean.');
  const events = [];
  R.push('## Manager wake', '');
  if (!remaining.length) R.push('No problem remains after the fixes: manager NOT woken.');
  for (const i of remaining) {
    const prev = state.issues[`health:${i.key}`];
    const d = shouldWake(i, prev, now, cfg.debounceHours);
    if (!d.wake) { R.push(`- ${i.key}: ${d.why}, not written`); continue; }
    const ev = buildEvent(i, fixedNote, reportPath, now);
    events.push(ev);
    R.push(`- ${i.key}: ${dryRun ? 'WOULD write' : 'wrote'} (${d.why}): \`${JSON.stringify(ev)}\``);
    if (!dryRun) {
      await appendFile(join(stateDir, 'manager-events.jsonl'), JSON.stringify(ev) + '\n');
      state.issues[ev.key] = { at: now, severity: i.severity };
    }
  }
  R.push('', '## Manager filter', '', 'monitor-filter.sh only drops kind "deploy" start/done and `jev.pick=="ignore"` deploy lines: kind "health" lines pass (no change needed).');

  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(reportPath, R.join('\n') + '\n');
  // retention: 7 days
  try { for (const f of readdirSync(reportsDir)) { const p = join(reportsDir, f); if (f.endsWith('.md') && now - statSync(p).mtimeMs > 7 * 86400000) rmSync(p); } } catch {}
  if (!dryRun) saveState(statePath, state); else saveState(statePath, { ...state, issues: loadState(statePath).issues });
  out(`health-watch: ${issues.length} tripped (${issues.map((i) => i.key).join(', ') || 'none'}), ${dryRun ? 'would free' : 'freed'} ${human(freedKB)}, ${events.length} event(s) ${dryRun ? 'would be written' : 'written'}, report ${reportPath}`);
  return { status: remaining.length ? 'problem' : 'fixed', issues, remaining, events, freedKB, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error('health-watch failed:', e); process.exit(1); });
}
