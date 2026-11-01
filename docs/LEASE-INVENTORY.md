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
- Sessions that name one member and wait are moved to a free group member by `vpt-lease` itself after 2 minutes
  (auto-equivalent, [LEASE-RULES](LEASE-RULES.md)); that makes a wrong member costly, so keep groups strict.
- A resource may be in several groups (a host that runs both the web app and an Android device).

## Updating it

Edit the file on the registry host; the service reads it again on its next claim (it watches the file's mtime), no
restart. A broken file is logged and counts as "no groups": named claims keep working, `--any` answers
`unknown resource group ... (known: none)`. Check the result with `vpt-lease inventory <env>`. Journal the change in the
manager's actions like any other host data change.
