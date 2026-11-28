# Cloud sessions (Anthropic-hosted coding VMs)

Owner request 2026-11-28: code fixes for mycodebox and VirtualPyTest can run in Claude Code cloud sessions
(claude.ai/code, `claude --cloud`) instead of on the codebox VM, several in parallel. This page is the runbook.

## How it works

```
codebox                                   GitHub                         Anthropic cloud VM
-------                                   ------                         ------------------
1. push the branch to fix  ─────────────▶  branch
2. scripts/cloud-start ── claude --cloud ─────────────────────────────▶  fresh VM clones the branch
                                                                          3. bash scripts/cloud-setup.sh
                                                                          4. edit, run the tests
                                           claude/<slug>  ◀───────────── 5. push its own branch
6. integrate request claude/<slug> --mac cloud-<label>
7. the lane merges, tests, deploys (on codebox, as for any branch)
```

The VM gets the repository and nothing else. It cannot reach codebox, the tailnet, the lab or production, so every
step that needs them (steps 6 and 7) stays on codebox. The dashboard's **Cloud** view lists each session started
with `cloud-start`.

## What you can and cannot do there

| Can (code only) | Cannot (stays on codebox) |
|---|---|
| Read and edit the code of the branch | Read `.env`, the state dir, `~/.ssh`, `~/.config` or any secret: none is in the VM |
| Install packages from public registries (npm, PyPI, GitHub) | Reach the dashboard, the lane, the tailnet, lab hosts, devices, databases or production servers |
| Run unit tests, typecheck, lint (`npm test`; VirtualPyTest `pytest tests/rollout tests/shared`, `tsc`) | Deploy, restart a service, take a lease, run a device or a validation, query or migrate a DB |
| Run several sessions in parallel, each in its own VM | Run `integrate`, `found-bug` or any ghosty API (none is reachable) |
| Push its own `claude/<slug>` branch | Push `main` (branch-protected) or anyone else's branch |
| Answer follow-up messages; be taken over locally (`claude --teleport`) | Tests that need a live service, a device, a GPU or a real key: run those on codebox after the hand-off |

## How secrets stay out

- **Nothing secret is in git.** `.env`, `certs/*.pem`, the state dir and logs are never tracked (AGENTS.md "never leak"),
  so the clone the VM receives has none. The tests run on fakes and temp state dirs: they need no real key.
- **Nothing secret is in the environment.** The *Default* environment has no variables and no network secrets; never add
  any. `cloud-start` sends only the repo, the branch and the task text (write no secret in a task).
- **None of our GitHub tokens in the VM.** It pushes through Anthropic's GitHub connection of the default login; we
  created no token and copy none in. The platform does put its own credential variables in the VM (`GH_TOKEN`,
  `GITHUB_TOKEN`, cloud-provider names; seen by name only in the 2026-11-28 review): their reach is the GitHub
  connection's, so keep that connection limited to the repos cloud work needs.
- **No path into our network.** Network *Limited* (package registries, GitHub). There is no Tailscale in the VM.
- **The agent knows where it runs.** `CLAUDE_CODE_REMOTE=true`, and each repo's `AGENTS.md` "Cloud sessions" forbids
  secrets, deploys, leases, devices and DB there.
- **What comes back is read before it runs.** Code from a cloud VM reaches codebox only as a `claude/*` branch queued
  with `--mac cloud-<label>`. The lane returns such a request for manager approval before it installs or tests anything
  (its install and tests run on codebox, where the dev user's files and the tailnet are in reach); the manager reads the
  diff and approves that exact commit (a new push needs a new approval).
- **Treat a cloud branch as untrusted code**: a confused or prompt-injected agent needs no secret to do harm, only a
  pushed branch. Write no secret and no internal detail in a task (`cloud-start` logs its first line, private file).

Known limits (2026-11-28):
- The code itself is copied to Anthropic VMs while a session runs (VirtualPyTest is private): the same trust as using
  Claude Code on codebox.
- claude.ai connectors (MCP) on the account bypass the network allowlist: keep those that reach our data off for cloud work.
- The settings above are a convention: a person editing the environment could add a secret or widen the network. Never do.
- VirtualPyTest CI runs on self-hosted lab runners. Its "Deploy harness" workflow ran on every pushed branch, cloud
  branches included (fixed in the workflow 2026-11-28: `main` and PRs to `main` only), and a branch can still change a
  workflow file in its own push. Closing that needs GitHub settings (runner group limited to `main`, secrets in an
  environment restricted to `main`): an owner item.
- The pushed branch is public at once on mycodebox (a public repo), before any review: nothing private in a cloud task.
- A key once committed stays in git history even after the file is cleaned, and every clone carries it: rotate such a
  key, deleting the file is not enough (VirtualPyTest TASK-08 §4 tracks such a rotation).

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
- Repo setup scripts: `scripts/cloud-setup.sh` in each repo. mycodebox: Node 24 like codebox (the VM ships 22; the binary comes from the
  `node-linux-<arch>` npm package, the npm registry being allowed), then `npm ci` (then `npm test`). VirtualPyTest:
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

`cloud-start` passes `--model sonnet` (owner 2026-11-28; `-m <model>` wins; checked on 2.1.332: a cloud session started with `--model haiku` ran on
Haiku). It runs `claude --cloud` (creating a cloud session is interactive only: `--print` is refused) in a private
tmux, prints the session URL and appends one line to `$GHOSTY_STATE_DIR/cloud-sessions.jsonl`
(`at, id, url, repo, base, label, by, task`). Run it once per task for parallel agents. Interactive alternative: type
`claude --cloud "task"` in a terminal. From a phone or browser: claude.ai/code on the default login.

Where they show up: the dashboard's **Cloud** view (More menu > Cloud, `/?cloud=1`: each session started with `cloud-start`, its task, a link
to it on claude.ai and its hand-off integration, read-only), the claude.ai/code sidebar of the default login (owner, phone app too), the URL
printed by `cloud-start`, and `cloud-sessions.jsonl`. They are not tmux cards. The hand-off shows when the request used `--mac cloud-<label>`
with the label given to `cloud-start -l`.
Follow-up message to a running one: `claude -p "<text>" --cloud <session-id>`; take it over locally:
`claude --teleport <session-id>`.

## Hand-off back to codebox

The cloud cannot reach the lane. The session that started the cloud session (or the manager) queues the branch:

```bash
integrate request claude/fix-foo --repo mycodebox --mac cloud-fix-foo      # or --repo virtualpytest
```

The lane first returns it with `needs manager approval: cloud branch (cloud-<label>)` and a manager item: nothing of the
branch runs on codebox until the manager has read the diff and approved that commit with
`integrate request claude/fix-foo --repo ... --mac cloud-fix-foo --approved-by manager`. Then it merges, tests and deploys
as for any branch (add `--deploy ...` when needed). The result is written to
`<state>/integration/external-results/<id>.txt` and raised as the manager event `<id>:external-result`; the manager
relays it and acks (`integrate ack <id>`), else the owner is pushed after 10 min. A returned request is fixed by a
follow-up message to the same cloud session, which pushes the same branch again; then request it again.

## Proof (2026-11-28)

One cloud session per repo, Default environment, pushed `claude/cloud-proof-mycodebox-20261128` and
`claude/cloud-proof-virtualpytest-20261128` (a small doc with the VM facts). The VM: Ubuntu, Node 22, Python 3.13,
root, repo in `/home/user/<repo>`. Two mycodebox tests that only failed under Node 22 were fixed the same day.
