STATUS: DELIVERED 966c59c (round 9)

# V2 progress

Coordinator: Opus (Claude Code), unattended. Integration branch `v2/integration`, base `origin/main` `dccab06`.
Worker worktrees: `~/mycodebox-v2-wt/<branch-suffix>`. Contract: `docs/v2/ARCHITECTURE.md`.

## Next action

Owner direction 2026-10-18 (OWNER_DECISIONS §18): show results (V1 pages replaced by V2 pages move to a "Legacy" group of
the More menu), ship first and test at the end of a build, shadow periods of 1 hour at most, no new feature rounds (ideas go
to TODO.md). Lease cut-over: waiting on the owner for the network path of the registry host and the device hosts; then
shadow 1 h, then central after telling the manager.

## Round 12 (2026-10-18): show results

| Item | What | State |
|---|---|---|
| Legacy menu | Platforms, Review stops, Jev decisions folded into a collapsed "Legacy pages" group of the More menu; links and `?platforms=1` / `?review=1` / `?decisions=1` keep working; service worker v148 | DONE |

## Round 9

Base: `origin/main` after round 10 (3cb6ea1, up to 304403f). Spec: `.v2/round9.md`; item 6 was done in round 10.
Owner decision: OWNER_DECISIONS §17.

| Item | Scope | Owner (model) | State |
|---|---|---|---|
| 1 | Mac Stop hook + token intake + long-poll answer channel (`remote-stops.js`, `scripts/mac-stop-hook.sh`, `docs/MAC-HOOK.md`) | Sonnet / Opus + Fable | DONE |
| 2, 3 | Approved-action floor (allow-list narrative and soft-verb relax), unmarked-first menus, product-visible picks first | Sonnet / Opus + Fable | DONE (3 review rounds) |
| 4 | Lab vs customer DB: additive SQL in `labEnvs` (empty by default) as a deploy step | Sonnet / Fable | DONE |
| 5 | Self-checks (version, progress, file exists), one open ask per session | Sonnet / Opus | DONE |
| 7 | Mockup-first | Sonnet / Opus | DONE |
| 8 | Hardware ready window | Sonnet / Opus | DONE |
| 9 | Owner round-trip ledger | Sonnet / Opus | DONE |
| 10 | MiniMax M3 fallback for AI triage (never for merge/push/deploy; needs mcode with lightweight mode) | Sonnet / Opus + Fable | DONE |
| 11 | Wake sessions when their own job ends | Sonnet / Opus | DONE |
| Gates | 2309/2310 Node 23.6 on 966c59c (the failing V2 bench driver test is untouched by this round and passes alone, 8/8); leak scan clean | coordinator | DONE |

## Round 10

Base: `origin/main` 923da00 (round 8 merged), merged up to 5c5e29a. Spec: `.v2/round10.md` (+ evening addendum on lease
modes). Owner decision: OWNER_DECISIONS §16. Design: `docs/v2/LEASES-CENTRAL.md`.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R10-1 | Inventory + design doc (matrix, queue, modes, heartbeats, API contract, shadow, cut-over) | coordinator + Fable design review | DONE (19 design findings folded in) | 0996e87, 6c79fd9, 0ecdbe0, 7c07a73, 6df89bf, ac4706b |
| R10-2 | `lease-service.js`, `lease-routes.js`, token / import / export scripts | Sonnet / Opus + Fable review | DONE | v2/r10a-service |
| R10-3 | `scripts/vpt-lease` compatible client, `docs/LEASE-RULES.md`, skill renderer, client-vs-service integration test | Sonnet / Opus + Fable review | DONE | v2/r10b-client |
| R10-4 | `lease-source.js` (legacy / central), liveness, manager lease answers (`lease-ask.js`), Leases view, voice line | Sonnet / Opus + Fable review | DONE | v2/r10c-dashboard |
| R10-5 | Reviews: Opus CHANGES REQUESTED -> APPROVE; Fable design CHANGES REQUESTED, code CHANGES REQUESTED -> APPROVE; final minors | coordinator | DONE | fa20b28, 9fb1d76 |
| R10-6 | Gates, PR, DELIVERED | coordinator | DONE | d0323ea (main 5646638 merged): 2222/2222 Node 23.6; dc54698: 2217/2217 Node 23.6 and 24.21; acceptance 54/54 on ef2579e and browser 67/67 on 13bb8e2 (the run on dc54698 was stopped by the memory guard); leak scan clean |

## Round 8

