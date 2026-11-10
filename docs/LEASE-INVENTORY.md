# Lease inventory: groups of equivalent resources

`vpt-lease claim <env> --any <group>` and the lease watchdog need to know which hosts or devices can stand in for each
other. That knowledge is data, kept next to the lease service, not code: `<LEASE_DIR>/inventory.json` on the registry
host (`LEASE_DIR` of `scripts/lease-serve.js`, default `~/.local/state/mycodebox-lease`). It is not in this repository,
because it names real hosts.

## Format

```json
{
  "*": { },
  "<env>": {
    "web":        ["<web-host-1>", "<web-host-2>"],
    "android-tv": ["<host-a>/<device1>", "<host-b>/<device3>"],
    "stb-<model>": ["<host-c>/<device2>", "<host-d>/<device1>"]
  }
}
```

- Top-level keys are environments (`node1-vpt`, ...); `"*"` applies to every environment.
- A group is a list of interchangeable resources, in the spelling of a claim: `<host>` or `<host>/<device>`. Members are
  tried in list order, so put the preferred one first.
- Put a resource in a group only if any session that needs the group can use any member without changing its work: the
  same app, the same model and firmware line, the same login state. When in doubt, leave it out: a missing member costs a
  wait, a wrong member costs a wrong result.
- Unique hardware (a single box of a kind, a device with its own account or firmware) is in no group and stays named.
- Rule for a group: same app, same model/firmware line, same login state. Split by what the work needs, for example a web
  group per browser profile that is logged in to the app, one group per set-top-box model, one per Android phone family.
  Method for building the groups (the survey itself names real hosts, so it stays in the manager's state dir, not here):
  list every host and device from the backends' host listing, take kind, model and app from it, check login state per
  member, then count each member's idle share from `vpt-lease events`. Members that match on all three go in one group.
- Sessions that name one member and wait are moved to a healthy free group member by `vpt-lease` itself at once
  (auto-equivalent, [LEASE-RULES](LEASE-RULES.md)); that makes a wrong member costly, so keep groups strict.
- A resource may be in several groups (a host that runs both the web app and an Android device).

## Updating it

Edit the file on the registry host; the service reads it again on its next claim (it watches the file's mtime), no
restart. A broken file is logged and counts as "no groups": named claims keep working, `--any` answers
`unknown resource group ... (known: none)`. Check the result with `vpt-lease inventory <env>`. Journal the change in the
manager's actions like any other host data change.

## Growing a group

A group that is too small makes sessions wait while compatible hosts sit idle (2026-11-01: only two hosts were in `web`; a
session waited ~3 h). When a session reports that another host passed the read-only check (same app, same login or browser
profile, same firmware line), add it to the group. Do not wait for the next incident: sweep each environment's hosts of a kind
and list them. A host that failed the check stays out; note what is missing (login, profile, driver) in the manager's journal.

## Health: "free" is not "usable" (owner, 2026-11-10)

An equivalent counts only if it is healthy. `<LEASE_DIR>/health.json` (read again when it changes) says which hosts answer and which
devices are present; the service uses it everywhere it offers or picks a member:

```json
{ "<env>": { "at": "<ISO time>", "hosts": { "<host>": { "up": false, "reason": "host <host> does not answer" } },
             "devices": { "<host>/<deviceN>": { "present": false, "reason": "..." } } } }
```

- A host with `up: false` makes every device on it unhealthy; a device with `present: false` is unhealthy on its own.
- An unhealthy member is shown as `(UNHEALTHY: <reason>)` in `vpt-lease inventory`, listed as `unhealthy-equivalent=` on a ticket
  in `vpt-lease list`, never offered as `free-equivalent`, never auto-switched to, and skipped by `claim --any <group>` (every
  member unhealthy: `E_INVALID no healthy member in group ...`).
- No data, or data older than 15 minutes, means unknown, and unknown counts as healthy: a dead probe never empties a group.
- `scripts/lease-health-probe.js` writes the file: run it from a 1-minute timer on the registry host. It makes one TCP connect per
  host named in `<LEASE_DIR>/health-targets.json` (`{ "<env>": { "hosts": { "<host>": "<address>:<port>" or `{ "addr": "<address>:<port>", "expect": "SSH-" }` (a forwarded port can accept a connect with nothing behind it), "devices": { ... } } }`),
  3 s timeout, so no polling storm. Both files name real hosts and stay out of the repository. A device census may write
  `devices` entries too.

## Which group a script may use

Two groups per STB family, because runs differ in what they need:

| Group | Members | Use it for |
|---|---|---|
| `stb-<model>` (for example `stb-stb4`) | the boxes of one model | a run that needs that variant: model-specific UI, firmware line, a keymap |
| `stb-<operator>-any` (for example `stb-orchtnet-any`) | every box of the operator's STB app: each model and each copy of a model | a run that does not depend on the box model: navigation, home tabs, settings read, live TV, capture-level checks |

A script declares "any STB is fine" by how its runner claims: `vpt-lease run <env> --any stb-<operator>-any -- <cmd>`, then it reads
`VPT_LEASE_RESOURCE` (`<host>/<device>`) to learn which box it got and never hard-codes the name. A virtual script / test case states
its group in its description (`lease group: stb-<operator>-any`) so a reviewer can see it. A script that needs one model or variant
uses the narrow group and says why. A member of both groups is fine (a resource may be in several groups). Keep the rule of this file: a run
that reads model-specific text (version strings, About page) must not use the wide group. The member list of the wide group
is the union of the operator's STB groups; the real host and device ids live in the registry host's `inventory.json`, proposed in the
manager's state dir (`inventory-proposal.json`, journaled by the manager when applied).

## What makes a candidate a real equivalent (owner/manager, 2026-11-10)

"Free" and "same group" are not enough. A candidate is refused, with the reason shown in `vpt-lease inventory` / `list` and in the push, when
1. it, or its host, is on the **known-broken** list (a device until its bug is fixed: for example a hung IR dongle),
2. its host does not answer, or the device is absent or not working (no control path),
3. it is not registered on the **same backend server** as the claimant's resource (a testcase lives on one server and can only run on the
   hosts that server lists).

The data is one file per consumer, same format, per env or `"*"` (`lease-equivalence.js`); no freshness limit, the owner or manager edits it:

```json
{ "<env>": { "known_broken": { "<host>/<deviceN>": "<why, bug id>", "<host>": "<why>" },
             "servers": { "<server>": ["<host>", "..."] },
             "hosts": { "<host>": { "up": false, "reason": "..." } },
             "devices": { "<host>/<deviceN>": { "working": false, "reason": "..." } } } }
```

- `<LEASE_DIR>/equivalence.json` on the registry host, read by the lease service (merged with `health.json`). The service now imports
  `lease-equivalence.js`: install it with `lease-service.js` and `scripts/lease-serve.js`.
- `<state>/lease-equivalence.json` (`~/.local/state/ghosty`) on the dashboard, which filters what the watchdog and the done-check offer
  even when the registry's own service is older. Edit it when a device breaks and remove the entry when it is fixed.
- The server rule applies only when `servers` is given and the claimant's host is listed in it; a host listed on no server is refused
  as "registered on no backend server". Keep `servers` complete for the hosts it names.
- A session that must stay on its device answers with a STATUS line that names the difference: `STATUS: waiting: lease <t-id> ...:
  needs exactly <device>, the other box is another model / firmware / not registered on the testcase's server / known broken`. The
  done-check accepts such a line; "needs exactly X" with no difference is pushed again. The push lists what was not offered and why.
