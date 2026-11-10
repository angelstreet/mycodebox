#!/usr/bin/env node
// Pokemon run retention (owner, 2026-11-10: "keep the in-progress and the last completed only").
//   node scripts/pokemon-retention.js [--root ~/vpt-private/pokemon] [--apply] [--live-min 15]
// Dry run by default. Scope: files in <root>/*/runs/ named <id>.json / <id>.webm (id = YYYYMMDD-HHMMSS...). Nothing else is touched:
// no saves, states, ROMs, finished/ or memory_* snapshots, and no directory outside a runs/ folder.
// Per runs folder and per save (the run json's "save" field), keep (a) every in-progress run and (b) the newest completed run.
// In progress = no parseable json, json without video_end, a file open by a process, or a file modified in the last --live-min minutes.
// --apply moves the rest to <root>/.trash-<date>/ (same filesystem, rename) and purges .trash-* folders older than 1 day.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^(\d{8}-\d{6}[^.]*)\.(json|webm)$/;
const G = (b) => `${(b / 2 ** 30).toFixed(2)}G`;

// Absolute paths currently open by any process we can inspect (/proc/*/fd).
export function openPaths(procDir = '/proc') {
  const open = new Set();
  let pids = [];
  try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { return open; }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(path.join(procDir, pid, 'fd')); } catch { continue; }
    for (const fd of fds) { try { open.add(fs.readlinkSync(path.join(procDir, pid, 'fd', fd))); } catch { /* gone */ } }
  }
  return open;
}

// { keep:[{path,reason}], remove:[{path,size,runsDir}] }
export function plan(root, { liveMin = 15, now = Date.now(), open = openPaths() } = {}) {
  const keep = [], remove = [];
  for (const top of fs.readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory() || top.name.startsWith('.trash-')) continue;
    const runsDir = path.join(root, top.name, 'runs');
    if (!fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) continue;
    const runs = new Map();   // id -> { files:[{p,size,mtime}], json }
    for (const e of fs.readdirSync(runsDir, { withFileTypes: true })) {
      const m = e.isFile() && ID.exec(e.name);
      if (!m) continue;
      const p = path.join(runsDir, e.name), s = fs.statSync(p);
      const r = runs.get(m[1]) || { id: m[1], files: [], json: undefined };
      r.files.push({ p, size: s.size, mtime: s.mtimeMs });
      if (m[2] === 'json') { try { r.json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { r.json = null; } }
      runs.set(m[1], r);
    }
    const lastCompleted = new Map();   // save -> run
    for (const r of runs.values()) {
      const why = r.json == null ? 'no readable json'
        : !r.json.video_end ? 'no video_end'
          : r.files.some((f) => open.has(f.p)) ? 'file open by a process'
            : r.files.some((f) => f.mtime > now - liveMin * 60e3) ? `modified < ${liveMin} min ago` : null;
      r.live = why;
      if (why) { keep.push(...r.files.map((f) => ({ path: f.p, reason: `in progress: ${why}` }))); continue; }
      const save = r.json.save || 'unknown', cur = lastCompleted.get(save);
      if (!cur || r.id > cur.id) lastCompleted.set(save, r);
    }
    for (const r of runs.values()) {
      if (r.live) continue;
      const save = r.json.save || 'unknown';
      if (lastCompleted.get(save) === r) keep.push(...r.files.map((f) => ({ path: f.p, reason: `last completed ${save}` })));
      else remove.push(...r.files.map((f) => ({ path: f.p, size: f.size, runsDir })));
    }
  }
  return { keep, remove };
}

// Move the plan's removals into <root>/.trash-<date>/<top>/runs/, purge .trash-* older than 1 day. Returns { moved, bytes, purged }.
export function apply(root, p, { now = Date.now() } = {}) {
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const trash = path.join(root, `.trash-${day(now)}`);
  let moved = 0, bytes = 0;
  for (const f of p.remove) {
    if (path.dirname(f.path) !== f.runsDir || path.basename(f.runsDir) !== 'runs') continue;   // never outside a runs/ folder
    const dest = path.join(trash, path.relative(root, f.path));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(f.path, dest);
    moved++; bytes += f.size;
  }
  const purged = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const m = e.isDirectory() && /^\.trash-(\d{4}-\d{2}-\d{2})$/.exec(e.name);
    if (m && m[1] < day(now - 864e5))   // keeps today's and yesterday's trash
     { fs.rmSync(path.join(root, e.name), { recursive: true, force: true }); purged.push(e.name); }
  }
  return { moved, bytes, purged };
}

function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const root = path.resolve(arg('--root', path.join(os.homedir(), 'vpt-private', 'pokemon')).replace(/^~/, os.homedir()));
  if (!fs.existsSync(root)) { console.error(`no such directory: ${root}`); process.exit(2); }
  const doApply = process.argv.includes('--apply');
  const p = plan(root, { liveMin: Number(arg('--live-min', 15)) });
  console.log(`# pokemon retention ${doApply ? 'APPLY' : 'dry run (nothing is changed)'}  root=${root}`);
  for (const k of p.keep) console.log(`KEEP   ${k.path}  (${k.reason})`);
  for (const r of p.remove) console.log(`REMOVE ${r.path} ${(r.size / 2 ** 20).toFixed(0)}M`);
  const total = p.remove.reduce((n, x) => n + x.size, 0);
  console.log(`=> keep ${p.keep.length} files, remove ${p.remove.length} files, ${G(total)}`);
  if (doApply) {
    const r = apply(root, p);
    console.log(`moved ${r.moved} files (${G(r.bytes)}) to trash; purged ${r.purged.length} old trash folders${r.purged.length ? `: ${r.purged.join(' ')}` : ''}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
