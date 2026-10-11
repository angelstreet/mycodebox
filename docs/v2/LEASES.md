# V2 leases: audit of existing coordination code and the new authority

Scope: spec §12.2 requires every shared mutation (integration/main branch, deploy, host maintenance, service restart)
to hold a lease from an *atomic, fenced, fail-closed* authority, and requires the existing modules to be audited and
reused according to their demonstrated guarantees. This file records what each existing module actually guarantees
(evidence as `file:line` at the commit that added this file) and how V2 uses it.

Terms: **atomic** = check-and-set in one indivisible step; **fenced** = a monotonically increasing token that a stale
holder cannot reuse and that is rechecked before acting; **TTL** = holder loses authority by time alone;
**fail-closed** = "could not observe" blocks the action instead of looking like "free".

## Summary

| Module | What it is | Atomic | Fenced | TTL | On failure | V2 role |
|---|---|---|---|---|---|---|
| `leases.js` | Read-only cached view of the remote registry | n/a (reads only) | no | registry's `ttlLeftMin`, shown only | `{ ok:false }`, cached | input / observer |
| `lease-watch.js` | Poller that releases/narrows registry leases of ended/idle sessions | no (snapshot then act) | no | 2 min grace, 30 min idle | no action on list failure | observer; its automatic release is not authority |
| `handoffs.js` | Local list of "A owes resource to B" intents | file replace via rename, no fsync | no | none (due time only) | corrupt file loads as empty | input only |
| `vpt-locks.js` | Read-only view of VPT device locks | n/a (GET only) | no | server-side | `{ ok:false }` -> "unknown" | input / observer |
| `deploy-runner.js` | Executes registry-queued deploys | only via registry `deploy start` (remote) | no token passed to the deploy | registry expiry (remote) | poll failure -> no start | executor; must gain a lease check |
| `scripts/safe-restart.sh` | Restart guard from a fresh deploy snapshot | no (explicitly) | no | snapshot <= 60 s old | unavailable/invalid -> exit 2 (refuse) | guard; complemented by `service:<id>:<service>` lease |
| `orchestration/lease-authority.js` | New V2 authority | yes (per-resource O_EXCL critical section) | yes (persisted generation) | yes | `E_UNAVAILABLE`, never free | **authority** |

## Existing modules

### `leases.js` — observational cache of the remote registry

- Runs `~/bin/vpt-lease list --json` over ssh on the remote registry host, 3 s connect timeout, 8 s overall
  (`leases.js:6-10`). Only `list` is ever called (`leases.js:17`); the module cannot acquire, renew or release.
- Result cached for 15 s (`leases.js:12`, `leases.js:15`); a failure is cached too (`leases.js:22-23`) and reported as
  `{ ok:false, error }`, not as an empty lease list. Callers can therefore distinguish "unknown" from "no leases".
- Rows are projected to `{ id, env, resource, agent, purpose, kind, ttlLeftMin }` (`leases.js:21`); no generation or
  fencing token exists in the projection, and nothing here can tell whether the registry's own writes are atomic.
- **Guarantee:** a best-effort, up to 15 s stale observation. Not atomic, not fenced. Absence of a row is not proof of
  availability (a row can appear right after the cached read).
- **V2:** input for platform state (UI, scheduling hints). Never authority (ARCHITECTURE §5).

### `lease-watch.js` — registry janitor

- Polls every 30 s (`lease-watch.js:58`, `lease-watch.js:136`). On a failed `list` it records `ok:false` and acts on
  nothing (`lease-watch.js:99-100`): fail-closed for its own actions.
- Decides from a snapshot, then issues a separate `release <id>` / `narrow <id>` call (`lease-watch.js:87-91`,
  `lease-watch.js:114-117`). The decision is not conditional on a generation: if the lease changed hands between the
  `list` and the `release`, this module cannot tell (whether the registry rejects a stale id depends on the registry,
  which is not in this repo). Mitigations are heuristic: 2 min grace for young leases (`lease-watch.js:14`, `:46`),
  two consecutive "ended" polls before a release (`lease-watch.js:108-112`), at most 3 actions per poll
  (`lease-watch.js:15`, `:115`), system holders never touched (`lease-watch.js:16`, `:30`), and idle server leases
  are only narrowed, never released (`lease-watch.js:40`).
- Modes `off` / dry / `live` (`lease-watch.js:57`, `:117`); actions append to `lease-actions.jsonl`
  (`lease-watch.js:118`). Its own state file is written with a plain `writeFile` (`lease-watch.js:68`), not atomic.
