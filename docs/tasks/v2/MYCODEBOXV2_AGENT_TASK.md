# mycodebox V2 — Agent-Executable Refactor Task

**Status:** proposed implementation plan; NOT authorization to deploy, merge, push, install agents on a live machine, or change production settings.  
**Repository:** `angelstreet/mycodebox` (`main`, observed 2026-10-09)  
**Audience:** implementation agent acting as coordinator, with delegated subagents in isolated Git worktrees.  
**Goal:** extend the existing self-hosted multi-agent **session dashboard** into a safe, provider-independent **task orchestration control plane**, preserving working features and the existing security contract.

## 0. Non-negotiable instructions for the implementing agent

Before editing: read `AGENTS.md`, `docs/CONTRACT.md`, `docs/MAP.md`, `README.md`, `docs/INSTALL.md`, `HANDOVER.md`, `TODO.md` and the relevant modules/tests. Run `git status --short` and record baseline commit SHA. Never overwrite or stage other people's files. Treat this document as instructions to plan and implement only on an explicitly authorized feature branch, not authorization to deploy or merge.

Use a fresh **Git worktree per independent task** and a named implementation agent per worktree. No two agents write into the same worktree. Merge through review/integration branch, never by concurrently editing main. Each phase requires failing tests first where feasible, implementation, green focused tests, full suite, evidence logs, and independent checker review. Maintain a durable task ledger with id, parent, baseline SHA, worktree path, owner agent, phase, input contract, expected outputs, verification, risk, actual results, and merge SHA. Make no claims that integration or mobile tests passed unless they actually ran. Do not expose the repo on the internet or use real credentials in tests.

### Explicit existing product invariants
- Preserve the private Tailscale access boundary. Current source `HOST=0.0.0.0` is **not** safe; fix it in an independently reviewed security phase with regression tests. Do not use Funnel/public tunnels.
- Never bypass CLI permission/sandbox policy; source UI Claude/Codex launch defaults are documented as unsafe. Audit **create, resume, park, wake, manager, scripts**, not just the launch UI.
- Never auto-answer about deployments, merges, deletions, credentials, money, customers or other forbidden topics; preserve countdown cancellation, actor attribution, manual approvals and hard floors.
- Never infer that an unreachable restart API means no deploy is active. Fail closed, and do not restart during deployment.
- Existing `$GHOSTY_STATE_DIR`, reporter API (loopback + token), tmux targeting, origin checks, WebSocket behavior, deployment recovery, saved state, and UI compatibility are migration invariants.
- `server.js` import starts listeners/polling: do not import it into unit tests. Use fake adapters and temporary state. `GHOSTY_STATE_DIR="$(mktemp -d)" npm test` is the baseline suite. Reporter plugin has its own separate tests.
- No real logs, host names, IPs, tailscale names, customer data, auth tokens or secrets in fixtures, commits, issues, screenshots or telemetry.

## 1. Observed architecture and code review

The repo is **not** an empty project. `README.md` describes a phone-first session dashboard for Claude Code, Codex, MiniMax and tmux; `server.js` exposes HTTP/WebSocket session controls; `public/app.js` powers the UI; `manager.js` has stoppage classification, guarded optional auto-responses, event and outcome logs, budgets and Jev decision integration; `router-shadow.js` evaluates stop case / owner needed / wake model without live effects; `router.js` explicitly says the generalized Jev routing points remain SHADOW ONLY; `scorecard.js` and `usage/` provide usage/outcome signals; `claude-plugin/ghosty-reporter` reports structured Claude turns; `deploy-runner.js`, leases and safe restart are sensitive operational areas.

**Gap (based on code inspection, to recheck in phase 0):** route-selection decisions do not yet form a general capability-aware task execution engine. Existing routing is largely focused on manager decisions/stop classification, and native provider execution is still driven by tmux/session commands. Worktree lifecycle, uniform model registry, task DAGs, independent verification gates, budgeted retries, and provider-agnostic resume/handoff have not been established as a single end-to-end contract. Existing safeguards and evaluation assets should be reused, not rewritten or turned live prematurely.

**Read these modules in depth before specifying any API:** `server.js`, `manager.js`, `router.js`, `router-shadow.js`, `stall.js`, `triage.js`, `decisions.js`, `scorecard.js`, `turn-meter.js`, `quota.js`, `usage/`, `reporter.js`, `handoffs.js`, `leases.js`, `deploy-runner.js`, `scripts/safe-restart.sh`, `scripts/router-dryrun.js`, `scripts/router-replay-stop.js`, `public/app.js`, `public/ask-model.js`. Use `rg` to locate actual launch/resume commands and tests; avoid assuming integration is absent merely because it is distributed.

## 2. Product definition, users and non-goals

**V2 goal:** From phone or desktop, define a bounded engineering task and project, choose cost/quality/speed preference, route to a compatible runtime+model, execute in an isolated worktree, collect deterministic and independent test evidence, recover from crashes, request owner approval for sensitive steps, and present progress and actual cost in the existing dashboard.

