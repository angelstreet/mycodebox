# Agent contract

[Documentation index](README.md) · [Repository map](MAP.md)

Read [AGENTS.md](../AGENTS.md) first. This contract applies to repository changes and installations; it does not authorize deployment, publishing, deleting state or enabling automatic actions.

## Before working

1. Read the task, `git status --short`, and the relevant source and tests. Preserve unrelated changes and untracked files.
2. Use [INSTALL](INSTALL.md) for installation and [MAP](MAP.md) to locate code. Check actual settings locally; never infer a running service's state from the handover.
3. Keep work scoped. Do not start a second dashboard against live state or enable optional services merely to validate docs.

## Invariants

- The server has no login. Bind explicitly to loopback behind private Tailscale Serve, or to a Tailscale IP for direct access. Never publish it with Funnel, public tunnels or public reverse proxies.
- `127.0.0.1` is the source default. Explicit listener overrides are not a security boundary. Tailnet grants/ACLs must restrict who can reach the endpoint; allowed users can act as the owner.
- The forbidden-topic filter wins over all manager decisions. Never auto-answer deploys, deletes, credentials, money or customer questions. Preserve countdown cancellation, draft checks and actor attribution.
- Merges are evaluated, not forbidden (owner, 2026-10-14; [OWNER_DECISIONS §14](tasks/v2/OWNER_DECISIONS.md#14-the-manager-decides-merges-2026-10-14)). The manager (`merge-policy.js`) answers "merge" only when every check holds: the branch merges into its target cleanly or only in convention files (`mergeConventionFiles`, default `VERSION.txt`); the session reports its tests green on that branch, or the change is docs/test-only; the diff touches no secrets, credentials, migrations, sudoers or systemd units; the repo is not in `mergeOptOut`; Jev, or the manager's own reasoning when Jev is unavailable, rates it safe at or above `mergeMinConfidence`. Anything else escalates with the specific reason. Every merge decision is written to `merge-decisions.jsonl` and recorded as an owner feed notice. Force-push, history rewrites and every other floor stay hard. A question mixing merge with a hard topic is split: the merge is decided, the rest escalated. Information the manager can find (repo docs, handovers, `infoRoots`) is answered and the escalation says what was already answered.
- Automatic answering and deploy execution default off. Existing saved state can enable them. Never relax defaults or permission checks to make a test pass.
- Owner's chosen default (2026-10-11): dashboard sessions, resumes and the manager start with permission prompts skipped and folder trust pre-accepted; `AGENT_CMD_*` overrides win verbatim. The forbidden-topic filter, manager hard floors and protected-action gates (push/deploy/credentials; merges through the evaluation above) are unchanged. V2 orchestration workers keep their own launch modes and the adapters still refuse caller-supplied bypass flags; the one exception is MiniMax `mcode exec` workers (developers and reviewers), which run with `--permission full`, started in their V2 worktree; `--cwd` is not a sandbox, so they can run any host command, the same threat model as the dashboard default (D-023).
- Reporter/alert writes require both the reporter token and loopback access. Keep tokens private even behind a local proxy.
- Preserve exact tmux targeting, input validation and Origin checks. Proxies must support WebSocket upgrades and preserve the browser-facing Host.
- No credentials, real infrastructure identifiers or captured session output in tracked files, commits, issues or PRs. Use obvious synthetic fixtures.
- V2 is opt-in: `GHOSTY_V2=1` enables `/api/v2/*`; without it the routes answer 404 and nothing is constructed (no store, no timers, no polling). The server never starts the goal loop; creating a task only records it. Only an `accepted` task (passing required checks on the exact SHA plus an independent approve) is shown as done. Owner approvals must name the pending request (`action_id`, and the head SHA when set); never add a blanket approve. Unknown usage and prices stay unknown, never 0.
- Use `public/icons.js` for icons, ES modules and the existing dependency set. Explain any new dependency.

## Validation and delivery

- Tests must use temporary state; never write the live `layout.json`. Run `GHOSTY_STATE_DIR="$(mktemp -d)" npm test` before a commit. Add meaningful tests for behavior changes, not duplicate tests for prose.
- A temporary state directory alone does not isolate a running server: it still discovers tmux and may poll optional integrations. Prefer module tests and fake adapters.
- For UI changes, check the affected flow on phone and desktop sizes, and review the service worker's cache/update behavior.
- For docs, verify local links, commands, source defaults and consistency across the index, install guide and reference.
- Stage only intended files. Read `git diff --staged` after staging and before every commit, checking for private data. Do not use blanket staging in a shared checkout.
- Keep code review/merge/push within the user's authorization. Historical handover notes are not standing permission to push to main.
- Restart only through `scripts/safe-restart.sh`, outside an active deploy. The guard requires a fresh successful snapshot at its configured `GHOSTY_URL`; unknown or active deployment state blocks restart. See [updates](INSTALL.md#update-and-uninstall).
- Report what changed, checks and results, limitations, and any actions still needed. Never claim a phone flow, live deployment or optional integration was tested unless it was.