- **Guarantee:** observational, with guarded but non-atomic cleanup. Not fenced.
- **V2:** observer and event source (`lease:*` events). Its release of an ended session's registry lease does not
  grant anything in the V2 authority, and V2 does not rely on it to free V2 resources (V2 leases expire by TTL).

### `handoffs.js` — coordination intent, not a lock

- Rows `{ resource, from, to, due, state }` saved as a JSON array via temp file + `rename` (`handoffs.js:62-68`): a
  reader never sees a torn file, but there is no `fsync`, and a save error is only logged (`handoffs.js:68`).
- A missing or corrupt file loads as an empty list (`handoffs.js:58-60`): fail-open, which is acceptable only because
  handoffs grant nothing.
- Resource matching is fuzzy substring matching in both directions (`handoffs.js:38-53`), and a row is closed by a
  registry event or by the target merely holding something that matches (`handoffs.js:118-151`).
- **Guarantee:** durable-ish intent record with notification on overdue (`handoffs.js:152-175`). Not atomic across
  processes (read-modify-write in memory, single process), not fenced, no TTL.
- **V2:** input only (who expects a resource next). Never authority; fuzzy matching must never be used to decide
  ownership of a V2 resource.

### `vpt-locks.js` — VPT device locks, read-only

- Only `GET /server/control/lockedDevices` with the API key (`vpt-locks.js:1-7`, `vpt-locks.js:29`); ghosty never
  takes, releases or forces a lock (`vpt-locks.js:4-5`). The GET may trigger the server's own reaping of expired locks
  (`vpt-locks.js:4`).
- Cached 15 s on success, 10 s on error, single request in flight (`vpt-locks.js:22`, `vpt-locks.js:35-39`). Every
  failure is `{ ok:false, error }` (`vpt-locks.js:27`, `:31`, `:33`); lock age is `null` when unknown
  (`vpt-locks.js:18`).
- **Guarantee:** observational, unknown-aware. Not atomic or fenced from this side.
- **V2:** input for device/platform availability. A VPT lock and a V2 lease are separate; neither implies the other.

### `deploy-runner.js` — deploy executor driven by the remote registry

- The queue and resource gating live in the remote registry, reached over ssh (`deploy-runner.js:45-56`). The only
  conditional operation used is `deploy start <id>`, whose exit code 3 means "resources busy"
  (`deploy-runner.js:364-369`); that check-and-start is remote and its atomicity is not observable from this repo.
- Local single-flight is in-memory only: a `running` map per env and a `ticking` flag (`deploy-runner.js:158`,
  `:319-321`, `:361`). Two runner processes would not see each other except through the registry.
- Poll failure starts nothing (`deploy-runner.js:183-184`, gated at `:325`): fail-closed for starts.
- The deploy child gets only `VPT_LEASE_AGENT=manager:deploy` and the deploy id (`deploy-runner.js:276`); there is no
  fencing token, so a deploy that outlives its registry entry (e.g. 90 min expiry, `deploy-runner.js:235-237`) cannot
  be stopped by fencing. Orphans are detected after the fact by log idleness (`deploy-runner.js:238-259`) and
  re-adopted after a restart (`deploy-runner.js:339-349`).
- `blockersOf` (`deploy-runner.js:201-214`) recomputes blocking leases locally only for alerts; it does not gate.
- When the runner is enabled, queued requests are auto-approved (`deploy-runner.js:327-332`). That is the owner's
  standing approval for VPT deploys, not an `approval_ref` for V2 gates.
- A failed `deploy finish` is only logged (`deploy-runner.js:301`).
- **Guarantee:** registry-gated start, local single-flight, no fencing, no V2 approval semantics.
- **V2:** an executor. Any V2-initiated deploy must hold `environment:<env>:deploy` from the authority and call
  `fence.check()` immediately before requesting/starting it; registry state remains an input.

### `scripts/safe-restart.sh` — restart guard

- Self-described as "a guard, not an atomic deploy lease" (`scripts/safe-restart.sh:2`).
- An unreachable deploy API returns 2 and the script exits 2 without restarting (`scripts/safe-restart.sh:22-23`,
  `:71`); an invalid, unsuccessful or older-than-60 s snapshot is also exit 2 (`scripts/safe-restart.sh:40-58`).
  So the code fails closed, as `docs/INSTALL.md:170` on this branch also states. (An `AGENTS.md` wording seen in a
  newer `main` checkout, "currently treats an unreachable API as no running deploy", does not match this script; it
  is not part of this branch and should be checked against the code there.)
