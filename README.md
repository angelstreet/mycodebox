# mycodebox

> Repo name: `ghosty-sessions`. **Installing it with an AI agent? Point the agent at [`docs/INSTALL.md`](docs/INSTALL.md); agent rules for working in this repo are in [`AGENTS.md`](AGENTS.md).**

Mobile-first control room for the Claude Code / Codex / MiniMax coding agents running in tmux on `codebox`.
Streams every `tmux capture-pane` to your phone over Tailscale (1 Hz tick),
lets you send keystrokes back, and shows status pills (idle / busy / needs you). On top of that it logs and
classifies every stop, tracks token usage and plan quota, coordinates deploys and device leases, and is the
hands of an AI manager that keeps the sessions moving.

> Read-mostly, send-keys-when-needed. The terminal stays alive on your laptop;
> Ghosty is a peer, not a replacement.

## Why Ghosty exists

### The setup

One person runs a dozen or more AI coding agents at the same time, each in its own tmux session on one coding VM
(`codebox`), each on its own task in its own git worktree: Claude Code, Codex and MiniMax side by side. Most of
those tasks build and test one shared product: a platform of servers, test hosts and real devices
(set-top boxes, phones, emulators). The agents deploy to that platform and run tests on its devices.

That works far better than one agent at a time, and it creates problems a single terminal never had.

### The constraints

| Constraint | What goes wrong without a tool |
|---|---|
| **Attention.** One owner, 15 panes, often away from the desk | Agents stop for small reasons: "continue?", a menu with an obvious choice, "waiting for the deploy", "should I deploy?", or a plain "next I'll do X" and then nothing. Nobody sees it, and work sits still for hours. |
| **Tokens and money.** Three flat subscriptions: Claude Max (200 €/month), ChatGPT Plus for Codex (20 €/month), MiniMax Token Plan (40 €/month), each with a 5-hour and a weekly window | No single view of how much each session burns. One runaway session can eat the week's Claude window and block the urgent work. The same job can cost ten times more on one agent or model than on another. |
| **Visibility.** Who did what, what is deployed, where each task stands | Answers live in 15 scrollbacks. "Was my fix deployed? Which version? Who restarted the server?" has no answer. |
| **Shared platform.** One test platform, exclusive devices | A deploy restarts services under another agent's test run. Two agents drive the same set-top box. An agent waits for a deploy nobody runs, or deploys over someone else's run. |
| **Phone only.** The owner is often away | Decisions must be one tap from the phone, with no extra app. |
| **Safety.** Agents act fast | Nothing may answer a question about a deploy, a merge to main, a delete, credentials, money or a customer on the owner's behalf. Every automatic action must be visible, logged and switchable off. |

### How Ghosty answers them

| Constraint | Ghosty |
|---|---|
| Attention | Live cards for every session with a state (working / waiting / done / idle). Every stop is logged and classified (`stall.js`: continue, recommended menu option, permission, owner decision, done, error, stopped short, waiting for a deploy, owner action). A swipe page lets the owner label stops good or bad, which measures the classifier. Safe stops can be answered automatically after a cancellable countdown; everything else goes to the owner with Jev's call and an AI reviewer's proposed reply. |
| Tokens and money | Usage tailers read every agent's transcripts into a ledger and a local Langfuse: tokens and API-equivalent cost per session, project, agent, model and day, with outliers flagged. Live plan quota: Claude from its status line, Codex from `codex app-server`, MiniMax from its plan endpoint. Priority P0 / P1 / P2 per session, and a policy that holds low-priority sessions before a plan runs out. |
| Visibility | One dashboard: sessions, usage, quota, OpenRouter credit, Jev's decisions, deploys, leases, codebox health. A reporter plugin inside each Claude session reports exact events (turn end, prompt, permission, subagents) instead of guessing from the screen. Every send is recorded with who sent it (`by`). |
| Shared platform | Deploy queue in the shared lease registry (`vpt-lease`): agents request a deploy and wait; ghosty's runner deploys when no lease blocks it and records every deploy in a ledger (what, which version, when, by whom). Leases show on the session cards and on a Platforms page, and a session waiting for a deploy gets its own badge. |
| Phone only | Installable PWA / Android TWA over Tailscale; Web Push for "needs you" alerts. |
| Safety | A forbidden-topic filter that always wins; automatic answers off until measured; per-session and global switches; non-owner senders can only type into a pane that really runs an agent; the owner's Pause sends Esc and holds. |

### The manager: one to run them all

Ghosty is the eyes and hands. The **manager** is the judgement on top, in layers, each cheaper than the next
one up and each passing only what it cannot settle:

```
 owner (phone)            decisions only: merges, product calls, anything risky
   ▲  escalations, batched, one tap each
 manager agent            one AI session following MANAGER.md: priorities vs quota, deploys,
   ▲                      delegation, escalation, daily report. Writes no code.
 Jev + AI reviewer        a cheap model's call on ambiguous stops + a proposed reply with reasoning
   ▲
 rules (stall.js)         instant classification, forbidden topics
   ▲
 ghosty                   watch every pane, log every stop, act (send, hold, deploy), record who did what
```

What the manager does:
- **Keeps sessions moving**: answers the safe stops, nudges a session that stopped short, escalates the rest with the
  question, a proposed answer and why it did not answer itself.
- **Spends tokens where they matter**: P0 first, P2 held when a plan is under pressure; coding work goes
  **MiniMax-first with a Sonnet review gate** (MiniMax builds in a worktree, Sonnet accepts, fixes or rejects,
  the manager ships), so Claude quota is kept for judgement. Its **own** usage is tracked and budgeted like any
  session's.
- **Runs the deploys**: under a standing approval, deploys whenever no lease blocks it; agents queue and wait.
- **Reports**: a daily summary of what shipped, what is blocked, stops and answers, quota, cost, deploys.

Its limits are fixed: it acts only through actions the owner could take from this dashboard, every action is
logged with `by`, every capability has a switch, and it never answers anything touching deploys, merges, deletes,
credentials, money or customers.

Goals, each with a measurable "done when", and the full operating manual live with the task that builds this:
TASK-44 (`docs/tasks/TASK-44-ai-manager.md` and `TASK-44-MANAGER.md` in the platform repo). Today the watching,
logging, usage, quota, deploy queue and reporter are live. Automatic answering is built but off until the
owner's labels show it agrees often enough. The manager agent session is the next step.

## Access

- Phone must be on the same Tailscale tailnet as `codebox`.
- **Plain HTTP**: `http://<codebox-tailnet-ip>:7777/` — works, but Chrome won't
  show the "Install" PWA option. Use Chrome menu → "Add to Home Screen".
- **HTTPS (recommended for PWA install)**: `https://<codebox-tailnet-ip>:7443/`
  — accepts a self-signed cert once, after which Chrome treats it as installable
  and the orange ↓ button in the topbar fires the system install prompt.

The server listens on `0.0.0.0:7777` and `0.0.0.0:7443`. It is reached via
the machine's Tailscale IP (see `tailscale ip -4`). The Proxmox firewall on
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

### Langfuse evaluation (TASK-44 phase 12)

The manager's labels feed the local Langfuse's evaluation features (Langfuse 3.x; scores, datasets, prompts work;
see "Judge" for why its evaluators do not).

