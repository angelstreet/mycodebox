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

// Short tail words that mean "I just need a confirmation, the real context is in what I said before".
const SHORT_QUESTION_RE = /^(?:ok(?:ay)?|right|sound(?:s)? good|shall i|shall we|go|proceed|agreed|yeah|alright|sure)\??[.!?]?$/i;

// A meaningful question the popup can render. When the last sentence is content-free ("OK?", "Shall I?", ...),
// prepend the preceding sentences of the same paragraph until the text reaches a useful length (120-220 chars).
// Capped at 3 sentences total. Returns the original text trimmed when it is already long enough.
// Pure: no DOM, no I/O. Used where the popup's question text is built (ask-popup.js -> view()).
export function displayQuestion(text) {
  const src0 = String(text || '').replace(/\r/g, '').trim();
  if (!src0) return src0;
  // Split into sentences on . ! ? (keep the separator with the sentence). We use a simple heuristic
  // that respects quoted endings and avoids splitting on single-letter abbreviations.
  const sentences = [];
  const re = /[^.!?]+[.!?]+(?:["')\]]*)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(src0))) {
    const s = m[0].trim();
    if (s) sentences.push(s);
  }
  if (sentences.length === 0) return src0;
  const last = sentences[sentences.length - 1];
  const lastShort = last.length < 30 || SHORT_QUESTION_RE.test(last.replace(/[.!?]+$/, '').trim());
  if (!lastShort) {
    // Already a meaningful question — return as-is, trimmed.
    return src0;
  }
  // Otherwise, prepend preceding sentences (newest first, walking back) until we hit 120-220 chars
  // or have consumed 3 sentences total.
  let chosen = last;
  let used0 = 0;
  for (let i = sentences.length - 2; i >= 0 && used0 < 2; i--) {
    const prev = sentences[i];
    const candidate = `${prev} ${chosen}`.trim();
    if (candidate.length > 220) break;
    chosen = candidate;
    used0++;
    if (chosen.length >= 120) break;
  }
  // If we still haven't reached 120 chars (a single "OK?" with no preceding text), return as-is.
  return chosen;
}

// Reflow pane-wrapped text from a tmux pane. Hard-wrapped at the pane width (often 25-60 cols) and indented.
// Joins a line to the previous one when the previous line does not end a paragraph (no blank line between,
// the previous line does not end with ':', and the next line does not start a list item like '-', '*', '1.', '1)',
// 'A.' or a table '│'). Strips Claude Code UI lines ("done H:MM AM/PM", "✻ <Verb>ed for …", "● …" tool markers,
// spinner lines, "⎿" lines, box-drawing status bars). Pure function with no DOM / no I/O.
const TIME_RE = /^\s*done\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/i;
const BAKED_RE = /^\s*\u273b\b.*\u00b7\s+done\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/i;
const BAKED_RE2 = /^\s*\u273b\s+\S+ed\s+for\b/i;
const TOOL_DOT_RE = /^\s*\u25cf\b/;
const SPINNER_CHARS = '\u280b\u2819\u2838\u2834\u2826\u2827\u282b\u283a\u2839\u283f\u2807\u2806\u280e\u281e\u282e\u2836\u2837\u282f\u280f\u2801';
const SPINNER_RE = new RegExp(`^[\\s\\u2500-\\u257f${SPINNER_CHARS}\\u273b\\u25cf\\u25c6\\u26ab]*[\\u273b\\u25cf\\u25c6\\u26ab\\u280b-\\u28ff]`, 'u');
const BOX_DRAWING_RE = /^[\s\u2500-\u259f]+$/;
const PROMPT_RE = /^\s*\u276f\s*$/;
const LIST_PREFIX_RE = /^(\s*(?:[-*\u2022]\s+|\d+[.)]\s+|[A-Z][.)]\s+))/;
// Pure-noise lines (no meaningful content even after joining): horizontal-rule bars, "bypass permissions" /
// "esc to cancel" / "enter to select" hints. Table rows ('│ col │ col │') have content between the bars
// and must NOT be treated as noise.
const STATUS_NOISE_RE = /^\s*(?:\u2500{3,}|.*bypass permissions.*|.*esc to cancel.*|.*enter to select.*|.*\u25b7\u25b7.*)$/i;
const BORDER_LINE_RE = /^\s*[\u2500-\u257f]+[\s\u2500-\u257f]*$/;

