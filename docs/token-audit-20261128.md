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
