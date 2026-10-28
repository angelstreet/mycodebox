// Unfinished work (owner, 2026-10-28): TASK-178 sat with open rows and no session for hours because the manager only watched live
// sessions. Registry = task docs (docs/tasks/TASK-*.md in the project dirs, state table rows) joined with live sessions and
// session-history. A task is "orphaned" when it has open rows the session can do, no live session mentions it, and its last session
// ended > QUIET_MS ago. Surfaces: GET /api/unfinished, feed kind `orphaned-task` (once per task per day), manager-status-scan.sh.
// ghosty never starts a session: the manager runs scripts/resume-task. Switch: manager.json `unfinished` "live" (default) | "off".
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

export const QUIET_MS = 30 * 60 * 1000;
export const STALE_MS = 14 * 24 * 3600 * 1000;   // a last session older than this is listed, but raises no event
export const POLL_MS = 10 * 60 * 1000;

const OPEN = /^\W*(open|blocked|in[ -]progress|todo|not started)\b/i;
const OWNER_ONLY = /\bowner[- ]only\b|\bneeds[- ]owner\b|\bowner (?:must|has to|to|supplies|decides)\b|\b(?:waiting|waits) (?:for|on) (?:the )?owner\b/i;
const clean = (s) => String(s).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

// Pure. Markdown task doc -> { title, rows: [{ n, goal, state, kind: 'open'|'blocked'|'in-progress', ownerOnly }] }. Only rows whose State cell
// starts with open / blocked / in progress are returned (done, "not applicable", merged ... are closed). The table is the first one whose
// header has a State (or Status) column.
export function parseTaskDoc(text) {
  const lines = String(text || '').split('\n');
  const title = clean((/^title:\s*(.+)$/m.exec(text || '') || /^#\s+(.+)$/m.exec(text || '') || [, ''])[1]).replace(/^["']|["']$/g, '');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const head = cells(lines[i]).map((c) => clean(c).toLowerCase());
    const si = head.findIndex((c) => c === 'state' || c === 'status');
    if (si < 0) continue;
    const gi = head.findIndex((c) => /^(goal|task|item|what)\b/.test(c));
    for (let j = i + 1; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const c = cells(lines[j]);
      if (/^[\s:|-]+$/.test(lines[j])) continue;
      if (c.length <= si) continue;
      const state = clean(c[si]);
      const m = OPEN.exec(state);
      if (!m) continue;
      const k = m[1].toLowerCase().replace(' ', '-');
      rows.push({ n: clean(c[0]), goal: clean(c[gi >= 0 ? gi : 1] || '').slice(0, 160), state: state.slice(0, 200),
        kind: k === 'todo' || k === 'not-started' ? 'open' : k, ownerOnly: OWNER_ONLY.test(state) });
    }
    break;
  }
  return { title, rows };
}

// Pure. A doc's rows -> { actionable, ownerOnly, blocked }: actionable = open / in-progress rows the session can do itself.
export function splitRows(rows) {
  const out = { actionable: [], ownerOnly: [], blocked: [] };
  for (const r of rows) (r.ownerOnly ? out.ownerOnly : r.kind === 'blocked' ? out.blocked : out.actionable).push(r);
  return out;
}

export const taskRe = (num) => new RegExp(`task[-_ ]?0*${Number(num)}(?!\\d)`, 'i');

// Scan task docs. dirs: [{ path }]. The same doc name in several worktrees is one entry: the newest copy wins.
export async function scanTaskDocs(dirs, { fs = { readdir, readFile, stat } } = {}) {
  const best = new Map();
  await Promise.all((dirs || []).map(async (d) => {
    const root = join(d.path, 'docs', 'tasks');
    let names; try { names = await fs.readdir(root); } catch { return; }
    for (const f of names) {
      const m = /^TASK-0*(\d+)[A-Za-z]?[-_.]/i.exec(f);
      if (!m || !f.endsWith('.md')) continue;
      const file = join(root, f);
      try {
        const st = await fs.stat(file), prev = best.get(f);
        if (prev && prev.mtimeMs >= st.mtimeMs) continue;
        const doc = parseTaskDoc(await fs.readFile(file, 'utf8'));
        best.set(f, { task: `TASK-${m[1]}`, num: Number(m[1]), file, slug: basename(f, '.md'), dir: d.path, mtimeMs: st.mtimeMs, ...doc });
      } catch { /* unreadable doc: skip */ }
    }
  }));
  return [...best.values()];
}

// Pure. docs (scanTaskDocs), instances (session-history fold), live: Set of live session names -> { orphaned, covered, other }.
export function computeUnfinished({ docs, instances, live = new Set(), now = Date.now(), quietMs = QUIET_MS, staleMs = STALE_MS }) {
  const out = { orphaned: [], covered: [], other: [] };
  for (const d of docs) {
    const rows = splitRows(d.rows);
    if (!rows.actionable.length && !rows.blocked.length && !rows.ownerOnly.length) continue;
    const re = taskRe(d.num);
    const mine = instances.filter((i) => re.test(i.name) || re.test(i.prompt_ref || '') || re.test(i.handover_ref || ''));
    const open = mine.filter((i) => i.end == null || live.has(i.name));
    const last = mine.filter((i) => i.end != null && !live.has(i.name)).sort((a, b) => b.end - a.end)[0] || null;
    const e = { task: d.task, doc: d.file, title: d.title, open: rows.actionable.map(rowOut), ownerOnly: rows.ownerOnly.map(rowOut), blocked: rows.blocked.map(rowOut),
      liveSessions: open.map((i) => i.name),
      lastSession: last && { name: last.name, provider: last.provider, model: last.model, cwd: last.cwd, endedAt: new Date(last.end).toISOString(), reason: last.end_reason } };
    if (open.length) out.covered.push(e);
    else if (!rows.actionable.length) out.other.push({ ...e, why: 'only owner-only or blocked rows are open' });
    else if (!last) out.other.push({ ...e, why: 'no session in history mentions this task' });
    else if (now - last.end < quietMs) out.other.push({ ...e, why: `last session ended ${Math.round((now - last.end) / 60000)} min ago (quiet period)` });
    else if (now - last.end > staleMs) out.other.push({ ...e, why: 'last session ended more than 14 days ago', stale: true });
    else out.orphaned.push({ ...e, why: `no live session; ${last.name} ${last.end_reason || 'ended'} ${Math.round((now - last.end) / 3600000 * 10) / 10} h ago with ${rows.actionable.length} open row(s)` });
  }
  return out;
}
const rowOut = (r) => ({ n: r.n, goal: r.goal, state: r.state, kind: r.kind });

// Pure. The cheaper case: a live session whose closing text says `STATUS: done` while its task doc still has open rows it can do.
// -> { task, items } or null. covered: computeUnfinished(...).covered.
export function docLeftoversFor(name, text, covered) {
  const st = [...String(text || '').matchAll(/^\W*STATUS:\s*([a-z-]+)/gim)].pop();
  if (!st || !/^(?:done|ok|complete|completed|finished)$/i.test(st[1])) return null;
  const e = covered.find((c) => c.liveSessions.includes(name) && c.open.length);
  return e ? { task: e.task, items: e.open.map((r) => `${e.task} row ${r.n}: ${r.goal}`.slice(0, 200)) } : null;
}

// Watcher: one `orphaned-task` event per task per day (persisted, so a restart does not repeat it). The manager runs scripts/resume-task.
export function createUnfinished({ compute, record, stateDir, mode = () => 'live', now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const file = stateDir && join(stateDir, 'unfinished-told.json');
  let told = null, timer = null, busy = false, last = { at: 0, orphaned: [] };
  const day = () => new Date(now()).toISOString().slice(0, 10);
  async function load() { if (told) return; try { told = JSON.parse(await readFile(file, 'utf8')); } catch { told = {}; } }
  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      if (mode() === 'off') return (last = { at: now(), orphaned: [], mode: 'off' });
      await load();
      const r = await compute();
      for (const o of r.orphaned) {
        if (told[o.task] === day()) continue;
        told[o.task] = day();
        try {
          await record({ key: `${o.task}:orphaned-task`, title: `${o.task}: orphaned, ${o.open.length} open row(s), no session`, body: o.why,
            items: o.open.map((x) => `row ${x.n}: ${x.goal}`), task: { id: o.task, doc: o.doc, lastSession: o.lastSession, ownerOnly: o.ownerOnly.map((x) => x.n) },
            url: '/', priority: 'default', at: new Date(now()).toISOString() });
        } catch (e) { log.error?.('[unfinished] record', o.task, e.message); }
      }
      for (const k of Object.keys(told)) if (told[k] !== day()) delete told[k];
      if (file) { try { await mkdir(stateDir, { recursive: true }); await writeFile(file, JSON.stringify(told)); } catch { /* best effort */ } }
      return (last = { at: now(), orphaned: r.orphaned.map((o) => o.task) });
    } catch (e) { log.error?.('[unfinished]', e.message); return (last = { ...last, at: now(), error: e.message }); }
    finally { busy = false; }
  }
  return {
    tick, snapshot: () => last,
    start(firstDelayMs = 4 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
