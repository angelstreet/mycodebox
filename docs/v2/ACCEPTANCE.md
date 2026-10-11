# V2 acceptance matrix (T01–T40, GL01–GL14)

Status: **evidence ledger for the V2 release gate**, synthetic data only. Rows come from
`docs/tasks/v2/MYCODEBOXV2_AGENT_TASK.md` §7 and §12.7 and `docs/tasks/v2/GOAL_LOOP_CONTRACT.md`.
The statuses below were produced by `node scripts/v2-acceptance.js` at the commit named in
`docs/v2/acceptance-results.json`; rerun it on the exact integration SHA before relying on them.

## How a row gets its status

- Every test whose **name starts with matrix ids** (`T07: …`, `GL02/T09 …`, `T27 (file): …`) is evidence for those
  rows. `scripts/v2-acceptance.js` runs the whole suite once (`node --test test/*.test.js`, fresh temp
  `GHOSTY_STATE_DIR`), maps results by that prefix and writes `docs/v2/acceptance-results.json` (ids, statuses, test
  names, SHA, Node version, timestamp; no captured output).
- **PASS**: at least one mapped test executed and every mapped test passed. **FAIL**: a mapped test failed, no test
  carries the id, or an independent verifier recorded an open defect against the row (a failing `todo` test; the
  runner maps verifier defects without a matrix prefix to the rows they contradict, in `DEFECT_ROWS`). **MANUAL**: evidence that cannot run inside `node --test`; T20 (the browser check) becomes
  PASS/FAIL when the runner is started with `PLAYWRIGHT_CORE` set, MANUAL otherwise. **PENDING / BLOCKED**: not used.
- T16 additionally requires every test in every pre-V2 test file to pass. "Pre-V2" is pinned to `origin/main`'s test list in
  the committed manifest `scripts/pre-v2-tests.json` (regenerate from `git ls-tree --name-only origin/main test/`; offline-safe),
  and a pinned file with no results fails the row. A failure or open defect that maps to no matrix row fails the run.
- `test/v2-acceptance-matrix.test.js` pins these rules.

Scope labels say exactly what ran: *fake runtime* = the scriptable in-process adapter
(`orchestration/adapters/fake.js`); *stub CLI* = a temp executable that speaks a CLI's JSON stream behind the real
adapter; *disposable bare remote* = a temp `git init --bare` origin; *fake remote CI* / *fake telemetry* = injected
status functions. No test calls a real provider, a real remote, systemd or the live state dir.

## Summary

| Status | Rows |
|---|---|
| PASS | 54 |
| FAIL | 0 |
| PENDING | 0 |
| BLOCKED | 0 |
| MANUAL | 0 |

Suite at `4303d43` on Node v23.6.0: 1606 tests, 1606 pass, 0 fail, 0 todo, 0 skipped.

## Matrix

