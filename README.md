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

Env vars (defaults shown). The unit sets the non-secret ones and loads the gitignored
`~/ghosty-sessions/.env` for the rest:

```bash
# ~/ghosty-sessions/.env  (chmod 600, never committed)
NTFY_TOPIC=ghosty-codebox-<random>      # subscribe to the same topic in the ntfy phone app
PUBLIC_URL=http://<tailscale-ip>:7777     # notification tap opens /?s=<session>
```

| var | default | meaning |
|---|---|---|
| `PORT`        | `7777` | listen port |
| `HOST`        | `0.0.0.0` | listen addr (`tailscale0` is the safest) |
| `TICK_MS`     | `1000`  | pane capture cadence |
| `PANE_LINES`  | `1000`  | scrollback lines captured for a session with an open card (a WebSocket viewer); the unit sets 2000 |
| `PANE_LINES_BG` | `300` | scrollback lines for every other session (state, reply and manager only need the tail) |
| `NTFY_TOPIC`  | unset   | enable optional ntfy push (Web Push is always on): a session starts waiting (high), a disk reaches the critical level (urgent, repeated every 6 h). Keep it secret — anyone with the topic name can read it |
| `NTFY_DONE`   | unset   | `1` also pushes when an agent finishes a turn |
| `NTFY_URL`    | `https://ntfy.sh` | ntfy server base URL |
| `PUBLIC_URL`  | unset   | base URL of this app; used as the notification click link (`/?s=<session>`) |
| `HEALTH_MS`   | `5000`  | codebox health sample cadence (CPU, load, RAM, disk) |
| `HEALTH_DISKS`| `/`     | comma-separated mount points shown in the health strip |
| `HEALTH_WARN_PCT` / `HEALTH_CRIT_PCT` | `85` / `95` | amber / red thresholds for CPU, RAM and disk; disk at critical pushes to ntfy. Load is amber at 1x cores, red at 2x |
| `JEV_URL` / `JEV_API_KEY` | unset | AI manager: the VPT server's `POST /server/ai/decide` and its `API_KEY` (Jev for ambiguous stalls). Unset = rules only |
| `JEV_DAILY_USD` / `JEV_DAILY_CALLS` | `0.25` / `2000` | Jev budget per UTC day; over it, ambiguous stalls stay with the owner |
| `STALL_SETTLE_MS` | `5000` | a stopped pane must stay unchanged this long before it counts as a stall |
| `GHOSTY_STATE_DIR` | `~/.local/state/ghosty` | manager config, `stalls.jsonl` log, Jev budget |
| `GHOSTY_FORBIDDEN_EXTRA` | unset | extra regex of never-auto-answer words (customer names etc. — keep them out of the public repo) |
| `DONE_IDLE_HOURS` | `6` | a finished agent session turns `done` -> `idle` after this long |
| `AGENT_CMD_CLAUDE` / `_CODEX` / `_MINIMAX` / `_BASH` | `claude` / `codex` / `minimax-code` / (none) | command typed into a session created via `POST /api/sessions` |

## Web Push (phone notifications, no extra app)

The bell button subscribes the browser / installed Android app (TWA) to Web Push. Alerts - a session
waiting ("needs you"), the manager asking you, a disk reaching critical, optionally "done" - reach the
phone even with the app closed.

- Payload-less push: the server POSTs an empty request signed with a VAPID ES256 key (node:crypto, no
  dependencies) to the browser's push service (FCM on Android). The service worker wakes up and reads
  `GET /api/push/feed?since=<last id>` to learn what to show, then calls `showNotification`. Tapping
  opens `/?s=<session>`.
