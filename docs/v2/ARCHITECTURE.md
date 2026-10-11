# V2 orchestration contract (frozen interfaces)

Status: **contract for implementation**, not a description of shipped behavior. Workers implement against these
signatures; a change needs a coordinator decision recorded in `V2_PROGRESS.md`. Precedence: `AGENTS.md`,
`docs/CONTRACT.md`, `docs/tasks/v2/OWNER_DECISIONS.md`, then this file.

## Ground rules for every module

- Location `orchestration/`, Node 20+ ES modules, built-ins only (`ws` stays the only runtime dependency).
- Pure where possible; every side effect is injected (`fs`, `now`, `spawn`, `fetch`, `git`, `randomId`). Defaults may
  bind real implementations but tests always inject fakes, temporary dirs, `tmux -L <name>` sockets and port 0.
- Never import `server.js`. Modules must be importable without starting timers, listeners or polling.
- Unknown is a value: `null`/`'unknown'`, never `0`, `[]` or `true` as a stand-in for "could not observe".
- Errors that callers must branch on carry `err.code` (string) from the lists below. Illegal state is a thrown
  `E_ILLEGAL_TRANSITION`, never silently corrected.
- Persistence: append-only JSONL plus atomic snapshots (write temp, `fsync`, `rename`, `fsync` dir). Persist **before**
  acknowledging. Recovery tolerates a torn last line (drop it, record `recovered_torn_tail`).
- Machine-readable traces for E2E go under the test's temp dir; synthetic data only.

## 1. Task contract — `orchestration/task-contract.js`

`SCHEMA_VERSION = 1`. Canonical states (OWNER_DECISIONS §5):
`created, clarified, planned, ready, executing, evaluating, repair, replan, waiting, awaiting_approval, integrating,
release_verifying, accepted, failed_unrecoverable, cancelled, unknown_external_effect`.
Terminal: `accepted, failed_unrecoverable, cancelled`. `cancelled` is reachable from every non-terminal state.

Allowed transitions (anything else throws `E_ILLEGAL_TRANSITION`):

| from | to |
|---|---|
| created | clarified, awaiting_approval, waiting |
| clarified | planned, awaiting_approval, waiting |
| planned | ready, replan, awaiting_approval, waiting |
| ready | executing, waiting, awaiting_approval |
| executing | evaluating, repair, replan, waiting, awaiting_approval, unknown_external_effect, failed_unrecoverable |
| evaluating | accepted, repair, replan, waiting, awaiting_approval, integrating, failed_unrecoverable |
| repair | executing, replan, waiting, awaiting_approval |
| replan | planned, waiting, awaiting_approval, failed_unrecoverable |
| waiting | ready, clarified, planned, repair, replan, awaiting_approval, integrating (D-007), failed_unrecoverable |
| awaiting_approval | ready, clarified, planned, repair, integrating, waiting, failed_unrecoverable |
| integrating | release_verifying, repair, waiting, awaiting_approval, unknown_external_effect |
| release_verifying | accepted, repair, waiting, awaiting_approval |
| unknown_external_effect | executing, integrating, repair, waiting, awaiting_approval, failed_unrecoverable |

`accepted` additionally requires (checked by the store, not just the table): every required `acceptance_check` has a
passing evidence record whose `sha` equals the task's current `head_sha`, and a verifier verdict `approve` from an
evaluator whose `actor` differs from every developer actor on that SHA. Otherwise `E_ACCEPTANCE_UNMET`.

