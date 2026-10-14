// Session history: an append-only start/end log of agent sessions ($GHOSTY_STATE_DIR/session-history.jsonl).
// The usage ledger only knows turns; this file knows when a session instance began and ended, who started it and
// with what prompt, so a ledger row at time ts can be attributed to the instance that was running then.
//   { schema_version: 1, kind: 'session.started', name, provider, model|null, cwd, started_by, prompt_ref, handover_ref,
//     remote_control_url?, ts }
//   { schema_version: 1, kind: 'session.ended', name, ts, reason: 'killed'|'exited'|'vanished' }
// Names are reused: an instance is a started record plus the next ended record for the same name.
// One appendFile call writes one complete line; a torn or invalid line (crash mid-write) is skipped on read.
import { promises as fsp, readFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = 1;
export const KINDS = ['session.started', 'session.ended'];
export const STARTED_BY = ['dashboard', 'cbsession', 'v2', 'manager', 'unknown'];
export const END_REASONS = ['killed', 'exited', 'vanished'];
export const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;
export const PROMPT_TEXT_MAX = 200;

// Prompt text is stored only as a short sanitized excerpt: no ANSI/control chars, whitespace collapsed, <= 200 chars.
// A value is kept as a path reference only when it has no whitespace and exists on this host (so "/review ..." is text).
export function sanitizePromptRef(v) {
  if (v == null) return null;
  const s = String(v);
  if (/^(?:\/|~\/|\.\.?\/)\S*$/.test(s) && s.length <= 1024 && !/[\x00-\x1f\x7f]/.test(s) && existsSync(s.startsWith('~/') ? homedir() + s.slice(1) : s)) return s;
  const t = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, PROMPT_TEXT_MAX) : null;
}

const strOrNull = (v, max = 1024) => (v == null || v === '' ? null : String(v).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) || null);
const isTs = (n) => Number.isFinite(n) && n > 0;

// Returns the normalized record or throws a TypeError naming the problem.
export function validateRecord(r, now = Date.now()) {
  if (!r || typeof r !== 'object') throw new TypeError('record must be an object');
  if (!KINDS.includes(r.kind)) throw new TypeError(`unknown kind: ${r.kind}`);
  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) throw new TypeError('bad session name');
  const ts = r.ts == null ? now : Number(r.ts);
  if (!isTs(ts)) throw new TypeError('bad ts');
  if (r.kind === 'session.ended') {
    if (!END_REASONS.includes(r.reason)) throw new TypeError(`unknown reason: ${r.reason}`);
    return { schema_version: SCHEMA_VERSION, kind: r.kind, name: r.name, ts, reason: r.reason };
  }
  if (!STARTED_BY.includes(r.started_by)) throw new TypeError(`unknown started_by: ${r.started_by}`);
  const out = { schema_version: SCHEMA_VERSION, kind: r.kind, name: r.name, provider: strOrNull(r.provider, 40), model: strOrNull(r.model, 120),
    cwd: strOrNull(r.cwd), started_by: r.started_by, prompt_ref: sanitizePromptRef(r.prompt_ref), handover_ref: strOrNull(r.handover_ref), ts };
  if (Number.isFinite(Number(r.tmux_created)) && Number(r.tmux_created) > 0) out.tmux_created = Number(r.tmux_created);   // tmux #{session_created}: tells a reused name from the same session
  const rc = strOrNull(r.remote_control_url, 300);
  if (rc && /^https:\/\/[^\s]+$/.test(rc)) out.remote_control_url = rc;
  return out;
}

// Fold ordered records into session instances. A second start while one is open ends the old one at that ts
// ('superseded') -- except an 'unknown' instance (the tick saw the tmux session first), which the real start enriches in place.
export function createFolder() {
  const out = [];
  const open = new Map();
  function feed(r) {
    if (r.kind === 'session.started') {
      const cur = open.get(r.name);
      if (cur && cur.started_by === 'unknown' && r.started_by !== 'unknown') {
        Object.assign(cur, { provider: r.provider ?? cur.provider, model: r.model ?? cur.model, cwd: r.cwd ?? cur.cwd, started_by: r.started_by,
          prompt_ref: r.prompt_ref, handover_ref: r.handover_ref, remote_control_url: r.remote_control_url ?? cur.remote_control_url ?? null,
          tmux_created: cur.tmux_created ?? r.tmux_created ?? null, start: Math.min(cur.start, r.ts) });
        return;
      }
      if (cur) { cur.end = r.ts; cur.end_reason = 'superseded'; }
      const inst = { name: r.name, provider: r.provider ?? null, model: r.model ?? null, cwd: r.cwd ?? null, started_by: r.started_by,
        prompt_ref: r.prompt_ref ?? null, handover_ref: r.handover_ref ?? null, remote_control_url: r.remote_control_url ?? null, tmux_created: r.tmux_created ?? null,
        start: r.ts, end: null, end_reason: null };
      open.set(r.name, inst); out.push(inst);
    } else if (r.kind === 'session.ended') {
      const cur = open.get(r.name);
      if (!cur) return;
      cur.end = Math.max(r.ts, cur.start); cur.end_reason = r.reason; open.delete(r.name);
    }
  }
  return { feed, instances: out, open };
}
export function fold(records) { const f = createFolder(); for (const r of records) f.feed(r); return f.instances; }

