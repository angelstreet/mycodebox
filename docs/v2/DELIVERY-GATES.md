# V2 delivery gates on 343063f2f7e8 (merge of v2/test-tmp-cleanup, lane request int-mvgge2xpf2f6a5)

Gate checkout: detached `343063f2f7e8`, Node 24.21.0, high box load (12-19). Single test files only, run serially, each once, fresh temp `GHOSTY_STATE_DIR`, spec reporter. The matrix runner `scripts/v2-acceptance.js` was NOT used (it runs the whole suite, which the locked full run owns); rows were mapped by the same rule it uses (test name starts with the matrix id).

## Summary

| Disposition | Rows |
|---|---|
| PASS | 53 (T16 PASS on its mapped tests; its pre-V2-files half rides on the full suite) |
| BLOCKED / MANUAL | 0 |
| Not applicable | 0 |
| FAIL | 0 (T20 failed 65/67 at 343063f on a stale cache-name literal in the check script; fixed in v2/final-report, 67/67) |

Files run (22, all exit 0, 0 fail / 0 skipped / 0 todo): safe-restart 52, v2-acceptance-cross-provider 1, -gl14 2, -effects 4, -strengthen 5, -state 3, -unavailable 4, -ops 6, v2-integration 23, v2-lease-authority 35, v2-adapters 32, v2-budget 14, v2-goal-loop 34, v2-task-core 13, v2-policy-classes 2, v2-policy 8, v2-worktrees 11, v2-routing 31, v2-store 25, v2-security-review 17, v2-system-ops 23, v2-acceptance-matrix 4. Total 372 tests, 372 pass.

## Per-gate table

