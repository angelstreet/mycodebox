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
- Token frugality (owner, 2026-10-11): run test suites, lint and git directly with Bash (in the background,
  then read the log file), never through subagents. Spawn subagents only for real implementation or independent
  review, with tight briefs; default Sonnet, Haiku for mechanical checks, Fable only for security-critical gates
  and the final full-process review. Do not re-read big files already summarized; rely on `V2_PROGRESS.md`.
  When waiting on a background job, end the turn with one line instead of polling; a watchdog wakes the
  coordinator every 15 min.

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

## 10. Round 2 (owner, 2026-10-11)

These override earlier text in this file and the V2 specs where they conflict. The owner also decides the AGENTS.md /
`docs/CONTRACT.md` wording for item 2.

### 0. Context you must know
- GitHub history was rewritten tonight to scrub the tailnet host/IP (replaced by `<tailnet-host>`, `<tailnet>`,
  `<tailscale-ip>`). Your clone is reset to the rewritten `origin/v2/integration`. Every SHA quoted in V2_PROGRESS.md,
  V2_VERIFICATION.md, docs/v2/* and the PR text is now a **pre-rewrite SHA** — say so where they appear, and quote
  current SHAs for everything you run from now on.
- Only branch from `origin/*`. Never push anything containing the real tailnet name or Tailscale IP (both are in the private denylist); extend the private leak
  denylist with both and keep running the leak scan before every push.
- Token frugality rules (OWNER_DECISIONS §3) still apply. Keep your own context small: read files partially, rely on
  V2_PROGRESS.md.
- Do **not** wire the V2 engine into `server.js` in this round.

### 1. Clean V2_VERIFICATION.md
Rewrite it as one coherent, current document: status at the top, gates on the exact current SHA (npm test on Node 23.6 and
24.21, reporter suite, acceptance matrix summary linking `docs/v2/ACCEPTANCE.md`, T20 browser check, leak scan), live
provider smoke table, and an explicit "not covered" list. No stale "NOT RUN" headers, no references to missing sections, no
contradictions with the PR. History may go to a short appendix. Re-run the gates on the final SHA at the end of the round.

### 2. Sessions never ask for permission (owner decision)
Dashboard-created and resumed sessions must start without permission prompts:
- Claude: `--dangerously-skip-permissions`; Codex: `--dangerously-bypass-approvals-and-sandbox` (yolo);
  MiniMax `mcode`: its full-permission mode (find the exact flag with `mcode --help`).
- Restore automatic folder trust for Claude and MiniMax (the removed `trustFolder` behaviour) so no trust dialog appears.
- Cover every launch path: create, resume, park/wake, manager (`managerCommand`, `manager-fresh.sh`), scripts.
- `AGENT_CMD_*` env overrides still win. Drop the "bypass" startup warnings for these defaults; keep the HOST warning.
- Update AGENTS.md, docs/CONTRACT.md, docs/INSTALL.md, README to state this is the owner's chosen default. The
  forbidden-topic filter, manager hard floors and protected-action gates (merge/push/deploy/credentials) are unchanged.
- V2 orchestration workers (adapters) keep their current launch modes unless the dry run (§6) shows a worker blocked by
  a permission prompt; then run workers with the bypass flags inside their isolated worktree and record the decision.

### 3. No tailnet identifiers in the repo, but keep the features working
- `public/.well-known/assetlinks.json` (Android app link) must be produced from configuration (env, e.g. package name and
  cert fingerprint) or served from the state dir — not committed with a real tailnet name.
- The Langfuse link and the "use the https address" hints must come from configuration (check what the branch already does).
- Document the new `.env` keys in INSTALL and put "set these before upgrading" in the owner-action list.

### 4. Close every follow-up
m1, m2, m3, m4, m6, the T15 "reviewer approves, tests red" test, the T20 same-origin positive control, and anything else
still open in V2_PROGRESS.md. Each with tests and an independent reviewer (Sonnet author / Opus reviewer; Fable only for
m3 and m6). Remove each from the open list only when its test passes on the current SHA.

### 5. OpenCode
Install OpenCode in user space on the host (no sudo, e.g. under ~/.local). Run its live smoke with
`scripts/v2-live-smoke.js`; fix the adapter if the real output format differs from the fake.

### 6. Scoring, then a dry run — before any wiring
Goal (owner): be able to score the tool and improve it automatically, safely.

a. **Scorecard**, per task run and aggregated per model / runtime / role / task class: verified completion rate,
   first-pass acceptance, cost per verified completion, latency, rework rounds, owner interventions (approvals asked,
   nudges), defects caught by the independent reviewer, regressions after acceptance. Unknown stays unknown.
b. **Tool score**: a small composite with documented weights, computed over a fixed benchmark suite (below), so two
   versions of mycodebox can be compared run against run.
c. **Auto-improve, approval-gated**: from scores, generate *proposals* (router weight / model registry changes evaluated in
   shadow with the decision diff shown; role prompt or harness changes), each recorded as a V2 task in
   `awaiting_approval`. Nothing applies itself without owner approval. Log proposals in the decision journal.
d. Show the scorecard read-only in the Tasks view and via `scripts/v2-score.js`. Update docs/v2/SCORING.md.

**Dry run (benchmark suite)**: 8–12 easy-to-verify tasks in disposable git repos, run through the goal-loop harness (not the
server) with real runtimes — Claude (Haiku and Sonnet), Codex, MiniMax, OpenCode — and an independent reviewer of a
different model. Include: fix a failing unit test; add a small function with tests; refactor keeping tests green; a doc fix
with link check; a task that asks for a forbidden action (must stop at awaiting_approval); a task whose test cannot pass
(must end `waiting`/no_progress, never done); a flaky test (must be diagnosed, not accepted blindly). Owner-authorized
real-provider spend for this round: **USD 20 total**, set as an explicit `budget_policy` and reported. Score every run
with (a)/(b), fix the defects the dry run exposes (repair loop), and re-run until the suite is stable. Commit the suite
(`scripts/v2-bench.js` + fixtures, synthetic only) so it can be re-run after wiring.

### 7. Deliver round 2
Push `v2/integration`, update the PR #1 description (round-2 section: what changed, scorecard and dry-run results, updated
owner actions), keep it draft. Then set line 1 of V2_PROGRESS.md to `STATUS: DELIVERED <sha> <pr-url> (round 2)`.

## 11. Round 3 (owner, 2026-10-12)

Add as section 11 "Round 3" of `docs/tasks/v2/OWNER_DECISIONS.md`, then execute in order. First set line 1 of
V2_PROGRESS.md to `STATUS: RUNNING — round 3: ...` (the watchdog stops on `STATUS: DELIVERED`). All earlier rules
still apply: worktrees only, push `v2/*` only, draft PR, no merge, no deploy, no live service/state, leak scan before
every push, token frugality (tests run directly with Bash; Sonnet default; Fable only for security-critical review).

### 1. Wire the V2 engine into the server (behind `GHOSTY_V2=1`, off by default)
- One process, one store handle shared by the HTTP routes and the goal loop (D-016/D-017). At startup take the
  controller lease, run `recover()` under it, then start the loop. Clean shutdown releases the lease.
- Tasks created from the dashboard/API actually execute: route (deterministic floors first) → adapter → isolated
  worktree under a configured work root (env, e.g. `GHOSTY_V2_WORK_ROOT`) → deterministic checks → independent reviewer →
  accepted / waiting / awaiting_approval. Repos limited to the allowlist in `.ai/project.json`.
- Approve, deny and cancel from the dashboard work through the loop (no more 503 when V2 is on); proposal tasks from the
  scorecard can be approved from the dashboard.
- Integration controller: may push only `v2/*`-style task branches it owns; anything touching a protected branch, merge or
  deploy stays `awaiting_approval` with an SHA-bound owner approval, exactly as the contract says. No merge/deploy happens
  without that approval.
- System operations: wire telemetry/incidents read-only plus request-only actions; nothing destructive.
- The existing manager, its `routerShadow`, sessions board and every pre-V2 behaviour are unchanged when `GHOSTY_V2` is unset.
- Fable reviews the wiring (security-critical). Add tests that boot the real server module in a child process on a
  disposable port with temp state and a fake `tmux -L` socket (never import `server.js` into the test process itself).

### 2. Benchmark against the wired server
Start a disposable server instance (`GHOSTY_V2=1`, temp state dir, loopback port, private tmux socket, temp work root) and
drive the benchmark suite **through the HTTP API** end to end with real runtimes (Claude Haiku and Sonnet, Codex, MiniMax,
OpenCode), approvals answered through the API where a task asks. Compare the scorecard and tool score with the round-2
dry run (same suite version), explain the differences. Owner-authorized real-provider spend for this round: **USD 20**,
set as an explicit budget_policy and reported. Fix defects the run exposes and re-run the affected tasks.

### 3. Loose ends
- MiniMax on the impossible task should end `waiting`/no_progress before the time cap — fix if the cause is ours.
- Remove the stale owner-action line saying the tailnet IP/host "stay in main's git history": history was rewritten.
- Docs: how to enable V2 on the live install (env keys, work root, `.ai/project.json`), how to roll back (unset
  `GHOSTY_V2`, restart), what changes for the owner. Put the enable steps in the PR's owner-action list. Do not enable it.

### 4. Deliver round 3
Gates on the final code SHA (both Node versions, reporter suite, acceptance matrix incl. T20, leak scan), update
V2_VERIFICATION.md (clean, current), V2_PROGRESS.md and the PR description (round-3 section with wiring summary, benchmark
comparison, spend, owner actions). Keep the PR draft. Then set line 1 to `STATUS: DELIVERED <sha> <pr-url> (round 3)`.

## 12. Round 4 (owner, 2026-10-12)

Add as section 12 "Round 4" of `docs/tasks/v2/OWNER_DECISIONS.md`, then execute in order. First set line 1 of
V2_PROGRESS.md to `STATUS: RUNNING — round 4: ...`. All earlier rules apply (worktrees, push `v2/*` only, draft PR,
no merge/deploy/enable on live, leak scan, token frugality). Also fix the stale owner-action line in V2_PROGRESS.md that
still says V2 is not wired / approvals answer 503.

Owner problem: MiniMax took 728 s to stop on the impossible task (5 stalled runs x ~2.5 min each, MiniMax never gives up
by itself). The owner wants token use, time and cost kept low per run, and wants the system to weigh token cost, time and
quality — using Haiku instead of MiniMax (or the reverse) when that is the better trade.

Owner facts: MiniMax is a **flat subscription** (fixed monthly plan with a usage quota): its marginal USD cost is ~0 —
record it as `subscription` (not `unknown`, not `$0` measured), track its tokens and quota/rate-limit signals, and let
the router treat quota exhaustion as `waiting`. Claude Haiku/Sonnet are pay-per-token. The M3.1 to evaluate is
`MiniMax-M3.1-Flash-Preview` (already in `~/.minimax/config.yaml`).

## 1. Per-model run limits (policy, not hard-coded)
- In `.ai/project.json` (and the model registry), per runtime/model and per task class: run timeout, max steps, effort,
  context mode. For `mcode exec` use `--timeout`, `--max-steps`, `--effort`, `--mode lightweight` where it helps, and
  `--permission full` (exec supports it — correct D-019 / the owner-action note about config.yaml).
- Defaults for cheap models on easy task classes: short leash (about 2–3 min per run, low effort, bounded steps);
  documented and overridable per task.
- Register `MiniMax-M3.1-Flash-Preview` (and keep M3) in the registry with capabilities and supported efforts.

## 2. Stop faster when there is no progress
Target: an impossible or stuck task on a cheap model ends `waiting` (no_progress) in **under 3 minutes**, not 12.
- A run killed by its own timeout counts immediately as a stall with a timeout signature.
- Cheap models: no-progress after 2 stalled runs (policy field), not 5; a reviewer verdict of "contradictory /
  impossible requirements" ends the task as `waiting` with that diagnosis right away.
- No arbitrary attempt cap on correctness work for capable models: this is the no-progress rule, per OWNER_DECISIONS §4.

## 3. Routing that weighs tokens, time and quality
- Per-task priority (cost / balanced / quality / speed) changes the weights. Feed them from the scorecard: first-pass rate,
  verified rate, tokens, latency, and cost (USD for pay-per-token, quota share for subscriptions).
- Escalation ladder: start with the cheapest model that is good enough for the task class (MiniMax M3.1-Flash or M3),
  escalate to Haiku, then Sonnet, only on failing checks or reviewer rejection — the strategy change in the goal loop
  can switch model. Record each choice and escalation in the decision journal.
- Security-sensitive or high-risk task classes keep their current floors (stronger models, Fable review where required).

## 4. Evaluate MiniMax M3 vs M3.1-Flash-Preview vs Claude Haiku
Same benchmark suite (`mycodebox-v2-bench`), **3 repetitions** per task per model, developer = each of the three,
reviewer = a different model as before. Through the HTTP API of a disposable wired server, with the new limits from §1–§2.
Measure per task and per model: verified, first pass, rework, input/output tokens, wall time, USD (Haiku) / subscription
(MiniMax), and time-to-stop on the impossible task. Owner-authorized real spend: **USD 10** total (Haiku and reviewers
are the $ cost). Write the comparison to `docs/v2/SCORING.md` with a clear recommendation: which model for which task
class and priority, and the router defaults you set from it. Fix defects the run exposes.

## 5. Deliver round 4
Gates on the final code SHA (both Node versions, reporter, acceptance incl. T20, leak scan), update V2_VERIFICATION.md,
V2_PROGRESS.md and the PR description (round-4 section: limits, faster stop, routing, evaluation table and recommendation,
spend). Keep the PR draft. Then set line 1 to `STATUS: DELIVERED <sha> <pr-url> (round 4)`.


## 13. MiniMax M3 only (2026-10-14)

The owner judged MiniMax-M3.1-Flash-Preview not good enough in live use. It is removed from `orchestration/models.json`,
so the router never picks it; MiniMax-M3 is the only MiniMax model and the escalation ladder is M3 → Haiku → Sonnet → Opus.
Session launchers default MiniMax sessions to M3. The benchmark keeps an explicit `minimax:m3.1-flash` spec for a future
re-evaluation; the round-4 numbers in `docs/v2/SCORING.md` stay as recorded.


## 14. The manager decides merges (2026-10-14)

Owner: "This is the type of question I want to avoid: if there is no reason not to merge, you should. If you are the
manager, evaluate and do it, either using Jev or your reasoning."

Trigger: a worker session asked "merge task90-open and deploy once the host frees? [1 buffer + merge, 2 merge only,
3 hold]" together with a request for a file path. The manager escalated all of it to the owner because "merge" was a
forbidden topic, including the path it could have looked up.

- Merge leaves the hard forbidden-topic floor and becomes an evaluated, recorded, vetoable manager decision: the
  manager answers "merge" when the branch merges cleanly (or conflicts only in convention files such as `VERSION.txt`),
  the session reports its tests green on that branch (or the change is docs/test-only), the diff touches no secrets,
  credentials, production-data migrations, sudoers or units, and Jev (or the manager's own reasoning when Jev is
  unavailable) rates it safe at or above the configured threshold. Otherwise it escalates with the specific reason.
- Every merge decision is journaled (rationale, evidence, Jev decision id or "reasoning", SHA) and appears in the
  owner's feed as a notice, so the owner can see and revert. Per-repo opt-out in the manager config.
- Unchanged floors: deploy, deletions, credentials, money and customers always go to the owner. A question mixing merge
  and deploy is split: the manager decides the merge and escalates only the deploy.
- Mixed questions: the manager answers the information part when it can find it and escalates only what remains,
  saying what it already answered.

Implementation: `merge-policy.js`, `info-lookup.js`, the `topicSplit` floor in `stall.js`, router point `merge`, and
`scripts/merge-eval.js` for the interactive manager. After the Fable review the implementation is stricter than the
quote in two places: "docs/test-only" means docs-only (test code needs a green report like any code), and CI, deploy and
infra files count as sensitive; see [REFERENCE](../../REFERENCE.md#merge-decisions-and-mixed-questions-owner-2026-10-14).

## Evidence: harness review 2026-10-14

The owner-interaction review behind rounds 8 (autonomy by default, voice) and 9 (harness fixes): [docs/v2/reviews/HARNESS-REVIEW-2026-10-14.md](../../v2/reviews/HARNESS-REVIEW-2026-10-14.md) (sanitised; the full private report is kept at `$GHOSTY_STATE_DIR/reviews/2026-10-14-harness-review.md` on the dashboard host).

## 15. Autonomy by default and hands-free voice (2026-10-14)

Owner: "The most difficult and constraining for me right now is to follow tasks and always answer the same questions:
yes merge, yes push, yes deploy, yes do the recommended one. Very rarely I correct, and almost always the correction can
come at the end, because when waiting for me we stop developing. Another issue: I need to be behind my laptop or phone.
I need a better ability to hear and engage by voice. My goal: I go to the gym or drive and can still work."

- **G1 autonomy by default** ([GOALS](../../GOALS.md)): push and deploy questions are decided by the manager like merges
  (§14): evaluated, journaled in `manager-decisions.jsonl`, shown as a feed notice, vetoable. A deploy is answered only
  when it goes through the repo's normal procedure (the deploy queue, run by the deploy runner), the target platform is
  free in the lease registry (or held by the asking session), tests are green on the deployed ref, and the change carries
  no production data migration; the notice carries a one-line rollback. "Do the recommended option" (`menu_recommended`)
  is on by default when the recommended option is not on a hard floor.
- **This replaces the earlier "automatic answering defaults off" invariant**: a fresh install starts with `autoSend` on
  and `autoCases` `continue` + `menu_recommended`; a saved config gets `menu_recommended` (also where the owner had chosen
  `continue` only), push and deploy decisions once (`autonomyVersion` 1, with one feed notice) and keeps a saved
  `autoSend: false` and every later owner change. Every capability keeps its switch.
- **Remaining hard floors (owner only):** deletions of data; credentials and secrets; money; customers; sudoers and
  units on hosts (`systemctl`, `pm2`, unit files); production database migrations. Force-push and history rewrites,
  pushes to prod/staging/live outside the deploy queue, tag pushes and publishing a package stay hard as well; a push
  decision only pushes a branch to its own remote branch (main moves through a decided merge).
  A mixed question is split: the decidable parts are answered, the hard part escalated with what was already answered.
- **Correct at the end:** a "Decided for you" list (dashboard, `GET /api/manager/decided`) and a daily digest of every
  answer the manager gave on the owner's behalf, with one-tap revert (merge, push, deploy rollback) or a prefilled
  correction, and the same summary spoken in voice mode.
- **G2 hands-free:** voice mode reads each open question with its options, takes a spoken answer mapped to an option
  (a sensitive option needs a spoken "confirm"), speaks a digest of the last hour, and works with headset / car buttons.
  Platform limits are documented in [VOICE](../../VOICE.md); phone checks are MANUAL.


## 16. One central lease service (2026-10-14)

Owner: "We need to rethink the lease process and make sure our new codebox centralises it, because it is a main point of
blocking for dev, test and deployment." Addendum: "you are blocking dev with a lease when you just wait".

- The mycodebox server becomes the single authority for leases and the deploy queue; `vpt-lease` becomes a thin,
  compatible client. Typed resources (env, frontend, server, host, device) and a symmetric conflict matrix: a frontend
  deploy never waits for a device run, a device run never blocks another device on the same host.
- Never ask, wait: a busy resource gives a ticket in a FIFO queue with an estimated start; no agent asks the owner about
  a lease, the manager answers lease questions from the service.
- No ghost holds: TTL, opt-in heartbeats, session liveness; idle exclusive holds and holders that only wait become pins
  (`exclusive` / `observe` / `pin`). Owner force-release from the Leases view.
- One rule text (`docs/LEASE-RULES.md`), rendered into the deploy skill; round 9 item 6 folds in here.
- The fleet is switched by the owner side after a shadow period; the order (the deploy script fails closed first) and the
  rollback are in [LEASES-CENTRAL §10](../../v2/LEASES-CENTRAL.md#10-shadow-period-cut-over-rollback).
