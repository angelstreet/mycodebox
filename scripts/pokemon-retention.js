#!/usr/bin/env node
// Pokemon run retention (owner, 2026-11-10, revised after the wrong apply: "for each of Blue, Yellow, Gold keep the in-progress one
// and the LATEST PLAYED game only"). See docs/POKEMON-RETENTION.md.
//   node scripts/pokemon-retention.js [--root ~/vpt-private/pokemon] [--plan-out FILE]   dry run: per-game report + plan file + sha
//   node scripts/pokemon-retention.js --apply --plan FILE --sha SHA                       moves exactly the reviewed plan's removals
//   node scripts/pokemon-retention.js --purge [--keep-days 7]                             deletes .trash-<date> folders older than 7 days
// A run file (runs/<stamp>.json + .webm) is one SEGMENT; a GAME is the segments of one save from a run that starts at the first
// milestone ("starter") on, grouped like the page's publisher (virtualpytest features/pokemon/lib/series_publish.py). Retention works
// on games, never on single segments: per Pokemon game (blue_fr, yellow_en, gold_en, ...) keep every in-progress game and the single
// best finished-or-abandoned game; a fragment (first segment not at "starter": "recorded from mid-game") never beats a playthrough.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^(\d{8}-\d{6}[^.]*)\.(json|webm)$/;
const FIRST = 'starter', LAST = 'hall_of_fame';
const PLAN_MAX_AGE_MS = 24 * 36e5;
export const KEEP_DAYS = 7;
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

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// The segments of a runs folder grouped into games, like series_publish.group_games. Runs after a game's Hall of Fame stay with that
// game (the page hides them as "story done"); a run that starts at "starter" after one that did not opens a new game of the save.
export function groupGames(segs) {
  const games = [], current = new Map(), prevEnd = new Map();
  for (const s of [...segs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const save = s.json.save || '?', sum = s.json.summary || {};
    if (!current.has(save) || (sum.start_milestone === FIRST && prevEnd.get(save) !== FIRST)) {
      const g = { save, segs: [] };
      current.set(save, g); games.push(g);
    }
    prevEnd.set(save, sum.end_milestone);
    current.get(save).segs.push(s);
  }
  for (const g of games) {
    const first = g.segs[0], ms = new Set();
    let badges = 0, playS = 0, finished = false;
    for (const s of g.segs) {
      playS += Math.max(0, s.json.video_end - s.json.video_start);
      const b = s.json.summary?.badges;
      badges = Math.max(badges, Number.isInteger(b) ? b : Array.isArray(b) ? b.length : 0);
      for (const e of s.json.events || []) if (e?.kind === 'milestone_done' && e.id) { ms.add(e.id); if (e.id === LAST) finished = true; }
    }
    Object.assign(g, {
      id: `${g.save}-${first.id.slice(0, 8)}`, game: g.segs.at(-1).json.game || 'blue_fr', start: first.id, end: g.segs.at(-1).id,
      fromStart: first.json.summary?.start_milestone === FIRST, finished, milestones: ms.size, badges, playH: playS / 3600,
      bytes: g.segs.reduce((n, s) => n + s.files.reduce((m, f) => m + f.size, 0), 0),
    });
  }
  return games;
}

// Higher is better: a playthrough beats a fragment, a finished game beats an unfinished one; among finished games the newest wins
// (the owner's "latest played"), among unfinished ones the furthest (milestones, then badges), then the newest start.
const rank = (g) => [g.fromStart ? 1 : 0, g.finished ? 1 : 0, g.finished ? 0 : g.milestones, g.finished ? 0 : g.badges, g.start];
export function better(a, b) {
  const x = rank(a), y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const describe = (g) => `${g.fromStart ? 'playthrough from start' : 'fragment (recorded from mid-game)'}, ${g.finished ? 'finished' : 'not finished'}, `
  + `${g.milestones} milestones, ${g.badges} badges, ${g.playH.toFixed(1)} h, ${g.segs.length} segments, ${G(g.bytes)}, ${g.start}..${g.end}`;

// { folders:[{runsDir, games:[{...game, verdict, why}], loose:[{path,reason}]}], keep:[{path,reason}], remove:[{path,size,runsDir}] }
export function plan(root, { liveMin = 15, now = Date.now(), open = openPaths() } = {}) {
  const keep = [], remove = [], folders = [];
  for (const top of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!top.isDirectory() || top.name.startsWith('.trash-')) continue;
    const runsDir = path.join(root, top.name, 'runs');
    if (!fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) continue;
    const runs = new Map();   // id -> { id, files:[{p,size,mtime}], json }
    for (const e of fs.readdirSync(runsDir, { withFileTypes: true })) {
      const m = e.isFile() && ID.exec(e.name);
      if (!m) continue;
      const p = path.join(runsDir, e.name), s = fs.statSync(p);
      const r = runs.get(m[1]) || { id: m[1], files: [], json: undefined };
      r.files.push({ p, size: s.size, mtime: s.mtimeMs });
      if (m[2] === 'json') { try { r.json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { r.json = null; } }
      runs.set(m[1], r);
    }
    // A run that is not a finished segment is never removed: no readable json, no video_start/video_end, open, or just written.
    const loose = [], segs = [];
    for (const r of runs.values()) {
      const why = r.json == null ? 'no readable json'
        : !isNum(r.json.video_start) || !isNum(r.json.video_end) ? 'no video_start/video_end'
          : r.files.some((f) => open.has(f.p)) ? 'file open by a process'
            : r.files.some((f) => f.mtime > now - liveMin * 60e3) ? `modified < ${liveMin} min ago` : null;
      if (why) loose.push(...r.files.map((f) => ({ path: f.p, reason: `in progress: ${why}` })));
      else segs.push(r);
    }
    keep.push(...loose);
    const games = groupGames(segs);
    // In progress: the newest game of its save that has no Hall of Fame yet (the save is still being played).
    const newestOfSave = new Map();
    for (const g of games) newestOfSave.set(g.save, g);
    const best = new Map();   // pokemon game -> game
    for (const g of games) {
      if (newestOfSave.get(g.save) === g && !g.finished) { g.verdict = 'keep'; g.why = `in progress: newest game of save "${g.save}", no Hall of Fame yet`; continue; }
      const cur = best.get(g.game);
      if (!cur || better(g, cur)) best.set(g.game, g);
    }
    for (const g of games) {
      if (g.verdict) continue;
      const b = best.get(g.game);
      if (b === g) { g.verdict = 'keep'; g.why = `latest played ${g.game}: ${describe(g)}`; continue; }
      g.verdict = 'remove';
      g.why = `${describe(g)}; ${b.id} is ahead (${b.fromStart && !g.fromStart ? 'a playthrough beats a fragment' : 'more progress or newer'})`;
    }
    for (const g of games) {
      for (const s of g.segs) for (const f of s.files) {
        if (g.verdict === 'keep') keep.push({ path: f.p, reason: `${g.id}: ${g.why}` });
        else remove.push({ path: f.p, size: f.size, runsDir, game: g.id });
      }
    }
    folders.push({ runsDir, games: games.map(({ segs: s, ...g }) => ({ ...g, segments: s.length })), loose });
  }
  return { keep, remove, folders };
}

// The text the manager reads before any apply: per runs folder and per Pokemon game, what is kept and why, what goes and its size.
export function report(root, p) {
  const out = [];
  for (const f of p.folders) {
    out.push(`## ${path.relative(root, f.runsDir)}`);
    const byGame = new Map();
    for (const g of f.games) byGame.set(g.game, [...(byGame.get(g.game) || []), g]);
    for (const [game, gs] of byGame) {
      out.push(`  ${game}`);
      for (const g of gs) out.push(`    ${g.verdict.toUpperCase().padEnd(6)} ${g.id.padEnd(18)} ${G(g.bytes).padStart(6)}  ${g.why}`);
    }
    if (f.loose.length) out.push(`  not a finished segment, kept: ${f.loose.length} files (${[...new Set(f.loose.map((l) => path.basename(l.path)))].slice(0, 6).join(' ')}${f.loose.length > 6 ? ' ...' : ''})`);
  }
  const total = p.remove.reduce((n, x) => n + x.size, 0);
  out.push(`=> keep ${p.keep.length} files, remove ${p.remove.length} files, ${G(total)}`);
  return out.join('\n');
}

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function writePlan(root, p, file, { now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, root, created: now, report: report(root, p), remove: p.remove }, null, 1), { mode: 0o600 });
  return sha256(file);
}

