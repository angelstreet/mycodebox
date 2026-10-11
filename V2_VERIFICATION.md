# V2 verification

Baseline SHA: `b9a83e14b7167a2efb35fa6c4367a692fadb94d1`.
Machine-readable results: [baseline evidence](docs/v2/baseline-evidence.json).

| Check | Result | Evidence / limits |
|---|---|---|
| Main `npm test`, sanitized environment and temporary state | FAIL | 858 tests, 839 pass, 19 stale-date failures in decision-share; 22.36 s. |
| `claude plugin test claude-plugin/ghosty-reporter`, sanitized environment | PASS | 25 mock tests; 4.84 s; no real provider smoke. |
| `node scripts/router-dryrun.js --dry`, sanitized environment | COMPLETED WITH DISCREPANCY | Exit 0; wake 6/10; builder/reviewer/retry/stop/model decisions 10/10 each. Rule-only builder 8/10 and stop 9/10. |
| Source inventory | REVIEWED | File/line evidence in `docs/v2/CURRENT_STATE.md`. |
| Synthetic lifecycle | PROPOSED FIXTURE | `executed:false`; not an E2E result. |
| Browser phone/desktop | NOT RUN | No UI changes or live dashboard launch. |
| Remote CI, provider smoke, production health, migration | NOT RUN | Not established by local results. |

## V2 acceptance matrix

T01–T40: NOT RUN as V2 acceptance scenarios.
GL01–GL14: NOT RUN. Existing regression tests do not establish V2 completion.

## Verification procedure

Use a clean task worktree, environment limited to PATH/LANG and fresh GHOSTY_STATE_DIR, and module/fake-adapter tests. Do not import server.js. Record SHA, command, exit, duration, synthetic artifacts and independent reviewer. Missing or failing evidence blocks PASS.

## Independent clock repair verification

`e9fbf2b78fb5934f1c2d7559096a1d496b6028e6`: independent reviewer repeated `npm test` in a clean worktree, fresh temporary state and scrubbed provider environment. Exit 0; 859 passed, 0 failed, 0 skipped; 17,001.695 ms. Production filtering unchanged. The new cutoff test and expired CLI fixture preserve date-window coverage. This is regression evidence, not V2 acceptance.

## Local baseline integration

Exact repaired SHA `1bc82f962f82966488a83bc71d5c1eab23faa48a`: `env -i PATH="$PATH" LANG=C.UTF-8 GHOSTY_STATE_DIR="$(mktemp -d)" npm test` exited 0; 859 passed, zero failed/skipped; test duration 19,219.862 ms (wall 19,511.664 ms). Documentation-only checkpoint follows this tested SHA. Phase 0 completion covers inventory, fixtures and recorded baseline outcomes; router discrepancies and all V2 acceptance gates remain open.

## Integration checkpoint c366307 (Phase 1 integrated on origin/main dccab06)

