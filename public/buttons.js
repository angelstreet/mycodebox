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
    const s = m[0].replace(/\s+/g, ' ').trim();
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
const TOOL_DOT_RE = /^\s*\u25cf\b/;   // (stall.js closingLines already strips the agent's own leading bullet, so a surviving '●' line is a tool marker)
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
  let listIndent = 0;
  let listNumbered = false;
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
      listIndent = raw.length - raw.trimStart().length;
      listNumbered = /^\s*\d+[.)]\s/.test(raw);   // a numbered item wraps on any word (even a capital); only its '.', '?' ends it
      continue;
    }
    if (buf) {
      // A list item or table row swallows the next non-blank, non-list / non-table line as its
      // own continuation — UNLESS the next line is clearly a new sentence (capital letter, or ends
      // with '.', '!', '?'). In that case the list is over and a new paragraph / question begins.
      if (prevType === 'list') {
        // A wrapped list item continues on a more-indented line. A flush-left line (same indent as the marker) is a new
        // paragraph when the item ended a sentence ('.', '?', '!', ':') or the line starts with a capital; else it is the wrap.
        const ind = raw.length - raw.trimStart().length;
        if (ind <= listIndent && (/[.?!:]["')\]]?$/.test(buf.trimEnd()) || (!listNumbered && /^[A-Z]/.test(deindented)))) {
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

// ---------- inline numbered options: "Where from: (1) each server *(recommended)*, (2) central, or (3) both?" ----------
// The agent's pick is flagged "*(recommended)*", "(recommended)" or "my recommendation"; the flag never makes an option selected.
const REC_TAG_RE = /\s*\*?\(\s*(?:my |the agent's )?recommend(?:ed|ation)\s*\)\*?|\s*,?\s*\bmy recommendation\b/gi;
const MULTI_REC_RE = /\brecommend(?:ed|ation)\b/i;
const cleanOpt = (t) => String(t).replace(REC_TAG_RE, '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim()
  .replace(/[\s,;]+(?:or|and)?\s*$/i, '').replace(/[\s,;]+$/, '').replace(/\?+$/, '').trim();
export const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// "(1) a, (2) b or (3) c" -> { label: text before "(1)", options: [{ n, text, recommended }] }; null when < 2 options.
// The numbers must run 1, 2, 3 ... in order, so "(2)" in prose or "(see 1)" is not an option.
export function parseInlineOptions(text) {
  const t = String(text || '').replace(/\*\*/g, '');
  const marks = [];
  const re = /\((\d{1,2})\)/g;
  let m;
  while ((m = re.exec(t))) if (Number(m[1]) === marks.length + 1) marks.push({ n: marks.length + 1, start: m.index, end: m.index + m[0].length });
  if (marks.length < 2) return null;
  const options = marks.map((k, i) => {
    const seg = t.slice(k.end, i + 1 < marks.length ? marks[i + 1].start : t.length);
    return { n: k.n, text: cleanOpt(seg), recommended: MULTI_REC_RE.test(seg) };
  }).filter((o) => o.text);
  if (options.length < 2) return null;
  const label = t.slice(0, marks[0].start).replace(/^\s*\d+[.)]\s+/, '').replace(/[\s:\u2014\u2013-]+$/, '').replace(/\s+/g, ' ').trim();
  return { label, options };
}

// The multi-question form: >= 2 numbered questions ("1. Where ...: (1) a, (2) b?") that each carry parsed options.
// -> [{ n, label, options: [{ n, text, recommended }] }] in source order, or null. Works on pane-wrapped text (reflowed first).
export function parseQuestionForm(text) {
  if (!text) return null;
  const qs = [];
  const seen = new Set();
  for (const line of reflowPane(text).split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (!m || seen.has(m[1])) continue;
    const parsed = parseInlineOptions(m[2]);
    if (!parsed) continue;
    seen.add(m[1]);
    qs.push({ n: m[1], label: parsed.label || `Question ${m[1]}`, options: parsed.options });
    if (qs.length >= 12) break;
  }
  return qs.length >= 2 ? qs : null;
}

// picks {"1":"1","2":"3"} -> "1: 1, 2: 3" (question order); unpicked questions are left out.
export function formatMultiAnswer(picks, questions) {
  const order = questions ? questions.map((q) => String(q.n)) : Object.keys(picks || {}).sort((a, b) => Number(a) - Number(b));
  return order.filter((n) => picks && picks[n] != null && picks[n] !== '').map((n) => `${n}: ${picks[n]}`).join(', ');
}

// "1: 1, 2: 3" / "1=1 2=3" / "1) 1" -> { "1":"1", "2":"3" } (the AI reviewer's per-question picks as a reply string); {} when none.
export function parseMultiReply(text) {
  const out = {};
  const re = /(?:^|[\s,;])(\d{1,2})\s*[:=)\-]\s*(?:option\s+)?(\d{1,2})(?=$|[\s,;.])/gi;
  let m;
  while ((m = re.exec(String(text || '')))) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
}

// Claude Code's dim input-box suggestion is a GUESS at what the owner types next, never an answer. When it only
// repeats a parsed answer set ("1 1 1 1 1 1 1, go ahead", "yes", "2") the popup ignores it.
export function suggestionIsAnswer(suggestion, questions, buttons = []) {
  const sg = String(suggestion || '').trim();
  if (!sg) return true;
  if (/^[\d\s,:;=.)-]+(?:,?\s*(?:go ahead|ok(?:ay)?|please))?\s*[.!]?$/i.test(sg)) return true;   // digits only: an answer set
  if (questions && parseMultiReply(sg) && Object.keys(parseMultiReply(sg)).length >= 2) return true;
  return buttons.some((b) => b.text && sameReply(b.text, sg)) || buttons.some((b) => b.label && sameReply(String(b.label).replace(/^\s*[A-Z0-9]\s\u00b7\s/, ''), sg));
}

// 'menu' (a live numbered menu), 'yesno', 'either' (an or-question), 'open'.
export function questionKind({ state, stall }) {
  const opts = stall?.options || [];
  if (state === 'waiting' && opts.length >= 2) return 'menu';
  const q = lastQuestion(stall?.question);
  if (/\bor\b/i.test(q) || parseInlineOptions(q) || /^which\b|\bwhich (?:one|option|approach)\b/i.test(q)) return 'either';
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

  // 0) Inline numbered options "(1) a, (2) b or (3) c" in the last question: options 1..N, "recommended" tagged.
  const inl = parseInlineOptions(lastQuestion(t));
  if (inl) return inl.options.slice(0, 4).map((o) => ({ letter: String(o.n), label: clip(o.text, 60), recommended: o.recommended, ...(o.text.length > 60 ? { desc: clip(o.text, 200) } : {}) }));

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

  // 3) Plain "X or Y?" — two shapes:
  //    a) single-word operands right before the closing "?" (existing behaviour), and
  //    b) multi-word verb phrases when there is a recognised lead-in at the start of the question
  //       ("Want me to X, or Y?", "Should I X or Y?", "Shall I X, or Y?", "Do you want me to X,
  //       or Y?", "Would you like me to X, or Y?") or a comma right before "or" ("Run tests, or
  //       not?"). The lead-in is stripped from X and both sides are capitalised; Y keeps its own
  //       verb. Plain "do you want X"/"would you like X" without "me to" is NOT a lead-in —
  // "Do you want X, or will you Y?" stays as the existing AI-button + wait path (two full clauses).
  const q = lastQuestion(t);
  const LEAD_INS = /^(?:do you want me to|would you like me to|want me to|should i|shall i)\b/i;
  // Bare "do you want" / "would you like" without "me to" is NOT a lead-in — those are full-clause
  // questions ("Do you want to deploy once the run ends, or will you run it yourself?") and stay
  // on the existing AI-button + wait path. Use a negative lookahead so "Do you want me to X,
  // or Y?" / "Would you like me to X, or Y?" still match LEAD_INS and split.
  const INTERROG = /^(?:do you want|would you like)(?!\s+me\s+to)\b/i;
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

  // a) Single-word operands.
  const orMatch = q.match(/\b(\S+?)\s+or\s+(\S+?)\s*\??\s*$/i);
  if (orMatch) {
    const aRaw = orMatch[1]; const bRaw = orMatch[2];
    const a = aRaw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const b = bRaw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (a && b) {
      // If either side ends with a comma, the simple regex captured only the last token before
      // "or": defer to the multi-word path below so the full verb phrase is kept
      // ("Run tests, or not?" -> "Run tests", not "tests").
      if (!/,\s*$/.test(aRaw) && !/,\s*$/.test(bRaw)) {
        if (LEAD_INS.test(q)) return [{ phrase: cap(a) }, { phrase: cap(b) }];
        return [{ phrase: a }, { phrase: b }];
      }
    }
  }

  // b) Multi-word verb phrases. Only act when there is a lead-in or a comma right before "or"
  // AND the question doesn't start with the bare "do you want" / "would you like" interrogator
  // (those are full-clause questions, not verb-phrase slots).
  const verbMatch = q.match(/^(.+?)\s+or\s+(.+?)\s*\??\s*$/i);
  if (verbMatch) {
    const xRaw = verbMatch[1];
    const yRaw = verbMatch[2];
    const leadMatch = xRaw.match(LEAD_INS);
    const hasComma = /,\s*$/.test(xRaw);
    if ((leadMatch || hasComma) && !INTERROG.test(xRaw)) {
      let x = xRaw.trim();
      if (leadMatch) x = x.slice(leadMatch[0].length).trim();
      x = x.replace(/^to\s+/, '').trim().replace(/[,;:.!?]+$/, '').trim();
      const y = yRaw.trim().replace(/[,;:.!?]+$/, '').trim();
      const xCap = cap(x);
      const yCap = cap(y);
      if (xCap && yCap) return [{ phrase: xCap }, { phrase: yCap }];
    }
  }
  return [];
}

// A short text matches the AI's proposal when the proposal starts with the option's letter
// (or letter + space/dot/parens), when the normalised proposal contains the option's phrase, or
// when >= 2 significant words (>= 3 chars, not stop words) from the option appear in the proposal —
// this last path catches the common reworded-verb-phrase case ("Leave it for now" -> "Leave the
// worktree as is for now, thanks."), where the AI keeps the meaning but not the wording.
const MATCH_STOP = new Set('the a an and or but if is are was were be been being have has had do does did will would should shall may might must can could to for of in on at by with as it i you me we they he she this that these those there here when where why how all any both each few many more most other some such no not only own same so than too very just'.split(/\s+/));
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
    const phWords = ph.split(/\s+/).filter((w) => w.length >= 3 && !MATCH_STOP.has(w));
    if (phWords.length >= 2) {
      const aiWords = new Set(aiN.split(/\s+/).filter((w) => w.length >= 3 && !MATCH_STOP.has(w)));
      let shared = 0;
      for (const w of phWords) if (aiWords.has(w)) shared++;
      if (shared >= 2) return true;
    }
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

// Claude's dim input-box suggestion is shown as a muted "Claude suggests: ..." line with its own "use" link, never as an
// option. Dropped when it repeats an answer the buttons already offer (or the AI's proposal) or is just an answer set.
function suggestionOf(stall, buttons, ai, topicForbidden) {
  const sg = String(stall?.suggestion || '').trim();
  if (!sg || (ai && sameReply(ai.proposed_reply, sg)) || suggestionIsAnswer(sg, null, buttons)) return null;
  return { text: sg, confirm: topicForbidden || !!stall?.suggestionForbidden };
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
    return { kind, buttons, esc: true, keys: RAW_KEYS, suggestion: null };
  }
  if (kind === 'yesno') {
    buttons.push({ id: 'yes', label: 'Yes', text: 'yes', primary: true, confirm: topicForbidden });
    buttons.push({ id: 'no', label: 'No', text: 'no' });
  } else {
    // either/or: structured alts get a button per alts; the AI pick is the matching one.
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
      } else {
        // either without parsed alts: the AI's proposal (when any), then the two generic answers, so there are always >= 3 with Other.
        if (ai) buttons.push({ id: 'ai', label: trunc(ai.proposed_reply, 44), text: ai.proposed_reply, primary: !triage.ai.owner_needed, ai: true, confirm: topicForbidden || !!ai.forbidden });
        else buttons.push({ id: 'continue', label: 'Yes, continue', text: 'yes', primary: true, confirm: topicForbidden });
        buttons.push({ id: 'wait', label: 'No \u2014 wait for me', text: "No, wait \u2014 I'll answer this myself.", confirm: topicForbidden });
      }
    } else {
      // open: no structured choice. With an AI proposal: that proposal is option 1 (highlighted), then "No \u2014 wait for me"
      // as option 2; without one: "Yes, continue" and "No \u2014 wait for me". Then Other / Reply\u2026.
      if (ai) {
        buttons.push({ id: 'ai', label: trunc(ai.proposed_reply, 44), text: ai.proposed_reply, primary: !triage.ai.owner_needed, ai: true, confirm: topicForbidden || !!ai.forbidden });
        buttons.push({ id: 'wait', label: 'No \u2014 wait for me', text: "No, wait \u2014 I'll answer this myself.", confirm: topicForbidden });
      } else {
        buttons.push({ id: 'continue', label: 'Yes, continue', text: 'yes', primary: true, confirm: topicForbidden });
        buttons.push({ id: 'wait', label: 'No \u2014 wait for me', text: "No, wait \u2014 I'll answer this myself.", confirm: topicForbidden });
      }
    }
  }
  withDescriptions(buttons, triage);
  buttons.push({ id: 'reply', label: '✎ reply…', reply: true });
  return { kind, buttons, esc: state === 'waiting', keys: RAW_KEYS, suggestion: suggestionOf(stall, buttons, ai, topicForbidden) };
}
