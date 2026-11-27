// The verdict of one tile, in one place: what the browser layer calls a tile that plays.
//
// A tile plays when the player has the stream, its picture is not black, and something about it MOVES, and none of
// its own HLS requests failed.
//
// Two things are deliberately not the bar:
//   - `readyState 2`: a healthy live player can sit at `readyState 1` while it shows a bright picture and its clock
//     moves (FR Kids 2 on 2026-11-27: alone, readyState 1 at 4 s and 4 at 6 s; inside the grid, which keeps the other
//     cards' pictures loading, it never passed 1 in 15 s).
//   - the clock over the last two seconds: a live tile at the live edge nudges its clock backward when it re-syncs
//     (FireTV -0.05 s, ILTV -0.54 s on 2026-11-27, both healthy: their clocks run on). The clock over the WHOLE time
//     the tile was watched, and the picture itself, are the honest signals.
//
// A card with no <video> at all (a drone, a PC screen) is not a stream tile: it gets no verdict (null), never a fault.

// the brightest pixel of the frame below this is a black picture
export const BLACK_LUMA = 32;

// -> true (the tile plays) | false (the tile does not play) | null (the card is not a stream tile)
export function tileVerdict({ readyState, dt, moved, pictureChanged, bright, hlsFailures } = {}) {
  if (readyState === null || readyState === undefined || readyState < 0) return null;   // no <video> in the card
  const seen = bright !== null && bright !== undefined && bright > BLACK_LUMA;
  // the tile lives when its clock runs, when it ran over the time it was watched, or when its picture changes
  const alive = (dt !== null && dt !== undefined && dt > 0) || !!moved || !!pictureChanged;
  return !!(readyState >= 1 && seen && alive && !hlsFailures);
}
