// AI manager event feed (TASK-44 phase ~N): one JSON line per fired alert in <stateDir>/manager-events.jsonl.
// The AI manager agent follows the file with `tail -n0 -F ...` so it wakes only when something happens,
// instead of polling. Skips events the manager must not react to (its own stops, the manager agent's own
// /api/alert calls, "done" — a turn finishing is not worth a wake).
//
// Key shapes (set by createAlerts() callers):
//   <session>:asks|waiting|done|hold|resume|...   → kind = suffix, session = prefix
//   deploy:<id>:<state>                          → kind = 'deploy', deployId, state
//   quota:<plan>:<window>                        → kind = 'quota'
//   disk:<path>                                  → kind = 'disk'
//   openrouter:credits                           → kind = 'credits'
//   manager-agent:<tag|title>                    → skipped (the agent's own POST /api/alert)
//   anything else                                → kind = 'other'
//
// Rotation: when the file would exceed maxBytes (default 5 MB), it is renamed to manager-events.jsonl.1
// (overwriting the old one) before the new line is appended. We check (current size + line length) so the
// new line never lands in a file that is about to be moved.

import { join } from 'node:path';
import { mkdir, stat, rename, appendFile, readFile } from 'node:fs/promises';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const FILE_NAME = 'manager-events.jsonl';
export const DEDUPE_MS = 6 * 3600 * 1000;   // the same stop re-fired inside this window is not appended again
export const FILE_NAME_OLD = 'manager-events.jsonl.1';

// Pure: classify an alert key. Exported for tests.
// Returns:
//   { kind: 'agent-skip' }                                           for manager-agent:<...>
//   { kind: 'deploy', deployId, state }                               for deploy:<id>:<state>
//   { kind: 'quota', quotaKey }                                      for quota:<...>
//   { kind: 'disk', diskPath }                                       for disk:<...>
//   { kind: 'credits', creditsKey }                                  for openrouter:<...>
//   { kind, session }                                                for <session>:<kind>
//   { kind: 'other' }                                                 otherwise
export function classifyKey(key) {
  if (typeof key !== 'string' || !key) return { kind: 'other' };
  const colon = key.indexOf(':');
  if (colon < 0) return { kind: 'other' };
  const head = key.slice(0, colon);
  if (head === 'manager-agent') return { kind: 'agent-skip' };
  if (head === 'deploy') {
    const rest = key.slice(colon + 1);
    const i = rest.indexOf(':');
    if (i < 0) return { kind: 'deploy', deployId: rest, state: null };
    return { kind: 'deploy', deployId: rest.slice(0, i), state: rest.slice(i + 1) || null };
  }
  if (head === 'quota') return { kind: 'quota', quotaKey: key.slice(colon + 1) };
  if (head === 'disk') return { kind: 'disk', diskPath: key.slice(colon + 1) };
  if (head === 'openrouter') return { kind: 'credits', creditsKey: key.slice(colon + 1) };
  // <session>:<kind> — the suffix may itself contain colons (we don't strip beyond the first).
  return { kind: key.slice(colon + 1), session: head };
}

