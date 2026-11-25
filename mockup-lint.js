// Mockup lint (owner 2026-11-24/25: "stop making me review wordy mockups"). Pure: the HTML of a mockup -> the readability defects a
// non-technical owner would complain about, so mockups.js can bounce a failing mockup back to the posting session instead of the feed.
// Visible text only: <script>, <style>, comments, <head> and attributes (a `title` tooltip is fine) are ignored, and so is the text
// inside a tooltip (class/role/id word tooltip|tip|popover, role=tooltip). Rules (limits in LIMITS):
//   long-sentence  a sentence of more than 12 words          long-block   a text block over 140 characters (about 2 lines)
//   repeated       the same visible string (3+ words) twice  helper-text  an element whose class / role / id says hint, help, note,
//   wide-header    a <th> over 2 words or 18 characters        caption, description (also <caption>, <figcaption>), or text starting
//   too-many-words more than 250 visible words in total        "Note:", "Tip:", "This shows", "This page", "Here you"
// lintMockup(html) -> [{ rule, text, message }]; formatDefects(defects, max) -> one line per defect for the session.
// No parser dependency: a small tag tokenizer is enough for readability (not for validity). manager.json `mockupLint` live | dry | off.
export const LIMITS = { sentenceWords: 12, blockChars: 140, repeatWords: 3, thWords: 2, thChars: 18, totalWords: 250 };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'button', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul', 'label', 'select', 'textarea', 'option']);
const IMPLIED_END = new Set(['p', 'li', 'td', 'th', 'tr', 'option', 'dt', 'dd']);
const HELPER_WORD = /^(?:hint|hints|help|helper|note|notes|caption|description|explanation|explain|explainer)$/;
const TOOLTIP_WORD = /^(?:tooltip|tip|tips|popover)$/;
const HELPER_START = /^(?:note\s*:|tip\s*:|this shows\b|this page\b|here you\b)/i;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENT[e.toLowerCase()] ?? m;
});
const words = (s) => (String(s).match(/[^\s]+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w));
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const attr = (src, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(src); return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''; };
const wordsOf = (v) => String(v).toLowerCase().split(/[\s_-]+/).filter(Boolean);

// -> [{ text, helper, th }] visible text blocks, in document order
export function textBlocks(html) {
  let src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const blocks = []; const stack = []; let cur = '', curHelper = false, curTh = false;
  const flush = () => { const t = decode(cur).replace(/\s+/g, ' ').trim(); if (t) blocks.push({ text: t, helper: curHelper || HELPER_START.test(t), th: curTh }); cur = ''; curHelper = false; curTh = false; };
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g; let m;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      if (stack.some((s) => s.tooltip)) continue;
      if (m[4].trim()) { cur += m[4]; if (stack.some((s) => s.helper)) curHelper = true; if (stack.some((s) => s.tag === 'th')) curTh = true; } else cur += m[4];
      continue;
    }
    const closing = !!m[1], tag = m[2].toLowerCase(), a = m[3] || '';
    if (BLOCK.has(tag)) flush();
    if (closing) { const i = stack.map((s) => s.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
    if (VOID.has(tag) || /\/\s*$/.test(a)) continue;
    if (IMPLIED_END.has(tag) && stack.length && stack[stack.length - 1].tag === tag) stack.pop();
    const ws = [...wordsOf(attr(a, 'class')), ...wordsOf(attr(a, 'role')), ...wordsOf(attr(a, 'id'))];
    stack.push({ tag, helper: tag === 'caption' || tag === 'figcaption' || ws.some((w) => HELPER_WORD.test(w)), tooltip: ws.some((w) => TOOLTIP_WORD.test(w)) });
  }
  flush();
  return blocks;
}

export function lintMockup(html, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const blocks = textBlocks(html), out = [];
  const add = (rule, text, message) => out.push({ rule, text: clip(text), message });
  let total = 0; const seen = new Map();
  for (const b of blocks) {
    const n = words(b.text).length; total += n;
    if (b.th) {
      if (n > L.thWords || b.text.length > L.thChars) add('wide-header', b.text, `table header "${clip(b.text, 30)}": use 1-2 short words (max ${L.thWords} words, ${L.thChars} characters)`);
      continue;
    }
    if (b.helper) { add('helper-text', b.text, `helper text "${clip(b.text, 40)}": remove it, explanations go in a title tooltip only`); continue; }
    for (const s of b.text.split(/(?<=[.!?])\s+/)) { const k = words(s).length; if (k > L.sentenceWords) add('long-sentence', s, `sentence of ${k} words "${clip(s, 40)}": max ${L.sentenceWords}`); }
    if (b.text.length > L.blockChars) add('long-block', b.text, `text block of ${b.text.length} characters "${clip(b.text, 40)}": max ${L.blockChars} (about 2 lines)`);
    if (n >= L.repeatWords) { const k = b.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); seen.set(k, (seen.get(k) || 0) + 1); if (seen.get(k) === 2) add('repeated', b.text, `"${clip(b.text, 40)}" appears more than once: show it once`); }
  }
  if (total > L.totalWords) add('too-many-words', `${total} words`, `${total} visible words: max ${L.totalWords}, cut the rest`);
  return out;
}

// One line per defect, at most `max`, then "+N more".
export function formatDefects(defects, max = 8) {
  const lines = defects.slice(0, max).map((d, i) => `${i + 1}. [${d.rule}] ${d.message}`);
  if (defects.length > max) lines.push(`+${defects.length - max} more`);
  return lines.join('\n');
}
