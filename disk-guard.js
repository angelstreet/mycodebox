// Disk-space safety policy (adoption #3, docs/comparisons/mycodebox-vs-cloudroom.md).
//
// mycodebox used to only *report* a full disk (the health strip and the ntfy push). Cloudroom blocks new work
// when the workspace/history volume falls below a threshold, with a reason code. This module is that policy:
//
//   - below the warn threshold (default 85 % used) a banner shows with the reason code `disk_low`;
//   - at or above the hold threshold (default 90 % used) *starting new work* is refused with HTTP 409 and the
//     same reason code: new dashboard sessions, resumed sessions and new V2 tasks;
//   - existing sessions, sends, deploys and the AI manager are never blocked.
//
// The switch lives in the state dir's manager.json (`diskGuard`) or in the environment. The guard is ON by
// default; the owner can turn it off, or override the hold once, with an explicit flag.
//
// Everything here is read-only: statfs for the volumes, du for the top consumers. Nothing is ever deleted.

import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { diskFromStatfs } from './health.js';

export const REASON = 'disk_low';          // the reason code the API and the banner use
export const HOLD_PCT = 90;                // >= 90 % used: new work is refused
export const WARN_PCT = 85;                // >= 85 % used: the banner shows, work continues
export const STATUS_TTL_MS = 15_000;       // the disk numbers are cached this long
export const CONSUMER_TTL_MS = 5 * 60_000; // the top-consumers scan is cached this long (du is not free)
export const TOP_LIMIT = 8;

const LEVEL_RANK = { unknown: 0, ok: 1, warn: 2, hold: 3 };

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const on = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes';
const off = (v) => v === false || v === 0 || v === '0' || v === 'off' || v === 'false' || v === 'no';
const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
  : typeof v === 'string' ? v.split(/[,:]/).map((s) => s.trim()).filter(Boolean) : []);

// ok | warn | hold | unknown — the level of one volume against the thresholds.
export function diskLevel(pct, { holdPct = HOLD_PCT, warnPct = WARN_PCT } = {}) {
  if (pct == null || !Number.isFinite(Number(pct))) return 'unknown';
  const p = Number(pct);
  if (p >= holdPct) return 'hold';
  if (p >= warnPct) return 'warn';
  return 'ok';
}

export const gb = (bytes) => `${(Number(bytes || 0) / 2 ** 30).toFixed(1)} GB`;

// The policy as the owner set it: manager.json first (the owner's saved setting, read fresh every time),
// the environment second, the built-in defaults last.
export function guardConfig({ file, env = process.env, defaultPaths = [] } = {}) {
  const j = readJson(file);
  const g = (j && typeof j.diskGuard === 'object' && j.diskGuard !== null && !Array.isArray(j.diskGuard)) ? j.diskGuard : {};
  let enabled = true;
  if (g.enabled !== undefined) enabled = !off(g.enabled);
  else if (env.GHOSTY_DISK_GUARD !== undefined && env.GHOSTY_DISK_GUARD !== '') enabled = !off(env.GHOSTY_DISK_GUARD);
  const holdPct = clamp(num(g.holdPct ?? env.GHOSTY_DISK_HOLD_PCT, HOLD_PCT), 0, 100);
  const warnPct = clamp(num(g.warnPct ?? env.GHOSTY_DISK_WARN_PCT, WARN_PCT), 0, Math.max(0, holdPct - 1));
  const override = on(g.override) || on(env.GHOSTY_DISK_OVERRIDE);
  const fromFile = asList(g.paths);
  const fromEnv = asList(env.GHOSTY_DISK_PATHS);
  const paths = fromFile.length ? fromFile : fromEnv.length ? fromEnv : defaultPaths;
  return { enabled, holdPct, warnPct, override, paths };
}

// statfs every watched path; the same volume listed twice is reported once.
export async function sampleDisks(paths, statfsImpl = statfs) {
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    let s = null;
    try { s = await statfsImpl(p); } catch { continue; }   // gone or not readable: no reading, no crash
    if (!s) continue;
    const key = s.dev ?? p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diskFromStatfs(p, s));
  }
  return out;
}

// "1234\t/path/to/x" -> { bytes, path }
export function parseDu(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\d+)\t(.*)$/);
    if (m) out.push({ bytes: Number(m[1]) * 1024, path: m[2] });
  }
  return out;
}

// du -k: one line per argument (or per child with --max-depth). `-s` cannot be combined with --max-depth, so the
// depth mode drops it. Unreadable paths are skipped by du itself; what it could measure is what we keep.
function duRun(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile('du', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(parseDu(stdout));
    });
  });
}

function gitWorktrees(repoRoot) {
  if (!repoRoot) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim()).filter(Boolean));
    });
  });
}

