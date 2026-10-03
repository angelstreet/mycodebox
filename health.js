// Codebox health: CPU %, load vs cores, RAM, disk. Linux only (/proc + statfs).
// Pure parsers are exported for tests; sampleHealth() does the I/O.

import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';

export const WARN_PCT = Number(process.env.HEALTH_WARN_PCT || 85);
export const CRIT_PCT = Number(process.env.HEALTH_CRIT_PCT || 95);

export function levelOf(pct, warn = WARN_PCT, crit = CRIT_PCT) {
  if (pct == null || Number.isNaN(pct)) return 'unknown';
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'ok';
}

// First "cpu " line of /proc/stat -> { idle, total } in jiffies.
export function parseProcStat(text) {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal (guest* are already inside user/nice)
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  const idle = (v[3] || 0) + (v[4] || 0);
  return { idle, total };
}

export function cpuPct(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (cur.idle - prev.idle) / dt)));
}

// /proc/meminfo -> bytes. "Used" = total - available, as `free` reports it.
export function parseMeminfo(text) {
  const kb = (k) => {
    const m = text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal'), avail = kb('MemAvailable');
  if (!total || avail == null) return null;
  return { total, used: total - avail, free: avail, pct: 100 * (total - avail) / total };
}

// statfs -> df-style numbers: used% = used / (used + available to non-root).
export function diskFromStatfs(path, s) {
  const used = (s.blocks - s.bfree) * s.bsize;
  const free = s.bavail * s.bsize;
  const pct = used + free > 0 ? 100 * used / (used + free) : null;
  return { path, total: s.blocks * s.bsize, used, free, pct };
}

// Load is "warn" when the 1-min average reaches the core count, "crit" at twice it.
export function loadLevel(load1, cores) {
  if (!cores) return 'unknown';
  return levelOf(100 * load1 / cores, 100, 200);
}

let prevStat = null;

export async function sampleHealth(disks = ['/']) {
  const [statText, memText, ...fs] = await Promise.all([
    readFile('/proc/stat', 'utf8').catch(() => ''),
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    ...disks.map((d) => statfs(d).then((s) => diskFromStatfs(d, s), () => null)),
  ]);
  const cur = parseProcStat(statText);
  const cpu = cpuPct(prevStat, cur);
  prevStat = cur;
  const cores = cpus().length;
  const load = loadavg();
  const mem = parseMeminfo(memText);
  const diskList = fs.filter(Boolean).map((d) => ({ ...d, level: levelOf(d.pct) }));
  return {
    at: Date.now(),
    cpu: { pct: cpu, level: levelOf(cpu) },
    load: { avg: load, cores, level: loadLevel(load[0], cores) },
    mem: mem ? { ...mem, level: levelOf(mem.pct) } : null,
    disks: diskList,
  };
}
