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
