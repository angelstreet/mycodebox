# Token audit, last 48 h (2026-11-26 00:00 to 2026-11-28 00:14 UTC)

Source: `usage-ledger.jsonl` (19.2k rows, errors excluded), the rate-limit files, and, for loops, the Claude transcripts of the window.
Cost is the ledger's API-equivalent price, a proxy for plan burn (the plans weigh models differently). Times in this file are UTC unless Paris is named.
The same numbers are now produced continuously by `usage/waste.js` and `usage/loops.js` (fields `waste`, `perAccount`, `burn`, `loops` of `/api/usage`).

## Per agent and model

| Agent / model | Calls | Context read | Avg ctx | p95 ctx | Cache hit | API cost |
|---|---|---|---|---|---|---|
| Claude (all) | 15,392 | 3,400 M | 221k | 586k | 98.5% | $1,423 |
| Sonnet 5.5 | 7,277 | 1,570 M | 216k | 556k | 98.4% | $437 (31%) |
| Opus 5.5 | 6,963 | 1,463 M | 210k | 617k | 98.3% | $529 (37%) |
| Fable 5.2 | 1,132 | 367 M | 324k | 587k | 99.3% | $456 (32%) |
| MiniMax (M3.1-Flash 1,732 / M3 1,174) | 3,128 | 599 M | 192k | 333k | 98.8% | unpriced |
| Codex (gpt-6.1-sol 280, others) | 630 | 95 M | 150k | 354k | 98.1% | unpriced |

Fable is 11% of the calls and 32% of the cost.

## Per hour (UTC) against the plan

Burn is bursty. 26 Nov 08h to 13h UTC (10h to 15h Paris) is $765, 54% of the 48 h, with a peak of 1,582 calls / $167 in the 10h hour; 27 Nov 17h to 20h is the second peak (about $115). Most nights run $1 to $10 an hour.
Rate-limit files now: default week 100% (resets 28 Nov 15:00 Paris), team1 5 h 95% (resets 03:00 Paris) and week 71% (resets 3 Dec 16:00 Paris), team2 week 75% (resets 30 Nov 13:00 Paris), MiniMax 5 h 2%.
At the average pace of its window team1's week hits 100% in about 14 h, before its reset in 135 h; team2's week in about 36 h, before its reset in 60 h. `burn` in `/api/usage` and the usage page show this per account and for MiniMax.

## Account split

Not in the ledger and not in the transcripts (all accounts share `~/.claude/projects`). Only a running process knows it (`GHOSTY_CLAUDE_ACCOUNT` in its environment). Shipped: the usage tick reads it from the live sessions and keeps a per-session history in `session-accounts.json`, so every session seen alive is attributed from now on, and a swap appends an entry. The 48 h before this change cannot be derived (the account files `.claude.json` / `.credentials.json` are never read, by rule): of 15.4k Claude calls, the 5 sessions alive at the first scan are known (team1 3.0k calls / 1.0 B ctx, default 29), the rest stay `unknown` and shrink as sessions run. Backfill is therefore forward-only.

## Questions a to f

**(a) Context per call.** Avg 221k, p95 586k. Share of context tokens by call size: under 100k 6.9%, 100 to 200k 22.7%, 200 to 400k 37.6%, 400 to 700k 23.2%, over 700k 9.6%: a third of all tokens are re-reads of a context above 400k. Sessions over 300k average (30+ calls): `userinterface-audit` 340k (2,940 calls), `artifact` 319k (816), `nightly-new-stbs-20261126` 381k, `done-reflection-20261126` 458k, `manager-workers-ask-manager-20261126` 357k; together they hold 13% of the context. The manager runs at 164k avg (1,686 calls, 276 M, $69), so it is not the problem you feared; `userinterface-audit` is: 3,700 calls, about 1.05 B context, $341 = 24% of all Claude cost. API cost of the context above 300k per call: $193 = 13.5%.

**(b) Cache.** Overall 98.5%, 52.7 M cache_creation tokens (1.5% of context). Only one session is under 90%: `userinterface-audit` rows on one session at 83% (2.1 M written, $14). `task263-night` is 89.7% over these 48 h with 0.8 M written (your 5.7 M is a longer window); 5-minute-TTL writes are 77 to 81% of the writes in `userinterface-audit`, `mcp-server-audit` and `whiteboard`, so idle gaps over 5 minutes re-write the context instead of re-reading it. Churn is real but small in money terms (about 1 to 2%).

**(c) Subagents.** 30.6% of context tokens and 23.0% of cost are subagent calls (Sonnet subagents 3,151 calls at 246k avg ctx, p95 728k, $209; Opus subagents 1,487, $96). By session: `userinterface-audit` 590 M of 1,046 M (59%), `mcp-server-audit` 292 M of 438 M (67%). Those two are 77% of the subagent tokens.

