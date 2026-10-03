# Ghosty Sessions — handover

Where this lives: **`~/ghosty-sessions/` on `codebox` (VM 190, Tailscale `<tailscale-ip>`)**.
Git remote: `git@github.com:angelstreet/ghosty-sessions` (public).

This file is the **first** thing to read when resuming work. Everything else
(architecture, runbook, certs, status pill heuristic) is in `README.md` and
`certs/README.md`.

## 30-second bring-up

```bash
ssh codebox
sudo systemctl status ghosty-sessions --no-pager    # should be active
curl -sS http://127.0.0.1:7777/api/health           # {"ok":true,...}
curl -ksS https://127.0.0.1:7443/api/health         # same, over TLS

# if it's down:
sudo systemctl restart ghosty-sessions
journalctl -u ghosty-sessions -n 50 --no-pager      # recent logs
```

Service runs as `jndoye` with `WorkingDirectory=/home/jndoye/ghosty-sessions`,
binds `0.0.0.0:7777` (HTTP) and `0.0.0.0:7443` (HTTPS, self-signed).

## Access URLs

| URL | Use |
|---|---|
| `http://<tailscale-ip>:7777/` | daily driver on the tailnet — works, no install ceremony |
| `https://<tailscale-ip>:7443/` | for installing the PWA (Android Chrome refuses SW on plain HTTP); accept the cert once |
| `https://<tailnet-host>:7443/` | if you ever want the ts.net name instead of the IP |

## Resume the dev session

There is a persistent tmux session `ghosty` on codebox that drops you straight
into this repo:

```bash
# from the Mac:
~/bin/codebox-ghosty

# from any box with the key:
ssh codebox 'tmux new-session -A -s ghosty -c ~/ghosty-sessions'
```

The session starts with `claude --dangerously-skip-permissions; bash -l` so when
Claude exits you land in a shell at the repo root, not kicked out of the session.

## What's done (v1 — cockpit)

- Server: one `list-panes` + one `ps` per tick, parallel captures, broadcasts only changed panes
- Status contract per session: `state` (working / waiting / idle / offline), `agent`
  (claude / codex / minimax / bash via process tree), `waitReason`, `lastSendAt`,
  `workingSinceMs`, `cols`/`rows`
- Cards: agent badge, state badge with elapsed timer (working = since last send),
  red "needs you" card with the prompt text + one-tap 1 / 2 / 3 / esc answers
- "NEEDS YOU" banner + count chips in the topbar (tap a chip = filter); `(n) codebox` tab title
- xterm sized to the tmux pane's cols with scaled font (6–14px) — no rewrap, no staircase, no flash
- Views: card / grid (2·4·6·9·all, one column on phones) / board (rows sorted by urgency, last agent line)
- Dock: full-width auto-growing input + quick keys (esc ⏎ ↑ ↓ tab 1 2 3 y n ^C) via `{key}` sends
- Leases from `vpt-lease` on proxmox in the sidebar (`/api/leases`, 15s cache)
- Bell = browser notification + vibrate when a session flips to "needs you" (HTTPS URL only)
- `?s=<session>` opens a session, `?view=card|grid|list` picks the view

## Known issues / not done

| # | Issue | Notes |
|---|---|---|
| 1 | 221-col panes render at the 6px floor and crop on phones | add a "reader" mode (ANSI-stripped, reflowed text) for card view on mobile |
| 2 | "waiting" can false-positive when prompt-like text sits in the last ~15 lines (e.g. a quoted "Do you want to proceed?") | Codex / MiniMax prompt wording in `WAIT_RE` is a best guess — calibrate on a real prompt |
| 3 | No HTTPS via `tailscale serve` (free plan) | self-signed works on Android after manual accept; Cloudflare Tunnel for prod-grade |
| 4 | Notifications only fire while the page/PWA is alive | real background alerts need Web Push or `ntfy` from the server |
| 5 | SW cache bumped to v4 | if stale JS ever shows, bump again and force-refresh |

## Files of interest

```
server.js                       # Node 20+, ws, no framework
public/app.js                   # controller, three view renderers, swipe, SW reg
public/index.html               # shell
public/style.css                # ghosty dark
public/sw.js                    # PWA service worker, cache v4, notification click
public/manifest.webmanifest     # installable as "codebox"
public/certs/  (git-ignored)    # self-signed PEMs
public/vendor/                  # xterm.js v5.3.0 + addon-fit
systemd/ghosty-sessions.service # PrivateTmp=false so the tmux socket is visible
```

## Commit conventions

- One feature per commit, message starts with `feat:` / `fix:` / `docs:` / `refactor:`
- Push directly to `main` (no PR flow yet — single-author)
- Always: `git diff --cached` before commit, then `git add` + `git commit` + `git push` in one Bash call to keep other agents from stepping in mid-flight

## Repo links

- GitHub: <https://github.com/angelstreet/ghosty-sessions>
- Tailscale IP: `<tailscale-ip>`
- Tailnet: `<tailnet>.ts.net`

## How to test the PWA install flow on a fresh phone

1. Join the `angelstreet` Tailscale tailnet on the phone (if not already).
2. Visit `https://<tailscale-ip>:7443/` in Chrome.
3. Tap **Advanced → Proceed to <tailscale-ip> (unsafe)**. Accept once.
4. The page loads → orange ↓ install icon in the topbar → tap → "Add to Home Screen" → done.
5. Launch from home screen — opens full-screen, no address bar, install button auto-hides.

## When you're done for the day

The session is named `ghosty` so you can re-attach from any box with the key:

```bash
ssh codebox 'tmux attach -t ghosty'
```

Or from the Mac:

```bash
~/bin/codebox-ghosty
```