- Needs a secure context (the https:// address). Notification permission must be allowed for the app.
- State in `$GHOSTY_STATE_DIR` (default `~/.local/state/ghosty`): `vapid.json` (private key, chmod 600,
  never commit), `push-subs.json` (subscriptions; dropped when the push service answers 404/410),
  `push-feed.json` (last 50 alerts).
- Routes: `GET /api/push/key`, `GET /api/push/feed`, `POST /api/push/subscribe|unsubscribe|test`.
- Test: `curl -XPOST -H 'content-type: application/json' -d '{}' https://<host>:<port>/api/push/test`
- ntfy is now optional; with `NTFY_TOPIC` set, every alert is also sent there (same debounce).
- Code: `push.js` (VAPID, subscriptions, feed, `createAlerts().alert()` fan-out), `public/sw.js`, bell in `public/app.js`.

## AI manager

`stall.js` classifies why an agent stopped — `continue`, `menu_recommended`, `permission`,
`owner_decision`, `done`, `error` — with rules first and Jev (closed choice
`continue | take_recommended | ask_owner`) for the ambiguous ones. `manager.js` logs every stall
to `stalls.jsonl` with what it would answer, then the owner's real reply as its outcome.

**Sending is off by default.** Turn it on (`autoSend`) and only the cases in `autoCases` are typed
(`continue` -> "Yes, continue."; `menu_recommended` -> the option's number in a live menu, or "Yes,
go with your recommendation." after a finished turn). A forbidden topic (deploy, push/merge to
main, delete/remove, migration, `.env`, credentials, money, customer) or an unsent draft in the
input box always means "ask the owner", whatever Jev says. The manager never starts, kills or
renames sessions.

An answer is not typed at once: it is shown on the card / board row as a pill
**"auto: Yes, continue. in 23s ✕"** (✕ or `POST /api/manager/cancel/:session` cancels). When the
delay is up everything is checked again against the live pane (same stall, session still waiting or
done, no draft typed, still not forbidden, session still enabled, under the cap) and only then
typed, through the same send code as the dock. Every answer, cancellation and escalation is logged.
Anything not auto-answered (owner case, forbidden, draft, low Jev confidence, cap reached, auto
off) goes to the owner via ntfy with a deep link and the reason ("deploy question — needs you");
a waiting session is covered by the existing "needs you" push.

`manager.json` (in `GHOSTY_STATE_DIR`; also `GET/POST /api/manager`):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | watch and log stalls at all |
| `autoSend` | `false` | global switch for typing answers |
| `autoCases` | `[]` | cases allowed to auto-send; valid: `continue`, `menu_recommended` |
| `minConfidence` | `0.8` | Jev-derived answers need this probability for the chosen option (rule answers count 1.0) |
| `delayMs` | `30000` | countdown before an answer is typed |
| `maxPerSessionPerHour` | `4` | auto answers per session per rolling hour |
| `disabledSessions` | `[]` | sessions the manager ignores (tick them off in the panel) |
| `policyEnabled` | `true` | quota policy by priority (below) |
| `p1MaxPct` / `p2MaxPct` | `80` / `80` | 5 h fill at which P1 / P2 sessions are held |

The robot icon in the top bar opens the manager panel: global auto-answer switch, per-case
checkboxes, per-session on/off, today's answered / cancelled / escalated counts and the last 30
log entries.

**Policy by priority and quota** (`public/policy.js`, pure and unit-tested). At a stall the manager
would auto-answer (all safety gates above already passed), the policy decides `allow` or `hold`:

- **P0**: always allowed. The safety gates (forbidden topic, draft, confidence, cap) still apply.
- **P1**: allowed while its agent's 5 h window is under `p1MaxPct`.
- **P2**: held when the 5 h window is at or over `p2MaxPct`, or when the weekly window is projected to run out
  before its reset (used % / elapsed fraction of the week > 100 %, only once 10 % of the week has elapsed).
- Unknown quota (stale, expired window, no data, `usedPercent` null) is allowed with reason "quota unknown".
- Plans: claude -> Claude Max, codex -> Codex, minimax -> MiniMax.

A hold is stored in `sessions.json` as `held:{by:'manager',reason,at}`, separate from the owner's `paused`,
logged `{type:'hold', by:'manager'}` and pushed once ("task05 held: Claude Max 5h 86% (P2)"). It never sends
Esc and never interrupts a working session; it only stops the session from being continued at its stop. Every
quota poll (60 s) re-evaluates held sessions: when the policy allows again the hold is cleared, `{type:'resume',
by:'manager'}` is logged and pushed, and a session still stopped at the same stall is scheduled normally (usual
countdown and cancel). The owner's Resume (play button, also shown on a held card) clears a hold too and
sends `continue`. A held session that moves on by itself loses the hold. Cards, rows and the sidebar show
"held: quota" (tooltip = reason); the manager panel lists held sessions. The manager never switches an agent.

**New session.** The dialog has a priority picker (default P2, sent as `priority` to `POST /api/sessions`) and
preselects the agent with the most headroom, shown as "suggested: ...": P2 prefers MiniMax unless it is known
to be under pressure; P0 prefers Claude unless Claude is at 95 % or more; P1 takes the most headroom among
known plans (Claude on ties). It is a suggestion only: picking an agent yourself wins.

```bash
npm run stall-report -- --days 3 --list      # precision per case vs. what the owner answered
curl -s localhost:7777/api/manager            # config + Jev budget + today's counts
curl -s -XPOST localhost:7777/api/manager -H 'content-type: application/json' \
  -d '{"autoSend":true,"autoCases":["continue"],"delayMs":30000}'
curl -s -XPOST localhost:7777/api/manager/cancel/task05 -H 'content-type: application/json' -d '{}'
```

## Priority, pause and quota

**Priority.** Every session is `P0`, `P1` or `P2` (default `P2`, also for a session seen for the first
time or created with `POST /api/sessions`). The badge on the card header, board row and sidebar is a
button: tap it to pick. P0 sorts first on the board, in the needs-you banner and in the card order, then
the usual order. `POST /api/session-meta/:session {"priority":"P0"}`. Stored in
`$GHOSTY_STATE_DIR/sessions.json` keyed by tmux session name; an entry is dropped after the session has
been gone for more than 7 days. The status payload carries `priority` and `paused`.

**Pause / resume (owner).** The pause button (pause glyph, card header and board row) calls
`POST /api/session-meta/:session {"paused":true}`: Escape is sent once, then the hold is kept (persisted).
While held the manager never auto-answers or continues that session, cancels a pending auto answer, and
does not ping you about it. `{"paused":false}` clears the hold and types `continue` + Enter. Both are
logged to `stalls.jsonl` as `{type:'pause'|'resume', session, by:'owner'}`. Ghosty never kills, renames or
starts sessions on its own.

**Quota.** `quota.js` runs every 60 s, Codex and MiniMax are really asked only every 5 minutes (cached in between) (`GET /api/quota`, also pushed on `/ws/status` as `{type:'quota'}`);
the row under the health strip reads `codex 5h 0% wk 32% . claude ? . minimax 5h 2% wk ∞`, amber from 80 %, red
from 95 %, tap for reset times. One push alert when a window crosses 80 %, re-armed below 70 % (the first
reading after a restart only seeds, it does not alert).

| plan | source | notes |
|---|---|---|
| Codex (Plus, 20 EUR/month) | live account read: `codex app-server` over stdio JSON-RPC (`initialize`, `initialized`, `account/rateLimits/read`), killed after the answer, 20 s timeout, no model call | 5h = `primary` (300 min), week = `secondary` (10080 min); a window whose reset time has passed reads 0 % (`expired`) |
| Claude Max (200 EUR/month) | `$GHOSTY_STATE_DIR/claude-rate-limits.json` written by `scripts/claude-statusline-ratelimits.sh` | no limit file exists on disk; Claude Code passes `rate_limits` (`five_hour`, `seven_day`: `used_percentage`, `resets_at`, Pro/Max logins, after the first reply) to its status-line command. Shows `?` until the script is installed as the status line |
| MiniMax (Token Plan) | the calls mcode's `/usage` makes: `GET platform.minimax.io/v1/api/openplatform/coding_plan/remains` with mcode's stored login as bearer token (read per request, in memory, never logged or kept) (plan name/expiry are not read: that needs mcode's signed client calls, deliberately not replicated) | 5h used % = 100 - remaining %; week is `unlimited:true` (no %, never triggers the weekly-projection hold) or a %. The login is never refreshed: when mcode's access token has expired the plan shows the last value as stale with `mcode login expired — open mcode once` |

A failed read keeps the last good value with `stale:true` and an `error` (the quota sheet shows it); a stale plan
never holds a session. The quota sheet shows each plan's subscription and "unlimited" weekly windows.

Env: `CODEX_BIN` (default `~/.local/bin/codex`), `MINIMAX_AUTH_FILE` (mcode login file, default the `en`/prod one),
`CLAUDE_RATE_LIMITS_FILE` override the paths.

Claude status line: in `~/.claude/settings.json` set
`"statusLine": {"type": "command", "command": "/home/<user>/ghosty-sessions/scripts/claude-statusline-ratelimits.sh"}`
(needs `jq`). It reads only the JSON on stdin and prints `model 5h NN% wk NN%`.

## Usage (Langfuse)

A local Langfuse (v3) on the host plus a tailer, `usage/ingest.js`, give token usage and cost per
session, project, agent, model and day. The tailer sends usage numbers and ids only, never prompt or
reply text.

- **Langfuse**: Docker compose in `~/langfuse-codebox/` (outside any repo; web, worker, Postgres,
  ClickHouse, Redis, MinIO, named volumes, `restart: unless-stopped`). Only the web UI is published,
  on `127.0.0.1:3100` and the tailnet IP `:3100` (open `http://<tailnet-ip>:3100`). Login, project
  `codebox-usage` and its API keys come from the headless-init variables in
  `~/langfuse-codebox/.env` (chmod 600). Telemetry and signup are off.
- **Tailer**: unit `systemd/ghosty-usage.service` (`sudo ln -sf $PWD/systemd/ghosty-usage.service /etc/systemd/system/`,
  `daemon-reload`, `enable --now`). It reads the API keys from `~/.config/ghosty/usage.env`
  (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optional `LANGFUSE_URL`), chmod 600.
- **Sources**: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`, including `subagents/`), Codex
  rollouts (`~/.codex/sessions/**/*.jsonl`, one generation per `token_usage_record`), and MiniMax
  (`local_runtime_token_usage` in `~/.minimax/v2/sqlite/runtime-state.sqlite`, read-only; the table has no
  model column, so `MINIMAX_DEFAULT_MODEL` is assumed and cost stays unknown).
- **Per message**: one trace per agent session, one generation per assistant turn (deterministic ids, so replays
  upsert). A Claude message is logged as several lines with the same `message.id` and a growing
  `output_tokens`; the largest wins. `usage/prices.json` holds USD per million tokens per model-id prefix
  with `source` and `as_of`; a model without a price gets no cost (never guessed).
- **State**: `~/.local/state/ghosty/usage-offsets.json` (byte offsets), `usage-ledger.jsonl` (one compact
  record per turn), `usage-summary.json` (rewritten every minute: totals per session / project / agent / model /
  day for the last 14 days, plus `outliers` = sessions whose cost per active hour today is over 3x their
  project's median; rule in `buildSummary()`), a `today` block (totals / agent / project / model for the UTC day)
  and per session `today`, `days`, `activeHours` for the usage view.
- **Rerun the backfill**: `node usage/ingest.js --backfill` (forgets offsets, re-reads the last `BACKFILL_DAYS`
  days; Langfuse upserts by id, no duplicates). `--once` does a single pass.

| var | default | meaning |
|---|---|---|
| `LANGFUSE_URL` | `http://127.0.0.1:3100` | Langfuse base URL |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | unset (required) | project API keys |
| `BACKFILL_DAYS` | `14` | first-run / `--backfill` window and summary window |
| `USAGE_PACE_MS` | `1500` | pause between ingestion requests (100 events each) |
| `USAGE_POLL_MS` / `USAGE_SUMMARY_MS` | `15000` / `60000` | tail cadence / summary cadence |
| `CLAUDE_PROJECTS_DIR` / `CODEX_SESSIONS_DIR` / `MINIMAX_DB` | under `$HOME` | source locations |
| `MINIMAX_DEFAULT_MODEL` | `MiniMax-M3` | model name assumed for MiniMax rows |
| `USAGE_PRICES` | `usage/prices.json` | price table |

The `session:` tag is the tmux session name (matched from the pane's current path to the transcript's
`cwd`, only for traces active in the last 10 minutes), else the cwd's folder name.

### Usage view (UI)

The bar-chart icon in the topbar (next to the robot) opens **Usage - API-equivalent**: tabs **Today** (UTC day)
and **14 days**, with totals, per agent, per project (top 10), per session (top 15, outliers first; project,
agent, model, cost, tokens, cost per active hour), per day (CSS bars, 14 days tab) and per model, tokens as
in / out / cache r / cache w (`12.3M`). A session row opens that session's card; the footer links to Langfuse
(`http://<tailscale-ip>:3100`, tailnet).

- **All costs are API-equivalent at list prices, not money spent.** The plans are flat subscriptions (Claude Max
  200 EUR, Codex / ChatGPT Plus 20 EUR, MiniMax 40 EUR per month); each agent row shows its plan and the live 5 h /
  week quota % from `/api/quota`. MiniMax has no price: cost shows `—` and tokens are shown, never `$0`
  (`costOrNull()`: cost 0 with unpriced turns = null).
- **Chip** on every card header, board row and sidebar entry: `$3.20 today` (or `12M tok today` when unpriced).
  An outlier is red with a warning sign; tap = toast with the reason (`9.9x the <project> median: $4.01/h vs
  $1.2/h`), tap on a normal chip opens the sheet.
- **`GET /api/usage`**: the summary plus `sessions` = `{ <live tmux name>: { todayCost, todayTokens, totalCost,
  outlier, days:[14 x {day, cost, total}] } }`; 404 when the file is absent. The file is cached 30 s
  (`usage-view.js`); the per-tick status payload gets `usage: {todayCost, todayTokens, totalCost, outlier} | null`
  per session from that cache (a Map lookup, no file reads). A session is matched by the summary's `session`
  label (the tmux name, see above); several traces with one label add up.
- `USAGE_SUMMARY` overrides the summary path (default `$GHOSTY_STATE_DIR/usage-summary.json`).
- A summary written on an earlier UTC day (dead tailer) reports no today usage and no outliers. The Today tab and
  per-session `today` / `days` need the tailer that writes the `today` block: after updating, restart `ghosty-usage`.
- Helpers (pure, unit-tested): `public/usage.js`; server side `usage-view.js`; tests `test/usageview.test.js`.

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
│   ├── prio.js                      # priority helpers shared with the server
│   ├── policy.js                    # quota policy + agent suggestion (pure, shared)
│   ├── usage.js                     # usage view helpers: formatting, summary -> session rows (pure, shared)
│   ├── style.css                    # ghosty dark
│   ├── manifest.webmanifest
│   ├── sw.js                        # service worker
│   ├── icon.svg / icon-{192,512}.png
│   └── vendor/                      # xterm.js + xterm-addon-fit (offline)
├── session-meta.js                  # priority + pause hold (sessions.json)
├── quota.js                         # Codex / Claude / MiniMax quota windows
├── usage/                           # Langfuse usage tailer + prices
├── usage-view.js                    # /api/usage + per-session status usage (cached summary)
└── systemd/
    ├── ghosty-sessions.service
    └── ghosty-usage.service
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