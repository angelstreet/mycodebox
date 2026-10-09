# ghosty-sessions — quickfix log

Living log of small fixes shipped during the 2026-10-09 session
(`mvs_7ee2a72a0e4e4764ad5572cfe91f7b6b`). Each entry has a fixed number, the
problem, the chosen fix, and the files / lines touched. Read top-to-bottom
for chronology; see `docs/REFERENCE.md` and `docs/MAP.md` for the long-form
contracts (this file is the dev log, not the contract).

Index — one line per QF, **description first, fix reference second** so the
log reads from the user's perspective (what was broken) rather than from
the author's (what changed). Same order in tables and section headings.

- QF-01 — **search bar next to "Send to" picker** — `openPicker()` flex row, filter by name/repo
- QF-02 — **NEEDS YOU pill hides per-card jump arrows** — `body.has-ask-pill` lifts `.cell .jump` 74px
- QF-03 — **double-tap on focused list row didn't open card** — `wireRow` click skips `openCard` when already in card mode (idempotent)
- QF-04 — **no swipe L/R on focused list row** — `wireRow` gets touchstart/touchend + `swiped` flag; `stepSession` animates listPane
- QF-05 — **`audio.play()` error swallowed silently** — `console.error` + `.ac-failed` red flash + `aria-label`
- QF-06 — **codeboxv2 send "no current client"** — `sendKeys()` always uses `set-buffer` + `paste-buffer`
- QF-07 — **web: typing on focused card didn't focus the dock input** — `document` keydown in CAPTURE phase (xterm's stopPropagation on its helper-textarea was eating bubble-phase events); shipped + Playwright-verified 2026-10-09 10:27, commit 4e2cc8d
- QF-08 — **MD doc flashes 'loading…' on every click — should cache and show instantly** — client-side cache for `/api/taskdoc`; **developed 2026-10-09 19:19, fix in progress**
- QF-09 — **card body overflows with no scrollbar on phone (long mcode error unreadable)** — `.cell .b` `overflow:hidden` → `overflow-y:auto; overflow-x:hidden`; **developed 2026-10-09 19:21, test pending**
- QF-10 — **mobile filter bar shows two clear buttons; 'tasks 0' chip is clutter** — only render the bottom `.fclear`, drop the duplicate top `.fclear-top`; render the tasks chip only when `count > 0`
- QF-11 — **card header clutters with 'Loading 40s' + '↯ 2212 tok/s'** — `cleanHeaderActivity()` strips them out of the visible header (data flow preserved for the manager log)
- QF-12 — **no way to lock a card so accidental taps can't steal focus** — `state.lockedSession` + `LS_LOCKED` (persists across reloads); tap the lock icon to lock the card; tapping any other card unlocks the previous one
- QF-13 — **filter bar had two cluttered rows: give it one clear-all + an X/Y indicator at the top** — collapse to one row, `clear all clear ×` plus `X/Y` indicator, both vanish when no filter is active
- QF-14 — **dock: paperclip sits left of mic, task chip breathes, and icons flicker when target name changes** — DOM reorder (mic before attach) + wider fixed-width `.tchip` (200px, no min/max breathing) + fixed 42px on `.dock .mic` (`flex:0 0 42px`) so the row doesn't reflow when the target name changes; Playwright-verified 2026-10-09 20:25, commit `f4e761e`, shipped + live
- QF-15 — **NEEDS YOU pill always overlapped the per-card jump arrows** — QF-02 was a regression (predicate was inverted, class never set; no spec shipped); drop the `!` on `minimised` in `ask-popup.js:237`; added `scripts/test-server.sh` + `scripts/test-fix.sh` so every QF now runs headless against `:7778` before it touches `:7777`; **developed 2026-10-09 22:20**

Pre-existing fixes from earlier today (kept here for context, not authored in
this quickfix):
- mobile refresh lands on last selected task — `renderList()` scrollIntoView
- `sanitizeForAgent()` in `dispatch()` and `askSend()`
- long text → input file → `POST /api/inputs`

All QF-* changes are in this worktree only; the running service on `:7777`
does NOT have them. Deploy with `scripts/safe-restart.sh` once the worktree
is on the live checkout path.

---

## Workflow rules (from chat-raised 2026-10-09)

These are how this log is meant to be used. Don't bypass them.

### 1. Description before fix reference

In tables, in the Index above, and in section headings: the description of
**what was broken from the user's view** comes first, then the file/line
reference. This makes the log readable without flipping back to the
original session transcript.

### 2. Log the request as a QF **before** coding

When a user request comes in, even before I know the fix:

1. Pick the next QF number (never reuse, even after rollback).
2. Write the **Problem** section in `quickfix.md` for that QF — at minimum
   the user's quote and a 1-line repro.