export function parseLines(text) {
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && KINDS.includes(r.kind) && NAME_RE.test(r.name || '') && isTs(Number(r.ts))) recs.push(r); } catch { /* torn or invalid line: skip */ }
  }
  return recs;
}

export function createSessionHistory({ file, now = Date.now, missMs = 2000, readOnly = false, refreshMs = 500 } = {}) {
  if (!file) throw new Error('session-history: file required');
  // Folded state lives in memory: read once at boot, then updated by each append (the server is the only writer, so it
  // never re-reads). readOnly = another process writes the file (the usage tailer): the file is re-checked at most every
  // refreshMs and only the bytes past the last complete line are read; a shrunk file or new inode is read in full.
  let folder = createFolder(), offset = 0, ino = null, checkedAt = 0;
  function load() {
    let st; try { st = statSync(file); } catch { if (ino !== null) { folder = createFolder(); offset = 0; ino = null; } return; }
    if (st.ino !== ino || st.size < offset) { folder = createFolder(); offset = 0; ino = st.ino; }
    if (st.size === offset) return;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - offset); const n = readSync(fd, buf, 0, buf.length, offset);
      const nl = buf.subarray(0, n).lastIndexOf(10);
      if (nl < 0) return;
      for (const r of parseLines(buf.toString('utf8', 0, nl))) folder.feed(r);
      offset += nl + 1;
    } finally { closeSync(fd); }
  }
  try { load(); } catch { /* unreadable: empty history */ }
  const fresh = () => { if (!readOnly) return; const t = Date.now(); if (t - checkedAt < refreshMs) return; checkedAt = t; try { load(); } catch { /* keep the last good state */ } };
  let queue = Promise.resolve();
  const instances = () => { fresh(); return folder.instances; };
  function append(rec) {
    if (readOnly) throw new Error('session-history: read-only');
    // validated now, written in call order: one write, one complete line
    const r = validateRecord(rec, now());
    const p = queue.then(async () => {
      mkdirSync(dirname(file), { recursive: true });
      const line = JSON.stringify(r) + '\n';
      await fsp.appendFile(file, line, { mode: 0o600 });
      folder.feed(r); offset += Buffer.byteLength(line);
      return r;
    });
    queue = p.catch(() => {});
    return p;
  }
  const openOf = (name) => { fresh(); return folder.open.get(name) || null; };
  const openNames = () => { fresh(); return new Set(folder.open.keys()); };
  const covers = (i, ts) => ts >= i.start && (i.end == null || ts < i.end);
  // The instance of `name` running at ts (latest start wins on overlap).
  function instanceAt(name, ts) {
    fresh();
    let best = null;
    for (const i of folder.instances) if (i.name === name && covers(i, ts) && (!best || i.start >= best.start)) best = i;
    return best;
  }
  // The instance running at ts in a working directory; null when none or ambiguous.
  function byCwd(cwd, ts) {
    fresh();
    const m = folder.instances.filter((i) => i.cwd === cwd && covers(i, ts));
    return m.length === 1 ? m[0] : null;
  }

  // Tick helper: live = Map(name -> {provider, model, cwd, created}) of tmux sessions. Starts unseen ones as 'unknown'
  // (ts = first seen), starts a new instance when a name was reused (tmux session_created differs), and ends open ones
  // missing for >= missMs of wall clock as 'vanished'. One call at a time: an overlapping call returns the running one.
  // The caller must not call this after a failed tmux listing (an empty list is only trusted when tmux said "no server").
  const missingSince = new Map();
  let running = null;
  function sync(live, opts = {}) {
    if (running) return running;
    running = doSync(live, opts).finally(() => { running = null; });
    return running;
  }
  async function doSync(live, { skip = new Set() } = {}) {
    const t = now();
    for (const [name, meta] of live) {
      missingSince.delete(name);
      if (skip.has(name) || !NAME_RE.test(name)) continue;
      const cur = folder.open.get(name);
      if (cur && cur.started_by === 'v2') continue;
      if (cur && cur.tmux_created != null && meta?.created != null && cur.tmux_created !== meta.created) {
        await append({ kind: 'session.ended', name, reason: 'vanished' });   // same name, different tmux session
      } else if (cur) continue;
      await append({ kind: 'session.started', name, provider: meta?.provider ?? null, model: meta?.model ?? null, cwd: meta?.cwd ?? null, started_by: 'unknown',
        prompt_ref: null, handover_ref: null, tmux_created: meta?.created ?? null });
    }
    for (const [name, cur] of [...folder.open]) {
      if (live.has(name) || cur.started_by === 'v2') continue;   // v2 runs are not tmux sessions
      const since = missingSince.get(name) ?? missingSince.set(name, t).get(name);
      if (t - since >= missMs) { missingSince.delete(name); await append({ kind: 'session.ended', name, reason: 'vanished' }); }
    }
  }
  return { append, instances, openOf, openNames, instanceAt, byCwd, sync, file };
}
