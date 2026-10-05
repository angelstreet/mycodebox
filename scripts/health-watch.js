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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, statfsSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, cpus, loadavg } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = {
  diskPct: 85,            // trip when / is at least this full
  loadPerCore: 1.0,       // trip when load1 AND load5 per core exceed this ...
  loadMinutes: 10,        // ... for this long (state file keeps the samples)
  ramAvailPct: 10,        // trip when MemAvailable is below this % of MemTotal
  runawayHours: 2,        // runaway = owned by this user, older than this, AND ...
  runawayRssMB: 1024,     // ... RSS above this, OR ...
  runawayCpu: 80,         // ... CPU above this % between two samples 5 s apart
  defunctMax: 50,         // stuck pattern: more defunct processes than this
  scratchMaxAgeDays: 2,   // /tmp/claude-1000 session scratch older than this (and session dead) is deletable
  npmCacheMB: 1024,       // npm cache is cleaned only above this size
  debounceHours: 6,       // same issue key is written to the manager feed at most once per this
  fixLevel: 'cleanup',    // report | cleanup | cleanup+orphans | cleanup+worktrees
};
export const FIX_LEVELS = ['report', 'cleanup', 'cleanup+orphans', 'cleanup+worktrees'];
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

const SKIP_RUNAWAY = (p, protectedPids) =>
  protectedPids.has(p.pid) || /^(claude|tmux)\b/.test(basename(p.args.split(' ')[0] || '')) || /tmux: (server|client)/.test(p.args)
  || /ghosty-sessions\/server\.js/.test(p.args);

// procs: [{pid, ppid, etimes, rssKB, args, stat, mine, cpu?}] ; cpu = % between two samples (optional)
export function findRunaways(procs, cfg, protectedPids = new Set()) {
  return procs.filter((p) => p.mine && p.etimes > cfg.runawayHours * 3600 && !SKIP_RUNAWAY(p, protectedPids)
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

// Worktree classification. info: {isWorktree, clean, merged, liveSession}
export function classifyWorktree(info) {
  if (!info.isWorktree) return 'not-worktree';
  if (info.liveSession) return 'live-session';
  if (!info.clean) return 'dirty';
  if (!info.merged) return 'unmerged';
  return 'removable';
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
  if (m.defunct > cfg.defunctMax) issues.push({ type: 'defunct', key: 'defunct', severity: m.defunct, decision: true, title: `${m.defunct} defunct processes`, what: `${m.defunct} defunct (zombie) processes, limit ${cfg.defunctMax}.` });
  return issues;
}

// ---------------------------------------------------------------- system access

const sh = (cmd, args, timeout = 20000) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
// du exits non-zero on unreadable entries but its stdout is still the answer
const shOut = (cmd, args, timeout) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return typeof e.stdout === 'string' ? e.stdout : null; } };
const duKB = (path) => { const o = shOut('du', ['-sk', path], 120000); const n = o ? parseInt(o, 10) : NaN; return Number.isFinite(n) ? n : 0; };
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

