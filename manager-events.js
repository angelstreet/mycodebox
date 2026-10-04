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
export function createManagerEvents({ stateDir, managerSessions = () => [], fs: fsMod, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
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
  async function record(event) {
    if (!event || typeof event !== 'object' || typeof event.key !== 'string') return false;
    const cls = classifyKey(event.key);
    if (cls.kind === 'agent-skip') return false;
    if (cls.kind === 'done') return false;
    const sessions = managerSessions() || [];
    if (cls.session && sessions.includes(cls.session)) return false;

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