# V2 verification

**Status: round 3 delivered on `v2/integration`, draft PR #1. The V2 engine is wired into `server.js` behind
`GHOSTY_V2=1` (off by default). All local gates pass on the gated SHA. Nothing was deployed and V2 is not enabled on
the live install.**

Gated SHA: `37004b9` (`37004b9f2e393011567348422a9dba7f6fa8c32d`), the last code change on the branch. The commits after it change documentation only
(`git diff --stat 37004b9..origin/v2/integration -- ':!*.md' ':!docs/'` is empty).

## Gates on `37004b9`

| Gate | Command | Result |
|---|---|---|
| Unit and integration suite, Node 23.6.0 | `npm test` with a temporary `GHOSTY_STATE_DIR` | **PASS** 1716/1716, exit 0 |
| Same, Node 24.21.0 | same | **PASS** 1716/1716, exit 0 |
| Reporter plugin suite | `env -i PATH=… HOME LANG GHOSTY_STATE_DIR=$(mktemp -d) claude plugin test claude-plugin/ghosty-reporter` (Claude Code 2.1.296, mock tests) | **PASS** 25/25, exit 0 |
| Acceptance matrix | `PLAYWRIGHT_CORE=<dir> node scripts/v2-acceptance.js` | **PASS** 54/54 rows (T01–T40, GL01–GL14), 1717/1717 tests, 138/138 test files (`dirty: true` in the results: only uncommitted documentation edits, this file, were in the tree); see [ACCEPTANCE.md](docs/v2/ACCEPTANCE.md) and [acceptance-results.json](docs/v2/acceptance-results.json) |
| T20 browser check | `PLAYWRIGHT_CORE=<dir> node scripts/v2-ui-check.js` | **PASS** 39/39 (details below) |
| Leak scan | `LEAK_SCAN_EXTRA=<private denylist> node scripts/leak-scan.js origin/v2/integration..HEAD`, plus a whole-tree tailnet scan | **PASS**, clean on every commit pushed |

Every suite ran with an environment limited to PATH, HOME and LANG and a fresh temporary `GHOSTY_STATE_DIR`; no test
calls a real provider, a real remote, systemd or the live state directory. The wiring tests boot `server.js` in a
child process on a disposable loopback port with temporary state and a private `tmux -L` socket
(`test/v2-server-wiring.test.js`, `test/v2-r3-wire-verify.test.js`, `test/v2-bench-http.test.js`).

### T20 browser check

Headless Chromium through `playwright-core` 1.58.2 (a dev-only tool, not a dependency; without `PLAYWRIGHT_CORE` the check
prints SKIPPED and the matrix marks T20 MANUAL). It runs on synthetic data only: 7 seeded tasks, a private `tmux -L` server, a temporary HOME
and state directory, and a loopback port. Covered at phone (390x844) and desktop (1440x900):

- the service worker registers and precaches the module;
- exactly one done badge, on the accepted task; waiting, needs-owner and unknown badges are visually distinct;
- Tab order New, Refresh, Scorecard, the approval queue, the rows, then close; Tab is trapped in the sheet; the focus ring is visible;
- text contrast at least 4.5:1 on sampled elements;
- a keyboard-opened detail view shows approve and deny only for the pending request; Escape closes it;
- no horizontal overflow and no page errors;
- a cross-origin POST is refused (403) and a same-origin control succeeds;
- with V2 off (the default) the routes answer 404 and no `v2` directory is created.

Screenshots stay local.

## Wiring (round 3)

