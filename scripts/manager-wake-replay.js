#!/usr/bin/env node
// Wake-filter replay (owner task TASK-239 item 5, 2026-11-11). Replays one day of manager-events.jsonl through two versions of the
// event filter (baseline = origin/main's filter + policy, candidate = this worktree's) and maps every delivered event to the
// task_done wake that followed it (manager-wakes.jsonl). A wake is REMOVED when the candidate delivers none of the events the
// baseline delivered to it. A removed wake that acted (nothing=false) is a LOST ACTION; the run exits 1 if there is one.
//   node scripts/manager-wake-replay.js [--day 2026-11-11] [--state DIR] [--base-owner-policy FILE|none] [--allow-lost <HH:MM,...>] [--json]
// Pure part (replay) is exported for tests. Nothing here writes the live state dir; filters run against a temp state dir.
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []).flatMap((l) => { try { return l.startsWith('{') ? [JSON.parse(l)] : []; } catch { return []; } });

// Pure. wakes: task_done wakes (sorted by start); baseKeys/candKeys: Sets of event ids delivered; events: [{id, at}].
// -> { total, noopBefore, noopAfter, removed: [wake], lost: [wake], ratioBefore, ratioAfter }
export function replay({ wakes, events, baseKeys, candKeys, urgentKeys = new Set(), otherWakes = [], windowSec = 0 }) {
  const starts = wakes.map((w) => w.start);
  const per = wakes.map(() => ({ base: 0, cand: 0, urgent: false }));
  for (const e of events) {
    let lo = 0, hi = starts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < e.at) lo = m + 1; else hi = m; }
    if (lo >= wakes.length) continue;
    if (baseKeys.has(e.id)) per[lo].base++;
    if (candKeys.has(e.id)) { per[lo].cand++; if (urgentKeys.has(e.id)) per[lo].urgent = true; }
  }
  const removed = [], lost = [];
  wakes.forEach((w, i) => { if (per[i].base > 0 && per[i].cand === 0) { removed.push(w); if (!w.nothing) lost.push(w); } });
  const all = wakes.length + otherWakes.length;
  const noopBefore = wakes.filter((w) => w.nothing).length + otherWakes.filter((w) => w.nothing).length;
  // survivors, then batching: consecutive non-urgent event wakes within windowSec of the group's first merge into one wake (events are delivered, only later);
  // a wake with no attributed event (the waiter returning on its own) or an urgent one stays alone. A merged wake acted if any member acted.
  const groups = []; let cur = null;
  wakes.forEach((w, i) => {
    if (per[i].base > 0 && per[i].cand === 0) return;
    const mergeable = windowSec > 0 && per[i].cand > 0 && !per[i].urgent;
    const t = Date.parse(w.start);
    if (mergeable && cur && t - cur.t0 <= windowSec * 1000) { cur.acted ||= !w.nothing; cur.n++; return; }
    cur = { t0: t, acted: !w.nothing, n: 1, open: mergeable }; groups.push(cur);
    if (!mergeable) cur = null;
  });
  const after = groups.length + otherWakes.length, noopAfter = groups.filter((g) => !g.acted).length + otherWakes.filter((w) => w.nothing).length;
  const unexplainedNoop = wakes.filter((w, i) => per[i].base === 0 && w.nothing).length;
  return { total: all, noopBefore, after, noopAfter, removed, lost, unexplainedNoop, ratioBefore: noopBefore / all, ratioAfter: after ? noopAfter / after : 0 };
}

