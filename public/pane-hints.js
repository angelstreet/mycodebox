// Claude Code draws a boxed hint when its pane is narrow: "Resize your terminal to at least 110 columns to show the diff panel".
// On the dashboard the card width is not the owner's to change, so the hint only gets in the way (owner 2026-11-20: "remove that").
// The whole box goes: its top border (wrapped over several lines on a narrow pane), the hint (wrapped too) and the rest of the box. The rows it
// took are put back as empty lines at the TOP of the screen, so the row count stays the same for the in-place repaint and the empty space is
// not left between the text and the prompt (owner 2026-11-20: "a waste of reading space").
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (l) => l.replace(ANSI, '');
const HINT = /Resize your terminal to at least \d+/;   // the rest ("columns ...") may be wrapped onto the next line
const BORDER = /^\s*[╭╮╰╯┌┐└┘─┄╌×✕x ]+\s*$/;   // ✕ (U+2715) is the close mark Claude Code draws, × kept for older builds                          // a border-only line (top or bottom, or a wrapped piece of it)
const REST = /^\s*(?:│\s*)?(?:columns to show the diff panel|to show the diff panel|diff panel|show the diff panel)?\s*│?\s*$/;   // the hint's wrapped tail or an empty box row

// text: the pane (history + screen); the removed rows come back as empty lines at its very top.
const isBox = (l) => { const p = plain(l); return HINT.test(p) || (/[×✕]/.test(p) && BORDER.test(p) && /[╭┌]/.test(p + '╭') && /─{3,}/.test(p)); };   // the hint, or the box's own top border (its × close mark) drawn without it
export function stripResizeHint(text) {
  if (!text || !text.split('\n').some(isBox)) return text;
  let lines = text.split('\n');
  for (let guard = 0; guard < 4; guard++) {
    const i = lines.findIndex(isBox);
    if (i < 0) break;
    let a = i, b = i;
    while (a - 1 >= 0 && i - a < 6 && BORDER.test(plain(lines[a - 1])) && plain(lines[a - 1]).trim()) a--;
    while (b + 1 < lines.length && b - i < 4 && (BORDER.test(plain(lines[b + 1])) || REST.test(plain(lines[b + 1]))) && plain(lines[b + 1]).trim()) b++;
    const k = b - a + 1;
    lines.splice(a, k);
    lines.unshift(...Array(k).fill(''));   // at the very top: never inside the text
  }
  return lines.join('\n');
}

// Claude Code's diff side panel (opened by /diff; the Claude app never shows it): on a wide pane it takes the right third of the screen,
// "/diff to close  source: Current" on top and often "No changes this session". The dashboard shows the conversation only (owner 2026-11-20):
// every row of the panel block is cut at the panel's left border column. Colour codes are kept up to the cut, then reset.
const PANEL = /\/diff to close/;
const ESC = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
function cutAt(line, col) {   // the line's visible text up to column `col` (escape codes do not count), then a colour reset
  let out = '', vis = 0;
  for (let i = 0; i < line.length && vis < col;) {
    const m = ESC.exec(line.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(line.codePointAt(i));
    out += ch; i += ch.length; vis += 1;
  }
  return `${out.replace(/\s+$/, '')}\x1b[0m`;
}
export function stripDiffPanel(text) {
  if (!text || !PANEL.test(plain(text))) return text;
  const lines = text.split('\n');
  const h = lines.findIndex((l) => PANEL.test(plain(l)));
  const hp = [...plain(lines[h])];
  let col = -1; for (let k = hp.length - 1; k > 0; k--) if (hp[k] === '│' && PANEL.test(hp.slice(k).join(''))) { col = k; break; }   // the border just left of the header
  if (col < 0) return text;
  const isRow = (l) => [...plain(l)][col] === '│';
  let a = h, b = h;
  while (a - 1 >= 0 && (isRow(lines[a - 1]) || /[×✕]/.test(plain(lines[a - 1]).slice(col)))) a--;
  while (b + 1 < lines.length && isRow(lines[b + 1])) b++;
  for (let i = a; i <= b; i++) lines[i] = cutAt(lines[i], col);
  return lines.join('\n');
}