`GHOSTY_V2=1` starts one runtime in the server process (`orchestration/v2-runtime.js`): one store handle shared by the
routes and the goal loop; controller lease, then `recover()` under it, then the scheduler; lease released on a clean
shutdown. Execution: route, adapter, worktree under `GHOSTY_V2_WORK_ROOT`, checks, independent reviewer, then
`accepted`, `waiting` or `awaiting_approval`. Repos limited to `GHOSTY_V2_REPOS` with their `.ai/project.json` (D-021).
Approve, deny and cancel (and proposal approvals) go through the live controller. Integration pushes only
`v2/task/<id>` (CAS, hooks off); merges and deploys stay SHA-bound approvals and are never executed by the server. System
ops: read-only status, telemetry and incidents, plus request-only actions. With the flag unset nothing V2 loads and
`/api/v2/*` answers 404. Claude runs are estimated at their `--max-budget-usd` bound (D-022). Enable and roll back:
[INSTALL.md](docs/INSTALL.md#optional-v2-task-engine-opt-in-off-by-default).

## Live provider smoke (opt-in real calls)

`scripts/v2-live-smoke.js`: disposable temporary repository, one trivial task, scripted fake reviewer. It proves each
adapter drives the real CLI end to end; it is not a quality benchmark.

| Runtime | CLI | Model | Outcome | Input tokens | Output tokens | Cost |
|---|---|---|---|---|---|---|
| claude | 2.1.296 | claude-haiku-4-5 (`--max-budget-usd 0.10`) | accepted, 1 run, ~19 s | 111,713 | 1,093 | $0.0467667 (reported) |
| codex | 0.162.1 | CLI default, effort low | accepted, 1 run, ~21 s | 76,913 | 353 | unknown (no USD reported) |
| minimax (`mcode`) | 0.6.3 | CLI default | accepted, 1 run, ~16 s | 41,059 | 421 | unknown (no USD reported) |
| opencode | 1.18.32 | `opencode/big-pickle` (free) | accepted, 1 run; resume via `--session` verified | ~52,000 | — | unknown (the CLI reports 0, recorded as unknown) |

`mcode` 0.6.3 needs Node 24 first on PATH (`MCODE_NODE_DIR`); with Node 23.6 it crashes at start.

## Benchmarks (real providers, USD 20 owner-authorized per round)

Suite `mycodebox-v2-bench@1`: 10 tasks, five developers (claude haiku, claude sonnet, codex, minimax, opencode), each
reviewed by a different model. Details, defects and spend ledgers: [SCORING.md](docs/v2/SCORING.md).

| | Round 2, in-process dry run | Round 3, over the HTTP API of a wired server |
|---|---|---|
| Runs started / ended as expected | 46 / 45 (4 skipped on budget) | 50 / 49 |
| Outcomes | 36 done, 6 awaiting_approval, 4 waiting_no_progress | 39 done, 6 awaiting_approval, 5 waiting_no_progress |
| Verified, every model | 100% | 100% |
| Tool score | partial 78.1 | partial 77.0 |
| MiniMax, impossible task | no `waiting_no_progress` (backoff / cancel at cap) | `waiting_no_progress`, 728 s |
| Spend, measured + estimated | 5.15 + 13.50 = 18.65 | 4.14 + 12.08 = 16.22 |

Round 3's one unexpected run is claude haiku leaving a scratch file outside input-validation's path allowlist: the
path gate held it at `awaiting_approval` (checks green). That is the intended policy stop, not an engine defect. The
round-3 run used the driver at `217177c`, before its review fixes. It was rescored with the fixed scorer, which
covers F1. F2, the server's Claude estimate, was not active in the run; a coordinator guard script held the
round total under the cap.

## Independent review of round 3

| Item | Author | Reviewer | Verdict |
|---|---|---|---|
| Wiring: runtime, scheduler, lease and recover, integration, system ops, routes (merge `64b3f75`) | Opus | Fable, 2 rounds | APPROVE |
| No progress on run timeouts; bench agent timeout (merge `0b56d12`) | Opus | Opus (separate context), 2 rounds | APPROVE |
| HTTP bench driver, ledger `budget_auto`, server Claude estimate (merge `e0f7dd5`) | Sonnet | Opus, 3 rounds | APPROVE |
| T20 positive control against a configured server (`37004b9`; the wiring made a create need the goal loop) | coordinator | Sonnet | APPROVE |

## Independent review of round 2

| Item | Author | Reviewer | Verdict |
|---|---|---|---|
| Sessions never ask for permission (bypass and folder trust on every launch path) | Sonnet | Opus, 2 rounds | APPROVE |
| Config-driven assetlinks, Langfuse link and https hints (no tailnet identifiers in the repo) | Sonnet | Opus, 2 rounds | APPROVE |
| m1, m2, m4, T15, T20 follow-ups | Sonnet | Opus, 2 rounds | APPROVE |
| m3 (owner answers only through the loop, D-020) and m6 (split and confusable forbidden topics) | Sonnet | Fable, 3 rounds | APPROVE |
| OpenCode adapter on the real format | coordinator and Sonnet | Opus, 2 rounds | APPROVE |
| Scorecard, tool score, proposals | Sonnet | Opus, 3 rounds | APPROVE |
| Bench runner, fixtures and dry-run repairs | Sonnet | Opus, 3 + 4 + 1 rounds | APPROVE |
| T20 tab order with the Scorecard button (`ae9efa0`) | coordinator | Sonnet | APPROVE |

## Not covered

- No deployment, service restart, migration of the live state, or production health check. V2 was not enabled on the
  live install (owner action, INSTALL). No remote CI.
- No real phone; T20 is headless Chromium at phone and desktop sizes.
- Cost is unknown for codex, minimax and opencode (no USD from the CLIs) and for models with `PLACEHOLDER` prices, so
  the tool score's cost component is unknown.
- The benchmarks are small (7 or 8 runs per model): per-model differences are anecdotal. The bench's test cases are
  visible to the developer; the reviewer, not the harness, guards against hard-coded answers.
- The server never merges or deploys; the merge path is covered up to the SHA-bound approval and the wait for `main` to
  contain the SHA, against local bare remotes only.
- Forbidden-topic matching leaves known low-severity gaps: rarer confusables (Armenian, small caps, Lisu), two splits
  in one window in the manager filter (the V2 policy catches it), prefix compounds such as "undeploy". Accepted false positives
  (safe direction) are listed in `V2_PROGRESS.md`.

## Appendix: history

SHAs in this appendix are **pre-rewrite**: GitHub history was rewritten on 2026-10-11 to remove tailnet identifiers, so they
no longer resolve. They are kept as labels only.

- Phase 0 baseline (pre-rewrite `b9a83e1`): main's suite 858 tests, 19 stale-date failures; reporter 25/25; router dry
  run wake 6/10. Clock repair (pre-rewrite `e9fbf2b`, `1bc82f9`): 859/859. Evidence in
  [baseline-evidence.json](docs/v2/baseline-evidence.json).
- Phase 1 checkpoint (pre-rewrite `c366307` on `main` `dccab06`): 913/913 on both runtimes after two fixes: an
  un-unref'd abort timer, and unknown MiniMax-M3 cost that read as $0.
- Live format capture: claude haiku exit 0 ($0.0265); codex exit 1 (account usage limit, rejected before inference);
  minimax exit 0 (cost unknown). Shapes in [RUNTIME_FORMATS.md](docs/v2/RUNTIME_FORMATS.md).
- Round 1 package gates, each with an independent reviewer, full suite on both runtimes at the integrated SHA:
  - routing, registry and budget (Opus): 991;
  - Phase 1 security floors (Fable): 1042;
  - task contract and store (Fable): 1125;
  - lease authority (Fable): 1195;
  - adapters, worktrees, incidents and telemetry (Opus, Fable): 1342;
  - integration queue (Fable): 1383;
  - goal loop (Fable, 6 rounds): 1508;
  - V2 API, Tasks view and docs (Opus): T20 37/37.
- Round 2 gates on current SHAs:
  - `ae6a613`: 1614;
  - `117a976`: 1638;
  - `7db8c4e`: 1651;
  - `508f0a0`: 1652;
  - `dacc48c`: 1674;
  - `2fde21c`: 1684, all tests passing on both runtimes. The acceptance run on `2fde21c` failed T20 only: the new Scorecard button changed the Tab order. That was fixed in `ae9efa0`.
- Round 2 final gate on `ae9efa0`: 1684/1684 on both runtimes, reporter 25/25, acceptance 54/54 (1685 tests), T20 39/39.
- Round 3 gates on current SHAs:
  - `10e96d2`: 1701;
  - after the wiring merge: 1709;
  - `c12a0d7`: 1716, all passing on both runtimes;
  - `e3be1f6`: 1716 on both runtimes, but the acceptance run failed T20 only (its same-origin control met a server without a goal loop), fixed in `37004b9`;
  - the final gate is above.
