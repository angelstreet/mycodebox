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
  `claim; work; release` keeps working and is bounded by its TTL. A heartbeating or dashboard-tracked (codebox session) exclusive lease with no activity
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
- **Leases that exist at the change** are not shortened or killed. They just cannot be renewed past 60 minutes of continuous hold while
  someone waits; a renewal without a waiter is clamped to 60 minutes from now.

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