**Primary use cases**
1. Quick repo explanation or doc fix using cheap capable model, fast local verification, no unnecessary multi-agent swarm.
2. Feature implementation with planning, one developer worktree, tests, independent checker, review and owner-controlled integration.
3. Complex parallel refactor decomposed into disjoint worktrees with file ownership, merge conflict gates, CI and end-to-end smoke tests.
4. Failed tests trigger bounded, evidence-driven retry/escalation (not blind provider rotation).
5. Quota/rate-limit/provider outage reroutes only to a compatible allowed model, preserving safe handoff without exposing secrets.
6. Stalled task resumes from persisted verified checkpoint after service restart; no duplicate irreversible actions.
7. Security-sensitive code invokes specialist review and human approval; auto-send and deploy remain disabled by default.
8. Scheduled repository maintenance keeps read-only scopes, bookmark per source, durable state, idempotent destination effects, and capped budget.
9. Operator uses phone to approve/cancel only authorized actions, audit routing reason, model, effort, tokens, latency and verification evidence.

**Non-goals in initial V2:** replacing the tmux dashboard; requiring OpenCode; silently changing install topology; public SaaS exposure; always-on multi-agent teams; autonomous deployment/merge; proprietary model-specific reasoning transfer; converting everything to a framework; claiming that models have identical effort semantics.

## 3. Architecture contract

```
User / Project Task
      |
Task service: policy + queue + task ledger + hard permissions
      |
Router: classify -> filter capabilities -> estimate -> score -> choose
      |
Runtime adapters: Claude Code | Codex CLI | OpenCode | (MiniMax native if available)
      |
Isolated worktree + declared tools, credentials, budgets, working context
      |
Sensors: deterministic tests + independent verifier + risk gates
      |
Accept | Retry (bounded) | Escalate | Request approval | Stop
      |
Durable results, callbacks and UI status
```

**Important:** runtime != provider != model. OpenCode is an optional common execution adapter, not the orchestration database or mandatory dependency. Native Claude Code and Codex must remain available when required for their capabilities. A MiniMax model may run through OpenCode or a validated native CLI adapter; do not assume every CLI shares the same programmatic API. Keep `AGENTS.md` as a common project rules interface while maintaining native `CLAUDE.md`, `.claude/`, `.codex/`, `.opencode/` adapters only as required. Detect instruction precedence; keep one canonical version of project policy.

### Proposed modules (names adaptable after inspecting code)
- `orchestration/task-contract.js`: schema validation, states, completion definition, risk and idempotency.
- `orchestration/model-registry.js`: provider/model IDs, capabilities, supported effort, context, cost and freshness metadata.
- `orchestration/router.js`: deterministic floors, candidate filter, selected runtime+effort, explanations, confidence, fallback.
- `orchestration/adapters/{claude,codex,opencode,minimax}.js`: normalized start, poll, cancel, output, errors, usage, resume support.
- `orchestration/worktrees.js`: create, ownership, branch naming, cleanup with safe checks.
- `orchestration/events.js`: versioned callback envelopes and at-least-once event deduplication.
- `orchestration/store.js`: durable task/event state with atomic persistence and crash recovery.
- `orchestration/verifier.js`: deterministic acceptance tests and independent checker reports.
- `orchestration/budget.js`: forecast, reserve, enforce, reconcile and cap costs/turns.
- `orchestration/roles.js`: logical manager/planner/developer/tester/security profiles, not fixed provider identities.

Prefer Node 20 ES modules with built-ins, DI for filesystem/process/network, and zero additional runtime deps unless a clear value and security assessment are documented. Do not move existing `router.js` into production until its semantics, fixtures, safety floors and ownership are understood.

### Standard task schema (versioned)
`task_id`, `project_id`, `repository`, `base_sha`, `goal`, `scope`, `excluded_paths`, `acceptance_checks[]`, `risk_class`, `required_capabilities[]`, `privacy_class`, `runtime_allowlist[]`, `model_allowlist[]`, `priority` (cost/balanced/quality/speed), `max_usd`, `max_input_tokens`, `max_output_tokens`, `max_duration_ms`, `retry_strategy` (not a fixed correctness-attempt cap), `no_progress_policy`, `approval_requirements[]`, `worktree_id`, `parent_task_id`, `dependencies[]`, `handoff_refs[]`, `status`, `created_at`, `updated_at`.

Statuses should be explicit: `queued`, `planning`, `awaiting_approval`, `running`, `verifying`, `blocked`, `retryable_failure`, `failed`, `completed`, `cancelled`, `unknown_external_effect`. Illegal transitions must fail loudly, not silently correct state.

