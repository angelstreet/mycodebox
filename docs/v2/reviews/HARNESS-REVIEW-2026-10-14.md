# Harness review, 2026-10-14 (sanitised)

Public copy of the owner-interaction review that drove rounds 8 and 9 (`docs/tasks/v2/OWNER_DECISIONS.md`). Counts, classes, findings and ranked changes are kept; the owner's verbatim replies, session examples and host names are removed. The full private report (with quotes and per-session detail) is kept outside the repository on the dashboard host: `$GHOSTY_STATE_DIR/reviews/2026-10-14-harness-review.md`.

Reviewer: Sonnet, read-only. Sources: the Mac owner-turns file (234 rows), the codebox `stalls.jsonl`, `manager-owner-asks.jsonl`,
`manager-events.jsonl`, `mm-manager-actions.jsonl`, `lease-watch.json` and today's codebox Claude transcripts (user lines only),
plus the `round7.md` / `round8.md` specs and `stall.js` on `origin/v2/r7-merge-policy`.

## Summary (5 lines)
1. **105 of the 234 Mac turns were replies to a stop** (a "needs-owner" menu or question). The other 129 were owner-initiated steering,
   cross-session relays (17) or pasted terminal output. Only about 13 of the 105 were a plain merge/deploy "yes", and 24 more were "yes / do the recommended one". The owner's complaint is accurate, but a third of the stops (corrections 23, hardware 20, genuine decisions 10, information 7) are not "same question" stops.
2. **About 33 of the 105 stops (31%) would be answered under round 7 + 8 as written (about 54, 51%, with changes 2 and 3 below), if the manager could see them. It cannot:** `stalls.jsonl` today holds only codebox sessions, and 210 of the 234 owner turns were on the Mac. The largest single change is to bring Mac `needs-owner` stops under the manager.
3. **Recommended options are not always right.** Of 22 Mac menus tagged "(recommended)", the owner took 10 as is, 6 with an addition, and 6 redirected. So "auto-pick the recommended one" needs the end-of-day digest and cheap revert that round 8 §2 promises, and a check that product-visible picks are listed first.
4. **Waiting time:** the Mac file has no stop timestamps, so Mac waits cannot be computed (see Limits). On codebox, 12 owner replies had waits of 76 s to 75 min: median 8.5 min, mean 25 min, total 5.1 h. Five of those 12 were questions the session could have settled itself (lease state, progress, "where is the path").
5. **Voice covers about 81% of the stops (85 of 105).** The rest need a screen: pasted terminal output from the modem rack (10) and mockup or browser checks (about 10).

## Limits (read first)
- **Mac wait times are not measurable.** The Mac file has the owner's reply time and the agent's last text, but no stop time. The `ts` column also mixes local and UTC order. Per-class waiting time is therefore given for codebox only (Q1 table B). Mac counts are reliable; Mac minutes are not.
- The classification of the 105 stops is my reading of the agent text plus the reply (heuristic filter, then hand labels). Treat counts as ±3.
- The answer ledgers stopped being written: `manager-owner-asks.jsonl` has its last `owner_answer` on 2026-10-07, `owner-roundtrips.jsonl` on 10-09, `manager-actions.jsonl` and `mm-manager-decisions.jsonl` on 10-06. So the data that round 8's digest and G1 depend on is not being collected today.

---

## Q1. Every stop for the owner today

### A. Mac sessions, 105 stops (counts; waits unknown)
| Class | Stops |
|---|---|
| Pick the recommended / plain "yes" (reversible work) | 24 |
| Merge + deploy (one question) | 5 |
| Deploy / re-deploy / rerun (incl. lab DB migration) | 8 |
| Push (as its own question) | 0 |
| Approve plan / mockup / build | 8 |
| Genuine decision | 10 |
| Correction / redirect | 23 |
| Information request (the owner asks, does not decide) | 7 |
| Physical action / hardware | 20 |
| **Total** | **105** |

Per session (stops / all turns): drone video 15/27, Zammad 12/19, fixnet modems 11/17, themes 9/15, subtitle QA report 7/11, platform update 6/10, ModeBar 6/7, favorites 6/10, CoC benchmark 5/12, CoC e2e 4/8. 14 other sessions had 1 to 3 stops.

Outside the 105: 129 turns were owner-initiated (new ideas, "…", "…", "…") and 17 were cross-session relays or context-summary hand-ins.

