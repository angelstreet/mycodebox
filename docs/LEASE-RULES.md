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

- Add `--kind host` when only a restart of your own host breaks you; leave the default when a server restart breaks you
  (runs started through the server API, the UI, MCP or take-control).
- A routine restart of a vpt-* service on a lab host (`systemctl restart <unit>`) needs that host's lease (`--kind host`) only, never the server or an env-wide lease, and does not wait for the owner.
- A frontend change never needs a backend or device lease, and a run on one device never blocks another device.
- Deploys go through the queue: `vpt-lease deploy request ...`, then `vpt-lease deploy wait ...`. Never run a deploy
  script by hand around the queue.
- Deploys go through the integration lane: `integrate request <branch> --deploy <scope>`. The lane merges, tests, waits for CI and
  then queues the deploy (approved, agent `integration:<id>`) and waits for it; you do not request or run the deploy yourself.

## How to claim

1. Use `vpt-lease run <claim args> -- <command...>`: it queues if busy, heartbeats while the command runs and releases
   when it ends, also on failure or interrupt. Or use `vpt-lease claim ... --wait`.
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
  Reuse is detected by start time: a process that started after the lease was granted is not its holder. The service itself probes only pids
  on its own host. `GHOSTY_HOLDER_REAPER=off` disables the reaper. A dispatcher that exits between ticks (game_dispatch, pokemon_dispatch) must not
  pass `--holder-pid`. A heartbeating or dashboard-tracked (codebox session) exclusive lease with no activity
  for 20 minutes becomes a pin.
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
  again (fair rotation).
- **Long work** (a 3 h walk) is split into steps that each claim, run, release, re-queue.
- **Leases from before the cap** (owner, 2026-10-27: "never 240 min"): the service cuts them back to claim time + 60 minutes; one already
  held longer gets 10 minutes to wrap up, then ends. A long lease does not survive the change.

## What to expect in the queue (owner, 2026-10-28)

- `vpt-lease` prints ETAs as `HH:MM UTC` (the registry host runs in CET; an unlabeled local time looked an hour late).
- A catch-up deploy (the restart of a host a deploy skipped) never holds a claim or ticket back while it is only queued; it blocks once it runs.
  After skipping again it waits 10 min before its next try, one pending catch-up per host set (a newer ref replaces an older one), and it yields to a device ticket that has waited over 10 min.
- A host deploy still holds every host lease while it runs (about 12 min): device tickets on those hosts are granted when it ends.

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