### Event/callback contract
Event envelope: `event_id`, `task_id`, `run_id`, `attempt_id`, `seq`, `schema_version`, `timestamp`, `runtime`, `provider`, `model`, `kind`, `payload`, `causation_id`. Events: `task.created`, `task.started`, `tool.failed`, `model.rate_limited`, `budget.threshold`, `verification.failed`, `verification.passed`, `task.blocked`, `approval.requested`, `action.attempted`, `action.confirmed`, `task.completed`, `task.cancelled`. Validate, persist, and deduplicate before side-effects; replay must be idempotent. Reconcile unknown status externally before retrying an operation that could have succeeded.

### Routing rules
1. Enforce hard floors first: permissions, forbidden topic, privacy/provider allowlist, risk and human approvals, working directory, context/input/tool/vision capabilities.
2. Classify work: research, coding, debugging, UI, test, security, operations, docs. Complexity score covers file scope, dependencies, ambiguity and failure impact; classify `unknown` as needing more discovery, not automatically high confidence.
3. Provider IDs and supported effort values must be discovered/validated, not assumed interchangeable. Keep per-runtime translation and reject unsupported effort.
4. Rank only feasible candidates by historical quality/success rate, cost per **verified completion**, expected latency, and reliability with configurable weights. No meaningful history -> explicit conservative defaults; preserve rationale.
5. Budget checks occur before starting and between steps; missing usage stays `unknown`, not zero. Include verification and retries in spending.
6. Fallback by error taxonomy: transient 429 -> backoff or compatible provider; context overflow -> compaction; failing tests -> bounded fix; repeated identical failure -> change plan/escalate; permissions/secrets/deploy -> stop and ask owner.
7. Shadow evaluation first, then owner opt-in and feature-flagged pilot; never flip existing `routerShadow` to live accidentally.

## 4. Agent roles and policies

**Shared service manager:** a trusted deterministic coordinator with an optional cheap classifier. Not an unrestricted LLM shell. Owns task records, budgets, approvals, assignment, cancellations and review state. Each project defines constraints, not a permanently running manager instance.

**Planner:** optional; triggered for complex/multi-file/high-risk work. Produces architecture, task graph, file ownership, API contracts, risks and acceptance criteria. No deployments or mutation until approved where required.

**Developer:** scoped task in unique worktree; minimum capabilities, no production secrets, no unrestricted deploy/merge; creates tests and implementation; submits structured handoff with commit SHA and evidence.

**Tester / independent verifier:** separate agent/process (ideally another model/runtime when warranted), read-only to implementation branch initially; invokes deterministic test runner and inspects diff against contract; cannot declare success if checks skipped. High-risk tasks additionally require security reviewer and explicit owner review.

**Don't always use multiple agents:** docs/small local fixes -> one developer + deterministic tests; medium -> developer + independent verifier; complex -> planner + developers in separate worktrees + verifier; security/deploy -> mandatory human gate. Separate logical role from model identity. Reuse shared role templates, with project-specific instructions and test commands.

### Proposed project policy layout
```
AGENTS.md                       # shared human-reviewed constraints
CLAUDE.md                       # Claude-specific compatibility only
.ai/project.yaml                # task policies, execution allowlist, risk, budget
.ai/roles/{planner,developer,tester,security}.md
.ai/skills/<workflow>/SKILL.md  # canonical workflow guidance
.ai/evals/                      # synthetic representative tasks
.claude/                        # native Claude adapter pointers/config
.codex/                         # native Codex settings where supported
.opencode/                      # OpenCode adapter-specific config
```
All `.ai/` names are V2 conventions, not established platform paths. No secrets committed. Reuse/sync native skills only after verifying actual discovery paths and precedence for installed CLI versions.

## 5. Lessons from Anthropic: Building effective agent automations (2026-10-08)

Source: https://claude.dev/blog/building-effective-agent-automations/

The article demonstrates **one** configured scheduled agent, not a mandatory manager/developer/tester swarm. It separates: sources, destination, agent configuration, schedule, persistent memory and guardrails. Apply these operational requirements to mycodebox:
- Maintain per-source/bookmark checkpoints rather than `last 24h` polling; preserve bookmarks when source fails.
- A source/tool outage must report `unavailable`, never `nothing new` or `success`.
- Immediately re-read/revalidate live data before external effects or completion.
- Use idempotency keys and a `posting` / `confirmed` / `possibly_applied` ledger; do **not** advance cursor/bookmark after an unconfirmed send/merge/deploy.
- Keep owner/project preferences read-only to agents and writable task state separate; re-read policy each run, fail closed when missing.
- Run within scoped credentials, network host allowlists, turn/time/spend caps; least privilege by agent role.
- For unknown external effect, reconcile with source, then resume; do not repeat blindly.
- Do not use model self-assessment as proof. Outputs require explicit verifiable evidence.

## 6. Implementation work packages (each is an isolated worktree)