function stripUiLine(line) {
  // A line that is only noise — drop it entirely. This includes:
  //   "done H:MM AM/PM", "✻ Verb ed for …", "● tool call (…)" markers, spinner-only lines, ⎿ lines, box-drawing bars.
  const t = line.replace(/\s+$/, '');
  if (!t.trim()) return false; // empty / blank lines are paragraph breaks, handled elsewhere
  if (TIME_RE.test(t)) return true;
  if (BAKED_RE.test(t) || BAKED_RE2.test(t)) return true;
  if (TOOL_DOT_RE.test(t)) return true;
  if (SPINNER_RE.test(t)) return true;
  if (BOX_DRAWING_RE.test(t) && t.replace(/[\s\u2500-\u259f]/g, '') === '') return true;
  if (BORDER_LINE_RE.test(t)) return true;
  if (PROMPT_RE.test(t)) return true;
  if (STATUS_NOISE_RE.test(t)) return true;
  // ⎿ tool-result markers and Claude Code "pasted text" markers (also a box-drawing char)
  if (/^\s*\u23bf/.test(t)) return true;
  return false;
}

// A "hard" paragraph ender. Joining across these always starts a new paragraph:
//   ':'  — a multi-line field label (e.g. "Open decisions:" / "Alert queue:")
//   '?'  — a question that wraps onto the next line is a new question, not a continuation
//   '!'  — same for an exclamation
//   '│'  — end of a table row
const HARD_END_RE = /[?:!\u2502](?:["')\]]?)\s*$/;
const LIST_PREFIX_RE2 = /^\s*(?:[-*\u2022]\s+|\d+[.)]\s+|[A-Z][.)]\s+)/;
const TABLE_PREFIX_RE = /^\s*\u2502/;

export function reflowPane(text) {
  const src = String(text || '').replace(/\r/g, '');
  if (!src.trim()) return '';
  // Drop Claude Code UI noise lines up front (status bars, "done H:MM", tool markers, spinners).
  const lines = src.split('\n').filter((l) => !stripUiLine(l.replace(/\s+$/, '')));
  const out = [];
  let buf = '';
  let prevType = null;   // 'prose' | 'list' | 'table' — what the current buf is.
  const flush = () => {
    if (!buf) return;
    out.push(buf.replace(/\s+/g, ' ').trimEnd());
    buf = '';
  };
  for (const raw of lines) {
    if (!raw.trim()) { flush(); prevType = null; out.push(''); continue; }
    const deindented = raw.replace(/^\s+/, '');
    const isList = LIST_PREFIX_RE2.test(raw);
    const isTable = TABLE_PREFIX_RE.test(raw);
    // A list item / table row always starts a new paragraph: flush whatever was buffered.
    if (isList || isTable) {
      flush();
      buf = deindented;
      prevType = isList ? 'list' : 'table';
      continue;
    }
    if (buf) {
      // A list item or table row swallows the next non-blank, non-list / non-table line as its
      // own continuation — UNLESS the next line is clearly a new sentence (capital letter, or ends
      // with '.', '!', '?'). In that case the list is over and a new paragraph / question begins.
      if (prevType === 'list') {
        const startsCapital = /^[A-Z]/.test(deindented);
        const endsSentence = /[.!?]$/.test(deindented);
        if (startsCapital || endsSentence) {
          flush();
          buf = deindented;
          prevType = 'prose';
        } else {
          buf = `${buf.trimEnd()} ${deindented}`;
        }
        continue;
      }
      if (prevType === 'table') {
        flush();
        buf = deindented;
        prevType = 'prose';
        continue;
      }
      // Prose: join unless the previous line ends a hard paragraph (':', '?', '!', '│').
      // A trailing '.' or ',' is soft — the pane may have wrapped mid-sentence (or the noise we
      // stripped was between two halves of the same sentence, as in the real-world sample).
      const trimmed = buf.trimEnd();
      if (HARD_END_RE.test(trimmed)) {
        flush();
        buf = deindented;
        prevType = 'prose';
        continue;
      }
      buf = `${trimmed} ${deindented}`;
      continue;
    }
    buf = deindented;
    prevType = 'prose';
  }
  flush();
  // Collapse 3+ blank lines to 2; trim leading / trailing blanks.
  const collapsed = [];
  let blankRun = 0;
  for (const l of out) {
    if (!l) { blankRun++; if (blankRun > 2) continue; collapsed.push(l); continue; }
    blankRun = 0; collapsed.push(l);
  }
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n');
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
