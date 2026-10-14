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
Optional `run_limits` (per-run timeout, steps, effort, context mode, stalled runs to no_progress; flat or
`{ <selector>: { <class>: limits } }`, docs/v2/ROUTING.md "Run limits", D-024) overrides the project and registry limits.
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

Checks (round 5, optional): `checks.timeout_ms` is the time limit of every acceptance check that sets no `timeout_ms`
of its own (read at each evaluation; size it to the real suite: mycodebox's `npm test` takes about 136 s on the live host,
the limit is 600 s). `checks.by_task_class.<class>` is the list of checks intake gives a task of that `task_class`
that names none (else `project-tests` = `test_command`). mycodebox's `docs` class runs `scripts/docs-check.js`
(links, code fences, conflict markers in the Markdown the change touches, against `V2_BASE_SHA`, which the verifier
sets to the task's base), the docs-links test, and `npm test` through `scripts/run-if-changed.js --except '*.md'`
(skipped, exit 0 and logged, when only Markdown changed). A required check that runs out of its time limit has no
result: the task waits (`check_timeout`, `until_ms` null, `verify_only`) with a diagnosis, never a repair run or a
stall; a policy change or an owner resume verifies the same SHA again, and runs without an exit code are rerun
under a new evidence index, never reused.

## 5. Leases — `orchestration/lease-authority.js`

`createLeaseAuthority({ backend, now, randomId })`, backends: `fileBackend({ dir, fs })` (atomic via `O_EXCL` lock file +
rename; persisted monotonically increasing generation per resource) and `fakeBackend({ fail })` for failure injection.
```
acquire(resource, { owner, task_id, ttl_ms, scope, approval_ref, lease_id? }) -> { ok:true, lease } | { ok:false, code:'E_HELD'|'E_UNAVAILABLE'|'E_INVALID' }
adopt({ resource, lease_id, owner, task_id }) -> { ok, lease } | { ok:false, code }   // recovery with the private, write-ahead lease_id (D-015)
renew(lease) -> { ok, lease } ; release(lease) -> { ok }
validate(lease) -> { ok } | { ok:false, code:'E_FENCED'|'E_EXPIRED'|'E_UNAVAILABLE' }   // call immediately before every mutation
acquireAll(resources[], opts)                              // sorted canonical order; all-or-nothing
withLeases(resources[], opts, fn(fence))                   // release in finally with identity check
```
Lease: `{ resource, lease_id, owner, task_id, token (fencing generation), acquired_at, expires_at, scope, approval_ref }`.
Namespaces: `repo:<repo>:integration`, `repo:<repo>:main`, `repo:<repo>:branch:<name>` (non-main target branches,
decision D-008: `<name>` uses `[A-Za-z0-9._/-]`, no `..`, `//`, leading `-`/`/` or trailing `/`),
`environment:<env>:deploy`, `host:<id>:maintenance`, `service:<id>:<service>`, `worktree:<task_id>`. Every resource is
at most 150 characters. Unavailable backend never means free. The existing `leases.js`
(read-only remote registry observer) is an *input* for platform state, not an authority. D-015: a caller-supplied
`lease_id` is persisted before `acquire` (write-ahead) and is granted once per resource; crash recovery uses `adopt()`
with it, never the owner/task_id that `E_HELD` discloses. D-016: one goal-loop controller per store holds
`service:<host_id>:goal-loop` (see docs/v2/LEASES.md).

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
`worktree:<task_id>` lease; branch `v2/task/<task_id>`), `owner(path)`, `status(path) -> { dirty, untracked, head }`,
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
without the server) and are assembled with the goal loop by `orchestration/v2-runtime.js` (see "Implementation notes
(server wiring)"). The UI adds an opt-in **Tasks** view; the session board is unchanged.

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

## Implementation notes (goal loop)

Recorded from `v2/05-goal-loop`; additive to §1, §9 and §10.

1. Checkpoint: the loop's own decision records carry an additive `loop: { k, patch, next? }` field. Loop memory is
   the fold of those patches; a decision with `next` and id `gl-<task>-<k>` (k = transitions so far) is replayed, not
   re-decided, after a crash between the decision and its transition. Events come from `store.events(id)`; a task
   with `store_error` is never stepped.
2. No-progress rule: same failure signature `same_signature` times in a row, or `no_progress_policy.
   iterations_without_progress` (default 6, D-012) iterations without new passing evidence, forces a strategy change
   (replan, different model, harness change). New passing evidence = more required checks pass, or fewer failing tests
   inside them. `strategy_changes_without_progress` changes without progress -> `waiting` (`until_ms: null`,
   diagnosis, next action). Billed identical retries (developer runtime errors, reviewer runs without a usable verdict)
   count the same way; only unbilled waits back off on a timer. A developer run killed by the run timeout (class `timeout`, billed) is an attempt, not a
   provider error: its changes are committed and checked like any run, the next prompt says it timed out, and the check
   failures feed the rule (round 3); quota and unavailability keep their timed backoff. A started developer timeout counts
   as billed and goes through the no-progress rule, so the router's `timeout` fallback (backoff, then a runtime switch) no
   longer applies to developer runs; a different model is tried through the rule's strategy change instead. One classifier for developer and reviewer runs:
   billed = measured spend, an incomplete usage record, or a run that started and failed with unknown usage (unknown
   is not zero); unbilled = refused before work (`rate_limit`, `unavailable`, `auth`) or never started. Every review
   attempt has its own run id (`…-a<n>`), so each one is in the ledger and counts against a cap. A run that started
   but never recorded usage (controller crash) gets an all-null usage record (`source: interrupted…`) on the next
   step and is an unknown ledger entry until then: totals become unknown and a cap stops on it.
3. Approvals: a request carries action keys; a grant covers exactly those keys (an agent's request is keyed by its
   run, so a later identical request is asked again) and `approve()` refuses classes or budget authorizations the
   request did not ask for. Denying an agent-requested action continues the task with "refused" feedback; denying
   any other gate ends it (`failed_unrecoverable`). An approved budget stop authorizes the next run when the stop exists
   only because a cost is unknown (no estimate, or a provider that reports no USD); it never waives a reached cap. The
   developer's first estimate is the router's price-based `cost_est_usd`, kept in the strategy at assignment. A reached
   cap is asked as "raise or cancel"; `approve()` without a higher `budget_policy` is refused (`E_INVALID`).
4. Risk (D-013, D-014): `risk_class` high/critical additionally needs the policy's `security_reviewer` verdict (when
   the policy names that registry entry) and an owner approval bound to the exact head SHA before `accepted`. An owner
   approval of a critical task's routing question (bound to task + base SHA) is passed to the router as
   `floorGrants: ['critical_risk']`; no other router floor is waivable.
