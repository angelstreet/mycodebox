// The verdict of one tile, in one place: what the browser layer calls a tile that plays.
//
// A tile plays when the player has the stream, its clock moves, its picture is not black, and none of its own HLS
// requests failed. `readyState 2` is NOT the bar: a healthy live player can sit at `readyState 1` while it shows a
// bright picture and its clock moves (FR Kids 2, 2026-11-27: alone, readyState 1 at 4 s and 4 at 6 s; inside the grid,
// which keeps the other cards' pictures loading, it never passed 1 in 15 s). The clock and the picture decide.
// A card with no <video> at all (a drone, a PC screen) is not a stream tile: it gets no verdict (null), never a fault.

// the brightest pixel of the frame below this is a black picture
export const BLACK_LUMA = 32;

// -> true (the tile plays) | false (the tile does not play) | null (the card is not a stream tile)
export function tileVerdict({ readyState, dt, bright, hlsFailures } = {}) {
  if (readyState === null || readyState === undefined || readyState < 0) return null;   // no <video> in the card
  const moves = dt !== null && dt !== undefined && dt > 0;
  const seen = bright !== null && bright !== undefined && bright > BLACK_LUMA;
  return !!(readyState >= 1 && moves && seen && !hlsFailures);
}
