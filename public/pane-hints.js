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
