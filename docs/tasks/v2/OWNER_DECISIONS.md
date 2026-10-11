# V2 owner decisions and spec reconciliation (2026-10-11)

This file records the owner's authorization for the V2 run and resolves contradictions between
`MYCODEBOXV2_AGENT_TASK.md`, `PROMPT.md` and `GOAL_LOOP_CONTRACT.md`. It **takes precedence over those
three files** where they conflict. `AGENTS.md` and `docs/CONTRACT.md` still win over everything here.

## 1. Mandate

The coordinator implements **all** of V2 (Phases 0–7, Section 12 extensions, Section 13 goal loop),
then runs a full-process review, and delivers. The owner reviews only at the end. Do not stop to ask
technical questions: investigate, decide, record the decision (decision journal in `V2_PROGRESS.md`),
and continue. Only a genuinely unclear *goal or requirement* justifies an owner question, and even then
pick the safest reversible default, record it as `OWNER-REVIEW` in `V2_PROGRESS.md`, and keep going.

## 2. Authority (explicit, scoped)

| Action | Authorized? |
|---|---|
| Create/modify worktrees and branches under `~/mycodebox-v2` and `~/mycodebox-v2-wt/` on the host | Yes |
| Push `v2/*` branches to `origin` (GitHub `angelstreet/mycodebox`), including force-push of `v2/*` task branches you own | Yes |
| Open/update a **draft** PR `v2/integration` → `main` | Yes |
| Push to, merge into, or rewrite `main`; mark the PR ready; `gh pr merge` | **No** |
| Deploy, restart or reconfigure the live `ghosty-sessions` service, any systemd unit/timer, `safe-restart.sh` against live | **No** |
| Write to `~/ghosty-sessions` (live checkout) or `~/.local/state/ghosty` (live state) | **No** — read-only inspection only |
| Touch other tmux sessions (`ghosty`, `ghosty-sessions`, `TASK*`, `mm-manager`, …) | **No** |
| Real provider calls (Claude, Codex, MiniMax) for smoke/E2E tests | Yes, sensibly; record each run's model and cost in `V2_VERIFICATION.md` |
| Host-wide maintenance, deleting anything outside `~/mycodebox-v2*`, credentials/permission changes | **No** |

Before every push: run a leak scan of the diff (no tokens, keys, real IPs, host names, tailnet names,
e-mails, `/home/<user>` paths, captured session output). The repo is public. Scrub existing
`docs/v2/*` evidence files of any such data before their first push.

## 3. Models

Claude Code native subagents are the default execution mechanism (`Agent` tool with
`isolation: "worktree"` or a worktree you create under `~/mycodebox-v2-wt/`).

- Coordinator: Opus.
- Developers: Sonnet for normal packages; Opus for the lease authority, task core/store, goal-loop
  engine and integration controller.
- Mechanical work (leak scans, doc link checks, fixture sanitizing): Haiku.
- Independent verifier: **never the same model+context as the author.** Opus reviews Sonnet work;
  Fable reviews security-sensitive work (Phase 1, leases, integration controller, system ops) and does
  the final full-process review. Codex CLI (`codex`, on the host) is available as a cross-provider
  verifier and for adapter tests; MiniMax via `mcode`.
- At most 3 concurrent developer workers (host: 6 cores, 15 GB). Check load before adding more.

## 4. "Bounded" vs "no attempt cap" — resolved

The specs say both "bounded retries" and "no arbitrary attempt cap". Canonical meaning:

**A loop is bounded by policy stops, never by an attempt count.** Policy stops are: cancellation,
an explicitly set budget (`budget_policy.max_usd`, tokens, duration), provider quota exhaustion
(→ `waiting` + backoff), missing authorization (→ `awaiting_approval`), unrecoverable condition, and
the **no-progress rule**:

- The same failure signature (normalized test name + error class) seen **3 consecutive times**
  forces a strategy change (replan, harness/test change, or different model) — never a blind retry.