| ID | Scenario | Required assertion | Scope | Status |
|---|---|---|---|---|
| T01 | Project policy absent or invalid | Refuse execution, request owner clarification | unit (policy.js) + integration (goal loop, real git, fake runtime) | **PASS** |
| T02 | Restricted action disguised in task text | Policy wins regardless of model | unit/security (policy.js, manager forbidden-topic matcher) | **PASS** |
| T03 | CLI startup, resume, park | Validated argv/cwd; V2 workers never get bypass flags (owner decision 2026-10-11 supersedes the original "no bypass by default" for dashboard sessions) | unit + integration (real adapters against stub CLIs; launch-config, parking, session-directory) | **PASS** |
| T04 | Network listener, origin and reporter endpoint | Default loopback, rejected unauthorized route | unit (launch-config, reporter.js handlers) + static source check of server.js routes | **PASS** |
| T05 | Parallel worktrees | No shared mutable worktree; same repo can host disjoint agents | integration (real git worktrees, file lease authority) | **PASS** |
| T06 | Duplicate event/outcome | Exactly one state transition/effect | unit (store) + crash E2E (goal loop restart, duplicate owner decision) | **PASS** |
| T07 | Restart between attempted and confirmed side effect | Remains unknown until reconciled; no blind duplicate | integration (store restart + fake external sink); remote variant in T30 (disposable bare remote) | **PASS** |
| T08 | Source MCP or provider unavailable | State says unavailable/blocked, not empty/success | integration (goal loop, real Claude adapter with a missing binary, fake runtimes; CI/telemetry/lease sources) | **PASS** |
| T09 | Unit test fails | Cannot mark completed; bounded fix/review/abort | E2E (goal loop, real git + node --test acceptance check, fake runtime) | **PASS** |
| T10 | Failed verification after source change | Revalidate commit SHA and rerun affected tests | E2E (goal loop, real git, fake runtime) | **PASS** |
| T11 | Adapter capability absent | Reject unsupported route, provide compatible fallback | contract (adapters vs stub CLIs, router) + E2E (GL11 cross-provider) | **PASS** |
| T12 | Rate limit / timeout / quota exhausted | Backoff and bounded compatible fallback | integration (adapters vs stub CLIs, router, goal loop with fake runtime) | **PASS** |
| T13 | Budget/time/turn cap | Stop/ask owner, no extra spending after cap | unit (budget.js) + E2E (goal loop, fake runtime with synthetic usd) | **PASS** |
| T14 | Cancellation during spawn/check | No unauthorized subsequent execution, status accurate | integration (adapters, real process groups) + E2E (goal loop) | **PASS** |
| T15 | Reviewer disagrees with maker | Test evidence and policy decide; owner if unresolved | integration (goal loop, scripted fake reviewer) | **PASS** |
| T16 | Existing dashboard/send/reply/status and push | No regression in original workflows | regression (every pre-V2 test file) + static import graph of server.js + inert-import check | **PASS** |
| T17 | Forbidden topic in manager auto-send | No send; human escalation | security regression (unit, manager.js) | **PASS** |
| T18 | Reboot/state recovery | Resume only confirmed work; no lost or duplicate events | E2E (store crash injection, goal loop controller crash + restart) | **PASS** |
| T19 | Existing state migration | Read old state safely and reversibly | integration (temp GHOSTY_STATE_DIR seeded with synthetic legacy files) | **PASS** |
| T20 | Mobile/desktop app/PWA | Screens, keyboard, service worker, responsive task view | browser E2E (scripts/v2-ui-check.js: headless Chromium via playwright-core, server.js child with GHOSTY_V2=1, private tmux socket, temp state, loopback port) | **PASS** |
| T21 | Safe restart with unreachable API | Refuse and show reason; never assume idle | security (scripts/safe-restart.sh executed with stub curl, sudo and systemctl on PATH) | **PASS** |
| T22 | Usage unknown / stale pricing | Do not report $0 or route on fabricated metrics | unit (store, budget, router, registry) | **PASS** |
| T23 | External write confirmation | Advance bookmark/ledger only after confirmation | integration (store effect ledger + fake external sink); remote variant in T30 | **PASS** |
| T24 | Multi-agent branch integration | Conflicts detected, checks re-run on merge SHA | Git E2E (integration controller, disposable bare remote) | **PASS** |
| T25 | Two Integration Agents race for the same branch | Exactly one fenced lease holder mutates branch | integration (file lease authority, separate node processes) + Git E2E | **PASS** |
| T26 | Lease backend unavailable or stale | No merge/push/restart; state blocked and operator alerted | integration (fake/file lease backends) + Git E2E | **PASS** |
| T27 | Lease expires mid-command | Stale executor cannot commit an additional protected action | integration (lease authority, lying clock) + Git E2E (integration controller, cross-role takeover) | **PASS** |
| T28 | Integration branch updated after tests | SHA mismatch invalidates previous gate; all required tests rerun | Git E2E (controller alone, and goal loop + controller with upstream commits) | **PASS** |
| T29 | Remote CI red, missing, or pending | No merge, even when local tests are green | Git E2E (disposable bare remote, fake remote CI status) | **PASS** |
| T30 | Push times out after remote accepted it | Query remote SHA first; do not double-push/mark failed blindly | Git E2E (disposable bare remote, injected push timeouts) | **PASS** |
| T31 | Unapproved merge/deploy request | Must refuse; audit records actor and required approval | Git E2E (integration controller) | **PASS** |
| T32 | Disk reaches configured pressure threshold | Report incident, pause admission, no destructive cleanup without approval | integration (system ops, fake telemetry, file lease) + E2E with the goal loop | **PASS** |
| T33 | CPU pressure during integration/E2E | Throttle or pause safely; keep task state and leases consistent | integration + E2E (goal loop + integration controller on a disposable remote + system ops, shared lease authority) | **PASS** |
| T34 | Host recovery while deployment active | Recovery waits/blocks or requests explicit override; never blind restart | integration (system ops, fake deploy registry) | **PASS** |
| T35 | Service health metric stale/unreachable | Health unknown, not healthy; escalation rules apply | integration (telemetry + system ops, fake probes) | **PASS** |
| T36 | Two developers report same host issue | One incident + linked reports, no duplicate remediation | integration (incident store + system ops) | **PASS** |
| T37 | Maintenance action fails mid-execution | Checkpoint, rollback/reconcile if safe, maintain incident state | integration (system ops, failing fake executor) | **PASS** |
| T38 | Service recovers, queued tasks resume | Fresh health check + released maintenance lease before admission | integration + E2E (goal loop waits on admission, resumes after a fresh reading) | **PASS** |
| T39 | Integration E2E on disposable Git remote | Worktree patch -> independent verify -> integration -> CI success -> authorized push/merge, exact SHAs recorded | Git E2E (controller alone; and the full goal loop in GL14) | **PASS** |
| T40 | Developer requests system command | Request routed to System Operations; developer cannot execute privileged maintenance via orchestration | integration + E2E (goal loop -> request-only facade) | **PASS** |
| GL01 | Task from UI/API/schedule/agent | Equivalent goal contract and loop | unit (task contract) + E2E (goal loop) | **PASS** |
| GL02 | First implementation fails a deterministic test | Structured feedback, fix, pass on exact SHA, independent approve; no 3-attempt cutoff | E2E (goal loop, real git, node --test check, fake runtime + scripted reviewer) | **PASS** |
| GL03 | Repeated identical failure | Replan/harness/model change by evidence; >= 4 failing iterations before success | E2E (goal loop) | **PASS** |
| GL04 | Missing artifacts / unavailable evaluator | waiting/blocked, never completed | E2E (goal loop) | **PASS** |
| GL05 | Reviewer rejects a superficially passing patch | Developer repairs; checks rerun | E2E (goal loop, scripted reviewer) | **PASS** |
| GL06 | Provider outage, rate limit, context exhaustion, crash | Task state preserved; resume idempotently | E2E (goal loop, crash injection) | **PASS** |
| GL07 | No-progress loop | Diagnostic replan/backoff/suspend; no false success, no runaway | E2E (goal loop) | **PASS** |
| GL08 | Automatic decisions | Structured rationale, alternatives, evidence, undo; no owner question for safe choices | E2E (goal loop decision journal) | **PASS** |
| GL09 | Credentials, merge/push, deploy, destructive repair | Explicit policy authorization regardless of goal text; silence is never approval | E2E (goal loop) + integration (system ops) | **PASS** |
| GL10 | Lease race / stale fencing; Integration vs System Ops | Fail closed; no conflicting resource mutation; ordered acquisition | integration + Git E2E (goal loop + integration controller + system ops on one lease authority) | **PASS** |
| GL11 | Cross-provider, native delegation, worker fallback | Identical acceptance checks satisfied on every path | E2E (real Claude/Codex adapters vs stub CLIs, native-subagent fake runtime, worker fallback) | **PASS** |
| GL12 | Reopened after crash/conflict/upstream change | Revalidate evidence against current SHA; never trust stale CI | unit (store) + E2E (goal loop) + Git E2E (controller, goal loop + controller) | **PASS** |
| GL13 | Costs and tokens | Measured where available; unknown stays unknown; throttle without inventing authorization | unit (store) + E2E (goal loop) | **PASS** |
| GL14 | Full disposable repo | Intake -> worktree -> repair loops -> independent verifier -> integration staging -> CI-equivalent verification -> accepted/release-ready; UI and machine-readable trace | Git E2E (goal loop + orchestration/delivery.js + integration controller + disposable bare remote + fake remote CI); trace JSON asserted | **PASS** |

