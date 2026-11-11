# Agent contract

[Documentation index](README.md) · [Repository map](MAP.md)

Read [AGENTS.md](../AGENTS.md) first. This contract applies to repository changes and installations. Who may commit, push, merge, deploy, restart or close a session, and what stays the owner's, is stated once, in [Who may do what](#who-may-do-what-one-rule-text); every other file links there. Publishing, deleting state and enabling automatic actions are not authorized by this contract.

## Before working

1. Read the task, `git status --short`, and the relevant source and tests. Preserve unrelated changes and untracked files.
2. Use [INSTALL](INSTALL.md) for installation and [MAP](MAP.md) to locate code. Check actual settings locally; never infer a running service's state from the handover.
3. Keep work scoped. Do not start a second dashboard against live state or enable optional services merely to validate docs.

## Invariants

- The server has no login. Bind explicitly to loopback behind private Tailscale Serve, or to a Tailscale IP for direct access. Never publish it with Funnel, public tunnels or public reverse proxies.
- `127.0.0.1` is the source default. Explicit listener overrides are not a security boundary. Tailnet grants/ACLs must restrict who can reach the endpoint; allowed users can act as the owner.
- The hard floor wins over every manager decision and every automatic path; merges, pushes and deploys are evaluated, not forbidden. Both are defined in [Who may do what](#who-may-do-what-one-rule-text). Preserve countdown cancellation, draft checks and actor attribution.
- Merges are evaluated, not forbidden (owner, 2026-10-14; [OWNER_DECISIONS §14](tasks/v2/OWNER_DECISIONS.md#14-the-manager-decides-merges-2026-10-14)). The manager (`merge-policy.js`) answers "merge" only when every check holds: the branch merges into its target cleanly or only in convention files (`mergeConventionFiles`, default `VERSION.txt`); the session reports its tests green on that branch, or the change is docs-only (test code needs the green report); the diff touches no secrets, credentials, migrations, sudoers, systemd units, CI/deploy/infra files or binaries, and the diff could be scanned in full; the repo is not in `mergeOptOut`; Jev, or the manager's own reasoning when Jev is unavailable, rates it safe at or above `mergeMinConfidence`. Anything else escalates with the specific reason. Every merge decision is written to `merge-decisions.jsonl` and recorded as an owner feed notice. Only text, never into a live menu, and only on a finished turn. Force-push, pushes to other refs or to prod/staging/live, history rewrites and every other floor stay hard. A question mixing merge with a hard topic is split: the merge is decided, the rest escalated. Information the manager can find (repo docs, handovers, `infoRoots`) is answered and the escalation says what was already answered.
- Automatic answering defaults on for the decidable cases (owner, 2026-10-14, OWNER_DECISIONS §15: `autoSend`, `continue`, `menu_recommended`, merge/push/deploy decisions); deploy execution (`deployRunner`) defaults off. Saved owner settings win after the one-time `autonomyVersion` migration. Never relax the hard floor or permission checks to make a test pass.
- UI features are mockup-first: post the HTML mockup to the feed (`POST /api/mockups`) and keep building unless the owner objects within the window; the owner reviews at the end.
- Long jobs run harness-tracked; when you stop to wait on your own job, name it in the STATUS line (pid, log file, run id or deploy id) so the manager wakes you when it ends.
- Leases: follow [LEASE-RULES](LEASE-RULES.md). Never ask the owner about a lease: wait (`vpt-lease claim ... --wait` or `vpt-lease run ... -- <cmd>`), never poll, never `--force`; a session that only waits holds no exclusive lease. The central service is the target authority ([LEASES-CENTRAL](v2/LEASES-CENTRAL.md)); until the owner switches the fleet, the registry stays authoritative.
- Pushes and deploys the manager answers are evaluated like merges (`decide-policy.js`; push of the session's own branch only, deploy only through the deploy queue, with a rollback line); every decision goes to `manager-decisions.jsonl`, the feed and the "Decided for you" list. Sessions themselves ship by [the ship rule](#after-a-change-every-session).
- Owner's chosen default (2026-10-11): dashboard sessions, resumes and the manager start with permission prompts skipped and folder trust pre-accepted; `AGENT_CMD_*` overrides win verbatim. The hard floor is unchanged by it; merges, pushes and deploys go through the evaluations above. V2 orchestration workers keep their own launch modes and the adapters still refuse caller-supplied bypass flags; the one exception is MiniMax `mcode exec` workers (developers and reviewers), which run with `--permission full`, started in their V2 worktree; `--cwd` is not a sandbox, so they can run any host command, the same threat model as the dashboard default (D-023).
- Reporter/alert writes require both the reporter token and loopback access. Keep tokens private even behind a local proxy.
- Preserve exact tmux targeting, input validation and Origin checks. Proxies must support WebSocket upgrades and preserve the browser-facing Host.
- No credentials, real infrastructure identifiers or captured session output in tracked files, commits, issues or PRs. Use obvious synthetic fixtures.
- V2 is opt-in: `GHOSTY_V2=1` enables `/api/v2/*`; without it the routes answer 404 and nothing is constructed (no store, no timers, no polling). The server never starts the goal loop; creating a task only records it. Only an `accepted` task (passing required checks on the exact SHA plus an independent approve) is shown as done. Owner approvals must name the pending request (`action_id`, and the head SHA when set); never add a blanket approve. Unknown usage and prices stay unknown, never 0.
- Use `public/icons.js` for icons, ES modules and the existing dependency set. Explain any new dependency.

## Validation and delivery

- Tests must use temporary state; never write the live `layout.json`. Create test temp dirs with `tmp()` from `test/helpers-tmp.js`, never a bare `mkdtemp()`: the tracker removes them when the test file ends (untracked calls filled the system temp dir until the box ran out of inodes; `test/tmp-cleanup.test.js` guards it). Run `GHOSTY_STATE_DIR="$(mktemp -d)" npm test` before a commit. It runs the tests your change touches (the integration lane does the same per merge); the full suite (`npm run test:full`) runs daily on main. Add meaningful tests for behavior changes, not duplicate tests for prose.
- A temporary state directory alone does not isolate a running server: it still discovers tmux and may poll optional integrations. Prefer module tests and fake adapters.
- For UI changes, check the affected flow on phone and desktop sizes, and review the service worker's cache/update behavior.
- For docs, verify local links, commands, source defaults and consistency across the index, install guide and reference.
- Stage only intended files. Read `git diff --staged` after staging and before every commit, checking for private data. Do not use blanket staging in a shared checkout.
- Ship by [the ship rule](#after-a-change-every-session): push your own branch and run `integrate request`; never push `main` yourself. Historical handover notes grant nothing the rule text below does not.
- Restart `ghosty-sessions` only through `scripts/safe-restart.sh`, outside an active deploy ([Who may do what](#who-may-do-what-one-rule-text)). The guard requires a fresh successful snapshot at its configured `GHOSTY_URL`; unknown or active deployment state blocks restart. See [updates](INSTALL.md#update-and-uninstall).
- Report what changed, checks and results, limitations, and any actions still needed. Never claim a phone flow, live deployment or optional integration was tested unless it was.

## Who may do what (one rule text)

The one statement of who may commit, push, merge, deploy, restart and close sessions, what a session does after a change, and
the hard floor (harness review 2026-11-11, item 8). AGENTS.md, REFERENCE.md, `scripts/cbsession`, `ci-watch.js` and the
done-check messages link here or say the same thing in fewer words. When another text differs, this one wins and the other
is a bug: fix it or file it with `found-bug`. Built from the owner's dated decisions; where two conflict, the newer wins (the
pairs are listed at the end of this section).

### After a change (every session)

Ship rule (owner, 2026-11-11), on the integration lane (round 13, owner 2026-10-18):

1. Run the touched tests and typecheck yourself (`npm test` here; it selects the touched tests).
2. Read `git diff --staged`, commit by explicit path on your own branch.
3. `git push -u origin <branch>`.
4. `integrate request <branch> [--deploy frontend|server|host|full]`, smallest scope that covers the change.
5. Keep working on anything that does not depend on the result; only when nothing is left end with
   `STATUS: waiting: integration <id>`. A returned request is fixed on the branch and requested again.

Never ask permission for these steps and never end a turn offering one ("I can ...", "if you want", "should I", "nothing is
committed"). Verify UI yourself with headless Playwright. Every turn ends with a STATUS line; a done line carries the
`closing review:` and `bugs:` fields (AGENTS.md).

### Who does each action

| Action | Who | Never |
|---|---|---|
| Commit, push your own branch | Any session, without asking | Commit secrets or live state (AGENTS.md "never leak") |
| Merge into the target, push the target (`main`) | The integration lane only (`integrate request`) | A session, the CI fixer or the manager merging or pushing the target by hand; force-push |
| Repo with no lane configured | The session stops on `STATUS: waiting: merge <branch>`; the manager runs the merge evaluation (`merge-policy.js`, owner 2026-10-14) and answers; on "merge" the session merges and pushes | Asking the owner for a merge or PR decision |
| Deploy | The lane, through the deploy queue, when the request carries `--deploy` | Running the deploy script yourself, `--force`, `--skip-leased`, a deploy inside a host's trigger window |
| Answer a merge / push / deploy / recommended-option question | The manager, evaluated and journaled; the owner corrects afterwards (owner 2026-10-14, OWNER_DECISIONS §14, §15) | Answering a hard-floor item for the owner |
| Restart `ghosty-sessions` | The lane after a server deploy; anyone else only through `scripts/safe-restart.sh` (it refuses during a deploy) | `systemctl restart ghosty-sessions` or `kill` on the service |
| Restart a lab `vpt-*` unit | The session holding the host (or `<host>/<device>`) lease, allowlisted units only (owner 2026-10-27, widened 2026-10-31; [REFERENCE](REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14)) | `stop`, `enable`, `disable`, `mask`, `daemon-reload`, unit files, non-allowlisted units, production hosts |
| Close a session (`DELETE /api/sessions/<s>?confirm=<s>`) | The owner; the agent that started the session (`startedBy`) for its own child; the manager only when the owner asks for that session (owner 2026-11-01) | Any automatic close: no tick sends `/exit` or kills a session (owner 2026-10-30). The delete guard refuses a session with an open ask, a lease or unmerged work unless `by=owner` or the spawner (2026-11-11) |
| Park or rotate a session | Explicit park, `autoParkArchived`, or account rotation on a usage limit (owner 2026-11-06): not a close | — |
| Kill a process | Your own only (`kill <pid>`, `pkill -P <your pid>`, a pattern naming your worktree) | `killall`, broad `pkill -f` patterns |

### Hard floor

Only the owner decides these; nobody, the manager included, answers them on the owner's behalf (owner 2026-10-14, every verb
form, [REFERENCE](REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14)):
deleting data; credentials and secrets (new, revoked, rotated, printed); money; customers; sudoers; units on hosts; reboots;
destructive or unreadable database migrations and database resets; force-push and history rewrites (`--force-with-lease`,
`--mirror`, `--delete`, `+ref`, pushes to prod/staging/live); pushing tags; publishing a package; a physical action only the
owner can do (try the software equivalent first and name it, owner 2026-10-31).

Dated exceptions (not floor):

| Owner date | Not floor |
|---|---|
| 2026-10-15 | A VirtualPyTest agent fetching and using the auto-sign test token |
| 2026-10-21 | Additive migrations (CREATE TABLE / INDEX, ADD COLUMN, DROP NOT NULL, COMMENT ON, RLS and policies): the session applies them and `integrate request` merges them with no `--approved-by` (journaled `migrationAdditive: true`) |
| 2026-10-25, 2026-10-26 | A routine, reviewed and merged unit / timer / script install with backup and rollback on codebox, a CI runner or another non-production helper or database host; a change that only makes something safer or idempotent; a permission fix so a service reads its own settings file, contents never read (`host-unit-routine.js`); journaled with a rollback line. Sudoers, new credentials and production customer-facing hosts stay floor |
| 2026-10-27, 2026-10-31 | `systemctl restart` of an allowlisted lab unit under the host lease (table above) |
| 2026-10-28 | A non-secret `.env` key (endpoint, port, flag): backup, change that line only, never print the file, rollback line |
| 2026-10-29 | Using a credential already on the box, through the service's own environment, for an idempotent additive write |
| 2026-10-30 | A one-time SMS / 2FA code the owner gives in chat: pass it on, it is not a secret |
| 2026-11-06 | Account rotation restart of a session stopped on a usage limit |

At most one open ask per session; a system wait (deploy, lease, integration id) is not a question (owner 2026-10-31).

### Pushes the done-check sends (one row per kind, `done-check.js`)

| Finding | Pushes |
|---|---|
| Done line, git disagrees (commits not on `origin/main`, uncommitted files) | Once per finding |
| Closing offer or permission question with unpushed work (ship rule) | Once per closing text, at most 2 a day per session (`SHIP_PUSHES_PER_DAY`) |
| Done line without `closing review:` | Once per done line, at most 3 a day (`REVIEW_PUSHES_PER_DAY`), done turns younger than 6 h |
| Done with leftovers, "not fully confirmed", `partial` | At most 3 a day (`LEFT_PUSHES_PER_DAY`), then the manager is told |
| Done line without `bugs:` | Once per 12 h (`BUGS_COOLDOWN_MS`) |
| `STATUS: waiting: lease` while a healthy equivalent is free | Once; the manager is told on the second stop |

All kinds together: at most 2 sessions per check (every 5 min), none while the host is busy.

### Leases

Follow [LEASE-RULES](LEASE-RULES.md). A named `--wait` claim of a group member switches to a healthy free equivalent **at
once** (owner 2026-11-10; `VPT_LEASE_SWITCH_AFTER` delays it); the lease watchdog tells a waiter after 30 s, other waits after
5 min (`lease-nudge.js`).

### Conflicts resolved (newer wins)

| Older | Newer | Rule kept |
|---|---|---|
| 2026-10-14 "merge your own work, push to `main` yourself" (§15 wording, `ci-watch.js` brief, `scripts/cbsession` step 3) | 2026-10-18 integration lane, 2026-11-11 ship rule | Push your branch, `integrate request`; the lane merges and deploys |
| 2026-10-22 "close finished children" (nightly kick); 2026-10-30 "the manager may close" | 2026-11-01 "stop closing them" | The manager closes only on the owner's request |
| 2026-11-01 auto-equivalent "after 2 minutes" | 2026-11-10 "at once" | At once |
| 2026-10-25 unit install on a CI runner or helper VM only (OWNER_DECISIONS §20) | 2026-10-26 codebox and helper database hosts too | The wider 2026-10-26 list |
| 2026-10-04 manager on Opus (manager manual) | 2026-10-21 Sonnet, not Opus (`MANAGER_MODEL`) | Sonnet |
| 2026-10-04 "deploy all", the manager approves deploys itself (manager manual) | 2026-10-18 deploys go through the lane | The lane deploys |

Not dated, corrected to the code: `autoSend` defaults **on** (`manager.js`, since round 8), not off.

### Manager manual (read-only copy, not edited here)

The manager manual in the manager's own checkout (`docs/tasks/TASK-44-MANAGER.md` and `-REF.md`) still says, against this
section: "merge nothing, push nothing" and "never answer anything about a deploy, restart, push or merge to main" (against
2026-10-14 §15); "send a worker, merge, restart ghosty" and "push to main (`git push origin HEAD:main`)" (against the lane);
"`sudo systemctl restart ghosty-sessions` is allowed" (against `scripts/safe-restart.sh` only); "Opus minimum" (against
2026-10-21 Sonnet); "Create a session: never" (against delegating workers). Filed for the manual's owner as one bug (bug-61e4265b).