5. Delivery (D5): a task asks for delivery with `review_policy.deliver: true` or a `repo:<repo>:integration` entry in
   `resources`. It then goes `evaluating -> integrating` through the injected `integrate(task, { sha, worktree,
   idempotency_key })` hook (optional `integrate.reconcile`), and waits in `integrating` when no hook is wired. A task
   accepted without delivery is "verified in the task worktree, not integrated" and the UI must label it so.
6. Privacy: the template default `privacy_policy: 'project'` maps to the project's `provider_allowlist`; any other
   string reaches the router unchanged and fails closed (no route).
7. Agent action requests: the loop gates `action_request` run events (class derived from argv/text, never from the
   model's label). Only the fake runtime emits them today; the Claude/Codex/MiniMax/OpenCode parsers do not yet map
   CLI permission prompts to `action_request`. Their own permission modes (`acceptEdits`, `workspace-write`,
   `smart`) remain the floor for those runtimes until they do.
8. Worktree lease: renewed at every dispatch and commit through `worktrees.renew(path, { owner })`, which re-acquires
   a lapsed lease nobody took (E_EXPIRED) for the same owner and rewrites the worktree meta (`lease_reacquired`
   decision). A live holder, or one that held the lease in between (E_FENCED), suspends the task until inputs change;
   after the owner resumes it, `renew(…, { acknowledgeFence: true })` re-acquires the lease only if it is free. A lease
   granted just before a crash (before the meta write) is adopted with the write-ahead id persisted before the acquire
   (`pending_lease` in the meta, `.v2-meta/<task_id>.intent.json` for create; D-015).
9. Task branch: `worktrees.status()` also reports `branch` (`HEAD` when detached). Dispatch, commit, evaluation, the
   pre-accept revalidation and the integration handoff require the worktree to be on `v2/task/<task_id>`; otherwise the
   task waits (`off_task_branch`, `until_ms: null`) until the owner restores the branch and resumes.
10. Controller (D-016, D-017, D-018): `step()`/`run()` act only under the controller lease
   `service:<host_id>:goal-loop`; another live instance makes them return `{ transitioned: false, idle: true,
   controller: 'E_HELD' }` with no store access. Every store write and every commit re-validates that lease first
   (fence per §5), so a displaced instance writes nothing even between heartbeats. Takeover (`recover()`, and owner
   actions `cancel`/`approve`/`deny`/`resume`) is liveness-gated: the controller intent file records pid, host and a
   heartbeat time; only an instance whose process is gone on this host (`kill(pid, 0)`, EPERM = alive) or whose
   heartbeat is older than two heartbeat intervals is taken over, through its write-ahead `lease_id`. A live
   controller is never displaced: `E_CONTROLLER_HELD`, and its TTL runs out.
   - The store's implicit open on first access is read-only **for recovery only**: it replays the log and writes no
     recovery events, so reading a store another controller writes cannot reconcile that controller's live run. It is
     not a multi-writer protocol: multi-writer safety rests on the controller lease (D-016).
   - `recover()` is called by the store's owner, the goal-loop controller, under the controller lease: at startup and
     whenever a view shows `recovery_pending` (a torn tail, or an open effect a full recovery would reconcile).
     Other clients (HTTP layer, scripts) treat `E_STORE_FAILED ... needs recover()` as "the controller has not
     reconciled this task yet" and retry through the controller.
   - Cancellation always goes through (D-018): `cancel()` takes the controller lease, runs `recover()` first when the
     task shows `recovery_pending` (it never appends over a torn tail), then persists the cancel.
   - Without a lease authority (`leases` not injected) there is no controller lease: `holdController` neither fences
     nor reconciles, so a store opened read-only is never reconciled automatically (liveness gap); deployments always
     inject the lease authority.

## Implementation notes (delivery bridge)

Recorded from `v2/11-e2e` (`orchestration/delivery.js`); additive to §10 and §11.

1. `createDelivery({ store, queue, controller: ({ store, approvals }) => controller, git, ci, repo, target, retryMs })`
   returns `{ integrate, controllerStore, approvals, controller }`; `integrate(task, { sha, worktree, idempotency_key,
   store })` and `integrate.reconcile(task, { effect_id, idempotency_key, store })` are the goal loop's delivery hook
   (implementation note 5 of the goal loop). The goal loop passes its fenced store handle as `store` in both calls.
2. One writer (D-016/D-017). The controller is built over `controllerStore`: every non-transition write goes to the
   loop's fenced handle of the current hook call (so it re-validates the loop's controller lease) and is refused with
   `E_NO_WRITER` outside a call; `transition()` is recorded as a proposal and never applied. The bridge maps the
   controller's durable queue item state to the loop's next state (`merged` -> `release_verifying` with
   `release_verified` when the remote target contains the integration SHA and remote CI is green on it;
   `awaiting_approval` -> `awaiting_approval`; `returned` -> `repair` with feedback; `unknown` -> unknown outcome;
   `rejected`/`cancelled` -> owner; anything parked -> `waiting` with a retry), and the loop applies it with its own
   decision. Every task transition is therefore written by the goal loop.
