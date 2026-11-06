# AGENTS.md

Guidance for AI coding agents working in, or installing, the `mycodebox` repository.

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
default (below): commit and push your own work, merge when the merge evaluation passes, deploy by the normal procedure.
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
- Bugs outside your scope (owner, 2026-10-28): when you hit a bug that is not yours (an endpoint that errors, a pre-existing
  failure, a tool that misbehaves), either fix it in a worktree or file it with `found-bug --title ... --endpoint ...
  --repro ... --error "<exact text>" --workaround ... --blocking yes|no` (`scripts/found-bug`, on PATH on codebox); the manager then sends a
  worker. Never leave it in a closing line ("could not", "returned an error", "unrelated", "pre-existing"). A `STATUS: done` line ends
  with `bugs: none | fixed <what> | reported <id>`; without it the done-check pushes once.
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

- Sessions are never auto-closed (owner, 2026-10-30, bug-9e811bf0): no ghosty tick sends `/exit`, `/quit` or kills a session on
  its own. Only the owner, the manager (`DELETE /api/sessions/<s>?confirm=<s>`) or the agent that spawned the session may close
  it. The old worker auto-close (2026-10-18) is removed; `workerAutoClose` in `manager.json` is ignored.


- Equivalent resources (owner, 2026-10-31): never wait on a named host or device while an equivalent one is free. Use
  `vpt-lease claim <env> --any <group> --wait` (groups: `vpt-lease inventory <env>`, data in [docs/LEASE-INVENTORY.md](docs/LEASE-INVENTORY.md)),
  or claim the free one by name (a named `--wait` claim of a group member switches to a free one after 2 minutes by itself;
  `--no-auto-equivalent` opts out); claim `<host>/<device>` for a device run, `<host>` only to restart or deploy the host.
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
  recommended option itself after an evaluation, records each decision and shows it to the owner, who corrects afterwards.
  It must never answer on the owner's behalf about deletions of data, credentials and secrets, money, customers, sudoers
  or units on hosts (except, owner 2026-10-25 and 2026-10-26, `host-unit-routine.js`: a routine, reviewed and merged unit/timer/script install with backup and
  rollback on codebox, a CI runner or another non-production helper or database host; a change that only makes something safer or idempotent, such as
  a migration made re-runnable, a guard added or permissions tightened; and a permission/ownership fix so a service can read its own settings file,
  contents never read or printed. Each is decided and journaled by the manager with a rollback line. Sudoers, new credentials and production
  customer-facing app hosts stay floor), destructive or unreadable database migrations (additive ones are not a floor, owner 2026-10-21, below), force-push or history rewrites, pushing tags or publishing a
  package (full list, any verb form: [REFERENCE](docs/REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14)): the hard floor always wins for
  those. Additive migrations (owner, 2026-10-21): a migration that only adds (CREATE TABLE / INDEX, ADD COLUMN, RLS and
  policies) can always be applied and merged without asking: the session applies it itself, then `integrate request`
  merges it with no `--approved-by` / `--migration-applied` (still accepted, ignored) and journals `migrationAdditive: true`;
  only a destructive or unreadable migration is returned to the owner. Merges are an evaluated manager decision (owner, 2026-10-14): the
  manager answers "merge" only when the branch merges cleanly (or only in convention files such as `VERSION.txt`), the
  session reports its tests green on that branch (or the change is docs-only; test code needs the green report), the diff touches no secrets,
  migrations, sudoers or units, and Jev (or the manager's own reasoning when Jev is unavailable) rates it safe at or
  above `mergeMinConfidence`; otherwise it escalates with the reason. Every merge decision is journaled
  (`merge-decisions.jsonl`) and shown in the owner's feed. A merge+deploy question is split: merge decided, deploy
  escalated. Pushes and deploys follow the same pattern (a deploy only through the deploy queue, leases free, tests green,
  no migration, with a rollback line). Automatic answering is on by default since round 8; every capability has a switch.
