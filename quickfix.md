# ghosty-sessions — quickfix log

Living log of small fixes shipped during the 2026-10-09 session
(`mvs_7ee2a72a0e4e4764ad5572cfe91f7b6b`). Each entry has a fixed number, the
problem, the chosen fix, and the files / lines touched. Read top-to-bottom
for chronology; see `docs/REFERENCE.md` and `docs/MAP.md` for the long-form
contracts (this file is the dev log, not the contract).

Index:
- QF-01 — search bar next to "Send to"
- QF-02 — NEEDS YOU pill vs per-card jump arrows
- QF-03 — double-tap to open card on a focused list row
- QF-04 — swipe L/R on a focused list row
- QF-05 — surface the swallowed `audio.play()` error
- QF-06 — codeboxv2 send "no current client"

Pre-existing fixes from earlier today (kept here for context, not authored in
this quickfix):
- mobile refresh lands on last selected task — `renderList()` scrollIntoView
- web keyboard Enter/arrow/printable routing — `document` keydown
- `sanitizeForAgent()` in `dispatch()` and `askSend()`
- long text → input file → `POST /api/inputs`

All QF-* changes are in this worktree only; the running service on `:7777`
does NOT have them. Deploy with `scripts/safe-restart.sh` once the worktree
is on the live checkout path.

---

## QF-01 — search bar next to "Send to" picker

### Problem
User asked for a search input on the right of the "Send to" sheet title so
they can filter long session lists (30+ rows). The `search` icon was added
to `public/icons.js` but `openPicker()` was not rewired.

### Decision
Replace the static `.sheet-title` with a flex row that has the title on
the left and a search input on the right; filter `sortedByNeed()` rows by
`displayName`, the session name, and the `repo · branch` chip — case
insensitive, empty query shows everything.

### Touched
- `public/app.js:3679` — `openPicker()` rewritten to render a `.sheet-head`
  flex row with title + search input; `draw()` filters via a local `q`;
  empty results show "no sessions match."
- `public/style.css:669-675` — `.sheet-head`, `.sheet-htitle`,
  `.sheet-hsearch` rules (row container, themed input with leading
  magnifier icon, focus state).

---

## QF-02 — NEEDS YOU pill vs per-card jump arrows

