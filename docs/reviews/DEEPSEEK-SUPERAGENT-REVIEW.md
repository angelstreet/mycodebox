# Review: the DeepSeek "Super-agent" harness design vs mycodebox (2026-11-02)

Owner request (2026-11-02): read the DeepSeek Harness "Super-agent" article (a Chinese post, machine-translated, "architectural
ideas, not existing features") and find what would improve **our** harness: the mycodebox dashboard (`manager.js`, `stall.js`,
the event feed and wake loop, the integration lane, leases, `found-bug`, the done check, `own-jobs.js`, `resume-task`) and the AI
manager (the operating manual kept in the platform repo). Do not propose what we already do; say what does not fit us; cost in
tokens and plan share, never money.

Reviewer: Fable 5.1, read-only. Sources: `AGENTS.md`, `docs/MAP.md`, `docs/REFERENCE.md`, the manager manual and task doc, the
modules named above, and three days of aggregate numbers from the live dashboard (`GET /api/manager/wakes`, the manager event feed).
No session text, host name or secret appears here; counts are aggregates.

## Summary (5 lines)

1. **We already have most of the article's shape**: an event-driven manager that writes no code, workers in isolated worktrees,
   deterministic event filtering with an LLM shadow, a token-free watchdog, a thin daemon for the Mac, a central lease and deploy
   queue, and per-session wakes for own jobs. On the five modules the article lists we are ahead on three and equal on one.
2. **The measured gap is the manager's wake economy.** On 2026-11-01 the manager woke 652 times, one wake per filtered event
   (no batching in practice), and 84 % of the wakes did nothing. Each wake re-reads the whole context: about 714 M cache-read
   tokens that day, 550 M of them in wakes that did nothing. The article's pass-through and batching ideas address exactly this.
3. **Three proposals carry nearly all the value** (section 4): a debounce window plus a per-kind policy table in the stage-1
   filter; pass-through of session-owned events to the session instead of the manager; and a token-free progress watchdog
   (loop / no-progress) feeding one event. Together they target the 550 M idle tokens and the one failure class we do not detect.
4. **A speculative "reproduce first" worker on `found-bug`** is worth a dry-run trial on the MiniMax plan, behind a switch, because
   161 bug events in 7 days each cost a manager wake and a judgement before any work starts.
5. **What does not fit us**: sharding the router, a stateless cloud loop with persisted sessions, a credential broker, IM-style
   word caps as a hard rule, and "workers never talk to humans". Reasons in section 5.

## 1. Baseline numbers (aggregates, live state, 2026-10-30 to 2026-11-01)

| Day | Manager wakes | Trigger: event waiter / owner / peer | Wakes that did nothing | Cache-read tokens (all wakes) | Cache-read tokens (idle wakes) |
|---|---|---|---|---|---|
| 2026-10-30 | 173 | 144 / 29 / 0 | 150 (87 %) | not sampled | not sampled |
| 2026-10-31 | 470 | 430 / 39 / 1 | 180 (38 %) | 698 M | 135 M |
| 2026-11-01 | 652 | 539 / 70 / 43 | 550 (84 %) | 714 M | 550 M |

"Did nothing" is `manager-wakes.js`'s definition: no alert, no send, no worker, no file write. Cache-read tokens are the sum over
every model call of a wake, so they count the context once per tool round-trip; a wake with five tool calls reads the context five
times. That is the article's point about the router: its cost is dominated by context re-reads, so fewer and shorter wakes beat any
per-wake optimisation.

Events in the feed, last 7 days: 5 702 lines. By kind: `lease` 3 382 (of which `released` 3 082, `expired` 83, `system-wait` 54,
all dropped by the filter; `idle-hold` 78, `nudge` 46, `manager-item` 36 pass), `deploy` 226 (`manager-item` 162 pass), `asks` 222,
`bug` 161, `needs-manager` 78, `told` 70, `leftovers` 32, `orphaned-task` 29, `health` 24, `bug-unreported` 24, `waiting` 22,
`quota` 20, `overlap` 10, and about 60 per-session or per-task keys classified `other`. On 2026-11-01 about 633 events passed the
stage-1 filter and the manager woke 652 times: **one wake per event**, batch size 1.0. The article measured 1.0 at low load and 2.8
at 40 events a minute, because its router queues events during a turn; our `manager-wait.sh` also queues while the manager is busy
(the cursor), but its grace window after the first event is 2 s, so at our load almost every event gets its own wake.