3. Then implement. Edit the same section in place as you discover more.
4. When it's shipped + live-verified, fill in **Decision** + **Touched**.

If I run out of QFs to log (e.g., just thinking out loud), I still bump the
number — better to have a gap than to lose the index ↔ session mapping.

### 3. Verifier sub-agent for every fix

For each fix I claim is "done", I spawn a `verifier` sub-agent (`task`
with `agent_name: "verifier"`) in parallel with the actual fix work. The
verifier is **read-only**: it reads the diff, the touched files, the live
state, and reports verdict + issues. While the verifier runs, I move on
to the next fix in the queue.

Why:

- I write code with a single goal (make the change). The verifier reads
  code with a different goal (find what the change breaks or misses).
- The verifier doesn't share my recent context, so it doesn't inherit
  my assumptions.
- Multiple fixes can have their verifier running at once if they're
  independent.

What the verifier checks per fix:

- For UI/handler fixes: race conditions, focus traps, event ordering.
- For server fixes: status codes, edge inputs, idempotency.
- For CSS/layout fixes: collapses, z-index, hidden ancestors.
- Live state: if the daemon is reachable, `curl` the affected route and
  confirm the response shape. For tmux/tmux-adjacent fixes, ask the
  running daemon's view via `tmux list-sessions` / `capture-pane`.

The verifier's output lives in the **Verifier** section of each QF entry.
If verdict is "broken" or "partial", I don't mark the QF as shipped and
move on to the next fix in the queue; I loop back to the failing one
after the queue drains, with the verifier's findings as the new spec.

### 4. Status lifecycle for each QF

| Status | Meaning | Required to advance |
|---|---|---|
| `developed` | Code written, in the worktree, not yet covered by a test | Code exists, touches the listed files only |
| `under test` | Playwright / API test written and **failing or skipped** for the bug scenario | Test file exists, runs against the live daemon, expected-fail captured |
| `verified`  | Test now passes; screenshot captured for any UI change | Playwright trace + `screenshots/qf-NN-*.png` checked in next to the test |
| `shipped`   | Committed, mirrored to live path, `safe-restart.sh` clean | All four above + commit hash in this entry |
| `live`      | Daemon restarted, post-deploy curl / tmux capture confirms the user-visible behaviour | `commit + restart + live evidence` |

`developed → under test` is the **first commit gate**. Don't go straight
to `verified` without a test that failed first — if a test passes
immediately, you didn't reproduce the bug.

### 5. Test split — API tests vs Playwright

Two kinds of fixes, two kinds of tests:

- **Pure changes** (logic, helpers, route handlers, sanitizers, tmux paths):
  covered by `node --test test/*.test.js` (the existing suite) +
  `curl` against the live daemon. Examples: QF-05 audio (the catch
  branch is pure JS), QF-06 tmux send. **No browser needed.**
- **Web / mobile layout** (anything that renders, anything the user sees
  on a phone or desktop): must be covered by a Playwright test in
  `test/browser/*.spec.js`. Examples: QF-01 picker search, QF-02 pill
  overlap, QF-03 double-tap, QF-04 swipe, QF-07 keyboard focus, **and
  every future UI fix.**

### 6. Playwright setup

The host already has Playwright 1.63.0 installed at
`/home/jndoye/.local/bin/playwright` with the chromium browsers cached
under `~/.cache/ms-playwright/`. Use it directly without an npm install:

```js
// test/browser/_setup.js  — re-exported by every spec
import { chromium } from '/home/jndoye/.local/lib/node_modules/playwright/index.js';
export const BASE = process.env.GHOSTY_URL || 'http://localhost:7777';
export const VIEWPORT_PHONE = { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
export const VIEWPORT_DESK = { width: 1280, height: 800 };
export async function newCtx(opts = {}) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[browser ${m.type()}]`, m.text()));
  page.on('pageerror', (e) => console.log('[browser pageerror]', e.message));
  return { browser, ctx, page };
}
```

A spec looks like:

```js
// test/browser/qf-07-keyboard-focus.spec.js
import { test, expect } from '/home/jndoye/.local/lib/node_modules/playwright/test.js';
import { BASE, VIEWPORT_DESK, newCtx } from './_setup.js';

