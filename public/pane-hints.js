// Claude Code draws a boxed hint when its pane is narrow: "Resize your terminal to at least 110 columns to show the diff panel".
// On the dashboard the card width is not the owner's to change, so the hint only gets in the way (owner 2026-11-20: "remove that").
// The three lines of the box (╭──╮ / │ hint │ / ╰──╯) are blanked, not removed: the row count must stay the same for the in-place repaint.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (l) => l.replace(ANSI, '');
const HINT = /Resize your terminal to at least \d+ columns/;
const BORDER = /^\s*[╭╮╰╯─┄╌×x ]+\s*$/;
export function stripResizeHint(text) {
  if (!text || !HINT.test(plain(text))) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!HINT.test(plain(lines[i]))) continue;
    lines[i] = '';
    for (const j of [i - 1, i + 1]) if (lines[j] !== undefined && BORDER.test(plain(lines[j])) && plain(lines[j]).trim()) lines[j] = '';
  }
  return lines.join('\n');
}