The Jev wake shadow (`jev.pick` on each line) said `ignore` for 1 219 lease and 49 deploy events in 7 days, but it is shadow only
and the deterministic filter already drops most of those; the events that reach the manager and still lead to nothing are mostly the
ones with no Jev opinion at all (`None` on 2 147 lease, 172 deploy, 140 bug, 129 asks lines: skipped by budget or not asked).

## 2. The article's ideas mapped to what mycodebox has

| # | Article idea | mycodebox today | Where | Verdict |
|---|---|---|---|---|
| 1a | Two-level architecture: a long-lived router that talks to humans and executes nothing; workers in isolated sessions, strongest model, never talk to humans | The manager agent "writes no code, merges nothing, pushes nothing" and acts only through the dashboard API and a few CLIs; building goes to MiniMax or Sonnet workers in their own worktrees; a single orchestrating session with teammates was considered and rejected in 2026-10 for the same reason the article gives (one process, one context, one point of failure) | manager manual §2, §5b; `docs/REFERENCE.md` "The manager"; TASK-44 phase 8 | **Equal.** Our router does run Bash (curl, `jev-ask`, `manager-ask`, `resume-task`, `mcode exec`), but every one of those is an action the owner could take from the dashboard, journaled with `by`. Workers do talk to the owner, through one gate (`owner-asks.js` `checkAsk`: question, options, recommendation, floor, "why you"), one open ask per session. That gate is stricter than routing everything through a router, and the owner's complaint (2026-10-31) was the number of questions, not who asks them. |
| 1b | A lighter model for the router | Owner decision 2026-10-04: Opus minimum for the manager; TASK-47 plans a MiniMax loop that calls Sonnet in doubt, gated on the scorecard | manual §0 | **Planned, not proposed again.** The scorecard (`planBudget.claudeWeeklyPct` 10 %) is the measure that decides it. |
| 1c | Batch the events that arrive during a router turn into the next call | `manager-wait.sh` keeps a byte cursor, so events that land while the manager is busy are delivered by the next call; a 2 s grace after the first event | `scripts/manager-wait.sh` | **Missing in effect.** Batch size measured 1.0 (section 1). Proposal P1. |
| 1d | Shard the router only if needed | Not applicable: one owner, one box, 15 to 20 sessions | | Does not fit (section 5). |
| 2a | Event triggers with a deterministic stage-1 filter (source, group, allowlist; "explicit / candidate / ignore" per source) and an LLM stage 2 | Stage 1: `manager-events.js` skips the manager's own events and plain `done`; `scripts/manager-event-filter.sh` (jq) drops routine deploy start/done, routine lease releases and system waits, dedupes repeats for 6 h; `lease-nudge.js` `systemResolvable` keeps lease/deploy stops the system resolves off the manager. Stage 2: Jev's wake shadow on every line and the router shadow on every new stop, shadow only; the Jev `wake` point exists for the manager to ask | `manager-events.js`, `scripts/manager-event-filter.sh`, `wake-shadow.js`, `router-shadow.js`, `router.js` | **Ahead on measurement, behind on policy shape.** The article's per-source policy is a table humans edit; ours is jq inside a script, so adding "ignore `deploy:*:manager-item` while the runner is on" is a code change with a test. Proposal P1. |
| 2b | Threads: consecutive events of one PR / topic; the router creates a worker for the first event, the worker subscribes, later events pass straight to it by code | `pending-wakes.js` keeps a per-session wake (integration result, lease ticket grant) and delivers it when the session stops; `own-jobs.js` wakes a session when the job named in its STATUS line ends; `integration-notify.js` types the lane result into the requesting session; `lease-nudge.js` writes the wait watchdog line into the waiter | `pending-wakes.js`, `own-jobs.js`, `integration-notify.js`, `lease-nudge.js` | **Equal on delivery, missing the "not the router" half.** Every one of those events is still appended to the manager feed and wakes the manager too (`integration:<id>:<state>`, lease `nudge`, deploy `manager-item`). Proposal P2. |
| 2c | Many-to-many subscriptions, so two workers on one PR see each other's events | `overlap-guard.js` tells both sessions once a day when they change the same file; the manager picks the area owner | `overlap-guard.js` | **Equal for our scale** (two sessions on one file is the real case, not two on one PR). |
| 3 | Context as a cache: inline id + summary, spill the rest behind a pointer; every object has an id and inlines related ids (a reference graph for multi-hop recall) | Events carry `session`, `deployId`, `integration <id>`, `bug.id`, `Q<n>`; `manager-wake-summary.sh` prints one line per event; backlog by `GET /api/manager/events?since=`; the manager is fresh every night and told to keep state in files; `/compact` when long | `scripts/manager-wake-summary.sh`, `scripts/manager-fresh.sh`, manual §0 | **Partly there.** Ids exist, but there is no one place that resolves an id of any kind, so a fresh manager reads whole ledgers to recall one thing. Proposal P4. |
| 4 | Speculative execution: on a bug report or an invite, start the work in the background and deliver only if it pans out | `ci-watch.js` starts a fixer session by code on a red main (no LLM in the loop), inside a fix window; `found-bug` reports wake the manager, which dedupes and starts a worker; the leftovers / push watchers prepare the reply the manager sends | `ci-watch.js`, `found-bugs.js`, manual §3 `bug` | **Ahead for CI, missing for bugs.** 161 bug events in 7 days each wait for a manager wake and a judgement before any reproduction starts. Proposal P5. |
| 5a | Full duplex: start()/stop() return at once, results arrive as events | Every long job is harness-tracked (`run_in_background`), the session is woken on exit; `STATUS: waiting: <id>` plus `own-jobs.js` for jobs the harness cannot see; the lane frees at the push and runs CI / deploy as a tail | AGENTS.md "long jobs", `own-jobs.js`, `integration-lane.js` | **Equal.** |
| 5b | Channel norms: IM light (notify only for decisions, 100-word cap), GitHub / mail dense | Push body ≤ 500 chars, question ≤ 140 in the needs-you line; the owner reads only the end of a manager reply, so every reply ends with one "Waiting for you" block, unchanged blocks are not reprinted; routine integration results go to a digest, not the feed; owner questions are the only interrupt alerts | `push.js`, manual §6a, `integration-notify.js` | **Equal in substance.** A hard word cap is not worth a rule (section 5); one small addition in P6. |
| 6 | Separate compute, state and environment; a thin stateless daemon reaches the execution environment; a queued task runs when an intermittently online device reconnects | State is files in the state dir; the Mac is reached through a thin Stop hook (`remote-stops.js`), the lab through the central lease service and the deploy queue; the agents themselves run on the box in tmux | `remote-stops.js`, `lease-service.js`, `deploy-runner.js` | **Equal for our scale.** The "stateless cloud loop" half does not fit (section 5). |
| 7 | Watchdog: an independent session on a schedule that checks infrastructure failure AND semantic progress (looping, drifting), fixes anomalies, answers "why did X fail" | Token-free: `scripts/manager-watch.sh` (dead manager loop, relaunch, one nudge an hour), `scripts/health-watch.js` (disk, load, RAM, runaways, orphaned test runs), daily checks, `done-check.js` (a "done" is checked against git), `done-leftovers.js`, `unfinished.js` (orphaned tasks), usage outliers (3x the project median). Semantic: the manual tells the manager to look for "same reply hash for 30 min while working" in the hourly sweep; no code does it | `scripts/manager-watch.sh`, `scripts/health-watch.js`, `done-check.js`, manual §8 | **Ahead on infrastructure, missing on semantic progress.** Proposal P3. |
| open | Long-term memory, sessions-free UX, A2A, credentials used but never seen | Nightly fresh manager with state in files; the owner's memory directory; `jev-ask` reads the API key itself and never prints it; `found-bugs.js` redacts secrets; the lease service uses per-client tokens | | Open for us too; only the id resolver (P4) is a cheap step. Credentials: section 5. |

