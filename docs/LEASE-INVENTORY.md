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
