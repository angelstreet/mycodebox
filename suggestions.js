// Suggestions the owner has not answered (owner, 2026-11-26): "if a user say done i ll archive and miss the fact that he suggest improvements, we should
// not say done until i say yes or no for the improvements". Every suggestion a session lists, in the reflection reply or anywhere else in a hand-over
// turn, is an item here until the OWNER says yes or no to it. While one is open, or the reflection question is not answered, the session is not done:
// the dashboard does not show it as done (public/state.js), no "is done" push goes out, and nothing answers for the owner (manager.js, server.js).
// Items leave only by the owner's answer: a session that drops the list, or writes `no suggestions` later, clears nothing.
// State: <state>/suggestions.json, journal suggestions.jsonl.
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lastStatus } from './status-honesty.js';
import { aiSenderOf, promptSig } from './public/prompt-sig.js';

const unmark = (s) => String(s || '').replace(/[*`]+/g, '');
const HANDOVER = new Set(['done', 'ok', 'complete', 'completed', 'finished', 'shipped', 'needs-owner', 'needs-manager']);
export const DONE_WORDS = new Set(['done', 'ok', 'complete', 'completed', 'finished', 'shipped']);

// ---- reading a list ----
// A heading that opens a list of suggestions: its own words, or any "... improvements / suggestions ...:" line ("Improvements raised by the audit
// that no worker has taken on:", mcp-server-audit 2026-11-26). A heading about improvements already made is not one.
const HEAD_OWN = /^(?:(?:improvement |further |other |some |my )?suggestions?|suggested (?:improvements?|follow-?ups?|next steps?)|(?:possible |potential |further |optional )?improvements?(?: ideas)?|improvement ideas|ideas|(?:worth doing|smaller)(?:\s+(?:suggestions?|improvements?|ideas|ones|findings))?(?=\s*(?:\(|:|$)))\b[^:.!?]{0,80}(?::\s*(.*))?$/i;
const HEAD_ANY = /^[^.!?:]{0,100}\b(?:improvements?|suggestions?)\b[^.!?:]{0,100}:\s*$/i;
const MADE = /\b(?:shipped|built|made|applied|implemented|merged|delivered|deployed|released|done|fixed|added|release notes?|approved|answered|declined|not decided yet by)\b/i;
const NOT_YET = /\b(?:no (?:worker|one|body)|not (?:yet )?(?:built|done|taken|applied|implemented|made|fixed|started)|none (?:built|done|filed))\b/i;
const BULLET = /^\s*(?:[-*•○]|\(?\d{1,2}[.)])\s+(.+)$/;
const NUMBER = /^\s*\(?(\d{1,2})[.)]\s/;
const NOTHING = /^(?:none|nothing|n\/a|-|no suggestions?)\b[.\s]*$/i;
const END_HEAD = /^\s*(?:recommendation|should i\b|leftovers?\b|verification\b|status:|closing review)/i;

// Pure. `no suggestions` on a line of its own (the only answer that leaves a session done).
export const saysNoSuggestions = (text) => unmark(text).split('\n').some((l) => /^\s*(?:[-•>⏺●]\s*)?(?:\(b\)\s*|suggestions?\s*:\s*)?no suggestions\s*\.?\s*$/i.test(l));

// A pane's closing text can still hold tool calls and their output (a command that printed a list was read as the agent's own, 2026-11-26): only what
// follows the last one is the agent speaking. Same rule as stall.js agentTextStart; a collapsed call shows its mark in the middle of a line.
const TOOL_CALL = /^\s*(?:[⏺●•]\s+)?(?:Bash|Read|Edit|Write|MultiEdit|Update|Grep|Glob|Search|List|Task|Agent|WebFetch|WebSearch|TodoWrite|NotebookEdit|Skill|Monitor|mcp__[\w-]+)\(/;
export function agentWords(text) {
  const lines = String(text || '').split('\n');
  let k = -1;
  lines.forEach((l, i) => { if (TOOL_CALL.test(l) || l.includes('⎿')) k = i; });
  if (k < 0) return lines.join('\n');
  let i = k + 1;
  if (lines[k].includes('⎿')) while (i < lines.length && /^\s{4,}\S/.test(lines[i])) i++;
  return lines.slice(i).join('\n');
}

// Pure. text: a closing text -> [{ num, tier, text }] for every suggestion listed in it.
export function suggestionsIn(text) {
  const lines = unmark(agentWords(text)).split('\n');
  const out = [];
  let open = null;   // { tier, blank, base }
  const push = (num, t) => { const s = t.replace(/\s+/g, ' ').trim(); if (s && !NOTHING.test(s)) out.push({ num, tier: open.tier, text: s.slice(0, 300) }); };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], l = raw.trim().replace(/^[#>⏺●]+\s*/, '');
    const bullet = BULLET.exec(raw.replace(/^\s*[⏺●]\s+/, ''));
    if (!bullet) {
      const own = HEAD_OWN.exec(l), any = !own && HEAD_ANY.test(l);
      // a bare word ("Smaller") is a heading only when a list follows it
      if ((own && (l.includes(':') || /^(?:worth doing|smaller)\b/i.test(l))) || any) {
        if (MADE.test(l.split(':')[0]) && !NOT_YET.test(l)) { open = null; continue; }
        open = { tier: /^smaller\b/i.test(l) ? 'smaller' : /^worth/i.test(l) ? 'worth' : null, blank: false };
        const rest = own?.[1]?.trim();
        if (rest && !NOTHING.test(rest)) { if (BULLET.test(rest)) push(Number(NUMBER.exec(rest)?.[1]) || null, BULLET.exec(rest)[1]); else if (!/^[\d\s,and-]+\.?$/.test(rest)) push(null, rest); }
        continue;
      }
    }
    if (!open) continue;
    if (END_HEAD.test(l)) { open = null; continue; }
    if (bullet) { push(Number(NUMBER.exec(raw)?.[1]) || null, bullet[1]); open.blank = false; continue; }
    if (!l) { open.blank = true; continue; }
    if (!open.blank && /^\s{2,}\S/.test(raw) && out.length) { const last = out[out.length - 1]; last.text = `${last.text} ${l}`.slice(0, 300); continue; }   // a wrapped row
    open = null;
  }
  return out;
}

// ---- reading the owner's answer ----
const YES = new Set(['yes', 'y', 'do', 'build', 'implement', 'go', 'approve', 'approved', 'accept']);
const NO = new Set(['no', 'n', 'skip', 'drop', 'not', 'reject', 'rejected', 'dont', 'never']);
const ALL = new Set(['all', 'everything', 'both']);
const REST = new Set(['rest', 'others', 'other', 'remaining']);
const FILLER = new Set(['and', 'to', 'the', 'only', 'please', 'pls', 'it', 'of', 'item', 'items', 'suggestion', 'suggestions', 'number', 'numbers', 'but', 'for', 'ahead', 'them', 'those', 'these', 'also', 'thanks', 'then', 'a', 'with', 'is', 'ok', 'okay']);
// Pure. text: a message; open: the open item numbers -> { <n>: 'yes' | 'no' } or null when the message is not purely an answer (a new task, a question).
// "yes 1 3, no 2" · "1 yes, 2: no" · "do 1 and 3" · "no 4-5" · "yes all" · "no all" / "none" · "do 1, no to the rest" · "only 1"
export function answersOf(text, open = []) {
  const t = String(text || '').trim().toLowerCase().replace(/don['’]t/g, 'dont').replace(/(\d)\s*(?:-|–)\s*(?=\d)/g, '$1..').replace(/(?<!\.)\.(?!\.)/g, ' ');
  if (!t || t.length > 200 || /\?/.test(t) || !open.length) return null;
  const tok = t.split(/[\s,;:=+&/()#]+/).map((x) => x.replace(/!+$/, '')).filter(Boolean);
  if (!tok.length) return null;
  const numberFirst = /^\d/.test(tok[0]);   // "1 yes, 2 no"
  const only = tok.includes('only');   // "only 1": yes to those, no to the others
  const out = {};
  let polarity = only && !tok.some((w) => YES.has(w) || NO.has(w)) ? 'yes' : null, pending = [], restOf = null, all = null, sawNum = false;
  for (const w of tok) {
    const range = /^(\d{1,2})(?:\.\.(\d{1,2}))?$/.exec(w);
    if (range) {
      const a = Number(range[1]), b = Number(range[2] || range[1]);
      if (b < a || b - a > 30) return null;
      for (let n = a; n <= b; n++) { if (!open.includes(n)) return null; sawNum = true; if (numberFirst || !polarity) pending.push(n); else out[n] = polarity; }
    } else if (YES.has(w) || NO.has(w) || w === 'none') {
      const p = YES.has(w) ? 'yes' : 'no';
      if (w === 'none' && !polarity) all = 'no';
      if (pending.length) { for (const n of pending) out[n] = p; pending = []; if (!numberFirst) polarity = p; }
      else if (!(polarity === 'no' && w === 'do')) polarity = p;   // "do not" / "no, do not do 2"
    } else if (ALL.has(w)) all = polarity || 'yes';
    else if (REST.has(w)) restOf = polarity || 'no';
    else if (!FILLER.has(w)) return null;
  }
  if (pending.length) return null;   // a number with no yes or no
  if (restOf) { for (const n of open) out[n] ||= restOf; }
  else if (all && !sawNum) { for (const n of open) out[n] = all; }
  else if (!sawNum && polarity && tok.every((w) => YES.has(w) || NO.has(w) || FILLER.has(w))) { for (const n of open) out[n] = polarity; }   // a bare "yes" / "no" answers "should I do them?"
  if (only && sawNum && Object.values(out).includes('yes')) for (const n of open) out[n] ||= 'no';
  return Object.keys(out).length ? out : null;
}

// A prompt that is not a person typing: another session, a hook, a task notification, an attachment marker.
const NOT_TYPED = /^(?:<(?!pasted_content)|another claude session\b|stop hook feedback\b|\[(?:system|request|image|rules-watch)|caveat:|this session is being continued\b)/i;
// Pure. text: a prompt the session received; typed: [{ sig, by }] of everything this server typed into it -> true when a person typed it.
export const isOwnerTyped = (text, typed = []) => {
  const t = unpasted(text), sig = promptSig(t);
  // a short typed line matches only exactly: by prefix, a typed "no" would swallow the owner's "no all"
  return !!t && !NOT_TYPED.test(t) && !typed.some((x) => x.sig === sig) && !aiSenderOf(t, typed.filter((x) => String(x.sig).length >= 8));
};
const unpasted = (text) => String(text || '').replace(/<\/?pasted_content\b[^>]*>/g, ' ').trim();
// What this server typed into each session, however short (prompt-senders.js skips lines under 8 characters: a two-letter "no" must count here).
export function createTypedLog({ max = 200 } = {}) {
  const by = new Map();
  return {
    note(session, text) { if (typeof text !== 'string' || !text.trim()) return; const l = by.get(session) || []; l.push({ sig: promptSig(text), by: 'server' }); if (l.length > max) l.splice(0, l.length - max); by.set(session, l); },
    of: (session) => by.get(session) || [],
  };
}

const keyOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
const textSig = (t) => createHash('sha1').update(String(t || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
const openOf = (r) => (r?.items || []).filter((i) => !i.answer);

// ---- the record ----
// <state>/suggestions.json { since, s: { "<session>": { asked?: { at, sig }, clear?: { at, how }, items: [{ n, tier, text, at, answer?, by?, answeredAt?, via? }], missing? } } }
// active(): false when the reflection is switched off (nothing is held "not asked yet"; open items still are).
export function createSuggestions({ stateDir, now = Date.now, active = () => true, onResolved = () => {}, log = console } = {}) {
  const file = join(stateDir, 'suggestions.json');
  const journal = join(stateDir, 'suggestions.jsonl');
  let st;
  try { st = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log.error?.('[suggestions] read', e.message); st = null; }
  const fresh = !st;
  st ||= {};
  st.s ||= {};
  st.since ||= now();   // a done turn from before the rule is not held
  function save() {
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(st)); renameSync(`${file}.tmp`, file); }
    catch (e) { log.error?.('[suggestions] save', e.message); }
  }
  if (fresh) save();
  const note = (e) => { try { appendFileSync(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} };
  const rec = (name) => (Object.hasOwn(st.s, name) ? st.s[name] : null);
  const ensure = (name) => rec(name) || (st.s[name] = { items: [] });
  const resolved = (name, how) => { try { onResolved(name, how); } catch (e) { log.error?.('[suggestions] resolved', e.message); } };
  const seen = new Map();   // session -> sig of the last text read (the poll reads the same turn over and over)

  // A turn the session ended. text: its closing text; at: when it ended. -> { added: [items] }
  function observe(name, text, { at = null } = {}) {
    const ls = lastStatus(text);
    if (!ls || !HANDOVER.has(ls.kind) || (at && at < st.since)) return { added: [] };
    const sig = textSig(text);
    // later: this turn ended after the question was asked (a reply may repeat the asked text word for word)
    const q = rec(name)?.asked, later = q && at ? at > q.at : null;
    const key = `${sig}:${later}`;
    if (seen.get(name) === key) return { added: [] };
    seen.set(name, key);
    const listed = suggestionsIn(text);
    const prev = rec(name);
    const known = new Set((prev?.items || []).map((i) => keyOf(i.text)));
    const added = [];
    for (const it of listed) {
      const k = keyOf(it.text);
      if (known.has(k)) continue;
      known.add(k);
      const r = ensure(name), used = new Set(r.items.map((i) => i.n));
      let n = it.num && !used.has(it.num) ? it.num : 1;
      while (used.has(n)) n++;
      const item = { n, tier: it.tier, text: it.text, at: now() };
      r.items.push(item); added.push(item);
      delete r.clear;
    }
    const r = rec(name);
    if (added.length) { note({ session: name, listed: added.map((i) => ({ n: i.n, tier: i.tier, text: i.text.slice(0, 120) })), status: ls.kind }); save(); return { added }; }
    // the answer to the question: `no suggestions`, in a turn written after it was asked
    if (r?.asked && !r.clear && (later ?? sig !== r.asked.sig) && !listed.length && !openOf(r).length && saysNoSuggestions(text)) {
      r.clear = { at: now(), how: 'none' }; note({ session: name, reply: 'none', status: ls.kind }); save(); resolved(name, 'none');
    }
    return { added };
  }
  // The harness sent (or relayed) the reflection question after an accepted done; sig: the text of that done turn.
  function asked(name, text) {
    const r = ensure(name);
    for (const i of r.items) if (i.answer === 'yes') i.built = true;   // the question follows an accepted done: the approved work is finished
    r.asked = { at: now(), sig: textSig(text) };
    delete r.clear;
    seen.delete(name);
    note({ session: name, asked: true }); save();
  }
  // The OWNER's yes / no. answers: { n: 'yes'|'no' }. Callers are the only judges of who the owner is. -> { answered: [items], open: n, approved: [items] }
  function answer(name, answers, { via = 'dashboard' } = {}) {
    const r = rec(name);
    const answered = [];
    for (const i of openOf(r)) {
      const a = answers?.[i.n];
      if (a !== 'yes' && a !== 'no') continue;
      Object.assign(i, { answer: a, by: 'owner', via, answeredAt: now() });
      answered.push(i);
    }
    if (!answered.length) return { answered, open: openOf(r).length, approved: [] };
    note({ session: name, answered: answered.map((i) => ({ n: i.n, answer: i.answer })), via });
    // a new yes starts its work at once, together with the approved items not finished yet (so none drops out of the Done-when list)
    const unbuilt = r.items.filter((i) => i.answer === 'yes' && !i.built);
    const approved = answered.some((i) => i.answer === 'yes') ? unbuilt : [];
    if (!openOf(r).length) { if (unbuilt.length) delete r.clear; else r.clear = { at: now(), how: 'answered' }; }
    save();
    if (r.clear) resolved(name, 'answered');
    return { answered, open: openOf(r).length, approved };
  }
  // A message that reached the session and was typed by the owner: records it when it reads as an answer. -> answer() result or null
  function ownerMessage(name, text, opts) {
    const open = openOf(rec(name)).map((i) => i.n);
    const a = answersOf(unpasted(text), open);
    return a ? answer(name, a, opts) : null;
  }
  // -> null (nothing holds it) | { state: 'open', open: n, items } | { state: 'pending' } for a session whose latest turn is `text`
  function hold(name, text, { at = null } = {}) {
    const r = rec(name), open = openOf(r);
    if (open.length) return { state: 'open', open: open.length, items: open.map((i) => ({ n: i.n, tier: i.tier, text: i.text })) };
    const ls = lastStatus(text);
    if (!active() || !ls || !DONE_WORDS.has(ls.kind) || r?.clear || (at && at < st.since)) return null;
    return { state: 'pending' };
  }
  // a new round of work (approved suggestions): its done is asked again
  function newRound(name) { const r = rec(name); if (r) { delete r.clear; delete r.asked; delete r.missing; seen.delete(name); save(); } }
  // a new session took the name: its predecessor's record is journalled and dropped
  function drop(name) { const r = rec(name); seen.delete(name); if (!r) return; note({ session: name, dropped: true, open: openOf(r).map((i) => i.text.slice(0, 120)) }); delete st.s[name]; save(); }
  // the one nudge for a reply that answers neither way
  function claimMissing(name, text) { const r = rec(name); if (!r?.asked || r.clear || openOf(r).length || r.missing || textSig(text) === r.asked.sig) return false; r.missing = now(); save(); return true; }

  return { file, observe, asked, answer, ownerMessage, hold, newRound, drop, claimMissing, get: rec, openOf: (n) => openOf(rec(n)), awaiting: (n) => { const r = rec(n); return !!r && (openOf(r).length > 0 || (!!r.asked && !r.clear)); }, list: () => ({ since: st.since, sessions: st.s }) };
}