The article's A/B result (two-level beat one session plus subagents; a neutral prompt never delegated) matches what TASK-44 found
in 2026-10 without a benchmark, so nothing to change there.

## 3. Where we are ahead (so the manager does not re-propose it)

- **Every automatic action is a switch with a journal**: `manager.json` keys, `by` on every send, `manager-decisions.jsonl`,
  "Decided for you", regret taps. The article has no equivalent of the owner's veto path.
- **Measurement of the filter itself**: the wake shadow labels every event `needed` / `not_needed` 15 min later and the scorecard
  compares Jev with the rules. The article reports one ablation; we have a daily one.
- **Owner-question quality gate** (`checkAsk`), one open ask per session, stale-ask scan, "a question is closed only by another
  question". The article only says the router writes all human-facing replies.
- **Safety floors in code that beat every model** (`FORBIDDEN_RE`, the merge evaluation, the migration classifier by effect, the
  routine-restart allowlist). The article lists security as an open problem.
- **Done is verified, not trusted** (`done-check.js` against git; `bugs:` field; leftovers), and a dead task is found without a
  live session (`unfinished.js`, `resume-task`).

## 4. Proposals, ranked by value over cost

**Status (2026-11-02, owner: "implement the 3"):** P1, P2 and P3 are implemented (see `docs/REFERENCE.md` "Wake batch window and event policy"
and "Progress watch"); P4 to P6 are open.

