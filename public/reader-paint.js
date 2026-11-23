// Bug 1792615055496-11750f / 1792615061126-df00d9: the reader was rebuilding
// innerHTML on every status tick (any reply content change forced an immediate
// swap), and the swap happened under the user's thumb when they were mid-content,
// throwing their scroll position. The fix is to defer the rebuild while the
// user is reading and apply it the next time they land at the bottom.

const BOTTOM_PX = 24;

// Pure helper used by paintReader(). Decides what to do with a fresh html payload.
//
//   decideReaderPaint({
//     scrollTop, scrollHeight, clientHeight, // current geometry of the .reader element
//     isFirst,                                 // first paint ever (dataset.h was never set)
//     htmlChanged,                             // the new html differs from the previously painted one
//     busyUntil,                               // ms timestamp; if > now, the element is mid-touch
//     now,                                     // reference clock (defaults to Date.now())
//   })
//
// Returns one of:
//   { action: 'skip' }                     -- no change needed
//   { action: 'rebuild', scroll: 'bottom' }-- swap content, jump scroll to bottom
//   { action: 'defer' }                    -- keep the user where they are; caller
//                                            stores the html and applies it later
//                                            (e.g. when the reader scrolls to bottom)
//   { action: 'defer', until: ts }         -- mid-touch, retry after ts
export function decideReaderPaint({
  scrollTop, scrollHeight, clientHeight, isFirst, htmlChanged, busyUntil, now = Date.now(),
} = {}) {
  if (!htmlChanged) return { action: 'skip' };
  if (busyUntil && now < busyUntil) return { action: 'defer', until: busyUntil };
  const atBottom = (scrollHeight - scrollTop - clientHeight) < BOTTOM_PX;
  if (isFirst) return { action: 'rebuild', scroll: 'bottom' };
  if (atBottom) return { action: 'rebuild', scroll: 'bottom' };
  // user is mid-content, away from the bottom: leave what they are reading in
  // place, stash the new html, and let the scroll handler apply it when they
  // land at the bottom again. This is the flashing-between-2-screens fix:
  // rebuilding innerHTML under the user's scroll would swap the prose under
  // their thumb and ruin their position.
  return { action: 'defer' };
}

// The automatic whole-conversation load (Claude and fullscreen sessions) runs once per session. If that one load failed (a stalled request
// over a relayed link, owner 2026-11-23) the reader stayed on the last reply for the life of the tab. A failed load re-arms it after a pause;
// a successful one, or the owner's "last reply only", keeps it off.
export const AUTO_FULL_RETRY_MS = 5000;
export function autoFullDue(c, now = Date.now()) {
  return !!c && !c.autoFull && now >= (c.autoFullRetryAt || 0);
}
export function autoFullDone(c, ok, now = Date.now()) {
  if (ok) return;
  c.autoFull = false;
  c.autoFullRetryAt = now + AUTO_FULL_RETRY_MS;
}
