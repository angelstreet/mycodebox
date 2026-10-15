// Hardware ready window (round 9 item 8): "ready for 30 minutes [on <device>]" by voice or tap. While a window is open the manager answers a
// session stop that asks the owner for a hardware step on that device (pair, press, plug, power-cycle) with "retry the step yourself; stop
// after 2 failures"; the third ask inside the window goes to the owner. State: <state>/ready-windows.json. Pure matching + a tiny file store.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hardMatch, forbiddenMatch } from './stall.js';

export const MAX_MINUTES = 240;
export const MAX_FAILURES = 2;     // what the session is told; the owner is asked again on the ask after these (the third)
export const MAX_ANSWERS = 2;      // asks answered per session per window
export const SCOPES = ['device', 'host', 'session', 'any'];
// the owner is asked to touch hardware: pairing, pressing, plugging, power-cycling, a cable
export const HARDWARE_RE = /\b(?:pair(?:ed|ing)?|press(?:ed)?\b[^.\n?]{0,40}\b(?:button|pair|key|power|remote)|plug(?:ged)?(?:[ -]?in)?|unplug(?:ged)?|replug|power[- ]?cycl(?:e|ed|ing)|power (?:it )?(?:on|off)|(?:turn|switch) (?:it |the \w+ )?(?:on|off)|reconnect|re-?seat|usb|cable|bootloader|recovery mode)\b/i;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hhmm = (ms, tz) => {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(11, 16); }
};

export function createReadyStore({ file, now = Date.now, timezone = null } = {}) {
  let wins = [];
  const load = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); wins = Array.isArray(j.windows) ? j.windows.filter((w) => w && typeof w.id === 'string' && Number.isFinite(w.until)) : []; } catch { wins = []; } };
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify({ windows: wins })); renameSync(`${file}.tmp`, file); } catch (e) { console.error('[ready] save', e.message); } };
  const live = () => { const t = now(); const before = wins.length; wins = wins.filter((w) => w.until > t); if (wins.length !== before) save(); return wins; };
  load();
  return {
    // { device | host | session, minutes, by } -> the window. Nothing named = scope 'any'. A new window for the same target replaces the old one.
    set({ device, host, session, minutes, by = 'owner' } = {}) {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) throw Object.assign(new Error(`minutes must be 1..${MAX_MINUTES}`), { status: 400 });
      const named = [['device', device], ['host', host], ['session', session]].filter(([, v]) => v != null && v !== '');
      if (named.length > 1) throw Object.assign(new Error('name one of device, host or session'), { status: 400 });
      const [scope, target] = named[0] || ['any', ''];
      if (target && (typeof target !== 'string' || !/^[\w .@:+-]{1,80}$/.test(target))) throw Object.assign(new Error(`${scope} has characters that are not allowed`), { status: 400 });
      live();
      wins = wins.filter((w) => !(w.scope === scope && String(w.target).toLowerCase() === String(target).toLowerCase()));
      const t = now();
      const w = { id: randomUUID(), scope, target: String(target).trim(), set_at: t, until: t + m * 60e3, by: String(by).slice(0, 40), asks: {} };
      wins.push(w); save();
      return this.view(w);
    },
    clear(id) { live(); const before = wins.length; wins = wins.filter((w) => w.id !== id && id !== 'all'); if (wins.length !== before) save(); return before - wins.length; },
    view: (w) => ({ id: w.id, scope: w.scope, target: w.target, until: w.until, until_hhmm: hhmm(w.until, timezone), set_at: w.set_at, by: w.by }),
    list() { return live().map((w) => this.view(w)); },
    // the window that covers this session / ask text, or null
    match({ session, text }) {
      const t = String(text || '');
      return live().find((w) => (w.scope === 'any')
        || (w.scope === 'session' && w.target.toLowerCase() === String(session).toLowerCase())
        || ((w.scope === 'device' || w.scope === 'host') && new RegExp(`(?<![\\w-])${esc(w.target)}(?![\\w-])`, 'i').test(`${t} ${session}`))) || null;
    },
    // a chip for the session row: the window and (when named) its target
    chipFor(session, text) { const w = this.match({ session, text }); return w ? this.view(w) : null; },
    // Which ask this stop would be in the window (nothing recorded) -> { n, answer: n <= MAX_ANSWERS }. An ask counts only after commitAsk,
    // which the manager calls once the answer passed its gates (autoSend, pause, cap, draft).
    peekAsk(w, session, stopId) {
      const rec = wins.find((x) => x.id === w.id);
      if (!rec) return { n: MAX_ANSWERS + 1, answer: false };
      const ids = rec.asks[session]?.ids || [];
      const at = ids.indexOf(stopId);
      const n = at >= 0 ? at + 1 : ids.length + 1;
      return { n, answer: n <= MAX_ANSWERS };
    },
    commitAsk(w, session, stopId) {
      const rec = wins.find((x) => x.id === w.id);
      if (!rec) return;
      const a = (rec.asks[session] ||= { ids: [] });
      if (!a.ids.includes(stopId)) { a.ids.push(stopId); save(); }
    },
  };
}

// The reply the session gets. Plain words; no deploy / restart / merge vocabulary so the hard floor stays out of its way.
export function readyReply(w, hhmmUntil) {
  const at = hhmmUntil || w.until_hhmm;
  return `The owner is at the device until ${at}: retry the step yourself; stop after ${MAX_FAILURES} failures.`;
}

// Does this stop ask the owner for a hardware step the manager may wave through? -> true | false. Never when the ask touches a forbidden or hard topic.
export function isHardwareAsk({ kase, action, question, excerpt }) {
  if (!['owner_action', 'owner_decision'].includes(kase)) return false;
  const text = `${action || ''}\n${question || ''}`;
  if (!HARDWARE_RE.test(text)) return false;
  const whole = `${text}\n${excerpt || ''}`;
  return !forbiddenMatch(whole) && !hardMatch(whole, {});
}

// ---- the spoken command ----
const WORD_MIN = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, 'ninety': 90, 'an hour': 60, 'one hour': 60, 'half an hour': 30, 'two hours': 120, 'ninety minutes': 90 };
// normalised transcript -> { minutes, device } | null: "ready for 30 minutes", "i am ready for ten minutes on the pixel"
export function parseReadySpeech(t) {
  const m = /^(?:(?:i am|i'm|i m|im|we are|we're|we re) )?(?:ready|here|at (?:the|my) (?:device|desk|bench))(?: for)? (\d{1,3}|an hour|one hour|two hours|half an hour|ninety minutes|(?:five|ten|fifteen|twenty|thirty|forty|forty five|fifty|sixty|ninety)(?: minutes?| mins?)?)(?: minutes?| mins?)?(?: (?:on|at|for|with) (?:the |my )?([a-z0-9][a-z0-9 ._-]{0,60}))?$/.exec(String(t || ''));
  if (!m) return null;
  const raw = m[1].replace(/ (?:minutes?|mins?)$/, '');
  const minutes = /^\d+$/.test(raw) ? Number(raw) : WORD_MIN[raw];
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null;
  const device = (m[2] || '').trim() || null;
  return { minutes, device };
}
