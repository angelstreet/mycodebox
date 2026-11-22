// "Smooth scroll" of a fullscreen (alternate-screen) terminal card (docs/SCROLL-DESIGN.md).
// The app (Claude Code) keeps its transcript itself, so every scroll step of the terminal is a request to the server, a redraw by the
// app and a pane pushed back: the text moves in whole rows, a round trip late. The conversation is already in the page (the reader's
// document), so with the setting on a scroll UP shows that document in the card and scrolls it locally, and reaching the bottom again
// returns to the live screen. Per card, never saved: the reader / terminal choice (the >_ button) is still the user's.
// Pure decisions only; the DOM side is in app.js (localScrollEnter / localScrollExit).

export const ENTER_PX = 6;       // finger or wheel travel toward older text before the card goes local (a tap or a jitter does not)
export const EXIT_PX = 1;        // "at the bottom"
export const EXIT_IDLE_MS = 180; // at the bottom, no finger down and no scroll for this long: back to the live screen
export const FLING_TAU_MS = 325; // decay of the fling after the finger lifts (the usual touch-scroll time constant)
export const FLING_MIN = 0.05;   // px/ms: below this the fling is over

// May this scroll move the card to the local conversation? Only a real conversation file is worth it: the pane-derived transcript of
// another fullscreen app (vim, htop) is one screen, and an unloaded conversation would show an empty document.
export function localScrollEnters({ on, reader, alt, source, text, px } = {}) {
  return on === true && !reader && alt === true && source === 'session-file' && !!text && px >= ENTER_PX;
}

// Back to the live screen?
export function localScrollExits({ fromBottomPx, touching, idleMs } = {}) {
  return fromBottomPx <= EXIT_PX && !touching && idleMs >= EXIT_IDLE_MS;
}

// Finger velocity (px/ms) out of the last touch samples [{ t, y }]: the mean over the last ~150 ms, 0 when the finger rested before lifting.
export function flingVelocity(samples, now) {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > 100) return 0;   // the finger stopped, then lifted: no fling
  const recent = samples.filter((s) => last.t - s.t <= 150);
  const a = recent.length > 1 ? recent[0] : samples[samples.length - 2];
  return a && last.t > a.t ? (last.y - a.y) / (last.t - a.t) : 0;
}

// One animation step of the fling: -> { dy (px to scroll by), v (the velocity left), done }
export function flingStep(v, dtMs) {
  const k = Math.exp(-dtMs / FLING_TAU_MS);
  const dy = v * FLING_TAU_MS * (1 - k);   // the integral of v * e^(-t / tau) over the step
  const nv = v * k;
  return { dy, v: nv, done: Math.abs(nv) < FLING_MIN };
}
