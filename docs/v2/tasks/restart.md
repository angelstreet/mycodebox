# Fail-closed restart guard

- Base: `b9a83e1`, plus own deterministic test-clock repair `e9fbf2b`; isolated branch `v2/01-restart`.
- Scope: `scripts/safe-restart.sh`, fake-command unit tests, this record. No live command execution.
- Contract: only successful HTTP responses containing a valid, successful, fresh deploy snapshot permit restart. Unknown states and malformed records fail closed. Running work always blocks; enabled queued or awaiting-approval work blocks because the runner can start it automatically.
- Plan: tests first with disposable fake curl/sudo/systemctl/date/sleep; then implement strict argument parsing, snapshot validation, bounded explicit waiting, and a final status recheck. Remove PID-kill fallback.
- Freshness: snapshot `at` is epoch milliseconds; normal runner polling is every 30 seconds. Accept at most 60 seconds old and never future-dated snapshots.
- Limitation: polling and rechecking cannot provide an atomic deployment lease. A deploy could start after the last check. Do not describe this guard as fencing.
- Acceptance: focused and complete suites pass in a sanitized environment with disposable state; independent review required. Rollback: revert scoped commit.

## Developer evidence

- Implementation base after cherry-picking the own test-clock repair: `4426be8`.
- Inspected `deploy-runner.js`: `poll()` sets `ok`, `error`, `at`; `snapshot()` adds `enabled`, `running`, `envs`. `tick()` can auto-approve awaiting work and start queued work. Existing UI recognizes `cancelled` as terminal.
- `--wait` alone retains its ten-minute default; explicit minutes accept decimal integers 0–1440 to keep arithmetic bounded. Unknown status fails immediately even while waiting.
- `bash -n scripts/safe-restart.sh`: exit 0.
- Initial focused harness: 41/41 passed (8.9 s); expanded malformed-data and freshness boundary coverage included in full run.
- `env -i PATH="$PATH" LANG=C.UTF-8 GHOSTY_STATE_DIR="$(mktemp -d)" npm test`: exit 0, 905/905 passed, 18.8 s, no skips. Includes 46 restart tests using only fake service/network commands.
- No live restart, provider, or production-state access. Independent verification pending.
- Root coordinator notified of installation/migration documentation changes; those documents are outside this worker scope.