### Phase 0 — Inventory, baseline, fixtures (P0, no behavioral change)
**Owner:** coordinator + research subagent; worktree `v2/00-baseline`.
- Inspect all paths above and map existing startup/resume, manager, quota, router, checks, reporter, stop and deploy data flow; produce `docs/v2/CURRENT_STATE.md` with file/line evidence and missing capabilities vs existing ones.
- Establish `GHOSTY_STATE_DIR=$(mktemp -d) npm test` baseline, separately run reporter plugin suite per its package config, `node scripts/router-dryrun.js --dry`; capture command, exit, version, sanitized summary, not private output.
- Add fixture-first trace of a synthetic task's lifecycle and baseline UI status. Identify existing state migrations and backward compatibility.
**Exit:** documented baseline, test status and risks, no claim of live end-to-end test.

### Phase 1 — Security floors and test isolation (P0)
**Owner:** security developer + independent reviewer; `v2/01-security`.
- Change unsafe network launch defaults to loopback and CLI launch defaults to non-bypass modes where compatible. Audit ALL start/resume/park/restart paths, preserve user-configured overrides but flag unsafe settings explicitly.
- Refactor safe restart to fail closed on unreachable API/ambiguous deploy status. Maintain tailnet and reporter invariants.
- Add negative tests: forbidden auto-answer always blocked; origin, reporter token+loopback, malicious session targeting, path escapes, timeout, unknown deploy states; no real tmux in unit tests.
- Ship migration notes before applying runtime default changes; verify existing installation docs.
**Exit:** focused and full tests green, independent risk review, no live restart performed.

### Phase 2 — Task contracts, durable store, events (P1)
**Owner:** core developer; `v2/02-task-core`.
- Implement typed/versioned task and event schemas, strict transitions, idempotent append/log, persistence and recovery, immutable project policy snapshot per run and policy refresh at next run.
- Add crash injection and restart replay fixtures; external effects remain `unknown_external_effect` until reconciled.
- Add read-only preferences + writable run-state separation; model user-facing status consistently from stored facts, not terminal guesses alone.
**Exit:** replaying same event twice has exactly one effect, interrupted writes recover without misreporting completion.

### Phase 3 — Adapters + worktree executor (P1)
**Owner:** adapter specialists in separate worktrees (`v2/03-claude`, `v2/03-codex`, `v2/03-opencode`, `v2/03-minimax`) with stable interface agreed before parallelism.
- Implement standardized `start`, `observe`, `send`, `cancel`, `collectUsage`, `probeCapabilities`, `normalizeError`, and `resume` where supported. Explicitly represent unsupported actions. Avoid pretending tmux heuristics equal structured completion.
- Use process argv arrays and validated cwd; no shell injection. Capture pid/session, exit code, worktree SHA, timeout, cancellation acknowledgement.
- Guarded Git worktree lifecycle: repo allowlist; no concurrent ownership of a worktree; dirty/untracked checks; no unsafe deletion; safe cleanup only after review/explicit retention choice.
- Dependency: API contract and fake adapter tests finalized before multiple agents branch.
**Exit:** synthetic adapter contract tests for each provider; at least one sandbox integration path (no credentials) through fake runtime; live provider smoke only with opt-in and recorded costs.

### Phase 4 — Model registry, dynamic routing and budgets (P1)
**Owner:** routing developer; `v2/04-routing`.
- Introduce versioned model registry and local policy with model/provider/runtime and capability/effort mappings. Do not encode current prices as permanent truths.
- Build deterministic eligibility and risk floors before any AI ranking; rationale and shadow decision events.
- Implement dry-run comparisons to existing rules and guard false auto-handles; enforce budgets per attempt and whole task, including verifier costs. Quota missing vs exhausted distinguished.
- Run routing in shadow mode first, then bounded feature-flagged pilot after review. Report disagreement, cost, latency, unsafe picks, not just agreement.
**Exit:** fixtures prove forbidden tasks can never pick an unsafe action; model/provider failure cannot bypass risk policy; no shadow routing changes live behavior.

### Phase 5 — Bounded goal loop and independent verification (P1)
**Owner:** loop and verifier developers in separate worktrees, integration after stable contracts.
- Implement step lifecycle `plan -> execute -> test -> review -> accept/retry/abort`; no arbitrary correctness-attempt limit; respect real authorized spending/quota/safety constraints, and use feedback-driven repair, replan and waiting for no-progress conditions.
- Require test evidence linked to task and code SHA. Reviewer is logically separate from maker; do not count a verifier's prose as a test run.
- Policy: no auto-merge/deploy or irreversible action. High-risk gates trigger owner approval.
- Failure injection: test failure, flaky tests, provider rate-limit, provider timeout, budget exhaustion, cancel, concurrent updates, stale branch, changed policy, missing source, reboot.
**Exit:** bounded retries terminate deterministically; success only after required checks pass for the *current commit SHA*; cancellation prevents later background writes.

