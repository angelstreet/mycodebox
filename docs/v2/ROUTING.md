# Routing (Phase 4) notes

Modules: `orchestration/model-registry.js`, `orchestration/router.js` (shadow only), `orchestration/budget.js`.

## Integration requirements for the goal loop

* **Working-directory floor.** When a task carries `cwd`, `worktree` or `worktree_path`, the router requires it to be
  an absolute path inside one of `policy.allowed_roots` (exported as `WORKDIR_ROOTS_KEY`). The goal loop must pass the
  V2 worktree root in `policy.allowed_roots`; with no roots configured **every worktree route is denied** (fail closed).
  Pass `realpath` (for example `fs.realpathSync`) in the `route()` options so symlinks cannot escape a root; without it
  paths are compared lexically. A path that cannot be resolved is denied.
* **Policy checker.** Inject `checkAction(policy, task, action)` (ARCHITECTURE §4). The router always applies its own
  floors first (non-object task, critical risk, forbidden topic, unserialisable text); only `allow === true` passes.
  High-risk approval belongs to `policy.js`; the built-in stub only mirrors it.
* **Budget dimensions.** `max_usd`, `max_input_tokens`, `max_output_tokens`, `max_duration_ms`, `max_turns` (ledger and
  estimate key `turns`), whole task and `per_attempt`. Unknown, malformed or negative values under a cap give
  `awaiting_approval`; exhausted provider quota gives `waiting` unless a cap stop applies.
* **History.** Counts must be coherent (integers, verified <= attempts, errors <= attempts, non-negative spend);
  otherwise the entry is ignored and the rationale says so.
* **Fallback.** `retry_after_ms` is clamped to (0, 900000] ms; anything else uses the default backoff.

## Round 4: run limits, billing, history and the escalation ladder (OWNER_DECISIONS §12)

### Run limits (`orchestration/run-limits.js`, D-024)

One limits object: `{ timeout_ms, max_steps, effort, context_mode, stall_runs_to_no_progress }`.
`timeout_ms` 1000..86400000; `max_steps` positive integer or null (no cap); `effort` a runtime effort or null (runtime
default); `context_mode` `standard`|`lightweight`; `stall_runs_to_no_progress` positive integer or null (the
OWNER_DECISIONS §4 rule only). Unknown keys and bad values are rejected.

Sources, most specific wins **field by field**: task `run_limits` > `.ai/project.json` `run_limits` > the registry
entry's `run_limits` (`orchestration/models.json`) > engine defaults (the loop's run timer — 30 min, or
`GHOSTY_V2_RUN_TIMEOUT_MS` in the wired server — no step cap, runtime-default effort, standard context, §4 rule only).

Keys. Project and task: `{ "<selector>": { "<class>": limits } }`, selector `*` | runtime (`minimax`) | entry id
(`minimax:MiniMax-M3`); a task may also give one flat limits object. Registry entry: `{ "<class>": limits }`. Class =
`*` | router work type (`docs`, `test`, `coding`, … from `classifyWork`) | `<work type>:<risk class>` (`coding:low`).
Inside one source the selector decides first (entry > runtime > `*`), then the class (type:risk > type > `*`).

```json
"run_limits": { "minimax": { "docs": { "timeout_ms": 120000 } }, "*": { "coding:medium": { "max_steps": 60 } } }
```

Defaults shipped in the registry (light models on easy classes): `docs`, `test` and `coding:low` on
`minimax:MiniMax-M3` and `claude:claude-haiku-4-5` get `timeout_ms` 120000,
`max_steps` 40, `effort` low where the model has efforts (Haiku; M3 has none) and `stall_runs_to_no_progress` 2.
Every other model and class keeps today's behaviour.

Rules: an effort the entry does not support rejects that candidate at routing (never translated). Limits a CLI cannot
apply are dropped with a note in the run's `task.started` payload (`limits_ignored`): claude and codex have no step
flag and no lightweight mode; the run timeout is always the controller's own timer. `lightweight` (mcode: no tool
schemas, no session) is used only for text-only reviewer roles on fresh runs; never for developers or resumes. Each
run records its effective `limits` and `limit_sources` in `task.started`.