// The plain-words line the owner reads on the banner and in the 409 body.
export function holdMessage(status, what = 'new work') {
  const d = status?.worst;
  const pct = d && d.pct != null ? Math.round(d.pct) : null;
  const where = d ? ` on ${d.path}` : '';
  const free = d ? ` (${gb(d.free)} free)` : '';
  return `The disk is ${pct != null ? `${pct}% full` : 'nearly full'}${where}${free}. `
    + `${what} is paused until it drops below ${status?.holdPct ?? HOLD_PCT}%. `
    + 'Sessions that are already running are not affected — free some space and try again.';
}

export function createDiskGuard({
  configFile, env = process.env, defaultPaths = [], stateDir = null, workRoot = null, repoRoot = null,
  statfsImpl = statfs, now = () => Date.now(), log = () => {},
} = {}) {
  let diskCache = null;      // { key, at, disks }
  let consumerCache = null;  // { at, rows }
  let consumerBusy = null;   // the in-flight scan

  const config = () => guardConfig({ file: configFile, env, defaultPaths });

  async function disks(cfg) {
    const key = cfg.paths.join('\0');
    if (diskCache && diskCache.key === key && now() - diskCache.at < STATUS_TTL_MS) return diskCache.disks;
    const disks = await sampleDisks(cfg.paths, statfsImpl);
    diskCache = { key, at: now(), disks };
    return disks;
  }

  async function compute() {
    const cfg = config();
    const list = (await disks(cfg)).map((d) => ({ ...d, level: diskLevel(d.pct, cfg) }));
    const worst = list.reduce((a, d) => (a == null || LEVEL_RANK[d.level] > LEVEL_RANK[a.level] ? d : a), null);
    const level = worst ? worst.level : 'unknown';
    const show = cfg.enabled && (level === 'warn' || level === 'hold');
    return {
      ok: true,
      reason: show ? REASON : null,
      level,
      hold: level === 'hold',
      blocked: level === 'hold' && cfg.enabled && !cfg.override,   // does new work get refused?
      enabled: cfg.enabled,
      override: cfg.override,
      holdPct: cfg.holdPct,
      warnPct: cfg.warnPct,
      paths: cfg.paths,
      disks: list,
      worst,
      at: now(),
    };
  }

  // The top consumers: the state dir, the V2 work root and the git worktrees, biggest first.
  async function scan() {
    const rows = [];
    if (stateDir) {
      for (const r of await duRun(['-k', '--max-depth=1', '--', stateDir])) if (r.path !== stateDir) rows.push({ ...r, label: 'state' });
    }
    if (workRoot) {
      for (const r of await duRun(['-k', '--max-depth=2', '--', workRoot])) {
        if (r.path === workRoot) continue;
        rows.push({ ...r, label: r.path.startsWith(`${workRoot}/wt/`) ? 'worktree' : 'v2' });
      }
    }
    const wts = await gitWorktrees(repoRoot);
    if (wts.length) {
      for (const r of await duRun(['-k', '--', ...wts])) rows.push({ ...r, label: 'worktree' });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows.slice(0, TOP_LIMIT);
  }

  async function consumers() {
    if (consumerCache && now() - consumerCache.at < CONSUMER_TTL_MS) return consumerCache.rows;
    if (!consumerBusy) {
      consumerBusy = (async () => {
        try { consumerCache = { at: now(), rows: await scan() }; }
        catch (e) { log('[disk-guard] consumers', e.message); }
        finally { consumerBusy = null; }
      })();
    }
    if (!consumerCache) await consumerBusy;   // first call waits; later stale calls get the old rows
    return consumerCache ? consumerCache.rows : [];
  }

  // The decision point: refuse new work when the disk is at or above the hold threshold.
  // Never refuses existing sessions, sends, deploys or the manager.
  async function assertStart(what = 'new work') {
    const cfg = config();               // fresh: the owner's switch applies at once
    if (!cfg.enabled || cfg.override) return null;
    const status = await compute();
    if (status.level !== 'hold') return null;
    const message = holdMessage(status, what);
    throw Object.assign(new Error(message), { status: 409, code: REASON, reason: REASON, disk: status });
  }

  // For the V2 worktree path: the same decision, as a coded error the goal loop understands.
  async function admit() {
    const cfg = config();
    if (!cfg.enabled || cfg.override) return { ok: true };
    const status = await compute();
    if (status.level !== 'hold') return { ok: true };
    return { ok: false, code: REASON, reason: REASON, message: holdMessage(status, 'new work'), status };
  }

  return {
    config,
    status: compute,
    async detail() {
      const status = await compute();
      return { ...status, top: await consumers() };
    },
    assertStart,
    admit,
  };
}
