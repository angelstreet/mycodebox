# Install and configure mycodebox

[Documentation index](README.md) · [Usage](USAGE.md) · [Reference](REFERENCE.md)

For a human or an installing agent. Read [AGENTS.md](../AGENTS.md) first. Do the core steps, then only the optional features requested by the owner. Keep private values on the machine.

## Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Linux | `uname -s` | systemd is optional for foreground operation |
| Node.js 20+ and npm | `node -v`, `npm -v` | ES modules, no build step; one runtime npm dependency (`ws`) |
| Git and tmux | `git --version`, `tmux -V` | Run the server as the Unix user owning the tmux sessions |
| Tailscale on server and client | `tailscale status` | Private network access is the only user-access gate |
| curl and Python 3 | `curl --version`, `python3 --version` | Verification and safe-restart script |
| Agent CLI, if desired | Check the CLI you use | Existing shell sessions also work; UI launches need configured commands |

Use the installed machine's paths and service user; do not copy a previous deployment's identity. Have the owner perform any interactive sign-in locally. Do not ask for passwords, tokens or private keys in chat.

## Tailscale setup and access policy

1. Install Tailscale using its [official platform instructions](https://tailscale.com/download), on both the Linux server and the phone/laptop.
2. On the server, run `sudo tailscale up` if it is not already joined. Complete sign-in locally and connect the client to the same tailnet. Inspect existing settings before changing an already configured node.
3. Check `tailscale status` and `tailscale ip -4` locally. Do not paste their private output into repository files or public issues.
4. Restrict inbound access to the owner or explicitly trusted operators through the tailnet policy. Existing allow-all rules can make a new restrictive grant ineffective: review the complete policy, not just the new rule. See [Tailscale grants](https://tailscale.com/docs/features/access-control/grants) and [examples](https://tailscale.com/docs/reference/examples/grants).
5. Choose one network mode below. Do not open router/firewall ports to the internet or enable Tailscale Funnel.

The recommended mode allows trusted clients to reach HTTPS on TCP 443 through Serve; Node listens only on `127.0.0.1:7777`. Direct mode instead needs policy access to TCP 7777 and, if configured, 7443 on the node. Other tailnet users must not receive access merely because they share the network.

## Core install

For a new checkout:

```bash
git clone https://github.com/angelstreet/mycodebox.git ~/ghosty-sessions
cd ~/ghosty-sessions
npm ci --omit=dev
GHOSTY_STATE_DIR="$(mktemp -d)" npm test
```

Run once in the foreground, with explicit network and agent-command settings:

```bash
HOST=127.0.0.1 PORT=7777 node server.js
```

From another shell:

```bash
curl --fail --silent --show-error http://127.0.0.1:7777/api/health
```

Expect JSON with `ok: true`. An empty session list is fine if no tmux sessions exist. Stop the foreground process with Ctrl-C before starting the service.

**Defaults and upgrades:** the source now defaults to `HOST=127.0.0.1`, `AGENT_CMD_CLAUDE=claude --dangerously-skip-permissions` and `AGENT_CMD_CODEX=codex --dangerously-bypass-approvals-and-sandbox`. Owner's chosen default (2026-10-11): dashboard-created and resumed sessions and the manager start with permission prompts skipped, and create/resume pre-accept folder trust (best effort). Claude resume and `scripts/manager-fresh.sh` reuse `AGENT_CMD_CLAUDE` (the manager restart also pre-accepts trust); an `AGENT_CMD_*` override wins verbatim, so set it to plain `claude`/`codex` to get normal prompts. The forbidden-topic filter, manager hard floors and protected-action gates are unchanged, and V2 workers keep their own launch modes. **MiniMax:** the `mcode` TUI has no permission flag; its full-permission mode is `permissionMode: bypassPermissions` in `~/.minimax/config.yaml` (headless `mcode exec` takes `--permission full`). Set it yourself; mycodebox never writes that file. mcode has no folder-trust prompt. Ensure `claude` is on the service/script PATH or configure its absolute path. The server does not automatically load `.env`.

Existing environment overrides are preserved, so review service settings before upgrading: select loopback + private Serve (or an explicitly private Tailscale address). A non-loopback `HOST` emits a warning without logging its value. Bypass flags no longer warn: they are the default. Already-running agents are unchanged. No migration edits live settings or restarts the service automatically.

### Persistent service configuration

`systemd/ghosty-sessions.service` is an example from a particular deployment, not a portable installer. Copy it and edit the installed copy before enabling it:

```bash
sudo cp systemd/ghosty-sessions.service /etc/systemd/system/ghosty-sessions.service
sudo nano /etc/systemd/system/ghosty-sessions.service
```

Set `User=` to the tmux owner, `WorkingDirectory=` to the checkout, and `ExecStart=` to an absolute Node executable and the absolute `server.js` path. A shell's Node version manager may not be available to systemd.
Change all `TLS_*`, `Documentation=` and `EnvironmentFile=` paths. Remove the optional usage environment file unless that integration is configured.
Set these service environment entries explicitly:

```ini
Environment=HOST=127.0.0.1
Environment=PORT=7777
# Optional: Environment=AGENT_CMD_CLAUDE=... / AGENT_CMD_CODEX=... replaces the default launch command verbatim (see Defaults).
```

Set absolute CLI paths if needed. For MiniMax, override `AGENT_CMD_MINIMAX` with your installed command; the source default has a machine-specific Node path.
Keep `PrivateTmp=false` so the tmux socket remains visible, and `KillMode=process` for detached deploy-child recovery. Do not apply generic systemd hardening that hides the owner's home or tmux socket without testing it.

Optional secrets/settings belong in a private environment file (mode 0600) referenced by `EnvironmentFile=`. The example unit uses `<checkout>/.env`, which Git ignores. Use `KEY=value` entries, no shell commands; systemd does not expand `~` or shell substitutions there. Use absolute paths for `GHOSTY_STATE_DIR`, certificate paths and similar settings. An environment file can override `Environment=` values, so ensure it does not restore an unsafe HOST or launch command.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ghosty-sessions
systemctl status ghosty-sessions --no-pager
```

This is a first-install start. For an existing service, use the update procedure below.

### Recommended: private HTTPS with Tailscale Serve

Enable MagicDNS and HTTPS certificates for the tailnet as described in [Tailscale's HTTPS guide](https://tailscale.com/docs/how-to/set-up-https-certificates). Certificate issuance publishes the certificate's DNS name in public certificate-transparency logs; choose a non-sensitive node name.

Inspect existing Serve configuration before adding a root endpoint so you do not replace another service:

```bash
tailscale serve status
sudo tailscale serve --bg http://127.0.0.1:7777
tailscale serve status
```

Open the HTTPS URL printed by Serve on the connected client, normally `https://<machine>.<tailnet>.ts.net/`. Serve provides private HTTPS and manages its certificate; no PEM files are needed in the checkout. This is **Serve**, not public **Funnel**. See the [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Set `PUBLIC_URL` to that exact HTTPS origin in the service environment, then use the guarded restart procedure. Check that the page, live cards and sends work: the proxy must preserve Host and support WebSocket upgrades because the app checks browser Origin against Host. Local reporter calls still use `http://127.0.0.1:7777` and their token.

### Alternative: direct Tailscale access

For a simple HTTP dashboard without Serve, bind to the node's actual Tailscale IPv4 address:

```bash
GHOSTY_TAILSCALE_IP="$(tailscale ip -4)"
test -n "$GHOSTY_TAILSCALE_IP" || exit 1
HOST="$GHOSTY_TAILSCALE_IP" node server.js
```

Open `http://<tailscale-ip>:7777/`. Set the literal address in the service configuration for persistent operation; `HOST` takes an address, not the interface name `tailscale0`. Do not start this command alongside a running dashboard.
For trusted native HTTPS on 7443, follow [certificates](../certs/README.md) and use the certificate's full DNS name.

A listener bound only to the Tailscale IP cannot also receive loopback requests. Reporter/alert APIs require loopback and will not work by pointing them at the tailnet IP; use the recommended Serve mode for those integrations. Local checks and `GHOSTY_URL` for safe-restart must target the configured listener. Do not switch to `0.0.0.0` just to make a local helper connect.

## Optional features

Optional does not mean every background reader defaults off. The server starts polling some integrations at startup; configure only what the owner needs, and review the reference for side effects.

| Feature | Setup / prerequisite | Data or credential |
|---|---|---|
| Android app links | `ANDROID_APP_PACKAGE` and `ANDROID_APP_SHA256` in `.env` (or a verbatim `$GHOSTY_STATE_DIR/assetlinks.json`) | Package name and public cert fingerprint; 404 when unset |
| Langfuse link | `LANGFUSE_PUBLIC_URL` (browser-reachable; else a non-loopback `LANGFUSE_URL`) | Button hidden when neither is set |
| Web Push | Trusted HTTPS, browser permission, bell button | Generated VAPID key and subscriptions in state dir |
| ntfy | Private `NTFY_TOPIC`, optional `NTFY_URL`, `PUBLIC_URL` | Topic is secret; default provider is external |
| Claude reporter | Merge the plugin setting from [REFERENCE](REFERENCE.md#session-reporter-task-44-phase-8) into existing Claude settings; compatible Claude version; new sessions | Loopback URL plus `reporter.token`; do not overwrite other settings |
| Voice | Install `faster-whisper` into the Python environment used by `transcribe.js`; see reference/source for `WHISPER_MODEL` | First use downloads a model; choose a virtual environment instead of changing system Python |
| Image attach | Available in dashboard | Stored separately in `~/.ghosty/uploads/` |
| AI manager | Review [manager settings](REFERENCE.md#ai-manager); automatic sends default off | Optional Jev/reviewer endpoint credentials; requests can include session text |
| Usage and evaluation | `usage/ingest.js`, optional adapted `systemd/ghosty-usage.service`; see [usage](REFERENCE.md#usage-langfuse) | CLI transcripts, local ledger; optional Langfuse keys/data |
| Deploys and leases | External platform registry/SSH adapters and state configuration | Deployment-specific; skip on a generic install. Deploy runner defaults off, but lease binding defaults live when the registry is reachable; review [lease binding](REFERENCE.md#lease-binding-task-58-c1) first |

State defaults to `~/.local/state/ghosty` or the absolute `GHOSTY_STATE_DIR`. Back it up privately. Existing state can carry previously enabled manager actions; do not treat an upgrade as a fresh set of safe defaults.

## Optional: V2 task engine (opt-in, off by default)

V2 runs owner-created tasks in isolated git worktrees: route, developer run, deterministic checks, independent reviewer,
then `accepted`, `waiting` or `awaiting_approval`. It is off unless `GHOSTY_V2=1`; with it unset nothing V2 is loaded and
the dashboard behaves exactly as before. Reference: [env keys](REFERENCE.md#configuration), [V2 task API](REFERENCE.md#v2-task-api-opt-in).

**Enable** (owner action; a restart through the normal update procedure below, never during a deploy):

1. Pick a work root outside the checkout and the state dir, e.g. `/home/<user>/v2-work` (absolute path).
2. List the repositories V2 may work in. Each needs a `.ai/project.json` policy (see this repository's own file for the
   format); its allowlists govern every task in it. A repository without a valid policy is listed but its tasks stop at an
   owner clarification.
3. Add to the private environment file (`.env`, mode 0600):

   ```ini
   GHOSTY_V2=1
   GHOSTY_V2_WORK_ROOT=/absolute/path/to/v2-work
   GHOSTY_V2_REPOS=/absolute/path/to/repo-a:/absolute/path/to/repo-b
   # Optional:
   # GHOSTY_V2_PATH_DIRS=/home/<user>/.local/bin      (where opencode or other CLIs live)
   # MCODE_NODE_DIR=/path/to/node-24/bin              (MiniMax needs Node 24)
   # GHOSTY_V2_CONCURRENCY=1                          (tasks stepped at once, 1-8)
   # GHOSTY_V2_CLAUDE_RUN_USD=1                       (cap of one Claude run, lowered to the task's remaining cap)
   # GHOSTY_V2_PUSH_REMOTE=origin                     (unset = never push; set = only the task's own v2/task/<id> branch)
   ```

   Never set `GHOSTY_V2_TEST_FAKE_ADAPTER` on a live install: it is for tests only.
4. Restart with `scripts/safe-restart.sh` (it refuses during a deploy). The service log shows `[v2] controller lease held;
   recovered the store` and a `[v2] runtimes:` line (a `goal loop NOT started` line names what is missing).
   `GET /api/v2/ops/status` shows the same state.

**What changes for the owner.** The **V2 tasks** view (More menu) now runs tasks: a new task starts at once in a
worktree under the work root, never in the repository's own checkout, and never on `main`. Each task's spend is shown
(unknown stays unknown); set a `max_usd` cap per task to make spend a hard stop. Approve/deny answer exactly the request
shown (its id and head SHA); merges to a protected branch, deploys, credentials and the other restricted classes always
stop at `awaiting_approval`. The server never merges or deploys: an approved merge is done by the owner (for example the
PR merge), and the task is accepted once `main` contains that SHA. Scoring proposals appear as tasks waiting on the owner and
are approved or denied in the same view. Sessions, the manager and its router shadow are unchanged. Old task worktrees under the work root are not
deleted automatically.

**Roll back.** Remove `GHOSTY_V2=1` (or set it to anything else) and restart with `scripts/safe-restart.sh`. The
`/api/v2/*` routes answer 404 again and nothing V2 runs. Task state stays in `$GHOSTY_STATE_DIR/v2` and the work root
(delete them by hand only if the tasks are no longer wanted); re-enabling recovers open tasks under the controller lease.

## Verify

For the recommended loopback + Serve setup:

```bash
curl --fail --silent --show-error http://127.0.0.1:7777/api/health
curl --fail --silent --show-error http://127.0.0.1:7777/api/vm
tailscale serve status
ss -ltn
journalctl -u ghosty-sessions -n 30 --no-pager
```

Verify Node binds only to the intended address. On the owner's phone, confirm HTTPS has no warning, a tmux session appears, updates arrive, and a harmless reply reaches an explicitly selected test session. Verify an unauthorized client cannot access the endpoint. Check notifications/microphone only if requested. Keep session output and diagnostic logs private.
Report the private URL to the owner, enabled features, test results and anything skipped. See [usage and troubleshooting](USAGE.md).

## Update and uninstall

**Set these before upgrading.** The repository no longer carries `public/.well-known/assetlinks.json` or a hard-coded Langfuse host. If you used the Android app links or the usage sheet's Langfuse button, add to `.env` first (or the features go away after the restart): `ANDROID_APP_PACKAGE` + `ANDROID_APP_SHA256` (or `$GHOSTY_STATE_DIR/assetlinks.json`), `LANGFUSE_PUBLIC_URL`, and `PUBLIC_URL` (https origin) to name it in the HTTPS hints. With `LANGFUSE_PUBLIC_URL` unset (and `LANGFUSE_URL` loopback), the usage sheet's Langfuse button is hidden instead of pointing at port 3100 on the same host. See [REFERENCE](REFERENCE.md).

Check `git status --short`, preserve local changes, review the update, and securely back up state before changing versions. Record the previous commit so rollback is possible without discarding local work.

```bash
cd ~/ghosty-sessions
git pull --ff-only
npm ci --omit=dev
GHOSTY_STATE_DIR="$(mktemp -d)" npm test
export GHOSTY_URL=http://127.0.0.1:7777
curl --fail --silent --show-error "$GHOSTY_URL/api/deploys"
# Only after a successful response and confirming no deploy is running:
scripts/safe-restart.sh
```

Adapt `GHOSTY_URL` for direct mode. The guard requires a successful registry snapshot no older than 60 seconds; unreachable, stale, future or ambiguous responses block restart. Running deployments always block; queued or awaiting-approval work blocks while the runner is enabled. It checks again immediately before the service restart and never falls back to killing a PID. `--wait` optionally accepts an integer from 0 to 1440 minutes (10 when omitted); waiting does not bypass the guard. These checks do not provide atomic fencing against a deployment starting after the final check. Never restart during a deploy. Deploy children can survive a restart, but that is recovery behavior, not a reason to bypass the guard. Repeat health and phone checks after an update. If it fails, restore the reviewed previous code/dependencies and compatible backup through the same guarded procedure; do not blindly reset a shared checkout.

Uninstall only when requested: confirm no deploy is running, disable/stop the dashboard service and any optional units you installed, remove its copied unit and reload systemd. Remove only this app's Serve endpoint (inspect shared Serve configuration first). Remove its checkout if desired. State, uploads, private env files, certificates and agent settings need separate retention/removal decisions; never delete the owner's agent home directories or tmux sessions as cleanup.