Cost is tokens on the Claude plan unless said otherwise. "Smallest change" is what a worker should build first; nothing here is
implemented yet.

### P1. Wake economy: a debounce window and a per-kind policy table in the stage-1 filter

- **Article idea**: batch events per router turn (1c); per-source "explicit / candidate / ignore" policy humans edit (2a).
- **Gap**: `scripts/manager-wait.sh` exits 2 s after the first filtered event (`MANAGER_WAIT_GRACE`), so batch size is 1.0 at 633
  events a day; the drop rules live inside `scripts/manager-event-filter.sh` as jq, so each new "this kind is routine" is a script
  change. The kinds that pass today and lead to nothing: `deploy:*:manager-item` (162 in 7 days, written by `deploy-runner.js`
  for a request awaiting approval although the runner is on and approves every request), lease `idle-hold` / `nudge` (124), `told`
  (70, the manager's own relays), per-session `other` keys (about 370 on 2026-11-01).
- **Smallest change**:
  1. `manager-wait.sh`: after the first event, keep collecting for a quiet window (default 60 s) unless the event is urgent
     (`asks`, `needs-manager`, `hold`, `health`, a failed / orphan deploy, `bug` with `blocking`), which ends the window at once.
     One wake then carries the whole batch; `manager-wake-summary.sh` already prints every line.
  2. A policy file `<state dir>/manager-event-policy.json` (`{ "<kind>[:<state>]": "pass" | "ignore" | "urgent" }`), read by the
     filter before its built-in rules; defaults in the repo, the owner's file wins. Seed it with `deploy:manager-item: ignore` while
     `deployRunner` is on, `lease:idle-hold: ignore`, `told: ignore`.
  3. The wake shadow's daily `needed` / `not_needed` per kind (already in the scorecard) becomes the evidence to move a kind to
     `ignore`: a kind at 0 `needed` over 7 days is proposed in the daily report, never flipped by code.
- **How to test**: `test/manager-wait.test.js` and `test/manager-event-filter.test.js` exist; add a batch case (three events within
  the window, one exit), an urgent case (exit at once), and a policy case (an ignored kind never printed; an unknown kind falls to
  the built-in rules). Measure with `GET /api/manager/wakes?day=`: target under 200 wakes a day and an idle share under 50 %.
- **Risk**: a real item waits up to the window; the urgent list bounds it, and the owner's own prompts never wait (they are not
  events). The dedupe file and cursor are unchanged.
