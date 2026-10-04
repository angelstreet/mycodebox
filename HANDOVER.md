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

**Usage / cost (TASK-44 phase 3)** — local Langfuse in `~/langfuse-codebox/` (UI `:3100`, loopback + tailnet) and
unit `ghosty-usage` (`usage/ingest.js`); details in README "Usage (Langfuse)". Creds: `~/langfuse-codebox/.env`,
`~/.config/ghosty/usage.env`. Summary for the UI: `~/.local/state/ghosty/usage-summary.json`.
**Usage view** (branch `task44-usage-ui`): topbar bar-chart icon -> sheet Today / 14 days, API-equivalent costs (never money
spent; MiniMax unpriced = `—`), cost chip on cards/rows, `GET /api/usage`, `usage` in the status payload; see README
"Usage view (UI)". Deploy: the tailer must be restarted (`ghosty-usage`) so the summary gets the `today` block, plus a
ghosty-sessions restart; until then the Today tab says so and 14-day data still works.

**Swipe review (TASK-44 phase 2b, branch `task44-swipe-review`)** — `/?review=1` / topbar cards icon / panel link: Tinder-style
good (right) / bad (left) / skip (up) labelling of unlabelled stops, Undo via `{type:'unlabel'}` records. API
`GET /api/manager/review`, `POST /api/manager/unlabel`; code `public/review.js`; tests `test/review.test.js`; SW cache v17.
Not merged or deployed; deploying needs a `ghosty-sessions` restart. See README "Swipe review".

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

## What's done (v2 — cockpit)

**States** — working (pulsing green + current step), needs you (red, prompt + 1/2/3/esc), done
(blue, agent finished its turn), idle (grey), offline. Agent badge (claude/codex/minimax/bash via
process tree), repo/branch*, context left, model, held leases (exact `codebox:<session>` match; see README "Platforms page"), purple "waiting deploy".

**Phone (≤720px)** — board is home (sorted needs you > done > working > idle); tap row = card,
long-press = set send target. Card: swipe header/reader left/right = next/prev session, "Aa / >_"
toggles reader (last reply as readable text) vs raw terminal. Tabs + grid hidden.

**Grid** — sizes 2 / 4 / 8 / 16 always visible at the far right of the top bar (tap = grid at that size, phones too); tap = send target ("→ send target" pill), double-tap = open card.
Reorder: drag a card by its header (desktop), or ◀ ▲ ▼ ▶ on the selected card (touch); order saved per device.

**Dock** — fixed-width target chip (tap = picker), quick-prompt chips (long-press edit, + adds),
history, quick keys, sent ✓ / delivered ✓✓, multi-target send.

**Sidebar** — grouped by state, rename, kill (type name to confirm), "+" new session (agent + dir
from `/api/dirs` + name), Platforms page in the ⋮ menu (leases, deploy queue, deployed now; replaces the sidebar leases list).

**Font & fit** — one global terminal font (A− / A+ / Aa popover, Ctrl+= / − / 0); detached sessions
are resized (`tmux resize-window`, then `window-size` unset so a later attach still resizes) to fill
their card — `POST /api/resize/:s`, 409 when a client is attached (then h-scroll), `GHOSTY_RESIZE_ALLOW`
regex limits which sessions may be resized. Toggle "Fit sessions to cards" in the Aa popover.

**Filters** — funnel button: status / project (GitHub repo from `origin`) / agent; applies to grid,
board, tabs, sidebar. Card headers show project · ⎇ branch(*) · ⑂ worktree in the middle.

**Dock** — chevron bottom-left collapses quick prompts + keys (remembered).