## Evidence per row (exact test names)

### T01 — PASS

2 test(s) passed.

- `test/v2-goal-loop.test.js` › T01 missing project policy -> awaiting_approval with a clarification; fixed policy + approval -> proceeds
- `test/v2-policy.test.js` › T01: missing or invalid policy -> refuse, awaiting_approval with a clarification request

### T02 — PASS

2 test(s) passed.

- `test/v2-policy-classes.test.js` › T02: every manager-blocked phrasing maps to a concrete approval class
- `test/v2-policy.test.js` › T02: a restricted action disguised in task text needs approval whatever the model says

### T03 — PASS

13 test(s) passed.

- `test/v2-adapters.test.js` › T03 no adapter argv carries a permission/sandbox bypass flag; safe flags present
- `test/v2-adapters.test.js` › T03 bypass guard throws on injected flags in every form; prompt text is not scanned
- `test/v2-adapters.test.js` › T03 cwd must be a real directory inside an allowed root (incl. symlink escape)
- `test/v2-adapters.test.js` › T03 shell metacharacters in the prompt arrive verbatim as one argv element and are not executed
- `test/v2-security-review.test.js` › T03: default claude/codex/manager/resume commands carry the owner-chosen bypass flags (2026-10-11); minimax and bash do not
- `test/v2-security-review.test.js` › T03: resume never restores a saved process flag; only model, remote-control name and the id come back
- `test/v2-security-review.test.js` › T03: a saved remote-control name is single-quoted for the shell
- `test/v2-security-review.test.js` › T03: a resume id must be a plain token (no options, paths, whitespace, control characters or non-strings)
- `test/v2-security-review.test.js` › T03: sessionDirectory rejects prefix siblings, files, missing dirs, traversal, symlink escapes and non-strings
- `test/v2-security-review.test.js` › T03: a tampered parked record cannot escape $HOME, start before validation, or resume without a cwd
- `test/v2-security-review.test.js` › T03: prototype-named sessions are not parked records
- `test/v2-security-review.test.js` › T03: bypass flags are named only in launch-config (the default) and nowhere else in the server, scripts or modules
- `test/v2-security-review.test.js` › T03: the manager command helper keeps an explicit override verbatim and its diagnostics name only the setting

### T04 — PASS

5 test(s) passed. The Origin check is asserted by reading server.js, not by a running server: tests must not import or start server.js (AGENTS.md).

- `test/v2-security-review.test.js` › T04: loopback by default, an explicit tailnet HOST is honoured, warnings never carry the value
- `test/v2-security-review.test.js` › T04: isLoopback accepts only loopback literals
- `test/v2-security-review.test.js` › T04: the alert channel needs loopback AND the token before it reads a body
- `test/v2-security-review.test.js` › T04: reporter token is created 0600, compared in full, and nothing matches before init
- `test/v2-security-review.test.js` › T04: server routes keep loopback + token on the reporter intake and the Origin check on every mutating request

### T05 — PASS

3 test(s) passed.

- `test/v2-worktrees.test.js` › T05 two tasks get two disjoint worktrees on one repo, each on its own branch
- `test/v2-worktrees.test.js` › T05 a second owner cannot claim or remove the first owner's worktree
- `test/v2-worktrees.test.js` › T05 dirty or untracked trees are never removed; retain is the default

### T06 — PASS

3 test(s) passed.

- `test/v2-acceptance-effects.test.js` › T06: an owner decision delivered twice across a controller restart is one event and one transition
- `test/v2-store.test.js` › T06: same createTask key -> one task, also concurrently and after restart
- `test/v2-store.test.js` › T06: the same event twice has exactly one effect; seq is strictly increasing

### T07 — PASS

2 test(s) passed.