Base: `origin/main` 44bf60d (round 7 merged), merged up to 6801705. Spec: `.v2/round8.md`. Owner decision: OWNER_DECISIONS §15.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R8-1 | `docs/GOALS.md` (G1, G2, existing goals with status), README + index links, OWNER_DECISIONS §15, AGENTS / CONTRACT / INSTALL / REFERENCE floors | coordinator | DONE | 5f86eb1 era docs, 5477a67, 8e9a8f8, 313cdb7 |
| R8-2 | G1: topic split {merge, push, deploy, hard}, push / deploy evaluations (`decide-policy.js`), menu_recommended default + `autonomyVersion` migration, `manager-decisions.jsonl`, Decided for you (`decided.js`, view, revert, daily digest), `merge-eval.js --kind` | Sonnet / Opus + Fable review | DONE (4 review rounds; Fable APPROVE) | d01c807, 9cc92ab, e5f8a69, 11942d4, 61da88f, 7a60af6, 38aae6c |
| R8-3 | G2: voice audit + `docs/VOICE.md`, `voice.js` queue / answer / digest, voice mode page (Media Session, Wake Lock), notification actions | Sonnet / Opus review | DONE | 5904a8c, 391c28d |
| R8-4 | mm-manager manual (ops repo) | coordinator | DONE, local branch `mm-r8-autonomy` (not pushed) | 7ebfabd9a |
| R8-5 | Gates, PR, DELIVERED | coordinator | DONE | 185d982: 2027/2027 Node 23.6, Node 24.21 2027/2027 on rerun (one unidentified intermittent failure in the first run), acceptance 54/54, browser 67/67, leak scan clean |

## Round 7

Base: `origin/main` 36114e5 (rebased from 602d2f3). Spec: `.v2/round7.md`. Owner decision: OWNER_DECISIONS §14.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R7-1 | `stall.js` topicSplit / hardMatch (merge leaves the hard floor; FORBIDDEN_RE unchanged), `merge-policy.js` evaluation + journal, `info-lookup.js`, router point `merge`, `manager.js` `manager_decision` source, feed notices, `GET /api/manager/merge-decisions`, `scripts/merge-eval.js` | Sonnet / Opus + Fable review | DONE (3 review rounds; Fable APPROVE) | 9ea2a57, 22fc2c1, 9ce3003, c11fb97 |
| R7-2 | CONTRACT, AGENTS, REFERENCE, OWNER_DECISIONS §14, V2 task doc | coordinator | DONE | b651b96, 66acdad (+ 9ce3003) |
| R7-3 | mm-manager manual (ops repo TASK-44-MANAGER.md, TASK-44-ai-manager.md) | coordinator | DONE, local branch `mm-r7-merge-policy` (not pushed) | e78be1b17, 1c442e547 |
| R7-4 | Gates, PR, DELIVERED | coordinator | DONE | c11fb97: 1892/1892 Node 23.6 and 24.21, acceptance 54/54, leak scan clean |

## Round 6b

Base: `origin/main` 602d2f3. Spec: live defect, pre-restart sessions showed 0 turns in History.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R6b-1 | Backfill first-seen sessions from the ledger, ledger-only rows for uncovered turns, V2 turns counted once, cached join; ledger compaction keeps old rows (atomic) | coordinator / Opus review | DONE (APPROVE after 1 change round) | bcce613 + e350cc3 + 795b1cf |
| R6b-2 | Gates, PR, DELIVERED | coordinator | DONE | 1826/1826 Node 23.6 and 24.21, acceptance 54/54 (T20 67/67), leak scan clean |

## Round 6

Base: `origin/main` dff3120. Spec: `.v2/round6.md`.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R6-1 | `session-history.js` record + writers (dashboard, tick loop, V2 runs, loopback `POST /api/history/started`), `scripts/cbsession`, `GET /api/history` | Sonnet / Opus review | DONE (2 review rounds) | 69ade91 + bc17789 + 74aa871 |
| R6-2 | History view (More menu, filters, load more, detail sheet), sw v144, browser check | Sonnet / Opus review | DONE | fd18b41 (+ stale-response fix in 74aa871) |
| R6-3 | MiniMax launch model, OpenCode ingest (`message` table only), labels from history | Sonnet / Opus review | DONE | 70280f5 (+ read-only follower in 74aa871) |
| R6-4 | Gates, PR, DELIVERED | coordinator | DONE | rebased on main 1529069 (d26f962; MiniMax M3 only, no M3.1 default): 1817/1817 Node 23.6 and 24.21, acceptance 54/54, browser 67/67, leak scan reviewed |

## Round 5

Base: `origin/main` dff3120. Spec: the live smoke task `waiting/no_progress` (run 1 committed then hit its 120 s leash,
`npm test` ran out of the 120 s check limit, run 2 changed nothing).

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R5-1 | Docs checks per task class (`checks.by_task_class`, `scripts/docs-check.js`, `scripts/run-if-changed.js`), check limit `checks.timeout_ms` 600 s (suite measured 136 s), `check_timeout` wait, evaluate committed timeouts, no-change run on unmeasured/passing head -> evaluation, declared `task_class` sets the work type | coordinator / Opus review | DONE (Opus APPROVE, 2 rounds) | 1557dfb + 2db1d3d + f8c1e4c; regression replay `test/v2-r5-livefix.test.js` |
| R5-2 | Gates, V2_VERIFICATION, PR, DELIVERED | coordinator | DONE | 1774/1774 Node 23.6 and 24.21, acceptance 54/54 (1775 tests, T20), leak scan clean |

