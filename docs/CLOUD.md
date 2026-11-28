# Cloud sessions (Anthropic-hosted coding VMs)

Owner request 2026-11-28: code fixes for mycodebox and VirtualPyTest can run in Claude Code cloud sessions
(claude.ai/code, `claude --cloud`) instead of on the codebox VM, several in parallel. This page is the runbook.

## What is offloaded, what is not

| Offloaded to the cloud VM | Not offloaded |
|---|---|
| CPU, RAM, disk of the clone, installs, tests, typecheck (4 vCPU, 16 GB RAM, 30 GB+ disk per session) | Tokens: cloud sessions count toward the same plan usage limits as local ones; there is no separate VM charge |
| | The lane, deploys, device runs, leases, DB, manager: they stay on codebox |

## Which login owns it

The `default` login (the Max plan in `~/.claude` on codebox). It has the most headroom, it is the login `claude --cloud`
uses on codebox, and its GitHub connection already pushes `claude/*` branches to both repos. The two Team logins are
parked on usage limits and their environments would be personal to them anyway. No new account, token or paid usage.

## Environment

- **Default** (exists on a Max plan; used for the 2026-11-28 proofs): network *Limited* with package managers allowed
  (GitHub, npm, PyPI ...), no variables, no secrets. Nothing else is needed: each repo's `AGENTS.md` tells the agent to
  run `bash scripts/cloud-setup.sh` first (idempotent, a no-op outside the cloud).
- **Optional one-time owner step (speed only):** claude.ai/code → environment selector under the message box → the
  gear next to *Default* (or *New environment*, name `mycodebox-cloud`) → *Setup script* → paste, then *Save*:

  ```bash
  for s in "$PWD"/scripts/cloud-setup.sh /home/user/*/scripts/cloud-setup.sh; do [ -f "$s" ] && CLAUDE_CODE_REMOTE=true bash "$s" || true; done; exit 0
  ```

  The install is then cached in the environment snapshot (about 7 days) instead of running in each session
  (VirtualPyTest: about 90 s). Leave *Network access* on Limited + package managers, *Environment variables* and
  *Network secrets* empty.
- Repo setup scripts: `scripts/cloud-setup.sh` in each repo. mycodebox: `npm ci` (then `npm test`). VirtualPyTest:
  a venv in `~/.venvs/vpt-cloud` with the server + host requirements and pytest, and `frontend/node_modules` with the
  CI's vitest/testing-library extras (then `pytest tests/rollout tests/shared`, `tsc --noEmit`).

## Rules (owner 2026-11-28)

No secrets, no `.env` values, no lab or production credentials in the environment, and no tailnet access into our
network. Cloud work is code only: no device runs, deploys, leases or DB. Each repo's `AGENTS.md` carries this as
"Cloud sessions"; the agent sees `CLAUDE_CODE_REMOTE=true`.

- `main` is branch-protected on both repos; a cloud agent pushes only its own `claude/<slug>` branch.
- Never add environment variables or network secrets to the environment, never widen network access to *Full* or add
  our hosts to the allowlist.
- claude.ai connectors (MCP) enabled on the account bypass the network allowlist. Keep connectors that reach our
  data off for cloud work, or tell the agent not to use them.

## Starting sessions (several in parallel)

From codebox (any session; the branch must be pushed, the VM clones the GitHub remote at that branch):

```bash
scripts/cloud-start -C ~/ghosty-sessions -l fix-foo -t "Fix ... ; run the tests; push claude/fix-foo"
scripts/cloud-start -C ~/virtualpytest -l fix-bar -f /tmp/task.txt
```

`cloud-start` runs `claude --cloud` (creating a cloud session is interactive only: `--print` is refused) in a private
tmux, prints the session URL and appends one line to `$GHOSTY_STATE_DIR/cloud-sessions.jsonl`
(`at, id, url, repo, base, label, by, task`). Run it once per task for parallel agents. Interactive alternative: type
`claude --cloud "task"` in a terminal. From a phone or browser: claude.ai/code on the default login.

Where they show up: the claude.ai/code sidebar of the default login (owner, phone app too), the URL printed by
`cloud-start`, and `cloud-sessions.jsonl` for the manager. They are not tmux cards on the dashboard.
Follow-up message to a running one: `claude -p "<text>" --cloud <session-id>`; take it over locally:
`claude --teleport <session-id>`.

## Hand-off back to codebox

The cloud cannot reach the lane. The session that started the cloud session (or the manager) queues the branch:

```bash
integrate request claude/fix-foo --repo mycodebox --mac cloud-fix-foo      # or --repo virtualpytest
```

The lane merges, tests and deploys as for any branch (add `--deploy ...` when needed). The result is written to
`<state>/integration/external-results/<id>.txt` and raised as the manager event `<id>:external-result`; the manager
relays it and acks (`integrate ack <id>`), else the owner is pushed after 10 min. A returned request is fixed by a
follow-up message to the same cloud session, which pushes the same branch again; then request it again.

## Proof (2026-11-28)

One cloud session per repo, Default environment, pushed `claude/cloud-proof-mycodebox-20261128` and
`claude/cloud-proof-virtualpytest-20261128` (a small doc with the VM facts). The VM: Ubuntu, Node 22, Python 3.13,
root, repo in `/home/user/<repo>`. Two mycodebox tests that only failed under Node 22 were fixed the same day.
