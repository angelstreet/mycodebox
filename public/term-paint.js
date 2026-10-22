// Repaint plan for a card's terminal. The old paint cleared the screen AND the scrollback and rewrote the whole pane every time the
// text changed, and a live session changes every second (timers, spinners): on a phone the card went blank and rebuilt in front of the
// reader, and the scroll position jumped. When only rows of the visible screen changed, overwrite just those rows in place: no clear,
// the scrollback is not touched, nothing blinks. Anything else (history line changed, line count changed past the screen, a resize)
// is a full repaint, exactly as before.
//   planPaint(prev, next, rows) -> { mode: 'skip' } | { mode: 'inplace', data } | { mode: 'full' }
// prev / next: the text as it was / will be written (after closeBgAtNewlines, no trailing newlines); prev null = nothing painted yet.
const SGR_RE = /\x1b\[[0-9;:]*m/g;

export function planPaint(prev, next, rows) {
  if (prev == null || !(rows >= 2)) return { mode: 'full' };
  if (prev === next) return { mode: 'skip' };
  const pl = prev.split('\n'), nl = next.split('\n');
  if (pl.length !== nl.length && Math.max(pl.length, nl.length) > rows) return { mode: 'full' };   // lines scrolled: the screen is not the same rows
  let d = 0;
  while (d < pl.length && d < nl.length && pl[d] === nl[d]) d++;
  const screenTop = pl.length > rows ? pl.length - rows : 0;   // first line the screen shows
  if (d < screenTop) return { mode: 'full' };                  // a line already in the scrollback changed
  // tmux -e carries colour state across lines: replay the head's SGR codes so the first row of the tail starts in the right state
  const carry = (nl.slice(0, screenTop).join('\n').match(SGR_RE) || []).join('');
  const tail = nl.slice(screenTop).map((l) => `${l}\x1b[K`).join('\r\n');
  return { mode: 'inplace', data: `\x1b[?25l\x1b[H\x1b[0m${carry}${tail}\x1b[J` };
}