## Round 4

Base: `origin/v2/integration` 5a5741e. Owner spec: OWNER_DECISIONS §12.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R4-0 | §12 recorded, status line, stale "not wired / 503" owner action replaced | coordinator | DONE | 5a5741e |
| R4-1..3 | run_limits policy + registry (M3.1-Flash, billing), faster no-progress stop, scorecard-fed routing + escalation ladder, mcode exec `--permission full` | Opus / Fable review | INTEGRATED (Fable APPROVE, 2 rounds) merge 50e40bf | 245569f+1053e4c+ec4582b; D-023..D-026; 1741/1741 both runtimes; two 150 s stalls alone take 300 s, so the <3 min stop comes from a feasibility review (independent reviewer, `impossible:true` on failing checks) after the first cheap-model stall |
| R4-4a | Bench `--reps`, M3.1 spec, subscription cost basis, per-model table, time-to-stop | Sonnet / Opus review | INTEGRATED (Opus APPROVE, 3 rounds) merge ac97bbf | 24dbd17; 1728/1728 both runtimes; time-to-stop over expected-impossible runs only; unknown cost wins over mixed |
| R4-fix | Real-run defects: mcode 0.6.5 final text (item.content, result.output), verdict/feasibility parsed from the final text only (last JSON object), no-change and impossible-claim runs count as stalls under stall_runs_to_no_progress, cheap leash 120 s, failed exec status | Opus / Fable review | INTEGRATED (Fable APPROVE, 2 rounds) | bbc9666+6a6bd5b; 1762/1762 both runtimes; sanity2 on bbc9666: 6/6 as expected, impossible stops in 38-55 s (M3 was 503 s) |
| R4-4b | Real evaluation M3 vs M3.1-Flash vs Haiku, 3 reps, USD 10 cap, SCORING.md recommendation | coordinator | DONE | bench2 merge ab649c2 (Opus APPROVE); 2 sanity runs exposed the R4-fix defects; full run 90/90 as expected (72 done, 9 awaiting_approval, 9 waiting_no_progress in 29–57 s), all 24/24 verified first pass per model; M3.1-Flash fastest (34 s mean), M3 44 s, Haiku 68 s; fix: gate-stopped tasks cost basis `none` ($0 known) + Haiku latency_ms 20000, merge feb87cc (Sonnet APPROVE); spend USD 4.83 measured; SCORING.md "Round 4" |
| R4-5 | Gates, V2_VERIFICATION, PR round-4 section, DELIVERED | coordinator | DONE | gates on f3eb199 (code = merge feb87cc): 1764/1764 Node 23.6 and 24.21, reporter 25/25, acceptance 54/54 rows incl. T20 (1765 tests), leak scan clean; PR #1 round-4 section, still draft |

## Round 3

Base: `origin/v2/integration` c23ebe8. Owner spec: OWNER_DECISIONS §11.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R3-1 | Wire the V2 engine into the server behind `GHOSTY_V2=1` (lease, recover, scheduler, execution, approvals, integration, system ops) | Opus / Fable review | INTEGRATED (Fable APPROVE, 2 rounds) merge 64b3f75 | 27aa36c+cf99337+56023ed: lease-fenced create (`ownerWrite`), branches `v2/task/<id>`, dead remote bounded, stop() bounded, repo hooks neutralized; orchestration/v2-runtime.js + v2-integrate.js, child-process server tests; 1692/1692 both runtimes; D-021; approved merges are not executed by the server (task waits until main contains the SHA) |
| R3-2 | Benchmark through the HTTP API of a disposable wired server (USD 20 cap), compare with round 2 | Sonnet driver / Opus review + coordinator | DONE; driver fixes INTEGRATED (Opus APPROVE, 3 rounds) merge e0f7dd5 | real run on driver 217177c, rescored with the fixed scorer: 50/50 started, 49 as expected (39 done, 6 awaiting_approval, 5 waiting_no_progress), all models 100% verified, partial 77.0 (round 2: 78.1, 45/50, 4 skipped); the one miss is a haiku stray file held by the path gate (policy stop, not a defect); MiniMax impossible ended waiting_no_progress in 728 s; spend 4.14 known + 12.08 estimated = 16.22 of 20 (incl. driver sanity 0.09 + 0.34); no re-run needed. docs/v2/SCORING.md "Real run over HTTP" |
| R3-3a | MiniMax impossible task ends `waiting`/no_progress before the time cap | Opus / Opus review | INTEGRATED (Opus APPROVE, 2 rounds) merge 0b56d12 | 8df6828+7cdca16: run timeout counted as an attempt (was routed to provider backoff); bench agent timeout 3 min; 1693/1693 both runtimes |
| R3-3b | Drop stale "main's git history" owner action | coordinator | DONE | history was rewritten |
| R3-3c | Docs: enable / roll back V2 on the live install | coordinator | DONE | INSTALL "Optional: V2 task engine"; README/USAGE updated |
| R3-4 | Gates on final SHA, V2_VERIFICATION, PR round-3 section, DELIVERED | coordinator | DONE | gated 37004b9: 1716/1716 Node 23.6 and 24.21, reporter 25/25, acceptance 54/54 (1717 tests), T20 39/39, leak scan clean; first gate on e3be1f6 failed T20's positive control (create needs the loop since the wiring), fixed in 37004b9 (Sonnet APPROVE); PR #1 round-3 section; PR stays draft |

