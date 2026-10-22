// Text size for a card whose pane is wider than the card. The server keeps a 60-column minimum (and another client may have set more), so on a
// phone the pane often does not fit at the chosen text size: the right edge was cropped and the card scrolled sideways. Step the font down
// until the whole pane fits, but not below `min`. colsAt(f) = how many columns fit in the card at font f (measured by the caller).
export function fitFont({ cols, base, min = 8, step = 0.5, colsAt }) {
  let f = base;
  while (f > min && cols > colsAt(f)) f = Math.max(min, f - step);
  return f;
}

// The two decisions a card makes while it is being fitted to its window (layoutTerm):
// may the text shrink yet? Only once the server has had its say (our resize request is answered and the pane is at the width it granted), or
// when this client cannot resize the window at all; while the request is on its way the pane is about to change width, and a shrunk interim
// (8 px text, then a jump to 12 px) was the ugly load.
export function canShrinkFont({ askable, granted, cols }) {
  return !askable || !!(granted && granted.cols === cols);
}

// Should a freshly opened card stay hidden for now? While the pane is not at the width we asked for (or the server granted), or the repainted
// pane after a grant has not arrived yet, for at most maxMs after the card was mounted (then it shows whatever it has).
export function isSettling({ askable, cols, target, awaitPane = false, ageMs, maxMs = 1800 }) {
  return !!askable && (Math.abs(cols - target) > 1 || !!awaitPane) && ageMs < maxMs;
}