- **Value / cost**: the largest lever (section 1: 550 M idle cache-read tokens on one day) for a shell and jq change plus tests.

### P2. Thread pass-through: session-owned events go to the session, not the manager

- **Article idea**: a worker subscribes to its thread; later events of that thread reach it by code with no router call (2b);
  measured 27 % fewer router cache-read tokens at equal completion time.
- **Gap**: ghosty already types the integration result, the lease grant, the own-job end and the wait-watchdog line into the
  session (`pending-wakes.js`, `own-jobs.js`, `integration-notify.js`, `lease-nudge.js`), but every one of them is also a manager
  event, so the manager wakes to read something the session was already told. The feed has no field that says "delivered to the
  session".
- **Smallest change**: when a pending wake or own-job wake is **delivered** to the session, write the manager event with
  `handled: "session"` and let the stage-1 filter drop it; emit the manager event only on the fallback paths that exist today
  (dropped after two timed attempts, session gone, lane `returned` / `merged_ci_red` / `deploy_failed`, which need a decision).
  The manager's hourly `manager-status-scan.sh` still lists every session whose STATUS is a wait, so nothing becomes invisible.
- **How to test**: `test/pending-wakes.test.js` and `test/integration-sessions.test.js`: delivered wake writes a `handled` event
  that the filter drops; a dropped wake writes a plain event that passes. Measure: integration and lease wakes in
  `manager-wakes.jsonl` per day before and after.
- **Risk**: a session that is told and does nothing. Covered by the existing done check, leftovers watcher and the hourly scan; the
  lane's own failure states still wake the manager.
- **Value / cost**: medium value (integration, lease and deploy events are about a third of what passes the filter), small cost;
  do it with P1.

### P3. A token-free progress watchdog for sessions (loop and no-progress), outside the manager

- **Article idea**: an independent watchdog checks semantic progress, not only infrastructure (7).
- **Gap**: `scripts/manager-watch.sh` guards the manager only; `health-watch.js` sees processes, not work; `stall.js` classifies
  stops, so a session that never stops is never classified. The manual's "same reply for 30 min while working" rule is advice,
  not code. The usage outlier flag (3x the project median) is the only signal and it fires late.
- **Smallest change**: a `progress-watch.js` poller (10 min, `manager.json` `progressWatch`: `live` / `dry` / `off`) over live
  agent sessions, no model call:
  - **no-progress**: `working` for longer than 45 min with no reporter turn end, no harness-tracked job (`own-jobs.js` sees one),
    no new commit and no tracked-file mtime change in its worktree;
  - **loop**: in the session's own transcript (the usage tailer already reads these files) the last 8 tool calls contain 4 or more
    with the same tool name and input hash, or the same error text 4 times.
  One feed event `<session>:no-progress` (kind `no-progress`, `items`: the evidence) per session per 2 h, plus a line in
  `manager-status-scan.sh`. Stage 2 is the manager's judgement (it is woken by the event): never Esc, ask Jev's `stop` point with
  the evidence, then either a one-line nudge ("you have repeated X four times; stop, state what you know, pick another way") or
  an owner item with the cost so far. Drift (work that moves but not toward the task) stays with the manager's hourly sweep and
  the task doc; a cheap code rule for it does not exist.
- **How to test**: fixtures of transcript tails (a loop, a long legit build with a tracked job, a quiet session with commits),
  the poller with injected clocks and a fake session list; dry mode journals only.
- **Risk**: false positives on long builds and device runs. The tracked-job and commit checks gate it, and the first weeks run
  `dry` with the journal reviewed in the daily report. Cost: zero tokens; the manager wake it causes is one per real finding.