Stops. A developer run killed by its own time limit that left the head unchanged counts at once as a stall
(`run_timeout` decision, signature `run_timeout:<entry> :: timeout`; the §4 streak keeps the checks' signature so stalls
and failing no-op runs still converge). Round 5: a timed-out run that committed a change is evaluated on that commit
(`run_timeout` chosen `evaluate the committed change`); it becomes a stall only if its required checks then fail without
progress (`stall_pending`, settled by the failure handler and kept across a `check_timeout` or `evidence_unavailable`
wait; a reviewer rejection of passing checks does not settle it on purpose: the review-failure streak bounds that loop).
Under a `stall_runs_to_no_progress` limit, a run that leaves the head unchanged (`run_no_change`) or ends with an
impossibility claim is a stall too (at most one per run), except that a no-change run on a head that still holds a
change with no exit code on a required check, or one whose checks all pass and no reviewer rejected, goes to evaluation
first (`run_no_change` chosen `evaluate the head`, same pending rule). A declared `task_class` that names a work type
(`docs`, `test`, `coding`, ...) sets the work type for run limits and routing, except over `security` or `operations`
keywords; keywords decide alone without one. And the first measurement never resets the count:
the base SHA is not measured, so checks that already pass on it look like "new passing evidence" at the first
evaluation; only progress over an earlier measurement resets stalls. Verdicts, feasibility answers and claims are read
only from the last JSON object of the run's final text; a placeholder diagnosis such as `<why>` is not a diagnosis.
When the run's limits set `stall_runs_to_no_progress` N, N stalled runs without new passing evidence end the
task in `waiting` reason `no_progress` (diagnosis names the entry, limit and next rung). Without it, the §4 rule applies.
Time to stop is about N × `timeout_ms` plus checks (2 × 120 s on the defaults); the feasibility review below can stop
an impossible task after the first run.

Feasibility review. On failing required checks, after a developer's impossibility claim (`{"impossible":true,
"diagnosis"}` in its answer) and once per task after the first stall of a short-leash run, an independent reviewer
(never a developer of the task, budget-checked; answers are read as the last JSON object in the final text, one-line,
pretty-printed or fenced) answers `{"verdict":"reject","impossible":true|false,"diagnosis",
"findings"}`. `impossible:true` ends the task in `waiting/no_progress` with that diagnosis; `false` adds its findings to
the developer's feedback. A normal review (green checks) may carry `impossible:true`: it is ignored and journaled
(`impossible_ignored`). Quota or rate-limit text from mcode (stderr or a failed event, also when the run then sat until
our timer) is class `rate_limit`: provider backoff in `waiting` (the wait names `entry` and `role`), never a stall.

### Billing and cost (D-025)

Registry entries carry `billing` (`per_token` | `subscription` | `unknown`; default claude/codex per_token, minimax
subscription, opencode unknown) and an optional `quota { period: 5h|day|week|month, tokens, usd }` (null = unknown).
Usage records carry `billing`. A subscription run keeps `usd: null` (never a measured $0); the budget gate counts its
marginal USD as 0, so a USD cap never asks the owner to confirm an unknown MiniMax cost; quota exhaustion still waits.

Router cost per verified completion: per_token = observed USD history, else price × tokens / quality (stale or
missing price = unknown, ranked last). Subscription = tokens × (quota.usd / quota.tokens, else the nominal
`SUBSCRIPTION_NOMINAL_USD_PER_MTOK` = 0.05 USD per million tokens) / quality: known, near zero, growing with tokens.
Tokens: a model's measured mean tokens per developer run (history) replace the task estimate, so token-heavy models
lose on the `cost` priority. A known first-pass rate scales history quality by 0.85..1.

History (`orchestration/route-history.js`): `routeHistory(buildScorecard(logs), { tokens: tokenTotals(logs), registry })`
gives `{ attempts, verified, errors, first_pass_rate, latency_ms, total_usd, billing, input_tokens, output_tokens,
token_attempts }` per developer entry. The wired server (`orchestration/v2-runtime.js` `historyProvider`) builds it from
its own store, read-only, at most every 60 s, and passes it to every route unless the caller gives one.

### Escalation ladder (D-026)

For low/medium-risk, non-security tasks with priority `cost` or `balanced` (policy `routing.escalation`, default
true): rungs are the router's floored candidates ordered by tier, then billing (subscription first), then estimated
cost. The developer starts on the cheapest rung whose fit-adjusted quality is at least 0.5 (only when two candidates
have a known cost). A forced strategy change (failing checks or reviewer rejection, §4 thresholds) picks
`escalate_model`: the next strictly higher rung (an equally priced sibling is not an escalation), e.g. MiniMax
M3 → Haiku → Sonnet. Each choice is a `route` + `assign_developer` decision and each climb a `strategy_change`
decision with `escalation <from> -> <to>` evidence. Floors hold: rungs are floored candidates (allowlists,
MIN_TIER_BY_RISK, probes), high/critical risk and security work are not eligible and keep their ranking and reviewers,
reviewers are never routed by the ladder, and a pinned task (`preferred_models`) never leaves its pins.


**Owner decision 2026-10-14:** MiniMax-M3.1-Flash-Preview is removed from the registry and never routed (quality judged
too low on live use); MiniMax-M3 is the only MiniMax model. The ladder starts at M3. `scripts/v2-bench.js` keeps its
`minimax:m3.1-flash` spec for explicit re-evaluation only.
