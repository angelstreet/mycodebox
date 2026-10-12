STATUS: RUNNING — round 3: wiring the V2 engine into the server (OWNER_DECISIONS §11)

# V2 progress

Coordinator: Opus (Claude Code), unattended. Integration branch `v2/integration`, base `origin/main` `dccab06`.
Worker worktrees: `~/mycodebox-v2-wt/<branch-suffix>`. Contract: `docs/v2/ARCHITECTURE.md`.

## Next action

Round 3 (OWNER_DECISIONS §11) in progress; see "Round 3" below. SHAs quoted before round 2 in this file, in
V2_VERIFICATION.md history and in docs/v2/* are **pre-rewrite SHAs** (GitHub history was rewritten on 2026-10-11 to
scrub the tailnet identifiers); they no longer resolve. Round-2 entries quote current SHAs.

## Round 3

Base: `origin/v2/integration` c23ebe8. Owner spec: OWNER_DECISIONS §11.

| Item | Scope | Owner (model) | State | Result |
|---|---|---|---|---|
| R3-1 | Wire the V2 engine into the server behind `GHOSTY_V2=1` (lease, recover, scheduler, execution, approvals, integration, system ops) | Opus / Fable review | IN PROGRESS (wt r3-wire) | |
| R3-2 | Benchmark through the HTTP API of a disposable wired server (USD 20 cap), compare with round 2 | Sonnet driver + coordinator | TODO (after R3-1) | |
| R3-3a | MiniMax impossible task ends `waiting`/no_progress before the time cap | Opus / Opus review | IN PROGRESS (wt r3-noprog) | |
| R3-3b | Drop stale "main's git history" owner action | coordinator | DONE | history was rewritten |
| R3-3c | Docs: enable / roll back V2 on the live install | coordinator | TODO | |
| R3-4 | Gates on final SHA, V2_VERIFICATION, PR round-3 section, DELIVERED | coordinator | TODO | |

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
| D-006 | Leak scan = `scripts/leak-scan.js` (generic patterns) + private denylist outside the repo (`LEAK_SCAN_EXTRA`) | patterns in repo | Real identifiers must never be committed, including in the scanner | yes |

## OWNER-REVIEW / owner actions (collected for the PR)

- Live unit sets `HOST=0.0.0.0` explicitly (read-only inspection). Upgrading keeps it (no access break) and now logs a
  warning; owner should switch to `127.0.0.1` + private Serve or a literal Tailscale IP.
- Owner default since 2026-10-11: dashboard-created and resumed Claude/Codex sessions and the manager skip permission
  prompts and pre-accept folder trust (`AGENT_CMD_*` overrides win). For MiniMax, set `permissionMode: bypassPermissions`
  in `~/.minimax/config.yaml`: `mcode` has no flag for it (D-019).
- Before upgrading, set `ANDROID_APP_PACKAGE`, `ANDROID_APP_SHA256`, `LANGFUSE_PUBLIC_URL` and `PUBLIC_URL` in the service
  environment: assetlinks, the Langfuse link and the https hints now come from configuration, not the source.
- Set `MCODE_NODE_DIR` in the service environment where `node` is 23.x (mcode 0.6.3 needs Node 24).
- V2 execution is not wired into the server: when it is, the HTTP routes and the goal loop must share one store handle in
  one process, and `recover()` must run under the controller lease at startup (D-016, D-017). Until then dashboard
  approve, deny and cancel answer 503 (D-020) and proposal tasks cannot be approved from the dashboard.
- `usage/prices.json` PLACEHOLDER rows (MiniMax-M3, gpt-6-luna, gpt-6-sol) need real prices; until then cost shows unknown.
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