- **Value / cost**: a failure class we do not see today (a looping session burns its plan window and blocks a device lease) for
  one small module. The manual's §8 row becomes real.

### P4. An id resolver for recall: `lookup <id>`

- **Article idea**: every object has an id, inlines its related ids, and the router recalls by following ids on demand (3).
- **Gap**: ids are everywhere (`Q<n>`, `int-…`, `bug-…`, deploy ids, lease tickets `t-…`, stop ids, `TASK-NN`), each with its own
  endpoint or ledger; a fresh manager (every night, or after `/compact`) answers "what happened to X" by reading whole files.
  `manager-wake-summary.sh` prints the title but not the ids an event carries.
- **Smallest change**: `scripts/lookup <id>` (loopback, read-only) that recognises the id shape and prints one JSON object with
  the record, its state and the related ids (ask → session, stop id, superseded-by; integration → branch, session, deploy id, sha;
  bug → session, resolved-by commit or integration; deploy → request, blocking leases; session → open ask, last STATUS, lease,
  integration). Add the ids to the wake-summary line. No new storage: it reads what the ledgers hold.
- **How to test**: unit tests per id shape against fixture ledgers in a temp state dir; one test that an unknown id prints
  `{"found": false}` and exits 0.
- **Risk**: none to the live system (read-only). Cost: a wake that needs recall spends one tool call instead of reading a ledger
  of thousands of lines into context, which is the cache-read cost in section 1.
- **Value / cost**: medium; cheapest of the list.

### P5. Speculative reproduce-first worker on `found-bug`, as a dry-run trial on the MiniMax plan

- **Article idea**: act ahead on an environment signal, deliver only if it pans out (4).
- **Gap**: `ci-watch.js` already does this for a red main by code. A `found-bug` report (161 in 7 days) waits for a manager wake
  and the manager's dedupe and judgement; the first useful step, reproduce it and name the failing line, is done by the fix worker
  the manager starts later, on the Claude plan.
- **Smallest change**: in `found-bugs.js`, on a new report that is not `test`, not a 24 h duplicate and has a `repro` field,
  start one bounded read-only worker by code (`scripts/cbsession`, MiniMax, 20 min, no lease claims, no commit, no push, no
  deploy, no device): reproduce, record the exact error and the suspect file, propose the smallest fix in `<state
  dir>/found-bugs/<id>-repro.md`. The bug record gets `repro: reproduced | not-reproduced | flaky` and the manager wakes once
  on `bug:<id>:repro-done` with that verdict instead of on the raw report. Switch `manager.json` `bugRepro`: `off` (default) /
  `dry` (journal the brief, start nothing) / `live`. The report's `blocking: yes` bypasses the trial and wakes the manager at
  once as today.
- **How to test**: `test/found-bugs*.test.js` with a fake `cbsession`; dedupe by endpoint plus error hash in addition to title
  plus session; the brief contains the forbidden list.
- **Risk**: the owner's rule that "ghosty never starts a session itself" (`unfinished.js`) is in tension with `ci-watch.js`,
  which does. This needs the owner's switch, hence `off` by default and a journaled `dry` first. A repro worker that touches a
  shared device would break a lease rule: the brief forbids claims, and the worker runs without the lease token. Tokens: MiniMax
  plan (flat), zero Claude tokens until the manager wake.
- **Value / cost**: medium value, medium cost, one owner decision. Below P1 to P4 because the manager wake it saves is one per
  bug, and the worker itself is not free on the box.

### P6. Small channel rules (do with the next owner-asks change, not alone)

- **Article idea**: IM replies light and short; dense channels elsewhere (5b).
- **Gap**: the ask gate checks shape, floor and "why you", not length; a push body can be 500 chars on a phone; the manager's
  pane replies have no cap, but the owner reads only the end, which the "Waiting for you" block already handles.
