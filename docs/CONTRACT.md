# Agent contract

[Documentation index](README.md) · [Repository map](MAP.md)

Read [AGENTS.md](../AGENTS.md) first. This contract applies to repository changes and installations; it does not authorize deployment, publishing, deleting state or enabling automatic actions.

## Before working

1. Read the task, `git status --short`, and the relevant source and tests. Preserve unrelated changes and untracked files.
2. Use [INSTALL](INSTALL.md) for installation and [MAP](MAP.md) to locate code. Check actual settings locally; never infer a running service's state from the handover.
3. Keep work scoped. Do not start a second dashboard against live state or enable optional services merely to validate docs.

## Invariants

- The server has no login. Bind explicitly to loopback behind private Tailscale Serve, or to a Tailscale IP for direct access. Never publish it with Funnel, public tunnels or public reverse proxies.
- `0.0.0.0` is the current source default, not a security boundary. Tailnet grants/ACLs must restrict who can reach the endpoint; allowed users can act as the owner.
- The forbidden-topic filter wins over all manager decisions. Never auto-answer deploys, merges to main, deletes, credentials, money or customer questions. Preserve countdown cancellation, draft checks and actor attribution.
- Automatic answering and deploy execution default off. Existing saved state can enable them. Never relax defaults or permission checks to make a test pass.
- Reporter/alert writes require both the reporter token and loopback access. Keep tokens private even behind a local proxy.
- Preserve exact tmux targeting, input validation and Origin checks. Proxies must support WebSocket upgrades and preserve the browser-facing Host.
- No credentials, real infrastructure identifiers or captured session output in tracked files, commits, issues or PRs. Use obvious synthetic fixtures.
- Use `public/icons.js` for icons, ES modules and the existing dependency set. Explain any new dependency.

## Validation and delivery

- Tests must use temporary state; never write the live `layout.json`. Run `GHOSTY_STATE_DIR="$(mktemp -d)" npm test` before a commit. Add meaningful tests for behavior changes, not duplicate tests for prose.
- A temporary state directory alone does not isolate a running server: it still discovers tmux and may poll optional integrations. Prefer module tests and fake adapters.
- For UI changes, check the affected flow on phone and desktop sizes, and review the service worker's cache/update behavior.
- For docs, verify local links, commands, source defaults and consistency across the index, install guide and reference.
- Stage only intended files. Read `git diff --staged` after staging and before every commit, checking for private data. Do not use blanket staging in a shared checkout.
- Keep code review/merge/push within the user's authorization. Historical handover notes are not standing permission to push to main.
- Restart only through `scripts/safe-restart.sh`, outside an active deploy. First verify its configured `GHOSTY_URL` responds: its current unreachable-API behavior fails open. See [updates](INSTALL.md#update-and-uninstall).
- Report what changed, checks and results, limitations, and any actions still needed. Never claim a phone flow, live deployment or optional integration was tested unless it was.
