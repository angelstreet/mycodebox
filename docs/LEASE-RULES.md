# Lease rules

One rule text for every agent and session. The deploy skill gets this text rendered into its lease section
(`scripts/render-deploy-skill.js`); do not keep a second copy. Design: [docs/v2/LEASES-CENTRAL.md](v2/LEASES-CENTRAL.md).

## What to claim

Claim the narrowest resource that covers the work. `<env>` is the platform name, `<agent>` is `codebox:<tmux session>`
or `mac:<name>`.

| Work | Claim | Mode |
|---|---|---|
| Frontend deploy | nothing on the backend; `frontend` only if you deploy it yourself (the deploy queue claims it) | exclusive |
| Server deploy or server restart | `server` | exclusive |
| Host deploy or host maintenance | `<host>` | exclusive |
| Run on a device (remote keys, channel changes, scripts) | `<host>/<device>` | exclusive |
| Whole-environment deploy or maintenance | `*`, only when nothing narrower fits | exclusive |
| Reading archives, frames, logs, copying chunks read-only | nothing, or the resource with `--mode observe` | observe |
| "Keep this channel or state until I am done" | the resource with `--mode pin` | pin |

- Sensitivity (`--kind`): a host or device claim defaults to `host` (only a restart of that host breaks you), so it never
  holds up a server deploy. Add `--kind server` when a server restart breaks you (a run that needs the server API, the UI,
  MCP or take-control the whole time); a server-kind lease queues every server deploy of the env until it ends, so keep it
  short and release it as soon as the run is done (owner, 2026-11-01).
  A `--shared` hold of `server` (the CI lease guard: "do not restart it") does not conflict with a server-kind host or device lease,
  so a device run never turns CI red (bug-ad68f59e); a non-shared `server` claim (a deploy) still conflicts with both.
- A routine restart of a vpt-* service on a lab host (`systemctl restart <unit>`) needs that host's lease (`--kind host`) only, never the server or an env-wide lease, and does not wait for the owner.
- A frontend change never needs a backend or device lease, and a run on one device never blocks another device.
- Deploys go through the queue: `vpt-lease deploy request ...`, then `vpt-lease deploy wait ...`. Never run a deploy
  script by hand around the queue.
- Deploys go through the integration lane: `integrate request <branch> --deploy <scope>`. The lane merges, tests, waits for CI and
  then queues the deploy (approved, agent `integration:<id>`) and waits for it; you do not request or run the deploy yourself.

## Never wait on one resource while an equivalent one is free (owner, 2026-10-31)

Hours were lost waiting on one web host while the other was free. When the work can run on any of several hosts or devices
(any web host, any Android TV of a model), do not name one and queue:

- `vpt-lease inventory <env>` lists the groups of equivalent resources and which members are free now.
- `vpt-lease claim <env> --any <group> --agent <agent> --kind host --wait` (or `vpt-lease run <env> --any <group> ... -- <cmd>`)
  is granted the first free member at once; when all are busy, one ticket waits on all of them and gets whichever frees first.
  stdout line 1 is the lease id, line 2 `resource=<granted>`; `run` passes it to the command as `VPT_LEASE_RESOURCE` and
  `VPT_LEASE_HOST`. `--alt <resource>` (repeatable) names equivalents that are not in a group.
- A busy named claim prints `FREE EQUIVALENT NOW: <resource>` when a member of its group is free: claim that one instead. A
  ticket that has waited 5 minutes while one is free gets the same advice in the session's chat (lease watchdog).
- A group that lists too few members is not a reason to wait (owner, 2026-11-01: a session waited ~3 h on one web host while other
  lab hosts were free, because only two hosts were in the `web` group). If every member is busy for more than a few minutes, look at
  the other hosts of the same kind (`vpt-lease list <env>`), claim a free one, check read-only that the app, login or profile and
  firmware work there, and run on it. Report the hosts that work so the manager adds them to the group; a host that fails the check
  is named in one line with what is missing. The lease watchdog says nothing when no healthy free equivalent exists (unique hardware, a single-member group, every other member busy or unhealthy): keep waiting.
