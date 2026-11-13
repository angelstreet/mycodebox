# Review: the stb3 variant session's hour (2026-11-13)

Owner request: the Mac Remote Control session "STB3 variant selection in Open_Exit_App_quick"
(`mac:STB3-variant-selection-in-Open_Exit_App_quick-b67b11`, branch `claude/stb3-variant-selection-802519` in VirtualPyTest) took about an hour
for three small frontend edits: the Quick Test Key default, the Inputs dialog field height, and the stb3 variant default. Why, and what in
the harness removes it?

**Sources.** Harness facts: the integration journal (`<state>/integration/requests.jsonl`, the step times of each request),
`manager-events.jsonl`, `stalls.jsonl` (stops, routing, peer messages, stop-answer reminders), `manager-actions.jsonl`, and the VirtualPyTest
`git log` of `origin/main`. The session's own timeline, received by SendMessage at 11:58 UTC, is marked **(est.)** wherever it gives no
clock. All times are UTC (Paris = UTC+1).

## Timeline

| Time (UTC) | What | Source | Lasted |
|---|---|---|---|
| ~10:45 | Session starts; finding the code: Quick Test has no page of its own (it reuses the Test Builder and `InterfaceVariantSelector`), and a first grep missed | session (est.) | ~10 min |
| 11:08:03 | **int-1a1d497d** queued, with `--deploy frontend`, before the commit existed: the commit `e3b8b9d` is stamped 11:08:10, and the Mac pipe-guard hook swallowed the first commit/push | journal, git | — |
| 11:08:05–11:10:44 | The lane finds the branch tip already in main (`alreadyMerged`), skips the merge and **still deploys main**. Its result reads "merged … into main at 52e5cf4f8ede" (another branch's merge) | journal | 2m41s wasted |
| 11:10:20 | **int-1a1d499e** (variant default + compact dropdowns): queued, 60 s settle, merge, tests 17 s, frontend deploy 1m24s; deployed 11:13:20 | journal | 3m00s |
| ~11:10–11:35 | Verification set-up: no local Playwright (installs `playwright-core` in the scratchpad, 15 min); then which server shows stb3: the main server does not list it, rpitest has the API but no frontend (10 min) | session (est.) | ~25 min |
| 11:17:58 | **int-1a1d4a0e**: the variant-selector unit test (`b1e5088`), a request of its own, merged 11:19:45 without a deploy | journal | 1m47s |
| 11:19:57 | **Ask 1** (`needs-manager`): "stb3 lives on the vpt-pi1 server … options: 1 you or the manager check it on stb3 / 2 …" | manager-events | — |
| 11:25:49 | **int-1a1d4a81** (Key default + dialog padding, `ca74e0b`): queued 2m25s behind other repos' requests; merged 11:29:00; deployed 11:31:36 | journal | 5m47s |
| 11:30:38 | Stop-answer reminder queued for the manager (10 min grace, `stop-answer.js`); delivered 11:35:40, when the manager came back from disk cleanup and the MiniMax quota | stalls | — |
| 11:31:49 | **Ask 2**: "deployed but not seen in a browser … 1 you confirm on stb3 / 2 I find the vpt-pi1 server URL and check it" | manager-events | — |
| 11:36:19 | **Manager answers asks 1 and 2**: "option 2, … check it yourself headless (vpt-headless-verify) on the vpt-pi1 server" | stalls (peer) | ask 1: **16m22s**, ask 2: 4m30s |
| ~11:34–11:38 | Server picker found ("Awesomation" → vpt-pi1); the **stb3 chip is verified** headless: `dcx960-02.04`, Key shows `{exit_key}` = BACK | session | ~4 min |
| 11:38:21 | **Ask 3**: "the Inputs dialog field height is not checked because stb3 is locked by another session" (Run needs Take Control; stb3 leased by `mac:parental-pin-tc435` since 11:21) | manager-events | — |
| 11:39:29 | Manager: "option 2: check the height on an unlocked stb of the same server or an equivalent" | stalls (peer) | 1m08s |
| ~11:39 | Searching for a free device: lease CLI syntax errors, a wrapper hook blocked `--help`; claims vpt-pi3/device4 (stb4) | session | ~5 min |
| ~11:40 | Measure 1 on stb4: dropdowns 24 px, text fields 27 px, so edit 1 was incomplete. Two commits (`f91d168` 11:41:10, `b516a00` 11:42:29), one lint-gate bounce | git, session | — |
| 11:43:42 | **int-1a1d4b87**: merged 11:44:53, deployed 11:47:50 | journal | 4m08s |
| 11:48:49 | **int-1a1d4bd2**: queued **before the next commit was pushed** (`69e45f9` is stamped 11:54:33). The branch tip `b516a00` was already in main (`alreadyMerged: true`); the lane deployed main again (11:52:42), with nothing of the session's. The session's "measure 2" (22/22/24/24) read a deploy that had no new code of its own | journal, git | 3m53s wasted |
| ~11:53 | Measure 3 reads computed styles: the select `padding: 3px` / `min-height: 0` rule overrides the fix. The root cause is found only now | session | — |
| 11:55:35 | **int-1a1d4c35** (`69e45f9`, height on `.MuiInputBase-root`): merged 11:56:53, deployed 11:58:51 | journal | 3m16s |

Seven integration requests for three edits: five carried code, one was the unit test alone, and **two carried nothing** (int-1a1d497d,
int-1a1d4bd2), yet both deployed. Lane time: 24m32s in all, of which 6m34s went to the two empty requests.
The stb3 lock itself cost **0 min**: the session went around it with a free stb4, as the manager said at 11:39.

## Where the hour went (slices)

The slices overlap: the session kept editing while the lane deployed and while ask 1 waited. Minutes are wall-clock, each attributed to its
main slice. "(est.)" means the session's own estimate.

| Slice | Minutes | Evidence |
|---|---|---|
| Verification set-up: Playwright install, which server shows stb3 | **~25** (est.) | session; the stb3 chip was finally read at ~11:38 |
| Rework: guess-and-deploy on a CSS height instead of reading computed styles first | **~19** (11:40 → 11:58:51) | 3 deploy cycles (int-1a1d4b87, int-1a1d4bd2, int-1a1d4c35) for one CSS property |
| Test + deploy wait (lane), real requests | **18** (17m58s) | journal: 60 s settle per request; frontend deploys 1m24s–2m36s; no CI wait (frontend scope) |
| Asks and answers | **16** (ask 1, 11:19:57 → 11:36:19) | the answer was the standing rule ("verify it yourself headless"). Asks 2 and 3: 4.5 min and 1 min |
| Empty requests: the pipe-guard hook swallowed a push, and a request was sent before its commit was pushed | **~14** (6m34s lane + ~10 min rework, est.) | int-1a1d497d, int-1a1d4bd2 (`alreadyMerged`) |
| Real edit work | ~15 (est.) | 6 commits, each 5–42 changed lines |
| Finding the code | ~10 (est.) | session |
| Finding a free equivalent device (lease CLI) | ~5 (est.) | session |
| Wait on the stb3 lock | 0 | worked around on vpt-pi3 stb4 |

## Causes

1. **No ready recipe to see a UI change on a lab device from a Mac** (~25 min). Playwright was not installed, and nothing told the session
   that stb3 lives on the vpt-pi1 server and that the picker (top left) switches to it. The answer exists only in skills the session had to
   find (`vpt-headless-verify`, `vpt-device-control`).
2. **Guess-and-deploy instead of measuring first** (~19 min). The first measure showed 27 px against 24 px. The cause (a select padding /
   min-height rule) was visible to `getComputedStyle` at that moment, but the session shipped two guesses through the lane before reading it.
   Each lane cycle costs 3–6 min, so a guess loop on a deployed build is the most expensive way to tune CSS. A local Vite build against the
   live backend (`frontend-worktree-e2e`) would have taken seconds per try.
3. **Each tiny edit was its own integration with its own deploy** (18 min). The lane worked as designed (60 s settle, about 2 min per
   frontend deploy), but seven requests for three edits multiplied it. The unit test went in a request of its own.
4. **The ask went to the manager although the rule already answered it** (16 min). Ask 1 offered "you or the manager check it on stb3".
   The manager was busy (disk cleanup, MiniMax quota) and saw the ask only through the 10-minute stop-answer reminder. Its answer was the
   standing rule: verify it yourself, headless.
5. **Requests with nothing new were accepted, deployed, and reported as "merged"** (~14 min). The lane's text "merged <branch> into main at
   <sha>" named the target's sha, which belonged to another branch's merge. After int-1a1d4bd2, the session believed fix 3 was live and
   measured a build that did not contain it.
6. Finding a free equivalent device took ~5 min (lease CLI syntax, a hook blocked `--help`). This is at the 5-minute line, so it was filed
   as an idea, not built.

## What changed (this branch, mycodebox)

| Cause | Change | Test |
|---|---|---|
| 5 | `integrate request` (client scripts v4) refuses a branch that has local commits origin does not have ("N commit(s) on <branch> are not pushed: git push origin <branch>"), and a branch that is not on origin, **before** anything is queued. It prints a note when the worktree has uncommitted changes. `--no-push-check` / `INTEGRATE_NO_PUSH_CHECK=1` skips the check. Both empty requests of this hour would have been refused at the prompt. Macs pick it up with `integrate self-update`; every request already prints that hint when the client is older than the server | `test/integration-routes.test.js` "CLI: a branch with unpushed commits…" |
| 5 | The lane's result for a branch already on the target now starts with **"nothing new: <branch> at <its sha> is already in main, no commit of yours was merged (just committed? push the branch …)"**, and a deploy says "redeployed main … with no new code of yours". It no longer says "merged <branch> at <another branch's sha>". This text is used by the wake message, the Mac external result, `integrate status` and the feed | `test/integration-routes.test.js` "describe: a branch already on the target…" |

## What did not change, and why (filed ideas)

| Cause | Idea | Filed |
|---|---|---|
| 1, 2, 3 | `vpt-headless-verify` and the VirtualPyTest ship rule: a one-line Mac Playwright set-up, the device → server map ("stb3: vpt-pi1, picker top left"), device-agnostic UI checked on any free equivalent device, `getComputedStyle` before a CSS fix, a local Vite e2e before any deploy, and one integration for a batch of tiny frontend edits. These live in the skills repo and VirtualPyTest `AGENTS.md`, not here | bug-871ddc70 |
| 4 | Answer "shall someone else look at the UI?" `needs-manager` stops at once with "verify it yourself headless" (a rule answer, or a shorter grace for this kind of ask). `needs_manager` is never auto-answered by owner rule (TASK142, 2026-10-20), so this is the owner's call | bug-11dc9e74 |
| 6 | `vpt-lease`: "free equivalent of <host>/<device>" in one call, and `--help` not blocked by the Mac wrapper hook (proxmox / Mac, not this repo) | bug-0103d12e |
| 3 | Not changed: the lane's 60 s settle and the frontend deploy time. The settle is what coalesces a burst of requests from one branch. The cure for this hour is fewer requests (cause 2 and the idea above), not a faster lane | — |

## Unverified

- Every "(est.)" line comes from the session's own account, with no harness clock: start ~10:45, the 25 min of verification set-up, the
  10 min of code finding, the ~15 min of real edit work, and the ~5 min lease search.
- The session places its stb3 chip check at 11:34–11:38. The manager's answer that told it to check is stamped 11:36:19, so it may have
  started before the answer. Not resolved.
- The final 24 px height after int-1a1d4c35 (deployed 11:58:51) is the session's own check (re-measure on vpt-pi3 stb4). It had not
  reported the result when this review was written.
- The new client check runs on a Mac only after `integrate self-update`. Which Macs have updated was not checked.
