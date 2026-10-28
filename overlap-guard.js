// Overlap guard (owner, 2026-10-28: "why 2 sessions work on the same file"). script-naming, migration-virtual and task168-resume
// all changed scripts/agent/vod_radio_*.py; their integrations came back `conflicts outside convention` and cost hours.
// Every minute: for each live session's checkout, the paths it changes vs origin/main (committed branch diff + uncommitted
// status, names only, no content reads). A path changed by 2+ sessions of the same repo is an overlap; a delete or rename
// in one and an edit in another counts too. Surface: GET /api/overlaps, a manager event `<a>+<b>:overlap` once per pair per
// UTC day, and each session of the pair told once per day (silent form, like rules-watch). Never blocks, never kills.
// Switch: manager.json `overlapGuard` "live" (default) | "dry" (detect + journal, tell nobody) | "off".
// `overlapIgnore` (list of globs, `*` within a segment, `**` across) replaces DEFAULT_IGNORE. Journal: overlap-guard.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const POLL_MS = 60 * 1000;
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;
// Convention files (version bumps, release-note build sections), generated files and append-mostly docs: a clash there
// is resolved by the lane, not by a human.
export const DEFAULT_IGNORE = ['VERSION.txt', 'docs/REFERENCE.md', 'package-lock.json', '**/release_notes*', '**/RELEASE_NOTES*', '**/generated/**', '**/*.min.js', '**/__pycache__/**'];