### Phase 6 — UI, accessibility, documentation (P2)
**Owner:** frontend/doc agent; `v2/06-ui-docs`.
- Preserve session board; add opt-in **Tasks** view with task graph, assigned roles, runtime/model/effort, cost+token ledger, allowed actions, worktree/branch SHA, evidence, retry history, approval queue and clear unknown states.
- Responsive mobile and desktop, no misleading badges such as `done` on unverifiable tasks; use existing `public/icons.js`; verify service-worker cache update.
- Rewrite README as progressive disclosure: problem/use cases, capabilities today vs planned V2, architecture diagram, supported runtimes, security limits, quick start, screenshots, tutorial, docs links, contribution/test instructions. No feature claim without evidence.
**Exit:** browser UI test phone/desktop with artifacts, keyboard focus/contrast checks, screenshots, all docs links valid.

### Phase 7 — End-to-end integration + staged rollout (P0 release gate)
**Owner:** integration manager plus independent tester; `v2/07-integration`.
- Integrate branches sequentially after matching contracts, rebase/check ownership conflicts, run full suite and separate plugin suites in clean temp state. Do not run secondary real dashboard against the live tmux socket.
- E2E scenarios below must pass against isolated fake infrastructure. Optional real-provider smoke requires credentials isolated outside repo and explicit cost approval.
- Record rollback procedure, migration validation, load/safety budget, telemetry opt-in. Roll out disabled -> shadow -> one low-risk project -> multi-provider; no autonomous deployment without owner authorization.
**Exit:** signed acceptance checklist with every test as PASS/FAIL/SKIPPED, command, timestamp, commit SHA, artifact link; zero critical outstanding findings.

## 7. Verification matrix — compulsory

| Test ID | Scenario | Required assertion | Scope |
|---|---|---|---|
| T01 | Project policy absent or invalid | Refuse execution, request owner clarification | Unit |
| T02 | Restricted action disguised in task text | Policy wins regardless of model | Unit/security |
| T03 | CLI startup, resume, park | No bypass permissions by default, validated argv/cwd | Integration |
| T04 | Network listener, origin and reporter endpoint | Default loopback, rejected unauthorized route | Integration/security |
| T05 | Parallel worktrees | No shared mutable worktree; same repo can host disjoint agents | Integration |
| T06 | Duplicate event/outcome | Exactly one state transition/effect | Unit + crash E2E |
| T07 | Restart between attempted and confirmed side effect | Remains unknown until reconciled; no blind duplicate | E2E |
| T08 | Source MCP or provider unavailable | State says unavailable/blocked, not empty/success | Integration |
| T09 | Unit test fails | Cannot mark completed; bounded fix/review/abort | E2E |
| T10 | Failed verification after source change | Revalidate commit SHA and rerun affected tests | E2E |
| T11 | MiniMax/Codex/Claude/OpenCode adapter capability absent | Reject unsupported route, provide compatible fallback | Contract |
| T12 | Rate limit / timeout / quota exhausted | Backoff and bounded compatible fallback | Integration |
| T13 | Budget/time/turn cap | Stop/ask owner, no extra spending after cap | E2E |
| T14 | Cancellation during spawn/check | No unauthorized subsequent execution, status accurate | E2E |
| T15 | Reviewer disagrees with maker | Test evidence and policy decide; owner if unresolved | Integration |
| T16 | Existing dashboard/send/reply/status and push | No regression in original workflows | Regression |
| T17 | Forbidden topic in manager auto-send | No send; human escalation | Security regression |
| T18 | Reboot/state recovery | Resume only confirmed work; no lost or duplicate events | E2E |
| T19 | Existing state migration | Read old state safely and reversibly | Integration |
| T20 | Mobile/desktop app/PWA | Screens, keyboard, service worker, responsive task view | Browser E2E |
| T21 | Safe restart with unreachable API | Refuse and show reason; never assume idle | Security |
| T22 | Usage unknown / stale pricing | Do not report $0 or route on fabricated metrics | Unit |
| T23 | External write confirmation | Advance bookmark/ledger only after confirmation | Integration |
| T24 | Multi-agent branch integration | Conflicts detected, checks re-run on merge SHA | Git E2E |

**Minimum genuine end-to-end test:** use a temporary local Git repo, temporary state dir, stub CLI executables and a disposable port. Submit a feature task, route to fake dev, create a dedicated worktree, introduce a failing test, observe verifier rejection, retry with a fix, rerun validation on final SHA, simulate an independent reviewer, mark done, restart controller, prove no duplicate run or event. Repeat with simulated 429, cancel, budget cap and attempted unsafe action. Record machine-readable trace and screenshots (synthetic data only). Do not substitute mocks for the later opt-in real provider smoke; label each scope distinctly.

**Quality requirements:** no policy-bypass regressions; zero unapproved external writes in negative tests; all required acceptance checks pass on exact integrated SHA; persisted tasks recover; tests have timeouts/cleanup; UI accurately distinguishes running, blocked, unknown, verified and merely reported states. Report coverage metrics, but do not make an arbitrary percentage substitute for scenario testing.

## 8. Worktree + subagent operating procedure