- `test/v2-acceptance-effects.test.js` › T07/T23: restart between attempted and confirmed -> unknown_external_effect; reconciled from the destination, never re-sent; not-applied becomes failed and may be retried once
- `test/v2-store.test.js` › T07: attempted-but-unconfirmed effect across restart -> unknown_external_effect, never repeated

### T08 — PASS

4 test(s) passed. V2 has no MCP/bookmark source reader yet; the sources that exist (runtimes, repository, remote CI, telemetry, lease authority) are covered.

- `test/v2-acceptance-unavailable.test.js` › T08: every runtime unavailable (a real adapter whose CLI is missing, a fake whose probe says down) -> waiting(no_route), not an empty success
- `test/v2-acceptance-unavailable.test.js` › T08: the only allowed provider disappears mid-task -> waiting with backoff, the failure recorded, no fallback outside the allowlist, never success
- `test/v2-acceptance-unavailable.test.js` › T08: the source repository or its base commit cannot be read -> waiting(evidence_unavailable), not "nothing changed"
- `test/v2-acceptance-unavailable.test.js` › T08: status sources behind the gates fail closed: unreachable CI is unknown (never success), unreachable telemetry is unknown (never healthy), an unavailable lease authority grants nothing

### T09 — PASS

2 test(s) passed.

- `test/v2-acceptance-strengthen.test.js` › T09: a unit test that keeps failing never completes: targeted repairs, forced strategy changes, no review of a failing SHA, a bounded no-progress stop, and the owner can abort
- `test/v2-goal-loop.test.js` › GL02/T09 failing first run -> structured feedback -> fix -> pass on exact SHA -> independent approve

### T10 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › T10/GL12 source changes after verification: SHA revalidated, checks and review rerun on the new SHA

### T11 — PASS

7 test(s) passed. OpenCode is not installed on the host: its adapter is only contract-tested against a stub CLI.

- `test/v2-acceptance-cross-provider.test.js` › GL11/T11: real Claude and Codex adapters (stub CLIs), a native-subagent runtime and the ordinary-worker fallback all satisfy the identical acceptance checks
- `test/v2-adapters.test.js` › T11 probe: not installed -> unavailable; failing --version -> unknown; ok -> version
- `test/v2-adapters.test.js` › T11 probe: ambiguous failure -> unknown (non-zero --version exit, hang)
- `test/v2-adapters.test.js` › T11 unsupported ops throw E_UNSUPPORTED
- `test/v2-routing.test.js` › T11: capability absent (vision) -> rejected with reason, compatible fallback offered
- `test/v2-routing.test.js` › T11: effort xhigh unsupported -> those entries rejected with reason; supported ones stay
- `test/v2-routing.test.js` › T11: runtime unavailable by probe -> rejected, others offered; all unavailable -> no choice, waiting

### T12 — PASS

4 test(s) passed.

- `test/v2-adapters.test.js` › T12 429 stderr -> rate_limit with retry_after_ms, retryable
- `test/v2-adapters.test.js` › T12 timeout kills the process group and reports class timeout
- `test/v2-goal-loop.test.js` › T12/GL06 rate limit: backoff (waiting) twice, then a compatible fallback runtime; state preserved
- `test/v2-routing.test.js` › T12: rate limit/timeout -> backoff first, then compatible fallback, never outside the allowlist

### T13 — PASS

3 test(s) passed.

- `test/v2-budget.test.js` › T13: cap reached -> awaiting_approval and no further spend; even a zero estimate is refused at the cap
- `test/v2-budget.test.js` › T13: estimate that would exceed the cap is refused before starting
- `test/v2-goal-loop.test.js` › T13 explicit budget cap: stop before overspend -> awaiting_approval; an owner extension continues within it

### T14 — PASS

5 test(s) passed.

- `test/v2-adapters.test.js` › T14 cancel during spawn: acknowledged, process gone, no later writes
- `test/v2-adapters.test.js` › T14 cancel escalates to SIGKILL when SIGTERM is ignored; events stop after cancel
- `test/v2-adapters.test.js` › T14 fake: cancel during spawn -> acknowledged, no later writes
- `test/v2-goal-loop.test.js` › T14 cancel during a run: no commit, no evidence, no later writes; status is cancelled
- `test/v2-store.test.js` › T14: after cancel every write is rejected with E_CANCELLED; reads still work

### T15 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › T15 tests pass but the reviewer keeps disagreeing: evidence cannot settle it -> owner decides, never accepted
- `test/v2-goal-loop.test.js` › T15 reviewer approves but the required tests are red: never accepted, back to repair (evidence outranks the verdict)

### T16 — PASS

2 test(s) passed; 921 pre-V2 regression tests passed. Row is PASS only when every test in the pre-V2 test files passes as well (scripts/v2-acceptance.js). Seven pre-V2 test files differ from origin/main; see "T16 disclosure" below (router wake defaults changed on purpose).

- `test/v2-acceptance-state.test.js` › T16: server.js loads no V2 module at startup: none in its static import graph; any V2 import is dynamic and behind GHOSTY_V2
- `test/v2-acceptance-state.test.js` › T16: every V2 module is importable without side effects: no timers, listeners, child processes or files
- plus every test in the 71 pre-V2 test files (921 tests)

### T17 — PASS

3 test(s) passed.

- `test/v2-security-review.test.js` › T17: a forbidden topic blocks every answer source — rule, Jev continue, Jev take_recommended — in every case
- `test/v2-security-review.test.js` › T17: the AI reviewer re-check catches a forbidden proposal text even when the question looked harmless
- `test/v2-security-review.test.js` › T17: plain paraphrases of forbidden topics are recognised by the rule filter

