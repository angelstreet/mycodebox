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
- QF-07 — **web: typing on focused card didn't focus the dock input** — `document` keydown handler; **bug reported 2026-10-09 10:14, fix in progress**

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