export function worktreeInfos(home, panes, claude) {
  const out = [];
  let names = [];
  try { names = readdirSync(home).filter((n) => /^(vpt-|ghosty-)/.test(n)); } catch {}
  for (const n of names) {
    const dir = join(home, n);
    let st; try { st = lstatSync(join(dir, '.git')); } catch { continue; }
    const isWorktree = st.isFile();
    const porcelain = sh('git', ['-C', dir, 'status', '--porcelain']);
    const clean = porcelain !== null && porcelain.trim() === '';
    const merged = sh('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', 'main']) !== null;
    const live = panes.some((p) => p.path === dir || p.path.startsWith(dir + '/')) || claude.some((c) => c.alive && (c.cwd === dir || c.cwd.startsWith(dir + '/')));
    const branch = (sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
    out.push({ name: n, dir, branch, isWorktree, clean, merged, liveSession: live, kind: classifyWorktree({ isWorktree, clean, merged, liveSession: live }) });
  }
  return out;
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
  const { home, procs, owners, panes, claude, wts } = ctx;
  const L = [];
  L.push('## Top 15 processes by CPU', '', topProcs(procs, owners, 'cpu'), '', '## Top 15 processes by RSS', '', topProcs(procs, owners, 'rss'), '');
  L.push('## Disk use of the usual suspects', '');
  // one `du -d1` per directory (children and total in a single walk), not one du per child
  const dirKids = (dir, n = 15) => {
    const o = shOut('du', ['-k', '-d1', dir], 180000) || '';
    const rows = o.split('\n').filter(Boolean).map((l) => { const m = l.match(/^(\d+)\t(.*)$/); return m ? { kb: +m[1], path: m[2] } : null; }).filter(Boolean);
    const total = rows.find((r) => r.path === dir);
    return { total: total ? total.kb : 0, kids: rows.filter((r) => r.path !== dir).sort((a, b) => b.kb - a.kb).slice(0, n) };
  };
  const tmpK = dirKids('/tmp');
  L.push(`- /tmp total: ${human(tmpK.total)}`);
  for (const k of tmpK.kids) L.push(`  - ${k.path}: ${human(k.kb)}`);
  const cacheK = dirKids(join(home, '.cache'));
  L.push(`- ~/.cache total: ${human(cacheK.total)}`);
  for (const k of cacheK.kids) L.push(`  - ${k.path.replace(home, '~')}: ${human(k.kb)}`);
  L.push(`- ~/.claude: ${human(duKB(join(home, '.claude')))}`, `- ~/.npm: ${human(duKB(join(home, '.npm')))}`, `- ~/.local/state/ghosty: ${human(duKB(join(home, '.local/state/ghosty')))}`);
  const jd = sh('journalctl', ['--user', '--disk-usage']) || sh('journalctl', ['--disk-usage']);
  L.push(`- journal: ${jd ? jd.trim() : 'n/a'}`, '');
  L.push('## Worktrees (~/vpt-*, ~/ghosty-*)', '', '| dir | branch | size | git worktree | clean | merged into main | live session | class |', '|---|---|---|---|---|---|---|---|');
  for (const w of wts) L.push(`| ${w.name} | ${w.branch} | ${human(duKB(w.dir))} | ${w.isWorktree ? 'yes' : 'no (main clone)'} | ${w.clean ? 'yes' : 'NO'} | ${w.merged ? 'yes' : 'NO'} | ${w.liveSession ? 'YES' : 'no'} | ${w.kind} |`);
  L.push('');
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

function runOptionalFixes(ctx, issues) {
  const { cfg, dryRun, wts, log } = ctx;
  const verb = dryRun ? 'WOULD' : 'did';
  if (cfg.fixLevel === 'cleanup+orphans' || cfg.fixLevel === 'cleanup+worktrees') {
    for (const i of issues) {
      if ((i.type === 'runaway' || i.type === 'stuck') && i.orphan && i.pid) {
        if (!dryRun) { try { process.kill(i.pid, 'SIGTERM'); } catch {} }
        i.fixed = true;
        log.push(`- ${verb} SIGTERM pid ${i.pid} (${i.title}): no live tmux or Claude session owns it`);
      }
    }
  }
  if (cfg.fixLevel === 'cleanup+worktrees') {
    for (const w of wts.filter((x) => x.kind === 'removable')) {
      if (!dryRun) {
        const o = sh('git', ['-C', w.dir, 'worktree', 'remove', w.dir], 120000);
        log.push(o === null ? `- FAILED to remove worktree ${w.dir}` : `- removed worktree ${w.dir} (clean, merged, no session)`);
      } else log.push(`- WOULD remove worktree ${w.dir} (clean, merged, no session)`);
    }
  }
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
  const mem = readMem(), disk = readDisk();
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
    diskPct: disk.pct, diskFreeGB: disk.freeGB, load1: l1, load5, cores,
    ramAvailPct: mem.total ? (mem.avail / mem.total) * 100 : 100,
    runaways: findRunaways(procs, cfg, protectedPids).map((p) => ({ p, owner: owners(p.pid) })),
    stuck: procs.filter((p) => p.mine && p.pid !== process.pid && isStuckNodeTest(p.args)).map((p) => ({ p, owner: owners(p.pid) })),
    defunct: procs.filter((p) => p.stat.startsWith('Z')).length,
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
  const wts = worktreeInfos(home, panes, claude);
  const ctx = { cfg, dryRun, home, claude, now, procs, owners, panes, wts, log: [] };
  const R = [`# Codebox health report ${new Date(now).toISOString()}${dryRun ? ' (DRY RUN)' : ''}${force ? ' (forced)' : ''}`, ''];
  R.push('## Checks', '', `- disk /: ${disk.pct}% (${disk.freeGB} GB free), limit ${cfg.diskPct}%`, `- load: ${l1.toFixed(2)} / ${load5.toFixed(2)} on ${cores} cores (limit ${cfg.loadPerCore}/core for ${cfg.loadMinutes} min, sustained: ${loadTrip})`,
    `- RAM available: ${metrics.ramAvailPct.toFixed(1)}%, limit ${cfg.ramAvailPct}%`, `- runaways: ${metrics.runaways.length}, stuck node --test: ${metrics.stuck.length}, defunct: ${metrics.defunct}`, '',
    '**Tripped:** ' + (issues.length ? issues.map((i) => i.title).join('; ') : 'none (forced run)'), '');
  R.push(investigate({ home, procs, owners, panes, claude, wts }));

  // SAFE AUTO-FIX
  let freedKB = 0;
  const diskIssue = issues.find((i) => i.type === 'disk');
  R.push(`## Auto-fix (fixLevel "${cfg.fixLevel}"${dryRun ? ', dry run' : ''})`, '');
  if (diskIssue) freedKB = runFixes(ctx);
  else ctx.log.push('- disk check not tripped: no cleanup');
  runOptionalFixes(ctx, issues);
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