## Round 2

Base: `origin/v2/integration` e1a9a5b (post-rewrite).

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R2-1 | Clean V2_VERIFICATION.md, gates on final SHA | coordinator | DONE | Rewritten as one current document; gated SHA ae9efa0: 1684/1684 Node 23.6 and 24.21, reporter 25/25, acceptance 54/54 (1685 tests), T20 39/39, leak scan clean; later commits docs only |
| R2-2 | Sessions never ask for permission (bypass + folder trust on every launch path) | Sonnet / Opus review | INTEGRATED (Opus APPROVE, 2 rounds) merge 0967a6d | 4109590+bb883c5; mcode TUI has no permission flag: full mode = `permissionMode: bypassPermissions` in its config.yaml (D-019); 1614/1614 both runtimes at ae6a613 |
| R2-3 | assetlinks / Langfuse / https hints from configuration | Sonnet / Opus review | INTEGRATED (Opus APPROVE, 2 rounds) merge ae6a613 | b0c02bc squashed (a node_modules symlink slipped into a fix commit; squashed before any push); env ANDROID_APP_PACKAGE, ANDROID_APP_SHA256, LANGFUSE_PUBLIC_URL; PUBLIC_URL feeds hints |
| R2-4 | m1 m2 m3 m4 m6, T15 red-tests half, T20 same-origin control | Sonnet / Opus (m3,m6 Fable) | INTEGRATED: m1 m2 m4 T15 T20 merge 42bce7a (Opus APPROVE, 2 rounds); m3 m6 merge dacc48c (Fable APPROVE, 3 rounds) | D-020; m6 shared textVariants/windowJoins in stall.js. Accepted false positives (safe direction): "roll out", "I'll pass. Word", "Re start", "Bill ing", "pass/word", "we pass words". Open low: rarer confusables (Armenian, small caps), two splits in one window (manager only; V2 catches), prefix compounds (undeploy) out of scope. Gate dacc48c 1674/1674 both runtimes |
| R2-5 | OpenCode installed in user space, live smoke | coordinator + Sonnet | INTEGRATED (Opus APPROVE, 2 rounds) merge d29ecf5 | opencode-ai 1.18.32 under ~/.local/opencode (pinned >2 weeks old, free models); real format: sessionID, per-step tokens summed, incomplete flagged; resume via --session verified live; --auto refused by the adapter guard; live smoke accepted |
| R2-6 | Scorecard, tool score, approval-gated proposals, bench suite + dry run (USD 20 cap) | Opus / Sonnet | INTEGRATED: scoring 117a976 (Opus, 3 rounds); bench 7db8c4e (Opus, 3 rounds); owner-intervention fix 508f0a0 (Opus); bench2 4f942dc (Opus, 4 rounds); bench3 2fde21c (Opus); T20 tab order ae9efa0 (Sonnet review) | Dry run full2: 50 runs, 45 as expected, 4 skipped_budget, all models 100% verified, tool score partial 78.1; defects repaired (assert monkeypatch, exit cheats, reviewer sandbox EPERM, budget share, outcome list) and confirmed by re-runs. Results and spend: docs/v2/SCORING.md "Dry run" |
| R2-7 | Push, PR #1 round-2 section, DELIVERED | coordinator | DONE | pushed to origin/v2/integration; PR #1 description has a round-2 section; PR stays draft |

## Plan (waves, max 3 concurrent developers)

| Wave | Packages | Depends on |
|---|---|---|
| A | P1 review (Fable); `v2/02-task-core` (Opus); `v2/08-lease-authority` (Opus); `v2/04-routing` registry/router/budget + router dry-run 6/10 (Sonnet) | Phase 1, ARCHITECTURE |
| B | `v2/03-adapters` claude/codex/opencode(fake)/minimax/fake + worktrees (Sonnet); `v2/10-system-ops` (Sonnet); `v2/09-integration-agent` (Opus) | A |
| C | `v2/05-goal-loop` engine + verifier + policy (Opus) | A, B |
| D | `v2/06-ui-docs` API routes, Tasks view, README/MAP/CONTRACT, scoring (Sonnet) | C |
| E | `v2/11-e2e` T01–T40 + GL01–GL14 harness and evidence (Opus); Fable full-process review; draft PR | all |

## Task ledger

