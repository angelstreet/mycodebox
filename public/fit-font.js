// Text size for a card whose pane is wider than the card. The server keeps a 60-column minimum (and another client may have set more), so on a
// phone the pane often does not fit at the chosen text size: the right edge was cropped and the card scrolled sideways. Step the font down
// until the whole pane fits, but not below `min`. colsAt(f) = how many columns fit in the card at font f (measured by the caller).
export function fitFont({ cols, base, min = 8, step = 0.5, colsAt }) {
  let f = base;
  while (f > min && cols > colsAt(f)) f = Math.max(min, f - step);
  return f;
}
