// How many lines of pane history a client may ask for: GET /api/pane/<session>?lines=N.
// The dashboard asks for 1000 lines first and then for 1000 more at a time (its "load older" button), so 1000 is the
// floor. The server's own pane depth (PANE_LINES, the lines it keeps per session) may be larger, and it must not refuse
// that first request: on this host PANE_LINES is 2000, so every pane of the dashboard answered 400 and the history of a
// session never loaded (bug-4f9afc93).
export const PANE_MIN_LINES = 1000;
export const PANE_MAX_LINES = 10000;

// A valid request: an integer within [1000, 10000]. tmux returns what it has, so asking for fewer lines than the
// server keeps is fine.
export function paneLinesOk(lines) {
  return Number.isInteger(lines) && lines >= PANE_MIN_LINES && lines <= PANE_MAX_LINES;
}