| Task | Phase | Branch / worktree | Base | Owner (model) | State | Result / merge SHA |
|---|---|---|---|---|---|---|
| baseline | 0 | v2/00-baseline | b9a83e1 | prior run | done | integrated as a8bccb2 |
| test-clock | 0 | v2/00-test-clock | b9a83e1 | prior run | done | integrated as e54e779 |
| restart-guard | 1 | v2/01-restart | b9a83e1 | prior run | integrated, review pending | e4b09cb |
| security-defaults | 1 | v2/01-security | b9a83e1 | prior run | integrated, review pending | f3d4ae6 |
| main regressions | 1 | v2/integration | dccab06 | coordinator | done | 13d161d (placeholder price), 4bdaae6 (Node 23 test) |
| security follow-up | 1 | v2/integration | dccab06 | coordinator | integrated, review pending | 9507d11 |
| phase1-review | 1 | v2/01-review, wt review-p1 | c366307 | Fable | done: APPROVE WITH FIXES | 0e6d4d9 tests (+1 todo); F1 high forbidden paraphrases; F2–F8 med/low |
| phase1-fixes | 1 | v2/01-fixes | 0e6d4d9 | Sonnet + coordinator | INTEGRATED (Fable APPROVE, 3 rounds) | ab70292 -> merge 8567083; 1042/1042 both runtimes |
| task-core | 2 | v2/02-task-core | c366307 | Opus | review | 3a4fb9e; 39 tests |
| task-core-verify | 2 | wt verify-02 | 3a4fb9e | Fable | done: APPROVE WITH FIXES | a5f83d2 (11 todo); 2 high |
| task-core-fixes | 2 | v2/02-task-core | 3a4fb9e | Opus + coordinator | INTEGRATED (Fable APPROVE, 4 rounds) | e2bf65f; topic-class map follows widened forbidden list; 1125/1125 both runtimes |
| lease-authority | 12 | v2/08-lease-authority | c366307 | Opus | review | 9e958b6; T25–T27 tests |
| lease-verify | 12 | wt verify-08 | 9e958b6 | Fable | done: APPROVE WITH FIXES | 5d19f6b (4 todo); F1 breaker race |
| lease-fixes | 12 | v2/08-lease-authority | 9e958b6 | Opus + coordinator | INTEGRATED (Fable APPROVE, 4 rounds) | 5b094e5 -> dc04001 |
| system-ops | 12 | v2/10-system-ops | 9e958b6 | Sonnet | review | b5ffaac; T32–T38, T40 |
| system-ops-verify | 12 | wt verify-10 | b5ffaac | Fable | done: APPROVE WITH FIXES | c50f7ff (18 todo) |
| system-ops-fixes | 12 | v2/10-system-ops | b5ffaac | Sonnet + coordinator | INTEGRATED (Fable APPROVE, 3 rounds) | a0b46a6 -> merge |
| goal-loop | 5 | v2/05-goal-loop | be60274 | Opus | INTEGRATED (Fable APPROVE, 6 rounds) | dc425dc -> merge |
| routing | 4 | v2/04-routing | c366307 | Sonnet | INTEGRATED (verifier APPROVE, 3 rounds) | b9a88f2 -> merge 71d9b39; 991/991 both runtimes |
| routing-verify | 4 | wt verify-04 | fd3e4d6 | Opus | in progress | |
| adapters+worktrees | 3 | v2/03-adapters | c366307 | Sonnet | review | 106bd36 (fake CLIs only) |
| adapters-verify | 3 | wt verify-03 | 106bd36 | Opus | done: APPROVE WITH FIXES | 190bf01 (15 todo); 1 high remove() data loss |
| adapters-fixes | 3 | v2/03-adapters | 106bd36 | Sonnet + coordinator | INTEGRATED (Opus APPROVE, 3 rounds) | 312ab55 -> merge; D-011 --full-auto seam fixed 85cd076 |
| integration-agent | 12 | v2/09-integration-agent | merge of 02+08+03 | Opus | review | a14a72a (b7d0788); T24–T31, T39, GL12 |
| integration-verify | 12 | wt verify-09 | a14a72a | Fable | done: APPROVE WITH FIXES | 631409d (5 todo); F1 high self-approval via handoff |
| integration-fixes | 12 | v2/09-integration-agent | a14a72a | Opus + coordinator | INTEGRATED (Fable APPROVE, 3 rounds) | -> 063380e; usage.incomplete seam fixed in store |
| ui-docs | 6 | v2/06-ui-docs | a292b90 | Sonnet + coordinator | INTEGRATED (Opus APPROVE, 2 rounds) | b114077 |
| acceptance + delivery bridge | 7 | v2/11-e2e | b781cdc | Opus | INTEGRATED (Fable DV1-DV4 fixes re-probed in the final review) | 469aa49; matrix 54/54 PASS |
| final full-process review | 9 | wt fable-final | a8aa4c0 | Fable | APPROVE; M1/M2/m5/m7 fixed in 4303d43; m1-m4, m6 and two test gaps recorded below | 4303d43 |

