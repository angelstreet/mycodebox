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

The router ignores an entry with fewer than its minimum attempts, and ignores an incoherent one (the rationale says so),
so thin or corrupt data cannot steer a choice. The router runs in shadow mode only: the history changes a
recommendation, not a live route. To use it, a person saves the JSON, passes the `router_history` object as `history`
in a dry run, reviews the recommendation and decides. Nothing in this repository does that automatically.

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
| `router_history` | the score report's `router_history` has an entry with 5+ attempts and differs from the history in use (`--history FILE`, default none = priors) | shadow |
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
