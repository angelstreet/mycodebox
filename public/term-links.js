// Clickable URLs in the terminal cards. A pane snapshot is hard-wrapped by the agent (and by table cells: the URL
// continues in the same column on the next row, before the cell's closing "│"), so a URL can span several rows.
// urlChains() follows those wraps; the terminal turns each segment into a link to the whole URL.
const URL_AT = /https?:\/\/[^\s│┃|<>"'`]+/g;
const TRAIL = /[.,;:!?)\]}>]+$/;
const BORDER = /^\s*[│┃|]/;
const MAX_ROWS = 12;

// lines: array of row strings (0-based). Chains that START on `row`: [{ url, segs: [{ row, x1, x2 }] }] with x1 inclusive, x2 exclusive (0-based cells).
export function urlChains(lines, row, cols) {
  const line = lines[row] || '';
  const chains = [];
  for (const m of line.matchAll(URL_AT)) {
    const segs = [{ row, x1: m.index, x2: m.index + m[0].length }];
    let text = m[0];
    // a segment is "full" when it ends at the cell border (" │") or at the right edge of the terminal
    const full = (l, x2) => BORDER.test(l.slice(x2)) || x2 >= cols - 1;
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
    if (url.length > 8 && segs.length) chains.push({ url, segs });
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
      for (let r = 0; r <= y - 1 - first; r++) {
        for (const c of urlChains(lines, r, term.cols)) {
          for (const s of c.segs) {
            if (s.row + first !== y - 1) continue;
            out.push({ text: c.url, range: { start: { x: s.x1 + 1, y }, end: { x: s.x2, y } }, activate: (_e, t) => open(t) });
          }
        }
      }
      cb(out.length ? out : undefined);
    },
  });
}