- **Smallest change**: `checkAsk` refuses a "what it is" over 280 chars or a question over 140; the needs-you push body is cut at
  200 with the rest behind the deep link (the popup shows the full text). No cap on the manager's pane text: the block rule is
  enough and a hard word count would cut the evidence the owner asked for.
- **Test / risk**: `test/owner-asks.test.js`, `test/push.test.js`; the risk is a refused ask, which the gate already reports
  with its reason. Cost: nil.

## 5. What does not fit us, and why

- **Sharding the router.** One owner, one box, under 20 sessions, one manager at about 10 % of the weekly Claude plan. The
  article's trade (continuity for throughput) only matters at tens of events a minute across many humans; our 2026-11-01 peak is
  about 0.5 events a minute, and P1 reduces it.
- **Router with no Bash, and a lighter model for it.** Our manager's actions are CLIs that encode the owner's rules (`manager-ask`,
  `integrate`, `resume-task`, `jev-ask`, `found-bug`); taking Bash away would mean re-implementing each as a tool. The model
  question is already decided by the owner (Opus minimum) and planned for review by the scorecard (TASK-47), not by this review.
- **Workers never talk to humans.** Our sessions ask the owner directly through one gate, with the floor and the "why you" line
  the manager would have to invent on their behalf. Routing every ask through the manager adds a wake and a relay, loses the
  session's evidence, and does not reduce the count, which is what the owner asked for on 2026-10-31.
- **Stateless cloud loop, persisted sessions, BYOM daemon.** The agents are tmux sessions on the box by owner choice (phone over
  Tailscale, subscription plans, no API keys for the loop). The only remote machines we have are the Mac (thin Stop hook, already
  stateless) and the lab (reached through the lease service and the deploy queue). An intermittently online device that runs a
  queued task when it reconnects is not a case we have.
- **A credential broker (use without seeing).** Owner decision D-023: dashboard sessions run with permissions skipped and full
  host access; a session's shell can read any file its user can. A broker that signs requests without exposing the key only
  helps when the agent cannot read the broker's store, which needs a second trust domain (another user or host). What we do
  instead and should keep: keys read by the script that needs them and never printed (`jev-ask`), short-lived auto-sign tokens
  for the platform UI, the lease service's per-client tokens, secret redaction in `found-bugs.js`, the leak scan on every push.
  Revisit only if a worker ever runs under another Unix user.
- **A hard 100-word cap on replies to the owner.** The owner asked for the four-column ask table and the "what it is / why you /
  recommendation" order, which is a shape rule, not a length rule; the block-at-the-end rule and "unchanged" line already keep
  replies short. A word cap would cut the evidence a decision needs.
- **Many-to-many subscriptions between workers.** Two sessions on one file is our real collision, and the overlap guard tells both
  once a day with the manager picking the owner. A subscription bus for the sake of it adds a mechanism without a measured case.
- **Long-term memory as a product feature.** The owner's memory directory and the nightly fresh manager with state in files are
  the right scale; the id resolver (P4) is the one cheap step that makes recall precise.

## 6. Cost summary and order

| Proposal | Claude tokens | Box cost | Owner decision needed | Order |
|---|---|---|---|---|
| P1 debounce + policy table | saves most of the 550 M idle cache-read tokens a day | none | no (a switch and a file) | 1 |
| P2 pass-through | saves about a third of the remaining event wakes | none | no | 2 (with P1) |
| P3 progress watchdog | zero; one manager wake per real finding | one poller, 10 min | no (`dry` first) | 3 |
| P4 `lookup <id>` | small saving per recall | none | no | 4 (cheapest, any time) |
| P5 reproduce-first worker | zero Claude; MiniMax plan | one 20 min worker per new bug | yes (ghosty starting sessions) | 5, after a `dry` week |
| P6 channel rules | nil | none | no | with the next owner-asks change |

Measure P1 and P2 with the numbers in section 1 (`GET /api/manager/wakes?day=`: wakes, idle share, cache-read tokens) one week
after the merge, and report them in the daily report next to the manager's weekly plan share.
