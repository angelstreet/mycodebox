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
| `PANE_LINES`  | `2000`  | scrollback lines per pane |
| `NTFY_TOPIC`  | unset   | enable ntfy push: a session starts waiting (high), a disk reaches the critical level (urgent, repeated every 6 h). Keep it secret — anyone with the topic name can read it |
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

## AI manager (shadow mode)

`stall.js` classifies why an agent stopped — `continue`, `menu_recommended`, `permission`,
`owner_decision`, `done`, `error` — with rules first and Jev (closed choice
`continue | take_recommended | ask_owner`) for the ambiguous ones. `manager.js` logs every stall
with what it **would** answer to `stalls.jsonl`, then the owner's real reply as its outcome. It
types nothing. A forbidden topic (deploy, push/merge to main, delete/remove, migration, `.env`,
credentials, money, customer) or an unsent draft in the input box always means "ask the owner",
whatever Jev says. A finished turn that asks something is pushed via ntfy ("X asks you").

```bash
npm run stall-report -- --days 3 --list      # precision per case vs. what the owner answered
curl -s localhost:7777/api/manager            # config + Jev budget
curl -s -XPOST localhost:7777/api/manager -H 'content-type: application/json' \
  -H 'origin: http://localhost:7777' -d '{"session":"task05","sessionEnabled":false}'
```

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
  project's median; rule in `buildSummary()`).
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
├── usage/                           # Langfuse usage tailer + prices
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