### T18 — PASS

5 test(s) passed.

- `test/v2-goal-loop.test.js` › GL06/T18 controller crash mid-run: restart reconciles the unconfirmed run and resumes without duplicates
- `test/v2-goal-loop.test.js` › T18 crash between a decision and its transition: the restart replays the recorded transition, no second decision
- `test/v2-store.test.js` › T18: crash mid-write of the completion leaves a torn tail; recovery drops it, no false completion
- `test/v2-store.test.js` › T18: crash after the log write but before the snapshot: the event is durable and a retry is a no-op
- `test/v2-store.test.js` › T18: crash while writing task.created -> no half task; the same key creates it once later

### T19 — PASS

1 test(s) passed. server.js does not wire V2 yet; the V2 components are placed the way the frozen layout prescribes (store default $GHOSTY_STATE_DIR/v2).

- `test/v2-acceptance-state.test.js` › T19: V2 state lives under $GHOSTY_STATE_DIR/v2 only; legacy files stay byte-identical; removing v2/ restores the old tree exactly

### T20 — PASS

1 test(s) passed. Runs only with PLAYWRIGHT_CORE set (dev-only, not a dependency); without it the runner marks the row MANUAL.

- `scripts/v2-ui-check.js` › T20: browser check (scripts/v2-ui-check.js): 39/39 checks passed (includes the same-origin positive control for the 403 check)

### T21 — PASS

5 test(s) passed.

- `test/safe-restart.test.js` › T21: unreachable API refuses with a visible reason and runs nothing, even when asked to wait
- `test/safe-restart.test.js` › T21: a stale or malformed snapshot while waiting is unknown, not busy: no retry, exit 2
- `test/safe-restart.test.js` › T21: a state outside the known vocabulary is refused whether or not the runner is on
- `test/safe-restart.test.js` › T21: --wait 0 refuses busy work at once; --wait=N is not a form the script accepts
- `test/safe-restart.test.js` › T21: the script owns no kill path and restarts only through systemctl

### T22 — PASS

4 test(s) passed.

- `test/v2-budget.test.js` › T22: unknown spend with a cap -> awaiting_approval, reported unknown, never 0
- `test/v2-routing.test.js` › T22: unknown/placeholder/stale pricing is never $0 and never ranked cheapest
- `test/v2-routing.test.js` › T22: stale price (older than the max age) is treated as unknown for ranking
- `test/v2-store.test.js` › T22/GL13: unknown usage stays null, never 0

### T23 — PASS

3 test(s) passed. No bookmark-bearing source exists in V2 yet: the ledger half is proven; a per-source bookmark must reuse this ledger when one is added.

- `test/v2-acceptance-effects.test.js` › T23: the ledger advances only after the destination confirms; no confirmation, no acceptance and no second send
- `test/v2-acceptance-effects.test.js` › T23: a rejected or unreachable destination never advances the ledger; only a positive acknowledgement does
- `test/v2-acceptance-effects.test.js` › T07/T23: restart between attempted and confirmed -> unknown_external_effect; reconciled from the destination, never re-sent; not-applied becomes failed and may be retried once

### T24 — PASS

3 test(s) passed.

- `test/v2-integration.test.js` › T24 conflicting branches: conflict detected and returned to its developer with files; the other merges
- `test/v2-integration.test.js` › T24 non-conflicting branches: merged sequentially, gates run once on the final merge sha
- `test/v2-integration.test.js` › T24 red gate on the merge sha returns the work even though each branch was green alone

### T25 — PASS

4 test(s) passed.

- `test/v2-integration.test.js` › T25 two integration controllers race on the same target: exactly one fenced holder mutates it
- `test/v2-lease-authority.test.js` › T25: 40 parallel acquire() through one file dir -> exactly one holder, rest E_HELD
- `test/v2-lease-authority.test.js` › T25: separate node processes contend on the same resources -> exactly one holder per resource
- `test/v2-lease-authority.test.js` › T25: the losing contender never runs its protected action (withLeases)

### T26 — PASS

12 test(s) passed.

- `test/v2-integration.test.js` › T26 lease backend unavailable or stale: no merge/push, blocked and alerted
- `test/v2-integration.test.js` › T26 deployment state unknown blocks integration before any lease or mutation
- `test/v2-lease-authority.test.js` › T26: fake backend 'unavailable' -> acquire/validate E_UNAVAILABLE, mutation never runs, alert + audit
- `test/v2-lease-authority.test.js` › T26: fake backend 'stale' -> acquire/validate E_UNAVAILABLE, mutation never runs, alert + audit
- `test/v2-lease-authority.test.js` › T26: fake backend 'timeout' -> acquire/validate E_UNAVAILABLE, mutation never runs, alert + audit
- `test/v2-lease-authority.test.js` › T26: fake backend 'clock_skew' -> acquire/validate E_UNAVAILABLE, mutation never runs, alert + audit
- `test/v2-lease-authority.test.js` › T26: partial write leaves the resource unavailable (not free) until repaired
- `test/v2-lease-authority.test.js` › T26: file backend corrupt record -> acquire and validate E_UNAVAILABLE; torn tmp file is ignored
- `test/v2-lease-authority.test.js` › T26: file backend record deleted while audit has history -> E_UNAVAILABLE, generation not restarted
- `test/v2-lease-authority.test.js` › T26: file backend I/O error -> E_UNAVAILABLE and alert
- `test/v2-lease-authority.test.js` › T26: unwritable backend dir -> E_UNAVAILABLE
- `test/v2-lease-authority.test.js` › T26: stale lock file is never broken while its holder lease is live (fails closed)