// The default fs module is node:fs/promises; tests inject a fake via { fs }.
//   annotate(event, cls) (optional): async, returns the `jev` value to put on the line (TASK-47 G10, wake-shadow.js) or
//   undefined for none. It is awaited BEFORE the serialised append chain, so one slow call never blocks other events;
//   it must answer within its own cap and never throw (a throw / reject is treated as "no annotation").
export function createManagerEvents({ stateDir, managerSessions = () => [], fs: fsMod, maxBytes = DEFAULT_MAX_BYTES, now = Date.now, annotate = null } = {}) {
  const fsp = fsMod || { mkdir, stat, rename, appendFile, readFile };
  const file = join(stateDir, FILE_NAME);
  const oldFile = join(stateDir, FILE_NAME_OLD);

  async function maybeRotate(line) {
    try {
      const st = await fsp.stat(file);
      if (st.size + Buffer.byteLength(line) >= maxBytes) await fsp.rename(file, oldFile);
    } catch { /* no file yet */ }
  }

  // record(event): event = { at, key, title, body, url, priority }
  //   at       : ISO string (optional; defaults to now())
  //   key      : the alert key
  //   title    : the alert title
  //   body     : string, truncated to 300 chars on output
  //   url      : string (default '/')
  //   priority : string (default 'default')
  // Returns true when written, false when skipped (manager session, own alert, 'done').
  let chain = Promise.resolve();   // serialise appends: stat+rename+append must not interleave across concurrent records
  async function record(event) {
    const built = build(event);
    if (!built) return false;
    if (annotate) {
      try {
        const jev = await annotate(event, built.cls);
        if (jev !== undefined) built.rec.jev = jev;
      } catch (e) { console.error('[manager-events] annotate', e.message); }
    }
    const p = chain.then(() => writeNow(built.rec));
    chain = p.catch(() => {});
    return p;
  }
  // Pure part: the record, or null for events the feed skips (manager sessions, own alerts, 'done').
  function build(event) {
    if (!event || typeof event !== 'object' || typeof event.key !== 'string') return null;
    const cls = classifyKey(event.key);
    if (cls.kind === 'agent-skip') return null;
    if (cls.kind === 'done') return null;
    const sessions = managerSessions() || [];
    if (cls.session && sessions.includes(cls.session)) return null;

    const at = event.at || new Date(now()).toISOString();
    const rec = { at, key: event.key, kind: cls.kind };
    if (cls.session) rec.session = cls.session;
    if (cls.kind === 'deploy') { rec.deployId = cls.deployId; if (cls.state) rec.state = cls.state; }
    if (cls.kind === 'quota') rec.quotaKey = cls.quotaKey;
    if (cls.kind === 'disk') rec.diskPath = cls.diskPath;
    if (cls.kind === 'credits') rec.creditsKey = cls.creditsKey;
    rec.title = typeof event.title === 'string' ? event.title : '';
    rec.body = typeof event.body === 'string' ? event.body.slice(0, 300) : '';
    rec.url = typeof event.url === 'string' ? event.url : '/';
    rec.priority = typeof event.priority === 'string' ? event.priority : 'default';
    return { rec, cls };
  }
  // Re-fired stops (a re-wrap, a restart) repeat the same session + kind + text minutes apart: skip them for 6 h.
  // The map is seeded from the file's tail on first use so a service restart does not forget it.
  const seen = new Map();   // dedupe signature -> ms of the newest appended line
  let seeded = false;
  const sigOf = (r) => [r.session || r.key, r.kind, String(r.body || r.title || '').replace(/\s+/g, '').slice(0, 160)].join('\u0000');
  async function seedSeen() {
    seeded = true;
    try {
      const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-500);
      for (const l of lines) { try { const r = JSON.parse(l); const t = Date.parse(r.at); if (Number.isFinite(t)) seen.set(sigOf(r), t); } catch {} }
    } catch { /* no file yet */ }
  }
  async function writeNow(rec) {
    if (!seeded) await seedSeen();
    const sig = sigOf(rec), t = Date.parse(rec.at);
    const prev = seen.get(sig);
    if (prev !== undefined && Number.isFinite(t) && t - prev >= 0 && t - prev < DEDUPE_MS) return false;
    if (Number.isFinite(t)) seen.set(sig, t);
    const line = JSON.stringify(rec) + '\n';
    await fsp.mkdir(stateDir, { recursive: true });
    await maybeRotate(line);
    try {
      await fsp.appendFile(file, line);
    } catch (e) { console.error('[manager-events] append', e.message); return false; }
    return true;
  }

  // tail({ since, limit }) → newest-last list of {at,key,...} entries strictly after `since` (ISO).
  // `since` omitted/null returns the last `limit` lines. The file is read whole; rotation keeps it small.
  async function tail({ since = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(2000, Number(limit) || 50));
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
    const lines = text.split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let start = 0;
    if (since) {
      const t = Date.parse(since);
      if (Number.isFinite(t)) {
        const idx = parsed.findIndex((e) => Date.parse(e.at) > t);
        start = idx >= 0 ? idx : parsed.length;
      }
    }
    return parsed.slice(start).slice(-n);
  }

  return { record, tail, file };
}