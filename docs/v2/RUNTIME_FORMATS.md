# Observed headless output formats (live capture, 2026-10-11)

One trivial prompt ("Reply with the single word OK.") per CLI, in a disposable empty git repo, read-only/plan
permission modes. Only event *shapes* are recorded here; no content was kept. Costs are in `V2_VERIFICATION.md`.

## Claude Code 2.1.296 — `claude -p … --output-format stream-json --verbose --permission-mode plan`

JSONL, one object per line, discriminated by `type` (+ `subtype`):
- `system`/`init`: `session_id, model, permissionMode, cwd, tools[], claude_code_version, …`
- `system`/`commands_changed`, `system`/`thinking_tokens` (`estimated_tokens`, `estimated_tokens_delta`)
- `assistant`: `message{ model, id, content[], stop_reason, usage{…} }`, `session_id`, `parent_tool_use_id`
- `user`: tool results (`message.content[]`), `isSynthetic`
- `rate_limit_event`: `rate_limit_info{ status, resetsAt (epoch s), rateLimitType, overageStatus, isUsingOverage, … }`
  — a structured quota signal, emitted even on success.
- `result`/`success`: `is_error, num_turns, duration_api_ms, stop_reason, session_id, total_cost_usd, usage{
  input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, … }, modelUsage{…}`.
  `input_tokens` excludes cache tokens: total input = input + cache_creation + cache_read.

## Codex CLI 0.162.1 — `codex exec --json -s read-only -C <dir> --skip-git-repo-check`

JSONL with `type`: `thread.started` (`thread_id`), `turn.started`, `item.*` (`item.type`), `turn.completed`
(`usage`), and on failure `error` (`message`) followed by `turn.failed` (`error.message`).
- **Quota exhaustion arrives on stdout as an `error`/`turn.failed` event** ("You've hit your usage limit … try again at
  <local time>"), exit code 1. Adapters must classify stdout error events, not only stderr; the reset time is a
  local wall-clock string, so `retry_after_ms` is derived best-effort and otherwise unknown.
- Without a prompt on argv, or with stdin open, it prints "Reading additional input from stdin…": spawn with stdin
  closed (`'ignore'`).

## MiniMax Code 0.6.3 — `mcode exec --cwd <dir> --output-format stream-json --permission smart`

JSONL with `type` and envelope `runId, sessionId, turnId, sequence, schemaVersion, timestampMs`:
`exec.started`, `session.started`, `turn.started`, `item.started|updated|completed` (`item`), `turn.completed`
(`durationMs, model, usage{ inputTokens, outputTokens, cacheReadTokens, totalTokens }, usageIncomplete, usageSource`),
`exec.completed` (`result`). No USD cost is reported: cost stays unknown unless priced. Honour `usageIncomplete`.

Runtime requirement (observed 2026-10-11 in the V2 live smoke): `mcode` 0.6.3 is a `#!/usr/bin/env node` script that
supports Node 22.19+, 24, 25 or 26 and refuses Node 23.6 ("current version is 23.6.0", exit 1; the adapter then reports
a failed run). The first `node` on PATH must be a supported one. The adapter takes `nodeDir` (or `MCODE_NODE_DIR` in its
env) and puts that directory first on the child PATH for runs and probes; without it PATH is used as is. Installs whose
default `node` is 23.x must set `MCODE_NODE_DIR` (owner action for the service environment).

## OpenCode

Live capture (opencode 1.18, `opencode run --format json`, via scripts/v2-bench.js): every line is
`{ type, timestamp, sessionID, part }`. `type` is `step_start`, `text` (answer in `part.text`), tool events, and
`step_finish` with that step's `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and `part.cost`.
The adapter sums usage per step (input includes cache tokens, output includes reasoning). A `cost` of 0 is recorded as
unknown USD, never $0: unpriced providers report 0 too. Other shapes fall back to the generic parser.
