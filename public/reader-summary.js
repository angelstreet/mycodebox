// The owner's summary of a turn (owner 2026-11-28, docs/READER-SUMMARY.md): a line `Summary:` and then 1 to 10 short plain lines, written
// by the agent before `Verification:` and the STATUS line. Pure, no DOM: the server (/api/reply, done-check.js) and the reader share it.
export const SUMMARY_MAX_LINES = 10, SUMMARY_MAX_CHARS = 160;

const GLYPH = /^\s*[⏺●•]\s+/;
const HEADER = /^[*_#\s]*summary[*_]*\s*:[*_]*\s*$/i;            // `Summary:`, `**Summary:**`, `**Summary**:`
const END = /^[*_#\W]*(?:verification|status)\s*:/i;          // the checks or the STATUS line end the block
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;
const indentOf = (l) => /^\s*/.exec(l)[0].length;

// -> { lines, tooLong, lineCount } for the LAST `Summary:` block in `text`, or null when there is none. A pane row indented deeper than the
// block's first line and not a new bullet is the wrapped tail of the line above (a narrow tmux pane), so it is joined, not counted.
export function summaryOf(text) {
  const all = String(text || '').split('\n').map((l) => l.replace(GLYPH, (m) => ' '.repeat(m.length)).replace(/\s+$/, ''));
  let at = -1;
  all.forEach((l, i) => { if (HEADER.test(l)) at = i; });
  if (at < 0) return null;
  const out = [];
  let base = -1;
  for (let i = at + 1; i < all.length; i++) {
    const l = all[i], t = l.trim();
    if (!t) {   // a blank line ends the block unless a list goes on after it
      const next = all.slice(i + 1).find((x) => x.trim());
      if (out.length && next !== undefined && BULLET.test(next.trim()) && !END.test(next.trim())) continue;
      if (out.length) break;
      continue;
    }
    if (END.test(t) || HEADER.test(l)) break;
    if (base < 0) base = indentOf(l);
    if (out.length && indentOf(l) > base && !BULLET.test(t)) { out[out.length - 1] += ' ' + t; continue; }
    out.push(t);
  }
  const lines = out.map((l) => l.replace(BULLET, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { lines, lineCount: lines.length, tooLong: lines.length > SUMMARY_MAX_LINES || lines.some((l) => l.length > SUMMARY_MAX_CHARS) };
}

// What the play button reads when a summary exists: its lines as sentences, '' otherwise.
export function spokenSummaryOf(lines) {
  if (!Array.isArray(lines) || !lines.length) return '';
  return lines.map((l) => String(l).replace(/[*`]+/g, '').trim()).filter(Boolean).map((l) => /[.!?:]$/.test(l) ? l : l + '.').join(' ');
}
