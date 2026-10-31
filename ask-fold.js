// One open ask per session (owner, 2026-10-31): while the owner-asks ledger (manager-owner-asks.jsonl) has an open ask for a session,
// further "asks you" / "needs you" alerts of that session are folded into it: no new push, no new event, until the ask is answered or
// superseded. The ledger is read in the background (a cached set, refreshed at most every `ttlMs`), so the alert path stays synchronous;
// a ledger that cannot be read folds nothing (alerts go out as before).
import { readOpenAsks } from './owner-asks.js';

export function createAskFold({ file, ttlMs = 10_000, read = readOpenAsks, now = Date.now } = {}) {
  let sessions = new Map(), at = 0, busy = null;
  const refresh = () => {
    if (busy) return busy;
    busy = Promise.resolve().then(() => read(file)).then((asks) => {
      const m = new Map();
      for (const a of asks || []) if (a?.session && !m.has(a.session)) m.set(a.session, a.id);
      sessions = m; at = now();
    }).catch(() => { sessions = new Map(); at = now(); }).finally(() => { busy = null; });
    return busy;
  };
  // -> the open ask id of that session, or null. Starts a refresh when the cache is stale (the answer is the cached one).
  const openAskOf = (session) => { if (now() - at > ttlMs) refresh(); return sessions.get(session) || null; };
  // should this alert be folded into an open ask? only the owner-facing kinds
  const folds = (session, kind) => (kind === 'asks' || kind === 'waiting') && !!openAskOf(session);
  return { refresh, openAskOf, folds };
}