## Decision journal

| ID | Decision | Alternatives | Rationale / evidence | Reversible |
|---|---|---|---|---|
| D-001 | Cherry-pick reviewed-by-tests Phase 1 commits onto `origin/main` rather than merge the b9a83e1-based branches | merge; re-implement | Linear, small history; only docs/tests overlap; full suite green after pick | yes (revert) |
| D-002 | `PLACEHOLDER` price rows are treated as unpriced by `priceFor` | revert dccab06; leave $0 | Main's dccab06 broke the "cost unknown, not guessed" test and violates T22/OWNER §4 (unknown stays unknown). Keeps the owner's grep-able rows. | yes |
| D-003 | Canonical test runtime: both `/usr/local/bin/node` (v23.6, what the live unit's `env node` resolves to) and Node 24.21 must pass | Node 24 only | Prior evidence used Node 24 only and hid 5 Node 23 failures (unref'd abort timer in a test) | yes |
| D-004 | Project policy file is `.ai/project.json`, not YAML | add YAML dep; hand-rolled YAML | One-runtime-dependency rule; JSON is built in | yes |
| D-005 | Example unit binds loopback; live unit untouched; `manager-fresh.sh` prepends `$HOME/.local/bin` to PATH | leave example at 0.0.0.0 | Example contradicted the security contract; prior run removed the absolute CLI path the timer relied on | yes |
| D-007 | Add `waiting -> integrating` transition | keep blocks as events only | Integration controller must park retryable blocks (lease busy, CI pending) visibly as `waiting` and resume | yes |
| D-008 | Lease namespace adds `repo:<r>:branch:<name>` | main-only targets | Integration to non-main targets needs a fenced lease too | yes |
| D-009 | Coordinator authors small residual fixes when every developer slot is busy; an independent Fable verifier checks them | wait for a slot | Owner's 3-developer cap; independence preserved (author != verifier) | yes |
| D-010 | Gate exit codes captured by a script (`gate.sh`, outside the repo) | inline one-liner | The earlier one-liner printed `$?` after a command substitution; counts were right but the exit column was not reliable | yes |
| D-011 | Advisory `launchWarnings` keeps flagging `--full-auto`; the adapters' hard bypass guard does not refuse it | refuse it everywhere | `--full-auto` keeps Codex's workspace-write sandbox (adapter verifier ruling); owner still sees the warning for explicit overrides | yes |
| D-012 | No-progress rule: a falling failing-test count is new passing evidence; the iterations-without-progress trigger is a policy field (default 6) | pure per-check evidence | Per-check counting turned the extra trigger into an attempt counter (verifier V13) | yes |
| D-013 | `high`/`critical` risk tasks need an owner approval bound to the exact head SHA before `accepted`, besides independent review | treat high like low | Phase 5 exit: high-risk gates trigger owner approval | yes |
| D-014 | An owner `route` grant for a critical task is honoured by the router floor | loop asks forever | Approval must be able to unblock; grant is bound to the task | yes |
| D-015 | Remove `leases.adoptOwn`; `acquire` accepts a caller-chosen `lease_id`, worktrees write `{resource, lease_id, owner, task_id}` ahead of acquiring and recover with `adopt(attempted)` | adoptOwn restricted to worktree namespace; fenced takeover | `E_HELD` discloses owner+task_id, so adoptOwn let any contender take over any live lease; twins also both got valid handles. Write-ahead id keeps lease identity private and fences twins | yes |
| D-016 | One goal-loop controller per store via lease `service:<host>:goal-loop` (short TTL, renewed by the loop); a second instance fails closed | per-controller instance id in owner identity | Two same-owner controllers could step one task; the lease fences other instances without new identity machinery | yes |
| D-017 | A store handle's implicit first access only replays (no writes); torn/unconfirmed tasks refuse writes (`recovery_pending`) until an explicit `recover()` under the controller lease | recover on first read | A second process's first read used to mark another controller's live run possibly_applied. Wiring rule: one store handle per process, shared by the HTTP routes and the loop | yes |
| D-018 | Owner cancel always succeeds: `loop.cancel()` takes the controller lease and runs `recover()` first when the view shows `recovery_pending`, then transitions | store appends cancel over a torn tail | Appending without recovery would corrupt a torn line; recovery under the lease is the safe path and keeps T14 | yes |
| D-019 | mcode TUI full-permission mode is its own config key `permissionMode: bypassPermissions`, documented in INSTALL, never written by code | write ~/.minimax/config.yaml from the server | mcode 0.6.5 TUI has no permission flag (only `mcode exec --permission full`); editing the user's CLI config is invasive | yes |
| D-020 | Dashboard approve/deny/cancel go through the goal loop under the controller lease; no loop in the process → 503, another live controller → 409, nothing written | store owner lock; keep direct writes | Owner answers must never be lost or written behind the single writer's back (m3; D-016/D-017/D-018) | yes |
| D-021 | V2 runs only in repositories listed in `GHOSTY_V2_REPOS` (realpath match), each with a `.ai/project.json` whose allowlists govern its tasks (a missing or invalid policy keeps the repo listed but every task stops at a T01 clarification, `awaiting_approval`); worktrees under the required `GHOSTY_V2_WORK_ROOT` (no overlap with the checkout, state dir or listed repos); developer pins via `preferred_models` only narrow routing and pinned models never review | allowlist inside the server's own `.ai/project.json`; any repo with a policy file | Explicit, per-install list; the target repo's own policy governs; nothing outside it executes | yes |
| D-022 | The wired server estimates a Claude run at its own `--max-budget-usd` bound (`GHOSTY_V2_CLAUDE_RUN_USD` lowered to the cap left), USD only | keep "estimate unknown" for the first run; measured mean | The bound is the hard per-run limit, so a capped task never overspends by one run and the first Claude run needs no owner confirmation; token/duration estimates still come from measurements | yes |
| D-023 | MiniMax `mcode exec` V2 worker runs (developer and reviewer, each inside its isolated V2 task/review worktree) launch with `--permission full` (OWNER_DECISIONS §12.1; started in the worktree, `--cwd` is not a sandbox: any host command, same threat model as the dashboard default): the adapter marks its own flag pair trusted; caller-supplied bypass flags (`--permission off/full` in extraArgs, `--dangerously-*`, `--auto`) are still refused and the other adapters keep their modes. Corrects D-019's consequence: only the mcode TUI needs `permissionMode` in its config.yaml, exec workers use the flag | keep `--permission smart` | Owner decision 2026-10-12; smart mode stalled exec workers on permission prompts nobody can answer | yes |
| D-024 | Run limits are policy: `{ timeout_ms, max_steps, effort, context_mode, stall_runs_to_no_progress }` per runtime/model and task class (router work type, optionally `:risk`), most specific wins field by field: task `run_limits` > `.ai/project.json` `run_limits` > registry entry `run_limits` > engine defaults (run timer, no step cap, runtime-default effort, standard context, §4 rule only). Light models on docs/test/coding:low default to 120 s (150 s until the round-4 sanity run), 40 steps, effort low where supported, 2 stalled runs to `waiting/no_progress`; an effort an entry does not support rejects the candidate (never translated); limits a CLI cannot apply are dropped with a recorded note; lightweight context only for text-only reviewer roles on fresh runs | one global run timeout (`GHOSTY_V2_RUN_TIMEOUT_MS`) | The owner's problem was a cheap model spending 5 x 2.5 min on an impossible task; capable models keep the §4 rule (no attempt cap) | yes |
| D-025 | Billing per registry entry (`per_token` / `subscription` / `unknown`; claude/codex per_token, minimax subscription) with an optional `quota {period, tokens, usd}`. A subscription run records usd null + `billing: subscription` (never a measured $0); for USD caps its marginal USD counts as 0 (no unknown-cost confirmation); routing prices its tokens at the quota share (usd/tokens) or a nominal 0.05 USD/Mtok, so it is known, near zero and still grows with tokens. Measured mean tokens per run replace the task estimate in every cost; a known first-pass rate scales quality by 0.85..1. Router history comes from the scorecard of the store the server already has (read-only, 60 s cache) | treat MiniMax cost as unknown (worst) | Unknown made the flat-rate model rank last on cost and asked the owner on every capped run | yes |
| D-026 | Escalation ladder for low/medium-risk, non-security tasks with cost/balanced priority (`.ai/project.json` `routing.escalation`, default on): rungs = floored router candidates ordered by tier, billing (subscription first), estimated cost; the start is the cheapest rung whose quality reaches 0.5 (needs two known-cost candidates); a forced strategy change on failing checks or a reviewer rejection escalates to the next strictly higher rung (`escalate_model`, journaled as a strategy_change and an assign_developer decision). Rungs are floored candidates, so the ladder never goes below MIN_TIER_BY_RISK, security work and high/critical risk keep their ranking and reviewers, and a pinned task (preferred_models) never leaves its pins. Stalls on a short leash stop for the owner instead of escalating | always route by score | Owner wants the cheapest good-enough model first and Haiku/Sonnet only when evidence says so | yes |
| D-006 | Leak scan = `scripts/leak-scan.js` (generic patterns) + private denylist outside the repo (`LEAK_SCAN_EXTRA`) | patterns in repo | Real identifiers must never be committed, including in the scanner | yes |