- Requires two consecutive idle snapshots (`scripts/safe-restart.sh:65-67`); the comment at `:66` acknowledges the
  remaining race between the last check and `systemctl restart` (`:81`).
- **Guarantee:** fresh-snapshot guard with a small race window; not atomic, not fenced.
- **V2:** kept as the human/manual path. V2's System Operations executor must additionally hold
  `service:<host-id>:<service>` (and `host:<id>:maintenance` for host-wide work) and `fence.check()` right before
  invoking it.

## The V2 authority: `orchestration/lease-authority.js`

Interface: ARCHITECTURE §5. Resources must match one of the §5 namespaces (`validResource`), else `E_INVALID`;
this includes `repo:<repo>:branch:<name>` for non-main target branches (D-008). File names are the percent-encoded
resource (`/` -> `%2F`, `:` -> `%3A`); `%` is never valid in a resource, so two resources never share a file.

What it guarantees, and how:

- **Atomic conditional acquire/renew/release.** The file backend wraps read-check-write per resource in an `O_EXCL`
  lock file (`<res>.lock`). The record (`<res>.lease.json`) is replaced by temp file + `fsync` + `rename` + `fsync(dir)`,
  so readers (`validate`) never see a torn record. The locker re-reads its nonce right before committing; a lost lock
  aborts with `E_UNAVAILABLE`. Lock files record `{ nonce, pid, host, at }`; directories are created `0700`.
- **Fencing.** Each acquire increments a per-resource `generation`, persisted in the record and kept across release
  and restart; `lease.token` is that generation. `validate` re-reads the record and returns `E_FENCED` when the
  generation, `lease_id` or owner differ, *before* looking at time — so a holder whose clock lies is still fenced as
  soon as anyone else acquired. Otherwise `E_EXPIRED` once `now >= expires_at`.
- **TTL + renew.** Only the current, unexpired holder (same token, lease_id, owner) can renew; the token stays the
  same. An expired holder must re-acquire and gets a new token.
- **Identity-checked release.** Release requires the same token, lease_id and owner; a non-owner gets `E_FENCED` and
  the holder keeps the lease. `withLeases` releases in `finally` through the same check, so it never frees a lease that
  was taken over.
- **Fail-closed.** Any backend error, operation timeout (`opTimeoutMs`), clock skew against a backend clock
  (`maxSkewMs`), non-finite authority clock, corrupt record, busy lock past `lockWaitMs`, or a missing record whose
  resource has history (`<res>.seen` marker, written before the first record: an O(1) check), is `E_UNAVAILABLE`. It is never treated as free and an unavailable release leaves the lease to expire by TTL.
  Every `E_UNAVAILABLE` and every failed `validate` calls `alert`.
- **Stale critical-section locks.** A lock file left by a crashed process is broken only when (a) its recorded owner is
  not a live process on this host (`kill(pid, 0)`; a lock from another host or without a host is judged by the other
  two conditions only), (b) the resource's holder is expired or absent, and (c) the lock file's mtime is older than
  `staleLockMs`. Breakers are serialized by an `O_EXCL` `<res>.break` file; under it the breaker re-stats the lock,
  renames it to `<res>.moved` and checks dev/ino/mtime match what it judged stale. If it displaced a fresh lock
  instead, every locker that arrives while `<res>.moved` exists backs off, so the slot stays free until the breaker
  links the lock back (or its owner, finishing, removes `<res>.moved`). Two lockers can therefore never both be inside
  the critical section, and no orphan lock is left (verifier test F1). A live holder's resource is never unlocked by
  breaking: it fails closed until the holder's TTL passes.