Exports:
```
STATES, TERMINAL, TRANSITIONS, SCHEMA_VERSION
validateTask(spec) -> { ok, errors: [{ path, message }] }
normalizeTask(spec, { now, randomId }) -> task          // fills documented defaults, never caps/deadlines
canTransition(from, to) -> boolean
assertTransition(from, to)                               // throws E_ILLEGAL_TRANSITION
outcomeOf(state) -> 'done'|'waiting'|'needs_owner'|'unrecoverable'|'cancelled'|'not_yet_done'
narrowsParent(parent, child) -> { ok, violations[] }     // child may only narrow constraints
failureSignature({ test, errorClass }) -> string         // normalized, used by the no-progress rule
```
Task fields: union in OWNER_DECISIONS §6. Required: `task_id, project_id, goal, scope, prohibited_actions[],
definition_of_done[], acceptance_checks[] ({ id, command (argv array), expect: { exit: 0 } , evidence_type, required }),
risk_class ('low'|'medium'|'high'|'critical'), runtime_capabilities[], privacy_policy, resources[], dependencies[],
base_sha, approval_policy, created_by ({ kind: 'ui'|'api'|'schedule'|'agent', id }), status`.
Defaults: `budget_policy = { mode: 'track' }`, `priority = 'balanced'`, `retry_strategy = 'evidence'`,
`no_progress_policy = { same_signature: 3, strategy_changes_without_progress: 3 }`, allowlists = project policy.
`approval_policy.requires` lists action classes that always need approval: at least
`['merge_protected','push_shared','deploy','credentials','destructive','host_maintenance','money','customer']`; a task can
add classes but never remove these.

## 2. Events — `orchestration/events.js`

Envelope: `{ event_id, task_id, run_id, attempt_id, seq, schema_version, timestamp, runtime, provider, model, kind,
payload, causation_id }`. Kinds (spec §3 plus): `task.created, task.transitioned, task.started, tool.failed,
model.rate_limited, budget.threshold, verification.failed, verification.passed, task.blocked, approval.requested,
approval.granted, approval.denied, action.attempted, action.confirmed, action.unknown, task.completed, task.cancelled,
decision.recorded, evidence.recorded, usage.recorded`. Exports `makeEvent(fields, { now, randomId })`,
`validateEvent(e)`, `EVENT_KINDS`.

## 3. Store — `orchestration/store.js`

`createTaskStore({ dir, fs, now, randomId })`:
```
init() / recover() -> { tasks, torn, pendingEffects }      // replays logs; effects 'attempted' w/o 'confirmed' -> unknown_external_effect
createTask(spec, { idempotencyKey }) -> task               // same key -> same task, no second event
get(id), list({ state, project_id, parent_task_id })
append(task_id, event) -> { applied: boolean }             // dedup by event_id; seq strictly increasing per task
transition(task_id, to, { reason, actor, causation_id, event_id })
recordEvidence(task_id, { check_id, sha, command, exit, duration_ms, artifact, actor, ts })
recordVerdict(task_id, { sha, actor, verdict: 'approve'|'reject', findings[] })
recordDecision(task_id, decision)                          // schema in §9
recordUsage(task_id, { runtime, provider, model, input_tokens, output_tokens, usd, unknown: [] })
recordEffect(task_id, { effect_id, idempotency_key, kind, phase: 'attempted'|'confirmed'|'possibly_applied'|'failed' })
setHead(task_id, sha)                                      // new SHA invalidates earlier evidence for acceptance
snapshotPolicy(task_id, policy)                            // immutable per run; refreshed at next run
```
Layout: `<dir>/tasks/<task_id>/events.jsonl`, `<dir>/tasks/<task_id>/snapshot.json`, `<dir>/index.json`. The V2 dir
defaults to `$GHOSTY_STATE_DIR/v2` and never touches existing state files.

## 4. Project policy — `orchestration/policy.js`