- Verification that needs the deploy to finish (integration lane) is not a device wait: do not hold or queue for a device before the deploy is done.
- Auto-equivalent (owner, 2026-11-01; immediate and health-aware since 2026-11-10): a `claim --wait` / `run` of ONE named resource that
  belongs to a group never waits while a healthy member is free. If one is free when the ticket is made, the client cancels the ticket
  and claims that member at once; a ticket already waiting is re-evaluated at every poll, so the moment something frees the claim moves.
  It prints `auto-equivalent: <named> is busy and <member> is free and healthy: took <member> at once`. Read `VPT_LEASE_RESOURCE` (set by
  `run`) instead of assuming the name you asked for. Opt out with `--no-auto-equivalent` for work tied to that one unit (its account,
  firmware, a physical setup). `--verify-profile "<cmd>"` is a hook: before switching, `<cmd>` runs with
  `VPT_LEASE_CANDIDATE=<resource>`; a non-zero exit skips that member (use it to check the app, login or firmware).
  `VPT_LEASE_SWITCH_AFTER=<seconds>` adds a delay (default 0). Central mode only. `vpt-lease inventory` shows the holder per member.
- Exactly the named resource / actual resource (owner request, 2026-11-11, fp194-opus-status): `--no-auto-equivalent` means exactly the
  named resource: the claim waits for it, never moves, and `run` refuses to start (exit 8) if the lease is on anything else. (Bug: the
  ssh/forwarded path did not pass the flag to the registry host, so `run ... vpt-mf1/device3 --no-auto-equivalent` got device2.)
  When a claim does move (auto-equivalent, `--any`, `--alt`), `run` exports the ACTUAL resource as `VPT_LEASE_RESOURCE`,
  `VPT_LEASE_HOST` and `VPT_LEASE_DEVICE`, prints `granted <res> — SWITCHED from <named>` on stderr, and `claim` prints a second stdout
  line `resource=<actual>`. A `run` whose command line names the original `host/device` literally (or host and device as separate words)
  is refused after a switch (exit 8, lease released) unless `--allow-switch`: use `$VPT_LEASE_RESOURCE` / `$VPT_LEASE_DEVICE` in the command.
- Healthy only: a member whose host does not answer or whose device is absent is `UNHEALTHY` in `vpt-lease inventory` / `list`, never
  `free-equivalent`, never switched to, and skipped by `--any` ([LEASE-INVENTORY](LEASE-INVENTORY.md) "Health").
- Enforcement (owner, 2026-11-10): the watchdog types the exact command into a waiting session's chat after 30 s (not 5 min) when its
  ticket has a healthy free equivalent. A final `STATUS: waiting: lease ...` while one exists is refused by the done-check: one push with
  the command, then the manager is told if the session stops on it again. Use `--any <group>` from the start.
- Real equivalents only (owner/manager, 2026-11-10): a candidate on the known-broken list, on an unreachable host, with no working control
  path, or registered on a different backend server than your testcase is never offered ([LEASE-INVENTORY](LEASE-INVENTORY.md) "What makes
  a candidate a real equivalent"). If you must stay on one device, say which difference makes the others unusable in your STATUS line
  (model, firmware, server registration, known broken); the done-check accepts that and refuses a bare "needs exactly X".
- Wide and narrow groups: use the operator-wide group (`stb-<operator>-any`) when the run does not depend on the box model, the narrow
  one (`stb-<model>`) when it does ([LEASE-INVENTORY](LEASE-INVENTORY.md) "Which group a script may use").
- Only unique hardware (one Mi box, the Apple TV, a specific set-top box or firmware) is worth a queue. The groups are data on
  the registry host ([LEASE-INVENTORY](LEASE-INVENTORY.md)); a missing group is fixed there, not by waiting.

## Host lease or device lease

- A device run (scripts, remote keys, take-control on one device) claims `<host>/<device> --kind host`. It never waits for a run
  on another device of the same host.
- A host lease (`<host>`) is for work that disturbs every device of the host: a vpt-host restart, a deploy, host maintenance. It
  waits for the device runs on that host, by design: restarting vpt-host breaks them. A host claim blocked only by device leases
  prints `HINT: blocked only by device lease(s) on ...`: if you need one device, claim that device instead.
- Restarting one device's own unit instance (the per-device BLE/HID daemons and per-device stream, grabber and monitor-img
  instances, see REFERENCE) needs only `<host>/<device>` of that device and is blocked only by another session's lease on the same
  device. Name the device in the request (`device5`); host-wide units such as vpt-host keep the host lease.
- Enforced, not just a rule (bug-486f0188; installed 2026-11-11): the codebox PreToolUse hook `scripts/session-guard-hook.js` (installed into `~/.claude/settings.json` by `scripts/install-guard-hooks.js`; it also runs the older `lease-guard-hook.js` check) refuses `systemctl restart` of a device-driving unit on host H while another session's lease covers H or one of its devices (message names lease id, holder, expiry); deviceless units (vpt-kpi, vpt-avq, vpt-archiver, vpt-timeline) stay allowed, there is no `--force`. Since 2026-11-11 it also refuses `systemctl restart|stop` of a vpt-* unit on a host this session holds no lease on, and after a `vpt-lease claim` whose result is not checked (`;`, `||`, newline or a pipe between them): chain with `&&` or use `vpt-lease run ... -- <cmd>`. See [REFERENCE](REFERENCE.md#session-guard-hook-owner-2026-11-11).