## OWNER-REVIEW / owner actions (collected for the PR)

- Live unit sets `HOST=0.0.0.0` explicitly (read-only inspection). Upgrading keeps it (no access break) and now logs a
  warning; owner should switch to `127.0.0.1` + private Serve or a literal Tailscale IP.
- Owner default since 2026-10-11: dashboard-created and resumed Claude/Codex sessions and the manager skip permission
  prompts and pre-accept folder trust (`AGENT_CMD_*` overrides win). For the MiniMax TUI, set `permissionMode: bypassPermissions`
  in `~/.minimax/config.yaml`: the `mcode` TUI has no flag for it (D-019). V2 `mcode exec` workers and reviewers need
  nothing: they run `--permission full` (D-023).
- Before upgrading, set `ANDROID_APP_PACKAGE`, `ANDROID_APP_SHA256`, `LANGFUSE_PUBLIC_URL` and `PUBLIC_URL` in the service
  environment: assetlinks, the Langfuse link and the https hints now come from configuration, not the source.
- Set `MCODE_NODE_DIR` in the service environment where `node` is 23.x (mcode 0.6.3 needs Node 24).
- V2 execution is wired into the server behind `GHOSTY_V2=1` (round 3, off by default): one process shares one store
  handle with the goal loop and runs `recover()` under the controller lease at startup (D-016, D-017). With V2 on, dashboard
  approve, deny and cancel and proposal approvals go through the loop; with it off they answer 503 (D-020). Enable steps:
  INSTALL "Optional: V2 task engine".
