# AGENTS.md

Guidance for AI coding agents working in, or installing, the `mycodebox` repository.

## Ship rule (read first, owner 2026-11-11)

After a change: run the touched tests / typecheck yourself, commit by explicit path, `git push -u origin <branch>`, then
`integrate request <branch> [--deploy frontend|server|host]`. Never ask permission for these steps and never end a turn
with an offer ("I can ...", "if you want", "should I", "want me to", "nothing is committed") for something the rules
already authorise: do it. Verify UI yourself with headless Playwright (skill `vpt-headless-verify`) instead of asking the
owner to look. Only hard-floor items (data deletion, credentials, money, sudoers, force-push) are questions. End every
turn with a STATUS line.

**The seven STATUS words (owner 2026-11-11). Take the first row that is true.**

| # | Word | Use it when | Never when | Who acts next |
|---|---|---|---|---|
| 1 | `done` | The goal is reached, you have the proof, nothing of yours is still running | A part is open, a worker or job of yours still runs, or it is "merged, not checked" | Nobody |
| 2 | `running` | Work **of yours** is still going: your background job, a worker session you started. You will be woken and continue | Nothing is actually running | Nobody; the harness wakes you |
| 3 | `waiting` | You depend on something **not yours** that ends by itself: a lane request, a deploy, a lease ticket, another session's work, a named time | You could work on something else meanwhile, or nothing will ever end it | Nobody; the harness wakes you |
| 4 | `needs-manager` | You need a decision or an answer (technical, merge, deploy, lease, design) | You have a recommendation and the choice is reversible: decide | Manager |
| 5 | `needs-owner` | Money, customers, deleting shared data, a credential only the owner holds, a physical action | Anything else | Owner |
| 6 | `blocked` | You **cannot work** and nothing running will fix it: someone must act (a device is dead, an access is missing) | Something is running or queued (that is `running` or `waiting`) | Manager |
| 7 | `failed` | You stopped and the goal is **not** reached after you tried what you could | You have not tried, or work is still running | Manager |

Forms: `done — <what> · goal: achieved · evidence: <links / run ids / frames>`; `running: <job id / worker names> — <what is left>`; `waiting: <id / ticket / session / time>`; `blocked: <what stops you> · tried: <list> · need: <who must do what>`; `failed — goal not achieved: <why> · tried: <list>`. "blocked: waiting on ..." is never right. A green / pass / proven claim carries its evidence.

Before you fix a filed bug, run `found-bug --claim <id>` (exit 3: someone else is fixing it).

**Goal first, verification last (owner 2026-11-11).** A task opens and closes with the same list.