## How to claim

1. Use `vpt-lease run <claim args> -- <command...>`: it queues if busy, heartbeats while the command runs and releases
   when it ends, also on failure or interrupt. Or use `vpt-lease claim ... --wait`.
   A waiting claim ends with the work that started it (owner 2026-11-11, after the Mi was held ~11 h by an idle session's waiters):
   the client cancels its ticket and exits when its parent process is gone (`VPT_LEASE_WAIT_ORPHAN=off` opts out), when its
   `codebox:<session>` was closed (exit 130), or after `--max-wait <min>` (default `VPT_LEASE_MAX_WAIT_MIN`, 240; `0` = no bound; exit 3:
   claim again if you still need it). A waiter is granted once and exits: a forwarded waiter whose connection drops right after the
   grant adopts that lease (`adopted, not claimed again`) instead of queueing a second time. When you finish or abandon the work, still
   kill your own waiter (`kill <pid>`) or `vpt-lease release --agent <agent>`.
2. Add `--expect <minutes>` so the queue can estimate when you are done.
3. Never poll in a loop, never ask the owner whether a lease is free, never use `--force` and never kill another
   agent's lease. Busy means wait in the queue: the answer to "who holds it and when is it free" is on stderr or in
   `vpt-lease list`.
4. To keep working while you wait: `vpt-lease claim ... --ticket` prints the ticket id and the ETA and returns at once;
   later `vpt-lease ticket <id> --wait`.

## While you hold a lease

- Heartbeat: `run` does it for you; otherwise `vpt-lease heartbeat <id> --active` while you use the resource. Only `run` and
  other heartbeating leases (those that declared a heartbeat interval) are released when their heartbeats stop; a plain
  `claim; work; release` keeps working and is bounded by its TTL.
- **Holder death (owner 2026-10-27):** a dead holder never blocks a device. The service records a local holder pid with its start time: the
  claim's `holder_pid` (`vpt-lease claim ... --holder-pid <pid>` or `$VPT_HOLDER_PID`; pass the pid of the long-lived dispatcher/script, never
  of a shell that exits after the claim) or the `-<pid>` of an agent named `codebox:<name>-<pid>`. If that process is gone, or the pid now has
  another start time (reuse), on 2 consecutive checks 30 s apart, the lease is released with reason `holder-gone`, journaled in the lease events
  and the owner feed ("released stale lease X: holder pid N is gone"). Only exclusive, non-system, non-deploy leases; a pid that was not alive at
  claim time, a pid from another host, `pin`/`observe` leases and leases without a pid keep TTL behaviour. `mac:*` agents are on another
  machine: they rely on `heartbeat_s` (`vpt-lease run`) and TTL only. Never release another holder's lease by hand: this does it.
  **Who checks:** the registry host cannot see the pids of processes on other machines, so on codebox the dashboard's `lease-holder-reaper.js` does the
  check every 30 s (holder_pid + holder_host == this host, else the `-<pid>` of a `codebox:<name>-<pid>` agent, which counts only after it was
  seen alive once and never while a dashboard session of that name exists) and releases with `--by lease-holder-reaper --reason "holder-gone: ..."`.
  **A codebox claim always has a holder (owner 2026-11-11):** an exclusive `claim` / `run` by `codebox:<session>` made on codebox records that
  tmux session's pane pid as `holder_pid` (unless `--holder-pid` / `$VPT_HOLDER_PID` names one; `VPT_LEASE_AUTO_HOLDER=off` opts out), so
  closing the session frees its leases within a minute. **Unused grant:** a lease of a `codebox:<session>` agent that another agent waits for,
  granted while that session sat idle, with no heartbeat or renewal and no turn of the session since the grant, is released by the same reaper
  after 10 minutes (`--reason "unused-grant: ..."`; `GHOSTY_UNUSED_GRANT_MIN`, `0` = off). Using a grant means a turn or `vpt-lease heartbeat
  <id> --active` / `renew`. An idle holder that blocks a waiter and whose chat cannot take the watchdog's note is flagged to the manager
  (`lease:idle-blocking`).
  **Idle release (owner 2026-11-11, TASK-239 item 3):** an exclusive lease of a live `codebox:<session>` whose session sits at its prompt (not
  working; no turn, prompt, heartbeat or grant) for 10 minutes (`GHOSTY_IDLE_RELEASE_MIN`, `0` = off) is released on 2 polls
  (`--reason "idle-release: ..."`, `lease-actions.jsonl` `type: idle-release`) and the session is told how to claim again. Never when the session has a
  background task, a cron, a pane task or a child process of its agent, nor for a lease whose holder pid is on another host, a pin, a deploy or a Mac holder (a CLI claim carries a holder pid on this host and does qualify). Switch:
  `manager.json` `leaseIdleRelease` `"dry"` (code default: journal `dryRun:true` only) | `"live"` | `"off"`; live on codebox since 2026-11-12 00:55 UTC. Replay a day against the session transcripts:
  `node scripts/lease-idle-replay.js --day <date> --min 10` (2026-11-11: 7 idle events, 0 wrong). **Idle Mac holder (manager decision 2026-11-13, bug-87be6e11):** a `mac:*` exclusive lease nobody renewed for 20 minutes (`GHOSTY_MAC_IDLE_RELEASE_MIN`,
  `0` = off), with another agent waiting and no run attached (no holder pid, no deploy, not system), is released on 2 polls
  (`lease-actions.jsonl` `type: idle-release-mac`, lease id and reason in the line and in the registry release reason). `lease-nudge` tells the manager at
  10 minutes without renewal. Switch: `manager.json` `leaseMacIdleRelease` `"live"` (default) | `"dry"` | `"off"`. A waiter whose chat could not take the
  watchdog line is journaled once as `flag: chat-cannot-take-note` in `lease-nudges.jsonl` (bug-988c4f48). **A stop on `STATUS: waiting`/`blocked` with a live
  ticket while a healthy equivalent is free** is answered at once (3 s and 25 s after the stop) with the exact claim command (`lease-nudge.js` `answerStop`).
  Reuse is detected by start time: a process that started after the lease was granted is not its holder. The service itself probes only pids
  on its own host. `GHOSTY_HOLDER_REAPER=off` disables the reaper. A dispatcher that exits between ticks (game_dispatch, pokemon_dispatch) must not
  pass `--holder-pid`. A heartbeating or dashboard-tracked (codebox session) exclusive lease with no activity
  for 20 minutes becomes a pin.
  A `--holder-pid` / `$VPT_HOLDER_PID` that is not running on this host at claim time is dropped with a warning (the TTL applies), so a mistyped pid cannot make the reaper release the lease minutes later (bug-81094e7d).