### T27 — PASS

5 test(s) passed.

- `test/v2-acceptance-ops.test.js` › GL10/T27: stale fencing across roles: the integrator's lease expires mid-gate and System Ops takes the lane; the stale integrator pushes nothing and the task waits
- `test/v2-integration.test.js` › T27 lease expires mid-run and is taken over: the stale executor cannot push
- `test/v2-lease-authority.test.js` › T27 (file): lease expires mid-command -> second protected action blocked; stale token fenced despite a lying clock
- `test/v2-lease-authority.test.js` › T27 (fake): lease expires mid-command -> second protected action blocked; stale token fenced despite a lying clock
- `test/v2-lease-authority.test.js` › T27: expired holder is fenced (not merely stale) when a new owner takes over without release

### T28 — PASS

3 test(s) passed.

- `test/v2-acceptance-gl14.test.js` › GL12/T28: integration branch with new upstream commits: the approved SHA goes stale, gates and CI rerun on the rebuilt SHA, a fresh approval is required
- `test/v2-integration.test.js` › T28 target updated after tests: previous gate invalidated, rebuilt on the new target, all gates rerun
- `test/v2-integration.test.js` › T28 integration tree changed by a gate after tests: evidence invalidated and gates rerun on a clean tree

### T29 — PASS

1 test(s) passed.

- `test/v2-integration.test.js` › T29 remote CI red, missing, pending or unknown: no merge even with local gates green

### T30 — PASS

3 test(s) passed.

- `test/v2-integration.test.js` › T30 push times out after the remote accepted it: remote queried, no double push, marked confirmed
- `test/v2-integration.test.js` › T30 push timed out and the remote did not take it: marked failed, not retried blindly, not success
- `test/v2-integration.test.js` › T30 push outcome unknowable: unknown_external_effect, then reconciled from the remote without pushing again

### T31 — PASS

2 test(s) passed.

- `test/v2-integration.test.js` › T31 unapproved merge is refused and audited; approvals for another sha/action/target or expired do not count
- `test/v2-integration.test.js` › T31 policy-prohibited merge is refused even with an approval

### T32 — PASS

4 test(s) passed.

- `test/v2-acceptance-ops.test.js` › T38/T40/T32: host pressure under a running task -> the loop only requests an operation -> System Ops runs a scoped, reversible cleanup under its lease -> fresh healthy reading -> admission resumes -> the task completes
- `test/v2-system-ops.test.js` › T32: disk pressure -> incident, admission paused, only V2-temp cleanup runs, remaining pressure needs approval
- `test/v2-system-ops.test.js` › T32: deletion outside the V2 temp root, symlink escapes and non-allowlisted actions need approval and never run
- `test/v2-system-ops.test.js` › T32: worktree storage / tmux exhaustion have no allowlisted remediation -> approval_required

### T33 — PASS

3 test(s) passed.

- `test/v2-acceptance-ops.test.js` › T33: CPU pressure during integration -> System Ops throttles under its own host lease and pauses admission; the integration keeps its leases and state and still merges; queued work resumes on a fresh healthy reading
- `test/v2-system-ops.test.js` › T33: CPU pressure during integration -> throttle + admission pause; task state and integration lease untouched
- `test/v2-system-ops.test.js` › T33: throttling does not help -> stays paused and escalates to the owner

### T34 — PASS

2 test(s) passed.

- `test/v2-system-ops.test.js` › T34: recovery while a deployment is active or unknown -> approval_required, no restart/actions, lease released
- `test/v2-system-ops.test.js` › T34: a service restart is only ever requested (approval_required), never executed, even with no deploy

### T35 — PASS

2 test(s) passed.

- `test/v2-system-ops.test.js` › T35: telemetry stale, unreachable, future-dated or non-numeric is unknown, never healthy
- `test/v2-system-ops.test.js` › T35: stale/unreachable health at intake -> incident.unknown + escalated, admission paused, no actions

### T36 — PASS

1 test(s) passed.

- `test/v2-system-ops.test.js` › T36: two developers report the same host issue -> one incident, linked reports, one remediation

### T37 — PASS

3 test(s) passed.

- `test/v2-system-ops.test.js` › T37: action fails mid-execution -> checkpoint, undo, incident stays open (reconciling), lease released, admission paused
- `test/v2-system-ops.test.js` › T37: lease lost between actions -> next action fenced and not executed, no undo under a dead lease, reconciling
- `test/v2-system-ops.test.js` › T37: a reconciling incident needs owner acknowledgement before recheck can resolve it

### T38 — PASS

3 test(s) passed.

- `test/v2-acceptance-ops.test.js` › T38/T40/T32: host pressure under a running task -> the loop only requests an operation -> System Ops runs a scoped, reversible cleanup under its lease -> fresh healthy reading -> admission resumes -> the task completes
- `test/v2-system-ops.test.js` › T38: queued tasks resume only after a FRESH healthy reading and a released maintenance lease
- `test/v2-system-ops.test.js` › T38: one incident cannot resume admission paused for another; lease backend failure never resumes

### T39 — PASS

2 test(s) passed.