// Move exactly the reviewed plan's removals into <root>/.trash-<date>/. Refuses (moves nothing) unless the plan file's sha matches, it is
// for this root, under 24 h old, and every planned removal is still a removal in a fresh plan with the same size. Never purges.
export function apply(root, planFile, sha, { now = Date.now(), fresh } = {}) {
  if (!planFile || !sha) throw new Error('--apply needs --plan <file> --sha <sha256> from a reviewed dry run');
  if (sha256(planFile) !== sha) throw new Error('plan file sha does not match --sha: re-run the dry run and review it');
  const reviewed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (reviewed.version !== 2 || path.resolve(reviewed.root) !== path.resolve(root)) throw new Error('plan is for another root or version');
  if (now - reviewed.created > PLAN_MAX_AGE_MS) throw new Error('plan is older than 24 h: re-run the dry run and review it');
  const cur = new Map((fresh || plan(root, { now })).remove.map((r) => [r.path, r]));
  const stale = reviewed.remove.filter((r) => !cur.has(r.path) || cur.get(r.path).size !== r.size);
  if (stale.length) throw new Error(`${stale.length} planned removals changed since the dry run (first: ${stale[0].path}): re-run the dry run`);
  const day = new Date(now).toISOString().slice(0, 10), trash = path.join(root, `.trash-${day}`);
  let moved = 0, bytes = 0;
  const log = [];
  for (const f of reviewed.remove) {
    if (path.dirname(f.path) !== f.runsDir || path.basename(f.runsDir) !== 'runs' || !f.path.startsWith(root + path.sep)) continue;
    const dest = path.join(trash, path.relative(root, f.path));
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(f.path, dest);
    moved++; bytes += f.size; log.push(`${f.game || '?'}\t${path.relative(root, f.path)}`);
  }
  if (log.length) fs.appendFileSync(path.join(trash, 'MOVED.tsv'), `${log.join('\n')}\n`);
  return { moved, bytes, trash };
}