- **Scores** (`usage/lfeval.js`, run by the tailer after each pass; own state file `lfeval-state.json`, replay-safe):
  `stop_verdict` (categorical legit / no_reason), `stop_case_correct` (boolean), `ai_proposal_correct` (boolean, the
  owner's right / wrong on the AI's proposal), `jev_agreed` (boolean, the owner's reply vs Jev's pick). They sit on the
  stop's `manager.jev` / `manager.ai-review` generation(s); a stop with neither gets a `manager.stop` span (case, source,
  agent, session; no text). Ids are deterministic, so a label change upserts, an unlabel deletes the label scores. The
  pass is skipped unless `stalls.jsonl` gained a label / unlabel / outcome / triage line. `LFEVAL=0` turns it off.
  CLI: `node usage/lfeval.js [--stalls f] [--state f] [--force]` (one pass; reads the log, never writes it).
- **Dataset `ghosty-stops`**: one item per labelled stop (item id = stop id). input `{closing_text, case_by_rules, agent,
  state}`, expected output `{verdict, correct_case?, owner_reply_kind?}`, metadata `{session, stop_id, at}`. The closing
  text is in it: this Langfuse is local to the box; never export the dataset into the repo or a fixture. Unlabel archives the item.
- **Experiments**: `node scripts/stops-experiment.js --run-name <name> [--classifier rules|jev|ai]` runs the classifier
  over the active items and records a dataset run (a trace per item, scores `case_match` / `verdict_match`, run scores
  `case_accuracy` / `verdict_accuracy`). `rules` is free; `jev` / `ai` call the real endpoints (needs `JEV_URL`, `JEV_API_KEY`).
  Compare runs in Langfuse: Datasets -> ghosty-stops -> Runs.
- **Prompt management**: the reviewer's system prompt is the Langfuse text prompt `ghosty-ai-reviewer` (label `production`),
  fetched with a 10-minute cache (`prompts.js`); the hard-coded `REVIEWER_SYSTEM` is the fallback (Langfuse unset, down, or
  no such prompt). The triage record and the generation carry the prompt name + version. ghosty needs `LANGFUSE_URL`,
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` in its own environment (the usage unit already has them; add
  `EnvironmentFile=-/home/jndoye/.config/ghosty/usage.env` to `ghosty-sessions.service`) - until then the fallback is used.
  Edit the prompt in Langfuse (new version, move the `production` label) to change the reviewer without a deploy.
- **Judge** (`ai_proposal_judge`, 0..1 + reasoning): `scripts/lf-setup.js` creates the OpenRouter LLM connection, the
  evaluator and its rule in Langfuse, but observation-level evaluators need Langfuse v4's events tables
  (`LANGFUSE_MIGRATION_V4_WRITE_MODE`, ClickHouse 25.12); this v3.225 deployment has none, so the rule never fires. The
  same judge therefore runs in the tailer (`usage/judge.js`): opt-in `LFEVAL_JUDGE=1` + `JEV_URL` + `JEV_API_KEY` in the usage
  unit's environment (the judge goes through the VPT server's `POST <JEV_URL origin>/server/ai/complete` with `X-API-Key`,
  same as the AI reviewer in `triage.js` — no OpenRouter key is needed in the ghosty env); at most `LFEVAL_JUDGE_MAX_PER_DAY`
  (400) proposals, sampling `LFEVAL_JUDGE_SAMPLING` (1), only proposals of the last 24 h, each once. It sends the case, flags
  and the reviewer's proposal + reasoning (not the closing text). Cost is estimated from the token counts the server returns
  (`AI_USD_PER_MTOK_IN/OUT`, default 3 / 15), same as the reviewer, via `triage.js` `costOf` (no fixed per-call number); the judge's own cap is 400
  calls/day, and failed calls count against it. `LFEVAL_SEND_AI_OUTPUT=1` additionally puts the proposal on the generation (for a
  future v4 evaluator).
- **Panel**: manager panel -> "Langfuse" links (scores, dataset, evaluator, prompt) from `LANGFUSE_PUBLIC_URL` (else
  `LANGFUSE_URL`) and `LANGFUSE_PROJECT` (default `codebox-usage`).

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
| `VPT_TEAM_ID` | unset | team of the VPT server's decision log (`<team-uuid>`, shown by the server's `/server/health`). With it the manager's Jev calls are written to the product's decision log (`log:true`, `team_id`, `refs`), outcomes are written back, and the Jev & AI tab / decisions page can read the server. Unset = Jev calls are not logged, those pages use ghosty's own log |
| `JEV_DAILY_USD` / `JEV_DAILY_CALLS` | `0.25` / `2000` | Jev budget per UTC day; over it, ambiguous stalls stay with the owner |
| `STALL_SETTLE_MS` | `5000` | a stopped pane must stay unchanged this long before it counts as a stall |
| `GHOSTY_STATE_DIR` | `~/.local/state/ghosty` | manager config, `stalls.jsonl` log, Jev budget |
| `GHOSTY_FORBIDDEN_EXTRA` | unset | extra regex of never-auto-answer words (customer names etc. — keep them out of the public repo) |
| `DONE_IDLE_HOURS` | `6` | a finished agent session turns `done` -> `idle` after this long |
| `AGENT_CMD_CLAUDE` / `_CODEX` / `_MINIMAX` / `_BASH` | `claude` / `codex` / `PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode` / (none) | command typed into a session created via `POST /api/sessions` |

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
`owner_decision`, `done`, `error`, plus `stopped_short`, `waiting_deploy`, `owner_action` (below) — with rules first and Jev (closed choice
`continue | take_recommended | ask_owner`) for the ambiguous ones. `manager.js` logs every stall
to `stalls.jsonl` with what it would answer, then the owner's real reply as its outcome.

**Stops that bother the owner** (finished turns, rules only):

| case | what it is | would answer / escalation |
|---|---|---|
| `stopped_short` | the agent says what it will do next ("I'll start adding X", "Next I'll ...", "Once it is built I'll rerun ...") and stops, no question, no blocker (a wait, "I'm stopping here", "say the word", a running background job all rule it out) | "Yes, continue." (auto case, off by default) |
| `waiting_deploy` | waiting for leases, live runs or a go-ahead to deploy / restart | never answered; escalated "deploy waiting — queue it (Phase 7)"; the log record carries `deployHint: {scope?, ref?}` (`--host` / `--server` / `--frontend`, `update_core <ref>`, `main`) |
| `owner_action` | the agent asks the owner for a small manual thing (reload a page, plug a device, press a button, check the phone) | never answered; escalated "needs you: <short action>" |

Any finished-turn stall also carries `no_status`: the closing text (the agent's own words, not tool
output) never says what is done / tested / left / next / blocked. It is a flag, not a case, and is not set
for questions, deploy waits or owner actions. A `done` stall with `no_status` has the would-answer
"Before stopping: what is done, what is left?" (auto case `ask_status`, off by default).

**One stop, one record.** A TUI that merely repaints makes ghosty show `working` for a few seconds; that
is not progress. A session only counts as having moved on when real work was seen (the spinner signal
ghosty already computes, passed to `observe` as `realWork`) or ghosty sent it something. An outcome is only
logged after that, and a stall identical to the last logged one is not logged again unless one of those
happened in between.

The last 5 logged stops (hashes of their whitespace-free closing text) are kept per session in `<state dir>/last-stops.json`,
so a service restart or a repaint does not log it again either; real work, a send or a reporter prompt in between
resets that list, so the same words then count as a new stop. An `outcome` only uses a reply that came after the stop: the reporter's prompt must
be newer than the stall, and from the pane only a `❯ prompt` line below the stall's closing text counts (an older prompt
above it, or a closing text no longer on screen, gives kind `unknown`).

**Safe defaults.** `autoSend` off, `autoCases: []`, `aiTriage: 'simulate'`, `aiAutoCases: []`: the owner picks
every case that may be auto-answered (`POST /api/manager`). `owner_decision` is never in a default list.

**Router shadow (`routerShadow`, default on).** For every new distinct stop, after the rules classified it, ghosty fires one
`POST /server/ai/decide` (usage `text.decision.manager`, profile `jev`, `refs.source: "ghosty-router"`) with three questions: the stop's
case, whether only the owner can answer, and who to wake. The answers go to `stalls.jsonl` as `{type:"router", id, rule_case, escalated,
router:{case, caseConf, owner, wake, wakeConf, decision_id}}` and the stop's outcome is posted to the decision once it is known. It is
shadow only: it never changes a reply, push, hold or wake, uses the same daily Jev budget and skips when the OpenRouter credit is 0. The
scorecard's `router` section per day compares it with the rules. Off: `POST /api/manager {"routerShadow":false}`.

**Who acted (`by`).** `POST /api/send/:session`, `/api/send-many`, `/api/manager/label`, `/api/session-meta/:session`
and `/api/deploys/:id/approve|cancel` take an optional `by` (string, 1..40 characters; default `owner`, which is what
the UI means). The Opus manager agent passes `by: "manager-agent"`. It is logged in `stalls.jsonl` (`{type:'send'|
'pause'|'resume'|'priority'|'deploy_action', by}`, and `by` on `label` records) and shown on the lines of the manager
panel log.

**Non-owner sends are gated on a live agent.** Any sender other than `owner` (`POST /api/send/:session`,
`/api/send-many`, `/api/session-meta/:session`) gets a 409 when the pane has no claude / codex / minimax process —
the guard looks at the live process tree, never at the pane text, so a `sleep` shell with old MiniMax JSON in its
scrollback is not mistaken for an agent. The owner uses Ghosty as a terminal too (shells included), so `by:"owner"`
is always allowed. Refusals are logged as `{type:'send-refused', session, by, reason}`.

**Alert API.** `POST /api/alert {title, body, url?, priority?, tag?}` is the manager agent's channel to the owner.
Loopback peers only, with the reporter token header (`x-ghosty-reporter-token`); anything else is 403 / 401. It goes
through the normal `alert()` (same debounce per `tag` or title, notification feed, Web Push, ntfy): the answer is
`{ok:true, sent:true}` or `{ok:true, sent:false, debounced:true}`. `title` 1..120, `body` 1..1000, `url` starts with
`/` or `http(s)://`, `priority` one of `min|low|default|high|urgent`. At most 10 calls per hour (429 beyond).

