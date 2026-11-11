# Harness review, 2026-11-11: why the owner still has to step in

Read-only audit of the codebox harness (mycodebox) and the Mac harness, asked by the owner on 2026-11-11. Nothing was changed:
no code, config, lease, session or `.env`. Sanitised for a public repo: no addresses, host names or credentials; devices are
named by role. Times are Paris time unless marked UTC. Window: 2026-10-11 to 2026-11-11 07:30 UTC, newest weighted.

Sources: the state ledgers under `$GHOSTY_STATE_DIR` (`stalls.jsonl`, `owner-roundtrips.jsonl`, `manager-owner-asks.jsonl`,
`manager-wakes.jsonl`, `manager-actions.jsonl`, `done-check.jsonl`, `found-bugs.jsonl`, `integration/requests.jsonl`,
`lease-nudges.jsonl`, `lease-actions.jsonl`, `session-history.jsonl`, `usage-summary.json`), the repo at `3b0180b`, the manager
manual on its own branch, and the owner's feedback memories. The previous review is
[HARNESS-REVIEW-2026-10-14](v2/reviews/HARNESS-REVIEW-2026-10-14.md).

## Summary

1. **The judgement layer has been down for two weeks and nobody was told.** The AI triage and router have had no provider credit
   since 2026-10-28; the fallback fails 97% of its calls. Every stop since then is classified by keyword rules alone.
2. **A stopped session stays stopped.** Nothing re-evaluates a session parked on `blocked` or `waiting` when the thing it waits
   for changes. The owner does it by hand: 216 "what is the status / why are you waiting" messages, 39 "resume", 23 "any
   leftover?" in 30 days.
3. **The harness detects far more than it resolves.** 406 bugs filed in 14 days, 342 still open; 161 done-check findings; 138
   lease nudges; a manager woken 4,745 times of which 75% did nothing.
4. **The Mac harness has no return path.** 618 Mac integration requests in 10 days, none marked as external, so the relay and
   the 10-minute owner push have never fired once. The Mac Stop hook is not operating.
5. **The rules contradict each other and most are prose.** Merge, push, closing sessions, restarts and the hard floor are each
   stated in three to eight places with different content. The nightly manager kick still orders an action the owner withdrew
   on 2026-11-01.
6. **Three of the top items of the 2026-10-14 review are still open** (Mac under the manager, keyword floor on the whole ask,
   router credit fallback). A hand correction does not reliably become a working harness change.

## How much the owner steps in (measured, with limits)

| Measure (30 days) | Value | Source | Limit |
|---|---|---|---|
| Owner messages typed to the manager or a session | 1,493 (828 manager, 665 sessions) | `manager-wakes.jsonl` trigger `owner`, `stalls.jsonl` sends `by: owner` | About 166 of the manager ones are lane results (126) and nightly kicks (40) that the wake log labels `owner` |
| Stops that reached the owner | 1,345 escalations | `stalls.jsonl` `escalated` | 313 are system waits that resolve by themselves |
| Stops recorded as answered by the owner | 878 of 1,163 (75%); median wait 9.8 min, p90 39 min, 281 h of session waiting in total | `owner-roundtrips.jsonl` | Upper bound: `roundtrips.js:20` and `manager.js:469` default any unattributed resolution to `owner` via `pane` (588 rows) |
| Formal owner asks (Q ledger) | 165 ids; 52 since 2026-10-30 | `manager-owner-asks.jsonl` | No asks filed 11-04 to 11-09 (low activity those days) |
| Sessions the owner told to "resume" | 39 messages | owner sends | |

What the owner typed, by kind (regex classes over the 1,493 messages, classes overlap):

| Kind | Count | Example |
|---|---|---|
| Status or "why" question | 216 | "what are you waiting for how to unblock"; "you said no one is blocked but i see Still blocked" |
| Merge, deploy, push, restart topic | 183 | "why waiting 1H ... STATUS: waiting: integration" |
| Complaint about a repeat | 124 | "it is 3rd time what did you enforce in harness"; "this is still a big issue" (leases, 11-10) |
| Lease or device | 91 | "The Mi is still tied up" (11-11) |
| Ask for a worker | 70 | "send a worker to investigate" |
| Resume / continue | 39 | "resume them all" |
| Bugs | 35 | "did you assign worker for those bugs"; "Are you progressively fixing the filed bugs?" |
| Leftovers, docs, close | 23 | "i often see agent saying done and i always have to ask them manually" |

