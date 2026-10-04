// Answer buttons that match the question a stopped session asks (TASK-44 phase 9). Pure: no DOM, no I/O.
//   deriveButtons({ state, stall, triage }) -> { kind, buttons: [...], esc: bool, keys: [...] }
// A button is { id, label, key?|text?, primary?, confirm?, ai? }. `key` is a tmux key (a live menu's option number),
// `text` is typed into the session followed by Enter. `confirm` = the reply touches a forbidden topic (deploy, push,
// delete, secrets, money, customer, ...): the UI needs a second tap before it sends it.

export const RAW_KEYS = [
  { id: 'k1', label: '1 · yes', key: '1', primary: true }, { id: 'k2', label: '2', key: '2' }, { id: 'k3', label: '3', key: '3' },
  { id: 'kenter', label: '⏎', key: 'Enter' }, { id: 'kesc', label: 'esc', key: 'Escape' },
];

const YESNO_START = /^(?:do|does|did|is|are|was|were|can|could|should|shall|will|would|may|might|have|has|had|want|ok(?:ay)?)\b/i;

// The last question sentence of the stop's text ("... Shall I continue?"), or the last paragraph.
export function lastQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const qs = t.match(/[^.!?]*\?(?=\s|$|["')\]])/g);
  return (qs ? qs[qs.length - 1] : t).trim();
}

// 'menu' (a live numbered menu), 'yesno', 'either' (an or-question), 'open'.
export function questionKind({ state, stall }) {
  const opts = stall?.options || [];
  if (state === 'waiting' && opts.length >= 2) return 'menu';
  const q = lastQuestion(stall?.question);
  if (/\bor\b/i.test(q) || /^which\b|\bwhich (?:one|option|approach)\b/i.test(q)) return 'either';
  if (YESNO_START.test(q) && /\?$/.test(q)) return 'yesno';
  return 'open';
}

// Does the stop need the owner (so answer buttons make sense)? Plain done / background work / a pending auto answer: no.
export function needsOwner(st) {
  const s = st?.stall;
  if (!s || st.auto) return false;
  if (s.case === 'background_wait') return false;
  if (s.case === 'done') return /\?/.test(s.question || '');
  return true;
}

const trunc = (t, n = 30) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sameReply = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function deriveButtons({ state, stall, triage }) {
  const kind = questionKind({ state, stall });
  const topicForbidden = !!stall?.forbidden;
  const buttons = [];
  const ai = triage?.ai && triage.ai.proposed_reply ? triage.ai : null;
  if (kind === 'menu') {
    for (const o of stall.options) {
      buttons.push({ id: `o${o.n}`, label: `${o.n} · ${trunc(o.text)}`, key: String(o.n), primary: !!o.recommended, confirm: topicForbidden || !!o.forbidden });
    }
    return { kind, buttons, esc: true, keys: RAW_KEYS };
  }
  if (kind === 'yesno') {
    buttons.push({ id: 'yes', label: 'Yes', text: 'yes', primary: true, confirm: topicForbidden });
    buttons.push({ id: 'no', label: 'No', text: 'no' });
  } else {
    // either/or or open: the AI's proposal first, then Claude's own dim suggestion
    if (ai) buttons.push({ id: 'ai', label: trunc(ai.proposed_reply, 44), text: ai.proposed_reply, primary: !triage.ai.owner_needed, ai: true, confirm: topicForbidden || !!ai.forbidden });
    if (stall?.suggestion && !(ai && sameReply(ai.proposed_reply, stall.suggestion))) {
      buttons.push({ id: 'sug', label: trunc(stall.suggestion, 44), text: stall.suggestion, confirm: topicForbidden || !!stall.suggestionForbidden });
    }
  }
  buttons.push({ id: 'reply', label: '✎ reply…', reply: true });
  return { kind, buttons, esc: state === 'waiting', keys: RAW_KEYS };
}