- Release as soon as the work is done: `vpt-lease release <id>`. Do not park a lease "for later".
- A session whose STATUS is `waiting` or `blocked` never keeps an exclusive lease: release it first, claim again when
  you can work. Downgrade to a pin with `vpt-lease mode <id> pin` if you only need the state kept.
- Narrow, do not hold broad: `vpt-lease narrow <id> --kind host` once a server restart no longer matters.

## No lease over 60 minutes (owner, 2026-10-27)

- **Cap:** a claim or renewal never gets a TTL above **60 minutes**, for every kind (device, host, server, env-wide, pin). A longer `--ttl` is
  clamped; the response carries `ttl_clamped_from` and `vpt-lease` prints "max 60 min per claim: release when your step is done and re-queue
  for the next step". The lower of this cap and the priority cap (10 min for P2/P3) wins. Deploy runner leases are system leases and keep
  their own limits.
- **Renewal:** allowed while you heartbeat and nobody waits. When anyone waits (a ticket, a queued deploy) the continuous hold, counted from the
  claim, may not pass 60 minutes: `renew` is clamped to that point, then refused (`hold_cap`, exit 7 like `yield_required`): release and queue
  again (fair rotation). The last clamped renew ends the lease at claim + 60 min, so the next heartbeat gets `E_NOT_FOUND` (bug-11ea0b19, nightly fleet):
  `vpt-lease run` now prints `HOLD CAP ... ends at <time>` at that renew and reports `LEASE LOST: hold cap reached` instead of a bare `E_NOT_FOUND`. A job that must
  hold longer than 60 min while others wait has to split into steps (release, re-queue); the nightly fleet's hold-until-05:00Z design cannot work under the cap.
- **Long work** (a 3 h walk) is split into steps that each claim, run, release, re-queue.
- **Leases from before the cap** (owner, 2026-10-27: "never 240 min"): the service cuts them back to claim time + 60 minutes; one already
  held longer gets 10 minutes to wrap up, then ends. A long lease does not survive the change.

## What to expect in the queue (owner, 2026-10-28)