3. Handoff facts come from the store and git: developer = the actor recorded by `setHead` for the SHA
   (`store.independence`), diff scope = `git diff --name-only base..sha` in the task worktree, source = the task
   branch in `task.repository` (which the controller config must list in `source_remotes`). While a queue item is not
   final, resubmitting is idempotent (`task:sha:target`). The integration queue re-queues a key whose item is FINAL,
   so the bridge looks the key up first and never hands off a SHA whose item is `merged` (no controller run); should a
   merged SHA reach the controller anyway (queue reset), the controller finds it already in the target (F8) and stops
   before any push. A `merged` item maps to `release_verifying` only when the remote target contains the integration
   SHA (`detail.sha`, or `detail.target_sha` for F8) and remote CI is green on it; unknown containment or CI, or an
   unknown SHA, is `waiting` with a retry, and a contradiction (not contained, CI red) goes to the owner.
   Batch runs: one controller run can finish other tasks' items. Their proposed transitions are dropped (this call
   returns only the calling task's proposals); each of those tasks rebuilds its state in its own hook call from its
   queue item and its own task log. An approval question is bound to the block at hand: the controller request
   written during this call (or carrying this run's integration id); a block that writes no request (protected path,
   path not allowlisted, target policy) carries no key an owner grant could cover, so the goal loop moves the task to
   `waiting` (`reason: policy_block`, diagnosis naming the queue item's reason, next action) instead of a keyless
   `awaiting_approval`; an owner resume or a policy change revisits it.
4. Approvals: each controller request (candidate push, merge) is returned with the key
   `integration:<action>:<repo>:<target>:<sha>`; the loop's integration approval request carries it (`keys`), the
   owner grant copies it, and the controller's approval check accepts only a grant whose keys contain the exact key
   for the request at hand. A class-only grant, or one for another SHA, action, target or repo, never counts.
5. `integrate.reconcile` only reads: for a controller effect key it asks the remote (`controller.effectState(key)`,
   `confirmed`/`failed`/unknown); for the loop's own hook effect it answers `applied` once every remote effect the call
   may have caused can be read. The loop records the phases itself.
6. Dashboard: the integration approval request also carries the SHA it is about (`sha`, the integration SHA, not the
   developer head), so `orchestration/http.js` shows that SHA, demands it on approve (`E_SHA_MISMATCH` otherwise) and
   records grants with the request's `keys` and `request_kind`, the same shape as `goal-loop approve()`.

## Implementation notes (server wiring)

Recorded from `v2/r3-wire` (OWNER_DECISIONS §11.1); additive. Env keys: [REFERENCE](../REFERENCE.md) (`GHOSTY_V2*`).

1. `server.js` imports `orchestration/v2-runtime.js` only when `GHOSTY_V2=1` (unset: nothing imported, constructed or
   scheduled). `createV2Runtime({ stateDir, env, repoRoot, log })` returns `{ http: { handle }, start(), stop({ timeoutMs }),
   status(), store, config }`. server.js forwards `/api/v2/*` to `http.handle`, calls `start()` once, and awaits
   `stop({ timeoutMs: 5000 })` on SIGINT/SIGTERM before closing.
2. One process, one store handle (D-016/D-017): the same `createTaskStore` instance backs the HTTP routes, intake and
   the goal loop. Every write the runtime makes outside a step (task creation, ops requests) goes through the loop's new
   `ownerWrite(fn)`: under the controller lease like approve/deny/cancel, through the fenced store handle, so a
   displaced instance gets 409 `E_CONTROLLER_HELD` and writes nothing. `start()` takes the controller lease with the loop's new `acquire({ watch: false })` (the lease and a
   heartbeat are then held between steps too, so an owner action never drops it), runs `recover()` under it, probes
   the adapters, then starts the scheduler. `stop()` stops scheduling, waits for in-flight steps for the remaining
   time, calls the loop's new `release()` (lease released at once; an in-flight step's next write fails the fence, so
   nothing is written behind the next controller's back) and cancels the runs still going (GL06 reconciles them).
   The whole `stop()` is raced against `timeoutMs + 1.5 s`, so SIGTERM exits in bounded time.
