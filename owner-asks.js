// The manager's ledger of questions for the owner (~/.local/state/ghosty/manager-owner-asks.jsonl, see TASK-44-MANAGER.md):
// one line per question {at,id,session,question,options,recommendation,state:"open"}, later lines per resolution
// {id,state:"answered|superseded|partial|amended"} or {action:"ledger-close|ledger-amend|log_intent"}. The open ones are what
// the owner still has to answer; the page shows them in the NEEDS YOU strip.
import { readFile, appendFile } from 'node:fs/promises';

const CLOSED = new Set(['answered', 'superseded', 'closed', 'resolved', 'withdrawn']);

export function openAsks(lines) {
  const byId = new Map();
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.id) continue;
    const prev = byId.get(r.id) || { id: r.id, open: false };
    if (r.action === 'ledger-close' || CLOSED.has(r.state)) { prev.open = false; byId.set(r.id, prev); continue; }
    if (r.state === 'open' || r.action === 'log_intent' || r.action === 'ledger-amend' || r.state === 'partial' || r.state === 'amended') {
      prev.open = true;
      for (const k of ['at', 'session', 'question', 'recommendation']) if (r[k]) prev[k] = r[k];
      if (Array.isArray(r.options) && r.options.length) prev.options = r.options;
    }
    byId.set(r.id, prev);
  }
  return [...byId.values()].filter((a) => a.open && a.question).map(({ open, ...a }) => a)
    .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
}

// One open ask per session (round 9, item 5): the newest of a session stands, the older ones are shown no more. `asks` is newest first.
export function newestPerSession(asks) {
  const seen = new Set();
  return asks.filter((a) => { if (!a.session) return true; if (seen.has(a.session)) return false; seen.add(a.session); return true; });
}

export async function readOpenAsks(file) {
  try { return newestPerSession(openAsks((await readFile(file, 'utf8')).split('\n').filter(Boolean))); } catch { return []; }
}

// A session escalated a new ask: every older open ask of that session is marked superseded by it (appended to the ledger, never edited).
// -> the superseded ids. A missing ledger is not created.
export async function supersedeOlder(file, session, newId, { now = new Date(), before = null } = {}) {
  if (!session || !newId) return [];
  let lines; try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  // `before` (ms): only asks written before the stop that raised the new one; an ask with no readable time is left alone
  const older = openAsks(lines).filter((a) => a.session === session && a.id !== newId && (before == null || Date.parse(a.at) < before));
  if (!older.length) return [];
  await appendFile(file, older.map((a) => JSON.stringify({ at: now.toISOString(), id: a.id, state: 'superseded', by: newId })).join('\n') + '\n');
  return older.map((a) => a.id);
}
