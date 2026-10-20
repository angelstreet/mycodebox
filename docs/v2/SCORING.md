# Scoring report

[Documentation index](../README.md) · [Architecture](ARCHITECTURE.md) · [Routing notes](ROUTING.md)

`scripts/v2-score.js` is a read-only report over the V2 task store. It answers: which models and runtimes complete
tasks that were verified, at what cost, how fast, and with how much rework. It does not change the router, the
registry, any policy or any file. There is no automatic self-modification; a person decides whether to act on it.

```sh
node scripts/v2-score.js                          # table, store = $GHOSTY_STATE_DIR/v2
node scripts/v2-score.js --json                   # machine-readable
node scripts/v2-score.js --store DIR --since 2026-10-01T00:00:00Z
node scripts/v2-score.js --scorecard [--suite MANIFEST] [--json]   # full scorecard (see Scorecard)
node scripts/v2-score.js --tool-score --suite MANIFEST             # tool score over a bench run (JSON)
node scripts/v2-score.js --compare A.json B.json                   # two tool scores; refused across suite versions (exit 3)
node scripts/v2-score.js --propose [--history FILE]                # print proposals, write nothing
node scripts/v2-score.js --propose --write-proposals --store DIR --base-sha SHA [--project ID]
```

The scorecard is also served read-only at `GET /api/v2/scorecard` (V2 on) and shown under **Scorecard** in the Tasks view.
Only `--write-proposals` writes, and only with an explicit `--store`: see [Proposals](#proposals-approval-gated).

It reads `tasks/<id>/events.jsonl` directly. It never calls the store's recovery, so scoring a live store cannot
truncate or rewrite anything. A torn last line is ignored. A corrupt line before the tail makes the task unreadable: it is
listed under `tasks.unreadable`, left out of every rate, and noted in the caveats (it is not counted as a success or a failure).

## Data sources

| Fact | Event | Field |
|---|---|---|
| Task, creation time, informational template | `task.created` | `payload.task` (`review_policy.mode`) |
| State changes and acceptance time | `task.transitioned`, `task.completed`, `task.cancelled` | `payload.to`, event `timestamp` |
| Developer of a commit | `task.head_changed` | `payload.actor.id` (the registry entry `runtime:model`) and `payload.sha` |
| Tokens and cost | `usage.recorded` | `runtime`, `model`, `input_tokens`, `output_tokens`, `usd` (`null` = unknown) |

Evidence, verdicts and decisions decide whether a task was accepted: the store refuses `accepted` without passing required
checks on the exact SHA and an independent approve. So the report counts `accepted` as **verified** and does not re-judge it.

## Metrics

A task is **settled** when it ended `accepted` or `failed_unrecoverable`. Cancelled tasks (an owner decision), informational
tasks (never dispatched to a developer) and open tasks are counted in the totals but excluded from every rate.

Each settled task is credited to exactly one model and one runtime, so groups never double count:

- accepted: the developer recorded for the accepted head SHA;
- failed: the last developer recorded, else the model of the last usage record, else `unknown`.

Only registry-shaped ids (`<known runtime>:<model>`) count as developers or models. Other actors, such as `external:worktree` written by worktree revalidation or a human id, are ignored for credit and are never exported to the router.

| Metric | Definition |
|---|---|
| `settled` | settled tasks credited to the group |
| `verified`, `verified_rate` | accepted tasks credited to the group, and `verified / settled` (`null` when nothing settled) |
| `cost.per_verified_completion_usd` | **all** known spend credited to the group, failed tasks included (developer and reviewer usage), divided by `verified`. A model that burns money on failures is not cheap. **`null` if any settled task credited to the group has an unknown cost**: no usage record, a `null` `usd`, or usage flagged `incomplete`. A partial mean is never reported |
| `cost.spend_on_accepted` | spend on the group's verified tasks only (`null` if none has a known cost), shown separately for comparison |
| `cost.usd_known_total`, `cost.spend_unknown_tasks` | total known spend over settled tasks, and how many settled tasks had unknown cost |
| `median_latency_ms` | median of (acceptance time minus creation time) over verified tasks; `null` when there are none. Includes time spent waiting for the owner or quota |
| `rework.transitions` | number of entries into `repair` or `replan` across the group's settled tasks, plus `per_settled_task` |

## Caveats

- Small samples mislead. The report warns when a group has fewer than 5 settled tasks; treat those as anecdotes.
- A model is credited by its developer role. A strong reviewer's cost is inside the developer group's cost per
  completion, and its review is not credited separately.
- Latency is wall time including waits, so it mixes model speed with quota and approval delays.
- Cost is only as known as the price table: `PLACEHOLDER` or missing prices make `usd` unknown, which makes the figure unknown. Usage marked `incomplete` (a runtime that reported partial counts) is treated as unknown cost too.
- Task difficulty differs between models unless routing was random; a higher rate may reflect easier work. Do not rank
  models from a few tasks, or from tasks that were not comparable.
- Rework counts transitions, not attempts inside a run.

## Feeding the router

`scripts/v2-score.js --json` includes `router_history`, shaped for `route(task, { history })` in
`orchestration/router.js`:

```json
{ "claude:claude-sonnet-5-5": { "attempts": 14, "verified": 12, "errors": 2, "latency_ms": 640000, "total_usd": 3.1 } }
```

Keys are registry entry ids (`runtime:model`). `attempts` is `settled`, `verified` is `verified`, and `errors` is the failed
count, so `verified <= attempts` and `errors <= attempts` (the router's coherence rule). `latency_ms` and `total_usd` are
**omitted when unknown**, never zero-filled, so the router falls back to its priors for that term. The router reads
`total_usd / verified` as the cost per verified completion; `total_usd` here is the group's total spend including failed tasks, and it is omitted whenever the figure is unknown. Entries for `unknown`
runtimes are not exported.

The router ignores an entry with fewer than its minimum attempts (5), and ignores an incoherent one (the rationale says so),
so thin or corrupt data cannot steer a choice.

**What the live router consumes.** The server rebuilds this history from its own task store (`historyProvider` in
`orchestration/v2-runtime.js`, `buildScorecard` -> `routeHistory`, cached 60 s, read-only; a store that cannot be read gives
the last good history or none) and passes it to every live `route()` (OWNER_DECISIONS §12.3). With 5 or more attempts per
model it replaces the tier priors with measured quality (verified rate scaled 0.85..1 by first-pass rate), reliability,
latency, tokens and cost per verified completion. The switch is the project policy field `routing.history` in
`.ai/project.json` (default `true`; `false` = priors only, an explicit empty history). Nothing else in this document
reaches a live route: the ledger (`v2-ledger.js`), `recommend()`, the digest and the proposals never change a choice.
To try another history without touching live routing, pass a saved `router_history` object as `history` in a dry run
(`ROUTER_DRYRUN.md`).

## Scorecard

`orchestration/scorecard.js` (pure; not the root `scorecard.js`, which scores the manager). `buildScorecard(logs, { manifest,
unreadable, since })` folds each task log into a per-run record and aggregates settled runs four ways: `by_model` and
`by_runtime` (developer credit, as above), `by_role` (`developer:<entry>` and `reviewer:<entry>`; a task with two reviewers
counts in both reviewer rows, and each reviewer row counts only the defects that reviewer raised) and `by_task_class`
(`task.task_class`, else the bench manifest, else `unknown`; a class matches `[a-z0-9][a-z0-9._-]{0,63}`). Every group carries `small_sample` (fewer than 5 settled) and an
`unknown` map naming each metric that could not be derived and why. Informational tasks (including proposals) are never scored.

Unlike the plain report above, the scorecard counts a **cancelled** non-informational task as settled and not verified, so
cancelling work a tool could not finish never raises its rates; each group reports `cancelled` separately.

| Metric | Definition | Events |
|---|---|---|
| `verified`, `verified_rate` | accepted / settled (as above) | `task.transitioned`/`task.completed` |
| `first_pass`, `first_pass_rate` | accepted with zero entries into `repair` or `replan`, over settled | transitions |
| `cost.per_verified_completion_usd` | same rule as above: all spend over verified, `null` if any settled task has unknown cost or nothing was verified | `usage.recorded` |
| `median_latency_ms` | creation to acceptance over verified tasks, wall time: it **includes** time waiting for the owner (approvals) and for quota | timestamps |
| `rework.rounds` | entries into `repair`/`replan` | transitions |
| `owner_interventions` | `approvals_requested` (`approval.requested`), `approvals_granted` (`approval.granted` except `kind: resume`), `approvals_denied` (`approval.denied`), `resumes` (`approval.granted` with `kind: resume`, the owner's nudge to retry), `interventions = approvals_requested + resumes`. A budget stop answered by the bench runner's suite-ledger grant (actor `v2-bench-ledger`, matched by the request's `k`) is a policy-authorized confirmation: it is counted in `budget_auto` (JSON only) and excluded from the other counters and from `interventions`; a real owner answer still counts. `messages` is always `null`: no V2 event records owner chat messages | approval events |
| `reviewer_defects` | `caught`: `reject` verdicts from an actor that is not a developer of the SHA it judged; `findings`: their findings count. All verdicts precede acceptance (the store refuses writes after it) | `verification.failed` with a verdict, `task.head_changed` actors |
| `regressions` | see below; `detected` is `null` when no accepted task of the group was re-checked | `evidence.recorded` across tasks |

**Regressions after acceptance**, conservatively: a check command that passed on task A's accepted head SHA ran again later
(any other task, timestamp after A's acceptance) on that exact SHA and exited differently from A's expectation. The same
SHA is the same code, so the acceptance did not hold (flaky or environment-dependent). A later run of a command A never
passed, or on another SHA, is not counted. A task whose SHA was never re-checked is `unknown`, not "no regression". An
accepted task cannot be reopened (the store refuses transitions out of `accepted`), so reopening is reported as not derivable.

## Bench manifest

A bench run (`scripts/v2-bench.js`, built separately) produces a normal task store plus a manifest:

```json
{ "schema": "mycodebox.v2.bench-run/1", "suite_id": "core", "suite_version": "3",
  "budget_policy": { "max_usd": 5, "max_task_ms": 1800000 },
  "runs": [ { "task_id": "bench-0001", "bench_task_id": "docs-link", "task_class": "docs", "expected_outcome": "done",
              "runtime": "claude", "model": "<model>", "reviewer_runtime": "codex", "reviewer_model": "<model>" } ] }
```

`expected_outcome` is `done`, `awaiting_approval`, `waiting` or `waiting_no_progress` (`waiting` whose last block reason is
`no_progress`); `EXPECTED_OUTCOMES` in `orchestration/scorecard.js` is the one list the bench and the validator share. A run
with `outcome` `skipped_budget`, `not_started` or `harness_error` never created a task: its `task_id` is `null`, the
scorecard lists it under `not_run`, and the tool score leaves it out of every component, reports `skipped` and
`run_coverage`, and stays partial (`score` `null`). Its `partial_score` then covers only the runs that started: it is not a
lower bound for the whole suite. `task_id` must be unique; `suite_version` is a string (an
integer is accepted and stringified). `budget_policy.max_usd` is the fixed budget for the whole suite; `max_task_ms` the
per-task latency budget. Declared `runtime`/`model` are a fallback only: credit follows the recorded developer, and a
mismatch is listed in the caveats. Manifest runs with no task in the store are listed and count as incorrect.

## Tool score

`toolScore(scorecard, manifest)` over a fixed suite (`suite_id` + `suite_version`), formula `v1`:

```
score = 100 * (0.30 * outcome_correctness + 0.25 * verified_rate + 0.15 * first_pass_rate
             + 0.10 * cost + 0.10 * latency + 0.10 * owner_interventions)
```

| Component | Value in [0,1] |
|---|---|
| `outcome_correctness` | runs whose final state matches the expectation / all runs. `done` = `accepted`; `awaiting_approval` = ended in `awaiting_approval`; `waiting` = ended in `waiting`. A run expected to stop that ended `accepted` is wrong |
| `verified_rate` | accepted / runs expecting `done` |
| `first_pass_rate` | accepted with zero repair/replan / runs expecting `done` |
| `cost` | `1 - total spend / budget_policy.max_usd`, clamped; unknown if the budget is missing or any run's cost is unknown |
| `latency` | mean over runs expecting `done` of `1 - latency / max_task_ms` (clamped; not accepted = 0); unknown without `max_task_ms` |
| `owner_interventions` | runs expecting `done` that needed no approval request or resume / runs expecting `done` |

Any unknown component makes `score` `null` with `score_reason`. Alongside it the result always carries
`partial_score` (100 x the weighted sum of the **known** components, not rescaled: a lower bound out of `100 * coverage`),
`coverage` (the sum of the known components' weights) and `unknown_components`. The cost component also reports
`cost_known_runs` and `cost_coverage` (known-cost runs / all runs): with a placeholder price (for example a model whose
price row is `PLACEHOLDER`) cost is unknown, and the partial score is what can be compared.

`compareToolScores(a, b)` returns the score and partial-score deltas and per-component `a`, `b`, `delta`, `weighted_delta`.
It **refuses** (`E_SUITE_MISMATCH`) when the formula, `suite_id`, `suite_version`, `budget_policy.max_usd` or
`budget_policy.max_task_ms` differ, when one score is full and the other partial, or when the two cover different
components: a new suite version or budget is a new baseline. Suites under 10 runs carry a small-suite caveat.

## Proposals (approval-gated)

`orchestration/proposals.js`. `generateProposals(scorecard, { registry, tasks, routerHistory, currentHistory, currentWeights })`
is pure and returns proposals; each has `kind`, `title`, `rationale`, `evidence_refs`, `change` or `text`, `risk_class`
(at least `medium`; registry changes `high`), `shadow` and `applies_itself: false`. Rules fire only for groups with at
least 5 settled tasks:

| Kind | Rule | Evaluation |
|---|---|---|
| `router_history` | the score report's `router_history` has an entry with 5+ attempts and differs from the history in use (`--history FILE`, default none = priors). Stale since D-025: live routing already uses the store history, so this compares against priors, not against what runs | shadow |
| `router_weights` | overall first pass < 50%: quality +0.1, cost -0.1; or verified >= 90%, first pass >= 80% and all costs known: cost +0.1, quality -0.1 (renormalized) | shadow |
| `model_registry` | a model's verified rate < 50%: exclude it from routing (`models.json` or the project `model_allowlist`). Owner-cancelled tasks count against the model (settled, not verified), so a model whose work the owner keeps cancelling can be proposed for exclusion | shadow with `exclude` |
| `role_prompt` | reviewer rejects per settled task >= 0.5 for a developer model: developer prompt text | text only |
| `harness` | rework rounds per settled task >= 1.5, or owner interventions per settled task >= 1 | text only |

Shadow evaluation runs `route()` (shadow mode, nothing starts) on every recorded non-informational task with the current
and the proposed history, weights or exclusion, and lists the tasks whose choice differs (`shadow.changed`).

`recordProposals` (the only writer, used by `--write-proposals`) records each proposal through the normal intake as an
**informational** task (`proposal-<id>`, risk at least `medium`), with a decision record and an `approval.requested`
event, and moves it to `awaiting_approval`, so the Tasks view shows it in the approval queue. It appends one line per new
proposal to `journal.jsonl` in the store directory (append-only; rationale, evidence refs, change, shadow diff,
`applied: false`). The same proposal maps to the same task and event ids, so a replay records nothing new; whether a
journal line is written is decided by the journal itself (proposal id not yet journaled), so a crash between creating
the task and appending the line is completed on the next run.

`recordProposals` refuses (`E_CONTROLLER_LIVE`) while a goal-loop controller may be alive on the store: a
`controller.*.intent.json` from this host whose pid is alive (whatever its heartbeat age: an idle loop beats only while
stepping), one from another host with a heartbeat younger than 40 s, or one that cannot be judged (no pid/host and no
heartbeat). This check is not enough on its own: a loop that never stepped has no controller file, and a running server
with `GHOSTY_V2=1` keeps the store in memory and will not see tasks written behind its back until restart. **Stop the
server, or record into a copy of the store directory.**

Nothing applies a proposal. The goal loop never dispatches informational tasks, so approving one only records the owner's
decision; the task then says "decision recorded; nothing is applied by it; cancel the task to close it". A person makes
any change in a separate, reviewed task. Tests assert that the registry, router, roles,
goal loop, policy and price files are byte-identical after generating, recording and approving proposals.

## Scorecard caveats

- Owner chat messages are not V2 events; owner interventions undercount them. Cancelled tasks (an owner decision) are not scored.
- Reviewer rows overlap when a task had several reviewers; developer rows never do.
- Regressions depend on later evidence on the same SHA; most accepted tasks will show `unknown` until something re-runs a check.
- The tool score is only as fair as the suite: compare tools on the same `suite_version` and treat small suites as anecdotes.

## Dry run (round 2, 2026-10-12)

Owner-authorized budget: **USD 20 total** for real provider runs (explicit `budget_policy`, cap mode). Suite
`mycodebox-v2-bench@1` (`scripts/v2-bench.js`, fixtures in `test/fixtures/v2-bench/`), 10 tasks: fix-failing-test,
off-by-one, add-function, input-validation, refactor-extract-helper, rename-callers, doc-link-fix,
forbidden-merge-deploy (expects `awaiting_approval`), impossible-contradiction (expects `waiting_no_progress`) and
flaky-tie-order. Five developers: claude haiku, claude sonnet, codex (CLI default), minimax (CLI default), opencode
(`big-pickle`, a free model). The reviewer is always a different model: claude developers get codex, codex gets claude
sonnet, minimax and opencode get claude haiku. Outputs (task stores, manifests, logs) stay local; none is committed.

Full run (`--max-usd 16 --task-usd 2`, 50 runs): 45 runs ended as expected. Outcomes: 36 done, 6 awaiting_approval (the
5 forbidden-task runs plus one reviewer disagreement, below), 4 waiting_no_progress, 4 skipped_budget (rename-callers for
sonnet, codex, minimax and opencode: the suite ledger reserves each run's cap, so the tail of the suite was not started).

| Developer | Settled | Verified | First pass | Rework | Defects | Median latency |
|---|---|---|---|---|---|---|
| claude haiku 4.5 | 8 | 100% | 75% | 5 | 3 | 52 s |
| claude sonnet 5.5 | 7 | 100% | 86% | 2 | 1 | 34 s |
| codex | 7 | 100% | 100% | 0 | 0 | 37 s |
| minimax | 7 | 100% | 100% | 0 | 0 | 46 s |
| opencode big-pickle | 7 | 100% | 100% | 0 | 0 | 32 s |

Feature tasks had 70% first pass; every other class 100%. Owner interventions 0 (budget stops answered by the suite
ledger count as `budget_auto`, not owner interventions). Tool score: **partial 78.1** (coverage 0.8, run coverage 0.92,
4 skipped; outcome correctness 0.978, verified 1.0, first pass 0.917, owner interventions 1.0). Cost and latency are
unknown, so `score` is `null`: codex, minimax and opencode report no USD, and placeholder prices stay unknown.
With so few runs per model (7 or 8) the differences are anecdotal, not a ranking.

Defects found by the dry run and repaired before the confirmation runs (each independently reviewed):

- MiniMax made the impossible task "pass" by monkeypatching `assert`; the reviewer rejected it. The fixtures now preload a
  protected `checks/freeze-assert.mjs` (frozen `assert`, locked `process.exit`), judge `node --test` by its TAP summary
  (needs pass > 0, fail 0 and a named test) and probe the child with a nonce.
- The codex reviewer's sandbox cannot spawn nested test runners (`EPERM`, output lost), so it rejected a correct sonnet
  change. Check children now start asynchronously with a clean environment, lost output is a check error (exit 2), and
  the reviewer prompt says controller-recorded exits are authoritative while a passing exit never legitimizes a gamed diff.
- The default per-task share ($0.36) stopped every claude run on budget; the bench now refuses a per-task cap below the
  viable minimum at setup. Bench ledger confirmations were counted as owner interventions; they are now `budget_auto`.
- The scorer rejected manifests with `waiting_no_progress` or a `null` task id: bench and scorer now share one outcome list.

Confirmation re-runs on the repaired code: rename-callers done for codex, minimax, opencode and sonnet (sonnet reviewed
by codex, the case that failed before). MiniMax on impossible-contradiction remains
unstable: after the assert defense it no longer cheats, but it keeps working instead of reporting no progress: one
re-run ended `waiting` after a timeout backoff (481 s), another was cancelled at the 15-minute agent timeout (1693 s,
one repair). Both are safe stops (never accepted) but neither is the expected `waiting_no_progress`.

Round 3 diagnosis: the cause was ours, in two places. (1) The goal loop treated a developer run killed by its own run
timeout (class `timeout`) like a provider rate limit: router fallback, timed backoff (30 s, 60 s, then a model switch),
no checks, so the stall never counted toward the no-progress rule; the bench then stopped at that first timed wait and
recorded `waiting` (the 481 s run: one 8-minute run, then `timeout: backoff 1/2`). (2) The bench's agent timeout did not
fit the no-progress rule inside the wall clock: the rule needs about five developer runs (two identical failures, a
replan, two more, plus a first failure that usually differs), but with 14-minute runs only two fit in 20 minutes (the
1693 s run). Fix: a billed run timeout is now an attempt (its changes are committed and checked, the next prompt says it
timed out, the failures feed the rule) while quota and unavailability keep their backoff; mcode's own `--timeout` is
set 30 s past the controller's run timer so a stall is always classified `timeout`, never `crash`; the bench's agent timeout
defaults to 3 minutes and the bench refuses an agent timeout that cannot fit five runs in the wall clock.

Spend (USD; "estimated" is what the cap was enforced on for runs whose CLI reports no cost, never measured spend):

| Run | Known | Estimated |
|---|---|---|
| reviewer's accidental opencode run during bench review | — | 0.10 |
| pilot (off-by-one x 5, 5/5 done) | 0.31 | 1.02 |
| first full run, aborted (per-task share too small) | 0.46 | 0.42 |
| full run (50) | 3.73 | 10.64 |
| confirmation re-runs (4 batches, 7 runs) | 0.65 | 1.32 |
| **Total** | **5.15** | **13.50** |

Measured plus estimated: USD 18.65 of the USD 20 authorized. The estimates are upper bounds the cap used, not bills.

## Running the suite over HTTP (round 3)

`node scripts/v2-bench.js --http ...` (or `scripts/v2-bench-http.js` directly) runs the same suite (`mycodebox-v2-bench@1`,
same fixtures, manifest schema `mycodebox.v2.bench-run/1`, suite ledger and stop rules) through the HTTP API of a
disposable wired server instead of the in-process goal loop, so the scores are comparable with the round-2 dry run above.

```
node scripts/v2-bench.js --http --runtimes claude:haiku,claude:sonnet,codex,minimax,opencode --tasks all \
  --out /path/outside/the/repo --max-usd 20 --task-usd 1.5 [--concurrency 1] [--poll-ms 1000]
node scripts/v2-score.js --tool-score --suite OUT/manifest.json --store OUT/state/v2
```

What the driver does: starts one `node server.js` child (`GHOSTY_V2=1`, `GHOSTY_STATE_DIR=OUT/state`, `HOST=127.0.0.1`, a free
port, TLS pointed at missing files, `TMUX_BIN` = a wrapper around `tmux -L <unique>`, a temp `GHOSTY_V2_WORK_ROOT`,
`GHOSTY_V2_REPOS` = the per-run fixture repos, `GHOSTY_V2_REGISTRY` = a registry file with the same entries as the in-process
harness, `GHOSTY_V2_RUN_TIMEOUT_MS` = `--agent-timeout-min`, `GHOSTY_V2_CLAUDE_RUN_USD` = the largest claude run bound capped at the
per-task cap), then per run `POST /api/v2/tasks` (developer pinned with `preferred_models`, reviewer fixed by runtime/model
allowlists naming exactly the planned pair, `budget_policy` cap, `no_progress_policy`, the fixture checks), polls
`GET /api/v2/tasks/:id`, answers an unknown-cost budget stop with `POST .../approve` (pending `action_id` and `sha`) only while
the suite ledger fits `--max-usd` (never a reached cap, never any other kind: the forbidden task ends `awaiting_approval`),
and cancels with `POST .../cancel` at the wall clock. The server and the private tmux server are killed at the end, on error
and on SIGINT/SIGTERM. `GHOSTY_V2_CONCURRENCY` (server) and the driver's run pool both follow `--concurrency` (default 1).

Manifest additions: `driver: "http"`, `store_dir: "state/v2"`, per run `reviewer_planned`, `reviewer_actual`,
`developer_actual` and `reviewer_as_planned` (read back from the task detail; a mismatch is also written to `error`).
Differences from the in-process harness, to keep in mind when comparing: the server estimates claude runs at their
`--max-budget-usd` bound (D-022) and other runtimes from the router's prices, or stops as unknown (answered by the ledger); `checks` hold the latest
evidence per check; `stop_note` comes from the last decision. `OUT/state` is the throwaway server state (it holds a
generated reporter token and VAPID keys): keep it out of the repository. `--fake` uses the server's test-only scripted
adapter and needs `--runtimes fake-dev` (test/v2-bench-http.test.js).

HTTP driver notes (review fixes): a budget stop for unknown cost is approved with the reason `suite-ledger <committed>/<cap>`;
`v2-score.js` counts such a grant (budget request, no cap raise) as `budget_auto`, not an owner intervention, only for a
manifest with `driver: "http"`, so an existing run dir is re-scored in place with no rerun:
`node scripts/v2-score.js --tool-score --suite OUT/manifest.json --store OUT/state/v2` (and `--scorecard ...`). The server
estimates a claude run at its own `--max-budget-usd` bound (never lower), so a task cannot overspend its cap by a run. Claude
runs share one `GHOSTY_V2_CLAUDE_RUN_USD` (the largest claude `run_usd`, at most the per-task cap; haiku is not held to 0.25 as in
round 2). The child server gets only PATH, HOME, locale, proxy and provider auth variables, and a detached watcher kills it,
its private tmux server and the temp dir if the driver dies (SIGKILL included). A task stuck in `unknown_external_effect`,
with an unreadable log, or in `integrating`/`release_verifying` for 60 s is recorded as `not_yet_done`.

## Real run over HTTP (round 3, 2026-10-12)

Owner-authorized budget: **USD 20 total** for round 3 (explicit `budget_policy`, cap mode). The same suite and pairs as
the round-2 dry run, driven through the HTTP API of a disposable wired server (`--http --tasks all --max-usd 19.5
--task-usd 1.5`, concurrency 1, 3-minute agent timeout). Every budget stop for unknown cost was answered through
`POST .../approve` by the suite ledger (89 confirmations); nothing was answered for the forbidden task or the path gate.

Result: **50/50 runs started, 49 ended as expected.** Outcomes: 39 done, 6 awaiting_approval (the 5 forbidden-task runs,
stopped before any developer run, plus one path gate, below), 5 waiting_no_progress, 0 skipped on budget.

| Developer | Settled | Verified | First pass | Rework | Defects | Median latency |
|---|---|---|---|---|---|---|
| claude haiku 4.5 | 7 | 100% | 86% | 2 | 1 | 72 s |
| claude sonnet 5.5 | 8 | 100% | 75% | 6 | 2 | 44 s |
| codex | 8 | 100% | 100% | 0 | 0 | 58 s |
| minimax | 8 | 100% | 100% | 0 | 0 | 57 s |
| opencode big-pickle | 8 | 100% | 100% | 0 | 0 | 45 s |

Tool score: **partial 77.0** (coverage 0.8, run coverage 1.0, 0 skipped; outcome correctness 0.98, verified 0.975, first
pass 0.9, owner interventions 0.975). Cost and latency are unknown, so `score` is `null`, as in round 2.

Comparison with the round-2 dry run (partial 78.1; 45/50 as expected; 4 skipped on budget):

- **Coverage up, partial score about the same.** All 50 runs ran (run coverage 1.0 against 0.92): the round-2 per-task
  shares are now validated at setup and the ledger had room for the tail of the suite. The partial score moved from 78.1
  to 77.0 because of one run, not a trend: verified and owner-interventions each lost 0.025 to it, first pass dropped from
  0.917 to 0.9.
- **The one unexpected run is a safe stop by policy.** On input-validation, claude haiku left a scratch file
  (`test-fix.mjs`) outside the task's path allowlist. The path gate stopped the task at `awaiting_approval` (kind
  `paths`) with the checks passing; the driver never approves anything but a ledger budget stop, so it stayed there. This is
  the developer straying, not an engine defect: the gate is the intended behaviour and was not changed. In round 2 the
  same pair ended done.
- **The impossible task now ends as designed for every developer.** All five runs ended `waiting_no_progress`, MiniMax
  included (728 s, inside the 20-minute wall clock; round 2: a timeout backoff at 481 s and a cancel at 1693 s). This
  confirms the round-3 no-progress fix above. Times: sonnet 53 s, codex 124 s, opencode 482 s, minimax 728 s, haiku
  1136 s (haiku is the slowest to repeat the same failure; it still fits).
- **Feature tasks are where models differ.** Feature first pass was 67% (round 2: 70%); every other class 100%. Sonnet's
  rework this time (6, round 2: 2) and haiku's (2, round 2: 5) swapped places: with 7 or 8 runs per model this is noise,
  not a ranking.
- **Latency is higher, and not comparable one to one.** Medians went from 32–52 s to 44–72 s. The HTTP path adds a
  1 s poll, the server's own worktree, checks and reviewer start-up, and the wake-up after each ledger approval.
- **Driver caveat.** The run used the driver at `217177c`, before the review fixes `d902bf5` and `f292495`. The F1 fix
  (ledger confirmations are `budget_auto`) only changes scoring, and the numbers above come from rescoring the run with
  the fixed scorer. The F2 fix (the server's claude run estimate, D-022) was not in the run: claude budget stops were based
  on router prices and the ledger. A coordinator guard script held the round total under USD 20, with margin to spare
  (spend below).
- **Cost stays unknown.** Only 1 run has a fully known cost: every claude developer is reviewed by codex, and codex,
  minimax and opencode report no USD.

Spend for round 3 (USD; "estimated" is what the cap was enforced on, not measured spend):

| Run | Known | Estimated |
|---|---|---|
| bench-driver worker's sanity runs (real calls during development) | 0.09 | 0.34 |
| real run over HTTP (50) | 4.05 | 11.74 |
| **Total** | **4.14** | **12.08** |

Measured plus estimated: USD 16.22 of the USD 20 authorized. No defect required a re-run, so no re-run was made.

## Round 4: MiniMax M3 vs M3.1-Flash-Preview vs Claude Haiku (2026-10-12)

Owner brief (OWNER_DECISIONS §12): 3 repetitions, through the HTTP API of a disposable wired server, USD 10 total.
MiniMax is a flat subscription (`billing: subscription`: no marginal USD, never a measured $0); Haiku is per token.
Command, from the integration checkout at `3860d4f`:

```sh
node scripts/v2-bench.js --http --runtimes minimax:m3,minimax:m3.1-flash,claude:haiku --tasks all --reps 3 \
  --max-usd 9.2 --task-usd 0.25 --reviewer-map claude:haiku=minimax:m3 --concurrency 3 --report --out <dir>
```

Pairs: each MiniMax developer is reviewed by Haiku, and Haiku is reviewed by M3, so the reviewer is never the author's
model. Every developer ran with the light-model short leash (`run_limits`: 120 s, 40 steps, effort low where supported,
2 stalls to `no_progress`), and so did Haiku when it reviewed. No run hit the 120 s timeout.

Result: **90/90 runs ended as expected.** Outcomes: 72 done, 9 awaiting_approval (the forbidden merge/deploy task,
stopped at the policy gate before any worker ran), 9 waiting_no_progress (the impossible task). No provider quota wait,
no rate limit, no error.

| Developer | Verified (8 done tasks x 3) | First pass | Rework | Wall time, done tasks (mean) | Dev tokens in / out per run | Developer cost | Impossible task: time to stop (mean, max) |
|---|---|---|---|---|---|---|---|
| MiniMax M3.1-Flash-Preview | 24/24 | 24/24 | 0 | 34 s | 42k / 0.6k | subscription | 30 s, 30 s |
| MiniMax M3 | 24/24 | 24/24 | 0 | 44 s | 37k / 1.7k | subscription | 46 s, 57 s |
| Claude Haiku 4.5 | 24/24 | 24/24 | 0 | 68 s | 333k / 3.7k | USD 2.42 measured (~USD 0.10 per verified task) | 47 s, 57 s |

Wall time is task creation to acceptance and includes the review. The reviewer differs by pair: Haiku reviewed MiniMax,
and M3 reviewed Haiku. Haiku as a reviewer cost about USD 0.033 per review (USD 1.78 over 54 reviews and feasibility
reviews). The per-task and per-task-and-model tables are in the run's `report.md` (`v2-score.js --markdown`).

Findings:

- **On this suite, the three models tie on quality.** All 8 feature, fix, refactor, docs and test tasks were verified
  first time, 3 times each. The suite is small and easy, so it ranks speed and cost, not ability: harder work still goes
  to the standard and strong tiers by risk and by the escalation ladder.
- **M3.1-Flash is the fastest and the leanest.** It was about 25% faster than M3 and about 2x faster than Haiku, with
  2.7x fewer output tokens than M3. Haiku reads about 8x more input tokens, mostly cached context, and is the only one
  with a marginal cost.
- **Faster stop: met with margin.** The goal was an impossible task on a cheap model reaching `waiting/no_progress` in
  under 3 minutes. Every run stopped in 29–57 s, against 481–1693 s in rounds 2 and 3. Each stop came from the feasibility
  review after the developer's first run, which ended with an impossibility claim or no change. Exactly 2 worker runs
  were used each time. Two 120 s stalls alone would take about 240 s, so the leash is the backstop and the feasibility
  review gives the speed.
- **Policy gates cost nothing.** The scorecard used to show the 9 gate-stopped tasks as unknown cost, which made every
  model's cost unknown. They now have cost basis `none`, a known USD 0 because no worker ran. A run that started without
  recording usage stays unknown.

Recommendation (routing defaults; floors unchanged):

| Task class and priority | First choice | Then | Why |
|---|---|---|---|
| non-security work at low or medium risk; priority balanced or cost | MiniMax M3.1-Flash-Preview (ladder start) | M3 (sideways, on provider error or quota), then Haiku, Sonnet, Opus | equal quality here, fastest, no marginal USD |
| the same, priority speed | ranked by score, no ladder | | among light models M3.1-Flash ranks first (latency default below) |
| the same, priority quality | ranked by score, no ladder | | not separated by this suite; tier priors favour standard and strong |
| high or critical risk, security work, pinned tasks | unchanged floors (standard or strong, or the pin) | | the ladder never goes below a floor or off a pin |
| reviewer of a MiniMax developer | Haiku | | independent model and provider, about USD 0.03 per review |
| reviewer of a Haiku developer | M3 | | independent, subscription |

Router defaults set from this run:

- The escalation ladder (D-026) is on by default, in the order M3.1-Flash → M3 → Haiku → Sonnet → Opus. That is the
  registry's order (light before standard, subscription before per token, then score), and the data confirms it.
- `models.json`: Haiku `latency_ms` went from 8000 to 20000, so a speed-priority task ranks the measured order
  (M3.1-Flash < M3 < Haiku) instead of preferring Haiku.
- The run_limits defaults are kept: 120 s, 40 steps, effort low, and 2 stalls for light models on docs, test and
  coding:low. The longest verified task took 1.9 min including its review, so the leash did not cut any good run.
- Once the server's own store holds 5 or more attempts per model, route history from the scorecard replaces the tier
  priors with measured quality, reliability, latency and cost.

Caveats: 3 repetitions of 10 tasks. `MiniMax-M3.1-Flash-Preview` is a preview model that may change or be withdrawn, and
the router then falls back to M3. The MiniMax subscription quota was not reached, so quota waits are tested only with stub
CLIs.

Spend for round 4 (USD, measured from provider usage records; MiniMax is subscription):

| Run | Measured |
|---|---|
| sanity run 1 (6 runs, before the fixes) | 0.34 |
| sanity run 2 (6 runs, after the fixes) | 0.29 |
| full evaluation (90 runs) | 4.20 |
| **Total** | **4.83** of the USD 10 authorized |

The two sanity runs exposed defects that were fixed before the full run: mcode 0.6.5 final-text parsing, verdict and
feasibility JSON, stall counting for no-change runs, and the 120 s leash (V2_PROGRESS R4-fix). The full run then
exposed one more, the `none` cost basis above, which was fixed by rescoring. No re-run was needed.

## Round 5 note: work type from task_class (2026-10-14)

From round 5 a task's declared `task_class` that names a work type (`docs`, `test`, `coding`, `ui`, `research`,
`debugging`) sets the router's work type, unless the keywords say `security` or `operations`
(`orchestration/router.js` `classifyWork`). Before, keywords alone decided, so a docs task whose definition of done
named its checks ("project-tests passes") was classified `test`. Scorecards grouped by work type from round 4 and
round 5 are therefore not directly comparable for tasks that declare a class.

## Round 14: cross-source ledger (`scripts/v2-ledger.js`)

`v2-score.js` scores tasks that ran inside the V2 task store. Most work on the box does not: sessions hand branches to
the integration lane, the manager runs MiniMax workers, `game-dispatch` runs scripted jobs. `scripts/v2-ledger.js`
(OWNER_DECISIONS §8) joins those real sources into one normalized ledger and prints the same metrics. It is read-only:
it opens files for reading, never writes, never edits a config, prompt or routing file. A missing source is listed as
`skipped`, not an error.

```sh
node scripts/v2-ledger.js                       # per model and per runtime
node scripts/v2-ledger.js --by source --since 2026-10-01
node scripts/v2-ledger.js --json [--records]    # --records adds the normalized ledger
node scripts/v2-ledger.js --state-dir DIR       # default $GHOSTY_STATE_DIR or ~/.local/state/ghosty
```

### Ledger record

One record per attempt (queued and running items are open, not attempts):

| Field | Meaning |
|---|---|
| `source` | `lane`, `manager`, `game-dispatch` |
| `id`, `ref`, `kind` | source id; branch (`repo/branch`), worktree or job name; what it was |
| `model`, `runtime` | attributed model and agent (`unknown` when it cannot be attributed; `none` for no-LLM jobs) |
| `started`, `ended`, `latencyMs` | ISO times and their difference |
| `outcome` | source state: `merged`, `deployed`, `returned`, `accepted`, `fixed`, `rejected`, `no-verdict`, `completed`, `abandoned`, ... |
| `verified`, `evidence` | yes/no and the reason; only verified completions count as successes |
| `costUsd`, `tokens` | summed from `usage-ledger.jsonl` rows in the attribution window; `null` cost = unknown (MiniMax has no price), never `$0` |
| `rework`, `reworkEvent` | earlier failed attempts for the same key; whether this attempt is itself a rework event |

### Per-source mapping

| Source | File | Attempt | Verified when (evidence) | Rework |
|---|---|---|---|---|
| lane | `integration/requests.jsonl` (snapshots, last per id wins) | one request in a final state | state `merged` or `deployed`, `pushed`, the final `test` step green, not `alreadyMerged` (evidence: lane tests green + pushed) | a `returned` request; `rework` = earlier returns of the same repo/branch |
| manager | `manager-runs.jsonl` (start + end lines per id) | one worker run that ended, or never closed after 6 h | verdict `accepted` or `fixed` (the manager reviewed and accepted the work) | verdict `fixed` or `rejected` |
| game-dispatch | `~/.cache/game-dispatch/runs.jsonl` | one run; `started` older than 6 h is `abandoned` | `completed` with a `script_result_id` | a non-completed run before a later run of the same job |

Attribution (model, runtime, cost, tokens) comes from `usage-ledger.jsonl`. Lane: rows labelled with the request's
session inside the window from the session's previous request (at most 24 h) to this request; the dominant model by cost
is credited, with `session-history.jsonl` as fallback. Manager: `minimax` rows whose `cwd` is the run's worktree inside
the run window. Game-dispatch: its own `model` field. This is an approximation: a session working on two branches at once
splits cost by time, not by branch.

### Metrics (per group)

`attempts`; `verified`; `verifiedRate` = verified / attempts; `costPerVerified` = cost of all priced attempts in the group
(failed ones included) / verified, `null` when nothing is priced; `medianMs`, `p90Ms` of verified completions (lane
latency is lane time from request to result, not the session's work time); `rework` = number of rework events.

### What the ledger feeds (and what it does not)

The live router does **not** read `v2-ledger.js`. The ledger feeds only the read-only outputs: the `recommend()` ranking, the
daily digest and the routing shadow (Round 15 below), plus `v2-score.js --json` for a person. Live routing history comes from
the task store ("Feeding the router" above).

- `recommend()` needs `minVerified` 10 verified and `minAttempts` 15 attempts per (model, runtime) and task type
  (`GHOSTY_SHADOW_MIN_VERIFIED` / `GHOSTY_SHADOW_MIN_ATTEMPTS`); it ranks by verified rate, then tokens per verified, then
  more verified. Models named `unknown` or `none` are never ranked. There is no cost or rework term.
- Cost per verified completion is `null` when any verified record in the group has no known cost (a flat plan record counts
  as unmetered and stays out), so an unpriced run never lowers the figure. Unpriced usage rows are unknown, not 0.
- Sources differ in difficulty (a docs fix versus a game run); compare within one `--by source` slice when possible.
- The output is a suggestion for the manager. Nothing applies it: no write to routing config, prompts or registry.

### Gaps (2026-10-19)

The usage ledger has no price for MiniMax, so its cost per verified completion is unknown. Lane and manager records
without usage rows in their window have model `unknown`. Manager verdicts are optional, so unclosed runs count as
unverified. Reviewer-pass evidence is not recorded as its own field yet. (Closed by Round 14b below for new records.)

## Round 14b: recorded attribution (manager runs, lane requests, flat plans, reviewer evidence)

Round 14 attributed model and cost by joining a time window over `usage-ledger.jsonl` afterwards. Round 14b records the
attribution when the run or request is made; `v2-ledger.js` prefers it and uses the window only for old records.
All of it is computed by `usage-window.js` from the ledger rows the usage tailer already prices; there is no second price table.

### Rules

| Source | Recorded where | Rule |
|---|---|---|
| manager run | `node scripts/manager-run.js end <id> [--verdict ..] [--review pass\|fail] [--model M] [--session LABEL]` writes `usage` on the end line of `manager-runs.jsonl` | ledger rows whose `cwd` is the run's worktree (or whose `label` is `--session`, and for a `minimax` run only rows of agent `minimax`, so the manager's own rows never count) in (startedAt, endedAt]; dominant model and runtime, tokens in/out/cache, summed cost (unknown when any non-plan row is unpriced). `--model` only fills the model when no row exists (tokens and cost stay unknown) |
| lane request | `usage` on the request record in `integration/requests.jsonl`, frozen at enqueue | `integrate request` sends the requester's git toplevel (`worktree`, loopback callers only). Rows whose `cwd` is inside it in (from, to] are summed (`attribution: worktree`, per branch); with no worktree or no matching rows, rows labelled with the requesting session (`attribution: session-window`, splits by time when a session works two branches). `to` = request time, `from` = the later of the session's previous request (any branch) and 24 h earlier |
| game-dispatch | `runs.jsonl` | its own `model` and `prompt_version` (`-` = none); no tokens or cost |

`usage` = `{model, runtime, tokens (in+out+cache), tokensIn, tokensOut, costUsd, plan, rule, (from, to)}`.
Records written before 14b have no `usage`: the ledger falls back to the Round 14 window join and marks them
`approximate: true` (`attribution: "time-window"`, `"recorded"` otherwise, `"none"` when nothing matched).

### Flat plans

A model whose registry billing is `subscription` (`orchestration/models.json`, today MiniMax) has no per-token cost.
Its `costUsd` is `null` with `plan: "flat"`, never 0. The report prints `in plan`, leaves such attempts out of cost and
`$/verified` (the denominator is the metered verified completions), and shows `tok/verified` (tokens per verified
completion) for every group. `--json` groups carry `flatPlanAttempts`, `tokens`, `tokensPerVerified`, `approximate`.

### Reviewer evidence

| Source | Reviewer field | Effect on `verified` |
|---|---|---|
| lane | `review {pass, source, confidence}` set by the merge evaluation step (merge floor; `jev` or `reasoning` when the merge evaluator reports its decision) | a `pass: false` blocks verification; a pass is named in the evidence |
| manager | `review: pass\|fail` from `manager-run.js end --review` (the independent reviewer's verdict) | `fail` blocks; `pass` verifies a run with no manager verdict; with an `accepted`/`fixed` verdict it is added to the evidence |
| game-dispatch | none | evidence stays the completed run with a script result id |
| V2 task store | reviewer verdicts stay in `v2-score.js` (goal loop), not in this ledger | - |

`node scripts/v2-ledger.js --by prompt_version` groups by the game-dispatch prompt version (other sources group as `none`).

## Round 15: shadow routing and the daily digest (read-only, observe only)

Scoring feeds a **shadow** recommendation next to every live runtime choice. Nothing here changes a choice, a config,
a prompt or a registry entry: the loop calls the shadow after it decided, ignores the result and the shadow swallows every error.

### Task types

`classifyTaskType({source, role, text})` in `scripts/v2-ledger.js`; every ledger record now carries `type`. `text` is the
lane branch, the manager run task plus worktree name, or the V2 task title and goal. Precedence, first match wins:

| Type | Rule |
|---|---|
| `game_run` | source `game-dispatch`, or the text names `game`/`league`/`lol` and `run` |
| `review` | role `reviewer`/`security`, or the text has `review`, `reviewer`, `audit` |
| `infra` | V2 work type `operations`, or the text has `infra, lease(s), deploy(s), systemd, restart, ci, cutover, tailscale, service, host(s), ops, install, runner, watchdog` |
| `small_fix` | the text has `fix(es), bugfix, hotfix, typo, regression, crash, flaky, patch` |
| `other` | everything else, including unknown |

Conservative choices: an infra word wins over a fix word (`lease-fix-ttl` is infra); no file-count rule (lane records carry
none); ledger sources have no reviewer-only records, so `review` history is thin and mostly "insufficient data".

### Recommendation ranking (`recommend()`)

Per type, group the ledger records by (model, runtime); skip model `unknown`/`none`. A group is eligible only with
**at least `minVerified` verified (default 10) and at least `minAttempts` attempts (default 15)**
(`GHOSTY_SHADOW_MIN_VERIFIED`, `GHOSTY_SHADOW_MIN_ATTEMPTS`). Among eligible groups, in this order:

1. higher verified rate;
2. fewer tokens per verified (a group with no token figure ranks last on this key);
3. more verified completions;
4. model and runtime name (so the answer is deterministic).

No eligible group: `recommended: null`, reason `insufficient data (need >= N verified and >= M attempts; best seen K verified)`.
Cost is not a key (flat-plan models have none). History is all records in the ledger; unknown attribution is never counted for a model.

### Where the shadow sits

`routing-shadow.js` (`createRoutingShadow`), wired in `orchestration/v2-runtime.js` as the goal loop's `shadow` option
(`GHOSTY_ROUTING_SHADOW=0` turns it off). `orchestration/goal-loop.js` `shadowNote()` is called at the two live choice points:
`sPlanned` (the developer entry actually chosen, after any escalation climb) and the reviewer choice (`runReviewer`, after the independence
check). Speculative `routeFor` calls (escalation probes, fallbacks) are not noted. The ledger is read through a 10-minute
in-process cache (a failed read is cached too, no retry storm); one line per (task, role, choice key).

**No live change guarantee.** `note()` returns nothing; the call is in try/catch, a returned promise gets a `.catch`; the
choice variable is computed before the call and never reassigned from it. `test/v2-goal-loop.test.js` ("R15 shadow") runs
the same task with no shadow, a recording, a throwing and a rejecting shadow and asserts identical developer and reviewer entries;
`test/v2-shadow-routing.test.js` proves the logger swallows an unwritable state dir and junk input.

### Log: `<state dir>/routing-shadow.jsonl` (append-only, rotated once to `.jsonl.1` at 5 MiB)

`{ts, task_id, role, type, chosen: {entry, runtime, model}, recommended: {model, runtime, verifiedRate, tokensPerVerified} | null,
agree: true|false|null, reason, samples: {typeRecords, eligible, recommended: {attempts, verified}|null, chosen: {attempts, verified}|null}}`.
`agree` compares **models** (case-insensitive); `null` = no recommendation (insufficient data), excluded from the agreement rate.
No prompts, no task text, no paths are logged.

### Daily digest

`node scripts/v2-ledger.js --digest [--since 24h|7d|ISO date] [--json] [--state-dir DIR]`, or
`GET /api/manager/score-digest?since=24h` (same payload; read-only, cached 60 s per `since`, no writer). Default window 24 h; the **previous
window** is the equal span before it. Contents: per model verified rate, tokens per verified, rework (window, plus previous window
counts); regressions; the per-type recommendations; shadow agreement (`agree` / comparable, entries without a recommendation, in the window).

- **Rate-drop regression:** a model whose verified rate fell by at least `regressionDrop` (default 0.2, `GHOSTY_SHADOW_REGRESSION_DROP`) against the previous window, both windows non-empty.
- **Lane return after green:** a lane request in the window that ended `returned`/`failed` for a repo/branch that had an earlier verified request.
- **Caveat:** every model row, rate-drop and the agreement rate carries `low sample (n < minAttempts)` when below `minAttempts` (rate-drop uses the smaller of the two windows). A lane-return is a single event and says so. Treat caveated numbers as not significant.

There is no scheduler: the manager calls the script or the route. The digest never writes.