**Manager event feed.** Every alert that actually fires (not debounced) is appended as one JSON line to
`~/.local/state/ghosty/manager-events.jsonl` for the AI manager agent to follow, so it wakes only when something
happens. Follow it with: `tail -n0 -F ~/.local/state/ghosty/manager-events.jsonl`. Skipped: events whose session
is in `manager.json` `managerSessions` (default `["manager"]`), the agent's own `/api/alert` calls
(`manager-agent:<tag>` keys), and `done` (a finished turn). The file rotates to `manager-events.jsonl.1` when
the next append would push it past 5 MB. A freshly-started agent catches up via
`GET /api/manager/events?since=<ISO>&limit=50` (newest last).

**Wake shadow (`jev` on each event line).** Each line also carries Jev's opinion on whether that event needed
waking the manager agent: `jev: { pick, confidence, source, ruleDefault, decision_id, ms }`, where `pick` is
`ignore | rules_handle | wake_cheap | wake_opus` (the last two mean "wake"), `source` is `jev` (or `forced` when a
hard floor decided, no call made) and `ruleDefault` is what the rules alone would have picked. No call is made when
there is nothing to ask: `jev: { skipped: <why> }` (Jev not configured, daily budget, no OpenRouter credit, 402
cool-down) or `jev: { error: <kind> }` (`timeout` after the 3 s cap, `network`, `http`, ...). The call happens before the
line is appended and never delays an event by more than ~3 s or blocks other events. It is SHADOW: the rules still
decide what is recorded and what is sent. Fifteen minutes later ghosty labels each event from its own records
(`wake_outcome` in `stalls.jsonl`, once per event, restart-safe): `needed` if the manager agent acted on it (a send
by anyone but the owner, an auto answer, a `/api/alert` naming the session) or the owner did (send, outcome, popup
choice, deploy action), else `not_needed`; deploy / quota / disk / credits events count only an agent alert about them
(plus the owner's deploy action), because ghosty records no other owner action there. The label is posted to the
Jev decision as `{label, by: 'observed-15min', event_key}`, and `GET /api/manager/scorecard` gets a `wakeShadow`
section per day (annotated / skipped / errors, Jev wake vs not, needed vs not, agreement, misses and false alarms
by kind, the same for the rule default). Switch: `manager.json` `wakeShadow` (default `true`), or
`POST /api/manager {"wakeShadow": false}`.

**Per-wake log.** The manager's Claude Code transcript is the only complete record of its wakes, so `manager-wakes.js`
splits it into wakes (a wake starts at an owner prompt, a task-notification (Monitor event / expiry, background task,
subagent done), a scheduled sweep or a cross-session message, and ends before the next) with trigger, tool counts,
alerts / sends / workers / file writes, the first line of its final text, tokens and usd (same price table as the usage
ledger). `node scripts/manager-wakes.js [--day YYYY-MM-DD] [--json]` prints the table and a daily summary (wakes and usd per
trigger, top 5 most expensive, share of wakes that did nothing) and rewrites `<state dir>/manager-wakes.jsonl` for that
day. The transcript is found through the usage ledger: Claude session ids whose rows carry a label from `managerSessions`
-> `~/.claude/projects/<project dir>/<id>.jsonl`. `GET /api/manager/wakes?day=` (UTC day, cached 60 s) feeds the "Wakes
today" block of the AI manager panel.

**Health watchdog (zero tokens unless a problem remains).** `scripts/health-watch.js` (no deps, no AI calls) runs every
5 minutes from `systemd/ghosty-health-watch.timer` (`.service`: oneshot, `User=jndoye`; install with `sudo cp` to
`/etc/systemd/system`, `daemon-reload`, `enable --now ghosty-health-watch.timer`). It checks disk % of `/`, load vs
cores (sustained: the last samples in `~/.local/state/ghosty/health-watch-state.json`), RAM available %, runaway
processes (yours, older than `runawayHours`, and RSS over `runawayRssMB` or CPU over `runawayCpu` % across two
samples 5 s apart; claude, tmux and the ghosty server are never runaways) and stuck patterns (a bare `node --test`,
too many defunct processes). Healthy = exit 0, only the state file is touched. When a check trips it writes a markdown
report to `~/.local/state/ghosty/health-reports/<ISO>.md` (kept 7 days): top 15 processes by CPU and RSS with their
owning tmux / Claude session, disk use of `/tmp`, `~/.cache`, `~/.claude`, `~/.npm`, the journal, docker (if usable),
and every `~/vpt-*` / `~/ghosty-*` dir with its worktree / clean / merged / live-session status. Thresholds live in
`~/.local/state/ghosty/health-watch.json` (created with defaults: `diskPct` 85, `loadPerCore` 1.0 for `loadMinutes` 10,
`ramAvailPct` 10, `runawayHours` 2, `runawayRssMB` 1024, `runawayCpu` 80, `fixLevel`).

**Daily checks (zero tokens unless something is wrong).** `scripts/daily-checks.js` (no deps, no AI calls) runs once a day at
07:00 Europe/Zurich from `systemd/ghosty-daily-checks.timer` (install like the health watchdog; `Persistent=true` catches a
missed run). It is a generic runner: the checks are defined in the private, untracked
`~/.local/state/ghosty/daily-checks.json` (`debounceHours` 20, `keepDays` 14, `checks[]` of `{id, title, command[], timeoutSec}`).
A check command prints one JSON line `{summary, report, findings:[{key, title, body, priority}]}` and exits 0; no findings =
healthy. A check that crashes, times out or prints garbage becomes the finding `daily:check-broken:<id>`. The runner writes
the full report to `~/.local/state/ghosty/daily-reports/<date>.md` (kept `keepDays`) and appends ONE line per finding to
`manager-events.jsonl` (kind `daily`, key `daily:<key>`, title <= 80, body <= 300 ending in the report path), debounced per
key via `daily-checks-state.json` (same text inside the window is not repeated; a key that clears is forgotten). Flags:
`--dry-run` (report only, no event, no state), `--only <id>`. Keep repository names, term lists and customer names in the
private config and check scripts, never in this repo.

Fix levels (`fixLevel`, only acted on when the disk check trips): `report` = no fixes; `cleanup` (default) = delete
`/tmp/claude-1000/<project>/<session-id>/` scratch dirs whose session is not live and older than 2 days, `journalctl
--user --vacuum-time=7d` (skipped without rights), `npm cache clean --force` when `~/.npm` > 1 GB; `cleanup+orphans`
(OFF by default) also SIGTERMs runaway / bare `node --test` processes that belong to no live tmux or Claude session;
`cleanup+worktrees` also runs `git worktree remove` (never forced) on worktrees that are clean, merged
into `main` and have no live session (no orphan kills); `cleanup+all` = both. On codebox since 2026-10-05: `cleanup+worktrees`
(owner: "if a worktree has no session, delete"). Never touched: anything under a live session, any other worktree, anything
outside `/tmp/claude-1000` for the scratch cleanup. Every deletion and its size goes in the report.

The AI manager is woken only if a problem REMAINS after the fixes (disk still over the limit) or needs a decision (a
runaway inside a live session, sustained load, low RAM, a stuck `node --test`): one line `kind: "health"`, key
`health:<issue>` appended to `manager-events.jsonl` (no `jev` field: the watchdog writes it directly, not through
ghosty). The same issue key is written at most once per `debounceHours` (6) unless it worsened (disk +3 points, a new
runaway). `--force` investigates even when healthy; `--dry-run` deletes nothing and writes no event.

**Owner labels.** In the manager panel every stop has 👎 (stopped for no reason) / 👍 (legit) buttons,
a "wrong case" picker and an optional note; "unlabelled stops only" filters the list and a row's session
name opens its card. `POST /api/manager/label {id, label: no_reason|legit|wrong_case, note?, correctCase?}`
appends `{type:'label', ...}` to `stalls.jsonl`. `npm run stall-report` prints labels per case and the
`no_reason` examples; `--export <file>` writes the labelled stops as JSON (pick a path outside the repo: the
excerpts are real text) for future fixtures; `--reclassify` re-runs the current classifier over the logged
excerpts and prints how cases change (the log is not modified).

**Router (TASK-47, shadow).** `router.js` lets Jev (in `POST /server/ai/decide`) pick, inside hard
floors, who handles manager work — wake (`wake_cheap`/`wake_opus` only when something is p0-blocked,
a deploy has failed, the disk is critical or any plan quota is at >= 95%), builder (`minimax`/`codex`
off the table when the work touches infra/deploy/secrets/migrations or a public repo's security; P0
product decisions are forced to `opus`), reviewer (must be a real reviewer when the repo is public
or the work touches `auth`), retry (no more same-builder retries after round 2) and a `model` hint
that is suggestion only. The pure module, its `test/router.test.js` and `test/fixtures/router-states.json`
(50 hand-made states, 10 per point) live in the repo; `scripts/router-dryrun.js --dry` prints the
request bodies without calling the server, and without `--dry` it POSTs each fixture to the VPT
server and prints one line per state plus a per-point agreement roll-up. **Nothing live calls it yet**
— the wiring to the manager is a later step.

**Asking Jev (`jev-ask`).** "Jev makes the call when in doubt": a CLI the manager agent runs from its
shell whenever it is unsure. Same six points as the router (`wake`, `builder`, `reviewer`, `retry`,
`stop`, `model`), same floors. Pass facts inline (`--facts '<json>'`), from a file (`--facts-file <path>`)
or on stdin (`--facts -`). Env: `JEV_URL` + `JEV_API_KEY` + `VPT_TEAM_ID` (process.env, else
`<repoRoot>/.env` parsed by the script itself; the key is never printed). It POSTs one
`/server/ai/decide` (20 s timeout, `log:true`) and prints exactly one JSON line on stdout:
`{point, pick, confidence, source, ruleDefault, allowed, decision_id}` (`source` is `forced` | `jev` | `rule`).
Take Jev's pick only at `confidence >= 0.7` (the default threshold); below that, the script falls
back to the point's `ruleDefault` and continues when the network is down. Exit 0 on every printed
pick (forced, Jev, or rule), exit 2 on bad usage. The `stop` point's floors: `forbidden_topic` or
`case in {permission, owner_action, waiting_deploy}` are forced to `escalate`; otherwise the
conservative ruleDefault is `escalate`, except `case = "continue"` → `answer`. Every call also appends
one line to `<state dir>/manager-asks.jsonl` (`$GHOSTY_STATE_DIR` or `~/.local/state/ghosty`):

```bash
node scripts/jev-ask.js stop \
  --facts '{"session":"s1","agent":"claude","case":"owner_decision","proposed_reply":"Migrate /v1 first."}'
# -> {"point":"stop","pick":"escalate","confidence":0.83,"source":"rule","ruleDefault":"escalate","allowed":["answer","escalate"],"decision_id":"..."}
```

**Answer popup (TASK-44 phase 11).** One bottom-right popup shows every session that needs you
(the same set the NEEDS YOU strip does — `waiting` or `done` with a non-pending triage). Each item: the
question (max 220 chars), the answer buttons from `public/buttons.js` (`yesno` → Yes / No + Reply…,
`menu` / `either` → one numbered row per option + Reply…, `open` → Reply…), the AI reviewer's pick
pre-highlighted with a ★ (only when the proposal maps to a button that has no `confirm` and the AI
didn't mark it `owner_needed`), and the bottom line `AI ★ <confidence %>   Jev: continue <p%> · recommended <p%> · ask you <p%>`
(omitted when Jev didn't run). Cards keep only a one-line "asks you ★" chip; tapping it (or a name on
the NEEDS YOU strip) opens the popup on that session; tapping the session name inside the popup opens
the card. A TUI repaint that flips state to `working` for a few seconds is **not** progress: a session
stays in the popup queue until the owner answered it, its non-eligible streak hits 8 s, or its stall
id changed. The popup slides up (transform translateY + opacity, ~200 ms) only on a brand-new stall id;
content updates in place otherwise. Reply… prefills the existing dock for that session. Sending uses
the same `/api/send` + confirm-on-forbidden path as the dock. Desktop keys: `1..9` picks an option,
`y`/`n` for yes/no, `Enter` the highlighted one, `Esc` minimises; the minimised pill bottom-right
(`N need you`) reopens it (remembered in `sessionStorage`). Code: `public/ask-model.js` (pure queue /
AI→button / jev line / jev-agreement mapping), `public/ask-popup.js`, CSS in `public/style.css`.

**Owner choice log.** Every owner tap in the popup posts `POST /api/manager/choice {id, session,
kind:<yesno|menu|either|open>, owner:<button id|'reply'>, ownerText? (Reply only, 200 chars), ai:<button id|null>,
aiConfidence?, jev?:<choice>, jevProbabilities?}` and the server appends `{type:'choice', at, id, session, kind, owner, ai,
agreeAi:owner===ai (null when ai null), jev, agreeJev (computed by the server)}` to `stalls.jsonl` (next to
`/api/manager/triage`; same loopback / auth as its neighbours). Jev-agreement mapping (same on the
client and the scorecard): `continue`/`take_recommended` agrees when the owner picked the highlighted
(Yes, or the recommended option); `ask_owner` agrees when the owner picked anything other than the
AI highlight or tapped Reply. The manager panel shows today's calls/cost; the scorecard's quality is
the share of `choice` records with `agreeAi===true` among those with `ai!=null`.

**AI reviewer (TASK-44 phase 9).** For every stop that goes to you (not plain `done`, not
`background_wait`, not what auto-answer handles) the reviewer reads it after the rules and Jev: one
`POST <JEV_URL host>/server/ai/complete` (usage `text.plan`, same `X-API-Key`) returns
`{proposed_reply, reasoning, confidence, owner_needed, owner_needed_why}`; one call per stop, 25 s
timeout, daily budget `aiDailyUsd` (1.00) and `aiDailyCalls` (300) in `ai-budget.json`. It is logged
as a follow-up `{type:'triage', id, ai, cost, ms}` record and used by the popup (highlight + bottom
line); the NEEDS YOU strip and the push body show a one-line preview. `manager.json` `aiTriage`:
`off` | `simulate` (default: compute, show, log, never type) | `auto` (owner-only switch: an AI
proposal with `owner_needed:false`, confidence ≥ `aiMinConfidence` (0.85), no forbidden topic in the
question or the reply, no draft, case in `aiAutoCases`, goes through the normal countdown / hourly
cap / fire-time checks, and needs `autoSend` too). `AI_URL` overrides the derived reviewer URL.
In the swipe review the card shows the AI proposal; ✓ right / ✗ wrong posts `{type:'label', id, aiVerdict}` (does not label the
stop itself); `npm run stall-report` prints the AI agreement; the manager panel shows the switch, today's calls / cost and the agreement. The server returns token counts, not a cost, so the logged cost is an
estimate (`AI_USD_PER_MTOK_IN/OUT`, default 3 / 15).

**Swipe review (the main way to label).** `/?review=1`, the topbar button (cards icon) or "Review stops (N)" in the
manager panel opens a full-screen deck of unlabelled stops, newest first, one card at a time: session (tap = open its
card) · agent · age, the case the manager chose, what it would have answered, Jev's pick, `no_status`, and the full closing
text (the end is scrolled into view), plus your own reply if one was logged. **Swipe right = good** (a legit stop, label
`legit`), **left = bad** (stopped for no reason, `no_reason`), **up = skip** (no label, back of the deck). The card follows the
finger, tilts, shows a BAD / GOOD stamp past the threshold and snaps back under it. Buttons (✕ ↷ ✓) and the keys ← ↑ → do the
same; **Undo** (button, Backspace, `u`, Ctrl+Z) withdraws the last swipe. **Long-press** a card for a note and "manager got the
case wrong" (the correct case); they ride on the next swipe, which still decides good/bad. The panel's 👎/👍 remain but are
dimmed.

- `GET /api/manager/review?limit=50` -> `{cards, unlabelled, labelledToday, cases}`: unlabelled `stall` records (no effective
  label), newest first, each with id, at, session, project, agent, state, case, source, why, wouldSend, deployHint, no_status,
  jev {choice, confidence}, excerpt and `outcome` {reply, kind, via, afterSec} when the owner's reply was logged.
- `POST /api/manager/unlabel {id}` appends `{type:'unlabel', id}`. Readers (`effectiveLabels` in `manager.js`, the panel,
  `stall-report`) treat it as: the newest `label` of an id wins, an `unlabel` after it removes it. A `label` record may carry
  `correctCase` next to `no_reason`/`legit`; the report counts it under `wrong_case` as well.
- Code: `public/review.js` (loaded on demand), styles `.rv-*` in `style.css`.

**Sending is off by default.** Turn it on (`autoSend`) and only the cases in `autoCases` are typed
(`continue` and `stopped_short` -> "Yes, continue."; `ask_status` -> the status question; `menu_recommended` -> the option's number in a live menu, or "Yes,
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
| `autoCases` | `[]` | cases allowed to auto-send; valid: `continue`, `menu_recommended`, `stopped_short`, `ask_status` |
| `minConfidence` | `0.8` | Jev-derived answers need this probability for the chosen option (rule answers count 1.0) |
| `delayMs` | `30000` | countdown before an answer is typed |
| `maxPerSessionPerHour` | `4` | auto answers per session per rolling hour |
| `disabledSessions` | `[]` | sessions the manager ignores (tick them off in the panel) |
| `policyEnabled` | `true` | quota policy by priority (below) |
| `p1MaxPct` / `p2MaxPct` | `80` / `80` | 5 h fill at which P1 / P2 sessions are held |
| `managerSessions` | `["manager"]` | session labels whose `claude` / `codex` runs count toward the manager's own tokens in the scorecard (subagents are reported separately) |
| `scoreWeights` | `{quality:0.4, coverage:0.3, efficiency:0.3}` | how the three components combine into the scorecard number; a component that is null drops out and the others renormalise |
| `planBudget` | `{claudeWeeklyPct:10}` | scorecard `efficiency` is 1 when the manager's Claude weekly share is at or under this budget pro-rated to the elapsed fraction of the plan-week, falling linearly to 0 at 3x that; `null` when no Claude quota data |

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

### Scorecard

The Usage view's Overview (`public/usage.js` → `managerBlockHtml`) shows a **Manager** block at the
top: a 0-100 score with its three components, every token the manager caused today (no USD), the
manager's share of the Claude Max weekly plan, the Jev integration stats, and a 7-day mini bar of
the score. Behind it:

- `GET /api/manager/scorecard?days=7` (60 s in-process cache) returns `{ today, days:[...] }`. The
  loader (`scorecard.js`) tails `usage-ledger.jsonl`, `stalls.jsonl`, `manager-runs.jsonl` and reads
  `claude-rate-limits.json` (the same file the quota module polls) for the seven_day window, then
  folds everything in memory and runs `buildScorecard` per UTC day.
- **Tokens** (`cost.session` / `subagents` / `workers` / `jev` / `reviewer` / `judge` / `total`) is
  split by who paid the token; every bucket is `{tokens:{input,output,cache_read,cache_write}, calls}`
  and there is no USD anywhere in the scorecard (the owner is on a subscription, not on a meter):
  - session + subagents = `claude`/`codex` runs whose `label` is in `managerSessions`
    (`subagent:true` rows are reported separately — that's where the Sonnet review gates show up).
  - workers = `minimax` rows whose `cwd` is inside an open window in `<state dir>/manager-runs.jsonl`.
    Windows are opened with `node scripts/manager-run.js start --kind minimax --worktree <abs path>
    --task <text>` and closed with `... end <id> [--verdict accepted|fixed|rejected]`. MiniMax has
    no price and its weekly plan is unlimited, so workers' tokens are reported standalone.
  - jev = `agent:'manager', name:'manager.jev'` — OpenRouter calls (real money, not the Claude
    plan), tokens + calls only.
  - reviewer = `agent:'manager', name:'manager.ai-review'` — tokens + calls only.
  - judge = `agent:'manager', name:'manager.judge'` — `usage/judge.js` appends one ledger row per
    judged call (success or unparsable), matching the shape of the AI reviewer rows; tokens + calls only.
- **Claude plan share** (`claude_weekly_pct`, `claude_today_pct`, `budget.planWeek`): the manager's
  share of the Claude Max weekly plan. Internal weight per ledger row = `cost.total` (it reflects
  how the plan limits weigh models, output and cache) and is never displayed. Manager weight = sum
  of `cost.total` for `claude` rows whose label is in `managerSessions` (subagents included) in
  the plan-week; total weight = sum of `cost.total` for every `claude` row in the plan-week. The
  plan-week ends at the `seven_day.resets_at` from `claude-rate-limits.json`; when that's unknown
  (status-line hook not installed) the rolling last 7 days stand in. `claude_weekly_pct` =
  `managerWeight / totalWeight * seven_day.used_percentage` (0 when the manager owns nothing yet
  the plan has data). `claude_today_pct` is the same ratio over rows in `[from, to)`.
- **Performance** (`perf.{stops,resolved,resolvedFast,auto,escalated,medianTtrSec,p90TtrSec,agreement,
  ownerChoices, agreeAi, agreeAiN, agreeJev, agreeJevN, legacyLabelAgreement}`) reads `stalls.jsonl`:
  `auto` = send by `!= 'owner'` within 10 s before the outcome OR `outcome.via === 'ghosty'`;
  `ownerChoices` / `agreeAi` / `agreeJev` are the popup choice records (`{type:'choice', id, owner,
  ai, agreeAi, jev, agreeJev}`, see "Owner choice log" above): `agreeAi` is the share of choices
  where the owner picked the AI's highlighted button (over those with `ai != null`); `agreeJev`
  uses the Jev-agreement mapping the popup uses. `agreement` is the same as `agreeAi` (popup choices
  are now the quality signal); `legacyLabelAgreement` keeps the share of `no_reason|legit` label
  verdicts for any caller that still wants it. Ledger rows that share an id are deduped (latest
  wins) before summing tokens — a growing-id writer rewrites the same row.
- **Jev integration** (`jev.{consulted,errorRate,agreement,p50ms,overridden}`):
  consulted = `stall.source === 'jev'` or a `stall.jev.choice`; ambiguous = cases
  `owner_decision|continue|menu_recommended`; agreement = Jev said `continue`/`take_recommended` and
  the outcome matched, OR Jev said `ask_owner` and the outcome was `owner_specific`/`unknown`;
  overridden = `stall.forbidden` blocked the Jev pick.
- **Score** is the weighted average of `quality` (popup `agreeAi`), `coverage` (`resolvedFast /
  stops`) and `efficiency`. `efficiency` is 1 when `claude_weekly_pct` is at or under the
  `planBudget.claudeWeeklyPct` pro-rated to the elapsed fraction of the plan-week, falling linearly
  to 0 at 3x that; `null` when there is no Claude quota data. A null component is excluded and the
  remaining weights renormalise. Weights and budgets live in `manager.json` (`scoreWeights`,
  `planBudget`).
- **Langfuse**: once per 15 min the `usage/ingest.js` tailer calls `createScorecardPoster`, which
  posts the current day's scorecard as `manager.score`, `manager.quality`, `manager.coverage`,
  `manager.efficiency`, `manager.claude_weekly_pct`, `manager.claude_today_pct`, `manager.tokens`,
  `manager.workers_tokens`, `jev.consulted_rate`, `jev.error_rate`, `jev.agreement`, `jev.p50_ms`
  on a deterministic trace `manager-scorecard-<YYYY-MM-DD>` (trace name `manager-scorecard`),
  upserting.
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
npm run stall-report -- --days 3 --list      # precision per case vs. what the owner answered, owner labels
npm run stall-report -- --days 3 --reclassify --export ~/labelled-stops.json
curl -s localhost:7777/api/manager            # config + Jev budget + today's counts
curl -s -XPOST localhost:7777/api/manager -H 'content-type: application/json' \
  -d '{"autoSend":true,"autoCases":["continue"],"delayMs":30000}'
curl -s -XPOST localhost:7777/api/manager/cancel/task05 -H 'content-type: application/json' -d '{}'
```

**MiniMax shadow manager (experiment, TASK-47 G11).** A parallel loop (`scripts/mm-manager.sh`)
that follows the same `manager-events.jsonl` and proposes what the manager should do for each event —
running it through MiniMax, calling `scripts/jev-ask.js` when in doubt, and Sonnet only when Jev was
unsure (`source:"rule"`). **Shadow only: it never acts.** No POST, no send, no alert, no wake — read-only
GETs to `127.0.0.1:${GHOSTY_PORT:-7777}` and a single `mcode exec` per batch. Each batch appends one
record per event to `${GHOSTY_STATE_DIR:-~/.local/state/ghosty}/mm-manager-decisions.jsonl` (the
proposal plus `mm_ms`, `mm_tokens`, `sonnet_usd`, `batch_id`); the prompt and raw mcode output are
kept under `<state>/mm-manager/<batch_id>.{prompt,json}` (last 200 batches). Start it inside tmux so
the loop survives — and only after reading the runbook:

```bash
tmux new -d -s mm-manager 'scripts/mm-manager.sh'           # do NOT start it
node scripts/mm-manager-compare.js [--day YYYY-MM-DD] [--json]   # grade the day vs. the real (Sonnet) manager
```

Compare output per day: events, proposals by kind, agreement / misses / risky verdicts, Sonnet calls
and their `$`, MiniMax tokens, and the real manager's Claude `$` from the ledger. Any stall record
with `by` containing `mm-manager` is printed as `AUDIT FAIL` (the shadow never acts, so any such
record is a bug).

## STATUS meter (what a turn took)

Agents end a turn with `STATUS: <verdict> — <useful info>` (e.g. `STATUS: done — Status page shows VM summary (abc123), left: 23 tables`).
Agents cannot measure their own tokens or time, so ghosty does and shows one line:
`STATUS: done · 4m 01s · 1.3M tok · <info, max 200 chars>`. A part that cannot be known is left out, never guessed.

- Claude (reporter plugin): elapsed = prompt received -> `turn.complete`; tokens = the summed `turn.complete` usage (input, output,
  cache read, cache write; subagent turns of the same turn included).
- Codex / MiniMax (no hooks): elapsed = last owner/manager send -> the poll that saw the stop; tokens = `usage-ledger.jsonl` rows with
  that session's label dated in that window. The tailer writes the ledger a few seconds after a call, so a stop seen at once may
  undercount; the status payload re-reads it for 2 min. A stop that predates ghosty has no elapsed / tokens.
- Where: `GET /api/sessions` status entry `lastTurn` `{at, elapsedMs, tokens{in,out,cacheRead,cacheWrite,total}, status, info, line, source}`;
  the board row and the ask popup details; the first line of the `asks` / `done` push body and of the manager event `body`
  (the event also carries the object as `turn`). Code: `turn-meter.js`, `reporter.js` (`meterOf`), `stall.js` (`statusLine` strips the
  `— – - : ·` separator after the verdict).
- The Stop hook's re-prompt quotes the new form and tells the agent that ghosty adds tokens and time.

## Session reporter (TASK-44 phase 8)

`claude-plugin/ghosty-reporter/` is a Claude Code plugin (function hooks, Claude Code >= 2.1.288) that every
Claude session on the box loads. It is a **pure observer**: every hook awaits `next(e)` and returns its result
untouched, reports after that with an 800 ms bound, swallows every error and prints nothing. If ghosty is
down the session behaves as without the plugin (one failed try, then 30 s of silence).

**Install for all sessions** (owner action, one line in `~/.claude/settings.json`; the plugin is not part of the
settings otherwise):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/jndoye/ghosty-sessions/claude-plugin/ghosty-reporter" } }
```

New sessions pick it up; running ones keep going without it. One session only: `claude --plugin-dir <folder>`.

| plugin env / option | default | meaning |
|---|---|---|
| `GHOSTY_REPORTER_URL` (or plugin option `url`) | `http://127.0.0.1:7777/api/reporter/event` | where events go |
| `GHOSTY_STATE_DIR` | `~/.local/state/ghosty` | where `reporter.token` is read from |
| `GHOSTY_REPORTER_TOKEN_FILE` | `<state dir>/reporter.token` | token file override |

ghosty creates `reporter.token` (0600) in its state dir at startup if missing. `POST /api/reporter/event` accepts
loopback peers only, with the token in the `x-ghosty-reporter-token` header; anything else is 403 / 401.
`POST /api/alert` uses the same check and token (see "Alert API" under the manager).

The session is identified by its tmux session name (`tmux display-message -p -t $TMUX_PANE '#S'`, once, at the first
event) plus the Claude session id and cwd; a session outside tmux is ignored.

| event (plugin hook) | payload | what ghosty does |
|---|---|---|
| `session.start` / `session.end` (`session.start`, `session.end`) | reason | session is `live` / not |
| `prompt` (`prompt.submit`) | the submitted text (exact, 8 KB cap), `synthetic` for engine-raised prompts such as a finished background task | the owner's reply in the stall `outcome` (`via: "reporter"`); a prompt after a stall also counts as the session moving on |
| `turn.end` (`turn.complete`) | the final answer (exact), reason, usage; subagent turns carry `agentId` and are ignored as the session's turn | closing text of the stall classifier |
| `stop` (`classic.Stop`) | `last_assistant_message`, `backgroundWork` = background tasks in flight | `background_wait` when > 0 |
| `waiting` (`classic.PermissionRequest`, `classic.Notification` except idle / auth) | message | marks the session `waiting` even when the pane regex missed it, while the pane stays still |
| `agents` (`agent.spawn`, `classic.SubagentStart/Stop`, `classic.TeammateIdle`, after `turn.complete`) | `$.agent.list()`: id, type, status, description, sent only when it changed | subagent count + statuses in the ⚡ tooltip |

What the manager does with it (Claude sessions only; Codex / MiniMax unchanged): a stop whose turn has a fresh report
(no newer prompt, ended within 20 s of the stop being seen) is classified from the **reported answer text** instead
of the pane excerpt (`textSource: "reporter"`, else `"pane"`, in `stalls.jsonl`; `source` stays the rule / Jev
decision source). A reported turn with background work in flight is logged as `case: "background_wait"` and is never
escalated or answered. The pane is still read for the owner's unsent draft and for waiting menus / permission dialogs.

The status payload carries a small `reporter` object per live Claude session (`seenAt`, `turnAt`, `backgroundWork`,
`waiting`, `agents {count, by}`, `agentList`); the cards show a ⚡ (with the subagent count) whose tooltip lists them.
`GET /api/reporter/:session` returns everything held for one session (latest turn, prompt, waiting, agents).

Develop / test the plugin: `claude plugin validate claude-plugin/ghosty-reporter` and
`claude plugin test claude-plugin/ghosty-reporter` (tests in `ghosty-reporter.test.ts`); ghosty side: `npm test`.

## Deploy queue (TASK-44 phase 7)

Agents do not run `update_core.sh`; they queue a request in the shared lease registry (`vpt-lease deploy request ...`)
and wait (`vpt-lease deploy wait <id> --agent A`). `deploy-runner.js` polls the queue every 30 s and shows it on the
**Platforms page** (approve / cancel, what each request waits on, live log of the running one, a warning when the ref
differs from the last one deployed). A request without `--approved` waits for one tap there and pushes an alert.
The manager sheet keeps only the "Runs deploys" switch and a link to Platforms.

- **Off by default.** The runner only starts deploys when `manager.json` has `"deployRunner": true` (switch in the
  manager sheet or `POST /api/manager {"deployRunner":true}`). Off = it only reads the queue.
- **Env map** (not in the repo): `$GHOSTY_STATE_DIR/deploy-envs.json`, written with defaults on first run:
  `{ "<env>": { "ssh": "<host>", "cmd": "bash update_core.sh", "health": "<optional remote command, exit 0 = healthy>" } }`.
  Only envs in the map are deployed. Scope to flags: `frontend` -> `--frontend`, `host` -> `--host`, `server` -> `--server`,
  `full` -> none. The command runs as `ssh <host> "VPT_LEASE_AGENT=manager:deploy <cmd> <ref> <flags>"` (45 min timeout), output in
  `$GHOSTY_STATE_DIR/deploys/<id>.log`. Without `health`, only update_core's exit code decides done / failed.
- One running deploy per env. Queued requests with the same env + ref that the running scope covers (`full` covers all; other scopes only
  themselves) are finished with its result (`coalescedInto`).
- Registry: `ssh proxmox '~/bin/vpt-lease ...'`; `DEPLOY_REGISTRY='["python3","/path/vpt-lease"]'` runs it locally (tests, live checks).
  `DEPLOY_POLL_MS`, `DEPLOY_TIMEOUT_MS` override the timings.
- **Survives a restart (BUG-0341).** The deploy child is detached (own session, output to `deploys/<id>.run` via a file descriptor) and a
  tiny `sh` wrapper writes `deploys/<id>.pid` / `<id>.exit`. A restarted ghosty re-adopts every `running` deploy of the runner whose
  wrapper is alive or left an exit file, and finishes it as usual; with neither file the orphan sweep still applies. So a restart no
  longer loses a deploy, but the `.pid` / `.exit` / `.run` / `.off` files must not be deleted. The systemd unit must not kill the child on
  stop: `ghosty-sessions.service` needs `KillMode=process` (one line in `[Service]`, in `systemd/`); `/etc/systemd/system` is a hand copy, so
  copy it and `systemctl daemon-reload` (no restart needed for the unit text to be read; it applies at the next stop/start).
- API: `GET /api/deploys`, `POST /api/deploys/:id/approve|cancel`, `GET /api/deploys/:id/log?tail=200`; `{type:'deploys'}` on `/ws/status`.

## Platforms page, lease ownership, waiting for a deploy (TASK-44)

Open it from the ⋮ menu -> Platforms, from a lease chip / purple badge, or `/?platforms=1` (`/?deploys=1`, the push link, opens it too).
One block per platform/env, BLOCKED first, then DEPLOYING, then FREE: a status pill, **NEXT DEPLOY** in one line
(scope, ref, who, when it can start = the end of the lease it waits on, Cancel; several queued fold under "N more"),
**IN USE** (every lease, red when it blocks the next deploy), **LIVE** (every target in the ledger, red when its last
attempt failed) and a collapsed **History**. Agent ids show as plain names (`codebox:TASK-28-x` -> task28,
`claude-mac:...` -> mac, `manager:deploy` -> manager; "session gone" when a codebox holder has no live tmux session).
What blocks follows the runner: full deploys wait on `run` and env-wide leases, host deploys on env-wide ones
(`effectiveBlockers` in `public/platforms-view.js`, same rule as `vpt-lease` with `--skip-leased`).

- **Exact ownership.** A lease belongs to a session iff its agent is `<machine>:<tmux session name>`, case-insensitive;
  `<machine>` is `codebox` or this host's name. Agents get it with `AGENT="codebox:$(tmux display-message -p '#S')"` (deploy skill).
  There is no fuzzy guess: a codebox holder without that exact session shows as "session gone". Code: `public/platforms.js` (pure, shared with the server),
  `leases.js` (reads `vpt-lease list --json`, 15 s cache, injectable `run`).
- **Status payload.** `status[session].lease` = `[{env, resource, ttlLeftMin, purpose, blocksDeploy}]` (`blocksDeploy`: an
  awaiting-approval or queued deploy of that env whose scope touches the resource). `/api/leases` and the `leases` WS message also carry `waiters` and `hostname`.
- **Lease chip.** Only a session holding a lease gets `🔒 pi1/stb4 · 1h40` (`+N` for more) in the card header and board row; amber
  `· blocks deploy` while a pending deploy waits on it. Tap -> Platforms scrolled to that resource.
- **Purple "waiting deploy"** (`status[session].deployWait`, state badge, card border, row, tab, NEEDS-YOU order right after red): the session
  (1) is the requester of an awaiting-approval / queued / running deploy, (2) is a registered waiter (`vpt-lease deploy wait --agent`; the
  registry keeps `waiters.json`, heartbeat on every poll, dropped after 10 min without one), or (3) its latest stop was classified
  `waiting_deploy` (cleared when it works again). A live needs-you prompt always wins visually. The tooltip says which one applies;
  tap -> Platforms at that deploy.

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

### Jev in the product's decision log (TASK-44)

`decisions.js` (server side, no new deps) and `public/jev-view.js` (HTML builders). Server-to-server calls use
`X-API-Key: JEV_API_KEY` and the origin of `JEV_URL`; everything needs `VPT_TEAM_ID`.

- **Logging**: the manager's Jev call sends `log:true`, `team_id`, `refs {source:'ghosty-manager', session, stall_id,
  case}` and a usage key from the `jevUsage` setting (`POST /api/manager {jevUsage}`). Default `auto`: `text.decision.manager`
  once `GET /server/ai/decisions/summary` answers (checked lazily, cached 5 min yes / 1 min no), else `text.decision`;
  an explicit `text.decision[.x]` value pins it. A server that answers "unknown usage" gets one retry under
  `text.decision`. The returned `decision_id` stays in the stall record (`jev.decision_id`).
- **Outcome write-back**: the owner's real reply (kind continue / take_recommended / owner_specific -> continue /
  take_recommended / ask_owner, `by:'owner-reply'`; not when the manager itself sent it) and an owner label (legit ->
  ask_owner, no_reason -> continue, wrong_case + the right case -> that case's meaning, `by:'owner'`) are POSTed to
  `/server/ai/decisions/<id>/outcome` `{team_id, outcome:{label, by, stall_id}}`, fire-and-forget. A refusal or a
  missing endpoint keeps the item in `decision-outcomes.json` (state dir), retried every 5 min, dropped after 7 days
  (newest per decision wins).
- **Jev & AI tab** (usage sheet, third tab; `GET /api/jev-ai`): per day (14 UTC days) calls / failed / cost for the
  manager's Jev and the AI reviewer, from ghosty's own `stalls.jsonl` (works without the server), a red banner with
  the current error when the newest calls fail (e.g. OpenRouter 402), and the product's uses (Sherlock, Test Prompt,
  ...) from the server summary, or "not available until the server is updated".
- **Decisions page** (top-bar menu "Jev decisions", `/?decisions=1`; `GET /api/decisions?usage=&ok=&has_outcome=&min_conf=&limit=&offset=`):
  newest first; time, use, what it was about (session / case for the manager, `<x>_id` refs otherwise), Jev's pick +
  confidence, ms / cost / model, ok or the error, the outcome with a check / cross when it agrees with the pick.
  Filters: use, ok / failed, with / without outcome, minimum confidence (applied by ghosty). Source is the server's log
  (all uses) when it answers, else ghosty's own log (manager only), labelled on the page. Tap a manager row: its
  session card when running, otherwise the stop's text.
- Tests: `test/jev-decisions.test.js`.

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
│   ├── platforms.js                 # lease ownership, lease chip, waiting-for-deploy, Platforms view model (pure, shared)
│   ├── deployed.js                  # "deployed now" view model
│   ├── usage.js                     # usage view helpers: formatting, summary -> session rows (pure, shared)
│   ├── style.css                    # ghosty dark
│   ├── manifest.webmanifest
│   ├── sw.js                        # service worker
│   ├── icon.svg / icon-{192,512}.png
│   └── vendor/                      # xterm.js + xterm-addon-fit (offline)
├── api-extras.js                    # `by` (actor) validation + POST /api/alert handler (rate limit)
├── reporter.js                      # intake of the ghosty-reporter plugin events (token, latest facts per session)
├── claude-plugin/ghosty-reporter/   # the Claude Code plugin (hooks/register.ts, tests)
├── leases.js                        # `vpt-lease list --json` reader (cached, injectable)
├── session-meta.js                  # priority + pause hold (sessions.json)
├── quota.js                         # Codex / Claude / MiniMax quota windows
├── usage/                           # Langfuse usage tailer + prices, eval sync (lfeval), judge, experiment
├── prompts.js                       # Langfuse prompt fetch (10 min cache, hard-coded fallback)
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

No license file yet: all rights reserved by the author until one is added.
## Icons

All UI icons come from one set in `public/icons.js` (24x24 grid, 2px round strokes, `currentColor`). Do not paste emoji, unicode
glyphs (⏸ ⚡ ⚠ ▲ …) or one-off `<svg>` markup: add the icon to `ICONS`, then use `${icon('name', size)}` in JS strings or
`<i data-icon="name" data-size="18"></i>` in `index.html`. The catalogue is listed at the top of `icons.js`.

## Lease binding (TASK-58 C1)

`lease-watch.js` polls `vpt-lease` on proxmox every 30 s: it writes `lease:released|expired|narrowed` to manager-events.jsonl (never pushed),
releases a lease whose `codebox:<session>` holder is gone (seen in tmux before, missing on two polls in a row), and narrows a `kind=server`
lease to `host` when the holder had no finished turn for 30 min (never releases an idle holder). Everything automatic is logged with
`by:"TASK58-C1"` in `lease-actions.jsonl`. `manager.json` `leaseBind`: `"dry"` (log only) or `"off"`; default live. `GET /api/leases/watch` shows
each holder (live / ended / remote / unknown / system) and the planned action. The reporter plugin releases a session's leases on SessionEnd
(not on /clear or resume). Daily report: `lease-stats.js` (deploy request -> start p95, minutes held back by a lease, unknown holders).
