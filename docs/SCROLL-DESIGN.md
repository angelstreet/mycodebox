# Scrolling a fullscreen session in terminal mode: design review (2026-11-22)

Question from the owner: scrolling the terminal view of a Claude Code session does not feel like read mode. Is forwarding
wheel notches to Claude Code the right design, or is there another way?

**Answer.** Forwarding is the only way to scroll *the app's own screen*, and it cannot glide: every step is a network
round trip plus a redraw, in whole rows. The history does not have to come from the app: the page already holds the
conversation. **Recommendation, shipped as the optional setting "Smooth scroll" (off by default): scrolling up in a fullscreen
terminal shows the conversation in the card and scrolls it locally; reaching the bottom returns to the live screen.**
Forwarding stays as the path for the setting off, for apps without a conversation file, and until the file is loaded.

## 1. What the code does today

| Step | Where | What |
|---|---|---|
| Terminal view | `server.js` 1 s tick, `capturePane` -> WebSocket `snapshot` -> `paintTerm` (`public/app.js`) | A copy of the tmux pane about once a second, written into xterm.js |
| No history | `alt-scroll.js` `altScrollApplies` | Claude Code fullscreen runs in tmux's alternate screen: `history_size` 0, xterm has nothing to scroll |
| Input | `public/app.js` `bindAltScroll` | Wheel / touch pixels become notches, one per text row (`altRowPx`) |
| Queue | `altScroll` / `altPump` | One `POST /api/scroll` at a time; what gathered meanwhile goes in the next one (up to 60 notches) |
| Server | `server.js` `/api/scroll/` | capture-pane (before), `tmux send-keys -H` SGR wheel bytes, capture-pane polled at 15 ms then every 25 ms (8 tries) until the pane changed, snapshot pushed to every open card, then the answer |
| Paint | `paintTerm` | The whole visible grid is replaced by the new pane |
| Scrollbar | `barMetrics` kind `alt` | An estimate: notches sent, over 1.4 x the conversation's line count |
| Read mode | `paintReader`, `public/reader-paint.js`, `/api/transcript` (`conversation.js`) | The conversation read from the session file (newest 3 MB), rendered once as HTML, scrolled by the browser |