**Alerts** — bell = Web Push subscription (see README "Web Push"; state in the state dir: vapid.json, push-subs.json, push-feed.json). Optional extra phone push via ntfy: the secret `NTFY_TOPIC` + `PUBLIC_URL` are in
the gitignored `~/ghosty-sessions/.env` (loaded by the unit's `EnvironmentFile=`); pushes on "needs you" and on
disk critical (≥ 95 %, repeated every 6 h). `NTFY_DONE=1` adds turn-finished pushes.

**Health strip** (TASK-44 phase 1) — under the top bar: CPU %, load 1-min / cores, RAM used, disk used + free.
Amber ≥ 85 %, red ≥ 95 % (load: amber at 1x cores, red at 2x). `health.js` samples /proc + statfs every 5 s,
pushed as `{type:'health'}` on `/ws/status`, also `GET /api/vm`. Tests: `npm test`.

**AI Manager** — plan is TASK-44 in virtualpytest (`docs/tasks/TASK-44-ai-manager.md`); dev worktree
`~/ghosty-sessions-task44`, branch `task44-ai-manager`.

**TASK-44 phase 5** (branch `task44-priority`) — per-session priority P0/P1/P2 and owner pause/resume
(`session-meta.js`, `/api/session-meta/:s`, state in `sessions.json`), quota row (`quota.js`, `/api/quota`).
Claude Max quota is `?` until `scripts/claude-statusline-ratelimits.sh` is set as the Claude Code
`statusLine` command (owner edits `~/.claude/settings.json`; see README "Priority, pause and quota").
MiniMax has no stored plan limit: tokens only. Deploy = merge + restart `ghosty-sessions`; SW cache is v10.

**TASK-44 phase 6** (branch `task44-policy`) — quota policy by priority (`public/policy.js`, pure; wired in
`manager.js` + `server.js`). A P1/P2 session that would be auto-answered but whose agent's plan is under
pressure gets a manager hold (`held` in `sessions.json`, apart from the owner's `paused`), logged
`{type:'hold'|'resume', by:'manager'}` and pushed; released on every 60 s quota poll when the policy allows.
The new-session dialog has a priority picker (default P2, saved) and preselects the suggested agent
(suggestion only). Config keys `policyEnabled`, `p1MaxPct`, `p2MaxPct` in
`manager.json`. Deploy = merge + restart `ghosty-sessions`; SW cache is v11.

**Security** — cross-origin POST/WS rejected (Origin ≠ Host), JSON-only POSTs, 64KB body cap,
exact tmux targets (`=name:`), create limited to dirs under $HOME, execFile only.

## Known issues / not done

| # | Issue | Notes |
|---|---|---|
| 1 | Codex prompt/done/activity patterns untested (no live Codex pane) | calibrate `WAIT_RE` / done markers on a real codex session |
| 2 | "waiting" can false-positive on prompt-like text in the last ~15 lines | e.g. a quoted "Do you want to proceed?" |
| 3 | `ntfy` not configured yet | add `Environment=NTFY_TOPIC=<secret-topic>` + `PUBLIC_URL` to the systemd unit |
| 4 | Board reorders when states change | by design (urgency sort); rows are moved in place, not rebuilt |
| 5 | Phone top bar is full at 360px — count chips get squeezed (they scroll) | hides less once installed (no install button) |
| 6 | No HTTPS via `tailscale serve` (free plan) | self-signed on :7443 works after manual accept |
| 7 | SW cache v6 | bump again if stale JS ever shows |

## Session reporter (TASK-44 phase 8)

`claude-plugin/ghosty-reporter/` reports structured Claude events to `POST /api/reporter/event` (loopback + token
from `<state dir>/reporter.token`); `reporter.js` keeps the latest per tmux session; `manager.js` prefers the
reported final answer over the pane excerpt, logs `background_wait`, and takes the owner's reply from the reported
prompt. Install = one `CLAUDE_CODE_PLUGIN_DIRS` line in `~/.claude/settings.json` (README, "Session reporter").
Things to know: `Stop` is the only hook that says whether background work is in flight, and it does not fire for
every turn end (an interrupted or declined-question turn has only `turn.complete`), so a missing count means 0;
a finished background task wakes the session with a synthetic `<task-notification>` prompt (marked, ignored as an
owner reply); the Notification hook for a permission dialog can arrive ~10 s after the dialog is drawn. The spinner
detector (`WORK_RE`) misses short turns on Claude 2.1.289, so a reported prompt also counts as the session moving on.

## Files of interest

```
server.js                       # Node 20+, ws, no framework
public/app.js                   # controller, three view renderers, swipe, SW reg
public/index.html               # shell
public/style.css                # ghosty dark
public/sw.js                    # PWA service worker (shell cache version is in the file), notification click
public/platforms.js             # lease ownership + chip + waiting-for-deploy + Platforms view model (pure, shared with server)
leases.js                       # vpt-lease list --json reader
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