### B. Codebox sessions, measured (`stalls.jsonl`, `afterSec` = stop to owner reply, `via: reporter`)
| Session | Stop was | Class |
|---|---|---|
| coc-llm-haiku 13:18 | commit + merge + deploy attack fix | merge+deploy, credential |
| coc-llm-haiku 14:40 | commit v2, merge, deploy pi1 | merge+deploy |
| coc-llm-haiku 14:53 | merge to main, deploy | merge + correction |
| TASK90-worker 14:59 | start A1 (SRF 1 buffer capture) | yes + standing "don't stop" |
| TASK72-cfqa 15:44 | **was only waiting for a run** | information (false stop) |
| TASK90-worker 15:15 | send SRF 1 buffer path; merge and deploy? | merge + information |
| coc-llm-haiku 15:11 | deploy main to pi1 after lease | deploy (the session could check) |
| TASK103-measure 16:48 | report done, recommend delay 120 s | correction |
| TASK103-measure 16:52 | default delay set to 150 s | information |
| TASK90-worker 17:04 | use pi1 MCP key to change channel | credential |
| TASK90-worker 17:16 | recording window on an STB | correction |
| mycodebox-v2 15:33 | round 6b delivered | information / go |

Waiting total by class: merge/deploy 155 min (5 stops), information 127 min (3), credentials 8.5 min (1), corrections 11.5 min (2), plain go 3 min (1), queued instruction 52 min (1). The two longest waits (70 and 75 min) were the stops that needed no owner. Another 13 asks (Q145 to Q158) sit in `manager-owner-asks.jsonl`; 12 were still `open` at 17:27 and all 13 had the manager's recommendation "1 yes"…"narrowed".

---

## Q2. What round 7 + round 8 would and would not handle

Assumption: the manager sees the stop (it does not for the Mac, see the end of this section).

| Class | Stops | Handled | Not handled | Why |
|---|---|---|---|---|
| Plain yes / recommended | 24 | about 17 | about 7 | Missing evidence: option text contains words the forbidden regex still blocks (`remove`, `overwrite`, `migrat`, `deploy`), e.g. "…", "…". Round 8 must evaluate the *action being approved*, not any word in the ask |
| Merge + deploy | 5 | 3 to 4 | 1 to 2 | Deploy needs "lease free" and "…". Favorites and platform-update stops include DB migrations |
| Deploy / rerun | 8 | about 4 | about 4 | 3 include a lab-DB migration (hard floor as written: "…"); 1 had a busy lease |
| Approve plan / mockup / build | 8 | about 3 | about 5 | Missing rule: "…". Most of these menus carry no "…" marker, so `menu_recommended` never fires |
| Genuine decision | 10 | about 3 | about 7 | Hard floors: deletion (MinIO retention rules, "…"), credentials (.env key), buying a dongle; plus real product choices (skip the Atlas scene) |
| Correction / redirect | 23 | 0 | 23 | By definition |
| Information request | 7 | about 3 (the `info-lookup` of round 7 §2) | about 4 | The owner wants an explanation, not a path |
| Physical | 20 | 0 | 20 | Only the owner can power-cycle a drone or read a rack. Voice helps, automation does not |
| **Total** | **105** | **about 33 to 54** | | About 31% strict, 51% if the "plain yes" and "approve" menus are made to fire |

Hard-floor items that still stop (as written): data deletion (MinIO), credentials and secrets (3 times: CoC key, `.env` line, MCP key), money (dongle, VM cost), production-DB migration (3 to 4 stops that were really lab-DB), sudoers on hosts (2 on codebox: Q149 tessdata with sudo; mm sudoers).

**Structural gap that dwarfs the rest:** the manager's `stalls.jsonl` today contains only `mm-manager` (128 of 189 stalls: its own "done"), `mycodebox-v2`, `coc-llm-haiku`, `TASK72-cfqa-rerun`, `TASK90-worker`, `TASK103-measure`, `cfqa-rerun-engine`. None of the Mac sessions, which are 210 of the 234 owner turns and all 105 stops, ever reach it.

Also: `router` skipped on all 189 routes today (`no OpenRouter credit`), so only the deterministic rules were active, and `mm-manager` ran in alert-only mode. It answered 0 asks.

---

## Q3. Corrections (23 Mac stops + 3 codebox)

Could it have come at the end? "Y" = the work was reversible and the correction would have cost a cheap redo. "N" = the owner changed what the agent should do next.


Count: of 26, about 16 could have come at the end (the agent would have worked on a reversible choice), about 10 changed the next step and could not.

## Q4. Voice

Of the 105 stops, 85 (81%) could have been a spoken question and a spoken answer: 24 recommended + 13 merge/deploy + 8 approve (no visual) + 10 decisions + 7 info + 23 corrections (dictated). Within the physical class, "paired" and "ready" (10) are ideal for voice while the owner holds a drone. The ones that need a screen:
- Pasted `picocom` and rack output, 10 turns (fixnet modem session): the owner is a courier between a terminal on the rack host and the agent.
- "…" and "…" (about 8): a visual review. A voice flow can still say "…" and let the owner look later.
- "…" (the subtitle report): visual.

Spoken-friendly pattern in today's data: the drone session needed "paired" nine times in about 3 h.

