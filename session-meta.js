// Per-session owner settings (TASK-44 phase 5): priority P0|P1|P2 (default P2) and the pause hold.
// Persisted in $GHOSTY_STATE_DIR/sessions.json keyed by tmux session name:
//   { "<name>": { priority, paused, pausedAt, seenAt } }
// An entry is created the first time a session is seen (P2) and dropped once the session has been
// gone for more than 7 days. Nothing here touches tmux; server.js sends the keys.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PRIORITY, isPriority } from './public/prio.js';

const GONE_MS = 7 * 86400e3;
const SEEN_REFRESH_MS = 3600e3;   // seenAt is rewritten at most hourly, so the file is not hit every tick

export function createSessionMeta({ file, now = Date.now } = {}) {
  let data = {};
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) data = j;
  } catch {}

  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch (e) { console.error('[session-meta] save', e.message); }
  };
  const entry = (name) => {
    let e = data[name];
    if (!e) { e = data[name] = { priority: DEFAULT_PRIORITY, paused: false, seenAt: now() }; save(); }
    return e;
  };
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

  return {
    priority: (name) => (isPriority(data[name]?.priority) ? data[name].priority : DEFAULT_PRIORITY),
    isPaused: (name) => !!data[name]?.paused,
    pausedAt: (name) => (data[name]?.paused ? data[name].pausedAt || null : null),
    // Called every poll with the live names: registers new sessions and prunes long-gone ones.
    sync(liveNames) {
      const t = now();
      let dirty = false;
      for (const n of liveNames) {
        const e = data[n];
        if (!e) { data[n] = { priority: DEFAULT_PRIORITY, paused: false, seenAt: t }; dirty = true; }
        else if (t - (e.seenAt || 0) > SEEN_REFRESH_MS) { e.seenAt = t; dirty = true; }
      }
      const live = new Set(liveNames);
      for (const [n, e] of Object.entries(data)) {
        if (!live.has(n) && t - (e.seenAt || 0) > GONE_MS) { delete data[n]; dirty = true; }
      }
      if (dirty) save();
    },
    // Returns what changed: { priority?: 'P1', paused?: true }. Unchanged values are not reported.
    set(name, { priority, paused } = {}) {
      if (priority === undefined && paused === undefined) throw bad('priority (P0|P1|P2) or paused (boolean) required');
      if (priority !== undefined && !isPriority(priority)) throw bad('priority must be P0, P1 or P2');
      if (paused !== undefined && typeof paused !== 'boolean') throw bad('paused must be a boolean');
      const e = entry(name);
      const changed = {};
      if (priority !== undefined && e.priority !== priority) { e.priority = priority; changed.priority = priority; }
      if (paused !== undefined && !!e.paused !== paused) {
        e.paused = paused;
        if (paused) e.pausedAt = now(); else delete e.pausedAt;
        changed.paused = paused;
      }
      if (Object.keys(changed).length) save();
      return changed;
    },
    // A session that is created or killed starts over (a reused name must not inherit a hold).
    reset(name) { if (data[name]) { delete data[name]; save(); } },
    snapshot: () => structuredClone(data),
  };
}
