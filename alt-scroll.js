// Scrolling a pane that sits in tmux's alternate screen (Claude Code's fullscreen TUI).
// capture-pane has no scrollback there (history_size 0), so the dashboard's terminal has nothing to scroll: the app keeps
// the transcript itself and scrolls it on PageUp / PageDown. The dashboard forwards the wheel / touch / jump buttons as those keys.
export const SCROLL_PAGES = { up: ['PageUp', 1], down: ['PageDown', 1], top: ['PageUp', 12], bottom: ['PageDown', 12] };

// -> { key, count } or null when `dir` is not a scroll direction
export function scrollPlan(dir) {
  const p = Object.prototype.hasOwnProperty.call(SCROLL_PAGES, dir) ? SCROLL_PAGES[dir] : null;
  return p ? { key: p[0], count: p[1] } : null;
}

// A pane scrolls through the app only while it is in the alternate screen and tmux holds no scrollback for it.
export function altScrollApplies({ alt, history }) { return alt === true && !(history > 0); }