function globRe(g) {
  const s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${s}$`);
}
export function ignorer(globs = DEFAULT_IGNORE) { const res = globs.map(globRe); return (p) => res.some((r) => r.test(p)); }

// `git diff --name-status -M` output -> Map path -> 'M' | 'A' | 'D'. A rename deletes the old path and adds the new one.
export function parseNameStatus(out) {
  const m = new Map();
  for (const l of String(out).split('\n')) {
    if (!l.trim()) continue;
    const f = l.split('\t'), s = f[0][0];
    if ((s === 'R' || s === 'C') && f.length >= 3) { if (s === 'R') m.set(f[1], 'D'); m.set(f[2], 'A'); }
    else if (f[1]) m.set(f[1], s === 'A' || s === 'D' ? s : 'M');
  }
  return m;
}
// `git status --porcelain=v1` output -> same shape. Untracked counts as added.
export function parseStatus(out) {
  const m = new Map();
  const unq = (p) => p.replace(/^"(.*)"$/, '$1');
  for (const l of String(out).split('\n')) {
    if (l.length < 4) continue;
    const xy = l.slice(0, 2), rest = l.slice(3);
    if (xy.includes('R') && rest.includes(' -> ')) { const [a, b] = rest.split(' -> '); m.set(unq(a), 'D'); m.set(unq(b), 'A'); continue; }
    m.set(unq(rest), xy.includes('D') ? 'D' : xy === '??' || xy.includes('A') ? 'A' : 'M');
  }
  return m;
}
// Merge two maps; a path that is deleted by one layer and re-added by the other is a modification.
export function mergeChanges(a, b) {
  const m = new Map(a);
  for (const [p, s] of b) m.set(p, m.has(p) && m.get(p) !== s ? 'M' : s);
  return m;
}

export const pairKey = (a, b) => [a, b].sort().join('+');

// Pure. sessions: [{ name, repo, checkout, startedAt, changes: Map path -> M|A|D }]. -> [{ pair:[older,newer], paths:[{path, by:{name:status}, destructive}] }]
// Sessions in the same checkout share one diff: not an overlap of this kind. Different repos never overlap.
export function findOverlaps(sessions, ignore = ignorer()) {
  const byPair = new Map();
  for (let i = 0; i < sessions.length; i++) for (let j = i + 1; j < sessions.length; j++) {
    const a = sessions[i], b = sessions[j];
    if (!a.repo || a.repo !== b.repo || a.checkout === b.checkout) continue;
    const paths = [];
    for (const [p, sa] of a.changes) {
      const sb = b.changes.get(p);
      if (!sb || ignore(p)) continue;
      paths.push({ path: p, by: { [a.name]: sa, [b.name]: sb }, destructive: sa === 'D' || sb === 'D' });
    }
    if (!paths.length) continue;
    paths.sort((x, y) => x.path.localeCompare(y.path));
    const [older, newer] = (a.startedAt || 0) <= (b.startedAt || 0) ? [a, b] : [b, a];
    byPair.set(pairKey(a.name, b.name), { key: pairKey(a.name, b.name), pair: [older.name, newer.name], paths });
  }
  return [...byPair.values()];
}

export const TAG = '[overlap-guard: no reply needed]';
export function message({ other, paths, newer }) {
  const list = paths.slice(0, 6).map((p) => p.path).join(', ') + (paths.length > 6 ? ` (+${paths.length - 6} more)` : '');
  const rename = paths.some((p) => p.destructive) ? ' One of you deletes or renames a path the other edits.' : '';
  return [
    `${TAG} Session ${other} also changes ${list}.${rename}`,
    'Coordinate with it (one message) before your next commit; the one that started later waits or takes a different slice.',
    `${newer ? 'You started later than it: wait for its integration or take another slice.' : 'It started later than you: it should wait or move; keep your slice unless it asks.'}`,
    'Do not stop your work for this. If you were idle with nothing pending, start nothing new: write only `STATUS: acknowledged`. If you are waiting on a job, repeat your existing STATUS line unchanged.',
  ].join(' ');
}

const day = (t) => new Date(t).toISOString().slice(0, 10);

// listTargets(): [{ name, cwd, startedAt, working, scriptBusy }]. git(cwd, args) -> stdout.
export function createOverlapGuard({ stateDir, git, listTargets, send, record = async () => {}, mode = () => 'live', ignoreList = () => DEFAULT_IGNORE, pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const stFile = join(stateDir, 'overlap-guard.json');
  const journal = join(stateDir, 'overlap-guard.jsonl');
  let last = { at: 0, mode: 'off', overlaps: [], sessions: 0 };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { seen: {}, eventDay: {}, told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  async function changesOf(cwd) {
    const g = async (args) => { try { return await git(cwd, args); } catch { return ''; } };
    const top = (await g(['rev-parse', '--show-toplevel'])).trim();
    if (!top) return null;
    const repo = (await g(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const committed = parseNameStatus(await g(['diff', '--name-status', '-M', 'origin/main...HEAD']));
    const dirty = parseStatus(await g(['status', '--porcelain=v1']));
    return { repo, checkout: top, changes: mergeChanges(committed, dirty) };
  }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, overlaps: [], sessions: 0 });
      const pr = pressure();
      if (pr.loadPerCore > MAX_LOAD_PER_CORE || pr.ramAvailPct < MIN_RAM_AVAIL_PCT) return (last = { ...last, at: now(), mode: m, held: 'host busy' });
      const targets = await listTargets();
      const cache = new Map(), sessions = [];
      for (const t of targets) {
        if (!t.cwd) continue;
        if (!cache.has(t.cwd)) cache.set(t.cwd, await changesOf(t.cwd));
        const c = cache.get(t.cwd);
        if (c && c.changes.size) sessions.push({ name: t.name, startedAt: t.startedAt, ...c });
      }
      const found = findOverlaps(sessions, ignorer(ignoreList()));
      const st = await load();
      const t0 = now(), today = day(t0);
      for (const k of Object.keys(st.seen)) if (!found.some((o) => o.key === k)) delete st.seen[k];   // a resolved overlap forgets its first-seen
      for (const k of Object.keys(st.told)) if (!k.startsWith(today)) delete st.told[k];
      for (const k of Object.keys(st.eventDay)) if (st.eventDay[k] !== today) delete st.eventDay[k];
      const byName = new Map(targets.map((t) => [t.name, t]));
      const out = [];
      for (const o of found) {
        if (!st.seen[o.key]) st.seen[o.key] = new Date(t0).toISOString();
        const rec = { ...o, firstSeen: st.seen[o.key] };
        out.push(rec);
        if (m === 'dry') { await note({ dry: true, pair: o.key, paths: o.paths.map((p) => p.path) }); continue; }
        if (st.eventDay[o.key] !== today) {
          st.eventDay[o.key] = today;
          const names = o.paths.map((p) => p.path);
          await note({ pair: o.key, paths: names, firstSeen: rec.firstSeen });
          await record({ key: `${o.key}:overlap`, title: `${o.pair[0]} and ${o.pair[1]} change the same file(s): ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
            body: `older: ${o.pair[0]}; newer: ${o.pair[1]}; first seen ${rec.firstSeen}`, items: names, overlap: { pair: o.pair, paths: names, destructive: o.paths.some((p) => p.destructive), firstSeen: rec.firstSeen }, url: '/', priority: 'default' });
        }
        for (const [me, other] of [[o.pair[0], o.pair[1]], [o.pair[1], o.pair[0]]]) {
          const tk = `${today}|${o.key}|${me}`, t = byName.get(me);
          if (st.told[tk] || !t || t.working || t.scriptBusy) continue;   // an idle, messageable pane only; tried again next minute
          try { await send(me, message({ other, paths: o.paths, newer: me === o.pair[1] })); st.told[tk] = true; await note({ told: me, pair: o.key }); }
          catch (e) { log.error?.('[overlap-guard] send', me, e.message); }
        }
      }
      await save(st);
      return (last = { at: now(), mode: m, overlaps: out, sessions: sessions.length });
    } catch (e) {
      log.error?.('[overlap-guard]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