- `usage/prices.json` PLACEHOLDER rows (gpt-6-luna, gpt-6-sol) need real prices; until then cost shows unknown. The MiniMax-M3
  row no longer matters for V2: MiniMax is billed `subscription` in the registry (D-025), so V2 never prices it per token.
- Forbidden-topic floor accepts low-severity false positives (safe direction, an owner tap): "call the client method",
  "publish the event", "roll out", "I'll pass. Word", "Re start", "Bill ing", "pass/word", "we pass words". Tune only
  with a fresh review.
- Integration worktrees under the integration controller's work dir accumulate; clean them up manually.
- The bench dry run spent USD 5.15 measured plus 13.50 estimated against the USD 20 authorization (see SCORING.md).

---

## History from the prior run (Phase 0 / early Phase 1)

## Phase 0 — COMPLETE (inventory and baseline only)

Base: `b9a83e14b7167a2efb35fa6c4367a692fadb94d1`. Branch: `v2/00-baseline`.

User invoked `docs/tasks/v2/PROMPT.md`. Integration agent assembled this disposable worktree after independent inventory and test-clock review. Original checkout contains unrelated server edits and untracked files, preserved outside this worktree. Task specifications copied unchanged as the authorized implementation reference.

Scope: inventory source and safety boundaries, run isolated baseline checks, record reproducible evidence and synthetic lifecycle fixture. No runtime behavior changes in Phase 0.

Acceptance: source references, suite and reporter/dry-run outcomes, limitations, independent review.

Next: independently verify security-defaults and restart-guard commits, then reconcile on a fresh disposable integration worktree.

Phase 1: IN PROGRESS in isolated worktrees. Phases 2–7 and lease/integration/system-operations extensions: NOT STARTED. T01–T40 and GL01–GL14: NOT RUN as V2 acceptance gates.

## Checkpoint: baseline failures classified

Inventory and evidence recorded in `docs/v2/`. Main suite 839/858 passes; 19 failures share stale October 1 date fixtures. Reporter 25/25 passes. Router dry-run wake agreement 6/10 requires investigation, not a PASS badge.

| Task | Parent | Owner | Branch | State |
|---|---|---|---|---|
| baseline-inventory | v2-phase-0 | inventory agent | v2/00-baseline | independently reviewed and recorded |
| test-clock | v2-phase-0 | test_clock agent | v2/00-test-clock | independently verified; locally integrated |
| security-defaults | v2-phase-1 | security agent | v2/01-security | independent implementation in progress |
| restart-guard | v2-phase-1 | restart agent | v2/01-restart | implementation in progress |

All branches start at the recorded baseline. At most two implementation workers active. Integration will use a separate disposable worktree; no shared branch or remote mutation authorized. Phase 0 inventory/baseline gate is complete; router discrepancies remain documented work, not a claimed routing PASS. Baseline observed failure is retained in evidence rather than overwritten by repaired results.

Decision: fix clock-dependent tests because the suite must remain useful across dates; do not change production date filtering. Choose safe loopback and normal CLI permission defaults as specified. Unknown leases never imply permission. No arbitrary attempt ceiling is introduced.

## Local integration checkpoint

Reviewed source repair `e9fbf2b78fb5934f1c2d7559096a1d496b6028e6` was cherry-picked as `1bc82f962f82966488a83bc71d5c1eab23faa48a`. Full sanitized regression suite on that exact local SHA: 859 passed, zero failed/skipped. Only documentation is added afterward. Independent verifier did not author the clock patch.

Authority was exclusive ownership of this disposable local worktree only; no shared-resource lease or remote permission is implied. Main has advanced to reported `dccab06` and retains unrelated changes. Eventual integration must resolve the fresh full main SHA, preserve owner changes, and rerun gates on the resulting integration SHA. No shared/main/remote mutation occurred.

Use mycodebox as the product/repository name; preserve existing technical service/package/path identifiers until migrated.