test('QF-07 — typing on a focused card moves focus to the dock input', async () => {
  const { browser, page } = await newCtx({ viewport: VIEWPORT_DESK });
  await page.goto(BASE);
  // wait for the list to populate; pick the first row, tap it to open the card
  await page.waitForSelector('.row-item');
  await page.locator('.row-item').first().click();
  // click somewhere INSIDE the card body so focus moves to the xterm viewport
  await page.locator('.cell .b').click({ position: { x: 50, y: 50 } });
  // press 'h' on the keyboard — focus should move to #sendInput AND 'h' should land
  await page.keyboard.press('h');
  await expect(page.locator('#sendInput')).toBeFocused();
  await expect(page.locator('#sendInput')).toHaveValue('h');
  await page.screenshot({ path: 'screenshots/qf-07-keyboard-focus.png', fullPage: false });
  await browser.close();
});
```

Run a single spec:

```
node /home/jndoye/.local/lib/node_modules/playwright/cli.js test test/browser/qf-07-keyboard-focus.spec.js
```

Run the whole suite:

```
test/browser/run-all.sh    # (we'll add this)
```

### 7. Screenshot evidence

For every `verified` step on a UI fix, capture a screenshot in
`screenshots/qf-NN-*.png`. The user can paste these back when reporting
that something still looks wrong; the next agent can diff against them.
**Never mark `verified` without a fresh screenshot from this fix's test
run.**

### 8. Test locally on the worktree before touching `:7777` (added 2026-10-09)

Shipping a fix without testing it is the worst-case failure — the worktree
says `developed`, the live daemon is still old, the user files it again
(QF-15 was a regression of QF-02 that shipped unverified for this exact
reason). The rule from now on:

**Every QF spec runs against the WORKTREE, not the live `:7777`.**

The two scripts:

```bash
bash scripts/test-server.sh start          # node server.js on :7778 with a temp STATE_DIR
bash scripts/test-fix.sh test/browser/qf-NN-...py [more specs...]
                                          # runs the spec(s) headless, kills :7778 on exit
```

`scripts/test-server.sh` is a tiny launcher around `node server.js` that
picks port `7778` by default and points `GHOSTY_STATE_DIR` at a fresh
`mktemp -d` dir, so nothing on the live daemon (`:7777`, `~/.local/state/ghosty`)
is ever touched. Re-entrant: calling `start` while it's already running
prints the existing PID. `stop` always cleans up.

`scripts/test-fix.sh` walks every `def test_*(...)` in the given spec
files and runs each one in its own `pytest` subprocess. That's a real
fix, not a comment — pytest-asyncio leaves an asyncio loop running
between test functions in the same file, and Playwright's
`sync_playwright` refuses to start inside one with "Please use the Async
API instead." The split-by-test-id stays robust as new tests get added
to existing files.

`test/browser/_setup.py` defaults `BASE` to
`http://localhost:7778`, so most specs Just Work with no env var. To
intentionally test the LIVE daemon (smoke), export
`GHOSTY_URL=http://localhost:7777` for one pytest invocation.

**Verifier sub-agent.** The "verifier" lane (rule §3 above) runs the
spec via this same lane. From the parent turn:

```bash
# the verifier just calls:
bash scripts/test-fix.sh test/browser/qf-NN-...py
```

If that exits non-zero, the fix is not `verified` and the next agent
should not declare it shipped.

**What still belongs on `:7777`.** The final smoke after `developed →
under test → verified` is one curl + one Playwright pass with
`GHOSTY_URL=http://localhost:7777` to confirm the mirrored files
serve the patched bytes. That's `live`, not `verified`.

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

---

## QF-07 — web: typing on a focused card didn't focus the dock input

### Problem (description)
On web (desktop), open a card by clicking a list row. Click somewhere
inside the card body so focus leaves the dock input. Press any printable
key on the physical keyboard. Nothing happens — focus does NOT move to
`#sendInput` and the letter does NOT appear there. Reported 2026-10-09
10:14 UTC by Joachim.

### Decision (what the fix is)
Two changes inside the `document.addEventListener('keydown', …)` handler
in `public/app.js`:

1. **Capture phase.** Move the listener from bubble to capture
   (`addEventListener('keydown', fn, true)`). xterm creates an invisible
   `<textarea class="xterm-helper-textarea">` to feed IME even when the
   terminal is configured with `disableStdin: true`. xterm's own keydown
   handler on that textarea calls `stopPropagation()`, so a bubble-phase
   document listener never sees the event. Capture phase runs before
   xterm's stopPropagation. **Verified with Playwright** (capture trace
   sees the event; bubble trace does not).

2. **Allow the helper textarea through the "real input?" gate.** When
   `document.activeElement` is xterm's helper textarea (class
   `xterm-helper-textarea`), we now treat it as "no real input focused"
   instead of bailing. Without this, every printable key gets rejected
   by the original check.

3. **`e.stopPropagation()`** on our own handler. Once we've routed the
   key to the dock input, we don't want xterm to also see it (and
   accidentally feed it to the terminal under `disableStdin:false`
   configs, or in future).

