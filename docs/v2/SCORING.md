# Scoring report

[Documentation index](../README.md) · [Architecture](ARCHITECTURE.md) · [Routing notes](ROUTING.md)

`scripts/v2-score.js` is a read-only report over the V2 task store. It answers: which models and runtimes complete
tasks that were verified, at what cost, how fast, and with how much rework. It does not change the router, the
registry, any policy or any file. There is no automatic self-modification; a person decides whether to act on it.

```sh
node scripts/v2-score.js                          # table, store = $GHOSTY_STATE_DIR/v2
node scripts/v2-score.js --json                   # machine-readable
node scripts/v2-score.js --store DIR --since 2026-10-01T00:00:00Z
```

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

| Metric | Definition |
|---|---|
| `settled` | settled tasks credited to the group |
| `verified`, `verified_rate` | accepted tasks credited to the group, and `verified / settled` (`null` when nothing settled) |
| `cost.per_verified_completion_usd` | total `usd` of **all** usage records on the group's verified tasks (developer and reviewer), divided by `verified`. **`null` if any of those tasks has an unknown cost** (a usage record without `usd`, or no usage at all). A partial mean is never reported. `cost.usd_known_total` and the known/unknown counts show what is known |
| `median_latency_ms` | median of (acceptance time minus creation time) over verified tasks; `null` when there are none. Includes time spent waiting for the owner or quota |
| `rework.transitions` | number of entries into `repair` or `replan` across the group's settled tasks, plus `per_settled_task` |

## Caveats

- Small samples mislead. The report warns when a group has fewer than 5 settled tasks; treat those as anecdotes.
- A model is credited by its developer role. A strong reviewer's cost is inside the developer group's cost per
  completion, and its review is not credited separately.
- Latency is wall time including waits, so it mixes model speed with quota and approval delays.
- Cost is only as known as the price table: `PLACEHOLDER` or missing prices make `usd` unknown, which makes the figure unknown.
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
`total_usd / verified` as the cost per verified completion, which is what the report computes. Entries for `unknown`
runtimes are not exported.

The router ignores an entry with fewer than its minimum attempts, and ignores an incoherent one (the rationale says so),
so thin or corrupt data cannot steer a choice. The router runs in shadow mode only: the history changes a
recommendation, not a live route. To use it, a person saves the JSON, passes the `router_history` object as `history`
in a dry run, reviews the recommendation and decides. Nothing in this repository does that automatically.
