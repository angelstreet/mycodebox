// Clickable URLs in the terminal cards. A pane snapshot is hard-wrapped by the agent (and by table cells: the URL
// continues in the same column on the next row, before the cell's closing "│"), so a URL can span several rows.
// urlChains() follows those wraps; the terminal turns each segment into a link to the whole URL.
const URL_AT = /https?:\/\/[^\s│┃|<>"'`]+/g;
const TRAIL = /[.,;:!?)\]}>]+$/;
const BORDER = /^\s*[│┃|]/;
const MAX_ROWS = 12;
const WRAP_SLACK = 8;

// "report (https://...)": the agent prints a link as a label plus the URL in parentheses. In a table cell the label sits on
// the row above, in the URL's column. Returns the label's segment {row, x1, x2}, or null.
function labelOf(lines, row, line, tok, urlAt) {
  if (line[tok] !== '(' || urlAt !== tok + 1) return null;
  const before = /([^\s│┃|]+)[ \t]+$/.exec(line.slice(0, tok));
  if (before) return { row, x1: before.index, x2: before.index + before[1].length };
  const sameCell = /[│┃|]\s*$/.test(line.slice(0, tok));   // the "(" opens its cell (other columns may hold text): the label is above
  const prev = lines[row - 1];
  if (!sameCell || prev == null) return null;
  const w = /^[^\s│┃|()]+/.exec(prev.slice(tok));
  if (!w || (tok > 0 && !/[\s│┃|]/.test(prev[tok - 1] || ' '))) return null;
  return { row: row - 1, x1: tok, x2: tok + w[0].length };
}

// lines: array of row strings (0-based). Chains that START on `row`: [{ url, segs: [{ row, x1, x2 }] }] with x1 inclusive, x2 exclusive (0-based cells).
export function urlChains(lines, row, cols) {
  const line = lines[row] || '';
  const chains = [];
  for (const m of line.matchAll(URL_AT)) {
    const segs = [{ row, x1: m.index, x2: m.index + m[0].length }];
    let text = m[0];
    // a segment is "full" when it ends at the cell border (" │") or near the right edge of the terminal: the agent wraps a few
    // cells short of the edge (a margin, or a hanging indent under a tool result), so the edge itself is too strict
    const full = (l, x2) => BORDER.test(l.slice(x2)) || (x2 >= cols - WRAP_SLACK && !l.slice(x2).trim());
    let tok = m.index;   // the wrapped continuation starts under the token's first cell, e.g. under the "(" before the URL
    while (tok > 0 && !/[\s│┃|]/.test(line[tok - 1])) tok--;
    let cur = row, curLine = line, end = m.index + m[0].length, col = tok;
    while (full(curLine, end) && cur - row < MAX_ROWS) {
      const next = lines[cur + 1];
      if (next == null) break;
      const inTable = BORDER.test(curLine.slice(end));
      const start = inTable ? col : next.search(/\S/);
      if (start < 0 || (!inTable && start > 6)) break;
      const seg = /^[^\s│┃|<>"'`]+/.exec(next.slice(start));
      if (!seg || /^https?:\/\//.test(seg[0])) break;
      segs.push({ row: cur + 1, x1: start, x2: start + seg[0].length });
      text += seg[0];
      cur += 1; curLine = next; end = start + seg[0].length; col = start;
    }
    const url = text.replace(TRAIL, '');
    const cut = text.length - url.length;
    if (cut) {   // trim the trailing punctuation off the last segment(s)
      let left = cut;
      while (left > 0 && segs.length) {
        const last = segs[segs.length - 1], len = last.x2 - last.x1;
        if (len <= left) { left -= len; segs.pop(); } else { last.x2 -= left; left = 0; }
      }
    }
    if (url.length > 8 && segs.length) chains.push({ url, segs, label: labelOf(lines, row, line, tok, m.index) });
  }
  return chains;
}

// xterm link provider over a Terminal's active buffer. open(url) is called on click.
export function registerUrlLinks(term, open) {
  term.registerLinkProvider({
    provideLinks(y, cb) {   // y is 1-based buffer row
      const buf = term.buffer.active;
      const first = Math.max(0, y - 1 - MAX_ROWS);
      const lines = [];
      for (let i = first; i <= y - 1 + MAX_ROWS && i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) || '');
      const out = [];
      for (let r = 0; r <= Math.min(y - first, lines.length - 1); r++) {
        for (const c of urlChains(lines, r, term.cols)) {
          for (const s of [...c.segs, ...(c.label ? [c.label] : [])]) {
            if (s.row + first !== y - 1) continue;
            out.push({ text: c.url, range: { start: { x: s.x1 + 1, y }, end: { x: s.x2, y } }, activate: (_e, t) => open(t) });
          }
        }
      }
      cb(out.length ? out : undefined);
    },
  });
}