1. Coordinator creates `v2/<phase>-<topic>` worktree, records baseline and ownership; delegates task with exact files/APIs/acceptance criteria.
2. Worker reads project rules and contract, writes failing focused test, implements minimal change, runs test and full suite in isolated temp state.
3. Worker submits structured handoff: changed files, SHA, tests (command/exit/coverage), architecture decision, open risks, data/privacy scan, no untracked output.
4. Separate verifier reads diff from baseline and reruns tests without trusting worker assertion; rejects undocumented API changes and violations.
5. Integration agent incorporates one reviewed branch, re-executes affected contract and E2E tests, checks current source SHA, resolves conflicts with human decision on divergent specs.
6. Owner reviews security-sensitive and irreversible actions. Only explicit authorization permits push, merge, deployment, or state migration.

Suggested parallelism: after phase 0, security work may proceed separately; after task schema and adapter contract stabilizes, Claude/Codex/OpenCode adapters can run concurrently. Do NOT parallelize schema changes and callers without an agreed frozen contract.

## 9. README V2 content and diagrams

**Do not replace existing README with speculative V2 claims while features are unshipped.** Add a truthful `Current capabilities / V2 roadmap` section. Preserve existing desktop/mobile screenshots (`docs/images/mycodebox-desktop.png`, `docs/images/mycodebox-mobile.png`). Add `docs/images/v2-architecture.svg` after review; label architecture as **planned** until implemented. Add a workflow diagram: task -> router -> runtime/worktree -> deterministic tests -> independent review -> accept/retry/approval. Include safety model (tailnet, no app login, provider egress, permission defaults), use-case table, feature matrix by runtime, real test matrix, local quick-start and link to this task plan. See sibling README proposal file in this deliverable.

## 10. Definition of done and final report

V2 is NOT done merely because code compiles, new screens load, or an LLM says the work looks good. Completion requires: (1) user-facing use cases T01–T24 with evidence or explicit documented skips blocking release where required; (2) all pre-existing tests passing; (3) documented verified model/runtime support; (4) reproducible clean install/migration; (5) no regression in stop safety, tailnet boundary, reporter or deployment protection; (6) reviewer approval of critical paths; (7) README statements match tested behavior; (8) owner-authorized release and rollback readiness.

Final report format: baseline commit; integration commit; worktree/agent/role table; decisions; changed modules; automated test summary with exact commands/exits; E2E evidence by scenario; skipped/unverified items; security review; budget/latency data; migration/rollback; explicit owner actions required. If any critical gate fails, report **not ready** and stop.

## 11. Source references

- Repo: https://github.com/angelstreet/mycodebox
- `README.md`, `AGENTS.md`, `docs/CONTRACT.md`, `docs/MAP.md`, `HANDOVER.md`, `TODO.md`, `router.js`, `router-shadow.js`, `manager.js`, `server.js`, `scorecard.js`, `scripts/router-dryrun.js`, `scripts/router-replay-stop.js` (inspected via GitHub connector on 2026-10-09).
- Anthropic: https://claude.dev/blog/building-effective-agent-automations/ (2026-10-08).

## 12. V2 addition — Integration Agent and System Operations Agent (required)

**Decision:** add two persistent *logical roles*, not necessarily two continuously running LLM processes. `integration` exclusively coordinates shared-branch changes and owner-authorized push/merge; `system-operations` exclusively coordinates host/service maintenance. The deterministic task controller remains the authoritative scheduler and ledger. Neither role has standing authorization to perform dangerous actions.

### 12.1 Responsibilities and separation of duties

| Role | Owned operations | May request | Forbidden without explicit authorization |
|---|---|---|---|
| Developer | Task-scoped worktree edits, local tests | Integrate, host repair, deployment | Shared branch push/merge, system restart, external deploy |
| Tester | Independent diff/check and test evidence | Reject/retry, integration review | Self-approval, merge, deployment |
| Integration | Integration queue, branch reconciliation, CI gate, integration SHA, audit trail | Owner approval, production deployment | Auto-merge to protected branch or push without configured authorization; skip CI |
| System Operations | Host metrics/incidents, service recovery coordination, safe maintenance | Pause task admission, owner approval, approved remediation | Unscoped deletion, killing unrelated sessions, network exposure, irreversible recovery |
| Manager | Task intake, routing, scheduling, status | Delegate to Integration/System Operations | Circumvent either role's ownership and gates |

Integration and System Operations must use dedicated low-privilege identities/tool permissions where feasible. LLMs propose and explain; deterministic executors enforce leases and hard policy. Human approval is separate from agent recommendation.

### 12.2 Leases: mandatory fail-closed shared-resource control

Before any shared mutation, Integration/System Operations must acquire a lease through an atomic authority, never infer authority from `no lease found`. Proposed resource namespaces: `repo:<repo>:integration`, `repo:<repo>:main`, `environment:<env>:deploy`, `host:<host-id>:maintenance`, `service:<host-id>:<service>`, `worktree:<task-id>`. Existing `leases.js`, `lease-watch.js`, `handoffs.js`, `vpt-locks.js`, `deploy-runner.js` must be audited and reused/extended based on demonstrated guarantees—not silently replaced.

