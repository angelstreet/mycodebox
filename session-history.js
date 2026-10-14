// Session history: an append-only start/end log of agent sessions ($GHOSTY_STATE_DIR/session-history.jsonl).
// The usage ledger only knows turns; this file knows when a session instance began and ended, who started it and
// with what prompt, so a ledger row at time ts can be attributed to the instance that was running then.
//   { schema_version: 1, kind: 'session.started', name, provider, model|null, cwd, started_by, prompt_ref, handover_ref,
//     remote_control_url?, ts }
//   { schema_version: 1, kind: 'session.ended', name, ts, reason: 'killed'|'exited'|'vanished' }
// Names are reused: an instance is a started record plus the next ended record for the same name.
// One appendFile call writes one complete line; a torn or invalid line (crash mid-write) is skipped on read.
import { promises as fsp, readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;
export const KINDS = ['session.started', 'session.ended'];
export const STARTED_BY = ['dashboard', 'cbsession', 'v2', 'manager', 'unknown'];
export const END_REASONS = ['killed', 'exited', 'vanished'];
export const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;
export const PROMPT_TEXT_MAX = 200;

// Prompt text is stored only as a short sanitized excerpt: no ANSI/control chars, whitespace collapsed, <= 200 chars.
// A value that looks like a path (absolute or ./ ~/ and no newline) is kept as a path reference instead.
export function sanitizePromptRef(v) {
  if (v == null) return null;
  const s = String(v);
  if (/^(?:\/|~\/|\.\.?\/)[^\n\r]*$/.test(s) && s.length <= 1024 && !/[\x00-\x1f\x7f]/.test(s)) return s;
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
  const rc = strOrNull(r.remote_control_url, 300);
  if (rc && /^https:\/\/[^\s]+$/.test(rc)) out.remote_control_url = rc;
  return out;
}

// Fold ordered records into session instances. A second start while one is open ends the old one at that ts
// ('superseded') -- except an 'unknown' instance (the tick saw the tmux session first), which the real start enriches in place.
export function fold(records) {
  const out = [];
  const open = new Map();
  for (const r of records) {
    if (r.kind === 'session.started') {
      const cur = open.get(r.name);
      if (cur && cur.started_by === 'unknown' && r.started_by !== 'unknown') {
        Object.assign(cur, { provider: r.provider ?? cur.provider, model: r.model ?? cur.model, cwd: r.cwd ?? cur.cwd, started_by: r.started_by,
          prompt_ref: r.prompt_ref, handover_ref: r.handover_ref, remote_control_url: r.remote_control_url ?? cur.remote_control_url ?? null, start: Math.min(cur.start, r.ts) });
        continue;
      }
      if (cur) { cur.end = r.ts; cur.end_reason = 'superseded'; }
      const inst = { name: r.name, provider: r.provider ?? null, model: r.model ?? null, cwd: r.cwd ?? null, started_by: r.started_by,
        prompt_ref: r.prompt_ref ?? null, handover_ref: r.handover_ref ?? null, remote_control_url: r.remote_control_url ?? null, start: r.ts, end: null, end_reason: null };
      open.set(r.name, inst); out.push(inst);
    } else if (r.kind === 'session.ended') {
      const cur = open.get(r.name);
      if (!cur) continue;
      cur.end = Math.max(r.ts, cur.start); cur.end_reason = r.reason; open.delete(r.name);
    }
  }
  return out;
}

export function parseLines(text) {
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && KINDS.includes(r.kind) && NAME_RE.test(r.name || '') && isTs(Number(r.ts))) recs.push(r); } catch { /* torn or invalid line: skip */ }
  }
  return recs;
}

export function createSessionHistory({ file, now = Date.now, missTicks = 2 } = {}) {
  if (!file) throw new Error('session-history: file required');
  let cache = { sig: null, instances: [] };
  const sig = () => { try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } };
  function instances() {   // cached by size+mtime; the file is only re-folded after an append
    const s = sig();
    if (s !== cache.sig) {
      let text = ''; try { text = readFileSync(file, 'utf8'); } catch { /* no file yet */ }
      cache = { sig: s, instances: fold(parseLines(text)) };
    }
    return cache.instances;
  }
  async function append(rec) {
    const r = validateRecord(rec, now());
    mkdirSync(dirname(file), { recursive: true });
    await fsp.appendFile(file, JSON.stringify(r) + '\n', { mode: 0o600 });   // one write, one complete line
    return r;
  }
  const openOf = (name) => { const l = instances(); for (let i = l.length - 1; i >= 0; i--) if (l[i].name === name) return l[i].end == null ? l[i] : null; return null; };
  const openNames = () => new Set(instances().filter((i) => i.end == null).map((i) => i.name));
  const covers = (i, ts) => ts >= i.start && (i.end == null || ts <= i.end);
  // The instance of `name` running at ts (latest start wins on overlap).
  function instanceAt(name, ts) {
    const l = instances(); let best = null;
    for (const i of l) if (i.name === name && covers(i, ts) && (!best || i.start >= best.start)) best = i;
    return best;
  }
  // The instance running at ts in a working directory; null when none or ambiguous.
  function byCwd(cwd, ts) {
    const m = instances().filter((i) => i.cwd === cwd && covers(i, ts));
    return m.length === 1 ? m[0] : null;
  }

  // Tick helper: live = Map(name -> {provider, model, cwd}) of tmux sessions. Starts unseen ones as 'unknown' (ts = first seen),
  // ends open ones missing for `missTicks` consecutive ticks as 'vanished' (one empty tmux answer must not end everything).
  // `skip` = names being created right now (the creator writes their real start record).
  const missing = new Map();
  async function sync(live, { skip = new Set(), ended = new Map() } = {}) {
    const open = new Set(instances().filter((i) => i.end == null && i.started_by !== 'v2').map((i) => i.name));   // v2 runs are not tmux sessions
    for (const [name, meta] of live) {
      missing.delete(name);
      if (open.has(name) || skip.has(name) || !NAME_RE.test(name)) continue;
      await append({ kind: 'session.started', name, provider: meta?.provider ?? null, model: meta?.model ?? null, cwd: meta?.cwd ?? null, started_by: 'unknown', prompt_ref: null, handover_ref: null });
    }
    for (const name of open) {
      if (live.has(name)) continue;
      const n = (missing.get(name) || 0) + 1;
      if (n >= missTicks) { missing.delete(name); await append({ kind: 'session.ended', name, reason: ended.get(name) || 'vanished' }); } else missing.set(name, n);
    }
  }
  return { append, instances, openOf, openNames, instanceAt, byCwd, sync, file };
}
