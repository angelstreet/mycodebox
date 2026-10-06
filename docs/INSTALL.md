# Install and set up mycodebox (for AI agents)

This page is written for a coding agent that has been asked to install mycodebox on a Linux machine for its owner.
Follow it top to bottom. Do the **core** steps, then only the **optional** features the owner asks for.
Everything that needs a secret is created on the machine and stays there; nothing below asks you to commit one.

mycodebox (repo `ghosty-sessions`) is a mobile-first dashboard for the Claude Code / Codex / MiniMax agents that run in
tmux sessions on one machine. A small Node server captures every tmux pane once a second, serves a PWA over
Tailscale, and lets the owner send keystrokes back. See `README.md` for the full feature reference.

## What you need first

| Need | Check | Notes |
|---|---|---|
| Linux with systemd | `uname -s`, `systemctl --version` | systemd is optional: `npm start` in a tmux session works too |
| Node.js 20 or newer | `node -v` | the only runtime dependency is `ws` |
| tmux | `tmux -V` | the agents must run in tmux sessions; mycodebox lists `tmux list-sessions` |
| Tailscale on the machine and on the owner's phone | `tailscale status` | the tailnet is the only access control (see Security) |
| At least one agent CLI | `claude --version`, `codex --version` | only needed to create sessions from the UI |

Ask the owner for nothing secret. Ask only for: the machine's Tailscale name, and which optional features they want.

## Core install (about 5 minutes)

```bash
git clone https://github.com/angelstreet/ghosty-sessions.git ~/ghosty-sessions
cd ~/ghosty-sessions
npm install --omit=dev
npm test          # all tests should pass before you start the service
```

Run it once in the foreground to check:

```bash
PORT=7777 node server.js     # then, from another shell:
curl -s http://127.0.0.1:7777/api/sessions | head -c 300
```

You should get JSON (an empty list is fine). Stop it with Ctrl-C.

### Run it as a service

`systemd/ghosty-sessions.service` is the unit the author uses, with the author's user name and paths. Copy it and
edit `User=`, `WorkingDirectory=`, `ExecStart=` and the `TLS_*` / `EnvironmentFile=` paths to match this machine. Do not
symlink it unedited.

```bash
sudo cp systemd/ghosty-sessions.service /etc/systemd/system/ghosty-sessions.service
sudo nano /etc/systemd/system/ghosty-sessions.service   # fix user and paths
sudo systemctl daemon-reload
sudo systemctl enable --now ghosty-sessions
systemctl status ghosty-sessions --no-pager
```

If the service is already running (an update, not a first install), restart it with `scripts/safe-restart.sh`, which
refuses while a deploy is running. A plain `systemctl restart` can kill a deploy mid-build.

### HTTPS, so the phone can install the app

Plain HTTP on `:7777` works for browsing. The PWA install, Web Push and the microphone need HTTPS (`:7443`).
Put `key.pem` and `cert.pem` in `certs/` (both git-ignored). A self-signed cert is fine on a tailnet; steps are in
`certs/README.md`. Use the machine's real Tailscale IP and name in the cert, never anything copied from the docs.

### Open it from the phone

`http://<tailscale-ip>:7777/` or `https://<tailscale-ip>:7443/`. The phone must be on the same tailnet. On Android
Chrome use the menu, then Install app. Then check that a tmux session shows up as a card within a second or two:

```bash
tmux new-session -d -s hello -c ~ 'bash -l'
```

## Optional features

Each one is off until you set it up. None is required for the dashboard to work.

| Feature | What it gives | How to set it up | Secret involved |
|---|---|---|---|
| **Web Push** | "needs you" alerts on the phone with the app closed | Nothing to install. Open the app over HTTPS and tap the bell. | The server creates a VAPID key in the state dir (`vapid.json`, 0600) |
| **ntfy push** | the same alerts through the ntfy app | Add `NTFY_TOPIC=<long random string>` to the gitignored `.env`, subscribe to it in the ntfy app | the topic name |
| **Session reporter** | exact turn / prompt / permission events from Claude sessions instead of screen guessing | Add `{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "<repo>/claude-plugin/ghosty-reporter" } }` to `~/.claude/settings.json`. Needs Claude Code 2.1.288 or newer. New sessions load it; running ones do not. | `reporter.token` is created by the server, loopback only |
| **Voice input** (mic button) | speech to text on the machine, sent like typed text | `pip install faster-whisper` for the python3 that runs the server. `WHISPER_MODEL` picks the model (default `base`, CPU). The first use downloads the model. | none |
| **Image attach** (paperclip, paste, drop) | uploads an image to `~/.ghosty/uploads/` and adds `@<path>` to the message | works out of the box | none |
| **AI manager** | classifies every stop, can answer safe ones after a cancellable countdown | in the manager panel; auto-answer is off by default. Read the AI manager section of `README.md` before turning anything on. | `JEV_API_KEY` only if the owner has such a server |
| **Usage and quota** | token cost per session, plan windows | `usage/ingest.js`, `systemd/ghosty-usage.service`; Langfuse is optional | Langfuse keys, in a separate env file outside the repo |
| **Deploy queue, leases, Platforms page** | coordination of deploys and exclusive devices | specific to the author's platform (`vpt-lease` reached by `ssh proxmox`). Skip unless the owner has the same setup; without it those panels just show no data. | ssh access |

State (config, logs, keys) lives in `$GHOSTY_STATE_DIR`, default `~/.local/state/ghosty`. Back it up, never commit it.

## Security rules for you, the installing agent

- There is **no login screen**. Anyone who can reach the port can send keystrokes to every agent session on the machine.
  Keep it on the tailnet. Do not open the ports on a public interface, do not publish them with a tunnel or reverse
  proxy, and do not bind to a public address. Prefer `HOST=<tailscale-ip>` over `0.0.0.0` where you can.
- Never write a secret into a tracked file, a commit message, an issue or a pull request. Secrets go in `.env`
  (`chmod 600`, git-ignored), in the state dir, or in the environment of the service.
- Never commit `certs/*.pem`, `.env`, anything from the state dir, or a screenshot that shows a session's output.
- Before you push, run `git status` and read the diff for tokens, IP addresses, host names and e-mail addresses.
- The manager must never answer, on the owner's behalf, a question about a deploy, a merge to main, a delete,
  credentials, money or a customer. The forbidden-topic filter always wins; do not weaken it.

## Verify

```bash
curl -s http://127.0.0.1:7777/api/sessions | python3 -m json.tool | head
curl -s http://127.0.0.1:7777/api/vm            # CPU / RAM / disk of this machine
journalctl -u ghosty-sessions -n 30 --no-pager  # no stack traces
npm test
```

Report back to the owner: the URL to open, which optional features are on, and anything you skipped and why.

## Update and uninstall

```bash
cd ~/ghosty-sessions && git pull && npm install --omit=dev && npm test && scripts/safe-restart.sh
```

Uninstall: `sudo systemctl disable --now ghosty-sessions`, remove the unit file, and delete the repo. The state dir
is separate; delete it only if the owner agrees.