Lease record: resource, lease ID, owner/run/task ID, fencing token or monotonic generation, acquisition time, TTL, renewable heartbeat, action scope, approval reference, and audit provenance. Lease acquisition/renewal/release require atomic conditional operations. Re-check fencing/ownership immediately before mutation; expired owners must be fenced, not merely marked stale. On unavailable authority, ambiguous ownership, expired approval, missing permissions, or network partition: **block the mutation and alert**. Enforce an ordered resource-acquisition policy to avoid deadlocks. Prevent concurrent integrations of the same branch and overlapping host maintenance/deploy windows.

### 12.3 Integration Agent workflow (own worktree + queue)

1. Receive a signed/structured developer handoff: task ID, source branch/worktree, base SHA, diff scope, test commands/results, artifact locations, risk classification and independent tester verdict. Reject missing evidence.
2. Check task definition, approvals, protected branch rules, target repository and any deployment in progress. Acquire `repo:...:integration`, then needed target-branch resource lease. No lease service = wait/block, not proceed.
3. Materialize a separate integration worktree from fresh target SHA. Reconcile reviewed branches sequentially; do not trust stale green tests. Handle conflict by returning to the responsible developer or escalating—never silently select one side of a semantically conflicting contract.
4. Run format/lint/unit, contract, integration, security and task-specific E2E checks. Verify tests on exact integration commit SHA and persist machine-readable evidence (exit code, timestamp, environment/fixture hash, artifact digest). Use fresh temp state, fake tmux/providers and disposable ports; never start another server on live sockets/state.
5. Obtain configured human authorization before push/merge/release. Push authorized candidate branch, wait for required remote CI/check statuses on the **exact head SHA**; use atomic/conditional remote operations and respect branch protection. Local tests cannot replace remote CI. If a push/merge response is uncertain, query remote state before retry (idempotency/reconciliation).
6. Only authorized merges to shared branches. If remote merge changes SHA, verify required checks against the resulting commit and record provenance. Separate deployment approval and environment lease required; reuse safe deployment machinery and post-deploy health/rollback checks.
7. Release leases in `finally` with identity checks; publish immutable integration report and update task state. Failed or partial merges produce `blocked/unknown` rather than `success`.

**CI/CD policy:** Do not grant a GitHub workflow or agent permission to bypass protection. Required branch check suites and protected environments are the source of truth. Deployment must never be a side effect of unreviewed developer output. For repositories without configured CI, bootstrap explicit local gates first and do not claim CI verification.

### 12.4 System Operations Agent workflow (shared across projects)

The System Operations Agent is a single shared operational role per managed host or host group. Agents and monitors may open incidents; only this role may coordinate maintenance. Accept incident types including `host.cpu_pressure`, `host.memory_pressure`, `host.disk_pressure`, `service.unhealthy`, `service.crash_loop`, `tmux.resource_exhaustion`, `worktree.storage_exceeded`, `runner.starved`, and `health.unknown`. Messages are structured and sanitized; no credentials, raw private logs or owner outputs in public records.

Incident contract: incident ID/dedup key, reporter, host/service ID, symptom, measured values + units, timestamps, priority, evidence references, workload impact, candidate remediation, and requested owner action. Metrics must have timestamp, freshness, source and unknown state. Deduplicate repeated reports and avoid treating stale telemetry as recovery.

Process: verify telemetry independently; triage and classify impact; block new admission if host unhealthy; notify affected developer/test/integration tasks; obtain `host:maintenance` or narrower `service` lease; check competing deploys, leases and active critical jobs; execute **allowlisted and reversible** remediation only; recheck telemetry and service readiness; record before/after metrics and resume paused work. Escalate for data deletion, process termination outside its scope, service restart affecting active deployments, changing permissions/network, or uncertain repair. Use `scripts/safe-restart.sh` only after fixing and testing its unreachable-API fail-open behavior; never treat inaccessible control plane as idle. Never assume disk cleanup is safe simply because space is low.

Provide an incident API/event stream distinct from task events but linked by task/host ID: `incident.opened`, `incident.acknowledged`, `incident.mitigation_requested`, `incident.approval_required`, `incident.resolved`, `incident.escalated`, `incident.unknown`. Agents can **request** host repairs; they cannot execute them. The manager pauses/reroutes work only after an authoritative incident state transition.

### 12.5 Role configuration, lifecycle and integration points

Place canonical project role constraints in versioned project policy (e.g. `.ai/project.yaml`) and portable `AGENTS.md`. Global integration/host policies live in private service configuration. Native Claude/Codex/OpenCode agents are optional execution adapters; no role depends on a provider's proprietary subagent feature. Keep the Integration/System Operations state durable independently of model sessions; optionally invoke a temporary reasoning agent for complex incidents, but it never owns the lease authority or approval gate.