A non-fullscreen Claude card loads only the newest 40 000 characters first (`/api/transcript/<s>?max=40000`, `partial: true` when older text exists); the rest comes when the reader is scrolled near its top or "older conversation" is pressed (`loadOlderConversation`, scroll position held). The conversation is already loaded for every fullscreen card (the `snapshot` handler preloads `/api/transcript` on the
first alternate-screen snapshot; it was the reader's source only).

History: scrolling a fullscreen terminal did switch the card to the reader for a few hours on 2026-11-20. It flipped the
*global, saved-on-toggle* reader switch without saving it and never came back, so every reload flipped views; it was
removed the same day ("a card no longer switches between reader and terminal by itself"). That failure was the
persistence model, not the idea.

## 2. Measurements

Method (`scripts/scroll-bench/`, nothing live touched): a TEST `server.js` on a loopback port with a temp
`GHOSTY_STATE_DIR` and `HOME`, a private tmux socket with one throwaway session running
`test/fixtures/fake-fullscreen-tui.mjs` (alternate screen, SGR mouse, one line per notch, 12 ms redraw, 3000 lines), a TCP
proxy that adds the network delay (`delay-proxy.mjs`), headless Chromium at 360 x 780 with touch (`bench.py`, raw CDP
touch events). Position is logged in the page: the pane's own offset from each WebSocket snapshot (terminal) or the
document's scroll position at every animation frame (reader, smooth scroll).

Two gestures of 300 px toward older text: a **slow drag** (36 touch moves, about 1.8 s in headless) and a **flick**
(8 moves, about 0.45 s). "Updates" = times the text moved. `python3 scripts/scroll-bench/bench.py --rtt 0,100,300 --redraw 12 --modes terminal,reader,local`, 2026-11-22:

| Added round trip | View | Gesture | First move after touch | Updates | px per update (avg / max) | Gap between updates (median / max) | Requests (avg ms, max notches) | Travel after lift |
|---|---|---|---|---|---|---|---|---|
| 0 ms | terminal (forwarded) | drag | 153 ms | 24 | 12 / 12 | 53 / 102 ms | 24 (35 ms, 1) | 0 px |
| 0 ms | terminal (forwarded) | flick | 104 ms | 8 | 36 / 36 | 48 / 83 ms | 8 (44 ms, 3) | 36 px |
| 100 ms | terminal (forwarded) | drag | 250 ms | 13 | 22 / 24 | 140 / 192 ms | 13 (144 ms, 2) | 24 px |
| 100 ms | terminal (forwarded) | flick | 214 ms | 4 | 72 / 108 | 144 / 146 ms | 4 (145 ms, 9) | 180 px, all of it late |
| 300 ms | terminal (forwarded) | drag | 449 ms | 6 | 48 / 60 | 332 / 335 ms | 6 (333 ms, 5) | 60 px |
| 300 ms | terminal (forwarded) | flick | 400 ms | 2 | 144 / 252 | 333 ms | 2 (334 ms, 21) | 252 px, all of it late |
| any | reader | drag | 138 ms | 41 | 7 / 9 | 33 / 36 ms | 0 | 14 px |
| any | reader | flick | 88 ms | 37 | 14 / 38 | 17 / 35 ms | 0 | 233 px of momentum, 475 ms |
| any | **smooth scroll** | drag | 150 ms | 59 | 5.5 / 17 | 50 / 66 ms | 0 | 37 px |
| any | **smooth scroll** | flick | 94 ms | 61 | 8.6 / 37 | 17 / 66 ms | 0 | 228 px of momentum, 900 ms |

Reading the table:

- The "first move" floor of about 90-150 ms is the bench itself (headless Chromium delivers one touch move per 50 ms and
  the first one has to pass the touch slop); the local views sit on that floor at every latency. The forwarded terminal
  adds one full request on top: +35 ms on loopback, +145 ms at 100 ms, +335 ms at 300 ms.
- Forwarded request time = round trip + about 35-45 ms of server work (two capture-panes, send-keys, the 15 ms first
  poll, the app's redraw). So the terminal moves **at most 1000 / (RTT + 40) times a second**: 20 on loopback, 7 at
  100 ms, 3 at 300 ms, always in whole rows (12 px), and the rows that gathered during a request land in one jump
  (60 px in a drag, 252 px in a flick at 300 ms). That is "steps, not glide" and "uneven speed".
- A flick has no momentum of its own in the forwarded path: the finger's travel is delivered late, then it stops.
  The local views keep moving for 0.5-0.9 s (about 230 px), as a list does.
- Smooth scroll moved the text on every touch move of the gesture (35 of 36) and made **zero** requests, at every latency.

Real Claude Code 2.1.330 (`scripts/scroll-bench/app-redraw.mjs`, a throwaway fullscreen session on a private tmux socket,
100 x 40 pane, a copied conversation, no prompt sent):

| Notches in one write | Pane changed after | Rows moved |
|---|---|---|
| 1 (6 runs) | 10-13 ms | 1 |
| 2 | 11 ms | 2 |
| 3 | 7 ms | 3 |
| 5 (3 runs) | 11-15 ms | 6 |
| 8 | 9-15 ms | 13 |
| 10 | 11-21 ms | 19 |

`capture-pane` itself: 2.3 ms. Two findings: Claude Code is not the slow part (about 12 ms per redraw), and it
**accelerates**: a burst of notches moves more than one row each (10 notches = 19 rows). The dashboard batches exactly
when the network is slow, so the same finger travel scrolls further on a slow link than on a fast one, and the scrollbar
estimate (one row per notch) drifts. Neither can be corrected from outside: the app's position is not readable.

## 3. Options

| # | Option | Latency | Glide | Exact position | Size / risk | Verdict |
|---|---|---|---|---|---|---|
| A | Keep forwarding, tune it (skip the "before" capture, shorter polls, smaller batches) | RTT + ~25 ms at best | No: whole rows, one update per round trip | No | Small | Saves about 15 ms of a budget the network dominates. Loses |
| B | **Smooth scroll: show the conversation locally while scrolled up, the live screen at the bottom** | One frame | Yes: browser scroll, real momentum | Yes: real scrollbar, drag, jump to top | Small, a client setting | **Recommended, shipped** |
| C | Run Claude Code without fullscreen so tmux keeps scrollback | One frame (xterm) | Rows | Yes | A launch change for every session | Brings back the flicker and the duplicated lines fullscreen removed, history is capped at the captured lines (1000-10000), and it changes how every session renders to fix one view. Loses |
| D | Predict on the client: translate the grid by the finger's pixels while the request is out | One frame for the pixels | Looks like it until the reply | No | Medium, fragile | The rows scrolled into view are unknown until the reply (blank band), the app's header / prompt box would slide with the text, and the app's acceleration makes the predicted distance wrong, so the text snaps back on every reply. Loses |
| E | Build a local scrollback from successive captures | One frame for rows already seen | Rows | No | Medium | Only helps on the way back down; stitching screens of a redrawing TUI by text overlap breaks on repeated lines and on every reflow. Loses |
| F | Write the conversation from the session file into xterm's scrollback above the live screen | One frame | Rows (xterm scrolls by row) | Yes | Medium | One view instead of two, but the seam repeats what the live screen shows, the text is plain (no markdown, no bubbles), and every pane tick has to rebuild a multi-MB buffer. B gives the same content with a browser-native scroll. Loses |
| G | Claude Code's own keys (PageUp, transcript mode ctrl+o) | RTT + redraw | No: a page per key | No | Small | Same round trip with coarser steps; transcript mode is another screen to leave. Kept only as the fallback for apps without mouse tracking. Loses |
| H | Stream the pty (tmux control mode / pipe-pane) instead of a 1 s capture | n/a for scrolling | n/a | n/a | Large | Makes live output real-time, which is worth its own task, but a scroll is still a request to the app. Not a scrolling fix |
| I | Send synthetic momentum (extra notches after the lift) | RTT | No | No | Small | Adds late motion on top of late motion; the acceleration makes the distance unpredictable. Loses |

Why B wins: the two things the owner feels (delay and steps) are both the round trip, and B is the only option that
removes it for the content people scroll to read, with code that already existed (the reader and the preloaded
conversation). What B gives up: while scrolled up the card shows the conversation as the reader renders it (same font
and colours since 2026-11-20, but markdown instead of the TUI's boxes, and tool output as one line per call), and text
the agent is streaming right now reaches the session file a moment later than the screen. The live screen is one flick
down, and the setting turns the whole behaviour off.

## 4. What shipped

- `public/local-scroll.js`: the pure rules (when to go local, when to return, the fling); `test/local-scroll.test.js`.
- `public/app.js` `localScrollEnter` / `localScrollExit` / `wireLocalScroll`, `bindAltScroll`:
  - A scroll of 6 px toward older text in a fullscreen terminal whose conversation file is loaded shows the reader in that
    card, positioned that far above its end. The touch that began on the terminal keeps driving it pixel for pixel and
    flings on lift; later touches and wheel events are the browser's own scroll.
  - At the bottom, finger up and 180 ms at rest, the terminal is back.
  - Per card and in memory only (`state.scrollRd`): the saved reader / terminal choice (`ghosty.reader`, the `>_`
    button) is never written, a reload or another card shows the terminal. Tapping `>_` while scrolled up pins the reader.
  - The scrollbar is the document's (drag it, or press the estimate bar to go local at that point); the jump-to-top button
    goes to the first message locally, jump-to-bottom returns to the live screen.
  - The app is never scrolled; if it was (setting just switched on, another device), it is sent ctrl+End on entry.
  - The conversation is refreshed on entry when the pane changed since it was loaded, and swapped in under the reading
    position.
  - Not used (forwarding as before): setting off, a fullscreen app without a session file (vim, htop), conversation not
    loaded yet, grid view.
- Setting: `localStorage ghosty.smoothScroll` (default off, so terminal scrolling stays in the terminal unless enabled). Switches: More menu "Smooth scroll: on/off" (phone), text
  popover "Smooth scroll" (desktop).
- Verified at phone width on the test server: `python3 scripts/scroll-bench/verify.py` (18 checks: goes local with no
  request, saved view untouched, momentum, returns at the bottom, jump buttons, scrollbar press, reload, the switch,
  setting off = forwarded as before, re-enabling with the app scrolled up).

## 5. Not done, by choice

- Tuning the forwarded path (option A): the numbers say it cannot change the feel; it stays as the fallback.
- Real-time terminal output (option H): a separate, large task. Brief if the owner wants it: "replace the 1 s
  capture-pane tick for open cards with a tmux control-mode client (`tmux -C attach`, `%output` events) feeding xterm.js
  directly; keep capture-pane for state detection; measure output latency before / after with `scripts/scroll-bench`".