| ID | What | Run (test files, once each) | Result | Evidence |
|---|---|---|---|---|
| T01 | Project policy absent or invalid | test/v2-goal-loop.test.js, test/v2-policy.test.js | **PASS** | 2/2 tests whose name carries T01 pass |
| T02 | Restricted action disguised in task text | test/v2-policy-classes.test.js, test/v2-policy.test.js | **PASS** | 3/3 tests whose name carries T02 pass |
| T03 | CLI startup, resume, park | test/v2-adapters.test.js, test/v2-security-review.test.js | **PASS** | 13/13 tests whose name carries T03 pass |
| T04 | Network listener, origin and reporter endpoint | test/v2-security-review.test.js | **PASS** | 5/5 tests whose name carries T04 pass |
| T05 | Parallel worktrees | test/v2-worktrees.test.js | **PASS** | 3/3 tests whose name carries T05 pass |
| T06 | Duplicate event/outcome | test/v2-acceptance-effects.test.js, test/v2-store.test.js | **PASS** | 3/3 tests whose name carries T06 pass |
| T07 | Restart between attempted and confirmed side effect | test/v2-acceptance-effects.test.js, test/v2-store.test.js | **PASS** | 2/2 tests whose name carries T07 pass |
| T08 | Source MCP or provider unavailable | test/v2-acceptance-unavailable.test.js | **PASS** | 4/4 tests whose name carries T08 pass |
| T09 | Unit test fails | test/v2-acceptance-strengthen.test.js, test/v2-goal-loop.test.js | **PASS** | 2/2 tests whose name carries T09 pass |
| T10 | Failed verification after source change | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries T10 pass |
| T11 | Adapter capability absent | test/v2-acceptance-cross-provider.test.js, test/v2-adapters.test.js, test/v2-routing.test.js | **PASS** | 7/7 tests whose name carries T11 pass |
| T12 | Rate limit / timeout / quota exhausted | test/v2-adapters.test.js, test/v2-goal-loop.test.js, test/v2-routing.test.js | **PASS** | 4/4 tests whose name carries T12 pass |
| T13 | Budget/time/turn cap | test/v2-budget.test.js, test/v2-goal-loop.test.js | **PASS** | 3/3 tests whose name carries T13 pass |
| T14 | Cancellation during spawn/check | test/v2-adapters.test.js, test/v2-goal-loop.test.js, test/v2-store.test.js | **PASS** | 5/5 tests whose name carries T14 pass |
| T15 | Reviewer disagrees with maker | test/v2-goal-loop.test.js | **PASS** | 2/2 tests whose name carries T15 pass |
| T16 | Existing dashboard/send/reply/status and push | mapped tests in v2-acceptance-state; pre-V2 files = the locked full suite | **PASS (mapped) + covered by full suite** | 2/2 mapped tests pass. The "every pre-V2 test file passes" half is the coordinator's Node 24.21 full suite (not rerun here) and the lane's 2646/2646 on Node 23.6 |
| T17 | Forbidden topic in manager auto-send | test/v2-security-review.test.js | **PASS** | 3/3 tests whose name carries T17 pass |
| T18 | Reboot/state recovery | test/v2-goal-loop.test.js, test/v2-store.test.js | **PASS** | 5/5 tests whose name carries T18 pass |
| T19 | Existing state migration | test/v2-acceptance-state.test.js | **PASS** | 1/1 tests whose name carries T19 pass |
| T20 | Mobile/desktop app/PWA | `PLAYWRIGHT_CORE=<dir> node scripts/v2-ui-check.js <tmpdir>` (run twice, same result) | **PASS after check-script fix** (65/67 at 343063f: stale `ghosty-shell-v149` literal; v2/final-report reads the cache name from `public/sw.js`: 67/67) | 65/67 checks. Only the 2 checks "tasks-view.js is precached under the new cache name" fail: the script hardcodes `ghosty-shell-v149` (scripts/v2-ui-check.js:217) while public/sw.js is `ghosty-shell-v150`. All other checks pass: SW registers, no page errors, no overflow, cross-origin POST refused (403). Not release-critical; fix = derive the name from sw.js or bump the literal |
| T21 | Safe restart with unreachable API | test/safe-restart.test.js | **PASS** | 5/5 tests whose name carries T21 pass |
| T22 | Usage unknown / stale pricing | test/v2-budget.test.js, test/v2-routing.test.js, test/v2-store.test.js | **PASS** | 4/4 tests whose name carries T22 pass |
| T23 | External write confirmation | test/v2-acceptance-effects.test.js | **PASS** | 3/3 tests whose name carries T23 pass |
| T24 | Multi-agent branch integration | test/v2-integration.test.js | **PASS** | 3/3 tests whose name carries T24 pass |
| T25 | Two Integration Agents race for the same branch | test/v2-integration.test.js, test/v2-lease-authority.test.js | **PASS** | 4/4 tests whose name carries T25 pass |
| T26 | Lease backend unavailable or stale | test/v2-integration.test.js, test/v2-lease-authority.test.js | **PASS** | 12/12 tests whose name carries T26 pass |
| T27 | Lease expires mid-command | test/v2-acceptance-ops.test.js, test/v2-integration.test.js, test/v2-lease-authority.test.js | **PASS** | 5/5 tests whose name carries T27 pass |
| T28 | Integration branch updated after tests | test/v2-acceptance-gl14.test.js, test/v2-integration.test.js | **PASS** | 3/3 tests whose name carries T28 pass |
| T29 | Remote CI red, missing, or pending | test/v2-integration.test.js | **PASS** | 1/1 tests whose name carries T29 pass |
| T30 | Push times out after remote accepted it | test/v2-integration.test.js | **PASS** | 3/3 tests whose name carries T30 pass |
| T31 | Unapproved merge/deploy request | test/v2-integration.test.js | **PASS** | 2/2 tests whose name carries T31 pass |
| T32 | Disk reaches configured pressure threshold | test/v2-acceptance-ops.test.js, test/v2-system-ops.test.js | **PASS** | 4/4 tests whose name carries T32 pass |
| T33 | CPU pressure during integration/E2E | test/v2-acceptance-ops.test.js, test/v2-system-ops.test.js | **PASS** | 3/3 tests whose name carries T33 pass |
| T34 | Host recovery while deployment active | test/v2-system-ops.test.js | **PASS** | 2/2 tests whose name carries T34 pass |
| T35 | Service health metric stale/unreachable | test/v2-system-ops.test.js | **PASS** | 2/2 tests whose name carries T35 pass |
| T36 | Two developers report same host issue | test/v2-system-ops.test.js | **PASS** | 1/1 tests whose name carries T36 pass |
| T37 | Maintenance action fails mid-execution | test/v2-system-ops.test.js | **PASS** | 3/3 tests whose name carries T37 pass |
| T38 | Service recovers, queued tasks resume | test/v2-acceptance-ops.test.js, test/v2-system-ops.test.js | **PASS** | 3/3 tests whose name carries T38 pass |
| T39 | Integration E2E on disposable Git remote | test/v2-acceptance-gl14.test.js, test/v2-integration.test.js | **PASS** | 2/2 tests whose name carries T39 pass |
| T40 | Developer requests system command | test/v2-acceptance-ops.test.js, test/v2-system-ops.test.js | **PASS** | 4/4 tests whose name carries T40 pass |
| GL01 | Task from UI/API/schedule/agent | test/v2-goal-loop.test.js, test/v2-task-core.test.js | **PASS** | 2/2 tests whose name carries GL01 pass |
| GL02 | First implementation fails a deterministic test | test/v2-goal-loop.test.js | **PASS** | 2/2 tests whose name carries GL02 pass |
| GL03 | Repeated identical failure | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries GL03 pass |
| GL04 | Missing artifacts / unavailable evaluator | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries GL04 pass |
| GL05 | Reviewer rejects a superficially passing patch | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries GL05 pass |
| GL06 | Provider outage, rate limit, context exhaustion, crash | test/v2-goal-loop.test.js | **PASS** | 3/3 tests whose name carries GL06 pass |
| GL07 | No-progress loop | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries GL07 pass |
| GL08 | Automatic decisions | test/v2-goal-loop.test.js | **PASS** | 1/1 tests whose name carries GL08 pass |
| GL09 | Credentials, merge/push, deploy, destructive repair | test/v2-acceptance-strengthen.test.js, test/v2-goal-loop.test.js, test/v2-policy-classes.test.js, test/v2-system-ops.test.js | **PASS** | 5/5 tests whose name carries GL09 pass |
| GL10 | Lease race / stale fencing; Integration vs System Ops | test/v2-acceptance-ops.test.js, test/v2-system-ops.test.js | **PASS** | 4/4 tests whose name carries GL10 pass |
| GL11 | Cross-provider, native delegation, worker fallback | test/v2-acceptance-cross-provider.test.js | **PASS** | 1/1 tests whose name carries GL11 pass |
| GL12 | Reopened after crash/conflict/upstream change | test/v2-acceptance-gl14.test.js, test/v2-acceptance-strengthen.test.js, test/v2-goal-loop.test.js, test/v2-integration.test.js, test/v2-store.test.js | **PASS** | 6/6 tests whose name carries GL12 pass |
| GL13 | Costs and tokens | test/v2-goal-loop.test.js, test/v2-store.test.js | **PASS** | 2/2 tests whose name carries GL13 pass |
| GL14 | Full disposable repo | test/v2-acceptance-gl14.test.js | **PASS** | 1/1 tests whose name carries GL14 pass |

