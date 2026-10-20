#!/usr/bin/env node
// Root daemon: sorts everything the tmux server spawns into three systemd slices, so a test burst or a leak can no
// longer starve the manager. Before it, all panes shared the tmux server's unit and its default TasksMax (1027): leaked
// dev stacks plus 3-4 parallel `npm test` runs hit the cap, thread creation failed and claude died with "Aborted".
//   core     (CGROUP_CORE, default manager,mycodebox-v2,mm-manager)  codebox-core.slice      no cap, CPU first
//   sessions (every other tmux session, one scope each)               codebox-sessions.slice  6144 tasks
//   tests    (npm test/ci, node --test, pytest, vitest, jest, ...)   codebox-tests.slice     1024 tasks, CPU last
// A process whose parent died (ppid 1) goes to cb-orphans.scope in the sessions slice: it still counts, and
// `systemd-cgtop` names it. Scopes are created by systemd (StartTransientUnit), later pids join through cgroup.procs.
//   scripts/cgroup-placer.js            (systemd/ghosty-cgroup-placer.service, as root, polls every 2 s)
//   scripts/cgroup-placer.js --dry-run  (print one pass of decisions, move nothing)
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';

const CG = '/sys/fs/cgroup';
export const SOURCE = process.env.CGROUP_SOURCE || 'system.slice/mm-manager-session.service';
export const SLICES = { core: 'codebox-core.slice', sessions: 'codebox-sessions.slice', tests: 'codebox-tests.slice' };
const CORE = new Set((process.env.CGROUP_CORE || 'manager,mycodebox-v2,mm-manager').split(',').map((s) => s.trim()).filter(Boolean));
const TMUX_SOCKET = process.env.CGROUP_TMUX_SOCKET || '/tmp/tmux-1000/default';
const SH_TEST_RE = /(?:^|[\s;&|(/])(?:npm(?:\s+run)?\s+(?:test|ci)\b|node\s+--test\b|pnpm\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|playwright\s+test)\b|pytest\b)/;
const base = (t = '') => t.slice(t.lastIndexOf('/') + 1);
// Judged on argv shape, not on any substring: an agent's prompt in its own argv may mention "npm test".
export function isTest(cmd) {
  const t = cmd.trim().split(/\s+/); const b = base(t[0]);
  const runner = (i) => ['npm', 'pnpm', 'yarn'].includes(base(t[i])) && ['test', 'ci', 'run'].includes(t[i + 1]) && (t[i + 1] !== 'run' || t[i + 2] === 'test');
  if (['npm', 'pnpm', 'yarn'].includes(b)) return runner(0);
  if (b === 'npx') return ['vitest', 'jest'].includes(t[1]) || (t[1] === 'playwright' && t[2] === 'test');
  if (['pytest', 'vitest', 'jest'].includes(b)) return true;
  if (/^python3?(?:\.\d+)?$/.test(b)) return t[1] === '-m' && t[2] === 'pytest';
  if (b === 'node') {   // node --test and its per-file children carry --test* flags before the script
    for (const a of t.slice(1)) { if (!a.startsWith('-')) break; if (/^--test(?:$|-|=)/.test(a)) return true; }
    return runner(1);
  }
  if (['sh', 'bash', 'dash'].includes(b) && t[1] === '-c') return SH_TEST_RE.test(t.slice(2).join(' '));
  return false;
}
export const scopeName = (session) => `cb-${String(session).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60)}.scope`;

// procs: Map pid -> { ppid, cmd, cg }. panes: Map panePid -> session name. tmuxPids: the tmux server(s), never moved.
// Returns [{ pid, slice, scope }] for every process not already where it belongs.
export function plan(procs, panes, tmuxPids = new Set()) {
  const out = [];
  const owner = (pid) => {
    for (let p = pid, i = 0; p && i < 64; i++) {
      if (panes.has(p)) return panes.get(p);
      const e = procs.get(p); if (!e) return null;
      if (e.ppid <= 1) return null;
      p = e.ppid;
    }
    return null;
  };
  const testRoot = (pid) => {   // a process under a test runner is a test too (npm -> sh -> node --test -> node file.test.js)
    for (let p = pid, i = 0; p && i < 64; i++) {
      const e = procs.get(p); if (!e) return false;
      if (isTest(e.cmd)) return true;
      if (panes.has(p)) return false;
      p = e.ppid;
    }
    return false;
  };
  for (const [pid, e] of procs) {
    if (tmuxPids.has(pid) || e.outside) continue;
    let slice, scope;
    if (testRoot(pid)) { slice = SLICES.tests; scope = 'cb-tests.scope'; }
    else {
      const s = owner(pid);
      if (s == null) { slice = SLICES.sessions; scope = 'cb-orphans.scope'; }
      else { slice = CORE.has(s) ? SLICES.core : SLICES.sessions; scope = scopeName(s); }
    }
    if (e.cg !== `/${slice}/${scope}`) out.push({ pid, slice, scope });
  }
  return out;
}

