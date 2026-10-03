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

## What's done (v0.x)

- HTTP + WebSocket + tmux capture loop (1 Hz tick)
- Card / grid / list views, single-tap selects, double-tap goes fullscreen
- Custom session names in `localStorage`, pencil to rename
- Status pill: idle / busy / needs-you heuristic
- Send-keys dock (input → tmux send-keys -l + Enter)
- Swipe-from-left opens the sidebar; back-arrow returns from card view
- Self-signed HTTPS for PWA install on Android
- Public GitHub repo with runbook for others

## Known issues / not done

| # | Issue | Notes |
|---|---|---|
| 1 | `mountTerm` could still race on rapid focus swaps | safe for normal use; if you see `term.element is null` in console, just tap again |
| 2 | Status pill heuristic is conservative — "needs you" only fires on hard permission prompts | tighten `WAIT_RE` in `server.js` if you want to catch softer prompts |
| 3 | No HTTPS via `tailscale serve` (free plan blocks `tailscale cert` and `tailscale serve --https`) | self-signed works on Android after manual accept; for prod-grade, set up Cloudflare Tunnel (`cloudflared`) or pay for Tailscale |
| 4 | No notification on "needs you" pill | currently visual only; wire up Web Push or `ntfy` later |
| 5 | SW cached old JS once on first rollout | fixed by bumping `SHELL_CACHE` to v3 + server-side `no-cache` for `.html/.js/.css/.json/.webmanifest`; if it ever happens again, bump the version and force-refresh |

## Files of interest

```
server.js                       # Node 20+, ws, no framework
public/app.js                   # controller, three view renderers, swipe, SW reg
public/index.html               # shell
public/style.css                # ghosty dark
public/sw.js                    # PWA service worker, cache v3
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