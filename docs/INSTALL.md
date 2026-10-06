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
HOST=127.0.0.1 PORT=7777 AGENT_CMD_CLAUDE=claude AGENT_CMD_CODEX=codex node server.js
```

From another shell:

```bash
curl --fail --silent --show-error http://127.0.0.1:7777/api/health
```

Expect JSON with `ok: true`. An empty session list is fine if no tmux sessions exist. Stop the foreground process with Ctrl-C before starting the service.

**Why explicit settings:** the current source defaults to `HOST=0.0.0.0`; Claude and Codex UI launch commands include permission/sandbox bypass flags. The commands above override those defaults for new UI sessions. They do not change existing agents or every other launch path, such as parking/resume. Review those paths before using them. The server does not automatically load `.env`.

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
Environment=AGENT_CMD_CLAUDE=claude
Environment=AGENT_CMD_CODEX=codex
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
HOST="$GHOSTY_TAILSCALE_IP" AGENT_CMD_CLAUDE=claude AGENT_CMD_CODEX=codex node server.js
```

Open `http://<tailscale-ip>:7777/`. Set the literal address in the service configuration for persistent operation; `HOST` takes an address, not the interface name `tailscale0`. Do not start this command alongside a running dashboard.
For trusted native HTTPS on 7443, follow [certificates](../certs/README.md) and use the certificate's full DNS name.

A listener bound only to the Tailscale IP cannot also receive loopback requests. Reporter/alert APIs require loopback and will not work by pointing them at the tailnet IP; use the recommended Serve mode for those integrations. Local checks and `GHOSTY_URL` for safe-restart must target the configured listener. Do not switch to `0.0.0.0` just to make a local helper connect.

## Optional features

Optional does not mean every background reader defaults off. The server starts polling some integrations at startup; configure only what the owner needs, and review the reference for side effects.

| Feature | Setup / prerequisite | Data or credential |
|---|---|---|
| Web Push | Trusted HTTPS, browser permission, bell button | Generated VAPID key and subscriptions in state dir |
| ntfy | Private `NTFY_TOPIC`, optional `NTFY_URL`, `PUBLIC_URL` | Topic is secret; default provider is external |
| Claude reporter | Merge the plugin setting from [REFERENCE](REFERENCE.md#session-reporter-task-44-phase-8) into existing Claude settings; compatible Claude version; new sessions | Loopback URL plus `reporter.token`; do not overwrite other settings |
| Voice | Install `faster-whisper` into the Python environment used by `transcribe.js`; see reference/source for `WHISPER_MODEL` | First use downloads a model; choose a virtual environment instead of changing system Python |
| Image attach | Available in dashboard | Stored separately in `~/.ghosty/uploads/` |
| AI manager | Review [manager settings](REFERENCE.md#ai-manager); automatic sends default off | Optional Jev/reviewer endpoint credentials; requests can include session text |
| Usage and evaluation | `usage/ingest.js`, optional adapted `systemd/ghosty-usage.service`; see [usage](REFERENCE.md#usage-langfuse) | CLI transcripts, local ledger; optional Langfuse keys/data |
| Deploys and leases | External platform registry/SSH adapters and state configuration | Deployment-specific; skip on a generic install. Deploy runner defaults off, but lease binding defaults live when the registry is reachable; review [lease binding](REFERENCE.md#lease-binding-task-58-c1) first |

State defaults to `~/.local/state/ghosty` or the absolute `GHOSTY_STATE_DIR`. Back it up privately. Existing state can carry previously enabled manager actions; do not treat an upgrade as a fresh set of safe defaults.

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

Adapt `GHOSTY_URL` for direct mode. **The script currently treats an unreachable API as no running deploy**, so a failed check is not permission to restart; inspect the deployment state and resolve reachability first. Never restart during a deploy. Deploy children can survive a restart, but that is recovery behavior, not a reason to bypass the guard. Repeat health and phone checks after an update. If it fails, restore the reviewed previous code/dependencies and compatible backup through the same guarded procedure; do not blindly reset a shared checkout.

Uninstall only when requested: confirm no deploy is running, disable/stop the dashboard service and any optional units you installed, remove its copied unit and reload systemd. Remove only this app's Serve endpoint (inspect shared Serve configuration first). Remove its checkout if desired. State, uploads, private env files, certificates and agent settings need separate retention/removal decisions; never delete the owner's agent home directories or tmux sessions as cleanup.
