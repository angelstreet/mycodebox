# The integration lane (round 13, owner 2026-10-18)

Owner: "Integration is more urgent: we need to finalize and test it, then integrate it on all sessions; this is where I
see agents collapsing the most." First V2 goal (OWNER_DECISIONS §19): the owner never answers about leases or deployments.

## Problem

Every session develops, tests, merges into `main`, pushes and deploys by itself. Several do it at once: merges race,
`VERSION.txt` conflicts, pushes cancel each other's CI, deploys queue behind leases with nobody watching, and sessions
stop to ask the owner. V2 already defines the roles that fix this (developer, tester, integration; `orchestration/roles.js`)
and an integration controller (`orchestration/integration-controller.js`), but only for the opt-in V2 task engine.

## Design

One **integration lane per repository**, run by the mycodebox server, fed by every session.

1. **Sessions are developers.** A session commits on its own branch, pushes the branch, and hands off:
   `integrate request <branch> [--repo <name>] [--deploy frontend|server|host|full] [--note ...]`. It prints a request id.
   The session ends its turn with `STATUS: waiting: integration <id>` (or keeps working on something else). It never
   merges into the target, pushes the target or runs the deploy script itself.
2. **The lane integrates, one request at a time per repo**, in its own clone (never a session's checkout):
   fetch -> merge evaluation floor (round 7: clean or convention-only conflicts, nothing sensitive) -> merge the branch
   into the current remote target in a fresh worktree (convention files such as `VERSION.txt` resolved by the repo's
   rule and restamped with a fresh build number, so the merge never reuses the target's build number) -> run the repo's
   test command itself (the lane is the independent tester) -> push the target with a
   compare-and-swap (the target moved: re-merge from the new target, never force) -> wait for remote CI on that exact
   commit (when the repo has CI) -> when the request asked for a deploy and CI is green: queue the deploy (approved) and
   wait for it. Same-scope deploys coalesce in the deploy queue.
3. **The session is told the outcome.** Merged at `<sha>`, deployed `<version>`; or the exact reason it was returned
   (merge conflict outside convention files, red tests with the failing output tail, red CI, deploy failed) so the
   session fixes it on its branch and requests again. A codebox session gets one line through the guarded send when it
   is stopped; any session can block on `integrate wait <id>`; the manager's own-job watcher wakes a session whose
   STATUS names the request id. Anything ambiguous goes to the manager, never to the owner.
4. **Visible.** An Integration view (queue per repo, the current step, recent results, links to commits and deploys), a
   feed notice per result, and the manager journal.

## Configuration

`<state>/integration.json`, per repository: the lane's own clone path, remote, target branch, test command (null: CI
only), whether CI gates the deploy, the deploy env and the default scope, convention files. Requests name a repository
by its key; a session's checkout is recognised from its `origin` URL.

## What it reuses

The lane is its own module (`integration-lane.js`) with its own durable request log, git steps, compare-and-swap push and CI
wait. From the V2 engine it imports only the merge evaluation floor (`merge-policy.js`) and the usage attribution window
(`usage-window.js`); it also uses the deploy queue on the central lease service and the own-job wake (`own-jobs.js`).
`orchestration/integration-controller.js`, `integration-queue.js`, `ci-gates.js` and `delivery.js` belong to the opt-in V2
task engine and are not used by the lane. The owner's per-merge approval of the V2 controller is replaced by the merge
evaluation (OWNER_DECISIONS §14, §19). The request's `review` field is that evaluation (the merge floor, or the merge
decision's source), not an independent reviewer.

## Rollout

1. Build, review once (state and security are touched), test on a throwaway repository end to end.
2. Configure the real repositories; run the lane next to the old habit for one hour (sessions may use it; nothing forces
   it), watch the results.
3. Switch every session: AGENTS.md, the cbsession handover prompt and the deploy skill say "hand off to the lane"; the
   manager announces it to running sessions; `update_core.sh` started by hand while busy queues a deploy instead of
   failing.

## Interface as built (round 13, lane core)

`<state>/integration.json`:

```json
{ "repos": { "env-a": { "clone": "/abs/path/of/the/lane/clone", "remote": "origin", "target": "main",
  "test": "npm test", "testTimeoutMin": 30, "ci": "github", "ciTimeoutMin": 60,
  "deploy": { "env": "env-a", "defaultScope": "server" }, "conventions": ["VERSION.txt"], "conventionResolver": "take-target" } } }
```

When the merged tree has a `package-lock.json` and a test command is set, the lane runs `npm ci --no-audit --no-fund`
first (step `install`). Commands run with an allowlisted environment (PATH, HOME, locale, TMPDIR, `NODE_*`, CI and a
temp `GHOSTY_STATE_DIR`), never the service's own keys and tokens.

**Self deploy** (the mycodebox repo itself): `"deploy": { "kind": "self", "liveCheckout": "~/ghosty-sessions",
"restartWaitMin": 10 }`. Every merge (no `--deploy` needed; a re-request of a branch already on the target is not redeployed unless `--deploy` is explicit) is followed by: `node --check server.js` on the merge before
the push (step `precheck`; a failure returns the request); then in the live checkout: refuse when tracked files have
uncommitted changes (untracked files are fine) or the checkout is not on the target; `git fetch` then `git merge --ff-only <tested merge sha>` (never whatever the target is now; refused when the target no longer contains the sha or the live checkout cannot fast-forward to it); `npm ci` when `package-lock.json` changed; `node --check server.js` (a failure is reported, the
service is not restarted); then `scripts/safe-restart.sh --wait <restartWaitMin>`. The lane runs inside the service it
restarts and the unit sets `NoNewPrivileges`, so the script is launched with `tmux run-shell -b` (the tmux server is
outside the unit) and its output and exit code land in `<state>/integration/restart/<id>.{log,exit}`. The restart is
the last step: the request is first persisted done (`deployed`, "deployed live ghosty at <sha> (was <sha>), restart
scheduled via safe-restart"), the result event and the session notice go out, and only then is the script launched, so
the lane's own restart can neither lose nor re-run the request. A launch failure is recorded as `restartError` and
raised as a manager item; the outcome stays `deployed`.
One waiter at a time: the launch writes the waiter shell's pid to `<id>.pid`. If a safe-restart this lane launched is still waiting (no `<id>.exit`, process alive and still a safe-restart shell; a stale entry never blocks), a later self deploy does the pull and checks but launches nothing: the request records `selfDeploy.restart: 'coalesced'` and `restartWaiter: <id of the request whose waiter runs>`, and the notice says "restart pending (coalesced with <id>)". The pending waiter restarts into whatever the live checkout holds then, so the latest pulled sha goes live. The state is read from the persisted requests, so a lane restart keeps it.
`selfDeploy.outcome` says which: `deployed`, `deploy_refused`, `install_failed`, `check_failed`, `restart_refused`,
`restart_failed`, `deploy_failed`. Nothing is ever reset; once the checkout moved, the result carries a `rollback` line: `git -C <live> checkout --detach <prev sha> && scripts/safe-restart.sh`, then `git revert -m 1 <merge>` on the target through the lane (never `reset --hard`; the next self-deploy refuses until the live checkout is back on the target branch).

Files: `integration-lane.js` (queue, steps, restart), `integration-routes.js` (HTTP), `scripts/integrate` (CLI). The queue is
`<state>/integration/requests.jsonl` (one snapshot per line, the last wins). A client token for the Mac:
`node scripts/lease-token.js add <name> --integrate`. A request's states: `queued`, `running`, then one final state
(`merged`, `deployed`, `returned`, `merged_ci_red`, `deploy_failed`, `cancelled`). `notify(request, event)` fires on every
transition; `event.kind` is `queued | running | step | resumed | state | coalesced | final`, `event.final` is true on a final state.

**Coalescing and the settle window** (2026-10-20). One branch merged three times in three minutes, restarting the target CI each
time, so a request for a repo + branch + target whose request is still `queued` updates that entry instead of adding a second one:
same id and queue position, the newest tip, the notes appended, the widest `--deploy` scope, the newest `--approved-by` /
`--migration-applied`, and a restarted settle window (`coalesced` counter, `event.kind: 'coalesced'`). A request whose predecessor
is `running` is queued as a second entry and marked `afterId`; the lane is serial per repo, so it starts only after that one ends.
A queued request is picked once it has sat unchanged for `settleMs` (top level in `integration.json`, or per repo; default 60 s,
0 disables). The request records `settleUntil` (ISO); a coalesce pushes it back.

## Infra paths and manager approval

The merge floor treats an explicit list as CI/deploy/infra paths (CI configs, Dockerfiles, terraform/ansible/helm/k8s, `scripts/*deploy*`,
`scripts/*restart*`, `update_core*`, `deploy-runner.js`); files under `test/` or `docs/` and `*.md` never count. When that is the floor's only
reason, the request is returned with `outcome: needs_approval` and a manager item (branch, paths, `git diff --stat`) is raised. The manager
resubmits with `integrate request <branch> --approved-by manager`; only the loopback reporter token or a client added with
`lease-token.js add <name> --integrate --manager` may pass it (403 otherwise; with `INTEGRATION_MANAGER_CLIENT_ONLY=1` only the client, since every session can read the reporter token). The approval is stored on the request and in
`merge-decisions.jsonl` and skips only the infra-path reason: secrets, sudoers, systemd units, conflicts and red tests still return it
(a migration is its own rule, below).

**Approval identity** (2026-10-20). A working session approved its own `update_core` change by passing `--approved-by manager`, so the
lane checks the requesting `session` against `manager.json` `managerSessions`: an approval (`--approved-by`, and with it
`--migration-applied`) is honoured **only** when that session is a manager session. Otherwise the request is still queued and
evaluated as if no approval was given — a floor still returns it — the attempt is stored as
`approvalRefused: { by, session, at }`, and the manager gets one event `lane:self-approval:<request id>`
(`<session> passed --approved-by on <branch>`). A coalesce follows the same rule, and repeating the same claim on one request raises
one event only. Without the `managerSessions` lane option (tests, older wiring) every caller keeps the old behaviour.

## Migrations merge by effect (Q199, owner 2026-10-20; additive migrations are free, owner 2026-10-21)

The migration floor reads the **effect** of a migration, not its path. The lane collects the ADDED lines of each migration file of
the diff (comments and blank lines ignored) and classifies them:

- **Additive**: only `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE ... ADD COLUMN` (plus the session, policy, grant and RLS
  bookkeeping a real migration carries). A non-SQL migration (alembic `.py`) is additive only when its operations are
  `op.create_table`, `op.create_index` and `op.add_column`; anything else (e.g. `op.drop_column`) is not.
  Anything the lane cannot read (truncated diff, a statement it does not recognise) is **not** additive.

An additive migration can always be applied and merged. The session applies it itself, then requests the merge as usual:

```
integrate request <branch>
```

No `--approved-by` and no `--migration-applied` is needed. Both are still accepted (the lane ignores them; a manager's claim is
only recorded). The merge is journaled in `merge-decisions.jsonl` as a `merge` decision (`lane-migration-<id>`,
`migrationAdditive: true`) so it shows in the owner's "Decided for you" feed. The "a table the code uses that no schema or
migration creates" check still applies.

A destructive or unreadable migration still returns the request, with a reason naming what was found:

- `migration is destructive: DROP COLUMN in db/migrations/x.sql` (also `DROP TABLE`, `ALTER ... TYPE`, `RENAME`, `UPDATE`, `DELETE`,
  `INSERT`, `TRUNCATE`, an `op.drop_*`, or a statement that cannot be read)

**Still the owner's:** a destructive migration (any DROP, `ALTER ... TYPE/RENAME`, or data write), an unreadable one, and every
other hard floor (secrets, sudoers, systemd units, red tests, conflicts). The text filter (`FORBIDDEN_RE` in `stall.js`) matches a
migration only when the text says it is destructive (drop / truncate / delete / irreversible).