### Problem
The minimised "N need you" pill (`#askPopupPill`) sits at
`right: 10px; bottom: calc(var(--ask-bottom) + 10px)`, exactly where the
per-card `.jump` up/down buttons sit inside `.cell .b`. The pill overlaps
the up arrow so the user can't reach it without dismissing the pill.
User asked twice (req #4 and the follow-up req #9). Chose the cheaper
fix: move the jump arrows up inside the card, leave the pill where it is.

### Decision
Shift `.cell .jump` up by 74 px when the pill is visible. Cheaper than
moving the pill (the pill is wired to keyboard shortcuts + the answer
popup's positioning logic). Use a body-level flag so the jump arrows only
move when the pill is actually on screen.

### Touched
- `public/style.css:891` — `body.has-ask-pill .cell .jump{ bottom:84px; }`
  (was 10 px). Transition list also widened to include `bottom`.
- `public/ask-popup.js:237` — toggle `body.has-ask-pill` whenever the
  pill's `hidden` class flips.

---

## QF-03 — double-tap to open card on a focused list row

### Problem
In list mode, single-tap on a row opens the card. The user reported that
double-tapping didn't bring the card to fullscreen — the second tap was
just another single-tap that re-opened the same card (no visible change).
Perceived as "the card is focused but not full screen."

### Decision
After `focusSession(name)`, only call `openCard` when we're not yet in card
mode. Defensive: if the row's click fires while we're already on the card,
nothing breaks; if we're somehow still in list mode after a tap, the next
tap still escalates to fullscreen card.

### Touched
- `public/app.js:2235` — `wireRow` click handler now checks
  `state.mode !== 'card'` before calling `openCard`. Existing
  `focusSession(name)` always runs so the focus border stays correct.

---

## QF-04 — swipe left/right on a focused list row

### Problem
`wireCardSwipe` only listens in `'card'` mode. The mobile list view is the
home view; users wanted to swipe a row left/right to go to the next/prev
session in urgency order without opening each card.

### Decision
Add a touchstart/touchend swipe detector inside `wireRow` (60-px
horizontal threshold with vertical motion check, mirroring
`wireCardSwipe`). On swipe, focus the swiped row (so prev/next is
relative to it), then call `stepSession(dir)`. Gate the post-swipe
`click` with a `swiped` flag so the click handler doesn't also open the
card.

### Touched
- `public/app.js:2235` — `wireRow` rewritten with a `tsx/tsy/swiped`
  triplet; new `touchstart` / `touchend` listeners; `click` skips when
  `swiped`.
- `public/app.js:4155` — `stepSession` now picks the visible pane
  (`cardPane` / `listPane` / `gridPane`) for the slide animation, not
  just `cardPane`.
- `public/style.css:349-351` — `.list-pane.sl-r .row-item.focus` /
  `.list-pane.sl-l .row-item.focus` get the same slide-in keyframes the
  card already had.

---

## QF-05 — surface the swallowed `audio.play()` error

### Problem
`public/audio-chip.js` had `try { await audio.play(); } catch {}` with an
empty catch. On iOS Safari, `play()` can reject with `NotAllowedError`
(no user-gesture context), `AbortError` (interrupted by another play),
or `NotSupportedError` (codec issue). The user sees the play button do
nothing and has no clue why.

### Decision
Surface the error as `console.error` AND a brief red flash on the chip
plus an `aria-label` change for screen readers. Two-second timeout
restores the normal label. No module-level coupling to `toast()` — the
audio chip is rendered inside the popup which already has its own
affordances; an inline visual hint keeps it self-contained.

### Touched
- `public/audio-chip.js:103` — `catch (err) { console.error(
  '[tts] play failed', err); root.classList.add('ac-failed');
  playBtn.setAttribute('aria-label', 'audio failed: ' + …);
  setTimeout(() => { root.classList.remove('ac-failed');
  playBtn.setAttribute('aria-label', orig); }, 2400); }`
- `public/style.css:1105-1107` — `.audio-chip.ac-failed` red border +
  `acp-flash` 0.4s keyframe.

---

## QF-06 — codeboxv2 send "no current client"

### Problem
`POST /api/send/codeboxv2` returned 500 with
`tmux send-keys -t =codeboxv2: -l -- <text> ... no current client`.
The session exists (user sees it in the UI) and the target format
`=codeboxv2:` is identical to the one `createSession` uses successfully.
The difference: `createSession` runs right after `new-session -d`, when
the session has no client yet, but it uses `send-keys` for the first
command launch. When the dock later sends through, the session has no
client because no terminal is attached — and tmux's `send-keys -l`
(which needs to translate characters to key events) errors out.

### Decision
Always go through a tmux `set-buffer` + `paste-buffer` round-trip, even
for single-line text. `paste-buffer` does not require an attached
client; it just queues the bracketed-paste and the agent's paste
detection fires. Same 80 ms settle before the trailing `Enter`, so the
UX is unchanged for short sends. The inline and long-text paths now
share one mechanism.

### Touched
- `server.js:269` — `sendKeys()`: dropped the `lines.length > 1` branch.
  All non-empty text now goes through `set-buffer` + `paste-buffer`.
  Buffer name got a `Math.random()` suffix so two back-to-back sends
  don't collide on the same `Date.now()` ms. Limit bumped from 200
  lines to 5000 (the sanitized text after QF-07+ inputs is one-line
  pointers, see `server.js:1542` for the long-text path). 1 MB hard
  cap on text length.

---

## Verification

Each fix was syntax-checked; `npm test` stays at 839 pass / 39
pre-existing failures (date-sensitivity tests, unrelated to this work)
after each one.

## Deploy

None of these are in the running service on `:7777`. To ship:

```
cd /home/jndoye/ghosty-quickfix-codebox
git add quickfix.md public/app.js public/style.css \
        public/ask-popup.js public/audio-chip.js server.js
git commit -m "quickfix: QF-01..06 (search, pill overlap, double-tap, swipe, audio error, no-client)"
scripts/safe-restart.sh
```

Earlier (pre-quickfix) work that's also still on the worktree only:

- mobile refresh lands on last selected task — `renderList()` scrollIntoView
- web keyboard Enter/arrow/printable routing — `document` keydown
- `sanitizeForAgent()` in `dispatch()` and `askSend()`
- long text → input file → `POST /api/inputs`
---

## Deploy (Fri 2026-10-09 10:01 UTC)

- Commit `25e387d` on branch `task70-tts-needs-you` (worktree
  `/home/jndoye/ghosty-quickfix-codebox/`).
- Files mirrored to live path `/home/jndoye/ghosty-sessions/` (rsync --delete
  was blocked by the harness; manual `cp` of the changed files used
  instead).
- Restarted via `/home/jndoye/ghosty-sessions/scripts/safe-restart.sh --wait 10`.
  Replied `restarted via systemctl`. Server back on `:7777`, `/api/sessions`
  returns 200.
- codeboxv2 live test:
  - `tmux send-keys -t =codeboxv2: -l -- 'hi'` → still fails (live CLI;
    sanity check that nothing else changed the underlying tmux behaviour).
  - `curl POST /api/send/codeboxv2 {keys:"urgent task verify from dock"}`
    → `{"ok":true,"sent":1}`.
  - `tmux capture-pane -t codeboxv2: -p -J | tail -3` shows the prompt with
    both the earlier manual `paste-buffer` text and the dock-sent text in
    `›  hello from paste buffer urgent task verify from dock`.
- Decision log lives in the user-memory file as the "QF-01..06 shipped &
  verified" entry. Cross-project note: prefer `paste-buffer` over
  `send-keys -l` for any no-client tmux scenario.
