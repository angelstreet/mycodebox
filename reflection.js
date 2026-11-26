// Reflection after an accepted done (owner, 2026-11-26): "when a task is done we should always have that reflection, if and only if the goal was met:
// any leftover, suggestion of improvements". The owner got a ranked list with a recommendation only after typing the question himself. goal-check.js
// asks it once, after a done is accepted with the goal met; nobody builds a suggestion unasked, and nothing answers the choice automatically
// (manager.js, owner-push.js use isReflectionAsk). Pure functions only. Rule text: AGENTS.md "Reflection after an accepted done".
import { lastStatus } from './status-honesty.js';

// The fixed words of the closing line that hands the choice over. Fixed, so a topic word in a suggestion never turns it into a merge or deploy ask.
export const ASK_WORDS = 'improvement suggestions above, nothing built';

// Pure. -> true when the last STATUS hands the choice of suggestions to the owner or the manager.
export function isReflectionAsk(text) {
  const st = lastStatus(text);
  return !!st && (st.kind === 'needs-owner' || st.kind === 'needs-manager') && /^improvement suggestions\b/i.test(st.text);
}

// Who picks: the owner for a chat of theirs (dashboard, a cbsession start from outside tmux, a Mac session, unknown); the manager for a worker
// that the manager, another session or an automation started (`startedBy`, session-meta.js).
const OWNER_STARTS = new Set(['', 'owner', 'dashboard', 'cbsession', 'unknown']);
export function audienceFor(name, startedBy) {
  if (String(name || '').startsWith('mac:')) return 'owner';
  return OWNER_STARTS.has(String(startedBy || '')) ? 'owner' : 'manager';
}

// One message, under the 2000 characters the Mac hook's answer carries.
export function reflectionQuestion(audience = 'owner') {
  const word = audience === 'manager' ? 'needs-manager' : 'needs-owner';
  return 'Reflection (your done is accepted, goal met; asked once): any leftover, any suggestion of improvement? Answer both, kept apart. '
    + '(a) Leftovers of THIS task (part of the goal unfinished or unverified, something you broke, a stale doc): your done is then not final. Fix them now, end `running` / `waiting` while they are open, and write the done line again when none is left. If there are none, write `Leftovers: none`. '
    + '(b) Improvement suggestions (beyond the goal, things you noticed on the way): build NONE of them and file none. Write the single line `no suggestions`, or `Suggestions:` then a short ranked list, best first: '
    + '`Worth doing:` with numbered items, `Smaller:` numbered on from there, one line each (what and why), then one `Recommendation: <which numbers and why>. Should I do them?` '
    + `End: with at least one item worth doing, \`STATUS: ${word}: ${ASK_WORDS} — should I do <numbers>?\` (${audience === 'manager' ? 'you were started as a worker: the manager picks' : 'the owner picks'}). `
    + 'Otherwise repeat your done line, with its Verification block, closing review and bugs field.';
}

// Pure. The reply's suggestion part -> { answer: 'none' } | { answer: 'list', worth: n, smaller: n } | { answer: null } (neither form found).
export function reflectionReplyOf(text) {
  const lines = String(text || '').replace(/[*`]+/g, '').split('\n');
  const count = { worth: 0, smaller: 0 };
  let part = null, heads = 0;
  for (const l of lines) {
    const t = l.trim().replace(/^#+\s*/, '');
    if (/^STATUS:/i.test(t)) break;
    const h = /^(worth doing|smaller)\b/i.exec(t);
    if (h) { part = /^w/i.test(h[1]) ? 'worth' : 'smaller'; heads++; continue; }
    if (/^recommendation\b/i.test(t)) { part = null; continue; }
    if (part && /^(?:\d+[.)]|[-•])\s+\S/.test(t) && !/^(?:\d+[.)]|[-•])\s+(?:none|nothing)\b/i.test(t)) count[part]++;
  }
  if (heads) return { answer: 'list', ...count };
  return { answer: lines.some((l) => /^\s*(?:[-•>]\s*)?no suggestions\b/i.test(l)) ? 'none' : null };
}