**Module proposals after phase-0 inventory:** `orchestration/integration-controller.js`, `orchestration/integration-queue.js`, `orchestration/lease-authority.js` (adapter to proven existing leases), `orchestration/ci-gates.js`, `orchestration/incidents.js`, `orchestration/system-ops.js`, and `orchestration/events.js` extensions. Separate read-only monitor permissions from mutation executors. UI should show integration queue, remote CI SHA/status, active leases, host incidents, paused tasks, owner approvals, and audit evidence. If UI is not built yet, provide CLI/API observability before activating automation.

### 12.6 Worktree delivery split and sequencing

- `v2/08-lease-authority`: independently audited lease/FIFO/TTL/fencing contract, fake authority, concurrency tests. **BLOCKS all shared mutations**.
- `v2/09-integration-agent`: dedicated integration queue/controller, provenance manifest, protected Git operations, remote CI gate and owner authorization. Depends on lease contract and existing security phase.
- `v2/10-system-ops`: incident intake, dedup, telemetry freshness, admission pause, allowlisted maintenance and host/service leases. Depends on lease contract and fail-closed restart fixes.
- `v2/11-ops-integration-e2e`: scenario harness combining manager, dev, independent verifier, integration, system maintenance and simulated provider/process failures. No production endpoints or real credentials.

The **Integration Agent** is the sole normal integrator of these branches, but it cannot autonomously push/merge in the absence of explicit project-level authorization. A separate human or explicitly authorized reviewer checks the Integration Agent's own controller and policy changes before promotion.

### 12.7 Mandatory additional integration and end-to-end tests

| ID | Scenario | Required assertion |
|---|---|---|
| T25 | Two Integration Agents race to acquire same branch | Exactly one fenced lease holder mutates branch |
| T26 | Lease backend unavailable or stale | No merge/push/restart; state blocked and operator alerted |
| T27 | Lease expires mid-command | Stale executor cannot commit an additional protected action |
| T28 | Integration branch updated after tests | SHA mismatch invalidates previous gate; all required tests rerun |
| T29 | Remote CI red, missing, or pending | No merge, even when local tests are green |
| T30 | Push times out after remote accepted it | Query remote SHA first; do not double-push/mark failed blindly |
| T31 | Unapproved merge/deploy request | Must refuse; audit records actor and required approval |
| T32 | Disk reaches configured pressure threshold | Report incident, pause admission, no destructive cleanup without approval |
| T33 | CPU pressure during integration/E2E | Throttle or pause safely; keep task state and leases consistent |
| T34 | Host recovery while deployment active | Recovery waits/blocks or requests explicit override; never blind restart |
| T35 | Service health metric stale/unreachable | Health unknown, not healthy; escalation rules apply |
| T36 | Two developers report same host issue | One incident + linked reports, no duplicate remediation |
| T37 | Maintenance action fails mid-execution | Checkpoint, rollback/reconcile if safe, maintain incident state |
| T38 | Service recovers, queued tasks resume | Fresh health check + released maintenance lease before admission |
| T39 | Integration end-to-end on disposable Git remote | Worktree patch -> independent verify -> integration -> CI success -> authorized push/merge, exact SHAs recorded |
| T40 | Security regression: developer requests system command | Request routed to System Operations; developer cannot execute privileged maintenance via orchestration |

**Release gate amendment:** all applicable T01–T40 must have executed results or a documented blocked/skipped disposition, and no critical tests may be skipped for release. Existing T01–T24 retain precedence. Include lease/incident/restart/CI integration tests in automated CI; E2E tests use a disposable bare Git remote, fake status API, fake systemd/tmux, temporary state, stub CLI, and failure injection. Real GitHub and production maintenance smoke tests require explicit owner permission and carefully scoped test environments. Update README/architecture only as capabilities ship; mark planned Integration/System Operations features accurately until proven.


## 13. Universal goal loop for every mycodebox task (REQUIRED)

`GOAL_LOOP_CONTRACT.md` is the normative specification for an autonomous goal-loop engine. It applies to **all tasks created after V2 ships**, not only the mycodebox refactor. Implement task intake with a measurable goal and definition of done, persistent plan and events, developer worktree execution, deterministic tests, independent verification, decision rationales, and automated error repair/replan until the goal is verified. Do not impose arbitrary per-task attempt caps or ask the owner to manage routine technical iterations; respect real credential/permission, safety, cost-authorization and capacity constraints, with durable WAIT/approval states. Expose evidence and chosen recommendation rationale in the UI.

During V2 construction, dogfood this very loop using `PROMPT.md`, then prove product parity with tests GL01–GL14, including four-plus repair rounds, independent rejection/rework, provider failover, crash recovery, integration lease ownership, safe host incident escalation, and final accepted SHA. The project is NOT done until all applicable existing T01–T40 and GL01–GL14 gates pass and required manual approvals remain explicit.