- `test/v2-acceptance-gl14.test.js` › GL14/T39: intake -> worktree -> repair loops -> independent verifier -> integration on a disposable remote -> gates -> remote CI -> SHA-bound owner approval -> accepted; machine-readable trace
- `test/v2-integration.test.js` › T39 E2E on a disposable remote: worktree patch -> independent verify -> integration -> gates -> CI -> approved push/merge, exact SHAs in a manifest

### T40 — PASS

4 test(s) passed. Wiring requirement (pinned by a system-ops verify test): callers get `requester`, never the executing controller; `requestOperation` trusts its role string.

- `test/v2-acceptance-ops.test.js` › T38/T40/T32: host pressure under a running task -> the loop only requests an operation -> System Ops runs a scoped, reversible cleanup under its lease -> fresh healthy reading -> admission resumes -> the task completes
- `test/v2-acceptance-ops.test.js` › T40: a developer run that asks for host maintenance gets an owner approval request; nothing reaches a System Ops executor
- `test/v2-system-ops.test.js` › T40: developer/tester/integration requests become mitigation_requested incidents and are never executed
- `test/v2-system-ops.test.js` › T40: the request-only facade never executes, whatever role string it is given

### GL01 — PASS

2 test(s) passed.

- `test/v2-goal-loop.test.js` › GL01 UI, API, schedule and agent tasks get the same goal contract and the same loop
- `test/v2-task-core.test.js` › GL01: tasks from ui, api, schedule and agent get the same contract

### GL02 — PASS

2 test(s) passed.

- `test/v2-goal-loop.test.js` › GL02/T09 failing first run -> structured feedback -> fix -> pass on exact SHA -> independent approve
- `test/v2-goal-loop.test.js` › GL02 no 3-attempt cutoff: three different failures in a row, then success

### GL03 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › GL03 identical failures force evidence-based strategy changes (replan, then a different model), then success

### GL04 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › GL04 unknown check result and missing artifacts never pass; unavailable evaluator -> waiting, never accepted

### GL05 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › GL05 independent reviewer rejects a superficially passing patch; developer repairs; checks rerun

### GL06 — PASS

3 test(s) passed.

- `test/v2-goal-loop.test.js` › T12/GL06 rate limit: backoff (waiting) twice, then a compatible fallback runtime; state preserved
- `test/v2-goal-loop.test.js` › GL06 provider outage -> compatible fallback; context exhaustion -> compacted fresh run
- `test/v2-goal-loop.test.js` › GL06/T18 controller crash mid-run: restart reconciles the unconfirmed run and resumes without duplicates

### GL07 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › GL07 no progress: 3 strategy changes without new passing evidence -> waiting(no_progress), no runaway

### GL08 — PASS

1 test(s) passed.

- `test/v2-goal-loop.test.js` › GL08 every automatic decision is a structured record; routine choices never ask the owner

### GL09 — PASS

4 test(s) passed.

- `test/v2-acceptance-strengthen.test.js` › GL09: credentials need explicit authorization whatever the goal says; an agent asking for a secret is gated, a denial continues without it; silence never authorizes
- `test/v2-acceptance-strengthen.test.js` › GL09: protected push and merge stay unapplied through owner silence; a denial ends the delivery with the remote untouched
- `test/v2-goal-loop.test.js` › GL09 privileged actions need explicit authorization whatever the goal text says; silence is never approval
- `test/v2-system-ops.test.js` › GL09: only the system-operations role executes; its non-allowlisted or destructive ops still need approval

### GL10 — PASS

4 test(s) passed. system-ops.js acquires a single host/service resource; maintenance that also needs the repo lane is modelled with acquireAll on the same authority.

- `test/v2-acceptance-ops.test.js` › GL10: maintenance that needs the repo lane waits for the running integration: canonical-order, all-or-nothing acquisition; nothing half-held; it proceeds once the integration releases
- `test/v2-acceptance-ops.test.js` › GL10: Integration and System Ops race for overlapping resources in opposite orders: never a deadlock, never split holdings, at most one holder per round
- `test/v2-acceptance-ops.test.js` › GL10/T27: stale fencing across roles: the integrator's lease expires mid-gate and System Ops takes the lane; the stale integrator pushes nothing and the task waits
- `test/v2-system-ops.test.js` › GL10: lease unavailable or held by someone else -> no action, escalated, admission stays paused

### GL11 — PASS

1 test(s) passed. No real provider is called here; see the opt-in live smoke below.

- `test/v2-acceptance-cross-provider.test.js` › GL11/T11: real Claude and Codex adapters (stub CLIs), a native-subagent runtime and the ordinary-worker fallback all satisfy the identical acceptance checks

### GL12 — PASS

6 test(s) passed.

- `test/v2-acceptance-gl14.test.js` › GL12/T28: integration branch with new upstream commits: the approved SHA goes stale, gates and CI rerun on the rebuilt SHA, a fresh approval is required
- `test/v2-acceptance-strengthen.test.js` › GL12: reopened after a controller crash, the task revalidates against the current worktree SHA: stale evidence and review never count
- `test/v2-acceptance-strengthen.test.js` › GL12: reopened after an integration merge conflict, the repaired SHA is re-verified and re-integrated; nothing from the conflicting SHA carries over
- `test/v2-goal-loop.test.js` › T10/GL12 source changes after verification: SHA revalidated, checks and review rerun on the new SHA
- `test/v2-integration.test.js` › GL12 reopened after an upstream change: evidence, CI and approval are revalidated against the new SHA
- `test/v2-store.test.js` › GL12: a new head SHA invalidates earlier evidence and verdicts, even when it moves back

