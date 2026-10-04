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

// True when the body says the option is what the agent recommends ("(recommended)", "my recommendation").
const RECOMMENDED_RE = /\brecommend(?:ed|ation)\b/i;

// Extract the alternatives of an either-question. Returns an array (max 4) of either
//   { letter, label, recommended }  — "A (...)", "- A. ...", "A) ...", "(A) ..."
//   { phrase }                      — plain "X or Y?"
// [] when the text doesn't carry a structured choice (fewer than 2 alts).
export function parseAlternatives(text) {
  if (!text) return [];
  const t = String(text);
  const lines = t.split('\n');

  // 1) Lettered option lines: "- A. ...", "A. ...", "A) ...", "(A) ...".
  const alts = [];
  const seen = new Set();
  for (const l of lines) {
    const m = l.match(/^\s*(?:[-*\u2022]\s+)?\(?([A-D])(?:[.):\u2014\u2013-]|\s*\()\s*(.+)/);
    if (!m) continue;
    const letter = m[1];
    if (seen.has(letter)) continue;
    seen.add(letter);
    let body = m[2].trim();
    // "A (the agent's recommendation): do x" -> label "do x"; the parenthetical still counts for 'recommended'.
    const afterLetter = l.replace(/^\s*(?:[-*\u2022]\s+)?\(?[A-D]\s*/, '');
    const paren = /^\([^()]*\)\s*[:\u2014\u2013-]\s*(.+)$/.exec(afterLetter);
    if (paren) body = paren[1].trim();
    const full = body.replace(/\s*\([^()]*recommend[^()]*\)/ig, '').replace(/^[:\u2014\u2013-]\s*/, '').trim();
    body = full.split(/(?<=[a-z0-9)])\.\s/i)[0].trim().replace(/[.,;:\s]+$/, '');
    // what follows the label sentence is the agent's own description of the option (kept, <= 200 chars)
    const rest = full.slice(full.indexOf(body) + body.length).replace(/^[.,;:\s]+/, '').replace(/\s+/g, ' ').trim();
    alts.push({ letter, label: body, recommended: RECOMMENDED_RE.test(l), ...(rest ? { desc: trunc(rest, 200) } : {}) });
    if (alts.length >= 4) break;
  }
  if (alts.length >= 2) return alts;

  // 2) Inline "A (...) or B (...)" in any line.
  const inline = t.match(/\b([A-D])\s*\(([^)]+)\)\s*or\s*\b([A-D])\s*\(([^)]+)\)/);
  if (inline) {
    return [
      { letter: inline[1], label: inline[2].replace(/,?\s*(?:my |the agent's )?recommend(?:ed|ation)\s*/ig, '').trim(), recommended: RECOMMENDED_RE.test(inline[2]) },
      { letter: inline[3], label: inline[4].replace(/,?\s*(?:my |the agent's )?recommend(?:ed|ation)\s*/ig, '').trim(), recommended: RECOMMENDED_RE.test(inline[4]) },
    ];
  }

  // 3) Plain "X or Y?" — the words on each side of the "or" in the last question.
  // Only matches when both sides are single words and the right-hand side is the very last word
  // before the closing "?". This keeps "Do you want Redis or Postgres for the cache?" as
  // an unstructured either (the existing AI-button + suggestion path), while "Shall I use X or Y?"
  // becomes two phrase buttons.
  const q = lastQuestion(t);
  const orMatch = q.match(/\b(\S+?)\s+or\s+(\S+?)\s*\??\s*$/i);
  if (orMatch) {
    const clean = (x) => x.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const a = clean(orMatch[1]); const b = clean(orMatch[2]);
    if (a && b) return [{ phrase: a }, { phrase: b }];
  }
  return [];
}

// A short text matches the AI's proposal when the proposal starts with the option's letter
// (or letter + space/dot/parens) or when the normalised proposal contains the option's phrase.
function aiMatchesAlt(aiText, alt) {
  if (!aiText) return false;
  const ai = String(aiText);
  if (alt.letter) {
    const re = new RegExp(`^\\s*${alt.letter}(?:[.)\\]\\s:\\-]|$)`, 'i');
    if (re.test(ai)) return true;
  }
  if (alt.phrase) {
    const ph = alt.phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aiN = ai.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (ph && (aiN === ph || aiN.includes(ph))) return true;
  }
  return false;
}

// Pull the numbered decision questions out of a closing text.
//   "1. ... Do it?"   "2. Alert queue: A (...) or B (...)?"   ...
// Max 3, each ≤ 160 chars, in source order. Returns [] when there are < 2 such lines.
export function listQuestions(text) {
  if (!text) return [];
  const out = [];
  const lines = String(text).split('\n');
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    if (!/\?|\bdo it\b/i.test(body)) continue;
    const t = body.length > 160 ? `${body.slice(0, 159)}…` : body;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

// The id the AI reviewer and the buttons share for an option: 'yes' / 'no', 'A'.. for lettered, '1'.. for a menu.
const optionId = (b) => (b.id === 'yes' || b.id === 'no' ? b.id : /^o[A-Za-z0-9]$/.test(b.id) ? b.id.slice(1) : null);

// The option list handed to the AI reviewer so its option ids match the buttons: [{ id, label }] ([] for an open question).
export function reviewerOptions({ state, stall }) {
  const d = deriveButtons({ state, stall, triage: null });
  return d.buttons.map((b) => ({ b, id: optionId(b) })).filter((x) => x.id != null)
    .map(({ b, id }) => ({ id, label: String(b.label).replace(/^\s*[A-Z0-9]\s·\s/, '') }));
}

// Descriptions: the agent's own text first (already on the button), else the AI reviewer's summary for that option id.
function withDescriptions(buttons, triage) {
  const sums = new Map((triage?.ai?.options || []).map((o) => [String(o.id), o.summary]));
  for (const b of buttons) {
    const oid = optionId(b);
    if (oid == null) continue;
    if (!b.desc) { const sm = sums.get(oid); if (sm) b.desc = sm; }
    if (!b.desc) delete b.desc;
  }
}

export function deriveButtons({ state, stall, triage }) {
  const kind = questionKind({ state, stall });
  const topicForbidden = !!stall?.forbidden;
  const buttons = [];
  const ai = triage?.ai && triage.ai.proposed_reply ? triage.ai : null;
  if (kind === 'menu') {
    for (const o of stall.options) {
      buttons.push({ id: `o${o.n}`, label: `${o.n} · ${trunc(o.text)}`, key: String(o.n), primary: !!o.recommended, ...(o.recommended ? { rec: true } : {}), confirm: topicForbidden || !!o.forbidden });
    }
    withDescriptions(buttons, triage);
    return { kind, buttons, esc: true, keys: RAW_KEYS };
  }
  if (kind === 'yesno') {
    buttons.push({ id: 'yes', label: 'Yes', text: 'yes', primary: true, confirm: topicForbidden });
    buttons.push({ id: 'no', label: 'No', text: 'no' });
  } else {
    // either/or: structured alts get a button per alts; the AI pick is the matching one.
    // open: no structured choice; Claude's dim suggestion is the only thing worth offering.
    if (kind === 'either') {
      const alts = parseAlternatives(stall?.excerpt || stall?.question || '');
      if (alts.length >= 2) {
        const pickIdx = ai ? alts.findIndex((a) => aiMatchesAlt(ai.proposed_reply, a)) : -1;
        alts.forEach((a, i) => {
          if (a.letter) {
            const id = `o${a.letter}`;
            const label = `${a.letter} · ${trunc(a.label)}`;
            buttons.push({ id, label, text: a.letter, primary: a.recommended ? true : undefined, rec: a.recommended ? true : undefined, desc: a.desc, ai: i === pickIdx ? true : undefined, confirm: topicForbidden });
          } else {
            const id = `o${String.fromCharCode(65 + i)}`;
            const label = trunc(a.phrase, 44);
            buttons.push({ id, label, text: a.phrase, ai: i === pickIdx ? true : undefined, confirm: topicForbidden });
          }
        });
        // Either with alts: Claude's dim suggestion is NOT an answer (the owner is being asked
        // to pick). Hide it here; if it's the only thing on screen (no alts at all) it surfaces
        // as the muted "Claude suggests:" button in the open path below.
      } else {
        // either without parsed alts: today's behaviour — AI proposal + Claude's suggestion.
        if (ai) buttons.push({ id: 'ai', label: trunc(ai.proposed_reply, 44), text: ai.proposed_reply, primary: !triage.ai.owner_needed, ai: true, confirm: topicForbidden || !!ai.forbidden });
        if (stall?.suggestion && !(ai && sameReply(ai.proposed_reply, stall.suggestion))) {
          buttons.push({ id: 'sug', label: trunc(stall.suggestion, 44), text: stall.suggestion, muted: true, confirm: topicForbidden || !!stall.suggestionForbidden });
        }
      }
    } else {
      // open: no structured choice. The popup always offers at least 2 options before Reply.
      // With an AI proposal: that proposal is option 1 (highlighted), then "No — wait for me" as
      // option 2 (sends "No, wait — I'll answer this myself."); without one: "Yes, continue" and
      // "No — wait for me". Claude's dim suggestion, when distinct, comes after these as a 3rd
      // muted option, numbered like a menu row.
      if (ai) {
        buttons.push({ id: 'ai', label: trunc(ai.proposed_reply, 44), text: ai.proposed_reply, primary: !triage.ai.owner_needed, ai: true, confirm: topicForbidden || !!ai.forbidden });
        buttons.push({ id: 'wait', label: 'No — wait for me', text: "No, wait — I'll answer this myself.", confirm: topicForbidden });
      } else {
        buttons.push({ id: 'continue', label: 'Yes, continue', text: 'yes', primary: true, confirm: topicForbidden });
        buttons.push({ id: 'wait', label: 'No — wait for me', text: "No, wait — I'll answer this myself.", confirm: topicForbidden });
      }
      if (stall?.suggestion && !(ai && sameReply(ai.proposed_reply, stall.suggestion))) {
        buttons.push({ id: 'sug', label: `Claude suggests: ${trunc(stall.suggestion, 36)}`, text: stall.suggestion, muted: true, confirm: topicForbidden || !!stall.suggestionForbidden });
      }
    }
  }
  withDescriptions(buttons, triage);
  buttons.push({ id: 'reply', label: '✎ reply…', reply: true });
  return { kind, buttons, esc: state === 'waiting', keys: RAW_KEYS };
}