function runFilter(script, policyFiles, evFile) {
  const st = mkdtempSync(join(tmpdir(), 'wakereplay-'));
  mkdirSync(join(st, 'manager-reports'));
  const tmpScript = join(st, 'filter.sh'); copyFileSync(script, tmpScript);
  copyFileSync(policyFiles.def, join(st, 'manager-event-policy.default.json'));
  if (policyFiles.owner) copyFileSync(policyFiles.owner, join(st, 'manager-event-policy.json'));
  // the script reads its defaults next to itself: run it from a copy of its directory layout
  const dir = join(st, 'scripts'); mkdirSync(dir); copyFileSync(script, join(dir, 'manager-event-filter.sh')); copyFileSync(policyFiles.def, join(dir, 'manager-event-policy.json'));
  const out = execFileSync('bash', [join(dir, 'manager-event-filter.sh')], { input: readFileSync(evFile), env: { ...process.env, GHOSTY_STATE_DIR: st }, maxBuffer: 1 << 28 }).toString();
  rmSync(st, { recursive: true, force: true });
  const keys = new Set(), urgent = new Set();
  for (const l of out.split('\n').filter(Boolean)) { const o = JSON.parse(l), e = o.l, id = `${e.at}|${e.key}|${e.kind}|${e.state ?? ''}`; keys.add(id); if (o.u) urgent.add(id); }
  return { keys, urgent };
}

function main(argv) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const day = opt('--day', '2026-11-11'), state = opt('--state', process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'));
  const baseOwner = opt('--base-owner-policy', join(state, 'manager-event-policy.json'));
  const allow = new Set((opt('--allow-lost', '') || '').split(',').filter(Boolean));
  const events = [...lines(join(state, 'manager-events.jsonl.1')), ...lines(join(state, 'manager-events.jsonl'))].filter((e) => String(e.at).startsWith(day));
  const wk = lines(join(state, 'manager-wakes.jsonl')).filter((w) => String(w.start).startsWith(day));
  const wakes = wk.filter((w) => w.trigger === 'task_done').sort((a, b) => (a.start < b.start ? -1 : 1));
  const tmp = mkdtempSync(join(tmpdir(), 'wakeev-')); const evFile = join(tmp, 'ev.jsonl');
  writeFileSync(evFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const git = (p) => { const f = join(tmp, p.replace(/\//g, '_')); writeFileSync(f, execFileSync('git', ['show', `origin/main:${p}`], { cwd: join(HERE, '..') })); return f; };
  const base = runFilter(git('scripts/manager-event-filter.sh'), { def: git('scripts/manager-event-policy.json'), owner: baseOwner === 'none' ? null : baseOwner }, evFile);
  const cand = runFilter(join(HERE, 'manager-event-filter.sh'), { def: join(HERE, 'manager-event-policy.json'), owner: null }, evFile);
  const baseKeys = base.keys, candKeys = cand.keys;
  const evs = events.map((e) => ({ at: e.at, id: `${e.at}|${e.key}|${e.kind}|${e.state ?? ''}` }));
  const r = replay({ wakes, events: evs, baseKeys, candKeys, urgentKeys: cand.urgent, windowSec: Number(opt('--window', 0)), otherWakes: wk.filter((w) => w.trigger !== 'task_done') });
  const lostReal = r.lost.filter((w) => !allow.has(w.start.slice(11, 16)));
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (argv.includes('--json')) console.log(JSON.stringify({ ...r, removed: r.removed.length, lost: r.lost.map((w) => w.start) }));
  else {
    console.log(`day ${day}: ${wk.length} wakes (${wakes.length} task_done), events ${events.length}; delivered baseline ${baseKeys.size} -> candidate ${candKeys.size}`);
    console.log(`no-op wakes: ${r.noopBefore}/${r.total} (${pct(r.ratioBefore)}) -> ${r.noopAfter}/${r.after} (${pct(r.ratioAfter)}); wakes removed ${r.removed.length} (+${r.total - r.removed.length - r.after} merged by --window), waiter-only no-op wakes ${r.unexplainedNoop}, lost actions ${lostReal.length}${r.lost.length > lostReal.length ? ` (+${r.lost.length - lostReal.length} allowed: not event-driven)` : ''}`);
    for (const w of r.lost) console.log(`  lost? ${w.start} ${allow.has(w.start.slice(11, 16)) ? '[allowed] ' : ''}${String(w.decision || '').slice(0, 120).replace(/\n/g, ' ')}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  return lostReal.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
