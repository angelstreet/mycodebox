// Who may resize a shared tmux window. Every dashboard client that shows a session asks the server to resize its window to the card's
// size, and there is one window per session: a phone card and a desktop card (or two tabs) on the same session took turns resizing it,
// each answering "taken" within seconds, forever; the TUI reflowed and the card flashed at every flip. So a client claims the size once
// when it first shows the card, and after that only fights back while the user is actually using it (a tap, a key, a wheel, returning
// to the tab) and at most MAX_RECLAIMS times per use. An idle client just shows the pane at whatever size it has.
export const IDLE_MS = 30000, MAX_RECLAIMS = 4, GAP_MS = 3000;

// -> 'ask' (send our size), 'reclaim' (the window was taken back from the size we asked for: ask again) or 'wait'.
//   lastInput: ms of the user's last input in this page (0 = none); asked: we already asked once since the card mounted;
//   askedSame: the size we want is the one we last asked for; taken: the pane is not at it by more than a column.
export function fitAction({ now, lastInput = 0, asked = false, askedSame = false, taken = false, hasFocus = true, reqAt = 0, reclaims = 0 }) {
  const active = lastInput > 0 && now - lastInput < IDLE_MS;
  if (!active && asked) return 'wait';
  if (!askedSame) return 'ask';
  if (!taken || !hasFocus || now - reqAt < GAP_MS || reclaims >= MAX_RECLAIMS) return 'wait';
  return 'reclaim';
}

// Is the pane already as good as a resize request could make it? (so a touch, a focus event or the address bar sliding in and out does not
// resize the shared tmux window again, which reflowed the TUI and made the card flash)
//   - the pane is at our width and within ROW_SLACK rows of what fits (an address bar is ~4 rows), or
//   - the server already gave us all it can for this width (it keeps a 60-column minimum): we asked for `askedCols`, it granted `cols`,
//     the pane is still at that width and about that tall.
export const ROW_SLACK = 6;
export function fitSatisfied({ cols, rows, curC, curR, granted = null }) {
  if (cols === curC && Math.abs(rows - curR) <= ROW_SLACK) return true;
  return !!granted && granted.askedCols === cols && granted.cols === curC && Math.abs(granted.rows - curR) <= ROW_SLACK && Math.abs(granted.askedRows - rows) <= ROW_SLACK;
}
