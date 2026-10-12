# V2 verification

**Status: round 2 delivered on `v2/integration`, draft PR #1. All local gates pass on the gated SHA. The V2 engine is not
wired into `server.js` (by owner decision for this round); nothing here was deployed.**

Gated SHA: `ae9efa0` (`ae9efa0399c84c15e7be7dbc1db8e4372644aed6`), the last code change on the branch. The commits after it
change documentation only (this file, `V2_PROGRESS.md`, `docs/v2/SCORING.md`, `docs/v2/ACCEPTANCE.md` and the generated
`docs/v2/acceptance-results.json`); `git diff --stat ae9efa0..origin/v2/integration` lists them.

## Gates on `ae9efa0`

| Gate | Command | Result |
|---|---|---|
| Unit and integration suite, Node 23.6.0 | `node --test --test-concurrency=4 test/*.test.js` in a clean detached worktree | **PASS** 1684/1684, exit 0 |
| Same, Node 24.21.0 | same | **PASS** 1684/1684, exit 0 |
| Reporter plugin suite | `env -i PATH=… HOME LANG GHOSTY_STATE_DIR=$(mktemp -d) claude plugin test claude-plugin/ghosty-reporter` (Claude Code 2.1.296, mock tests) | **PASS** 25/25, exit 0 |
| Acceptance matrix | `PLAYWRIGHT_CORE=<dir> node scripts/v2-acceptance.js` | **PASS** 54/54 rows (T01–T40, GL01–GL14), 1685/1685 tests, 134/134 test files; see [ACCEPTANCE.md](docs/v2/ACCEPTANCE.md) and [acceptance-results.json](docs/v2/acceptance-results.json) |
| T20 browser check | `PLAYWRIGHT_CORE=<dir> node scripts/v2-ui-check.js` | **PASS** 39/39 (details below) |
| Leak scan | `LEAK_SCAN_EXTRA=<private denylist> node scripts/leak-scan.js origin/main..HEAD`, plus a check that no commit tracks `node_modules` | **PASS**, clean on every commit pushed |

Every suite ran with an environment limited to PATH, HOME and LANG and a fresh temporary `GHOSTY_STATE_DIR`; no test
calls a real provider, a real remote, systemd or the live state directory.

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

## Bench dry run (real providers, USD 20 owner-authorized)

Suite `mycodebox-v2-bench@1`: 10 tasks across five developers (claude haiku, claude sonnet, codex, minimax, opencode).
Each developer is reviewed by a different model. Full run: 50 runs, 45 ended as expected, 4 not started on budget.
Every settled model was 100% verified. Tool score: partial 78.1 (cost and latency unknown). Defects found by the run were fixed, reviewed
and confirmed by re-runs. One finding stays open: MiniMax does not report no progress on the impossible task within
the time cap. It is stopped safely (waiting or cancelled, never accepted). Spend: USD 5.15 measured plus 13.50 estimated, of the USD 20
authorized. Results, defects and the spend ledger: [SCORING.md, Dry run](docs/v2/SCORING.md#dry-run-round-2-2026-10-12).

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

- The V2 engine is not wired into `server.js`. Until it is, dashboard approve, deny and cancel answer 503 `E_NO_CONTROLLER`
  (D-020), and proposal tasks cannot be approved from the dashboard.
- No deployment, service restart, migration of the live state, or production health check. No remote CI.
- No real phone; T20 is headless Chromium at phone and desktop sizes.
- Cost is unknown for codex, minimax and opencode (no USD from the CLIs) and for models with `PLACEHOLDER` prices, so
  the tool score's cost component is unknown.
- The dry run is small (7 or 8 runs per model): its per-model differences are anecdotal. The bench's test cases are
  visible to the developer; the reviewer, not the harness, guards against hard-coded answers.
- MiniMax on an unsolvable task runs to the time cap instead of reporting no progress (safe stop, open finding).
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
