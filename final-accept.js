// Accepted final (2026-11-26): the manager accepted a session's partial / failed / blocked result as final, and the harness kept pushing it (time box,
// "blocked lacks tried: and need:") and raising `asks` events. The record is explicit only (`accept_final` on a send, or POST /api/manager/accept-final/:s),
// never guessed from message text, and it changes nothing about the result: no row, status or goal check is marked passed. While it stands the harness
// sends the session nothing and raises no ask for it. A later owner / manager task message reopens it. State: <state>/accepted-final.json, journal .jsonl.
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Who may accept, and whose text reopens: the owner (the dashboard sends no `by`), the owner's relayed words, the manager. Harness actors never do.
export const isTaskActor = (by) => by === 'owner' || by === 'manager-agent' || /^owner-/.test(String(by || ''));
// TUI housekeeping typed into a pane is not a task.
const HOUSEKEEPING = /^\/(?:exit|quit|clear|compact|status|cost|usage|context|model|rename|remote-control)\b/i;
export const isTaskMessage = (by, text) => isTaskActor(by) && !!String(text || '').trim() && !HOUSEKEEPING.test(String(text).trim());

export function createFinalAccept({ stateDir, now = Date.now, log = console } = {}) {
  const file = join(stateDir, 'accepted-final.json');
  const journal = join(stateDir, 'accepted-final.jsonl');
  let cache = { key: '', all: {} };
  function load() {
    try {
      const st = statSync(file), key = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (key !== cache.key) cache = { key, all: JSON.parse(readFileSync(file, 'utf8')) || {} };
    } catch (e) {
      if (e.code === 'ENOENT') cache = { key: '', all: {} };
      else log.error?.('[final-accept] read', e.message);   // an unreadable file keeps what was last read
    }
    return cache.all;
  }
  function save(all) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(all));
    renameSync(`${file}.tmp`, file);
    cache = { key: '', all };
  }
  const note = (e) => { try { appendFileSync(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} };
  const has = (name) => Object.hasOwn(load(), name);
  return {
    file,
    has,
    get: (name) => (has(name) ? load()[name] : null),
    list: () => ({ ...load() }),
    accept(name, { by, note: why = '' } = {}) {
      if (!isTaskActor(by)) throw Object.assign(new Error('only the owner or the manager accepts a final result (by: "manager-agent" | "owner")'), { status: 403 });
      const rec = { at: new Date(now()).toISOString(), by, ...(why ? { note: String(why).slice(0, 300) } : {}) };
      save({ ...load(), [name]: rec });
      note({ session: name, type: 'accepted', ...rec });
      return rec;
    },
    // -> true when there was a record to drop
    reopen(name, { by = 'unknown', why = '' } = {}) {
      if (!has(name)) return false;
      const all = { ...load() };
      delete all[name];
      save(all);
      note({ session: name, type: 'reopened', by, why: String(why).slice(0, 300) });
      return true;
    },
  };
}