| Check | Result | Evidence |
|---|---|---|
| `env -i PATH=/usr/local/bin:… LANG=C.UTF-8 NODE_BIN=/usr/local/bin GHOSTY_STATE_DIR=$(mktemp -d) npm test` (Node 23.6.0) | PASS | 913/913, exit 0. Before 4bdaae6: 5 failures (unref'd abort timer in vpt-locks test) + 1 (placeholder price). |
| Same with Node 24.21.0 | PASS | 913/913, exit 0. Before 13d161d: 1 failure (main dccab06 made unknown MiniMax-M3 cost read $0). |
| `claude plugin test claude-plugin/ghosty-reporter` (Claude Code 2.1.296, mock tests) | PASS | 25/25, exit 0, 2.1 s. No real provider call. |
| Leak scan `scripts/leak-scan.js` + private denylist, per commit `origin/main..c366307` | PASS | clean on every commit. |

## Live runtime format capture (opt-in real provider calls)

| Runtime | Model | Prompt | Result | Cost |
|---|---|---|---|---|
| Claude Code 2.1.296 | claude-haiku-4-5, plan mode, `--max-budget-usd 0.05` | trivial "OK" | exit 0, stream shapes recorded in docs/v2/RUNTIME_FORMATS.md | $0.0265 (reported `total_cost_usd`) |
| Codex CLI 0.162.1 | account default, effort low, read-only sandbox | trivial "OK" | exit 1: account usage limit (structured stdout error event) | $0 billed (rejected before inference) |
| MiniMax Code 0.6.3 | account default, permission smart | trivial "OK" | exit 0, shapes recorded | unknown (no USD reported; 12,067 tokens) |

## Package gates

| Package | Author | Verifier | Verdict | Integrated SHA | Full suite on integrated SHA |
|---|---|---|---|---|---|
| routing/registry/budget (Phase 4) | Sonnet | Opus (independent context), 3 rounds | APPROVE (F1–F14, R1–R5 fixed; 0 open) | 71d9b39 | Node 23.6 991/991 exit 0; Node 24.21 991/991 exit 0; dry-run wake 10/10 |
| Phase 1 security floors (restart guard, launch defaults, review fixes F1–F8, R1–R5, manager-wakes race) | prior run + Sonnet + coordinator | Fable, 3 rounds | APPROVE | 8567083 | Node 23.6 1042/1042 exit 0; Node 24.21 1042/1042 exit 0 |
| task contract/store/events/policy (Phase 2) | Opus + coordinator | Fable, 4 rounds | APPROVE (0 open) | e2bf65f | Node 23.6 1125/1125 exit 0; Node 24.21 1125/1125 exit 0 |
| lease authority (§12.2) | Opus + coordinator | Fable, 4 rounds | APPROVE (0 open) | dc04001 | 1195/1195 both runtimes |
| adapters + worktrees (Phase 3) | Sonnet + coordinator | Opus, 3 rounds | APPROVE | merge before 85cd076 | 1342/1342 both runtimes after D-011 seam fix |
| incidents/telemetry/system-ops (§12.4) | Sonnet + coordinator | Fable, 3 rounds | APPROVE | merged with adapters | 1342/1342 both runtimes |
| integration queue/CI gates/controller (§12.3) | Opus + coordinator | Fable, 3 rounds | APPROVE | 063380e | 1383/1383 both runtimes |
| goal loop/verifier/roles/intake (Phase 5, §13) incl. D-015..D-018 | Opus | Fable, 6 rounds (+ lease and store re-reviews) | APPROVE | merge before b114077 | 1508/1508 both runtimes on the package branch |
| V2 API, Tasks view, docs, scoring (Phase 6) | Sonnet + coordinator | Opus, 2 rounds | APPROVE; T20 37/37 | b114077 | see the integration gate below |

## T20 browser check (Phase 6, V2 Tasks view)

Command: `PLAYWRIGHT_CORE=<playwright-core dir> node scripts/v2-ui-check.js` (dev-only; playwright-core is not a dependency; prints SKIPPED and exits 0 when unset). Node v23.6.0, playwright-core 1.58.2 with its matching headless Chromium shell. Result: **PASS, 37 of 37 checks, 0 failed**, run on synthetic data only (7 seeded tasks, private `tmux -L` server, temp HOME and state, loopback port).

Covered at phone (390x844) and desktop (1440x900): service worker registers and precaches the new module under `ghosty-shell-v142`; exactly one done badge and it is the accepted task; waiting, needs-owner and unknown badges are distinct; Tab order and visible focus ring; text contrast at least 4.5:1 on sampled elements; keyboard-opened detail with approve/deny only for the pending request; Escape closes; no horizontal overflow or page errors. Also: the Needs owner approval queue sits above the task rows and lists exactly the pending request; Tab is trapped in the sheet; an accepted task shows "verified in worktree, not integrated"; cross-origin POST refused (403); with V2 off (default) the routes answer 404 and no `v2` directory is created. Screenshots are local-only and not committed. Not covered: a real phone, a live deployment, real provider tasks.

## Live goal-loop smoke (opt-in real provider calls, `scripts/v2-live-smoke.js`, disposable temp repo, scripted fake reviewer)

| Runtime | CLI | Model | Effort | Outcome | Input tokens | Output tokens | Cost |
|---|---|---|---|---|---|---|---|
| claude | 2.1.296 | claude-haiku-4-5 (`--max-budget-usd 0.10`) | default | accepted, 1 developer run, check exit 0, ~19 s | 111,713 | 1,093 | $0.0467667 |
| minimax | 0.6.3 | CLI default | default | accepted, 1 run, ~16 s | 41,059 | 421 | unknown (no USD reported) |
| codex | 0.162.1 | CLI default | low | accepted, 1 run, ~21 s | 76,913 | 353 | unknown (no USD reported) |

A first MiniMax attempt failed (`crash`): `mcode` 0.6.3 refuses Node 23.6 and needs Node 24 first on PATH.
These runs prove the adapters drive real CLIs end to end on a trivial task; they are not a quality benchmark.