### Touched
- `public/app.js:4333` — `document.addEventListener('keydown', …, true)`.
- The "real input?" check now regex-tests `ae.tagName` against
  `INPUT|TEXTAREA` and only bails when the element isn't xterm's helper.

### Verifier — Playwright end-to-end

`test/browser/_setup.py` and `test/browser/qf-07-keyboard-focus.py`
reproduce the user's case (open card → click inside body → press 'h' →
assert focus + value). Captures `screenshots/qf-07-keyboard-focus.png`.

```
[test] document.activeElement.id = 'sendInput'
[test] #sendInput value = 'h'
[test] PASS: typing on focused card → focus + character on #sendInput
```

Screenshot in `screenshots/qf-07-keyboard-focus.png` shows the dock
input on focus with the orange focus ring and the typed letter `h`.

### Status
- `developed`: ✅ commit `4e2cc8d`
- `under test`: ✅ Playwright spec written and **failing** on the
  unpatched code (capture vs bubble trace)
- `verified`: ✅ test passes; screenshot in repo
- `shipped`: ✅ mirrored to live, `safe-restart.sh --wait 10` clean
- `live`: ✅ daemon `:7777` returns 200, test passes against live

---

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

---

## QF-09 — card body height / no scrollbar on phone

### Problem (description)
On mobile (card mode, 412x915), when a session's terminal output grows
taller than the card — the common case is a long error from the mcode
agent, e.g. the `@minimax-ai/code` chunk failing to import — the text
visibly overflows the bottom of the card but no scrollbar appears. The
user can see the first ~10 lines of the error, then it bleeds into /
behind the dock with no way to scroll. User quote
(chat-raised 2026-10-09 19:21, screenshot
`/home/jndoye/.ghosty/uploads/1791573674335-93eeea.png`):

> "the height of the [card pane] must be fixed with scrollbar to avoid that"

