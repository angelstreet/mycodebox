// Scrolling a pane that sits in tmux's alternate screen (Claude Code's fullscreen TUI).
// capture-pane has no scrollback there (history_size 0), so the dashboard's terminal has nothing to scroll: the app keeps
// the transcript itself and scrolls it. An app with SGR mouse tracking on (Claude Code fullscreen) gets real wheel events,
// one line each in Claude Code, so a wheel / touch drag moves the text line by line; any other alternate-screen app gets PageUp / PageDown.
export const SCROLL_PAGES = { up: ['PageUp', 1], down: ['PageDown', 1], top: ['PageUp', 12], bottom: ['PageDown', 12] };
export const MAX_NOTCHES = 60;   // wheel notches in one request (the client batches what it gathered while the last one was on its way)

// -> { key, count } or null when `dir` is not a scroll direction
export function scrollPlan(dir) {
  const p = Object.prototype.hasOwnProperty.call(SCROLL_PAGES, dir) ? SCROLL_PAGES[dir] : null;
  return p ? { key: p[0], count: p[1] } : null;
}

// Wheel notches for up / down: the raw SGR mouse bytes (ESC [ < 64|65 ; col ; row M) as `tmux send-keys -H` hex arguments, aimed at
// the upper third of the pane (the transcript, not the prompt box). null for top / bottom / anything else (those stay PageUp/PageDown).
export function wheelPlan(dir, notches, { cols = 80, rows = 24 } = {}) {
  if (dir !== 'up' && dir !== 'down') return null;
  const n = Math.max(1, Math.min(MAX_NOTCHES, Math.floor(Number(notches) || 1)));
  const x = Math.max(1, Math.floor((Number(cols) || 80) / 2)), y = Math.max(1, Math.floor((Number(rows) || 24) / 3));
  const seq = `\x1b[<${dir === 'up' ? 64 : 65};${x};${y}M`;
  const hex = Array.from(seq, (c) => c.charCodeAt(0).toString(16).padStart(2, '0'));
  return { notches: n, hex: Array.from({ length: n }, () => hex).flat() };
}

// A pane scrolls through the app only while it is in the alternate screen and tmux holds no scrollback for it.
export function altScrollApplies({ alt, history }) { return alt === true && !(history > 0); }