3. Another live controller (`E_HELD`, liveness as in goal-loop note 10, `watch: false`): this process runs no loop and
   every write route (create, cancel, approve, deny, ops requests) answers 503 `E_NO_CONTROLLER` without writing; reads
   work. A lease backend that cannot answer (`E_UNAVAILABLE`, e.g. a lock file left by a killed process until it is
   stale and the dead holder's TTL ran out) is retried every 15 s. A dead controller (pid gone on this host) is taken
   over through its write-ahead lease id.
4. Scheduler: at most `GHOSTY_V2_CONCURRENCY` (default 1) steps in flight, round robin (one step, then the task goes to
   the back). Woken by create, by an owner answer, at start, and by a timer for the earliest `until_ms` of a timed wait;
   a slow safety tick (60 s) rescans open tasks (an idle step writes nothing). Informational tasks are never stepped.
5. Repositories (D-021): `GHOSTY_V2_REPOS` lists absolute repository paths; creation names one of them (realpath
   match) or is refused (400 `E_INTAKE_REPO`); the same list is the worktree allowlist; the loop re-reads the repo's
   `.ai/project.json` before every run (missing/invalid -> T01 clarification). `GHOSTY_V2_WORK_ROOT` (required for the
   loop) holds `wt/`, `review/`, `vtmp/` and `artifacts/` and must not overlap the checkout or the state dir.
6. Runtimes: the registry (`orchestration/models.json` or `GHOSTY_V2_REGISTRY`) with the claude, codex, minimax and
   opencode adapters (launch modes unchanged, no bypass flags), probed by the loop at every route (unavailable = not
   routable). Model ids are passed to claude, and to opencode for `provider/model` ids; codex and minimax run their
   CLI default model. A claude run gets `--max-budget-usd min(GHOSTY_V2_CLAUDE_RUN_USD, remaining max_usd)`.
   `GHOSTY_V2_TEST_FAKE_ADAPTER` (tests only) makes the scripted fake the only runtime, with two fake entries so the
   reviewer is a different model.
7. Developer pins: the loop passes `role` to the router; the runtime's route wrapper turns a task's `preferred_models`
   into exclusions only (developer routes see only the pinned entries; reviewer routes never see them).
8. Delivery hook `orchestration/v2-integrate.js` (opt-in per task, `review_policy.deliver`): may push only the task's own
   `v2/task/<task_id>` branch at the verified SHA to `GHOSTY_V2_PUSH_REMOTE` (compare-and-swap, recorded as effect
   `push:task-branch:<task>:<sha>`, read back from the remote; an unknown outcome is reconciled from the remote, never
   re-pushed blindly). The merge into `main` is an `integration` request with key
   `integration:merge:<project_id>:main:<sha>` (`merge_protected` when `main` is protected), bound to the SHA. This
   server has no integration lane (no remote CI or deploy-state source for `integration-controller.js`), so an approved
   merge is not executed: the task waits (`reason: integration`, retry 10 min) until `main` contains the SHA, then
   `release_verifying` -> `accepted`. Nothing merges, deploys or force-pushes a branch the task does not own.
9. System operations: `GET /api/v2/ops/telemetry` and `/incidents` are read-only; `POST /api/v2/ops/requests` goes
   through System Operations' request-only `requester` (incident `mitigation_requested`); no executor is configured
   and the controller object is not kept. The loop gets the same `requester` for infrastructure incidents.