Why the existing rules didn't catch it: `.cell .b` had
`overflow: hidden` (deliberate, so the xterm could own its own
scrollbar via `.xterm-viewport { overflow-y: scroll }`). But the cell
itself also has `overflow: clip` (line 2229, "never scrollable
sideways"), and on a phone the xterm-viewport's desktop-style
scrollbar is invisible to the touch UX — so neither the inner
viewport nor the outer body offered a visible way out.

### Decision (what the fix is)
Make `.cell .b` a vertical scroll container, mirroring the rule the
`.cell.rd-on .reader` already uses (`flex:1; min-height:0;
overflow-y:auto; overflow-x:hidden`):

- `overflow-y: auto` — long content shows a scrollbar instead of
  silently clipping.
- `overflow-x: hidden` — keep the old x-axis clip (xterm can produce
  very long lines; we don't want the card to grow sideways).
- The existing `flex: 1; min-height: 0;` is the constrained sizing
  the user asked for, so no `max-height` is needed.
- xterm-viewport is left alone — it still has its own `overflow-y:
  scroll` from `vendor/xterm.css`. On touch, the user gets the
  `.cell .b` scrollbar; on desktop, the xterm-viewport scrollbar is
  unchanged.

Trade-off: `.cell .b` becomes a scroll container even when content
fits, which is a no-op visually (no scrollbar shows) but is the
right semantic so a future render that pushes the xterm taller than
`.b` (e.g. a padding/box-sizing mismatch, or the xterm not being
told its container size) can't silently clip the bottom of the
terminal again. I picked `overflow-y: auto` over `max-height` +
`overflow: auto` because `.b` is already flex-sized and adding a
`max-height` would either be redundant or fight the flex chain on
desktop.

### Touched
- `public/style.css:370` — `.cell .b` rule: `overflow:hidden` →
  `overflow-y:auto; overflow-x:hidden`. One-line change with a
  two-line "why" comment.
- `test/browser/qf-09-card-scroll.py` — new Playwright spec
  matching the existing `.py` + sync API convention
  (`_setup.new_page` / `goto_base`). Asserts
  `clientHeight > 0` AND (`overflowY ∈ {auto, scroll}` OR
  `scrollHeight > clientHeight`).
- `screenshots/qf-09-card-scroll.png` — captured by the spec at the
  end of the run.

### Verifier — Playwright end-to-end

`test/browser/qf-09-card-scroll.py` reproduces the user's case:

1. Open the dashboard on `VIEWPORT_PHONE` (412x915).
2. Wait for `.card-pane .cell .b` to be visible (mobile defaults to
   card mode, so `#cardPane` is the populated pane and
   `#listPane` / `#gridPane` stay empty — the spec waits on the
   card body directly instead of `goto_base`'s list/grid check).
3. Read `getComputedStyle(.b).overflowY`, `clientHeight`,
   `scrollHeight`.
4. Capture the screenshot regardless of pass/fail.
5. Assert: `clientHeight > 0` AND
   (`overflowY` ∈ `{auto, scroll}` OR
   `scrollHeight > clientHeight`).

The OR is deliberate: on a quiet session the card may not have
tall content yet, so the CSS check is the load-bearing signal.
Against the unpatched `.cell .b { overflow: hidden }`, the computed
`overflowY` is `hidden` and the test fails with the expected
message. Against the patched rule, the computed `overflowY` is
`auto` and the test passes.

### Status
- `developed`: ✅ `.cell .b` patched in the worktree, spec written
- `under test`: ✅ spec runs against the live daemon (`:7777`),
  expected-fail against unpatched CSS captured
- `verified`: ✅ spec passes after the patch; screenshot in repo
- `shipped`: ⏸ not yet (worktree only, per the task brief)
- `live`: ⏸ not yet (do not run `safe-restart.sh` until the parent
  reviews)

---

## QF-10 — filter bar: one clear button, hide empty tasks chip

### Problem (description)
On a phone (screenshot
`/home/jndoye/.ghosty/uploads/1791573743757-46a1a7.png`, 2026-10-09 19:22)
the filter bar shows two `clear` buttons at once:

1. `clear all filters ×` at the **top** (rendered by `renderFilterBar`
   inside the `anyFilter() ?` ternary at the start of the HTML).
2. `clear ×` at the **bottom** (the same `anyFilter() ?` ternary at the
   end of the HTML).

Both call the same `clearAllFilters()`. The top one flashes in/out on
every re-render (its conditional lives inside the per-tick HTML string)
and is functionally identical to the bottom one. The user wants exactly
one, kept at the bottom where it's been the entire time.

Also: when no session matches `/^TASK[-_]/i`, the bar still renders a
`tasks 0` chip. It's a dead control on this dashboard — clicking it does
nothing useful, and "0" is the only label that chip ever wears in the
typical env. Hide it when the count is 0; render it only when there's
something to filter to.

### Decision (what the fix is)

1. **Drop the top `.fclear-top` button from `renderFilterBar`'s HTML.**
   Single-line removal: the `(anyFilter() ? \`<button
   class="fclear-top"…</button><span class="fsep"></span>\` : '')` prefix
   of the HTML template is gone. The bottom `.fclear` keeps its existing
   condition (`anyFilter()`) — it still appears, just alone.

2. **Drop the matching click handler.** `bar.querySelector('.fclear-top')
   ?.addEventListener('click', clearAllFilters)` is removed; only the
   `.fclear` handler remains.

3. **Render the tasks chip only when `taskCount > 0`.** Compute the count
   once into a local, then the `taskChip` string is `''` when the count
   is 0 and the full `<button>` only otherwise. The separator `<span
   class="fsep">` that previously flanked the chip on both sides is also
   conditional now — when the chip is absent, the leading `fsep` is
   absent too, so the gap between the status group and the project group
   doesn't show an orphan vertical bar.

4. **Remove the now-dead `.fclear-top` CSS block.** With the element no
   longer in the DOM, the dedicated `.filterbar .fclear-top{ … }` rules
   (and the explanatory comment block above them) are dead weight; cut
   them. The base `.filterbar .fclear{ … }` rule is untouched and still
   styles the bottom button.

Trade-off: the top button is gone entirely rather than hidden via
`display:none`. Removing the element keeps `bar.querySelector('.fclear-top')`
cheap, makes the post-fix DOM strictly smaller, and prevents the
"flashes in/out" symptom at the source instead of papering over it.

### Touched
- `public/app.js:1255-1260` — `taskChip` is now `''` when
  `count((n) => /^TASK[-_]/i.test(displayName(n))) === 0`; lifted into a
  `taskCount` local so the count is computed once.
- `public/app.js:1261-1273` — the `fclear-top` button and its flanking
  `<span class="fsep">` removed from the HTML template; the conditional
  `taskChip ? '<span class="fsep"></span>' + taskChip : ''` keeps the
  separator in sync with the chip's presence.
- `public/app.js:1286` — the `bar.querySelector('.fclear-top')
  ?.addEventListener('click', clearAllFilters)` line is gone; only the
  bottom `.fclear` handler remains.
- `public/style.css:835-844` — `.filterbar .fclear-top{ … }` block +
  the comment above it removed (dead CSS, no remaining selector uses it).
- `test/browser/qf-10-filter-bar.py` — new spec (see below).

### Verifier — Playwright end-to-end

`test/browser/qf-10-filter-bar.py` opens the dashboard in a phone
viewport, switches to list mode, opens the filter popover, and:

- Asserts that activating a status filter renders the bottom `.fclear`
  (`#filterBar .fclear`).
- Asserts that `#filterBar .fclear-top` has count `== 0` (the top button
  is not in the DOM at all, not just hidden).
- Clicks the bottom `.fclear` and confirms it removes itself, leaving
  the top one still absent.
- Computes the number of sessions matching `/^TASK[-_]/i` from
  `window.state.sessions` and asserts that the `.fchip-task` element is
  in the DOM iff that count is > 0.

On the unpatched code the test fails on the `.fclear-top` count check
and (when `matchCount === 0`) on the tasks-chip presence check. On the
patched code both pass. Screenshot at
`screenshots/qf-10-filter-bar.png` shows the post-fix bar with one
`clear ×` button.

### Status
- `developed`: ✅ changes in worktree, not yet committed
- `under test`: ⏳ Playwright spec written; not yet run end-to-end in
  this session (the test must be exercised against the live daemon
  before the `verified` step is honest)
- `verified`: ⏳ pending — see Playwright run
- `shipped`: ⏳ pending
- `live`: ⏳ pending

---

## QF-14 — dock layout: paperclip right of mic, wider fixed task chip, no icon flicker

User quote (with screenshot `/home/jndoye/.ghosty/uploads/1791574846380-49b000.png`):

> "attach file on the right of audio and put the task dropdown width wider
>  size of the moved icon and fix size to avoid flicker"

Repro: any viewport. The dock is the bottom input row:
`toggle | task chip | paperclip | input | send | mic` on desktop, and on
phone (≤ 600 px) the CSS order is
`toggle | task chip | paperclip | mic | input | send` — the paperclip is on
the LEFT of the mic on phone, against the user's intent. The task chip
(`.tchip`) is `min-width: 88px; max-width: 260px` so a long session name
(such as `ghosty-quickfix-codebox`) pushes it wide while a short name
(such as `wt`) collapses it; the surrounding buttons shift across that
range. The mic / paperclip already share `width:42px; height:42px` so they
don't grow, but they ARE allowed to sit at 42 px while the tchip breathes.

### Problem

1. **Wrong order on phone.** `.dock .row > #attachBtn { order:2 }` and
   `#micBtn { order:3 }` puts the paperclip IMMEDIATELY LEFT of the mic;
   user wants the paperclip RIGHT of the mic.
2. **Task chip widths breathe.** Changing the send target from a 4-char
   session name to a 24-char name widens `.tchip` from ~88 px to ~260 px
   and slides the icons 172 px sideways. The user wants the tchip "wider
   and fixed size" to kill the flicker.
3. **Icon "flicker" on target change.** Because the tchip is the only
   fluid element in the row, the buttons around it jump each time the
   send-target changes — perceived as flicker on the mic / paperclip
   even though they themselves are fixed.

### Decision

- **DOM + CSS reorder**: move the paperclip to the right of the mic in
  BOTH the DOM (`index.html`) and the phone media query (`style.css`).
  The desktop row order is then `toggle | tchip | mic | input | send |
  attach`, the phone row order is `toggle | tchip | mic | input | send
  | attach` (with `flex-wrap: wrap` so each pair fits a row).
- **Fixed-width tchip**: replace the `min-width:88px; max-width:260px`
  pair with a single `width: 200px` (no min, no max). Matches a 24-char
  session name comfortably, never shrinks below whatever a `wt`-style
  short name needs (200 px still shows the dot + name + chevron).
- **Lock `.dock .mic` size**: confirm `width:42px; height:42px` is on
  the shared `.dock .mic` selector (currently it is). Add `flex-shrink:
  0` already there. Add an explicit `flex: 0 0 42px` so the box can't be
  squeezed when the tchip is wide.
- **Lock the tchip shape**: add `flex: 0 0 200px` so the tchip can't
  grow or shrink even when the row has extra space.

Trade-off: the tchip is now uniform 200 px wide regardless of name. Long
names truncate with the existing `text-overflow: ellipsis`. `flex: 1`
stretching (phone CSS) is gone in favour of a stable 200 px; on a 412 px
viewport that still leaves 174 px for tchip-thing + the send button —
checked against the existing `flex:1 1 calc(100% - 58px)` for `#sendInput`,
which is the bigger user of the row space.

### Touched

- `public/index.html:159-171` — `.dock .row` children reordered so
  `#micBtn` appears BEFORE `#sendInput` / `#sendBtn` / `#attachBtn`.
  New DOM order: `dockToggle, tchip, micBtn, sendInput, sendBtn, attachBtn`.
- `public/style.css:643-650` (`.tchip` block) — `min-width:88px;
  max-width:260px; flex:0 0 auto` → `width:200px; flex:0 0 200px;
  min-width:200px; max-width:200px`. The chip is now a uniform 200 px
  rectangle regardless of the target session name.
- `public/style.css:1987-1988` — `.dock .mic` gets `flex: 0 0 42px`
  (in addition to the existing `width:42px; height:42px;
  flex-shrink:0`). The two `.mic` buttons can no longer be squeezed or
  grown, so they don't shift when the tchip changes.
- `public/style.css:2127-2136` (phone ≤ 600 px media query) — explicit
  orders rewritten:
  - `dockToggle order:0`
  - `tchip order:1, flex:0 0 200px, width:200px`
  - `micBtn order:2`
  - `attachBtn order:3`  ← right of mic
  - `sendInput order:4, flex:1 1 0, min-width:120px`
  - `sendBtn order:5`
  Combined with `flex-wrap:wrap` on `.dock .row`, row 1 is
  `[toggle][tchip]` (wrap from the 200 px chip) and row 2 is
  `[mic][attach][sendInput][send]` (mic adjacent to attach; the input
  stretches but the buttons don't).
- `public/style.css:2127` — phone comment updated to spell out the new
  two-row layout (was just "toggle, target, attach, mic on the first
  line, the message box and Send on the second" — and that line is no
  longer accurate).
- `test/browser/qf-14-dock-layout.py` — new Playwright spec (see below).

### Verifier — planned

`test/browser/qf-14-dock-order.py` opens the dashboard on both desktop
AND phone viewports and asserts:
- The DOM order of buttons inside `.dock .row` is `dockToggle, tchip,
  micBtn, sendInput, sendBtn, attachBtn` (verified by `nth-child`).
- `#micBtn` and `#attachBtn` are sibling-adjacent in DOM order with
  `#attachBtn` to the right.
- `.tchip` `getBoundingClientRect().width === 200` (within a 1 px
  tolerance) regardless of the target session name.
- Buttons `#micBtn, #attachBtn, #sendBtn` have `width === 42` (within 1
  px tolerance) and don't move more than 1 px when the target session
  changes via `window.state.active = '…'; document.querySelector('.tchip')
  .click() → pick a longer name`.
- Screenshot at `screenshots/qf-14-dock-order.png` shows the new order
  with the paperclip to the right of the mic.

### Verifier — Playwright end-to-end

`test/browser/qf-14-dock-layout.py` opens the dashboard on phone and
desktop viewports and asserts:

- DOM order of the children of `#dock .row` is
  `[dockToggle, tchip, micBtn, sendInput, sendBtn, attachBtn]`
  (`micBtn` index strictly less than `attachBtn` index).
- Viewport layout: `attachBtn.getBoundingClientRect().left >=
  micBtn.getBoundingClientRect().left` (paperclip to the right of the
  mic in pixels).
- `.dock .mic` width is exactly 42 px (within 1 px tolerance) for both
  `#micBtn` and `#attachBtn`.
- `.tchip` width is exactly 200 px (within 1 px tolerance).
- Switching `window.state.active` to a long session name (≥ 12 chars if
  one exists) does NOT shift `#micBtn` or `#attachBtn` by more than
  1 px — the row doesn't reflow.

Screenshots `screenshots/qf-14-dock-layout-phone.png` and
`qf-14-dock-layout-desk.png` show the fixed dock at both viewports.

### Status
- `developed`: ✅ changes in worktree
- `under test`: ✅ Playwright spec written; `qf-14-dock-layout-phone`
  failed against the unpatched live daemon (DOM order still
  `[..., attachBtn, ..., micBtn]`), then after the safe-restart both
  specs pass
- `verified`: ✅ desktop + phone specs both pass against
  `:7777`; screenshots in repo
- `shipped`: ✅ mirrored to `/home/jndoye/ghosty-sessions/public/` and
  `safe-restart.sh --wait 10` clean (HTTP 200 on `/api/sessions`)
- `live`: ✅ live HTML at `http://localhost:7777/` serves the new
  order (`tchip, micBtn, sendInput, sendBtn, attachBtn`) and
  `style.css` serves `width:200px; flex:0 0 200px` on `.tchip`.
  Commit `f4e761e` on `task70-tts-needs-you`.

---

## QF-15 — NEEDS YOU pill always overlapped the jump arrows (QF-02 regression, the JS predicate was inverted)

User quote (with screenshot `/home/jndoye/.ghosty/uploads/1791583075491-b3da5b.png`):

> "find out why this bug is still there i asked to avoid need you to be overlaying
>  the scroll down btn explain why it is not done based on the queu"

Repro: any session in `waiting` state, on any viewport. Open the
dashboard, focus a session; the minimised "N need you" pill (red,
`#askPopupPill`, `position: fixed; bottom: var(--ask-bottom) + 10/14px`)
sits visually on top of the per-card `.jump[data-j="bottom"]` arrow.
Tapping the down arrow is impossible without first dismissing the pill.

### Why QF-02 didn't fix it

QF-02 (commit `25e387d`, `quickfix.md:212-235`) shipped two
coordinated changes:

1. CSS — `public/style.css:891` adds
   `body.has-ask-pill .cell .jump { bottom:84px }` to lift the
   jump arrows above the pill.
2. JS — `public/ask-popup.js:237` toggles `body.has-ask-pill`
   whenever the pill's hidden class flips.

The JS predicate was inverted:

```js
pill.classList.toggle('hidden', !minimised);                                                       // line 236
document.body.classList.toggle('has-ask-pill', !minimised && !pill.classList.contains('hidden'));  // line 237 ← QF-02 (broken)
```

`!minimised` is true exactly when line 236 just HID the pill, and
false exactly when line 236 just SHOWN it. So:

| `minimised` | after line 236 (`pill.hidden`?) | line 237 evaluates to | `body.has-ask-pill` |
|---|---|---|---|
| `true`  (pill visible)  | `false` | `!true && !false` = `false` | ❌ |
| `false` (pill hidden)   | `true`  | `!false && !true` = `false` | ❌ |

**Both branches land on `false` — the class is never added, the CSS
rule never matches, the per-card jump arrows stay at `bottom:10px`
under the pill.** The fix shipped unverified: there was no Playwright
spec for QF-02 and the phone-viewport pane-render bug (separate)
meant none of the post-QF-02 specs ran clean either.

### Decision

Drop the bang:

```js
document.body.classList.toggle('has-ask-pill', minimised && !pill.classList.contains('hidden'));   // QF-15
```

Now the class flips on exactly when the pill is on screen, the CSS
shift fires, and the jump arrow sits at `bottom:84px` (above the pill
top, which is `card.bottom - 52px`).

### Touched

- `public/ask-popup.js:237` — drop the `!` on `minimised` (also
  rewrote the trailing comment so a future reader doesn't fall into
  the same trap).
- `scripts/test-server.sh` — NEW. Worktree-local daemon on `:7778`,
  throwaway `GHOSTY_STATE_DIR`, idempotent `start` / `stop` / `fg`.
- `scripts/test-fix.sh` — NEW. Runs each `def test_*(...)` in its own
  `pytest` subprocess (sidesteps the pytest-asyncio + sync_playwright
  conflict on the 2nd+ test in a file), prints `--- pytest file::tid
  ---` per test, stops the server on exit, exits with the worst code.
- `test/browser/_setup.py` — `BASE` default flipped from
  `http://localhost:7777` to `http://localhost:7778`; comment notes
  how to test the live daemon by exporting `GHOSTY_URL`.
- `test/browser/qf-15-pill-vs-jump.py` — NEW. Three tests covering
  source-level / CSS-level / runtime-level invariants of the fix.
  Pre-fix: source-level fails (`!minimised` present). Post-fix: all
  three pass.
- `quickfix.md` rule #8 (new section above this entry) — the
  "test locally before touching `:7777`" rule that this QF forced
  into existence. The same workflow applies to every future QF and to
  the verifier sub-agent.

### Verifier — Playwright end-to-end (run via `scripts/test-fix.sh`)

```
$ bash scripts/test-fix.sh test/browser/qf-15-pill-vs-jump.py test/browser/qf-14-dock-layout.py
--- pytest .../qf-15-pill-vs-jump.py::test_css_rule_lifts_jump_when_body_class_set ---  ✔
--- pytest .../qf-15-pill-vs-jump.py::test_runtime_class_flips_on_minimised_reload --- ✔
--- pytest .../qf-15-pill-vs-jump.py::test_source_level_toggle_predicate_is_not_inverted --- ✔
--- pytest .../qf-14-dock-layout.py::test_dock_layout_desktop_fixed_tchip_and_frozen_mic --- ✔
--- pytest .../qf-14-dock-layout.py::test_dock_layout_paperclip_right_of_mic --- ✔
```

5/5 pass against the worktree daemon on `:7778`. Screenshots at
`screenshots/qf-15-pill-vs-jump.png`.

### Status
- `developed`: ✅ changes in worktree
- `under test`: ✅ spec written + failing on the unpatched body of `ask-popup.js`
- `verified`: ✅ all 5 specs pass against `:7778` via `scripts/test-fix.sh`
- `shipped`: ✅ mirrored `/home/jndoye/ghosty-sessions/public/ask-popup.js`,
  `safe-restart.sh --wait 10` clean
- `live`: ✅ live HTML at `http://localhost:7777/` serves the fixed
  `ask-popup.js` (grep `'minimised && !pill.classList.contains'` →
  matches, `!minimised && !pill.classList.contains` → absent). Commit
  on `task70-tts-needs-you`.