- `vpt-lease` prints ETAs as `HH:MM UTC` (the registry host runs in CET; an unlabeled local time looked an hour late).
- A catch-up deploy (the restart of a host a deploy skipped) never holds a claim or ticket back while it is only queued; it blocks once it runs.
  After skipping again it waits 10 min before its next try, one pending catch-up per host set (a newer ref replaces an older one), and it yields to a device ticket that has waited over 10 min.
- A queued host deploy gates claims PER HOST (owner 2026-11-11: four free STB boxes, 13 tickets waiting, none granted because two catch-ups
  spanning other hosts waited on a Mi run). It never holds a host it does not touch. On a host its own blocking leases hold, it only stops
  NEW claims of lower priority than the deploy (it counts as P0, so P1..P3), for at most 10 min after it became ready; then they go ahead. Starvation guard: a deploy that has waited 30 min on a host (P1 claims keeping it busy one after another) closes the gate again on every new P1..P3 claim of that host until it starts, so it wins the next gap.
  On a host nothing blocks, the claim waits for the deploy, which is the next to run there (bounded by the same 10 min, and never behind
  another running or older overlapping deploy). A request limited to `--hosts` that is blocked on only some of them starts on the free ones;
  the busy hosts go back to the queue as their own strict request (same ref and age, `split-to=` in `deploy list`); a catch-up also yields per host to a ticket that waited over 10 min, so only the hosts that ticket touches stay queued. A request whose host
  another queued deploy lists at a ref that contains its own loses that host (`superseded-by=`): an older ref never deploys over a newer one.
- `vpt-lease list` / `claim --wait` say what gates a ticket that looks grantable (`note: gated by deploy <id> (<state>, <why>)`).
- `vpt-lease list` prints `OLD CODE  <env>/<host>  restart deferred ...: catch-up <id> ...` for every host a queued or running catch-up deploy covers: that host had its code synced (or was dropped) while leased, so its vpt-host and vpt-kpi still run the code from before that deploy. `--json` carries it as `old_code`. Freeing the host lets the catch-up restart it (2026-11-11).
- A host deploy releases each host as soon as it is done with it (rolling, owner 2026-10-31): update_core.sh reports each host's health,
  and once the run has moved on to the next host the deploy runner drops that host from the deploy lease (`vpt-lease deploy release-hosts`).
  A host the deploy has not reached yet, or is on now, stays held until it is done. Hosts held by a run are synced and restarted later by
  the catch-up, as before.

## Priority: P2 and P3 leases are short, and yield to a higher priority

Every lease and ticket carries the holder's priority P0 (highest) to P3 (background): `--priority P0|P1|P2|P3` on `claim` and `run`, else the
session's own priority (the owner's setting on the dashboard, read from the state dir on codebox), else P1.

- **P3 is for scheduled bots** (hourly runs, cron-started sessions); everything interactive is P0 to P2.
- A **P2 or P3** lease is capped at **10 minutes per claim** (a longer `--ttl` is clamped and says so). A turn is at most 10 minutes: claim
  per turn, release at the end of the turn, claim again with `--wait` for the next one.
- A P2 or P3 lease is **not renewed while a claim of STRICTLY higher priority waits** on a resource it blocks (P2 yields to P0/P1, P3 to P0/P1/P2). An equal-priority waiter changes nothing: first in, first out, 10-minute claims, so two long P2 runs do not preempt each other: `renew` exits 7
  (`yield_required`) and `run` prints `YIELD REQUIRED`. The holder also gets a `lease:yield` message. Stop at the next turn boundary
  and `vpt-lease release <id>`; do not retry the renewal.
- P0 and P1 leases keep the ordinary TTL and renewal rules.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok / free / granted | continue |
| 1 | error or not found; also a refused token (`E_AUTH`) or a missing, loose (not 0600) or empty token file: the call was rejected, nothing was granted | read stderr and fix the call or the token |
| 3 | busy | claim again with `--wait` (or `run`); do not poll |
| 4 | a deploy is pending on the resource | `vpt-lease deploy wait --env <env>`, then claim again |
| 5 | UNAVAILABLE: the lease service cannot be reached | treat as busy, never as free; retry with `--wait` |
| 7 | `renew` only: `yield_required`, a P2/P3 lease cannot be extended while a claim of strictly higher priority waits | stop at the next turn boundary and release |
| 6 | `run` only: the lease was lost during the run (fenced, gone or downgraded); the command itself exited 0 | treat the result as not protected; claim again and redo the protected step |

`vpt-lease validate <id> --agent <agent>` (central mode only; refused with exit 1 in legacy and shadow modes): exit 0 when
the lease is held, exclusive and yours; 3 when not (the reason is printed); 5 when the service is unavailable. Run it
right before each protected step, such as a restart, and stop on anything but 0.