## Q5. Other harness gaps
| Gap | Evidence | Cost |
|---|---|---|
| Mac sessions invisible to the manager | see Q2 | all 105 stops |
| Same ask re-sent, "narrowed" each time | `coc-llm-haiku`: 8 asks in 5 h | each re-ask restarts the owner's reading; waits of 75 min |
| False "needs you"…"what is run progress"; `stall` case `owner_decision` | owner interrupted for status |
| Router off | 189/189 routes `skipped: no OpenRouter credit` | no AI triage |
| Asks answerable by the session | lease state, "…", key location | 70 and 75 min waits |
| Lease semantics | owner complained about the lease in 7 sessions (frontend vs backend, "…", "why force"…"i already deployed") | about 12 owner turns |
| Owner as courier | modem rack: 10 pasted outputs; Tello: 9 "paired" | about 20 turns, 1 session per task |
| SRF 1 buffer | the worker wrote 12 live chunks (202 MB, hours 15 to 16) untracked in a worktree-local `.local-data/ads/` on codebox, then asked the owner to "…" (Q154). I could not find a copy on the Mac in this review (read-only, not searched). The replay found 0 breaks: the channel was free-to-air with rare ads. The session did not know a commercial channel and spare STBs existed ("…") | 70 min wait plus a failed replay |
| Wrong tool knowledge | owner 16:53: "…" | detour |
| Context loss | 2 context-summary hand-ins (`d6c1`, `32f9`) and the "…" pastes (3) | re-explaining |
| Idle without a question | `TASK90-worker` waits for a recording window to 20:12 CEST (fine, it says so); no session stalled silently in the data | none found |
| Data pipelines stale | see Limits | no measurement possible, no digest source |

---

## Ranked changes for mycodebox (expected time saved: estimate = stops removed x median wait 8.5 min; Mac waits unmeasured)

| # | Change | Where | Saves |
|---|---|---|---|
| 1 | **Bring Mac sessions under the manager.** Mac Stop hook posts `STATUS: needs-owner` (menu and options) to mycodebox; the same stall rules run on it. Without this nothing else matters | hook on Mac + `reporter` / `server.js` intake, `stall.js` | up to 54 stops/day, about 7.6 h of owner-wait if each costs the median 8.5 min |
| 2 | **Evaluate the approved action, not every word.** The forbidden regex scans the whole ask; apply it to the recommended option and the proposed command only. Today `remove`, `overwrite`, `migrat` anywhere block "…" | `stall.js` (`FORBIDDEN_PARTS`, `menu_recommended`) | about 7 of 24 yes-stops, about 1 h |
| 3 | **`menu_recommended` on by default and also for unmarked menus where the session's first option is the safe one** (recommended-rate 10/22 straight, 6/22 with addition), with the digest listing *product-visible* picks first | `stall.js`, round 8 §2 digest | about 20 stops, 2.8 h |
| 4 | **Lab vs customer DB.** A migration on the lab DB that is additive and applied by the documented procedure is a deploy step; customer DBs, destructive migrations and deletions stay owner-only | round 8 floors, `OWNER_DECISIONS` §15 | 3 to 4 stops (about 30 min); a visible deploy loop |
| 5 | **Session self-checks before asking:** lease state, build number, progress, "…". If the answer exists in the registry, the ask is dropped. Add: one open ask per session, a new ask supersedes the old | stall / ask intake | 70 min + 75 min + the 8 re-asks; also kills false "needs you" (TASK72) |
| 6 | **One lease rule, written once:** frontend deploys do not need a backend lease; busy means wait, never ask (fleet 0.1.5 does this on the Mac only); manager enforces it on every host and syncs the skill to both machines | `vpt-lease check`, deploy skill, `lease-watch` | about 12 owner turns |
| 7 | **Mockup-first as a rule:** UI feature -> html mockup in the feed -> build proceeds unless the owner objects within N minutes; review at the end | `docs/CONTRACT.md`, manager | 8 stops, 6 "…" |
| 8 | **Hardware "…":** owner says "…" once; the session retries without asking; stop on 2 failures. Voice command "ready" for 30 min | session prompt + voice queue | about 9 stops/day on drone days |
| 9 | **Standing secret-use grant:** a named list of stores (repo `.env`, Pi `ai_secrets.json`, skill-documented MCP key) a session may *read and use* in place, never print, never copy between hosts without a stop | policy doc, `OWNER_DECISIONS` | 3 stops, 17 min, and unblocks CoC / TASK90 |
| 10 | **Restore the ledgers:** write stop time, answer time, class and who answered to `owner-roundtrips.jsonl` for every host; add Mac stop and answer timestamps. Required for the round 8 digest and for measuring waits next time | `server.js`, `manager.js` | enables everything else |
| 11 | **Router credit fallback:** use MiniMax M3 or a local model when OpenRouter has no credit | `router.js` | 189 skipped routes today |
| 12 | **Device-owner relays:** give the fixnet / rack session ssh to the rack host so it reads `picocom` itself; then the owner is not the courier | session setup | about 10 turns |
| 13 | **Voice "needs you"…"yes / one / the recommended / go", route "…" as a note queued for the end | round 8 | 81% of stops |

Not recommended: auto-answering corrections or "…" (deletion, credentials, money). The data shows they are rare and mostly tell the agent something new.
