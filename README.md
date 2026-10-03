# Ghosty Sessions

Mobile-first tmux dashboard for the Claude / Codex sessions running on `codebox`.
Streams every `tmux capture-pane` to your phone over Tailscale (1 Hz tick),
lets you send keystrokes back, and shows status pills (idle / busy / needs you).

> Read-mostly, send-keys-when-needed. The terminal stays alive on your laptop;
> Ghosty is a peer, not a replacement.

## Access

- Phone must be on the same Tailscale tailnet as `codebox`.
- **Plain HTTP**: `http://<codebox-tailnet-ip>:7777/` — works, but Chrome won't
  show the "Install" PWA option. Use Chrome menu → "Add to Home Screen".
- **HTTPS (recommended for PWA install)**: `https://<codebox-tailnet-ip>:7443/`
  — accepts a self-signed cert once, after which Chrome treats it as installable
  and the orange ↓ button in the topbar fires the system install prompt.

The server listens on `0.0.0.0:7777` and `0.0.0.0:7443`. It is reached via
`codebox`'s Tailscale IP (typically `<tailscale-ip>`). The Proxmox firewall on
`vmbr0` does not expose these ports to LAN guests — only tailnet peers can reach them.

## Run on codebox

```bash
cd ~/ghosty-sessions
npm install --omit=dev
sudo ln -sf $PWD/systemd/ghosty-sessions.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ghosty-sessions
sudo systemctl status ghosty-sessions --no-pager
journalctl -u ghosty-sessions -f
```

If you don't want systemd, just `npm start` in a tmux session — the same `server.js`.

## Configuration

Env vars (defaults shown):

| var | default | meaning |
|---|---|---|
| `PORT`        | `7777` | listen port |
| `HOST`        | `0.0.0.0` | listen addr (`tailscale0` is the safest) |
| `TICK_MS`     | `1000`  | pane capture cadence |
| `PANE_LINES`  | `2000`  | scrollback lines per pane |
| `NTFY_TOPIC`  | unset   | enable ntfy push; notifies when a session starts waiting (high priority) or finishes a turn |
| `NTFY_URL`    | `https://ntfy.sh` | ntfy server base URL |
| `PUBLIC_URL`  | unset   | base URL of this app; used as the notification click link (`/?s=<session>`) |
| `DONE_IDLE_HOURS` | `6` | a finished agent session turns `done` -> `idle` after this long |
| `AGENT_CMD_CLAUDE` / `_CODEX` / `_MINIMAX` / `_BASH` | `claude` / `codex` / `minimax-code` / (none) | command typed into a session created via `POST /api/sessions` |

## Architecture

```
┌────────────┐  capture-pane  ┌─────────────────┐  WebSocket :7777  ┌────────┐
│  tmux      │ ─────────────▶ │ ghosty-server   │ ─────────────────▶ │ phone  │
│  (11 sess) │  tmux send-keys│ (Node 20+, ws)  │  JSON snapshot    │ (PWA)  │
└────────────┘ ◀───────────── └─────────────────┘                   └────────┘
                              also: /api/sessions, /api/send/:s
```

- `server.js` keeps an in-memory cache of the last pane for every session.
- WebSocket clients (`/ws/:session`) get the latest snapshot each tick.
- `/ws/status` broadcasts status pills to everyone (drives the UI colours).
- `POST /api/send/:session` runs `tmux send-keys -l "..."` then `Enter`.

## Status pill heuristic

| state | meaning |
|---|---|
| `wait` | pane contains a permission prompt (`[Y/n]`, `(y/N)`, `Allow?`, etc.) |
| `busy` | activity in last 5 s **and** pane contains a generation glyph (`⠿`, `Thinking`, …) |
| `busy` | activity in last 2 s (anything typing) |
| `idle` | otherwise |
| `offline` | session is not in `tmux list-sessions` |

Tune `classify()` in `server.js` if you want stricter or looser behaviour.

## Files

```
.
├── server.js                        # HTTP + WS + tmux
├── package.json
├── public/
│   ├── index.html                   # PWA shell
│   ├── app.js                       # controller
│   ├── style.css                    # ghosty dark
│   ├── manifest.webmanifest
│   ├── sw.js                        # service worker
│   ├── icon.svg / icon-{192,512}.png
│   └── vendor/                      # xterm.js + xterm-addon-fit (offline)
└── systemd/
    └── ghosty-sessions.service
```

## Adding xterm sessions automatically

Every tmux session on `codebox` shows up in Ghosty. To start a new Claude session:

```bash
ssh codebox
tmux new-session -d -s my-new-task -c ~/virtualpytest \
  '$HOME/.local/bin/claude --dangerously-skip-permissions; bash -l'
```

It appears in the sidebar within ~1 s.

## Security

- Tailscale ACL is the only gate.
- No auth prompt in the UI by design — anyone on your tailnet is "you".
- `tmux send-keys` runs as `jndoye`, scoped to the session name in the URL.
  Validate inputs server-side if you ever expose this beyond your tailnet.

## License

Private. Joakim, your call whether to OSS.