**(d) Loops and polling.** Transcript scan, same Bash command repeated in one session (8 or more times, numbers normalised): `manager-wait.sh` runs 81, 60, 57, 50, 27, 27, 26 and 20 times in eight sessions (the manager and its workers' wait loop), `integrate status` / `integrate wait` polls (14 and 9) in `userinterface-audit`, `task263-night` runs `night.py ensure/status` 16 times and gets the same "Night check 23:30 UTC" prompt 17 times. No pure test/retest loop reached the threshold of 8 identical test commands in the window. Calls that wrote under 150 tokens on a context over 100k (polling, waiting, acknowledging): 1,670 calls = 10.8% of calls, 9.6% of context, $105 = 7.3% of cost; top: `userinterface-audit` 428 calls / 95 M, `manager` 242 / 37 M, `mcp-server-audit` 169 / 34 M. The idle-polling detector flags `ci-main-red-20261126` (9 of 36 calls) and the manager.

**(e) Big model on small work.** 888 Opus/Fable calls wrote under 150 tokens: $67 (4.7%). Bigger: Fable is $1.24 per M context against $0.28 for Sonnet and $0.36 for Opus (ledger prices); Fable's $456 sits in `artifact` $173, `mcp-server-audit` $171, `userinterface-audit` $80, `choose-suggestions-fable` $17. Opus is the main model of `mcp-server-audit` ($70), `userinterface-audit` ($151), `artifacts` ($67) and `whiteboard` ($37) with 450 to 800 output tokens per call, i.e. ordinary coding turns.

**(f) MiniMax.** 3,128 calls, 599 M cache-read context in the ledger window (the 3.1 B / 18 k turns you quote is a longer window or the sqlite table). Three sessions are 99%: `rtsp-nightly-20261127-0545` 1,104 calls / 247 M, `coc-daily-20261126` 966 / 192 M, `coc-daily-20261127` 766 / 153 M; every call re-reads about 200k to 225k and writes about 500 tokens. 40% of the rtsp-nightly calls (440 of 1,104) and 27 to 33% of the coc-daily calls wrote under 150 tokens: the plan counts calls, so polling calls are the waste (rtsp-nightly alone: 114 M tokens of re-read for almost nothing). The existing `minimax-meter` already alerts on poll loops; they are long-running nightly sessions that never compact (225k avg).

## Top 5 savings, ranked (share of the 48 h API cost; a weekly plan share follows the same ratio when the mix stays)

| # | Saving | Estimate | Who acts |
|---|---|---|---|
| 1 | Fable only for the hard turns: `artifact`, `mcp-server-audit`, `userinterface-audit` run on Opus or Sonnet by default, Fable by exception. Moving two thirds of the Fable calls to Opus saves about $217. | about 15% | manager (model choice) |
| 2 | Compact or restart sessions that sit above 300k: `userinterface-audit`, `artifact`, `nightly-new-stbs`, `done-reflection`. Context above 300k per call costs $193; halving it. | 7% (13.5% ceiling) | manager (restart) |
| 3 | `userinterface-audit` and `mcp-server-audit` subagents: narrower prompts and a context cap (Sonnet subagents average 246k, p95 728k; 77% of subagent tokens). | about 5% | manager / session owners |
| 4 | Waits without the model: `manager-wait.sh`, `integrate wait`, nightly status loops; longer sleeps, fewer wakes. Poll-size calls cost $105; cutting 40%. On MiniMax, 27 to 40% of the calls of the nightly sessions are polls (calls count against the plan). | 3% Claude, about 25% of MiniMax calls | manager / nightly owners |
| 5 | Opus/Fable on sub-150-token turns to Sonnet or Haiku, and 1 h cache TTL for sessions with idle gaps over 5 minutes. $67 of tiny big-model calls plus about 1 to 2% churn. | 2 to 3% | manager (model choice), harness (TTL) |

Together about 30%, with #1 and #2 two thirds of it. Nothing in 1 to 5 changes how a session runs without the manager's decision; they are proposals.

## What shipped (detectors, so this stays visible)

`/api/usage` and `usage-summary.json` fields: `perAccount`, `waste` (findings: high-avg-context over 300k, low-cache-hit under 90%, cache-churn from 3 M written, subagent-heavy over 50% and 100 M, idle-polling 20% of calls, expensive-model-cheap-work), `burn` (hourly, time to 100% per window and account, and MiniMax), `loops`, a filled `outliers` list, and a `waste` line per day in the scorecard. First live run: 19 findings (5 high-avg-context, 2 subagent-heavy, 8 idle-polling, 3 cache-churn, 1 low-cache-hit). Page `/monitoring/ai-usage` shows them (virtualpytest repo).

## Before / after the merged fixes (measured 2026-11-28 09:35 UTC)

Merges: token-fix-a 00:43, token-fix-c-context 00:52, token-fix-b-waits 01:07, token-watch-subagents 04:18 (all UTC, 28 Nov). Source: `usage-ledger.jsonl`, Claude rows. Before = 27 Nov 00:43 to 28 Nov 00:43 (24 h). After = 28 Nov 04:30 to 09:35 (5.1 h, a Saturday morning). The after window is short and quiet, so the matching hours of 27 and 26 Nov are given as the fair baseline. Cost is null in the ledger for these rows, so context tokens per hour stands in for burn.

| Metric | Before 24 h | Same hours 27 Nov | Same hours 26 Nov | After 5.1 h |
|---|---|---|---|---|
| Calls per hour | 180 | 126 | 625 | 95 |
| Context M tokens per hour | 35 | 14 | 120 | 8 |
| Avg context per call | 196k | 115k | 192k | 84k |
| Calls above 300k | 19.7% | 3.1% | 12.0% | 0.0% |
| Cache hit | 98.1% | 98.0% | 98.3% | 95.8% |
| Subagent share of context | 65.3% | 5.0% | 25.7% | 19.9% |
| Tiny turns (<150 out) share of Opus/Fable calls | 14.8% | 13.4% | 11.0% | 15.2% |
| Calls/h of sessions labelled manager | 15 | 15 | 51 | 23 |

Weekly plan % per account (rate-limit files): default 100% (reset 28 Nov 15:00 Paris, no change); team1 71% in the audit, now 87% (+16 points; 5 h window 13%); team2 75% in the audit, now 86% (+11 points). Both still climbed after the merges, driven by the morning's work of 28 Nov before the after window and by the load of the days before, not by something the after window shows.

Reading: the large-context share fell (19.7% to 0.0% of calls above 300k, avg context 196k to 84k) and context per hour is 43% under the same hours of 27 Nov (14 to 8 M/h), but one quiet morning is not proof: volume is a third of a normal day, and the 26 Nov hours were a peak. Cache hit fell 2 points (95.8%), which fits the shorter sessions rewriting a smaller cache; watch it, the opt-in 1 h TTL is the lever. Tiny turns on Opus/Fable did not move (saving #5 is not shipped). Manager-labelled calls per hour rose (15 to 23, crude label match): the wait fix cuts wakes per wait, not the number of events the manager handles. Re-measure with a full weekday after the next merge window; script: `usage/` fields `waste` and `perAccount` of `/api/usage`.

## Saving #3: what is built, what stays with the owners

Built (ours): `context-advisory.js` now also turns a `subagent-heavy` waste finding into a low-priority manager advisory (`<session>:subagent-advisory`, one per finding id, same cooldown) carrying the narrow-prompt brief: one question per subagent, named files, answer in about 10 lines, Sonnet/Haiku for read-only lookups, no subagent for a few tool calls. Test in `test/context-advisory.test.js`.
Stays with the owners: the start briefs and skill text of `userinterface-audit` and `mcp-server-audit` are not in any repo we own (they were started by hand), so the actual prompt narrowing and the context cap there belong to their session owners; the advisory is how they get told, and the manager applies the 300k restart rule (saving #2) to the ones it started.

## Waste tab live check (headless, read-only, 28 Nov)

Playwright (headless chromium, fresh profile, `/?usage-page=1`, click Waste) on the live server, phone 390 px and desktop 1280 px: the tab renders all five sections (Waste 48 h with the hourly bars, Burn vs plan limit, By account, Findings 19, Loops), no "no waste data", 0 page errors. Found one layout bug at phone width: `.uv-root` has `margin:0 auto` inside the column-flex `.sheet-body`, so it sizes to its content instead of stretching; the long session names of the findings rows made the whole page 448 px wide and pushed the Waste/MiniMax nav buttons and the Today/14 days tabs off screen. Fix: `width:100%; min-width:0; box-sizing:border-box` on `.uv-root` (public/style.css). Re-measured with the fixed CSS routed over the live page: right edge 365 px on every tab at 390 px (Overview, Over time, Sessions, Waste, MiniMax); desktop unchanged (895). Open, not fixed: the Trending tab still reaches 397 px at 390 px (7 px over); next slice.

## Next 3 waste items (live `waste` findings, 28 Nov 09:50 UTC, 48 h window)

| # | Item | Size | Status / who |
|---|---|---|---|
| 1 | `userinterface-audit`: 302k avg context over 3,563 calls and 60.9% of its context in subagents, $358 (the largest single session). | about 20% of the window's cost with `artifact` | Advisories for both findings now go to the manager (context built earlier, subagent advisory built in this slice). Restart and prompt narrowing: the session's owner / manager (not started by the manager). |
| 2 | MiniMax nightlies polling on a 225k to 270k context: `rtsp-nightly-20261127-0545` 440 of 1,104 calls under 150 output tokens (114M tokens re-read), `coc-daily-20261127` 256 of 766 (58M), `coc-daily-20261126` 147 of 645 (35M), `coc-daily-20261128` 60 of 248 (16M). About 223M re-read tokens, 40% of those sessions' calls. | calls count against the MiniMax plan | The poll fix (longer sleeps, deferred minimax-poll notice) is merged for the manager side; the sleeps inside the nightly session briefs belong to the nightly owners. Not ours to edit. |
| 3 | `artifact` (339k avg, $181, 699 calls) and `mcp-server-audit` (61.5% subagents, $168). | about 10% | Same advisories; restart is the manager's call for sessions it started, owners otherwise. |

Nothing in the list is a small safe code change we own beyond what shipped (detectors, context advisory, subagent advisory, usage page fix); the remaining savings are session decisions (restart, model, sleep length). Item 5 of the handover (manager restart rule) is not started: it needs the manager's own session data and a decision on the threshold, so it goes to the manager as a proposal: restart the manager fresh when its avg context passes 300k over 30 calls at a natural stop, logging the open items in a handover line first.

## Manager decisions applied (28 Nov, later)

1. Manager restart rule, advisory only, built: a `high-avg-context` finding on a manager session (`loadManagerSessions`) becomes a low-priority `<session>:manager-restart-advisory` event: at the next natural stop (no turn, no draft, no deploy), append ONE handover line to `~/vpt-manager/docs/manager-handover.log` (UTC time, open items and who each waits on, pending decisions, last-seen event, promises), then run `scripts/manager-fresh.sh`; the fresh kickoff now tells the new manager to read the last line of that log first. Threshold is the waste detector's 300k average (30+ calls). Tests: `test/context-advisory.test.js`, `test/manager-visibility.test.js`.
2. Trending tab 7 px overflow at 390 px fixed: the sparkline `<svg>` has a fixed width attribute; `.uv-root .spark{max-width:100%;height:auto}`. Measured with the CSS routed over the live page: 365 px on every tab at 390 px, desktop unchanged.
3. Owner text written, offline sessions pick it up: `~/handovers/userinterface-audit-token-rules-20261128.md`, `~/handovers/mcp-server-audit-token-rules-20261128.md` (narrow subagent prompts, 10-line answers, Sonnet/Haiku for read-only lookups, 300k context cap) and `~/handovers/nightly-token-rules-20261128.md` (wait without the model: background + wake, 10 to 30 min sleeps). The rtsp-nightly template (`scripts/rtsp-nightly/prompt.md`, ours) already carries the waiting rule; the coc-daily prompts are generated outside our repos, so they take the section from the nightly file. Recorded as done.

## Correction after the closing check (28 Nov)

The subagent and manager-restart advisories I shipped earlier would have been dropped before the manager saw them: `manager-events.js` discards events about a manager session (the restart advisory is about the manager) and only kept the `advisory` payload for kind `context-advisory`; `manager-event-filter.sh` only deferred `context-advisory`. Fixed: the restart advisory is exempt from the manager-session drop, all three advisory kinds keep their payload, and the filter passes the two new kinds deferred. Tests: end-to-end tick into the feed (`test/context-advisory.test.js`) and the filter (`test/manager-event-filter.test.js`). The default `manager-fresh.sh` kickoff line was also evaluated in bash: it parses and contains the handover-log step (the tmux restart itself was not run, it would restart the live manager).

## coc-daily prompt generator and the deferred check (28 Nov)

The coc-daily prompt comes from `~/.local/share/coc-daily-review/run.sh` (unit `coc-daily-review.service`, TASK-164), which feeds `prompt.md` of that folder to `cbsession`; the installed copy mirrors `features/clashofclans/scripts/agent/coc_daily_review/prompt.md` in virtualpytest. The "Waiting without the model" section is now in both (virtualpytest integration `int-1a221946494486783` for the source, installed copy updated in place). Dry run: the real `run.sh` with `cbsession` and the clone sync stubbed wrote the prompt to a temp path: 84 lines, section present once, identical to the repo source. Deferred to the manager: the live `manager-fresh.sh` tmux restart with the handover-log kickoff is checked at the next natural manager restart.

## Second correction: shared trace id (28 Nov)

All findings of one session carry the same trace id, and the advisory state was keyed by id alone, so the context advisory already sent for `userinterface-audit` (id 7bdb4de4) suppressed its subagent-heavy advisory for 24 h. The state key is now `<kind>:<id>` for every kind except `high-avg-context` (old key kept so existing state files stay valid). Test: both findings of one session produce two advisories and neither repeats.
