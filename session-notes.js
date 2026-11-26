// Session notes (owner, 2026-11-26: "why do we get STATUS: acknowledged several times"). A message that only informs (rules watch,
// overlap and shared-checkout guards, lease pin notes) must not start a turn: every wake re-reads the whole context to answer
// "acknowledged". It is parked here and goes with the session's next real turn, once:
//   - Claude: the ghosty-reporter prompt.submit hook takes it (`notes.take`) and attaches it as context, then `notes.ack`;
//   - any session whose agent has no such hook (Codex, MiniMax, an older plugin): appended to the next real message ghosty types.
// A note is replaced by a newer one with the same key and dropped when what it says is no longer true. State: session-notes.json.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A message that can take a note along: real text, not a slash / shell command, a menu digit or a bare "continue".
export const carriesNotes = (text) => { const t = String(text || '').trim(); return t.length >= 12 && /\s/.test(t) && !/^[/!#]/.test(t); };
// Appended, never prepended: the sender of a prompt is matched on how it starts (public/prompt-sig.js).
export const withNotes = (text, notes) => [text, ...notes.map((n) => n.text)].join('\n\n');
// The hook's flag outlives a killed Claude process: it counts only while the pane still runs Claude (or its agent is not known yet).
export const hookDelivers = (asked, agent) => !!asked && (!agent || agent === 'claude');

// Types `text`, with the parked notes when `carry`. They are claimed before typing, so a hook asking meanwhile cannot deliver them
// twice, and put back when the send fails or the text stays unsubmitted. type(text) -> { submitted? }.
export async function carryNotes(store, session, text, carry, type) {
  const notes = carry && carriesNotes(text) ? store.peek(session) : [];
  if (!notes.length) return type(text);
  store.ack(session, notes.map((n) => n.id));
  let out;
  try { out = await type(withNotes(text, notes)); } catch (e) { store.restore(session, notes); throw e; }
  if (out?.submitted === false) store.restore(session, notes);
  return out;
}

export function createSessionNotes({ stateDir, now = Date.now, log = console } = {}) {
  const file = join(stateDir, 'session-notes.json');
  let all = {};   // session -> [{ id, key, text, at }]
  try { all = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { /* none yet */ }

  // Synchronous: notes are few and small, and a take must never interleave with another write.
  function save() {
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
    catch (e) { log.error?.('[session-notes] save', e.message); }
  }
  const list = (session) => (Object.hasOwn(all, session) ? all[session] : []);
  function keep(session, rows) {
    if (rows.length === list(session).length) return;
    if (rows.length) all[session] = rows; else delete all[session];
    save();
  }
  function put(session, key, text) {
    all[session] = [...list(session).filter((n) => n.key !== key), { id: randomUUID(), key, text, at: new Date(now()).toISOString() }];
    save();
  }
  const peek = (session) => [...list(session)];
  const ack = (session, ids) => keep(session, list(session).filter((n) => !(Array.isArray(ids) && ids.includes(n.id))));
  // back after a failed send; a newer note under the same key wins
  function restore(session, notes) {
    const back = notes.filter((n) => !list(session).some((x) => x.key === n.key));
    if (!back.length) return;
    all[session] = [...back, ...list(session)];
    save();
  }
  const drop = (session, key) => keep(session, list(session).filter((n) => n.key !== key));
  const dropKey = (key) => { for (const s of Object.keys(all)) drop(s, key); };
  const prune = (liveNames) => { for (const s of Object.keys(all)) if (!liveNames.has(s)) keep(s, []); };

  return { put, peek, ack, restore, drop, dropKey, prune };
}