### GL13 — PASS

2 test(s) passed.

- `test/v2-goal-loop.test.js` › GL13 usage measured where reported, unknown stays null; exhausted quota throttles without spend
- `test/v2-store.test.js` › T22/GL13: unknown usage stays null, never 0

### GL14 — PASS

1 test(s) passed. The UI half is covered by T20.

- `test/v2-acceptance-gl14.test.js` › GL14/T39: intake -> worktree -> repair loops -> independent verifier -> integration on a disposable remote -> gates -> remote CI -> SHA-bound owner approval -> accepted; machine-readable trace

## Opt-in real-provider smoke (not a matrix row)

`scripts/v2-live-smoke.js` runs one trivial task (write `hello.txt` with a fixed line) through the real goal loop and
a real CLI adapter in a disposable repo under the system temp dir, with the scripted fake reviewer and a
deterministic `node -e` acceptance check. It spends real quota only when `V2_LIVE_SMOKE=claude|codex|minimax` is set
(claude: `claude-haiku-4-5`, `--max-budget-usd 0.10`; codex: CLI default model, low effort; minimax: CLI default
model) and prints one JSON object (runtime, model, tokens, cost — unknown stays `null` — and outcome). No model
output is printed or kept. Results of each run are recorded in `V2_VERIFICATION.md`, not here.

## New evidence added by `v2/11-e2e`

| File | Rows |
|---|---|
| `test/v2-acceptance-gl14.test.js` | GL14/T39 full path with machine-readable trace; GL12/T28 upstream commits through the goal loop |
| `test/v2-acceptance-cross-provider.test.js` | GL11/T11 |
| `test/v2-acceptance-ops.test.js` | T33 E2E, T38/T40/T32 host pressure → incident → scoped recovery → resumed task, T40, GL10 (×3), GL10/T27 |
| `test/v2-acceptance-effects.test.js` | T23 (×2), T07/T23, T06 crash E2E |
| `test/v2-acceptance-unavailable.test.js` | T08 (×4) |
| `test/v2-acceptance-state.test.js` | T16 (×2), T19 |
| `test/v2-acceptance-strengthen.test.js` | T09 (bounded fix/review/abort), GL09 ×2 (credentials; push/merge silence and denial), GL12 ×2 (reopen after crash, after merge conflict) |
| `test/v2-delivery.test.js` | `orchestration/delivery.js` unit: handoff facts from the store, idempotent resubmit, single writer, SHA-bound approvals, CI pending → waiting, conflict → repair, unknown → reconcile |
| `test/v2-minimax-node.test.js` | minimax adapter `nodeDir` / `MCODE_NODE_DIR` |
| `test/fixtures/v2-world.js` | shared disposable worlds; `makeDelivery` wires `orchestration/delivery.js` over a real controller |

## T16 disclosure: pre-V2 tests changed on `v2/integration`

T16 runs every pre-V2 test file, but seven of them differ from `origin/main`
(`git diff origin/main...v2/integration -- test/`, files that exist on main):

| File | Change | Expectation changed? |
|---|---|---|
| `test/router.test.js` | wake floor: a forbidden topic now also removes `ignore`; `p0_blocked` and a failed deploy default to `wake_opus` (fd3e4d6, c93d5a7) | **yes**: deliberate behaviour change (router dry-run defect fix, OWNER_DECISIONS §8) |
| `test/usage.test.js` | added: a PLACEHOLDER zero price row is unknown, not $0 (13d161d) | new assertion; existing ones unchanged |
| `test/parking.test.js` | added: resume validates a saved record before tmux or exec (f3d4ae6, Phase 1 security) | new assertion; existing ones unchanged |
| `test/manager.test.js` | waits for the asynchronous owner push and filters to its own session (6a1fcf3) | no: load-flake fix; same expected push |
| `test/reporter-manager.test.js` | counts only its own session's pushes (4be4187) | no: load-flake fix |
| `test/decision-share.test.js` | pins the fixture clock (e54e779) | no: clock pinning; same expected values |
| `test/vpt-locks.test.js` | keeps the event loop alive across the abort-timeout case (4bdaae6) | no: runner-drain fix |

"No regression" therefore holds for every original workflow except the router wake defaults, which changed on purpose
and are covered by `test/router.test.js` and `test/v2-routing-verify.test.js`.

## Known gaps behind PASS rows

- **server.js wiring of delivery**: `orchestration/delivery.js` is the production bridge (ARCHITECTURE "Implementation
  notes (delivery bridge)"), but server.js does not construct an integration controller yet; with `GHOSTY_V2=1` a
  delivery task waits in `integrating` ("no integration hook wired").
- **System Ops role identity**: `requestOperation` trusts its `role` string; the wiring must hand out `requester` only
  (pinned by `test/v2-system-ops-verify.test.js`).
- **T04 Origin check** is asserted on the source of server.js; the T20 browser check exercises it once (cross-origin
  POST refused) but only when PLAYWRIGHT_CORE is available.
- **Dashboard approvals write directly**: `orchestration/http.js` appends `approval.granted/denied` with
  `store.append`, not through the goal loop's controller lease (D-016/D-018 route owner actions through the loop).
  The record is idempotent by event id and carries the request's keys, so it is safe as data, but it is a second
  writer of the task log.