const readCg = (pid) => { try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('::')[1] || ''; } catch { return null; } };
function stat(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    return { ppid: Number(r[1]), cmd };
  } catch { return null; }
}
// Every process in the source unit and in our three slices (a session's test runs start inside its scope).
function collect() {
  const dirs = [`${CG}/${SOURCE}`];
  for (const sl of Object.values(SLICES)) {
    const d = `${CG}/codebox.slice/${sl}`;
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.scope')) dirs.push(`${d}/${f}`);
  }
  const procs = new Map();
  for (const d of dirs) {
    let pids = []; try { pids = readFileSync(`${d}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number); } catch {}
    for (const pid of pids) { const s = stat(pid); const cg = readCg(pid); if (s && cg != null) procs.set(pid, { ...s, cg: cg.replace(/^\/codebox\.slice/, '') }); }
  }
  // Ancestors outside these cgroups still decide ownership (a pane's claude may have been placed already).
  for (const [, e] of [...procs]) for (let p = e.ppid, i = 0; p > 1 && !procs.has(p) && i < 64; i++) {
    const s = stat(p); if (!s) break; procs.set(p, { ...s, cg: null, outside: true }); p = s.ppid;
  }
  return procs;
}
function panes() {
  const m = new Map();
  try {
    const out = execFileSync('tmux', ['-S', TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pane_pid} #{session_name}'], { encoding: 'utf8' });
    for (const l of out.split('\n')) { const i = l.indexOf(' '); if (i > 0) m.set(Number(l.slice(0, i)), l.slice(i + 1)); }
  } catch {}
  return m;
}
const tmuxServers = () => { try { return new Set(execFileSync('pgrep', ['-x', 'tmux: server'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)); } catch { return new Set(); } };
const MGR = ['org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
// New scope: systemd creates it (no per-scope cap, the slice's TasksMax governs). Existing scope: write the pid into its
// cgroup.procs; AttachProcessesToUnit would need Delegate=yes, which a transient scope cannot gain later.
function move(scope, slice, pids) {
  const dir = `${CG}/codebox.slice/${slice}/${scope}`;
  if (existsSync(dir)) { for (const pid of pids) writeFileSync(`${dir}/cgroup.procs`, String(pid)); return; }
  execFileSync('busctl', ['call', ...MGR, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', scope, 'fail', '3',
    'PIDs', 'au', String(pids.length), ...pids.map(String), 'Slice', 's', slice, 'TasksMax', 't', '18446744073709551615', '0'], { stdio: 'pipe' });
}
export function pass(dry = false) {
  const procs = collect(); const tm = tmuxServers();
  const moves = plan(procs, panes(), tm);
  const byScope = new Map();
  for (const m of moves) { const k = `${m.slice} ${m.scope}`; byScope.set(k, [...(byScope.get(k) || []), m.pid]); }
  for (const [k, pids] of byScope) {
    const [slice, scope] = k.split(' ');
    if (dry) { console.log(`would move ${pids.length} -> ${slice}/${scope}: ${pids.slice(0, 8).join(' ')}`); continue; }
    try { move(scope, slice, pids); continue; } catch {}
    // One pid that exited since the scan fails the whole call (test files come and go fast): retry the rest one by one.
    for (const pid of pids.filter((p) => existsSync(`/proc/${p}`))) {
      try { move(scope, slice, [pid]); } catch (e) { console.error(`[placer] ${scope} ${pid}: ${String(e.stderr || e.message).trim().slice(0, 160)}`); }
    }
  }
  return moves.length;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--dry-run')) { pass(true); process.exit(0); }
  console.log(`[placer] core=${[...CORE].join(',')} source=${SOURCE}`);
  const tick = () => { try { const n = pass(); if (n) console.log(`[placer] placed ${n}`); } catch (e) { console.error(`[placer] ${e.message}`); } };
  tick(); setInterval(tick, Number(process.env.CGROUP_INTERVAL_MS) || 2000);
}
