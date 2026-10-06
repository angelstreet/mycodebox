// Where the owner put things: the order of the sessions, which are pinned, and the named groups. One small JSON file
// (<state dir>/layout.json) so a refresh or another device shows the same list.
//   { order: [session…], pins: [session…], groups: { session: groupName }, groupNames: [groupName…], collapsed: [sectionKey…], hidden: [session…], groupBy: ''|'project' }
// groupBy 'project' = the list also sections itself by repo (manual groups still win).
// Section keys: "pin" or "g:<groupName>". Unknown sessions are kept (a session may be down for a while).
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const MAX_NAMES = 500, MAX_LEN = 80;
const str = (x) => (typeof x === 'string' ? x.trim().slice(0, MAX_LEN) : '');
const uniq = (arr) => [...new Set(arr)];

export function normalizeLayout(x) {
  const list = (v) => (Array.isArray(v) ? uniq(v.map(str).filter(Boolean)).slice(0, MAX_NAMES) : []);
  const groups = {};
  if (x && typeof x.groups === 'object' && x.groups && !Array.isArray(x.groups)) {
    for (const [k, v] of Object.entries(x.groups).slice(0, MAX_NAMES)) { const g = str(v), n = str(k); if (n && g) groups[n] = g; }
  }
  const groupNames = uniq([...list(x?.groupNames), ...Object.values(groups)]);
  return { order: list(x?.order), pins: list(x?.pins), groups, groupNames, collapsed: list(x?.collapsed), hidden: list(x?.hidden), groupBy: x?.groupBy === 'project' ? 'project' : '' };
}

export function createLayoutStore({ file }) {
  let cur = normalizeLayout(null), loaded = false, writing = Promise.resolve();
  async function load() {
    if (loaded) return cur;
    try { cur = normalizeLayout(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { cur = normalizeLayout(null); }
    loaded = true;
    return cur;
  }
  async function get() { return load(); }
  // a PUT may carry only some keys; the others keep their value
  async function set(patch) {
    await load();
    cur = normalizeLayout({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) });
    const snap = JSON.stringify(cur, null, 2);
    writing = writing.then(async () => {
      await fs.mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snap);
      try { await fs.copyFile(file, `${file}.bak`); } catch { /* first write */ }   // one step back, in case a bad PUT wipes it
      await fs.rename(tmp, file);
    }).catch(() => {});
    await writing;
    return cur;
  }
  return { get, set };
}
