# No wait while an equivalent resource is free (owner, 2026-10-31)

Owner: "We need to ensure agents are not waiting for a lease or a device when we have another one available. Here they
were waiting hours on one web host when other hosts are available."

## What went wrong (2026-10-31)

| Wait | Cause |
|---|---|
| Sessions waited on web host B for 16+ min (and "until the deploy releases") while web host A was free | A claim names one host; nothing knew the two are equivalent |
| Every session needing any lab host waited 10-12 min | `deploy start` of a host deploy grants one system lease on ~20 hosts, released only at `deploy finish` |
| A host claim waited ~40 min on a device lease of another device on the same host | Correct by the matrix (a host claim means a vpt-host restart), but the claimer only needed one device and was not told |
| Waits on idle holders past their expected time | The nudge existed but waited 10 min, and lease stops still woke the manager |

## Design

1. **Equivalent claim.** `claim` accepts `any: <group>` (from an inventory file on the registry host, data:
   [LEASE-INVENTORY](../LEASE-INVENTORY.md)) and/or `alternatives: [[...], ...]`. The service evaluates each option inside
   its one mutex and grants the first free one; when none is free, ONE ticket carries all options (`alts`) and the ticket
   granter tries each option in order, so it is granted whichever frees first. The ticket's displayed resource (and its ETA,
   queue position, yield and hold accounting) is the option with the soonest ETA. Fairness: an earlier named ticket on a
   member still goes first (the granter's `earlier` list). Client: `--any`, `--alt`, stdout line 2 `resource=<granted>`,
   `run` exports `VPT_LEASE_RESOURCE` / `VPT_LEASE_HOST`, `vpt-lease inventory <env>`.
2. **Rolling deploy lease.** New `deploy release-hosts <id> --hosts h` (runner client only): records `doneHosts` on the
   running deploy (it no longer blocks claims there) and drops `host:h` from its system lease. The deploy runner parses
   update_core.sh's existing `VPT_PROGRESS` lines and releases a host once it reported `health ok|skipped` AND the run moved on
   to another host (the secondary-server catch-up of a host runs after its health line). No change to update_core.sh. Not yet:
   hosts the deploy has not reached are still held from the start (needs update_core.sh to claim per host: proposal below).
   Switch: `GHOSTY_DEPLOY_ROLLING=off`.
3. **Wait watchdog.** `lease-nudge.js` (2-min tick, no AI): the wait threshold is 5 min (was 10); a waiting ticket with a
   free equivalent (`equivalents_free` in the ticket view, computed by the service from the inventory) or blocked only by
   device leases (`hint`) gets one line in the waiter's chat with the exact commands. A lease or deploy stop of a session
   that has a live ticket, or waits on a queued/running deploy, is journaled as `lease:system-wait` and dropped by
   `manager-event-filter.sh`: no manager wake for a wait the system resolves.
4. **Host vs device.** No semantic change: a host claim means a vpt-host restart or host maintenance, which breaks device
   runs, so it must wait for them. Instead the service says so (`hint`) and points at the narrow `<host>/<device>` claim.
5. **Rules.** LEASE-RULES (rendered into the deploy skill), AGENTS.md and the cbsession brief say: never wait on a named
   resource while an equivalent is free, with the commands.

## What the owner/manager installs (registry host; not done by the branch)

The lease service and its client run on the registry host from copies, not from this checkout:

1. Back up: `cp -a ~/mycodebox-lease ~/mycodebox-lease.bak-<date>` and `cp -a ~/bin/vpt-lease ~/bin/vpt-lease.bak-<date>`.
2. Copy from main after the merge: `lease-service.js`, `lease-routes.js`, `scripts/lease-serve.js` into `~/mycodebox-lease/`
   (same layout), `scripts/vpt-lease` to `~/bin/vpt-lease`.
3. Restart the service: kill its `node scripts/lease-serve.js` pid (the minute cron `~/bin/mycodebox-lease-serve.sh` starts it
   again; the journal replays, tickets survive). Do it while no deploy runs.
4. Write `<LEASE_DIR>/inventory.json` ([format](../LEASE-INVENTORY.md)); start with the two web hosts as group `web`.
5. Check: `vpt-lease inventory node1-vpt`, `vpt-lease claim node1-vpt --any web --agent codebox:check --kind host --ttl 1` then
   release it.
6. Render the deploy skill: `node scripts/render-deploy-skill.js --in ~/.claude/skills/deploy/SKILL.md --out <tmp>` and move it
   into place.

Rollback: restore the two backups and kill the service pid again (cron restarts the old one). A journal written by the new
service carries `alts`/`doneHosts` fields the old code ignores; nothing else changes format.

## Proposal (not built): per-host deploy claims in update_core.sh

To stop holding hosts the deploy has not reached yet, update_core.sh would claim each host right before it deploys it
(`vpt-lease claim <env> <host> --deploy-id $VPT_DEPLOY_ID --kind host --wait`, granted at once unless a run took it, then
the existing sync-only/catch-up path) and `deploy start` of a host deploy would grant an empty system lease. That changes
the deploy's safety argument (a host can be taken between plan and deploy), so it is a reviewed update_core.sh change in
the VirtualPyTest repo, installed by the manager under the lease, not part of this branch.