- **Timed-out acquire.** An acquire that fails with `E_UNAVAILABLE` returns `lease_id` and
  `attempted: { resource, lease_id, owner, task_id }`. If the backend committed after the timeout,
  `authority.adopt(attempted)` returns that lease to the same owner/task (never a free resource, never another
  owner's lease) so it can be released. `acquireAll` does this itself during rollback.
- **Ordered, all-or-nothing acquisition.** `acquireAll` dedupes and sorts resources by code-unit order, acquires
  without blocking, and releases what it got (reverse order) on the first failure.
- **Audit.** Append-only `audit.jsonl` (`fsync` per append) with `acquire`, `adopt`, `renew`, `release`, `denied`
  (`E_HELD`/`E_INVALID`/`E_UNAVAILABLE`/non-owner), `fenced` (validate/renew failures and expired holders displaced by
  a new acquire) and `lock_broken`, each with owner, task_id, scope, approval_ref.
- **Decision (verifier F3): grant provenance is mandatory.** The `acquire` line (and the `fenced` line for a displaced
  expired holder) is appended inside the critical section *before* the record is committed; if it cannot be written,
  nothing is committed and the acquire is `E_UNAVAILABLE`. So every granted token has an audit line. A crash between
  the audit append and the record commit leaves an `acquire` line for a grant that never happened (the generation is
  not advanced); readers must treat audit lines as "attempted at least", the record as the truth. Audit lines for
  non-grant events (denied, renew, release, fenced on validate) stay best effort: their failure raises an
  `audit_failed` alert but does not block a release or a validate.

Executor usage:

```js
const r = await authority.withLeases(['repo:demo:integration'], { owner, task_id, ttl_ms, scope, approval_ref },
  async (fence) => {
    await fence.check();   // immediately before each protected action
    await pushIntegrationBranch();
    await fence.check();
    await markIntegrated();
  });
if (!r.ok) block(r.code);  // E_HELD | E_UNAVAILABLE | E_INVALID: no mutation ran
```

### Limits (honest)

- **Single host, local filesystem.** `O_EXCL` + `rename` are atomic on a local POSIX filesystem; do not put the
  backend directory on NFS or a sync folder. Cross-host authority needs another backend with the same interface.
- **Clocks.** Expiry uses each process's own clock (same host here). A process with a fast clock can take over a lease
  early; the displaced holder is then fenced by generation, so two holders never both pass `validate`. The file backend
  has no independent clock, so `maxSkewMs` only applies to backends that expose `time()`.
- **Check-to-act window.** Fencing protects only actions preceded by `fence.check()`. External systems (git remote,
  systemd, the deploy registry) do not check our token, so between the last check and the action a lease can expire.
  Keep TTLs well above the action duration, renew before long steps, and check immediately before each action.
- **Lost state.** Deleting the record while its `<res>.seen` marker survives is detected (`E_UNAVAILABLE`). Deleting
  or replacing the whole backend directory restarts generations at 1 and is not detected.
- **Timeouts.** An operation that times out may still commit later. For acquire the caller gets `attempted` and can
  `adopt()`/`release()`; if it does not (or the backend stays unavailable), the lease expires by TTL. A timed-out
  renew or release may also have committed; `validate` tells which.
- **Breaker window.** The displaced-fresh-lock case needs a lock to be replaced between the breaker's re-stat (under
  `<res>.break`) and its rename. With serialized breakers and the live-pid veto that requires a lock owner on another
  host or an external actor; it is handled (back-off + restore) but remains the least exercised path.

### Manual recovery

The backend fails closed rather than guessing. These states block a resource until an operator acts; first make sure
no process using the backend directory is running an operation on that resource (`<res>` is the URL-encoded name):

- `<res>.lock` left by a process that crashed inside the critical section while the holder's lease is still live, or
  whose recorded pid on this host was reused by another process: wait for the holder's TTL, or remove `<res>.lock`.
- `<res>.break` left by a breaker that crashed on this host clears itself once older than `staleLockMs` and its pid is
  gone. One from another host, or a `<res>.moved`, needs the manual step: remove `<res>.break`; if `<res>.moved` exists and
  `<res>.lock` does not, remove `<res>.moved` (its owner is gone or will fail its pre-commit check).
- A corrupt `<res>.lease.json`, or a missing one with `<res>.seen` present: restore the record from backup, or rebuild
  it with `generation` set above the highest `token` for that resource in `audit.jsonl` and `holder: null`.

Every one of these surfaces as `E_UNAVAILABLE` plus a `lease_unavailable` alert naming the resource.

## Hardening after re-verification

- `repo:<r>:branch:main` and `repo:<r>:branch:integration` are invalid: one real branch has one lease name.
- Branch names are short refs: `branch:refs/heads/...` and `branch:heads/...` are invalid.
- `validResource` also caps the percent-encoded length (200), so derived file names always fit.
- Lost-record guard: the `<res>.seen` marker first; when record and marker are both gone, the audit log is scanned for
  a granted token of that resource (only paid on a resource's first acquire).