// Delete .trash-<date> folders older than keepDays. Its own call: never in the same run as a move.
export function purge(root, { now = Date.now(), keepDays = KEEP_DAYS } = {}) {
  const cutoff = new Date(now - keepDays * 864e5).toISOString().slice(0, 10), purged = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const m = e.isDirectory() && /^\.trash-(\d{4}-\d{2}-\d{2})$/.exec(e.name);
    if (m && m[1] < cutoff) { fs.rmSync(path.join(root, e.name), { recursive: true, force: true }); purged.push(e.name); }
  }
  return purged;
}

function main() {
  const argv = process.argv;
  const arg = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
  const home = (p) => path.resolve(p.replace(/^~/, os.homedir()));
  const root = home(arg('--root', path.join(os.homedir(), 'vpt-private', 'pokemon')));
  if (!fs.existsSync(root)) { console.error(`no such directory: ${root}`); process.exit(2); }
  const doApply = argv.includes('--apply'), doPurge = argv.includes('--purge');
  if (doApply && doPurge) { console.error('--apply and --purge never run in the same call'); process.exit(2); }
  if (doPurge) {
    const keepDays = Number(arg('--keep-days', KEEP_DAYS));
    if (!(keepDays >= KEEP_DAYS)) { console.error(`--keep-days must be >= ${KEEP_DAYS}`); process.exit(2); }
    const purged = purge(root, { keepDays });
    console.log(`purged ${purged.length} trash folders older than ${keepDays} days${purged.length ? `: ${purged.join(' ')}` : ''}`);
    return;
  }
  if (doApply) {
    try {
      const r = apply(root, arg('--plan') && home(arg('--plan')), arg('--sha'));
      console.log(`moved ${r.moved} files (${G(r.bytes)}) to ${r.trash} (list: MOVED.tsv); trash is kept ${KEEP_DAYS} days, purge is a separate --purge call`);
    } catch (e) { console.error(`refused: ${e.message}`); process.exit(3); }
    return;
  }
  const p = plan(root, { liveMin: Number(arg('--live-min', 15)) });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const state = process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
  const file = home(arg('--plan-out', path.join(state, 'pokemon-retention', `plan-${stamp}.json`)));
  console.log(`# pokemon retention dry run (nothing is changed)  root=${root}`);
  console.log(report(root, p));
  if (argv.includes('--files')) for (const r of p.remove) console.log(`REMOVE ${r.path} ${(r.size / 2 ** 20).toFixed(0)}M`);
  const sha = writePlan(root, p, file);
  console.log(`plan: ${file}\nsha256: ${sha}\napply after review: node scripts/pokemon-retention.js --root ${root} --apply --plan ${file} --sha ${sha}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