## Q1. Top 10 root causes, ranked by frequency x cost

| # | Root cause | Evidence | Cost to the owner |
|---|---|---|---|
| 1 | **No wake for a parked session.** A session that ends on `blocked`, `waiting` or a system wait is only woken by its own job, the lane or a nudge with its own narrow trigger. Nothing watches "the thing you wait for changed" | 11-11: two Android TV sessions idle about 11 h on a blocked status after the device came free (manager action 07:11 UTC). `lease-nudge` skipped an idle holder for 4.5 h (idea bug from `fix-lease-orphan-claims`). 9 `pending_wake_gave_up`, 6 `own_job_stale_nudge` in 30 days. 216 owner status questions, 39 resumes | Highest: hours of idle devices and sessions, daily |
| 2 | **Judgement layer down, silent.** Router: "no OpenRouter credit" on every stop 10-29 to 11-11 (about 7,400 skipped). Triage fallback: 782 of 805 calls failed ("answer is not JSON" 550+, timeouts, exit codes). `anthropic-spend.json` shows `out_of_credits` | `stalls.jsonl` `router`, `triage`, `fallback` rows. With no judge, the keyword floor decides: 386 escalations carry `[hard: <word>]` (deploy 87, remove/delete about 90, publish 36, `.env` 27, drop 38). Example 11-11 07:16: an own-tree edit escalated on the word "remove" | Every ambiguous stop goes to the owner or the manager; item 11 of the 10-14 review |
| 3 | **Leases: named waits, orphan claims, idle holders.** | Owner rule 10-31, repeated 11-10 ("still a big issue"), again 11-11 ("critical"). 138 nudges; 15 on 11-10 alone. A stale wait-claim held the Mi device about 11 h. An equivalent that was off the network was offered (manager action 11-10 21:24 UTC). Fix merged 11-11 (`54f6b48`), not yet proven over a night | Idle lab, repeated owner corrections |
| 4 | **Bugs are filed, not fixed.** 406 filed since 10-28, 342 open (84%), 46 open and marked blocking, many stale (a disk-full report from 11-01 that was solved the same day is still "open blocking"). `found-bugs.js:94` returns at most 100 rows by default; states are only fixed / wontfix / doc-only. 56 resolved in total. Findings are "held" for an owner area (manager actions 11-11 03:45 to 04:51 UTC) | Owner asked three times in 14 h (11-10 18:18, 18:40; 11-11 08:18). The dashboard count is wrong (82 shown, 342 real) | Trust: the owner cannot tell what is being worked on |
| 5 | **Lab hardware and sign-ins need hands.** Of 52 asks since 10-30, about 17 are physical (an IR dongle replug was asked 7 times in 4 days; phone, QR sign-in, cable swap) and about 14 are sign-ins or lab credentials | Q259, Q263, Q266, Q270 to Q273, Q277, Q286, Q296, Q297; Q249, Q264, Q268, Q298 | Real floor, but it repeats because the hardware has no software power control and sign-in state is not monitored |
| 6 | **Mac to codebox has no reliable return path.** | See "Mac harness". One 7 h wait for a result the manager logged as "no action" (11-01 to 11-02), one tailnet outage that stalled 8 Mac sessions (11-03), results pasted by the owner | The owner is the courier between the two machines |
| 7 | **Host fragility loses every session at once.** Five mass "vanished" events (10-16, 10-25, 10-29, 10-30, 11-04: 16 to 27 sessions each) from host freezes and restarts; disk full on 10-18, 10-20, 11-01, 11-07 (`ENOSPC` reached `pending-wakes` on 11-07) | `session-history.jsonl`; host troubleshooting log. A cleanup timer was "proposed 11-03, 11-07, 11-09, never shipped" (idea bug from `disk-cleanup-1110`) | Owner resumes sessions by hand; cleanup asked "why do you need me to cleanup" (10-26) |
| 8 | **Contradicting rules.** Sessions are told both to merge and push themselves and never to; the manager manual forbids what AGENTS.md grants | See Q4. Lane returns that are pure process: 84 release-note conflicts, 52 "branch not pushed", 51 "needs manager approval" (one for a comments-only CI file change), 24 migration evaluations (one `DROP NOT NULL` judged destructive against the owner's 10-21 rule) | Owner explains rules to sessions ("i dont understand this question") |
| 9 | **Reported success that is not success.** | A frontend deploy reported OK while the build had failed (`bug-e3bb3c47`, fixed 11-11). 73 done-check findings "commits not on main". Done-check false alarms for workers that shared the manager's worktree (manager action 11-10 21:36 UTC). A nightly reported green while the app was signed out. A session published a navigation tree to production without approval while nightlies ran (11-11 00:22 UTC) | The owner re-verifies by hand |
| 10 | **No trustworthy measurement, so no feedback loop.** | Roundtrips default to `owner`. `killSession` (`server.js:1761`) records no caller: every API delete is "dashboard kill". `manager-actions.jsonl` has invalid JSON lines (hand-appended). The wake log labels lane results as `owner`. Mac failures were never filed as bugs. Three 10-14 review items still open | Nobody can say whether a fix reduced step-ins |

## Case study: the night of 2026-11-10 to 11

| Event (UTC) | What the evidence shows | Root cause |
|---|---|---|
| Device held about 11 h | A stale wait-claim kept the Mi device; the holder session sat idle; `lease-nudge` did not fire 02:16 to 06:48. The owner found it at 06:48 | 1, 3 |
| 14 sessions closed 02:57 to 03:02 | All through `DELETE /api/sessions` ("dashboard kill"), 27 min after the nightly manager restart at 02:30. The manager logged "I still don't know who is doing it". No caller is recorded. One closed session (`stb3-ir-fix`) had an open owner ask (Q297). The only standing instruction to delete finished children is the nightly kick text (`scripts/manager-fresh.sh:68`, "Close finished children (owner, 2026-10-22)"), which the owner withdrew on 2026-11-01 | 8, 10. **Not attributed**: no matching call found in the default account's session transcripts; other account directories and the browser were not checked |
| Idle sessions on a status nothing woke | Two sessions at the prompt about 11 h; nudged by the manager at 07:11 after the owner asked | 1 |
| 340+ bugs, API shows 100 | `GET /api/bugs` caps at 100 (`bug-6829b74a`); 105 bugs filed on 11-10 alone | 4 |
| Worker findings held | 10 findings held "until the owning worker finishes" between 03:45 and 04:51; no owner, no deadline | 4 |
| "Said done, git disagrees" | 44 done-check findings on 11-10; part false: workers started in the manager's own worktree swapped branches | 9 |
| Manager waiter race | `manager-wait.sh` exit 3, "another manager-wait is running": an untracked copy from before the restart blocked the new one (02:58) | 7 (restart hygiene) |
| Frontend deploy OK, build failed | Fixed by `feat/deploy-build-honest`, whose own deploy then failed once | 9 |
| CI timing | Job timeouts were below the lease wait, so a wait cancelled the job (fixed 22:16) | 3 |

## Q2. Hard floors: too wide and too narrow

| Too wide (the owner was asked, a safe default existed) | Evidence | Safe default |
|---|---|---|
| Keyword floor on the whole text | 386 `[hard: word]` escalations; item 2 of the 10-14 review | Judge the proposed action only; a word in a report is not an action |
| Copying an existing lab sign-in between lab hosts | Q262, Q278, Q279, Q283, Q289; owner: "all hosts should have the login" | Lab hosts in the inventory may receive lab sign-ins already in the canonical `.env` |
| Physical replug when software can power-cycle | 7 asks for one dongle | Switchable hub port first; ask only after two failed cycles, once per day per device |
| Cleanup of regrowable data | 10-26 "why do you need me to cleanup"; cleanup journals on 9 days | Merged clean worktrees, caches and old run videos by timer |
| CI or infra path touched | 51 returns, one for comments only | Diff-aware: comments and timeouts pass with a journal line |
| Additive migration variants | `DROP NOT NULL` returned as destructive on 11-10, against the 10-21 rule | One list of additive statements, shared by lane and docs |
| Asks that answered themselves | Q280, Q281, Q290, Q291, Q292 ("moot") | Re-check the fact after 15 min before the ask is pushed |

| Too narrow (something unsafe was automatic) | Evidence | Needed |
|---|---|---|
| Closing a session | Any caller, no actor, no check for an open ask, a lease or unmerged commits (`server.js:1761-1771`) | Caller identity in the journal; refuse while an ask, lease or unmerged work exists unless the owner confirms |
| Nightly kick orders closing children | `scripts/manager-fresh.sh:68` against the 2026-11-01 rule and AGENTS.md "never auto-closed" | Remove the sentence |
| Publishing a shared tree to production | 11-11 00:22: published without approval during nightlies; kept afterwards because it tested green | Production publish goes through the same evaluated gate as a merge |
| "Never merge or push the target yourself" | Prose only; `ci-watch.js:76` and `scripts/cbsession:83` tell sessions the opposite | One rule, enforced by a pre-push hook on the target branch |
| Deploy result | OK with a failed build until 11-11 | Verify the served build id after every deploy |
| Lease reaper | Five releases in 50 min for one agent with `pid 756`, the digits of its session name (`lease-actions.jsonl`, 11-10 19:44 to 20:35). Possible false "holder gone" | Check where that pid came from (not verified) |
| Restart guard "enforced" | `LEASE-RULES.md` says enforced; `scripts/lease-guard-hook.js` is in no Claude settings file found | Install it or correct the doc |
| One shared Mac token | Every Mac session is the same client with no session name | Per-request session label |

## Q3. What is missing

| Gap | State today | Evidence |
|---|---|---|
| Feedback loop: hand correction to tested change | Not reliable. 27 feedback memories exist; several repeat a rule the owner had to restate (auto-close: 10-22 rule, 11-01 reversal, still in the kick on 11-11; leases: 10-31, 11-10, 11-11). Ideas are filed and re-proposed, not shipped | 10-14 review items 1, 2, 11 open after 4 weeks |
| Wake for blocked or idle sessions | Seven modules can type into a session, none owns "dependency changed" or "parked too long" | Q1 row 1 |
| Liveness and ownership of leases and jobs | Improved 11-11 (`54f6b48`: holder pid, unused-grant reaper). Idle thresholds are 10, 20 and 30 min in different modules | Section Q4 |
| Bug ledger | No paging, no duplicate / stale / owner-floor state, no priority, no automatic close from the integration that fixed it, no age-out | Q1 row 4. A drain worker started 11-11 |
| One source of truth for session state | State is inferred from pane text by `stall.js` and again by `done-check.js`, `unfinished.js`, `own-jobs.js`; 38 ledger file names | Q4 |
| Mac reliability | No push channel, no drift check, no offline queue for `integrate request` | Mac harness |
| Alarm when a harness part dies | The judge was down 14 days; the roundtrip writer was once dead for 5 days (10-14 review); the Mac relay never worked | Q1 rows 2, 6, 10 |
| Actor on destructive calls | None on session delete | Case study |
| Ready worktrees | A worktree made by `cbsession` has no installed dependency: `npm test` fails 13 tests with "Cannot find package 'ws'" until `npm ci` is run by hand, and a docs-only change still selects 13 server test files | Seen in this review's own worktree, 2026-11-11 |

## Q4. Over-engineering and contradictions

Size: 101 root modules (24,611 lines), 72 scripts, 304 test files (55,969 lines), about 33 timers and watchers in `server.js`,
44 `manager.json` switches plus about 20 watcher switches, 96 environment variables, 19 dated owner rules in the 158 lines of
AGENTS.md and 61 in REFERENCE.md. A session that follows "read before changes" literally loads about 70k tokens; 6.5k are
injected at every start.

| Contradiction | Says A | Says B |
|---|---|---|
| Who merges and pushes | `AGENTS.md:28` "commit and push your own work, merge when the merge evaluation passes" | `AGENTS.md:52` "Never merge into the target branch, push the target"; `scripts/cbsession` has both (lines 83 and 95); `ci-watch.js:76` "Merge and push the fix to main yourself" |
| Manager authority | Manual: "merge nothing, push nothing", never answer about a deploy | `AGENTS.md:139` "the AI manager decides merges, pushes, deploys" |
| Closing sessions | `scripts/manager-fresh.sh:68` "Close finished children ... via DELETE" | Manual: "kill a session: never"; owner 2026-11-01; `AGENTS.md` "never auto-closed" |
| Auto-answer defaults | `REFERENCE.md:320` `autoSend` off | `REFERENCE.md:869`, `manager.js:84`: on |
| Restarting the service | `AGENTS.md:40` only `scripts/safe-restart.sh` | Manual allows a direct service restart |
| Done-check pushes | "once" (`AGENTS.md:65`) | "max 3 a day" (`AGENTS.md:84`), "2 per check", "once per 12 h" (REFERENCE) |
| Lease switch delay | "after 2 minutes" (`AGENTS.md:102`) | "at once" (`AGENTS.md:106`); 30 s and 5 min in LEASE-RULES |
| Contract | `CONTRACT.md` "not standing permission to push to main" | AGENTS.md autonomy by default |
| Manager model | REFERENCE: Sonnet, "not Opus" | Manual: Opus minimum |

The manager manual lives on another branch in another checkout, with a second, older, longer copy in another repo.

| Duplicate mechanism | Members | Problem |
|---|---|---|
| Hard-floor lists | Eight: three regexes in `stall.js`, `owner-asks.js`, `router.js`, `owner-push.js`, `done-leftovers.js`, `merge-policy.js` | Different members; two modules punch exceptions into some of them |
| "Done but not done" | `done-check.js`, `done-leftovers.js` + `owner-push.js`, `unfinished.js` | Two leftovers parsers, four caps |
| Idle or stuck | `stall.js`, `progress-watch.js`, `own-jobs.js`, `wait-ids.js`, `pending-wakes.js`, `crash-resume.js`, `quota-resume.js` | Seven timers and journals, yet row 1 of Q1 is uncovered |
| Lease hygiene | `lease-watch.js`, `lease-holder-reaper.js`, `lease-nudge.js`, service TTL, client `WaitGuard` | Two reapers, three idle thresholds |
| Typing notices into sessions | `rules-watch.js`, `overlap-guard.js`, `shared-checkout-guard.js`, `lease-nudge.js`, `integration-notify.js`, `done-check.js` | Six senders; a filter exists to suppress the replies they cause |
| Shadow and standby | `router-shadow.js`, `wake-shadow.js`, `routing-shadow.js`, second manager (`mm-manager*`, `standby-manager.js`) | Never act; still cost code and calls |
| Second engine | `orchestration/` (33 files, 9,388 lines, 74 test files), opt-in | Own router, leases and queue beside V1 |
| Dead but shipped | `worker-auto-close.js` (returns "do not close" unconditionally, still wired) | Remove |

Rules nobody enforces: never merge or push the target; tests never touch live state; no secrets in commits before the lane
(`scripts/leak-scan.js` is in no test or hook); drain the bug queue; never hand the owner commands; Paris time. Detected only:
work in the live checkout, detached jobs.

## Token and cost

Figures are API-equivalent estimates from the usage ledger, not the plan invoice.

| Where | Figure | Note |
|---|---|---|
| All sessions, 14 days | about $3,936; 73,454 turns; 15.1 B cache-read tokens against 44 M output | Re-reading context dominates: 340 tokens read per token written |
| Manager sessions, 14 days | about $662 (17%) | 13 manager sessions |
| Manager wakes, 30 days | 4,745 wakes, about $1,405; 3,544 (75%) ended with "nothing" | `task_done` (the waiter returning) is 3,665 wakes and about $1,047; 2,910 of them did nothing |
| Peak days | 11-01: 652 wakes, $156; 11-10: 245 wakes, $60; whole fleet $517 on 11-10 | Wake count follows event noise, not owner work |
| Nightly restart | About 17.5k tokens of manual read per night, plus the kick | Cheap by itself; the cost is the stale instruction it carries |
| Session start | 6.5k tokens injected; up to 70k if the docs are followed | The same rule appears in 3 to 4 files |
| Game lanes | about $492 (13%) in 14 days | Outside this review; named for scale |
| Lease events | 14,871 lease events judged "not needed" | Whether each cost a wake was not verified |

## Mac harness

Verified from codebox only. The Mac was not contacted.

| Aspect | Finding | Status |
|---|---|---|
| Install | Hand copies of `integrate`, `found-bug`, the Stop hook, a config file and one token. `docs/INSTALL.md` has no Mac section; provisioning needs the owner | Verified |
| Updates | No version or hash check for Mac copies (`scripts/installed-copies-check.js` covers codebox only). Even on codebox, "installed integrate differs from the repo" fired on four mornings (11-03 to 11-06) before it was fixed | Verified design; Mac state needs a Mac check |
| Result relay | `integration-routes.js:136` drops the `--mac` label when the caller uses a client token. 618 Mac requests (first 11-02), 0 marked external, `integration/external-results/` does not exist, 0 "unrelayed" owner pushes. AGENTS.md describes the opposite | Verified |
| Outcomes | 365 deployed, 170 merged, 72 returned, 6 deploy failed, 5 cancelled; median 2 min, p90 5 min. No proof that a Mac session read any of the 78 bad results | Counts verified; delivery needs a Mac check |
| Waking a Mac session | Impossible from the server: only the session's own `integrate wait`, a Remote Control message with no delivery proof, or the owner | Verified |
| Stop hook | No client has the remote flag, no `mac:` stop rows in the ledger: the hook is not operating or is refused silently | Verified on codebox; cause needs a Mac check |
| Tailnet down | `integrate request` fails once, no queue; `found-bug` queues locally and flushes only on its next call; nothing on codebox notices the Mac is offline | Verified (11-03: 8 sessions stalled until the owner turned Tailscale on) |
| Identity | One shared token, `session: null` on all 618 requests | Verified |
| Bugs about the Mac tooling | None filed, although two outages happened | Verified |

Read-only commands for the Mac (owner or a Mac session; none prints the token):

```sh
# 1 installed copies against the repo (inside the Mac mycodebox checkout, after git fetch)
for f in integrate found-bug; do shasum -a 256 ~/.local/bin/$f; git show origin/main:scripts/$f | shasum -a 256; done
shasum -a 256 ~/bin/mycodebox-stop-hook.sh; git show origin/main:scripts/mac-stop-hook.sh | shasum -a 256
# 2 hook registered and not disabled
grep -n -A6 '"Stop"' ~/.claude/settings.json; ls ~/.config/mycodebox/disabled 2>&1
# 3 config present, token file mode (never print it)
sed 's#//[^:/]*#//<tailscale-ip>#' ~/.config/mycodebox/config; stat -f '%Lp %Sm' ~/.config/mycodebox/token
# 4 tailnet and reachability
tailscale status | head -3
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 "$(sed -n 's/^url *= *//p' ~/.config/mycodebox/config)/"
# 5 hook dry run (sends nothing)
echo '{"session_id":"abc123456","transcript_path":"/nonexistent","cwd":"'"$PWD"'","last_assistant_message":"test"}' | ~/bin/mycodebox-stop-hook.sh --dry-run
# 6 stranded bug reports and last lane result
wc -l ~/.local/state/ghosty/found-bug-queue.jsonl 2>&1; integrate status | head -5
# 7 background jobs and lease client
launchctl list | grep -i -E 'mycodebox|ghosty|vpt|tailscale'; shasum -a 256 ~/bin/vpt-lease
```

## Q5. Ranked plan (no implementation here)

Do now, this week, smallest first:

| # | Change | Expected effect on step-ins | Size | Risk | Builder |
|---|---|---|---|---|---|
| 1 | Remove "Close finished children" from the nightly kick; record the caller on session delete; refuse a delete while the session has an open ask, a lease or unmerged commits | Ends unexplained mass closes; makes the next one attributable | S | Low | Sonnet |
| 2 | Alarm when the judge is down: one owner push when router or triage fails for 1 h; then either fund it or route triage to a small Claude model on the plan | Removes most of the 386 keyword escalations and the silent 14 days | S | Low | Sonnet |
| 3 | Keyword floor reads the proposed action or chosen option only (10-14 item 2) | Fewer false "needs you" | S | Medium: needs the labelled stops as regression cases | Opus |
| 4 | Honour the Mac label for client tokens and send a per-request session name (`integration-routes.js:136`, `scripts/integrate`) | The relay and the 10-min push start working for 60 Mac requests a day | S | Low | Sonnet |
| 5 | Parked-session sweeper: one module that re-checks every session at the prompt on `blocked` / `waiting` when its named dependency changes (lease freed, integration ended, bug resolved) and at a maximum age, then sends one wake | Targets the largest class: status questions, resumes, idle devices | M | Medium: wake storms; cap per session | Fable or Opus designs, Sonnet builds |
| 6 | Bug ledger: paging, states duplicate / stale / owner-floor, close from the fixing integration id, priority, age-out; rule "fix it yourself when it is in your area and small, else file" | Honest open count; fewer "who works on this" questions | M | Low | Sonnet (drain already started 11-11) |
| 7 | Honest ledgers: roundtrip `by: unknown` when unattributed, wake trigger `lane` and `kick` separated from `owner`, JSON-safe append for manager actions; one weekly number "owner step-ins" | Makes every later fix measurable | S | Low | Sonnet |
| 8 | One rule text for merge / push / deploy and one for closing sessions; fix `ci-watch.js:76`, `scripts/cbsession:83`, CONTRACT, the manual, the done-check push counts, the lease delays | Fewer process returns and rule questions | M (docs) | Low | Fable or Opus writes, since it is judgement on the owner's dated decisions |
| 9 | Prove last night's lease fix: one night report of named waits, orphan claims and idle holders; check the `pid 756` releases | Confirms row 3 is closed or reopens it | S | Low | Sonnet |

Design later:

| # | Change | Why later | Builder |
|---|---|---|---|
| 10 | One hard-floor module used by all eight call sites, with the dated exceptions as data | Touches every decision path; needs the regression set from item 3 | Opus |
| 11 | One session state machine written by the session's own status line and job registry; watchers read it instead of pane text | Replaces seven watchers; large | Fable design, Opus build |
| 12 | Manager wake economy: batch events, no wake for events the rules already handled; target under 25% no-op wakes | About $1,000 a month equivalent; needs item 7 first | Opus |
| 13 | Mac pull agent (launchd job that fetches results and updates the scripts, with drift warning) | Needs an owner install on the Mac | Sonnet |
| 14 | Software power control for the IR dongles and sign-in monitors for lab apps | Hardware choice and money: owner decision | Owner decides, Sonnet builds |
| 15 | Retire one of each pair: second manager and shadows, V1 or V2 engine, `worker-auto-close.js` | Needs the owner's call on V2 | Owner decides |
| 16 | Host resilience: disk timer, session auto-resume after a host restart verified end to end | Partly host work on the hypervisor | Sonnet, host steps owner floor |

## Not verified

- The Mac itself: installed versions, hook registration, token flags, local queues, tailnet state (commands above).
- Who closed the 14 sessions on 2026-11-11: no caller is recorded; transcripts of the other Claude accounts, MiniMax or Codex
  sessions and the browser were not searched.
- Whether the lease fix merged on 2026-11-11 (`54f6b48`) holds over a night; the origin of the `pid 756` reaper releases.
- Live switch values beyond `manager.json`; whether the V2 engine is on in the live service.
- The manager manual and its reference file were read by section, not line by line; the two guard hooks were not read.
- Owner message classes are regex counts and overlap; the roundtrip "by owner" figure is an upper bound.
- Costs are ledger estimates, not billing; cache-read cost per model was not split.
- Each feedback memory was not traced to a commit; the feedback-loop finding rests on the repeats named above.
- No test was run and no endpoint was called: this review changes one doc only.

## Follow-up: one-night lease report (item 9, 2026-11-11)

Sources: `vpt-lease events` (registry, 2026-11-10 00:17 to 2026-11-11 08:12 UTC, all times UTC), `lease-nudges.jsonl`,
`lease-actions.jsonl`. "Night" is 2026-11-10 20:22 to 2026-11-11 07:12: it starts when the waiting-claim orphan check merged
and ends when the abandoned-claim fix (`54f6b48`) merged. The service restarted at 08:06 and 08:13, so the decisive fix was
**not live for any full night yet**. Baseline is 00:17 to 20:22 on 2026-11-10.

| Measure | Baseline (20 h) | Night (11 h) | After 07:12 (1 h) |
|---|---|---|---|
| Wait tickets started | 44 | 465 (420 cancelled, 1 missed) | 11 |
| Longest wait / median | 2 min / 0.1 | 30 min / 2 min | 0 / 0 |
| Waits of 30 min or more | 0 | 1 | 0 |
| Holders that ran to the TTL (never released) | not counted | 50 (content-mobile, kpi-stb, content-web) | 1 |
| Holders reaped for no heartbeat (15 min) | not counted | 9 (8 are one agent, kpi-stb, on two devices) | 0 |
| Named waits while a free equivalent existed (nudge) | n/a | 7 (4 after the 22:26 health fix: 23:00, 23:24, 04:58, 05:02) | 0 |
| Waits with no free equivalent (nudge, 15 to 17 min) | n/a | 8 (all before 22:05) | 0 |
| Idle-holder nudges | n/a | 5 (idle 21, 21, 21, 33 and 86 min) | 1 (past expected time, 11 min) |
| Holder-gone reaper releases | 0 | 6 | 0 |

Reading:

- **Named waits**: no wait reached the 11 h of the previous night; the longest was 30 min. The rule "never wait on a named
  device while an equivalent is free" is still only a nudge: 7 sessions waited while one was free, 4 of them after the fix
  that made equivalents real. The nudge arrives 1 to 41 min into the wait.
- **Orphan claims**: 420 tickets were cancelled (10 times the baseline count; the cause, retries or the new orphan check, was not
  separated, not verified). 50 holders did not release and ended at the TTL; that is the idle-holder class the 07:12 fix targets.
- **Idle holders**: one was caught only after 86 min idle (02:46), the same gap as 11-10. Not closed.
- **`pid 756` releases (5 of the 6)**: all for one agent (`codebox:bug-0756`), each a different lease id, 19:44 to 20:35 on
  11-10, `src: claim`, so the claim itself carried `holder_pid` 756 (not the name-derived pid). The digits equal the session
  name, so a made-up or mistaken pid is the likely origin; the registry journal for that day was empty, so the claim call
  could not be read back (not verified). Effect: the agent lost five leases in 50 min. The 11-11 auto holder (pane pid) does
  not use a typed pid, but a typed `--holder-pid` is still accepted unchecked (filed as an improvement, see the closing line).
  The sixth release (`TASK-168-842439`, a real pid that died) is correct behaviour.

**Row 3 of Q1 is not closed.** Named waits are down from hours to at most 30 min, but idle holders (86 min nudge, 50 TTL
endings, 8 no-heartbeat reaps) and named waits beside a free equivalent (4 after the fix) still occur, and the main fix was
not live overnight. Re-run this report on the night of 2026-11-11 to 2026-11-12 (window 21:00 to 07:00 UTC) with the same
three sources; row 3 closes when there is no wait above 30 min, no named wait beside a free healthy equivalent, no idle-holder
nudge above 30 min and no `holder-gone` release for a live session.