Policy file `.ai/project.json` (JSON, not YAML: no new dependency — decision D-004). Read-only to agents; re-read at
the start of every run; snapshot stored on the task. `loadPolicy(repoDir, { fs }) -> { ok, policy } |
{ ok:false, code:'E_POLICY_MISSING'|'E_POLICY_INVALID', errors }`. Missing/invalid -> task goes to
`awaiting_approval` with a clarification request (T01). `checkAction(policy, task, action) -> { allow, needs_approval,
reason }`: forbidden topics (reuse the manager's forbidden-topic matcher) and `approval_policy` always win over model
output and task text (T02).

## 5. Leases — `orchestration/lease-authority.js`

`createLeaseAuthority({ backend, now, randomId })`, backends: `fileBackend({ dir, fs })` (atomic via `O_EXCL` lock file +
rename; persisted monotonically increasing generation per resource) and `fakeBackend({ fail })` for failure injection.
```
acquire(resource, { owner, task_id, ttl_ms, scope, approval_ref }) -> { ok:true, lease } | { ok:false, code:'E_HELD'|'E_UNAVAILABLE'|'E_INVALID' }
renew(lease) -> { ok, lease } ; release(lease) -> { ok }
validate(lease) -> { ok } | { ok:false, code:'E_FENCED'|'E_EXPIRED'|'E_UNAVAILABLE' }   // call immediately before every mutation
acquireAll(resources[], opts)                              // sorted canonical order; all-or-nothing
withLeases(resources[], opts, fn(fence))                   // release in finally with identity check
```
Lease: `{ resource, lease_id, owner, task_id, token (fencing generation), acquired_at, expires_at, scope, approval_ref }`.
Namespaces: `repo:<repo>:integration`, `repo:<repo>:main`, `environment:<env>:deploy`, `host:<id>:maintenance`,
`service:<id>:<service>`, `worktree:<task_id>`. Unavailable backend never means free. The existing `leases.js`
(read-only remote registry observer) is an *input* for platform state, not an authority.

## 6. Runtime adapters — `orchestration/adapters/<id>.js`

Each exports `createAdapter({ spawn, env, now, bin })` returning:
```
id, provider_ids[]
probeCapabilities() -> { available: boolean|'unknown', version, models[], efforts[], features: { resume, cancel, json_output, native_subagents, vision } }
start({ task_id, run_id, cwd, prompt, model, effort, timeout_ms, env }) -> run   // argv arrays only, validated cwd
observe(run) -> AsyncIterable<normalized event>  ; send(run, text) ; cancel(run) -> { acknowledged }
collectUsage(run) -> { input_tokens, output_tokens, usd } with null for unknown
normalizeError(err | { exit, stderr }) -> { class: 'rate_limit'|'timeout'|'context_overflow'|'auth'|'unavailable'|'crash'|'permission'|'unknown', retryable, retry_after_ms }
resume(run_ref) -> run | throws E_UNSUPPORTED
```
Unsupported operations throw `E_UNSUPPORTED`, never no-op. Adapters never add permission-bypass flags. Ids: `claude`,
`codex`, `opencode`, `minimax`, plus `fake` (scriptable test runtime used by every E2E).

## 7. Worktrees — `orchestration/worktrees.js`

`createWorktrees({ git, fs, root, repoAllowlist, leases })`: `create({ repo, task_id, base_sha, branch })` (takes
`worktree:<task_id>` lease; branch `v2task/<task_id>`), `owner(path)`, `status(path) -> { dirty, untracked, head }`,
`remove(path, { retain })` refuses dirty/untracked/unmerged or foreign-owned trees. Paths must resolve inside `root`.

## 8. Routing, registry, budget — `orchestration/{model-registry,router,budget}.js`

Registry entries: `{ runtime, provider, model, capabilities[], efforts[], context_tokens, price: { input, output } |
null, price_as_of, source }`. Price `null` = unknown (PLACEHOLDER rows are unknown). Router pipeline: hard floors
(policy, forbidden topic, privacy/provider allowlist, risk/approval, capabilities incl. effort) -> classify ->
rank feasible by verified-completion rate, cost per verified completion, latency, reliability (weights configurable;
no history -> conservative documented defaults) -> `{ choice, candidates[], rejected[{ id, reason }], rationale,
confidence, fallback[] }`. Shadow mode by default; nothing here changes the existing manager/router behavior.
Budget: `{ mode: 'track' }` default; `max_usd`/tokens/duration are hard stops -> `awaiting_approval`; unknown spend
stays unknown and is reported as such (cannot satisfy a cap check -> `awaiting_approval` when a cap exists).

## 9. Decision journal record

`{ decision_id, task_id, ts, kind, question, alternatives: [{ option, pros, cons }], chosen, evidence[], expected_effect,
rationale, actor: { role, runtime, model }, confidence: number|null, policy_ref, reversible: boolean, rollback }`.
Every automatic choice in the goal loop, router and controllers writes one.

## 10. Goal loop — `orchestration/goal-loop.js`

Deterministic controller over the store; LLM roles are adapters it calls. One `step(task_id)` performs at most one
transition and persists it. No attempt counter: the no-progress rule (OWNER_DECISIONS §4) — same failure signature 3x in a
row forces a strategy change (`replan`, harness change, or different model, recorded as a decision); 3 strategy changes
without new passing evidence -> `waiting` (`reason: no_progress`, diagnosis, next suggested action). Provider
`rate_limit` -> `waiting` with backoff; `unavailable` evaluator or missing artifacts -> `waiting`, never `accepted`.
Cancellation is checked before every side effect; writes after cancel are rejected by the store.

## 11. Integration and system operations

`orchestration/integration-controller.js` + `integration-queue.js` + `ci-gates.js`: handoff validation, lease
`repo:<repo>:integration`, fresh integration worktree, sequential merge, full gate on the exact SHA, remote CI status via
injected `ci.status(sha)` (missing/pending/red -> no merge), push/merge only with `approval_ref` valid for that SHA and a
fresh `validate(lease)`; uncertain push -> query remote SHA first. `orchestration/incidents.js` + `system-ops.js`: incident
contract (spec §12.4), dedup key, telemetry freshness (stale -> `health.unknown`), admission pause, allowlisted
reversible actions only, everything else `incident.approval_required`. Developers can only *request* operations.

## 12. API and UI

Read-mostly HTTP routes added to `server.js` behind the existing Origin check: `GET /api/v2/tasks`,
`GET /api/v2/tasks/:id` (state, outcome, goal, criteria, next action, decisions, evidence, usage, leases, incidents),
`POST /api/v2/tasks` (create from UI; same contract as API/schedule/agent), `POST /api/v2/tasks/:id/cancel`,
`POST /api/v2/tasks/:id/approve` (owner only, records actor). Route handlers live in `orchestration/http.js` (testable
without the server). The UI adds an opt-in **Tasks** view; the session board is unchanged.

## Implementation notes (task core)

Recorded from `v2/02-task-core` and accepted by the task-core verifier. All are additive to §1–§4 and §9.

1. Extra event kinds: `action.failed`, `task.head_changed`, `policy.snapshot`, `recovery.torn_tail`.
2. Extra optional arguments: `setHead(id, sha, { actor, event_id })`, `snapshotPolicy(id, policy, { run_id })`,
   `{ event_id }` on the `record*` methods. Pass a stable `event_id` on any write that may be retried.
3. Actor identity is the actor's `id` only (a string actor is its own id), trimmed, NFKC-normalized and
   case-folded. `setHead`'s `actor` must be the developer who produced the SHA. Without an id an actor records no
   developer and its approve never counts (its reject still blocks), so acceptance fails closed. `head_sha` starts
   `null`, not `base_sha`.
4. `accepted` also requires every effect to be reconciled, and leaving `unknown_external_effect` (except to cancel)
   requires the same.
5. Terminal tasks reject writes: `E_CANCELLED` after cancel, `E_TERMINAL` after `accepted`/`failed_unrecoverable`.
   The only exception is reconciling an effect already in flight (`confirmed`/`possibly_applied`/`failed`).
   A child cannot be created under a terminal parent.
6. `recover()` returns `{ tasks: [task_id], torn, corrupt, pendingEffects }`. A corrupt line before the tail stops
   replay; the task reads with `store_error` and outcome `unknown` and rejects writes with `E_STORE_FAILED`.
7. Task schema: unknown top-level fields are rejected; at least one required acceptance check; top-level `max_*`
   caps fold into `budget_policy` and a conflicting duplicate is rejected. Decision `evidence` must be non-empty.
   `seq` is dense (an explicit seq must be the next one). Usage totals are `null` when no record exists.
8. Recovery moves a task to `unknown_external_effect` only where the table allows it (`executing`, `integrating`);
   otherwise the effect is reported with `moved: false` and still blocks acceptance.
9. Policy: `loadPolicy` restores the mandatory approval classes a file omits (`validateTask` refuses the same
   omission on a task). Project allowlists are a floor: a task allowlist can only narrow them. `denied_args`,
   `protected_paths` and `protected_branches` are optional policy keys. The executor derives `action.class` from
   the operation it performs, never from model output.
