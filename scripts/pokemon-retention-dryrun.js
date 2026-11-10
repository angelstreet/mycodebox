#!/usr/bin/env node
// DRY RUN ONLY (proposal, harness fix 2026-11-10): prints what a pokemon retention rule would delete. It contains no delete code.
//   node scripts/pokemon-retention-dryrun.js [--root ~/vpt-private/pokemon] [--run-days 7] [--stale-days 14]
// Rule proposed (docs/POKEMON-RETENTION.md):
//   1. canonical/runs/*.webm older than --run-days, unless the run id appears in a file under canonical/finished/ (kept as evidence).
//      The small run .json files are always kept.
//   2. top-level stall*/repro*/work*/replay* directories whose newest file is older than --stale-days.
// Never listed, whatever their age: saves/states (*.sav, *.state, *.ss*), ROMs (*.gb, *.gbc, *.gba, *.rom, *.zip), canonical/ except rule 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve((arg('--root', path.join(os.homedir(), 'vpt-private', 'pokemon'))).replace(/^~/, os.homedir()));
const runDays = Number(arg('--run-days', 7)), staleDays = Number(arg('--stale-days', 14));
const now = Date.now(), cutoff = (d) => now - d * 864e5;
const PROTECTED = /\.(sav|state|ss\d*|gb|gbc|gba|rom|zip|7z)$/i;
const G = (b) => `${(b / 2 ** 30).toFixed(2)}G`;

function walk(dir, f) {   // [{ p, size, mtime }]
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, f)); else if (e.isFile()) { const s = fs.statSync(p); out.push({ p, size: s.size, mtime: s.mtimeMs }); }
  }
  return out;
}
if (!fs.existsSync(root)) { console.error(`no such directory: ${root}`); process.exit(2); }

// 1. old run videos
const runsDir = path.join(root, 'canonical', 'runs'), finDir = path.join(root, 'canonical', 'finished');
let finText = '';
if (fs.existsSync(finDir)) for (const f of walk(finDir)) if (/\.(json|txt|md|log)$/.test(f.p) && f.size < 5e6) finText += `${fs.readFileSync(f.p, 'utf8')}\n`;
const candidates = [], kept = [];
if (fs.existsSync(runsDir)) for (const e of fs.readdirSync(runsDir)) {
  if (!e.endsWith('.webm') || PROTECTED.test(e)) continue;
  const p = path.join(runsDir, e), s = fs.statSync(p), id = e.replace(/\.webm$/, '');
  if (s.mtimeMs >= cutoff(runDays)) continue;
  (finText.includes(id) ? kept : candidates).push({ p, size: s.size });
}
const sum = (a) => a.reduce((n, x) => n + x.size, 0);
console.log(`# pokemon retention dry run (nothing is deleted)  root=${root}`);
console.log(`\n## 1. run videos older than ${runDays} d (.json kept)`);
for (const c of candidates) console.log(`WOULD DELETE ${c.p} ${(c.size / 2 ** 20).toFixed(0)}M`);
console.log(`=> ${candidates.length} files, ${G(sum(candidates))}; ${kept.length} older videos kept because a finished/ snapshot names them (${G(sum(kept))})`);

// 2. stale debug directories
const stale = [];
for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name === 'canonical' || !/^(stall|repro|work|replay)/.test(e.name)) continue;
  const files = walk(path.join(root, e.name));
  if (!files.length || files.some((f) => PROTECTED.test(f.p)) || files.some((f) => f.mtime >= cutoff(staleDays))) continue;
  stale.push({ p: path.join(root, e.name), size: sum(files) });
}
console.log(`\n## 2. stall*/repro*/work*/replay* directories untouched for ${staleDays} d (skipped when they hold a save, state or ROM)`);
for (const s of stale) console.log(`WOULD DELETE ${s.p}/ ${(s.size / 2 ** 20).toFixed(0)}M`);
console.log(`=> ${stale.length} directories, ${G(sum(stale))}`);
console.log(`\nTOTAL would free ${G(sum(candidates) + sum(stale))}`);