- **3 strategy changes with no new passing evidence** → task moves to `waiting` with reason
  `no_progress`, a diagnosis, and the next suggested action; the loop moves to other independent work
  and revisits when inputs change.

Product default `budget_policy` for new tasks: `{ mode: "track" }` — spend is measured and shown,
no cap. When the owner sets `max_usd` (or token/time limits), it is a hard stop that leads to
`awaiting_approval`, never silent overspend. Unknown cost stays `unknown`, never `0`.

The coordinator itself follows the same rule for this run.

## 5. One status vocabulary

Canonical lifecycle states (from `GOAL_LOOP_CONTRACT.md`, extended):
`created, clarified, planned, ready, executing, evaluating, repair, replan, waiting,
awaiting_approval, integrating, release_verifying, accepted, failed_unrecoverable, cancelled,
unknown_external_effect`.

| Section 3 status | Canonical state |
|---|---|
| queued | ready |
| planning | clarified / planned |
| running | executing |
| verifying | evaluating |
| blocked | waiting (with `reason`) |
| retryable_failure | repair |
| failed | failed_unrecoverable |
| completed | accepted |
| awaiting_approval, cancelled, unknown_external_effect | same |

The user-facing `outcome` is derived, not stored: `done` = accepted; `waiting`; `needs_owner` =
awaiting_approval; `unrecoverable` = failed_unrecoverable; `cancelled`; everything else
`not_yet_done`. Event names in Section 3 stay as specified.

## 6. One task schema

Union of both schemas. Fields marked required in `GOAL_LOOP_CONTRACT.md` are required;
Section 3 fields (`repository`, `excluded_paths`, `runtime_allowlist`, `model_allowlist`,
`max_*`, `retry_strategy`, `no_progress_policy`, `worktree_id`, `parent_task_id`, `handoff_refs`,
timestamps) are optional with documented defaults. Subtasks may only narrow parent constraints.

## 7. Clarification (T01 vs goal loop)

Missing or invalid project policy → refuse execution, state `awaiting_approval` with a clarification
request (T01). Any other ambiguity → choose a safe, reversible, documented default and continue.

## 8. Other open items

- **README proposal file** referenced in Section 9 does not exist. Write the README
  "Current capabilities / V2 roadmap" section from Section 9 alone.
- **HOST default → loopback (Phase 1).** Inspect (read-only) how the live install sets `HOST`.
  Upgrading must not silently break phone access over Tailscale: support an explicit tailnet `HOST`
  and document it in migration notes; if the live unit lacks an explicit `HOST`, list it as an owner
  action in the PR description.
- **Router dry-run wake agreement 6/10** is in scope for Phase 4: diagnose and fix if it is a rule or
  fixture defect; document otherwise. The router never goes live in this run.
- **OpenCode** is not installed on the host: build its adapter against a fake CLI and mark live smoke
  `BLOCKED (runtime not installed)`.
- **Scoring and auto-improvement (owner's next goal).** Design the task ledger, decision journal,
  evidence and usage data so that a later scoring loop can compute per-model/per-runtime verified
  completion rate, cost per verified completion, latency and rework count. Provide a read-only
  `scripts/v2-score.js` report over the ledger plus `docs/v2/SCORING.md` describing how the router can
  consume it. Do not build automatic self-modification in this run.

## 9. Delivery

Done means: every applicable T01–T40 and GL01–GL14 gate executed with evidence (or a documented
BLOCKED/MANUAL disposition that is not release-critical), `npm test` and reporter suite green on the
exact integration SHA, a Fable full-process review with findings addressed, a pushed
`v2/integration` branch, and a **draft** PR to `main` whose description is the final report
(Section 10 format) including the owner-action list. Then set the first line of `V2_PROGRESS.md` to
`STATUS: DELIVERED <sha> <pr-url>`.

While working, keep line 1 of `V2_PROGRESS.md` as `STATUS: RUNNING — <current phase/next action>`.
If truly blocked on the owner with no independent work left, use `STATUS: OWNER-BLOCKED — <question>`.
Push `v2/integration` and active task branches after every phase checkpoint so progress is visible
on GitHub.
