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
   rule) -> run the repo's test command itself (the lane is the independent tester) -> push the target with a
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

The durable integration queue (`orchestration/integration-queue.js`), the git runner and merge-in-a-fresh-worktree
logic and the compare-and-swap push of `orchestration/integration-controller.js`, the CI status gate
(`orchestration/ci-gates.js`), the merge evaluation floor (`merge-policy.js`), the deploy queue on the central lease
service, the own-job wake (`own-jobs.js`). The owner's per-merge approval of the V2 controller is replaced by the merge
evaluation (OWNER_DECISIONS §14, §19).

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
"restartWaitMin": 10 }`. Every merge (no `--deploy` needed) is followed by: `node --check server.js` on the merge before
the push (step `precheck`; a failure returns the request); then in the live checkout: refuse when tracked files have
uncommitted changes (untracked files are fine) or the checkout is not on the target; `git pull --ff-only` (refused when
not a fast-forward); `npm ci` when `package-lock.json` changed; `node --check server.js` (a failure is reported, the
service is not restarted); then `scripts/safe-restart.sh --wait <restartWaitMin>`. The lane runs inside the service it
restarts and the unit sets `NoNewPrivileges`, so the script is launched with `tmux run-shell -b` (the tmux server is
outside the unit) and its output and exit code land in `<state>/integration/restart/<id>.{log,exit}`. The request's
`selfDeploy` record (`prevSha`, `expectedSha`, this boot) is persisted in the `restarting` phase before the launch; the
restarted service resumes it: live HEAD at the expected sha and `/api/health` answering -> `deployed` ("deployed live
ghosty at <sha> (was <sha>)"), otherwise `deploy_failed`. A safe-restart refusal ends `deploy_failed` with its own text.
`selfDeploy.outcome` says which: `deployed`, `deploy_refused`, `install_failed`, `check_failed`, `restart_refused`,
`restart_failed`, `deploy_failed`. Nothing is ever reset; once the checkout moved, the result carries a `rollback` line.

Files: `integration-lane.js` (queue, steps, restart), `integration-routes.js` (HTTP), `scripts/integrate` (CLI). The queue is
`<state>/integration/requests.jsonl` (one snapshot per line, the last wins). A client token for the Mac:
`node scripts/lease-token.js add <name> --integrate`. A request's states: `queued`, `running`, then one final state
(`merged`, `deployed`, `returned`, `merged_ci_red`, `deploy_failed`, `cancelled`). `notify(request, event)` fires on every
transition; `event.kind` is `queued | running | step | resumed | state | final`, `event.final` is true on a final state.