- **First**: before any work, the task has `Goal: <one sentence>` and `Done when:` with 1 to 5 numbered lines, each checkable by something other than you: a fact the harness holds (merged, deployed, bug resolved), a command or URL with a pass / fail result, or an observation with an artefact (run id, report link, frame). The brief did not give them: write them yourself as the first thing you say, then work. A line you cannot check is rewritten, not dropped.
- **Time box** (owner 2026-11-11): the opening also carries `Time box: <max duration>` (the brief's, else your own estimate; default 2 h for a fix, 6 h for a feature). At 50% with no `Done when` line passed, say so and change approach. At 100% **stop**: write the `Verification:` block as it stands and end `failed` (or `needs-manager` with what would unblock it); never extend your own time box, the manager or the owner does. The same check failing 3 times with the same error is the same stop, whatever the clock says: a retry loop is not progress.
- **Last**: the final message ends with `Verification:` and one row per `Done when` line, in the same order and numbering: `<n>. pass | fail | not checked — <evidence that resolves, or why>`, then the STATUS line. All `pass` = `done`. Any `fail` or `not checked` = not `done` (`running`, `waiting` or `failed`). Never change the `Done when` list at the end to fit what you did; a line the owner dropped is marked "dropped by owner", not deleted.
- **Failing is not an ending** (owner 2026-11-12): before a `failed` line, investigate until you can name what broke (logs, frames, ledgers, code), or say what you checked and ruled out, and write the next approach. The line carries both: `STATUS: failed — goal not achieved: <why> · tried: <list> · cause: <what the investigation found> · plan: <next approach, who does it>`. A plan that is yours to do inside your time box is done, not written. A `failed` line without `cause:` and `plan:` is sent back once.
- **Done is about the task's goal, not the last request** (owner 2026-11-12): the `Goal` and the `Done when` list are the ones the task opened with. A side request given on the way (pause these deployments, check this, answer that) is reported in one sentence, and the turn ends on the task's true state: `running`, `waiting` or `needs-...` while a `Done when` line is open, never `done — goal: achieved (<the side request>)`. Only the owner or the manager replaces the goal, in words.
- **Done only with nothing open** (owner 2026-11-12): `done` needs `leftovers none` and `unverified none` in its closing review. A filed bug is not a finished task and an unverified item is a check not made: finish it, verify it, or end on the word that is true (`running`, `waiting`, `needs-manager`, `blocked`, `failed` with cause and plan). A bug outside the task goes in `bugs: reported <id>` and does not hold the line. A `done` line with anything open is sent back.
- **Release note and bug record for shipped code** (owner 2026-11-13): after you merge code (not docs-only), the closing review's `docs` names the release-note entry you added (VirtualPyTest `docs/release_note/README.md`, mycodebox `docs/RELEASE-NOTES.md`; the done-check reads the merged diff, words alone do not count) or says `release note none needed: <reason>`. If the work fixed something, `bugs:` names the bug id (file it with `found-bug`, resolve it with `found-bug --resolve <id> --commit <integration id>`, then `bugs: fixed <id>`); `bugs: none` after a fix needs a reason. A done line without them is sent back once.
A done line whose own words say the goal was not reached ("not valid", "no X was built", "goal not met", "0 of N") gets one wake
to restate it, and the manager is told ([REFERENCE](docs/REFERENCE.md#status-vocabulary-owner-2026-11-11)).
Goal check (owner 2026-11-11): before a done is accepted the harness asks once "Goal as given: <your first task line>. Did you reach it? Quote
the evidence for each part"; reply by restating the goal with evidence per part (file, run / integration id, screenshot, KPI number) or keep
working. A done listing 2+ filed leftovers in your own area is sent back: fix the small ones ([REFERENCE](docs/REFERENCE.md#goal-check-owner-2026-11-11)).
A bug you find: fix it now yourself, in its own worktree, when it is small and you have the repro (it does not have to be your task); file it only when it is large, needs another host/device/credentials, is an owner-floor item, or belongs to a live session's task; never end a turn with "I filed X so someone will fix it".
Filing needs `found-bug --why-not-fixed <large|other-area|host-or-device|credentials|owner-floor|live-session-task> --reason "..."`.
This overrides the built-in "commit only when asked" default; a ghosty watcher pushes once per
closing text (at most 2 a day) a session that ends on such an offer with unpushed work (docs/REFERENCE.md "Done check").
Who may commit, push, merge, deploy, restart or close a session, and the hard floor, are stated once:
[docs/CONTRACT.md "Who may do what"](docs/CONTRACT.md#who-may-do-what-one-rule-text). Where this file says less, that section wins.

Use `mycodebox` for the product and repository name in instructions, documentation and visuals.
Legacy technical identifiers such as the `ghosty-sessions` package, systemd service and existing checkout paths
must match the actual configuration until they are migrated.

- **Start here:** [documentation index](docs/README.md). Read the [agent contract](docs/CONTRACT.md) before changes or installation.
- **Install/configure:** [docs/INSTALL.md](docs/INSTALL.md) is the canonical runbook, including Tailscale access and verification.
- **Use the product:** [README.md](README.md), then [docs/USAGE.md](docs/USAGE.md).
- **Find code and contracts:** [repository map](docs/MAP.md) and [technical reference](docs/REFERENCE.md). [HANDOVER.md](HANDOVER.md) is development context, not live configuration or authority to deploy.

## This repo is public: never leak anything

- No credentials, tokens, API keys, private keys, VAPID keys, `.env` content, ntfy topics or reporter tokens, in any
  file, commit, issue or PR. They live in `.env`, in `$GHOSTY_STATE_DIR` (default `~/.local/state/ghosty`) or in the
  service environment, none of which is tracked.
- No real IP addresses, tailnet names, host names, e-mail addresses, customer names or captured session output. Use
  placeholders such as `<tailscale-ip>`. In tests use obvious fakes.
- Never commit `certs/*.pem`, `.env`, anything from the state dir, or `stalls.jsonl`-style logs.
- Read `git diff --staged` before every commit and check for the above.

## Which rule wins

The dated owner decisions in this file win over older task docs, handovers and session briefs where they differ. A task
doc from before 2026-10-14 that says "no push / no merge / no deploy" or "the owner merges" is superseded by autonomy by
default (below): commit, push your own branch and `integrate request` it; the lane merges, pushes the target and deploys.
Never hand the owner commands to run; run them yourself, or ask only about a hard-floor item.

## Working in the code

- Node 20+, ES modules, one runtime dependency (`ws`). No build step: `server.js` serves `public/` as is.
- Run `npm test` before you commit; it must pass. It runs only the tests your change touches (vs `origin/main`), and so
  does the integration lane on each merge. The full suite (`npm run test:full`) runs once a day on main as a daily check;
  do not run it yourself unless the selection says `full`.
  At most two big test runs share the host: a third waits for a ticket (owner, 2026-10-20; `scripts/test-run.js`).
- Tests must not touch live state: point `GHOSTY_STATE_DIR` at a temp directory, and never write the live
  `layout.json`.
- The service is `ghosty-sessions` (systemd). Restart it with `scripts/safe-restart.sh`, never during a deploy.
  The guard requires a fresh successful deploy snapshot and refuses unknown or active deployment state.
- Kill only your own processes: `kill <pid>`, `pkill -P <your pid>`, or a pattern naming your own worktree path. Never
  `killall` or `pkill -f "node --test"`-style patterns: the host is shared, and on 2026-10-20 one killed the
  integration lane's test run. A Claude hook on codebox (`~/.claude/hooks/kill-guard.py`) refuses them.
- Never write work-in-progress into the live checkout (`~/ghosty-sessions`): it blocks deploys and risks committing
  secrets. Work in a worktree.
- Run long jobs (runs, suites, builds, deploys) in the foreground of a background shell the harness tracks, so the
  session is woken when they end. Never `nohup`, `setsid`, `disown` or a trailing `&`: the harness cannot see those
  jobs. If you must wait on one, name its pid, log file, run id or deploy id in the `STATUS: waiting` line; the manager
  watches it and wakes the session when it ends (`own-jobs.js`).
- Integration (round 13): commit on your own branch, push the branch, then hand off to the integration lane with
  `integrate request <branch> [--deploy frontend|server|host|full]`. Never merge into the target branch, push the target
  or run the deploy script yourself; the lane merges, tests, pushes, waits for CI and deploys, then tells you the result.
  After `integrate request`, keep working on the next independent item of your task (validation runs, tests, other fixes, the
  leases you need); a docs-only or already-pushed integration never blocks device or validation work. Only when nothing is left that
  does not depend on the result, end the turn with `STATUS: waiting: integration <id>` (the lane wakes you with the result); a returned
  request is fixed on your branch and requested again.
  Never ask the owner, or end a turn waiting on anyone, for a merge or PR decision: run `integrate request`, then continue, or `STATUS: waiting: integration <id>` if nothing else is left.
  See [docs/REFERENCE.md](docs/REFERENCE.md) "Integration lane".
  A branch from a Mac or cloud session (no live session to wake) is queued with `integrate request <branch> --mac <label>`: the result is written to `<state>/integration/external-results/<id>.txt`, the manager relays it (`external-result` event) and the owner is pushed if it does not within 10 min.
  Mac / Remote Control sessions can be messaged: the manager answers `mac:<label>` asks / needs-manager / goal-check events with `SendMessage` to the session name from `ListAgents` (hard-floor items still go to the owner; an offline session is not listed: say so). Only ghosty's own tmux `/api/send` cannot reach them.
- Bugs outside your scope (owner, 2026-10-28; fix-first rule owner, 2026-11-11; `--why-not-fixed` required since the same day): when you hit a bug that is not yours (an endpoint that errors, a pre-existing
  failure, a tool that misbehaves), fix it yourself, in your own worktree, when the fix is small and clear and you already have the
  context (cheapest in tokens and most accurate: the finder knows the repro); ship it with `integrate request` and say so in the
  `bugs:` field. File it with `found-bug` only when the fix is large, needs another area, host, device or credentials, or belongs to a
  live session's task. Filing syntax: `found-bug --title ... --endpoint ...
  --why-not-fixed large|other-area|host-or-device|credentials|owner-floor|live-session-task --reason "..." --repro ... --error "<exact text>" --workaround ... --blocking yes|no` (`scripts/found-bug`: POSIX sh, on PATH on codebox, installed on a Mac like `integrate` ([docs/MAC-HOOK.md](docs/MAC-HOOK.md)); check with `found-bug --help`; if it is missing, POST the same JSON to `$GHOSTY_URL/api/bugs` with curl as shown there and say so; an unreachable manager queues the report locally and `found-bug --flush` posts it); the manager sends the bug back to you once if it looks small, and a
  worker (the bug-drain worker) only when it is large/other-area and no live session owns it. Never leave it in a closing line ("could not", "returned an error", "unrelated", "pre-existing"). A `STATUS: done` line ends
  with `bugs: none | fixed <what> | reported <id>`; without it the done-check pushes once per 12 h.
- Closing review before any `STATUS: done` (owner, 2026-11-10): the owner should never have to ask "any leftover, suggestion of
  improvement or doc to update before we close?". Before the done line, do it yourself:
  1. **Docs**: list every doc or skill your change makes stale (task doc, REFERENCE / MAP / INDEX, user guide, skill, API
     inventory, release note) and update it now, in the repo; never leave a draft in a scratchpad.
  2. **Leftovers**: fix each one now, or file it with `found-bug`.
  3. **Suggestions for improvement**: file each with `found-bug --title "idea: ..." --blocking no`, not as prose.
  4. **Unverified**: name what you did not verify.

  The done line then carries `closing review: docs <updated list|none needed> · leftovers <none|filed ids> · unverified <none|list>`,
  e.g. `STATUS: done — X merged · closing review: docs REFERENCE.md · leftovers none · unverified none · bugs: none`. A done line
  without it gets one automatic push from the done-check with this checklist; leftovers named there that are neither `none` nor
  filed ids are sent back to finish like any other leftover ([REFERENCE](docs/REFERENCE.md) "Closing review").
- Owner-reported bug queues are drained, not negotiated (owner, 2026-10-21): work every reported problem through to
  shipped without stopping to ask "which one next?". Keep the queue explicit, rank it yourself, and take the fixes one
  at a time. Ask only on a hard-floor item, a conflict between two of the owner's requests, or a request too ambiguous
  to act on. `STATUS: done` is only honest when the queue is empty.
- A session ends only when everything is finished (owner, 2026-11-03, supersedes 2026-11-01): `STATUS: not fully confirmed` and `partial` are
  not end states. Finish the work, or stop with `STATUS: waiting: <system wait id>`, `blocked: <reason + what you tried>` or `needs-owner:` for a
  hard-floor item. The done-check sends a session that ends on "not fully confirmed", `partial` or a done line with leftovers back to finish (max 3 pushes a day, then the manager is told).
- UI icons come from `public/icons.js`; add an icon there instead of pasting emoji or one-off SVG.
- Match the surrounding code: terse comments that explain why, no new dependencies without a reason.

## Safety rules of the product

- Claude account rotation (owner, 2026-11-06): when the Claude account in use hits its usage limit, new sessions start
  on the next account with headroom and a session stopped on the limit is parked and resumed on it (same conversation,
  then `continue`). This restart is owner-requested and is not an auto-close. Switch: `autoSwapSessions` in
  `claude-accounts.json` (`claude-account swap off`). Logins are set up by the owner only (`claude-account login <id>`).

- Sessions are never auto-closed (owner, 2026-10-30, bug-9e811bf0; 2026-11-01): no ghosty tick sends `/exit`, `/quit` or kills a
  session on its own. Only the owner or the agent that spawned the session may close it (`DELETE /api/sessions/<s>?confirm=<s>`);
  the manager closes one only when the owner asks for it (owner 2026-11-01). The old worker auto-close (2026-10-18) is removed;
  `workerAutoClose` in `manager.json` is ignored. [CONTRACT](docs/CONTRACT.md#who-does-each-action).


- Equivalent resources (owner, 2026-10-31): never wait on a named host or device while an equivalent one is free. Use
  `vpt-lease claim <env> --any <group> --wait` (groups: `vpt-lease inventory <env>`, data in [docs/LEASE-INVENTORY.md](docs/LEASE-INVENTORY.md)),
  or claim the free one by name (a named `--wait` claim of a group member switches to a healthy free one at once, owner 2026-11-10;
  `--no-auto-equivalent` opts out); claim `<host>/<device>` for a device run, `<host>` only to restart or deploy the host.
- Never wait on a named device (owner, 2026-11-10): use `vpt-lease claim <env> --any <group> --wait`; never wait on a named device
  or end a turn with `STATUS: waiting: lease ...` while `vpt-lease list` shows a free-equivalent for your ticket. A named `--wait` claim
  of a group member switches at once to a healthy free member (`--no-auto-equivalent` only for hardware with its own account or
  firmware); unhealthy members (host down, device absent) are never offered. The done-check refuses such a waiting line
  ([LEASE-RULES](docs/LEASE-RULES.md), [LEASE-INVENTORY](docs/LEASE-INVENTORY.md)).
- Leases (deploys, restarts, test devices): follow [docs/LEASE-RULES.md](docs/LEASE-RULES.md). Never ask the owner about a
  lease: wait with `vpt-lease claim ... --wait` or `vpt-lease run ... -- <cmd>`; never poll, never `--force`.

- Routine device-side restart (owner, 2026-10-27): `systemctl restart <unit>` of an allowlisted vpt-* device/host service on a
  lab host the session leases is a routine step, not a forbidden topic or an owner question; it needs the host lease only.
  Allowlist: `GHOSTY_RESTART_UNITS` (default `vpt-monitor-img,vpt-host,vpt-stream*,vpt-grabber*,vpt-kpi,vpt-ble-remote@*,hid-remote@*,
  vpt-avq,vpt-archiver,vpt-timeline,vpt-audio*,vpt-monitor-audio,vpt-mediamtx`). stop, start-only, enable,
  disable, mask, daemon-reload, unit files, sudoers, `ghosty-sessions`, other units and production hosts stay floor
  ([REFERENCE](docs/REFERENCE.md), `routine-restart.js`).
  Lab-host service families (owner, 2026-10-31: the owner asked the manager to answer lab-host service restarts itself): vpt-kpi,
  the per-adapter BLE daemons (`vpt-ble-remote@*`, `hid-remote@*`), vpt-avq, vpt-archiver, vpt-timeline, vpt-audio* / vpt-monitor-audio
  and vpt-mediamtx joined the default. Same conditions: host lease only, no lease over 60 min, no `--force`, and not while a run holds
  a device lease on that host unless the unit drives no device (vpt-kpi, vpt-avq, vpt-archiver, vpt-timeline). NOT vpt-vnc,
  vpt-websockify, lircd, bluetooth.service, vpt-server, databases, nginx, `ghosty-sessions`, nor anything on a production host.

- Ask the owner only when (owner, 2026-10-31): the item is on the hard floor or physical, it blocks you, and you cannot pick a safe
  default. Before asking for a physical action (replug, power, plug a phone in, release a window on a device) try the software
  equivalent first (USB re-enumeration under the lease, restart of an allowlisted unit, reading the data another way) and name what
  you tried in the question. A non-blocking item with a safe "leave as is" is not a question: leave it and mention it in your
  report. `STATUS: waiting` / `blocked` on a deploy, lease, integration id or an ask already filed is a system wait, not a question:
  do not repeat the ask. At most one open ask per session; say what happens if the owner does not answer
  ([REFERENCE](docs/REFERENCE.md#fewer-better-owner-questions-owner-2026-10-31)).

- The server has no login; Tailscale policy is the only user-access gate. Do not expose it publicly.
  The source defaults to loopback (`127.0.0.1`); follow INSTALL for private Tailscale access.
- Owner's chosen default (2026-10-11): dashboard-created and resumed Claude/Codex sessions and the manager start with permission
  prompts skipped (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) and folder trust pre-accepted.
  `AGENT_CMD_*` overrides win verbatim. V2 orchestration workers keep their own launch modes and refuse bypass flags;
  the exception is MiniMax `mcode exec` workers (developers and reviewers), which run `--permission full`, started in their V2
  worktree (`--cwd` is not a sandbox: they can run any host command, the same threat model as the dashboard default; D-023).
- Autonomy by default (owner, 2026-10-14, OWNER_DECISIONS §15): the AI manager decides merges, pushes, deploys and the
  recommended option itself after an evaluation, records each decision and shows it to the owner, who corrects afterwards; it
  never answers a hard-floor item for the owner. Sessions ship through the integration lane. Who does what, the hard floor
  (deletions of data, credentials and secrets, money, customers, sudoers, units on hosts, destructive or unreadable
  migrations, force-push or history rewrites, tags, publishing) and its dated exceptions (additive migrations 2026-10-21,
  `host-unit-routine.js` 2026-10-25/26, routine lab restarts 2026-10-27/31, ...) are in
  [docs/CONTRACT.md "Who may do what"](docs/CONTRACT.md#who-may-do-what-one-rule-text); the merge evaluation in detail is
  in its Invariants and in [REFERENCE](docs/REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14).
  Automatic answering is on by default since round 8; every capability has a switch.
