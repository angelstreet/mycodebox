// Done with leftovers (owner, 2026-10-28): a session that ends `STATUS: done` but lists work it can do itself ("Left to do",
// "Remaining", "open: ...") sat idle ~13 h until the owner typed "continue". Pure parser + a watcher that wakes the manager
// (feed kind `leftovers`, items in the event); it never types into the session, the manager decides and sends the push.
// Switch: manager.json `leftovers` "live" (default) | "off".
import { createHash } from 'node:crypto';

export const IDLE_MS = 10 * 60 * 1000;
export const MAX_PER_HOUR = 4;
export const POLL_MS = 2 * 60 * 1000;

// Text that only the owner can act on: names the owner, an account, a purchase, a physical action, money, credentials.
const OWNER_ONLY = /\b(?:owner|jev|you must|needs? you|account|purchase|buy|bought|pay(?:ment)?|invoice|money|budget|credentials?|secrets?|tokens?|password|api[- ]?key|re-?\s?plug|unplug|plug(?:ged)? in|press(?:ing)? the|power[- ]?cycle|physical(?:ly)?|sudoers?|customer)\b/i;
const HEADER = /^\s*(?:[-*#>•]+\s*)*\**\s*(?:left to do|leftovers?|remaining(?: work| items| steps)?|still (?:to do|open)|todo|to do|next steps?|open(?: items)?)(?:,[^:\n]*)?\s*\**\s*:?\s*\**\s*(.*)$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
const STATUS = /^\W*STATUS:\s*([a-z-]+)\s*(.*)$/i;
const NONE = /^(?:none|nothing|n\/a|-|no\b.*)$/i;

const clean = (s) => String(s).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();

// Pane-wrapped lines: an indented non-bullet line directly under a bullet or the STATUS line continues it.
function unwrap(lines) {
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^\s{2,}\S/.test(l) && !BULLET.test(l) && !STATUS.test(l.trim()) && (BULLET.test(prev) || STATUS.test(prev.trim()) || prev._cont)) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + l.trim();
    else out.push(l);
  }
  return out;
}

// Pure. text: the closing text of a turn (pane excerpt). -> { items: [string], ownerOnly: [string], actionable: [string] } or null
// when the last STATUS is not done or no leftovers are listed. A list is read from `open:` on the STATUS line (items split on
// ';' and ',') and from a "Left to do / Remaining" header with bullets or inline text below it.
export function leftoversOf(text) {
  const lines = unwrap(String(text || '').split('\n'));
  let statusAt = -1, status = null;
  lines.forEach((l, i) => { const m = STATUS.exec(l.trim()); if (m) { statusAt = i; status = m; } });
  if (!status || !/^(?:done|ok|complete|completed|finished)$/i.test(status[1])) return null;
  const items = [];
  const add = (s) => { const c = clean(s); if (c && !NONE.test(c) && !items.includes(c)) items.push(c); };
  const open = /\bopen\s*:\s*(.+)$/i.exec(status[2]);
  if (open) open[1].split(/[;,]|\s+\band\b\s+(?=[A-Z])/).forEach(add);
  for (let i = 0; i < lines.length; i++) {
    if (i === statusAt) continue;
    const h = HEADER.exec(lines[i]);
    // a header is the label alone or the label followed by ':' (prose like "remaining time is short" is not a list)
    if (!h || (h[1] && !/^[\s\-*#>•]*\**\s*[a-z ,-]+\**\s*:/i.test(lines[i]))) continue;
    if (h[1]) h[1].split(/[;,]/).forEach(add);
    for (let j = i + 1; j < lines.length && j < i + 15; j++) {
      const b = BULLET.exec(lines[j]);
      if (b) add(b[1]);
      else if (lines[j].trim() === '' && items.length) { if (!BULLET.test(lines[j + 1] || '')) break; }
      else if (!lines[j].trim()) continue;
      else break;
    }
  }
  if (!items.length) return null;
  const ownerOnly = items.filter((s) => OWNER_ONLY.test(s)), actionable = items.filter((s) => !OWNER_ONLY.test(s));
  return { items, ownerOnly, actionable };
}

// Pure. The first item the session can do itself, or null (clean done, or everything left is owner-only).
export function pushableItems(text) {
  const r = leftoversOf(text);
  return r && r.actionable.length ? r.actionable : null;
}

// One line for the manager.
export function summary(items) { return items.slice(0, 3).join(' | ').slice(0, 280); }

// Watcher. listIdle: async () => [{ name, text, idleMs, working, draft, paused, held, manager, turnAt }] (the server filters nothing
// but supplies the facts); record: manager feed. Gates: no draft, not working, not paused/held, not a manager session,
// idle > IDLE_MS, once per session turn (signature of the items), at most MAX_PER_HOUR events per session.
// classify(text) -> { kind, items, title?, ...extra } | null picks what a stop is; the default is done-with-leftovers. The server
// passes one that also reads owner-push.js (kind 'push': suggestions / routine-ask / blocked-host, extra = pushKind + reply).
const leftoversKind = (text) => { const items = pushableItems(text); return items && { kind: 'leftovers', items, title: 'done with leftovers' }; };
export function createLeftovers({ listIdle, record, classify = leftoversKind, mode = () => 'live', now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const told = new Map();    // session -> signature already reported
  const sent = new Map();    // session -> [ms]
  let timer = null, busy = false, last = { at: 0, found: [] };

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      if (mode() === 'off') return (last = { at: now(), found: [], mode: 'off' });
      const found = [];
      for (const s of await listIdle()) {
        if (s.manager || s.paused || s.held || s.draft || s.working || s.idleMs < IDLE_MS) continue;
        const c = classify(s.text);
        if (!c || !c.items?.length) { told.delete(s.name); continue; }
        const { kind, items, title, ...extra } = c;
        const sig = createHash('sha1').update(s.name + '\0' + (s.turnAt || '') + '\0' + items.join('\0')).digest('hex').slice(0, 12);
        found.push({ name: s.name, kind, items, ...(extra.pushKind ? { pushKind: extra.pushKind } : {}) });
        if (told.get(s.name) === sig) continue;
        const recent = (sent.get(s.name) || []).filter((t) => now() - t < 3600 * 1000);
        if (recent.length >= MAX_PER_HOUR) continue;
        told.set(s.name, sig); sent.set(s.name, [...recent, now()]);
        try {
          await record({ key: `${s.name}:${kind}`, title: `${s.name}: ${title || kind}`, body: summary(items), items, ...extra, url: `/?s=${encodeURIComponent(s.name)}`, priority: 'default', at: new Date(now()).toISOString() });
        } catch (e) { log.error?.('[leftovers] record', s.name, e.message); }
      }
      return (last = { at: now(), found });
    } catch (e) { log.error?.('[leftovers]', e.message); return (last = { ...last, at: now(), error: e.message }); }
    finally { busy = false; }
  }
  return {
    tick, snapshot: () => last,
    start(firstDelayMs = 3 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