Scope caveats carried from docs/v2/ACCEPTANCE.md: synthetic data, fake runtimes, stub CLIs, disposable bare remotes; OpenCode is only contract-tested against a stub (T11); T04 Origin check is asserted from server.js source.

## Leak scan

`node scripts/leak-scan.js d93bb37^...343063f2f7e8` -> `leak-scan: clean`, exit 0 (review finding 19 fixed by v2/fix-leak-fixtures).

## Reporter suite

Separate from `npm test` (the plugin tests): `env -i PATH HOME LANG=C GHOSTY_STATE_DIR=<tmp> claude plugin test claude-plugin/ghosty-reporter` (Claude Code 2.1.304, mock tests) -> **25 pass, 0 fail**, exit 0. The server-side reporter tests (`test/reporter.test.js`, `test/reporter-manager.test.js`) are part of the full suite.

## Node 23.6 evidence

Integration lane request int-mvgge2xpf2f6a5: merged v2/test-tmp-cleanup into main at 343063f2f7e8; steps fetch, resolve, evaluate, worktree, merge (no conflicts), install, **test**, precheck, push, deploy-check/pull/syntax all ok. Test step (`npm test` = `scripts/test-run.js`, exit 0): **tests 2646, pass 2646, fail 0, cancelled 0, skipped 0, todo 0**, duration 318 s. Node: the lane uses `/usr/local/bin/node`, which reports v23.6.0 (the interpreter of the service process itself was not inspected; the shell default node is 24.21.0).

Node 24.21 full suite: 2646/2646 pass, 0 fail, 0 cancelled/skipped, 211/211 test files, 447 s (locked run, TEST_SCOPE=full, Node v24.21.0, at 343063f2f7e8)

## Not covered here

Pre-V2 test files for T16 individually, live provider smoke, Mac and device-host paths (see owner actions in final-report.md).
