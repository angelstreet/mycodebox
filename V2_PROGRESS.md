STATUS: RUNNING — all packages except goal-loop integrated; goal-loop fixing Fable findings; ui-docs in Opus review; acceptance harness in development

# V2 progress

Coordinator: Opus (Claude Code), unattended. Integration branch `v2/integration`, base `origin/main` `dccab06`.
Worker worktrees: `~/mycodebox-v2-wt/<branch-suffix>`. Contract: `docs/v2/ARCHITECTURE.md`.

## Next action

See the task ledger: start or resume every row whose state is `ready`/`in progress`; review rows in `review`.

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
| goal-loop | 5 | v2/05-goal-loop | be60274 | Opus | round-4 fixes 2cf2855 (1476/1476); Fable re-checks: goal loop, lease (D-015), store (D-017) | |
| routing | 4 | v2/04-routing | c366307 | Sonnet | INTEGRATED (verifier APPROVE, 3 rounds) | b9a88f2 -> merge 71d9b39; 991/991 both runtimes |
| routing-verify | 4 | wt verify-04 | fd3e4d6 | Opus | in progress | |
| adapters+worktrees | 3 | v2/03-adapters | c366307 | Sonnet | review | 106bd36 (fake CLIs only) |
| adapters-verify | 3 | wt verify-03 | 106bd36 | Opus | done: APPROVE WITH FIXES | 190bf01 (15 todo); 1 high remove() data loss |
| adapters-fixes | 3 | v2/03-adapters | 106bd36 | Sonnet + coordinator | INTEGRATED (Opus APPROVE, 3 rounds) | 312ab55 -> merge; D-011 --full-auto seam fixed 85cd076 |
| integration-agent | 12 | v2/09-integration-agent | merge of 02+08+03 | Opus | review | a14a72a (b7d0788); T24–T31, T39, GL12 |
| integration-verify | 12 | wt verify-09 | a14a72a | Fable | done: APPROVE WITH FIXES | 631409d (5 todo); F1 high self-approval via handoff |
| integration-fixes | 12 | v2/09-integration-agent | a14a72a | Opus + coordinator | INTEGRATED (Fable APPROVE, 3 rounds) | -> 063380e; usage.incomplete seam fixed in store |
| ui-docs | 6 | v2/06-ui-docs | a292b90 | Sonnet + coordinator | APPROVED (Opus, 2 rounds); lows fixed d9d50f8; integrate after goal-loop | 43fe411; T20 37/37 |

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
| D-006 | Leak scan = `scripts/leak-scan.js` (generic patterns) + private denylist outside the repo (`LEAK_SCAN_EXTRA`) | patterns in repo | Real identifiers must never be committed, including in the scanner | yes |

## OWNER-REVIEW / owner actions (collected for the PR)

- Live unit sets `HOST=0.0.0.0` explicitly (read-only inspection). Upgrading keeps it (no access break) and now logs a
  warning; owner should switch to `127.0.0.1` + private Serve or a literal Tailscale IP.
- Live install has no `AGENT_CMD_CLAUDE`/`AGENT_CMD_CODEX` overrides: after upgrade, new and resumed Claude/Codex
  sessions use normal permission prompts and folder-trust prompts (intended safe default; owner-visible change).
- Forbidden-topic floor (stall.js) was widened after review; Fable lists low-severity false positives (e.g. "call the client method", "publish the event") that now need an owner tap. Safe direction; tune only with a fresh review.
- V2 execution is not wired into the server: when it is, the HTTP routes and the goal loop must share one store handle in one process, and `recover()` must run under the controller lease at startup (D-016, D-017).
- `usage/prices.json` PLACEHOLDER rows (MiniMax-M3, gpt-6-luna, gpt-6-sol) need real prices; until then cost shows unknown.

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
