# mycodebox: technical reference

Feature and configuration details for the current implementation. [Documentation index](README.md) · [Repository map](MAP.md) · [Agent contract](CONTRACT.md). For what mycodebox is and a quick start, see the [README](../README.md); to install it with an AI agent, see [INSTALL.md](INSTALL.md).

Quick links: [configuration](#configuration) · [manager](#ai-manager) · [reporter](#session-reporter-task-44-phase-8) · [deploys](#deploy-queue-task-44-phase-7) · [quota](#priority-pause-and-quota) · [usage](#usage-langfuse) · [security](#security)

Mobile-first control room for the Claude Code / Codex / MiniMax coding agents running in tmux on one Linux host.
Streams every `tmux capture-pane` to your phone over Tailscale (1 Hz tick),
lets you send keystrokes back, and shows status pills (idle / working / needs you / done). On top of that it logs and
classifies every stop, tracks token usage and plan quota, coordinates deploys and device leases, and is the
hands of an AI manager that keeps the sessions moving.

> Read-mostly, send-keys-when-needed. The terminal stays alive on your laptop;
> Ghosty is a peer, not a replacement.

## Why Ghosty exists

### The setup

One person runs a dozen or more AI coding agents at the same time on one coding VM,
each in its own tmux session and git worktree: Claude Code, Codex and MiniMax side by side. Most of
those tasks build and test one shared product: a platform of servers, test hosts and real devices
(set-top boxes, phones, emulators). The agents deploy to that platform and run tests on its devices.

That works far better than one agent at a time, and it creates problems a single terminal never had.

### The constraints

| Constraint | What goes wrong without a tool |
|---|---|
| **Attention.** One owner, 15 panes, often away from the desk | Agents stop for small reasons: "continue?", a menu with an obvious choice, "waiting for the deploy", "should I deploy?", or a plain "next I'll do X" and then nothing. Nobody sees it, and work sits still for hours. |
| **Tokens and money.** Multiple agent subscriptions with different usage windows and limits | No single view of how much each session burns. One runaway session can eat the week's Claude window and block the urgent work. The same job can cost ten times more on one agent or model than on another. |
| **Visibility.** Who did what, what is deployed, where each task stands | Answers live in 15 scrollbacks. "Was my fix deployed? Which version? Who restarted the server?" has no answer. |
| **Shared platform.** One test platform, exclusive devices | A deploy restarts services under another agent's test run. Two agents drive the same set-top box. An agent waits for a deploy nobody runs, or deploys over someone else's run. |
| **Phone only.** The owner is often away | Decisions must be one tap from the phone, with no extra app. |
| **Safety.** Agents act fast | Nothing may answer a question about a deploy, a delete, credentials, money or a customer on the owner's behalf. A merge is answered only after an evaluation (clean merge, green tests, no sensitive files, Jev or the manager's reasoning) that is journaled and shown to the owner. Every automatic action must be visible, logged and switchable off. |

### How Ghosty answers them

| Constraint | Ghosty |
|---|---|
| Attention | Live cards for every session with a state (working / waiting / done / idle). Every stop is logged and classified (`stall.js`: continue, recommended menu option, permission, owner decision, done, error, stopped short, waiting for a deploy, owner action). A swipe page lets the owner label stops good or bad, which measures the classifier. Safe stops can be answered automatically after a cancellable countdown; everything else goes to the owner with Jev's call and an AI reviewer's proposed reply. |
| Tokens and money | Usage tailers read every agent's transcripts into a ledger and a local Langfuse: tokens and API-equivalent cost per session, project, agent, model and day, with outliers flagged. Live plan quota: Claude from its status line, Codex from `codex app-server`, MiniMax from its plan endpoint. Priority P0 / P1 / P2 per session, and a policy that holds low-priority sessions before a plan runs out. |
| Visibility | One dashboard: sessions, usage, quota, OpenRouter credit, Jev's decisions, deploys, leases, host health. A reporter plugin inside each Claude session reports exact events (turn end, prompt, permission, subagents) instead of guessing from the screen. Every send is recorded with who sent it (`by`). |
| Shared platform | Deploy queue in the shared lease registry (`vpt-lease`): agents request a deploy and wait; ghosty's runner deploys when no lease blocks it and records every deploy in a ledger (what, which version, when, by whom). Leases show on the session cards and on a Platforms page, and a session waiting for a deploy gets its own badge. |
| Phone only | Installable PWA / Android TWA over Tailscale; Web Push for "needs you" alerts. |
| Safety | A forbidden-topic filter that always wins; automatic answers off until measured; per-session and global switches; non-owner senders can only type into a pane that really runs an agent; the owner's Pause sends Esc and holds. |

### The manager: one to run them all

Ghosty is the eyes and hands. The **manager** is the judgement on top, in layers, each cheaper than the next
one up and each passing only what it cannot settle:

```
 owner (phone)            decisions only: product calls, deploys, anything risky (merges: evaluated, vetoable)
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
- **Sees every blocked session** (owner, 2026-10-22: a session that looked idle was blocked on a `needs-manager` the manager had missed).
  On every wake it reads ALL events of the `manager-wait.sh` output with `scripts/manager-wake-summary.sh <output-file>` (one line per
  event: time, kind, session, title, Jev pick; needs-manager / asks / hold lines start with `!!`; never truncated), and every hourly sweep
  runs `scripts/manager-status-scan.sh [--json]` (read-only; per tmux session the last `STATUS:` line when it says needs-manager,
  needs-owner, blocked or ready-for-gate; exit 0 always). A session whose last STATUS is one of those is never "idle". The same sentence
  is in the `manager-fresh.sh` kick text. Tests: `test/manager-visibility.test.js`.

Its limits are fixed: it acts only through actions the owner could take from this dashboard, every action is
logged with `by`, every capability has a switch, and it never answers anything touching deploys, deletes,
credentials, money or customers. Merges are its call after an evaluation (see "Merge decisions" below).

Historical goals and a platform-specific operating manual were tracked externally in:
TASK-44 (`docs/tasks/TASK-44-ai-manager.md` and `TASK-44-MANAGER.md` in the platform repo). Those documents are not included here and are not prerequisites for a core install.
Use source defaults and the current installation's saved settings to determine which features are active.

## Access

Follow [INSTALL](INSTALL.md) for Tailscale setup, access policy, HTTPS and service operation.
The recommended mode is private Tailscale Serve forwarding to `HOST=127.0.0.1` on port 7777.
Direct access binds to a literal Tailscale IP and optionally serves native TLS on 7443.
The source default `127.0.0.1` listens on loopback; explicit listener overrides must preserve private access.
PWA, push and microphone features need trusted HTTPS; clicking through a self-signed warning is not a reliable substitute.

## Run the service

Use [INSTALL](INSTALL.md#persistent-service-configuration), including the explicit launch-command overrides.
The checked-in systemd units have deployment-specific paths and settings. Copy and adapt them; do not symlink them unedited.
See [updates](INSTALL.md#update-and-uninstall) before restarting.

## Configuration

Environment variables (source defaults below). Node does not automatically load `.env`; the adapted systemd unit
loads its configured `EnvironmentFile`. Use absolute paths and protect private files with mode 0600. Environment
files can override unit `Environment=` values. Saved manager settings in the state directory persist across restarts.
For safe initial values, follow [INSTALL](INSTALL.md).

```ini
# ~/ghosty-sessions/.env  (chmod 600, never committed)
NTFY_TOPIC=<long-random-private-topic>      # subscribe to the same topic in the ntfy phone app
PUBLIC_URL=https://<machine>.<tailnet>.ts.net     # notification tap opens /?s=<session>
```

| var | default | meaning |
|---|---|---|
| `PORT`        | `7777` | listen port |
| `HOST`        | `127.0.0.1` | listen address; explicitly use `127.0.0.1` behind private Serve, or a literal Tailscale IP; not an interface name |
| `TICK_MS`     | `1000`  | pane capture cadence |
| `PANE_LINES`  | `1000`  | scrollback lines captured for a session with an open card (a WebSocket viewer); the unit sets 2000 |
| `PANE_LINES_BG` | `300` | scrollback lines for every other session (state, reply and manager only need the tail) |
| `NTFY_TOPIC`  | unset   | enable optional ntfy push (Web Push is always on): a session starts waiting (high), a disk reaches the critical level (urgent, repeated every 6 h). Keep it secret — anyone with the topic name can read it |
| `NTFY_DONE`   | unset   | `1` also pushes when an agent finishes a turn |
| `NTFY_URL`    | `https://ntfy.sh` | ntfy server base URL |
| `PUBLIC_URL`  | unset   | base URL of this app; used as the notification click link (`/?s=<session>`). An https value is also named in the UI's "needs the HTTPS address" hints |
| `LANGFUSE_PUBLIC_URL` | unset | browser-reachable Langfuse URL for the usage sheet's Langfuse button and the manager panel links. The usage button falls back to `LANGFUSE_URL` only when that is not a loopback address; with neither, the button is hidden. The manager panel falls back to `LANGFUSE_URL` as is |
| `ANDROID_APP_PACKAGE` / `ANDROID_APP_SHA256` | unset | serve `/.well-known/assetlinks.json` for the Android app: package name and signing-cert SHA-256 fingerprint(s) (`XX:..` 32 hex pairs, comma-separated). Both or neither; invalid values log a startup warning and nothing is served. Alternative: put a ready file at `$GHOSTY_STATE_DIR/assetlinks.json`. Read at startup; restart to apply. Unconfigured: 404 |
| `HEALTH_MS`   | `5000`  | host health sample cadence (CPU, load, RAM, disk) |
| `HEALTH_DISKS`| `/`     | comma-separated mount points shown in the health strip |
| `HEALTH_WARN_PCT` / `HEALTH_CRIT_PCT` | `85` / `95` | amber / red thresholds for CPU, RAM and disk; disk at critical pushes to ntfy. Load is amber at 1x cores, red at 2x |
| `GHOSTY_DISK_GUARD` / `GHOSTY_DISK_HOLD_PCT` / `GHOSTY_DISK_WARN_PCT` / `GHOSTY_DISK_OVERRIDE` / `GHOSTY_DISK_PATHS` | on / `90` / `85` / off / the state dir and the V2 work root | the disk-space safety policy: from 85 % a banner shows, at 90 % new work is refused with the reason code `disk_low`. See [Disk-space safety policy](#disk-space-safety-policy) |
| `JEV_URL` / `JEV_API_KEY` | unset | AI manager: the VPT server's `POST /server/ai/decide` and its `API_KEY` (Jev for ambiguous stalls). Unset = rules only |
| `VPT_TEAM_ID` | unset | team of the VPT server's decision log (`<team-uuid>`, shown by the server's `/server/health`). With it the manager's Jev calls are written to the product's decision log (`log:true`, `team_id`, `refs`), outcomes are written back, and the Jev & AI tab / decisions page can read the server. Unset = Jev calls are not logged, those pages use ghosty's own log |
| `JEV_DAILY_USD` / `JEV_DAILY_CALLS` | `0.25` / `2000` | Jev budget per UTC day; over it, ambiguous stalls stay with the owner |
| `STALL_SETTLE_MS` | `5000` | a stopped pane must stay unchanged this long before it counts as a stall |
| `GHOSTY_STATE_DIR` | `~/.local/state/ghosty` | manager config, `stalls.jsonl` log, Jev budget |
| `GHOSTY_FORBIDDEN_EXTRA` | unset | extra regex of never-auto-answer words (customer names etc. — keep them out of the public repo) |
| `DONE_IDLE_HOURS` | `6` | a finished agent session turns `done` -> `idle` after this long |
| `AGENT_CMD_CLAUDE` / `_CODEX` / `_MINIMAX` / `_BASH` | `claude --dangerously-skip-permissions` / `codex --dangerously-bypass-approvals-and-sandbox` / `PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode` / (none) | create/resume launch commands (owner's default 2026-10-11: prompts skipped, folder trust pre-accepted via `trust.js`); Claude also configures manager-fresh; an override wins verbatim, even empty. Only a non-loopback `HOST` warns |
| `MANAGER_MODEL` | `sonnet` | Model of the Claude manager (`managerCommand` in `launch-config.js`, used by `manager-fresh.sh` and `manager-watch.sh`); owner decision 2026-10-21: Sonnet, not Opus. A model alias or id; anything else falls back to `sonnet`. |
| `TLS_KEY` / `TLS_CERT` | `certs/key.pem` / `certs/cert.pem` under checkout | native TLS starts only when both exist; same HOST as HTTP |
| `TLS_PORT` | `7443` (`443` if PORT=443) | native HTTPS port; HTTP remains enabled |
| `TMUX_BIN` | `tmux` | tmux executable |
| `GHOSTY_V2` | unset | `1` enables the V2 engine (`orchestration/v2-runtime.js`): routes `/api/v2/*`, store in `$GHOSTY_STATE_DIR/v2`, and the goal loop under the controller lease. Unset: those routes return 404 and nothing is imported or constructed |
| `GHOSTY_V2_WORK_ROOT` | unset | V2 only, required for the loop: absolute directory for task worktrees, reviewer checkouts and check temp files. Created if missing; must not overlap the checkout or the state dir. Unset or invalid: no loop, V2 routes read-only (writes 503 `E_NO_CONTROLLER`) |
| `GHOSTY_V2_REPOS` | unset | V2 only: `:`-separated absolute paths of the git repositories tasks may run in (D-021). Each needs a valid `.ai/project.json`, whose allowlists govern its tasks; any other repository is refused at creation (400 `E_INTAKE_REPO`). A listed repository whose policy is missing or invalid stays listed (logged at start): its tasks are created but never run; they stop at an owner clarification (T01) until the policy is fixed |
| `GHOSTY_V2_CONCURRENCY` | `1` | V2 only: tasks stepped at the same time (1-8) |
| `GHOSTY_V2_PATH_DIRS` | unset | V2 only: `:`-separated absolute directories put first on PATH for the runtime CLIs (e.g. where `opencode` lives). MiniMax also honours `MCODE_NODE_DIR` |
| `GHOSTY_V2_CLAUDE_RUN_USD` | `1` | V2 only: `--max-budget-usd` of one Claude run, lowered to the task's remaining `max_usd` cap |
| `GHOSTY_V2_RUN_TIMEOUT_MS` | goal loop default (30 min) | V2 only: wall clock of one agent run, integer ms; the HTTP benchmark driver sets it so stalled agents fit the no-progress rule |
| `GHOSTY_V2_PUSH_REMOTE` | unset | V2 only: remote name (e.g. `origin`) the integration hook may push the task's own `v2/task/<id>` branch to; unset = no push (recorded in the decision, not an error). Nothing else is ever pushed |
| `GHOSTY_V2_REGISTRY` | `orchestration/models.json` | V2 only: absolute path of another model registry file |
| `GHOSTY_V2_TEST_FAKE_ADAPTER` | unset | TEST ONLY (`test/v2-server-wiring.test.js`): a JSON file of fake-adapter scripts; the scripted fake becomes the only runtime. Never set it on a live install |

### Langfuse evaluation (TASK-44 phase 12)

The manager can send labels to a configured Langfuse instance. The integration notes below include historical
Langfuse 3.x observations; validate compatibility against your installed version before enabling evaluation.

- **Scores** (`usage/lfeval.js`, run by the tailer after each pass; own state file `lfeval-state.json`, replay-safe):
  `stop_verdict` (categorical legit / no_reason), `stop_case_correct` (boolean), `ai_proposal_correct` (boolean, the
  owner's right / wrong on the AI's proposal), `jev_agreed` (boolean, the owner's reply vs Jev's pick). They sit on the
  stop's `manager.jev` / `manager.ai-review` generation(s); a stop with neither gets a `manager.stop` span (case, source,
  agent, session; no text). Ids are deterministic, so a label change upserts, an unlabel deletes the label scores. The
  pass is skipped unless `stalls.jsonl` gained a label / unlabel / outcome / triage line. `LFEVAL=0` turns it off.
  CLI: `node usage/lfeval.js [--stalls f] [--state f] [--force]` (one pass; reads the log, never writes it).
- **Dataset `ghosty-stops`**: one item per labelled stop (item id = stop id). input `{closing_text, case_by_rules, agent,
  state}`, expected output `{verdict, correct_case?, owner_reply_kind?}`, metadata `{session, stop_id, at}`. The closing
  text is in it: ensure the configured Langfuse endpoint is approved to receive session text; never export the dataset into the repo or a fixture. Unlabel archives the item.
- **Experiments**: `node scripts/stops-experiment.js --run-name <name> [--classifier rules|jev|ai]` runs the classifier
  over the active items and records a dataset run (a trace per item, scores `case_match` / `verdict_match`, run scores
  `case_accuracy` / `verdict_accuracy`). `rules` is free; `jev` / `ai` call the real endpoints (needs `JEV_URL`, `JEV_API_KEY`).
  Compare runs in Langfuse: Datasets -> ghosty-stops -> Runs.
- **Prompt management**: the reviewer's system prompt is the Langfuse text prompt `ghosty-ai-reviewer` (label `production`),
  fetched with a 10-minute cache (`prompts.js`); the hard-coded `REVIEWER_SYSTEM` is the fallback (Langfuse unset, down, or
  no such prompt). The triage record and the generation carry the prompt name + version. ghosty needs `LANGFUSE_URL`,
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` in its own environment (the usage unit already has them; add
  `EnvironmentFile=-/home/<user>/.config/ghosty/usage.env` to `ghosty-sessions.service`) - until then the fallback is used.
  Edit the prompt in Langfuse (new version, move the `production` label) to change the reviewer without a deploy.
- **Judge** (`ai_proposal_judge`, 0..1 + reasoning): `scripts/lf-setup.js` creates the OpenRouter LLM connection, the
  evaluator and its rule in Langfuse, but the historical v3.225 deployment did not run those observation-level rules.
  Do not assume this limitation applies to every current version. The alternative judge runs in the tailer (`usage/judge.js`): opt-in `LFEVAL_JUDGE=1` + `JEV_URL` + `JEV_API_KEY` in the usage
  unit's environment (the judge goes through the VPT server's `POST <JEV_URL origin>/server/ai/complete` with `X-API-Key`,
  same as the AI reviewer in `triage.js` — no OpenRouter key is needed in the ghosty env); at most `LFEVAL_JUDGE_MAX_PER_DAY`
  (400) proposals, sampling `LFEVAL_JUDGE_SAMPLING` (1), only proposals of the last 24 h, each once. It sends the case, flags
  and the reviewer's proposal + reasoning (not the closing text). Cost is estimated from the token counts the server returns
  (`AI_USD_PER_MTOK_IN/OUT`, default 3 / 15), same as the reviewer, via `triage.js` `costOf` (no fixed per-call number); the judge's own cap is 400
  calls/day, and failed calls count against it. `LFEVAL_SEND_AI_OUTPUT=1` additionally puts the proposal on the generation (for a
  future v4 evaluator).
- **Panel**: manager panel -> "Langfuse" links (scores, dataset, evaluator, prompt) from `LANGFUSE_PUBLIC_URL` (else
  `LANGFUSE_URL`) and `LANGFUSE_PROJECT` (default `codebox-usage`).


## Disk-space safety policy

`disk-guard.js` turns a full disk from a report into a rule. Before, the dashboard only *showed* that the disk was
getting full (the health strip and the ntfy push). Now the product refuses **new work** with a reason code, the way
Cloudroom does, and the owner sees a persistent banner while it applies.

**The rule**

| state | when | what happens |
|---|---|---|
| ok | below 85 % used | nothing |
| warn | 85 % or more used | a persistent banner shows with the reason code `disk_low`; new work still starts |
| hold | 90 % or more used | the banner shows (red) **and** new work is refused with HTTP 409 and the reason code `disk_low` |

**What the hold refuses** (the only things):

- `POST /api/sessions` — starting a new dashboard session;
- `POST /api/sessions/:name/resume` — resuming a parked session (it starts an agent and writes more to the disk);
- `POST /api/v2/tasks` — creating a new V2 task;
- a new V2 task worktree: the goal loop waits with the reason `disk_low` instead of creating one.

**What the hold never blocks**: sessions that are already running, sends, deploys, the integration lane, the AI
manager, parking a session (that frees space) and every read-only endpoint. An unreadable volume produces no reading
and no decision: a failed reading never stops work.

**The switch** — the policy is ON by default. The owner's setting in `$GHOSTY_STATE_DIR/manager.json` wins over the
environment, and both are read fresh, so a change applies without a restart:

```json
{ "diskGuard": { "enabled": true, "holdPct": 90, "warnPct": 85, "override": false, "paths": ["/"] } }
```

| key / var | default | meaning |
|---|---|---|
| `diskGuard.enabled` / `GHOSTY_DISK_GUARD` | on | the whole policy: banner and refusal. `false` / `0` turns it off |
| `diskGuard.holdPct` / `GHOSTY_DISK_HOLD_PCT` | `90` | used % at which new work is refused. `0` refuses always |
| `diskGuard.warnPct` / `GHOSTY_DISK_WARN_PCT` | `85` | used % at which the banner shows |
| `diskGuard.override` / `GHOSTY_DISK_OVERRIDE` | off | the owner's explicit override: the hold is lifted, the banner stays (the disk is still low) |
| `diskGuard.paths` / `GHOSTY_DISK_PATHS` | the state dir and the V2 work root | the volumes to watch; the same volume twice is watched once |

**The volumes**: the state dir (`$GHOSTY_STATE_DIR`) and the V2 work root (`GHOSTY_V2_WORK_ROOT`) when it is set.
**The top consumers**: the banner's detail (`GET /api/disk`) lists the biggest folders of the state dir, the V2 work
root and the git worktrees (`du`, read-only, cached for 5 minutes). Nothing is ever deleted by the policy.

**The owner-visible text** (plain words, no jargon):

> The disk is 91% full on / (2.0 GB free). Starting a new session is paused until it drops below 90%. Sessions that
> are already running are not affected — free some space and try again.

The 409 body carries `{"ok": false, "error": "<that text>", "reason": "disk_low"}`. The dashboard banner shows the
same thing in one line; tapping it opens the detail with the volumes and the biggest folders.

`GET /api/disk` returns the whole reading: `{ok, reason, level, hold, blocked, enabled, override, holdPct, warnPct,
disks[], worst, top[]}`. The reading is also pushed on `/ws/status` as `{type:'disk', disk}` every health tick.


## Voice mode (hands-free)

`voice.js` serves `GET /api/voice/queue`, `POST /api/voice/answer` and `GET /api/voice/digest`; see [VOICE.md](VOICE.md) for the flow, the
spoken-answer rules and the limits. A voice answer is sent through the guarded send as actor `owner-voice` (an agent pane is required, like the
manager's own sends), after re-reading the open item; a sensitive option needs a spoken or tapped confirm and is never answered from a notification.
Push feed items for a needs-you stop carry optional `voiceId` and `actions` (`[{action:'recommended'|'wait', title}]`, only for a recommended option
that is not forbidden). The page loads `public/voice-view.js` on demand (More menu or `/?voice=1`). The digest consumes `GET /api/manager/decided`
when this server has it and otherwise counts the manager's `answer` records itself.

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
- **Two tiers.** `push.js` `createAlerts()` splits alerts: an *interrupt* is pushed at once, everything else is
  collected and sent as **one digest push** per `pushDigestMinutes` while the owner is awake (nothing in quiet hours).
  `manager.json` `pushDigestMinutes` (30), `pushAwakeFrom` ("07:00"), `pushAwakeTo` ("23:00"), `pushTimezone`
  ("Europe/Zurich"), `pushInterruptPct` (95). Interrupts: a disk at the limit, a failed/orphaned/approval deploy,
  a quota above the percentage, an urgent alert, and **an owner question** (`ask-Q<n>`: it is always pushed on its
  own, with its tag, never inside a digest). A digest is one feed entry with the tag `ghosty-digest`.
- **The feed is a 50-item ring**, so a routine notice that takes a slot evicts an older alert. Routine integration
  notices therefore do not go into it (see the integration lane below); only the alert the owner must act on does.
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
the UI means). The manager agent passes `by: "manager-agent"`. It is logged in `stalls.jsonl` (`{type:'send'|
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

**Owner questions** (`scripts/manager-ask.js`, `ask-guard.js`, owner 2026-10-23). A question the owner must answer is filed in
`<state>/manager-owner-asks.jsonl` (`Q<n>`), pushed to the owner with the tag `ask-<n>` and written to the shared alert record
`<state>/manager-ask-alerts.jsonl` (`{id, at, via}`; `via` is `manager-ask`, `autoregistered` or `late`). The record is the
**one** truth about "this question was alerted": the ask-guard reads it before every sweep (it only grows), so a question is never
alerted twice, and `scripts/manager-ask-scan.sh` reports `!! ask-not-alerted <id>` only when neither the record nor the push feed
(tag `ask-<id>`) holds an alert. The scan used to read the push feed alone, which is a 50-item ring: a real alert scrolled out of it
and the scan printed a false alarm (2026-10-23). An owner question is an **interrupt** alert: it is pushed on its own, with its tag,
never inside a digest and never evicted by a routine notice.

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

**Manager failover (standby `mm-manager`).** `scripts/orchestrator-failover` (name kept) runs as `systemd/ghosty-manager-failover.service`
(`Type=simple`, `Restart=on-failure`). The repo does not track the unit file because the integration lane refuses unit paths; create
`/etc/systemd/system/ghosty-manager-failover.service` from the snippet below (replace `<user>`), then `sudo systemctl daemon-reload` and
`sudo systemctl enable --now ghosty-manager-failover`. Every 300 s it reads `$GHOSTY_STATE_DIR/claude-rate-limits.json`: at >= 97 % (5 h or
weekly) or a usage-limit message in the `manager` pane it starts or wakes `mm-manager` with a standby message (act as manager per
TASK-44, same hard floors, never type into a working session, no Esc/Ctrl-C) and sets `~/handovers/notes/.failover-state` to
`minimax`; under 90 % it asks `mm-manager` for a handback note and tells `manager` to read it (state `claude`). A missing or stale
(> 30 min) quota file is unknown: no action. The standby is promoted only when its **own** windows still have headroom: before
handing over it reads `$GHOSTY_STATE_DIR/minimax-rate-limits.json`, which `quota.js` mirrors from each fresh MiniMax reading (the live
reading is otherwise memory-only), and it stays at Claude if that file is unknown (missing, broken, stale) or at >= 97 % on the 5 h or
weekly window — a Claude-limited system with no seat left is an operator problem, so both cases are written to the log. A `minimax` state older than 12 h is a leftover and is reset to `claude` silently (no handback; if Claude is still limited the next pass takes over). `--once` runs one
pass; `--dry` (implies `--once`) prints what it would do and touches no tmux session, state or log. Overrides: `POLL`, `LIMIT_PCT`,
`BACK_PCT`, `FAILOVER_RL`, `FAILOVER_STANDBY_RL`, `FAILOVER_STATE`, `FAILOVER_LOG`, `FAILOVER_MANAGER`, `FAILOVER_STANDBY`. Test: `test/manager-failover.test.js`.

**Standby visibility.** `manager.json` `standbyManagerSessions` (default `["mm-manager"]`) names the standby manager sessions. While the failover state is `claude` (a missing or unreadable state file counts as `claude`; read at most every 5 s, `FAILOVER_STATE` overrides the path) such a session is `hidden` in the status: not in the NEEDS YOU strip, the ask popup, the needs-you push, the decision count or the voice list. Its stops are still logged to `stalls.jsonl` and the scorecard. While the state is `minimax` it is a normal manager session (`managerSession`, so only owner questions and forbidden topics show). Code: `standby-manager.js`. Tests: `test/standby-manager.test.js`, `test/ask-popup.test.js`.

```ini
[Unit]
Description=Ghosty: wake the MiniMax standby manager when the Claude manager runs out of quota, hand back when it is back
After=ghosty-sessions.service

[Service]
Type=simple
User=<user>
Environment=HOME=/home/<user>
ExecStart=/home/<user>/ghosty-sessions/scripts/orchestrator-failover
Restart=on-failure
RestartSec=30
Nice=10
```

**Health watchdog (zero tokens unless a problem remains).** `scripts/health-watch.js` (no deps, no AI calls) runs every
5 minutes from `systemd/ghosty-health-watch.timer` (`.service`: oneshot, `User=<service-user>`; install with `sudo cp` to
`/etc/systemd/system`, `daemon-reload`, `enable --now ghosty-health-watch.timer`). It checks disk % of `/`, load vs
cores (sustained: the last samples in `~/.local/state/ghosty/health-watch-state.json`), RAM available %, runaway
processes (yours, older than `runawayHours`, and RSS over `runawayRssMB` or CPU over `runawayCpu` % across two
samples 5 s apart; claude, tmux and the ghosty server are never runaways) and stuck patterns (a bare `node --test`,
too many defunct processes) and orphaned test runs: a process whose parent is gone, older than `testLeftoverMin` (60), whose
own or any descendant's args are a test run (`node --test`, `test/*.test.js`, vitest, tinypool, the `/tmp/*fresh-*/bin` fakes).
Those are killed with their whole subtree at every fix level except `report` (2026-10-15: 26 sat for up to 3.8 days). Healthy = exit 0, only the state file is touched. When a check trips it writes a markdown
report to `~/.local/state/ghosty/health-reports/<ISO>.md` (kept 7 days): top 15 processes by CPU and RSS with their
owning tmux / Claude session, disk use of `/tmp`, `~/.cache`, `~/.claude`, `~/.npm`, the journal, docker (if usable),
and every `~/vpt-*` / `~/ghosty-*` dir with its worktree / clean / merged / live-session status. Thresholds live in
`~/.local/state/ghosty/health-watch.json` (created with defaults: `diskPct` 85, `loadPerCore` 1.0 for `loadMinutes` 10,
`ramAvailPct` 10, `runawayHours` 2, `runawayRssMB` 1024, `runawayCpu` 80, `fixLevel`, `inodePct` 85, `fixLevel`).
Every tick (also healthy ones) it first removes stale test leftovers: directories directly in `os.tmpdir()` owned by the service uid, named with one of `TMP_PREFIXES` (every test/script `mkdtemp` prefix; `test/health-watch.test.js` fails when a new one is missing), `lstat`-checked (symlinks never followed) and with mtime older than 2 h, at most 2000 per tick and 20 s (the backlog goes on next tick); it never throws and logs one line with the count when it removed something. Next to the disk check it reads inode use of `/` (`statfs` files/ffree) and trips an `inode` issue at `inodePct` (85 %) with the same report / debounce / manager-wake path (2026-10-20: 186k leaked tmp dirs exhausted the inodes).

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

**Harness health check (`scripts/harness-health-check.js`, owner asked 2026-10-21).** The owner only sees a harness
regression when he asks for it, so this daily check measures the harness itself over the last 24 h and writes the numbers
as ONE line (`{date, ...}`) to `<stateDir>/harness-health.jsonl`, then compares with the previous line. It reads local state
only, read-only, except that appended line: new owner asks and how many were answered (`manager-owner-asks.jsonl`: a line
with a `question` in the window is an ask, a later line of the same id closes it), decisions taken for the owner
(`manager-decisions.jsonl`), the lane (`integration/requests.jsonl`: the last record per id, counted by final state, plus
`approvalRefused`), CI (`ci-watch.jsonl`: red minutes from a red record to the next green, clipped to the window, so a
streak opened before it is not a day-long outage), the box (`/proc/loadavg`, `MemAvailable` from `/proc/meminfo`, `/`
disk use as `df` computes it: used / (used + available)) and live sessions (`GET /api/sessions`, best effort: any fetch
error leaves `sessions: null`, never a fabricated 0). A missing or malformed source counts as 0 and is listed in the
report as "not found" — a silent zero would read as a healthy day. Findings are only real regressions: owner asks > 3,
lane returned > 5, CI red > 120 min, disk > 90 %, MemAvailable < 2 GB, any `approvalRefused`. `summary` is one plain line,
`report` a markdown table today vs previous. The pure parts (`askStats`, `laneStats`, `ciStats`, `summarize`, `prevLine`)
are tested in `test/harness-health-check.test.js` with fixture files in a temp state dir and an injected sessions fetch.
It is registered by the manager in the private `daily-checks.json` (id `harness-health`) after review; this repo never
edits that file.

Fix levels (`fixLevel`, only acted on when the disk check trips): `report` = no fixes; `cleanup` (default) = delete
`/tmp/claude-1000/<project>/<session-id>/` scratch dirs whose session is not live and older than 2 days, `journalctl
--user --vacuum-time=7d` (skipped without rights), `npm cache clean --force` when `~/.npm` > 1 GB; `cleanup+orphans`
(OFF by default) also SIGTERMs runaway / bare `node --test` processes that belong to no live tmux or Claude session;
`cleanup+worktrees` also runs `git worktree remove` (never forced) on worktrees that are clean, merged
into `main` and have no live session (no orphan kills); `cleanup+all` = both. These are destructive optional modes;
configure only within the owner's authorization. Historical deployment choices are not default permissions. Never touched: anything under a live session, any other worktree, anything
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
go with your recommendation." after a finished turn). A forbidden topic (deploy, push to
main, delete/remove, migration, `.env`, credentials, money, customer) or an unsent draft in the
input box always means "ask the owner", whatever Jev says. A merge goes through the merge evaluation
below instead. The manager never starts, kills or
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

The robot icon in the top bar opens the manager panel. Its first view shows whether automatic replies,
AI replies and deploys can actually run, plus stops awaiting review and today's outcomes. Expand the
sections to choose routine reply types, AI reply types, deploy behavior, quota policy or sessions; activity
and Langfuse details are further down. Selecting AI **Auto** alone does not send replies: the reviewer
must be configured, automatic replies must be on, and at least one AI reply type must be enabled.

**Policy by priority and quota** (`public/policy.js`, pure and unit-tested). At a stall the manager
would auto-answer (all safety gates above already passed), the policy decides `allow` or `hold`:

- **P0**: always allowed. The safety gates (forbidden topic, draft, confidence, cap) still apply.
- **P1**: allowed while its agent's 5 h window is under `p1MaxPct`.
- **P2**: held when the 5 h window is at or over `p2MaxPct`, or when the weekly window is projected to run out
  before its reset (used % / elapsed fraction of the week > 100 %, only once 10 % of the week has elapsed).
- Unknown quota (stale, expired window, no data, `usedPercent` null) is allowed with reason "quota unknown".
- Plans: claude -> Claude Max, codex -> Codex, minimax -> MiniMax.

A hold is stored in `sessions.json` as `held:{by:'manager',reason,at}`, separate from the owner's `paused`,

### Merge decisions and mixed questions (owner, 2026-10-14)

"If there is no reason not to merge, you should." A merge is no longer a hard forbidden topic: `stall.js` splits the
floor (`topicSplit(text)` -> `{ merge, hard }`). `forbiddenMatch` / `FORBIDDEN_RE` still match a merge, so every path
other than the merge evaluation stays fail-closed. A plain push to main/master (or with no explicit refspec) counts as the landing of a merge only when
the same text asks for a merge; force-push, `--force` / `-f`, `+refspec`, delete pushes, tag pushes, pushes to prod / staging / live, history rewrites, hard reset and rebase onto main stay hard. A push decision (round 8) only pushes a branch to its own `origin/<branch>`; main moves only through a decided merge.

For a stop that asks about a merge, the manager runs `evaluateMerge` (`merge-policy.js`) in the session's checkout,
without fetch, checkout or any ref, index or work-tree change (`git merge-tree --write-tree` writes loose objects only; async git with timeouts). It answers "merge" only when all hold:

| Check | Escalation reason when it fails |
|---|---|
| The branch exists and is not already merged | `branch not found` / `already merged` |
| `git merge-tree` is clean, or conflicts only in `mergeConventionFiles` (default `VERSION.txt`, max+1 by convention) | `conflicts outside convention: <files>` |
| The closing text reports tests green ("1826/1826 pass", "all green"), with no failure; or every changed file is documentation (`.md`, LICENSE / CHANGELOG-style files, non-code files under `docs/`; test code and generic `.txt` need a green report) | `tests reported red: ...` / `no green test report on the branch` |
| No changed path or added line touches secrets or credentials, migrations / `*.sql`, sudoers, systemd units, CI / deploy / infra files (workflows, Dockerfile, `*.tf`, deploy scripts), no new binary file, and the diff could be scanned (`diff too large or unreadable to scan` otherwise). A secret **path** is an artefact that stores one: `.env*` (except `.example` / `.sample` / `.template`), `.netrc`, `.npmrc`, `.pypirc`, `authorized_keys`, `id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`, `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks`, and a non-source data file under a `secret` / `credential` / `password` name (`secrets.json`, `credentials.yaml`). **Source files are not judged by name**: `apps/web/src/app/set-password/actions.ts`, `components/auth/PasswordField.tsx` and `lib/password.ts` are ordinary auth code, so a literal secret in them is caught by the added-line scan (`SENSITIVE_CONTENT`, `secret-content`) instead | `touches a secret/credential path: ...`, ... |
| The repo is not in `mergeOptOut` (matched against the checkout directory name, the main repo directory behind a worktree and the origin remote's repo name, or the full path) | `repo opted out` |
| Jev (router point `merge`) picks `merge` at or above `mergeMinConfidence` (default 0.85); without Jev, the manager's reasoning (a deliberate constant, not a measurement; "Jev unavailable"): 0.9 with a test count or docs-only, 0.8 for a green word alone, so with Jev down every floor-passing merge with a test count is approved until the minimum is raised | `Jev rates it escalate (0.62)` / `confidence 0.80 below 0.85` |

Every evaluation, merge or escalate, is appended to `<state>/merge-decisions.jsonl` (V2 decision-record shape: rationale,
evidence, `jev_decision_id` or `reasoning`, branch and target SHAs, rollback `git revert -m 1 <merge commit>`), logged as
`{type:'merge_decision'}` in `stalls.jsonl`, and recorded as an owner feed notice ("Merge approved (reply pending): <session>" or "Merge
escalated: <session>"; the later `answer` / `answer_cancelled` record carries `merge_decision_id`). `GET /api/manager/merge-decisions?limit=50` returns the newest records.

The reply ("Merge: yes - the manager evaluated <branch> -> <target>: ... Request it with `integrate request <branch>` ... Do not merge it yourself.") never tells the session to merge or push the target (the lane is the only merger, AGENTS.md); it goes through the usual countdown
and cancel pill with source `manager_decision`; it needs `autoSend` and `mergeDecisions` on (not `autoCases`), and the fire-time
gate re-checks draft, pause, hourly cap, pane and that the reply itself names no hard topic.

**Mixed questions.** Only a finished turn without menu options is handled this way; a live menu (the keys would select the highlighted option) goes to the owner. `info-lookup.js` splits a stop into parts. An information part ("send the path of X") is looked up in the
session's repository docs and the `infoRoots` directories (handovers, task docs, state files); a single, unambiguous hit is
answered with its source. A question mixing merge and deploy is split: the merge is decided, the deploy escalated. What
remains goes to the owner with a reason that says what was already answered ("deploy question - needs you (merge answered
by the manager; path answered)").

Config (`POST /api/manager`): `mergeDecisions` (default true), `mergeMinConfidence` (0.85), `mergeOptOut` (repo names - checkout, main repo or origin remote name - or
paths), `mergeConventionFiles` (`["VERSION.txt"]`), `infoAnswers` (true), `infoRoots` (absolute paths), `leaseAnswers` (true: a stop that asks about a lease is answered from the lease source with the fixed template, never escalated as a lease question; only a pure lease part is answered, a deploy, restart or hard topic anywhere in the stop still goes to the owner or the deploy decision).

The interactive manager uses the same evaluation from its shell:
`node scripts/merge-eval.js --repo <checkout> --branch <b> [--target main] --text "<closing text>" --session <s> --journal`
prints one JSON line `{verdict, reasons, rationale, ...}`.

### Autonomy by default: push, deploy and recommended options (owner, 2026-10-14)

OWNER_DECISIONS §15 ("yes merge, yes push, yes deploy, yes do the recommended one ... the correction can come at the
end"). `topicSplit(text)` returns `{ merge, push, deploy, hard }`. A push or deploy counts only when the session asks to do
it ("should I deploy ...", "push the branch?"), not when it names a feature ("the deploy queue page"). The hard floor:
deletions of data (every verb form: deletes, deleted, removal, drops, wiped, erased, destroyed, ...), credentials and
secrets (revoked, rotated keys; not a VirtualPyTest agent fetching and using the auto-sign test token with
`scripts/agent/auto_sign_token.sh`, which is routine agent work, owner 2026-10-15), money (pays, paid), customers, `systemctl` / `pm2` / `sudo` / sudoers / unit files /
reboots, database migrations and migration tools (`alembic`, `prisma migrate`, ...), database resets, force-push and
history rewrites (`-f`, `--force-with-lease`, `--mirror`, `--delete`, `+ref`, `:ref`, pushes to prod/staging/live), tag
pushes and publishing a package. Round 8 added the sudo, unit-file, reboot and migration-tool words to `FORBIDDEN_RE`
too, which only makes every other caller stricter: a button or a voice answer whose text says "graceful shutdown" or
`user.service.ts` now asks for a confirm too.

For a finished turn without a live menu, the manager evaluates every decidable topic present (merge, then push, then
deploy), answers the passing ones in one reply and escalates the rest with what was already answered:

| Kind | Answered when | Module |
|---|---|---|
| merge | round 7 rules (above) | `merge-policy.js` |
| push | one branch, pushed to its own `origin/<branch>` (a push of main/master/the default branch escalates unless a merge into it is decided in the same reply, and so does a push onto another ref: main moves through a decided merge) and fast-forwarding it; local commits on the target are scanned too after a merge; tests green on the branch or docs-only; nothing sensitive (scan fail-closed); not opted out (`pushOptOut`, plus `mergeOptOut`); Jev point `push` or reasoning at `pushMinConfidence` (0.85) | `decide-policy.js` `evaluatePush` |
| deploy | asked for explicitly; through the deploy queue with `deployRunner` on; exactly one configured environment named (or the only one, and no unknown target such as "production" named); no blocking lease on the scope; tests green on the ref (an unnamed report only when the session's HEAD is the ref), or on the session's branch already merged into it; no database migration between the last deployed commit and the ref (no deployed commit known: escalate); not in `deployOptOut`; the proposed procedure is the queue (`--force`, `--skip-leased`, `VPT_DEPLOY_NO_QUEUE`, "directly" / "bypass" or a session running `update_core.sh` itself escalates); migrations are detected as `migrations/`, `migrate/`, `alembic/`, `db/migrate*`, `*.sql` (a lab SQL migration must also be additive: no `CREATE TABLE ... AS`, no `CREATE OR REPLACE VIEW`); not in `deployOptOut`; Jev point `deploy` or reasoning at `deployMinConfidence` (0.85). The reply carries a one-line rollback (a deploy of the previously deployed commit, or "previous release unknown") | `decide-policy.js` `evaluateDeploy` |
| recommended option | `menu_recommended` is on by default: neither the question nor the recommended option has a hard topic (a generic "Yes" / "Proceed" inherits the question's topic; only the other options of a marked menu may mention anything: an unmarked menu keeps every numbered line in the floor, and a proceed / continue question over a list is a plan, never a menu; the `continue` floor reads the whole closing text, not its last lines); a merge/push/deploy option is evaluated first (a live menu gets only its key) | `manager.js` |

Defaults: `autoSend: true`, `autoCases: ['continue', 'menu_recommended']`, `mergeDecisions` / `pushDecisions` /
`deployDecisions` true. A saved `manager.json` is migrated once (`autonomyVersion: 1`: `menu_recommended` added even where the
owner had chosen `continue` only, push and deploy decisions on unless set, a saved `autoSend: false` kept; one feed notice
says so); later owner changes are kept. An unreadable `manager.json` keeps auto-answer off for that run. `deployRunner` stays off by default, and with it off a
deploy escalates ("deploy runner off").

Every decision goes to `<state>/manager-decisions.jsonl` (`kind` merge|push|deploy|menu; round-7
`merge-decisions.jsonl` is still read; `GET /api/manager/merge-decisions` is the merge-only alias), to `stalls.jsonl`,
and to the feed. The interactive manager runs the same checks with
`node scripts/merge-eval.js --kind merge|push|deploy [--env <e>] [--scope <s>] [--ref <r>] --journal`.

**Decided for you.** `decided.js` turns the log into one list of everything the manager typed on the owner's behalf
(continue, menu, AI reply, info, merge, push, deploy), newest first, with a one-line why, the evidence and a revert:
`GET /api/manager/decided?hours=24|since=<iso>&limit=100` -> `{ items: [{ id, at, session, kind, what, why, evidence,
revert: { label, text }, url }], summary: { count, byKind, text } }`. `POST /api/manager/decided/:id/revert` sends the
revert text for a merge, push or deploy to the session, once per item, through the guarded send path as the caller's actor (`by`, default `owner`); 409 when the session has not finished its turn, shows a menu, has a draft, or the item was already reverted;
other kinds return a correction draft instead. A merge the integration lane made (journal source `integration-lane`: records `lane-merge-<request>` per verdict in `merge-decisions.jsonl`, `lane-deploy-<request>` per deploy; they are decided items on their own) is reverted by the lane, session or not: the response is `{ enqueued: <request id> }` and the lane runs `git revert -m 1` on the merge commit, tests and pushes it. The manager's `merge_handoff` is logged as an `answer` (case `merge_wait`) joined to the lane's verdict record; it needs `autoSend`, `mergeDecisions`, no owner draft and the hourly cap, and `mergeOptOut` reaches the lane's own evaluation (and `scripts/merge-eval.js`). The dashboard view is in the More menu (`/?decided=1`, Revert needs a
second tap, Correct opens the session with the draft). Once a day at `decidedDigestHour` (18, in `pushTimezone`) a
digest-tier push "Decided for you today: N" carries the summary; voice mode speaks the same summary.

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

**Jev technical gate (2026-10-23).** The stop decision records `technical: "yes"|"no"` and a one-line `why` before the answer/escalation pick. A `yes` is a contained engineering choice (including a dedicated least-privilege credential for our own CI) and routes an escalation to the manager. Money, customers, physical actions, personal/shared/third-party credentials, and other hard floors remain `technical: "no"` and owner-routed; the field never bypasses a floor. `scripts/jev-ask.js --help` shows the extended JSON shape.

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
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/<user>/ghosty-sessions/claude-plugin/ghosty-reporter" } }
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

## Central lease service (round 10, owner 2026-10-14)

"We need to rethink the lease process and make sure our new codebox centralises it, because it is a main point of
blocking for dev, test and deployment." The design, the conflict matrix, the queue and the cut-over are in
[LEASES-CENTRAL](v2/LEASES-CENTRAL.md); the rules agents follow are in [LEASE-RULES](LEASE-RULES.md).

- `lease-service.js`: the single writer of leases, tickets and the deploy queue (journal + snapshot in
  `<state>/leases/`, fail closed). Always constructed; nothing in the fleet uses it until clients point at it.
- `lease-routes.js`: `/api/lease/v1/*` for lease clients, bearer token per machine (`node scripts/lease-token.js add
  <name>`; hashed in `<state>/leases/clients.json`), loopback and tailnet addresses only (`LEASE_ALLOW_CIDRS` adds
  ranges), `LEASE_ENVS` lists the valid environments (empty: any sane name).
- `scripts/vpt-lease`: the compatible client (Python 3, standard library): the registry CLI's commands, output and exit
  codes, plus `--wait`, `--ticket`, `run -- <cmd>`, `heartbeat`, `validate`, modes `exclusive | observe | pin`. Mode
  `legacy | central-through-ssh | shadow | central` in `~/.config/vpt-lease/config`. `central-through-ssh` forwards every call over ssh to the
  registry host's own `vpt-lease` (`VPT_LEASE_SSH_TARGET`, `VPT_LEASE_REMOTE_CMD` default `~/bin/vpt-lease`; else `VPT_LEASE_LEGACY` is the transport):
  full central semantics, remote exit code passed through, ssh failure (255) = 5; `run` claims/heartbeats/releases over ssh and runs the command locally.
- `lease-source.js`: what the dashboard, the deploy runner, lease-watch and the manager read: `manager.json`
  `leaseAuthority: "legacy"` (default: the registry over ssh, unchanged), `"central-through-ssh"` (the same registry paths, labelled: the registry host's central service reached by the client forwarding over ssh) or `"central"` (the in-process service; read once at start). Unless `central`, the in-process service refuses writes and reads (`check`, `list`, `get`, `events`, `deploy list|wait|last`) with `E_NOT_AUTHORITY`; only `status`, `tick` and the shadow store stay open (an empty store must never answer "free"). There is no switch to make it claim.
- The **Leases** view (More menu, `/?leases=1`) shows held leases, tickets with position and ETA, the deploy queue,
  overridden pins and shadow disagreements; force-release and downgrade-to-pin need two taps and are central-only.
- The manager answers lease questions from the lease source instead of escalating them (`lease-ask.js`), and voice
  mode has a lease line in the digest and a "who holds" question.
- Import / export for the cut-over: `node scripts/lease-import.js` (dry run unless `--apply`), `node
  scripts/lease-export.js`.

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
  `full` -> none. The command runs as `ssh <host> "VPT_LEASE_AGENT=manager:deploy <cmd> <ref> <flags>"` (11 min timeout: the 10-min lease cap plus 1 min grace), output in
  `$GHOSTY_STATE_DIR/deploys/<id>.log`. Without `health`, only update_core's exit code decides done / failed.
- One running deploy per env. Queued requests with the same env + ref that the running scope covers (`full` covers all; other scopes only
  themselves) are finished with its result (`coalescedInto`).
- Registry: the default SSH adapter is deployment-specific (see `deploy-runner.js`). Override `DEPLOY_REGISTRY` with a JSON command array for your registry; for example, `DEPLOY_REGISTRY='["python3","/path/vpt-lease"]'` for a local registry. This setting does not configure every other lease adapter.
  `DEPLOY_POLL_MS`, `DEPLOY_TIMEOUT_MS` override the timings.
- **Standing approval is bounded.** With the runner on, it approves only requests made in-process (the integration lane, after its merge evaluation; the manager) or by a client named in `DEPLOY_AUTO_APPROVE_CLIENTS` (comma list of lease client names; default `registry`, the central client every agent's `vpt-lease deploy request` arrives through; set it to replace the list), and requests with no recorded client (legacy registry). A request any other bearer token made stays `awaiting-approval` and goes to the manager item.
- **Survives a restart (BUG-0341).** The deploy child is detached (own session, output to `deploys/<id>.run` via a file descriptor) and a
  tiny `sh` wrapper writes `deploys/<id>.pid` / `<id>.exit`. A restarted ghosty re-adopts every `running` deploy of the runner whose
  wrapper is alive or left an exit file, and finishes it as usual; with neither file the orphan sweep still applies. So a restart no
  longer loses a deploy, but the `.pid` / `.exit` / `.run` / `.off` files must not be deleted. The systemd unit must not kill the child on
  stop: `ghosty-sessions.service` needs `KillMode=process` (one line in `[Service]`, in `systemd/`); `/etc/systemd/system` is a hand copy, so
  copy it and `systemctl daemon-reload` (no restart needed for the unit text to be read; it applies at the next stop/start).
- API: `GET /api/deploys`, `POST /api/deploys/:id/approve|cancel`, `GET /api/deploys/:id/log?tail=200`; `{type:'deploys'}` on `/ws/status`.
- **Restart guard** (`scripts/safe-restart.sh`): busy = a `running` deploy, or an `approved` one, or a `queued` one while the runner is on, each deploy item except when it carries `blocked: true` (its last start attempt was refused because a lease or a ticket held it, so it cannot start before the restart; Q199, owner 2026-10-20). A `running` item is busy even when blocked; a missing `blocked` field counts as not blocked (an older server keeps today's safe rule) and a non-boolean one is an invalid snapshot (exit 2).

## Platforms page, lease ownership, waiting for a deploy (TASK-44)

Open it from the ⋮ menu -> Platforms, from a lease chip / purple badge, or `/?platforms=1` (`/?deploys=1`, the push link, opens it too).
One block per platform/env, BLOCKED first, then DEPLOYING, then FREE: a status pill, **NEXT DEPLOY** in one line
(scope, ref, who, when it can start = the end of the lease it waits on, Cancel; several queued fold under "N more"),
**IN USE** (every lease, red when it blocks the next deploy), **LIVE** (every target in the ledger, red when its last
attempt failed) and a collapsed **History**. Agent ids are shortened for display; "session gone" means a recognized local holder has no live tmux session.
See `public/platforms.js` for legacy alias handling.
What blocks follows the runner: full deploys wait on `run` and env-wide leases, host deploys on env-wide ones
(`effectiveBlockers` in `public/platforms-view.js`, same rule as `vpt-lease` with `--skip-leased`).

- **Exact ownership.** A lease belongs to a session iff its agent is `<machine>:<tmux session name>`, case-insensitive.
  Use the actual host name; the implementation also recognizes a legacy alias. Generate holder IDs locally, never hard-code a private host name in documentation.
  There is no fuzzy guess: a recognized local holder without that exact session shows as "session gone". Code: `public/platforms.js` (pure, shared with the server),
  `leases.js` (reads `vpt-lease list --json`, 15 s cache, injectable `run`).
- **Status payload.** `status[session].lease` = `[{env, resource, ttlLeftMin, purpose, blocksDeploy}]` (`blocksDeploy`: an
  awaiting-approval or queued deploy of that env whose scope touches the resource). `/api/leases` and the `leases` WS message also carry `waiters` and `hostname`.
- **Lease chip.** Only a session holding a lease gets `<platform>/<device> · 1h40` (`+N` for more) in the card header and board row; amber
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
| Codex | live account read: `codex app-server` over stdio JSON-RPC (`initialize`, `initialized`, `account/rateLimits/read`), killed after the answer, 20 s timeout, no model call | 5h = `primary` (300 min), week = `secondary` (10080 min); a window whose reset time has passed reads 0 % (`expired`) |
| Claude | `$GHOSTY_STATE_DIR/claude-rate-limits.json` written by `scripts/claude-statusline-ratelimits.sh` | no limit file exists on disk; Claude Code passes `rate_limits` (`five_hour`, `seven_day`: `used_percentage`, `resets_at`, Pro/Max logins, after the first reply) to its status-line command. Shows `?` until the script is installed as the status line |
| MiniMax (Token Plan) | the calls mcode's `/usage` makes: `GET platform.minimax.io/v1/api/openplatform/coding_plan/remains` with mcode's stored login as bearer token (read per request, in memory, never logged or kept) (plan name/expiry are not read: that needs mcode's signed client calls, deliberately not replicated) | 5h used % = 100 - remaining %; week is `unlimited:true` (no %, never triggers the weekly-projection hold) or a %. The login is never refreshed: when mcode's access token has expired the plan shows the last value as stale with `mcode login expired — open mcode once` |

A failed read keeps the last good value with `stale:true` and an `error` (the quota sheet shows it); a stale plan
never holds a session. The quota sheet shows each plan's subscription and "unlimited" weekly windows.

Env: `CODEX_BIN` (default `~/.local/bin/codex`), `MINIMAX_AUTH_FILE` (mcode login file, default the `en`/prod one),
`CLAUDE_RATE_LIMITS_FILE` override the paths.

Claude status line: in `~/.claude/settings.json` set
`"statusLine": {"type": "command", "command": "/home/<user>/ghosty-sessions/scripts/claude-statusline-ratelimits.sh"}`
(needs `jq`). It reads only the JSON on stdin and prints `model 5h NN% wk NN%`.

## Usage (Langfuse)

The tailer, `usage/ingest.js`, produces token usage and API-equivalent cost per session, project, agent, model and day.
Usage records contain numbers and identifiers; evaluation/dataset features can additionally send closing text as described above.

- **Langfuse**: optional separately deployed service, outside this repository. Configure `LANGFUSE_URL`, project keys and access controls for your installation. Do not assume any deployment's Docker configuration, signup or telemetry settings. Keep its private configuration outside the checkout.
- **Tailer**: copy and adapt `systemd/ghosty-usage.service` using the same path/user review as the main unit in INSTALL before enabling it. It reads the API keys from `~/.config/ghosty/usage.env`
  (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optional `LANGFUSE_URL`), chmod 600.
- **Sources**: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`, including `subagents/`), Codex
  rollouts (`~/.codex/sessions/**/*.jsonl`, one generation per `token_usage_record`), and MiniMax
  (`local_runtime_token_usage` in `~/.minimax/v2/sqlite/runtime-state.sqlite`, read-only; the table has no
  model column, so `MINIMAX_DEFAULT_MODEL` is assumed and cost stays unknown).
- **Per message**: one trace per agent session, one generation per assistant turn (deterministic ids, so replays
  upsert). A Claude message is logged as several lines with the same `message.id` and a growing
  `output_tokens`; the largest wins. `usage/prices.json` holds USD per million tokens per model-id prefix
  with `source` and `as_of`; a model without a price gets no cost (never guessed).
- **Attribution** (ledger fields): MiniMax rows carry `model_source` = `launch` (model of the session-history
  instance in that cwd at that ts, `minimax/` prefix stripped) or `default` (`MINIMAX_DEFAULT_MODEL`). OpenCode rows
  (`agent: 'opencode'`, id `opencode:<message id>`, model `<providerID>/<modelID>`, reasoning tokens added to output)
  have `cost_source: 'provider'` only when the provider is metered and `cost > 0`, else `cost: null`. `label` falls
  back to the session-history name (cwd+ts, provider match) before the cwd folder name. Without
  `session-history.jsonl` nothing changes.
- **State**: `~/.local/state/ghosty/usage-offsets.json` (byte offsets), `usage-ledger.jsonl` (one compact
  record per turn; compacted by id at tailer start, rows older than `BACKFILL_DAYS` kept since round 6b), `usage-summary.json` (rewritten every minute: totals per session / project / agent / model /
  day for the last 14 days, plus `outliers` = sessions whose cost per active hour today is over 3x their
  project's median; rule in `buildSummary()`), a `today` block (totals / agent / project / model for the UTC day)
  and per session `today`, `days`, `activeHours` for the usage view.
- **Session history** (`session-history.js`, `history-view.js`): `$GHOSTY_STATE_DIR/session-history.jsonl`, append-only,
  one JSON object per line, `schema_version: 1`; a torn or invalid last line is skipped on read.
  `{kind:'session.started', name, provider, model|null, cwd, started_by:'dashboard'|'cbsession'|'v2'|'manager'|'unknown',
  prompt_ref, handover_ref, remote_control_url?, ts}` and `{kind:'session.ended', name, ts, reason:'killed'|'exited'|'vanished'}`.
  `prompt_ref` is a file path or at most 200 sanitized characters of prompt text. A session instance is a start plus the
  next end for the same name (names are reused). Writers: dashboard create/kill, the tick (a live tmux session with no
  open instance becomes `unknown`, ts = first seen; one gone for 2 consecutive ticks ends as `vanished`; rebuilt from the
  file at boot), V2 developer/reviewer runs (name = run id, `v2`, ended `exited`), and `scripts/cbsession`
  via `POST /api/history/started` (loopback + `x-ghosty-reporter-token`; an `unknown` instance is enriched in place).
  `GET /api/history?offset=&limit=&provider=&model=&started_by=&from=&to=&status=running|ended` (newest first, limit
  default 50, max 200; from/to filter the start time, ms or ISO) returns `{ok,total,offset,limit,sessions:[{name, provider,
  model, started_by, cwd, prompt_ref, handover_ref, remote_control_url, start, end (null = running), elapsed_ms, active_ms,
  turns, tokens:{input,output,cache_read,cache_write}, billing:'metered'|'subscription', cost_usd, days:[{day,turns,tokens,cost_usd}]}]}`;
  `GET /api/history/:name?start=<ms>` is one row (latest instance by default). Join with `usage-ledger.jsonl`: ledger
  `label` = session name (V2 runs: ledger `cwd` = the run worktree) and ts inside [start, end]; the whole ledger is read
  (cached by size+mtime), no day cap. `active_ms` = sum of gaps between consecutive turns, each gap capped at 5 minutes.
  Unknown stays `null`: no turns -> `tokens`, `active_ms`, `cost_usd` null; any unpriced turn -> `cost_usd` null;
  subscription providers (MiniMax) -> `billing:'subscription'`, cost null.
  Round 6b, derived at read time (the history file is never rewritten): a first-seen instance (`started_by:'unknown'`)
  starts at its label's earliest ledger turn after the previous instance of that name and after its tmux session was
  created (`start_source:'ledger'`, `recorded_start` = when it was first seen; the detail route accepts either start),
  and every turn of a label that no instance covers forms ended rows (`source:'ledger'`, `started_by:'unknown'`,
  start/end = first/last turn, provider = most frequent agent), split on 6 h idle gaps and at instance starts. Turns
  of V2 runs (joined by cwd, or by the run's own name as label) are counted only in the run. The joined list is cached per ledger generation and history
  state. The tailer rewrites the ledger at start through a temp file + rename.
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
| `MINIMAX_DEFAULT_MODEL` | `MiniMax-M3` | MiniMax model used only when session-history knows no launch for that cwd/ts |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode sqlite; only the `message` table is read (read-only, scalar columns via `json_extract`, never text) |
| `OPENCODE_METERED_PROVIDERS` | `openrouter,anthropic,openai,google,xai` | providers whose OpenCode `cost` is recorded; others stay unknown (null) |
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

## V2 task API (opt-in)

Enabled only with `GHOSTY_V2=1`. Handlers are in `orchestration/http.js` (tested without the server), assembled with the
goal loop by `orchestration/v2-runtime.js`; `server.js` runs them after its Origin check and the JSON content-type check
for non-GET requests. Store: `$GHOSTY_STATE_DIR/v2`. Writes (create, cancel, approve, deny, ops requests) are accepted
only while this process holds the goal-loop controller lease; otherwise 503 `E_NO_CONTROLLER` and nothing is written
(another live server, or `GHOSTY_V2_WORK_ROOT` unset). Reads always work.
All bodies are JSON objects, max 64 KB, with unknown fields rejected. Task ids match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
Writes (POST) need a caller: the dashboard (same-origin `Origin` or `Sec-Fetch-Site`, no token) or a bearer client flagged `manager` may create, cancel, approve and deny; a loopback session with the reporter token may only create and cancel (approve/deny: 403 `E_FORBIDDEN`); anything else is 403. The recorded actor is the real caller (`owner`, `manager:<client>`, `loopback`). A local process can still forge a same-origin `Origin`: Tailscale remains the gate.
Errors are `{ ok:false, error, code }` (400 invalid, 404 not found, 409 conflict or terminal, 413 too large, 503 store failed or no controller).

| Route | Body | Result |
|---|---|---|
| `GET /api/v2/tasks` | none | `{ tasks:[{ task_id, title, goal (200 chars), state, outcome, next_action, updated_at, created_at, project_id, risk_class, source, parent_task_id, delivery{ requested, integrated, label }, store_error }], approvals:[pending requests across all tasks] }`, newest first. `store_error` is a coarse text; the detail is in the server log |
| `GET /api/v2/tasks/:id` | none | the summary plus goal, scope, `definition_of_done`, `base_sha`, `head_sha`, `acceptance_checks[{ id, command, required, status, latest_evidence{ sha, exit, duration_ms, artifact, actor, ts, on_head } }]`, `verdicts`, `decisions` (rationale, evidence, alternatives), `usage` (`null` = unknown; `incomplete: true` = partial counts; per-record too), `runs` (role, runtime, model, effort, start/end, outcome, usage), `roles`, `allowed_actions` (approval classes, prohibited actions, policy allowlists once a run read the policy), `parent_task_id` and `children`, `delivery`, `leases{ resources, effects }`, `incidents`, `history`, `pending_approval` (`action_id`, `kind`, `question`, `classes`, `keys`, `sha`, `cap_reached` and `entry` for budget stops), `wait` (`reason`, `until_ms`, `resume_to`, `diagnosis`, `next_action`; null unless waiting) |
| `POST /api/v2/tasks` | `goal` (required) and optional `title, repository (absolute path), base_sha, project_id, scope, acceptance_checks, definition_of_done, risk_class, priority, runtime_capabilities, prohibited_actions, runtime_allowlist, model_allowlist, budget_policy, no_progress_policy, preferred_models, task_class, deliver, template (goal or informational), idempotency_key`. `repository` must be on `GHOSTY_V2_REPOS` (informational tasks may omit it). `preferred_models` (1-8 `runtime:model` ids) pins the developer: it only narrows routing, and pinned models never review the task. `deliver: true` asks for integration (owner-gated, below) | 201 with the summary and `defaults_applied`. Goes through `orchestration/intake.js` with source `ui` and actor `owner`; the same key returns the same task. The scheduler picks it up at once |
| `POST /api/v2/tasks/:id/cancel` | `{ reason? }` | cancels a non-terminal task as `owner` |
| `POST /api/v2/tasks/:id/approve` | `{ action_id, sha?, reason? }` | records `approval.granted` for the pending request only. `action_id` must equal `pending_approval.action_id`; `sha` is required when the task has a head SHA and must equal it. Covers exactly that request's action classes. 409 `E_NO_PENDING_APPROVAL`, `E_STALE_ACTION` or `E_SHA_MISMATCH` otherwise |
| `POST /api/v2/tasks/:id/deny` | same | records `approval.denied` |
| `GET /api/v2/scorecard` | none | read-only scorecard (`by_model`, `by_runtime`, `by_role`, `by_task_class`, `caveats`, `runs_count`; per-run rows omitted), see [Scoring](v2/SCORING.md). Any other method is 405. Writes nothing |

`outcome` is `done` only for state `accepted`; otherwise `not_yet_done`, `waiting`, `needs_owner`, `unrecoverable` or
`cancelled`, and `unknown` when the task log cannot be replayed. Approve, deny and cancel are written by the goal loop
under its controller lease (D-020) and wake the task. Budget stops: `cap_reached: false` (unknown estimate) is answered
by approve (one run), `cap_reached: true` by deny or cancel. Proposal tasks (informational) are answered the same way;
the answer is the outcome and applies nothing.

| Route | Body | Result |
|---|---|---|
| `GET /api/v2/ops/status` | none | engine state (`running`, `refused` with the reason, `stopped`), repository count, concurrency, runtime probes, scheduler queue |
| `GET /api/v2/ops/telemetry` | none | host telemetry assessment (`orchestration/telemetry.js`, freshness-checked) |
| `GET /api/v2/ops/incidents` | none | incidents (`orchestration/incidents.js`) |
| `POST /api/v2/ops/requests` | `{ action, type?, symptom? }` | 202: records an incident in `mitigation_requested` through System Operations' request-only handle. Nothing executes: no executor is wired |

Delivery (`deliver: true`, `orchestration/v2-integrate.js`): after acceptance on the exact SHA the hook may push only the
task's own branch `v2/task/<id>` to `GHOSTY_V2_PUSH_REMOTE` (compare-and-swap, recorded as an effect, read back from the
remote; repository hooks, fsmonitor and the `ext::` transport are disabled for these git calls; an unreachable remote
is a note in the decision, nothing is recorded or retried by it). The merge into `main` is an `integration` approval bound to `integration:merge:<project_id>:main:<sha>`
(`merge_protected` when `main` is a protected branch). Even approved, this server does not merge or deploy (no
integration lane): the task waits until `main` contains the SHA, then it is accepted as integrated.

The full scoring report, tool score and proposals are a script: [`scripts/v2-score.js`](v2/SCORING.md); only the scorecard has a read-only route.

## Architecture

```
┌────────────┐  capture-pane  ┌─────────────────┐  WebSocket / TLS  ┌────────┐
│  tmux      │ ─────────────▶ │ ghosty-server   │ ─────────────────▶ │ phone  │
│  (sessions) │  tmux send-keys│ (Node 20+, ws)  │  JSON snapshot    │ (PWA)  │
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
| `waiting` | detected question or permission prompt needing input |
| `working` | detected agent activity |
| `done` | detected finished turn; becomes idle after the configured interval |
| `idle` | no current work/prompt detected |
| `offline` | session unavailable |
| `deploy` (display only) | deployment wait overlays raw state except waiting/offline |

Parsing and activity detection live in `server.js`; `public/state.js` defines display labels and precedence.
These are heuristics, supplemented by reporter facts, not proof that a task succeeded. Preserve tests when changing them.

## Files

See the maintained [repository map](MAP.md) for components, tests and persistent data. The route inventory is at the top of `server.js`; handlers and tests are the authority for request/response details.

## Adding xterm sessions automatically

Every tmux session visible to the server's Unix user/socket appears in the dashboard. See [Usage](USAGE.md#first-session)
for creating a session. UI launch commands are configured above.

## Security

- No user authentication: every client allowed to reach the endpoint can read and control sessions as the service user.
- Bind explicitly and restrict tailnet grants/ACLs. Never publish the service with Funnel or a public tunnel/proxy.
- Keep Origin checks, exact tmux targets, body/input validation and reporter tokens intact; none replaces the network gate.
- Optional providers can receive data: ntfy receives alert content; AI review can receive session text; Langfuse evaluation can store closing text. Configure and assess these separately.
- See [agent contract](CONTRACT.md) for invariants and [INSTALL](INSTALL.md) for operational checks.

## License

No license file yet: all rights reserved by the author until one is added.
## Icons

All UI icons come from one set in `public/icons.js` (24x24 grid, 2px round strokes, `currentColor`). Do not paste emoji, unicode
glyphs (⏸ ⚡ ⚠ ▲ …) or one-off `<svg>` markup: add the icon to `ICONS`, then use `${icon('name', size)}` in JS strings or
`<i data-icon="name" data-size="18"></i>` in `index.html`. The catalogue is listed at the top of `icons.js`.

## CI watch (owner, 2026-10-15)

`ci-watch.js` keeps a repo's main branch green without anyone starting a session by hand. Every 30 min (first check 2 min after start)
it reads the newest finished run of the configured workflow on the branch with `gh` (cancelled runs are ignored; a red verdict waits up
to 60 min for a newer run still in progress). Red and no live fixer: it starts one with `scripts/cbsession` (session `ci-fix-main` and
Claude by default; codebox points it at the existing MiniMax M3 session `TASK66-cicd`) from a standard brief: fix the code, never skip or loosen a check, push to main, watch the run. The failed-step log
goes to `<stateDir>/ci-fix/<run>.log`. A live fixer that is working is left alone. An idle one gets the new red run, at most every 25 min.
After 4 dispatches in one red streak it stops and pushes the owner once (`ci-watch:stuck`). Delete `ci-watch-state.json` to let it retry.
Feed events: `ci-watch:red`, `ci-watch:fixer-started`, `ci-watch:fixer-nudged`, `ci-watch:green`. Journal: `ci-watch.jsonl`.
Config: `<stateDir>/ci-watch.json` `{ "repo": "<owner/name>", "workflow": "<file.yml>", "cwd": "<checkout>", "branch": "main", "session": "ci-fix-main",
"provider": "claude|minimax|codex|opencode", "model": "<optional, cbsession -m>" }`. Without it the watch stays idle. `manager.json` `ciWatch`: `"dry"` (journal only) or `"off"`; default live.
`GET /api/ci-watch` shows the last verdict, the action and the red streak.

## Done check (owner/manager, 2026-10-15)

A session's `STATUS: done` is checked against git, not trusted (TASK59 said "shipped, nothing pending" with 7 commits
never on main). `done-check.js` runs every 5 min (first check 4 min after start) over the idle sessions whose last STATUS
line is done (not the manager's, not paused). For the session's folder, and for every branch name or worktree path its
closing text names that exists in that repo, it counts commits not on `origin/main` (`--cherry-pick`, so equivalent
patches count as merged; `VERSION.txt`-only stamps ignored; content that reached main through other commits counts as merged
when a trial `git merge-tree` into main is clean and changes nothing) and uncommitted tracked files. Each repo is fetched at most
every 30 min. A mismatch gets one feed line `done-check:<session>` and one message to the session: finish it (commit,
merge when the merge evaluation passes, push, deploy) or say in one line why it stays. Once per finding, at most 2 per
check, and none while the session works or the host is busy (load above 1.5 per core, under 20% RAM available).
`manager.json` `doneCheck`: `"dry"` (journal `done-check.jsonl` only) or `"off"`; default live. `GET /api/done-check`
shows the last check and its findings.

## Rules watch (owner, 2026-10-15)

A session reads AGENTS.md once, at start. `rules-watch.js` checks every 10 min (first check 3 min after start): for each
live agent session (not the manager's, not paused), the last commit that touched AGENTS.md on its repo's `origin/main`
(fetched each check). If that commit is newer than the session's agent process, the session gets one message while it
is idle: the commit, the precedence rule (AGENTS.md beats older task docs and briefs, never hand the owner commands) and
`git show origin/main:AGENTS.md`. At most 2 sessions per check, and none while the host is busy (load above 1.5 per core or under 20% RAM available): a message can wake an idle session into work, and 6 per check swapped codebox on 2026-10-15. An idle session is told to start nothing new. Each session is told once per AGENTS.md commit (`rules-watch.json`),
with a feed line `rules-watch:told` per check and a journal `rules-watch.jsonl`. `manager.json` `rulesWatch`: `"dry"`
(journal only) or `"off"`; default live. `GET /api/rules-watch` shows the stale sessions and who was told.

## Lease binding (TASK-58 C1)

`lease-watch.js` polls the configured external `vpt-lease` registry every 30 s: it writes `lease:released|expired|narrowed` to manager-events.jsonl (never pushed),
releases a lease whose recognized `<machine>:<session>` holder is gone (seen in tmux before, missing on two polls in a row), and narrows a `kind=server`
lease to `host` when the holder had no finished turn for 30 min (never releases an idle holder). Everything automatic is logged with
`by:"TASK58-C1"` in `lease-actions.jsonl`. `manager.json` `leaseBind`: `"dry"` (log only) or `"off"`; default live. `GET /api/leases/watch` shows
each holder (live / ended / remote / unknown / system) and the planned action. The reporter plugin releases a session's leases on SessionEnd
(not on /clear or resume). Daily report: `lease-stats.js` (deploy request -> start p95, minutes held back by a lease, unknown holders).

### Leases and deploys never reach the owner (round 12, OWNER_DECISIONS section 19)

- **A lease or deploy stop is a manager item.** `ops-ask.js` `opsAsk(final)` says `'lease'`, `'deploy'` or `null`: the case `waiting_deploy`, or an
  `owner_decision` / STATUS `needs-owner` / `blocked` whose every question is about a lease, a deploy, `update_core`, the deploy queue or approval, or the
  restart of a service by the deploy procedure. The hard floor (`hardMatch` with `deployPresent`) runs on the whole text first, and `opsAsk` returns null when `hardMatch` (deploy, push and merge words exempt) finds a §15 hard topic (force-push, tag, publish, sudoers, unit, production migration): a deletion, credential,
  money, customer, migration or `sudo` word keeps the stop with the owner, as does a second, unrelated question in the same stop. A merge or push in the
  stop that the policy escalated also stays with the owner. The lease-answer path (`lease-ask.js`) still runs first; only what it leaves goes on.
- **What happens.** `escalate()` logs `{type:'escalated', target:'manager', kind}`, calls `onManagerItem` (server.js: one `manager-events.jsonl` line, key
  `lease:manager-item` or `deploy:<stop id>:manager-item`, for the `manager` session to read) and does not call the owner push. `stallOf()` exposes
  `escalatedTo: 'owner'|'manager'`; `isOwnersTurn` (`public/ask-model.js`) and the NEEDS YOU strip skip `'manager'` stops. Switch: `manager.json`
  `opsToManager: false` restores the old routing (accepted by `POST /api/manager/config`). Not covered: the raw `waiting` push of a live terminal menu fires before the manager has classified the stop.
- **The orchestrator asks the holder** (`lease-nudge.js`, every 2 min). For a queued deploy (the runner's `blocking`) or a ticket waiting more than 10 min,
  each blocking holder is asked once per (holder, lease) per 30 min when its lease is past its own `expect_min`, idle (no finished turn for 20 min, the
  lease-watch signal) or broader than its purpose (env-wide or server-kind lease whose purpose names one host, device or the frontend). A codebox session stopped
  on a finished turn with no draft and no menu gets one line through the guarded send (`by: 'lease-nudge'`); any other holder (Mac, scripts) gets a
  `lease:nudge` manager event with the same text. It never releases or narrows. Audit: `lease-nudges.jsonl`; cooldowns: `lease-nudge.json`.
  `manager.json` `leaseNudge`: `"live"` (default) | `"dry"` (log only) | `"off"`.

## Round 9: other machines, ledgers, credit fallback, ready window

- **The approved action** (`stall.js` `approvedAction`, `isPastNarrative`): for a recommended option or a "continue", the hard floor reads the
  option being approved and the commands it runs (or the plan a generic "Yes" / "Proceed" approves), not unrelated narrative. A sentence that reports
  finished work (past tense with a time marker, no plan or future wording, plainly spelled) no longer blocks a routine answer; a hard action in the
  approved option, its command or its plan still escalates. `FORBIDDEN_RE` is unchanged.
- **Unmarked menus**: a clean 1..N menu without a recommendation marker whose option 1 is safe (no hard topic, not merge / push / deploy, not
  skip / cancel / stop) is answered as if option 1 were recommended (`source: unmarked-first`). `decided.js productVisible()` sorts picks that name
  something users see (page, button, theme, wording, default, ...) first in the Decided-for-you list and summary.
- **Lab database** (`decide-policy.js` `analyzeMigrationSql`, `additiveMigrations`): a deploy whose range contains migrations is decided only when the
  env is in `labEnvs` (manager config, default `[]`) and every migration is a newly added `.sql` file of additive statements; the reply names the files
  and the procedure (`migrationProcedure[repo]`, else the deploy queue). OWNER_DECISIONS §17.
- **Self-checks** (`self-check.js`, `selfChecks` switch, default on): before escalating, the manager answers "what version is deployed on X?" from the
  deploy ledger, "is the run finished?" from the session's own job, and "does <path> exist?" (stat only, inside the repo or `infoRoots`, no symlink
  escapes, secret-looking paths refused). **One open ask per session**: a new escalation supersedes the session's older open asks in the owner-asks
  ledger; the NEEDS YOU strip shows the newest only.
- **Mockup-first** (`mockups.js`; `mockupFirst`, `mockupWindowMin` default 10): `POST /api/mockups` (loopback + reporter token) records a feed item
  `kind: mockup` with a link and a deadline; a stop asking to show the mockup before building is answered "post it to the feed and build"; the owner's
  "Object" (notification button or `POST /api/mockups/<id>/object`) sends the session "The owner objects to the mockup: wait for their notes."
- **Waiting on its own job** (`job-refs.js`, `own-jobs.js`): a STATUS `blocked` / `waiting` that names a pid, a log file, a run id or a deploy id is
  case `own_job_wait`, never shown as needs-you; the job is watched (deploy state, `/proc/<pid>` or the pane's process tree, a log file's mtime)
  and when it ends the session gets "your <job> finished at <time>, continue". A detached job (`nohup`, `setsid`, `disown`, `&`) is flagged in the feed.
- **Remote stops** (`remote-stops.js`, `scripts/mac-stop-hook.sh`, install in [MAC-HOOK](MAC-HOOK.md)): `POST /api/remote/v1/stops` and
  `GET /api/remote/v1/stops/<id>/answer?wait=<s>`, same address allowlist and bearer-token store as the lease API, but the token's client needs
  `remote: true` (`node scripts/lease-token.js add <name> --remote`). A stop enters `manager.js observe()` as the session `mac:<session name>`
  (`s.remote`: no settle wait, no restart dedupe, a fake reporter turn carries the text); the manager reports back through one marked block
  (`setRemoteHooks`: settled, cancelled, escalated, noAnswer, maxDelayMs). `<state>/remote.json`: `{ "waitS": 45, "checkouts": { "<project>": "/abs/path" } }`
  (hook wait 1..120 s; local checkouts for merge / push / deploy evaluations). Dashboard rows come from `remote.statusRows()` in `pollOnce`.
- **Owner round-trip ledger** (`roundtrips.js`): `<state>/owner-roundtrips.jsonl`, one record when a stop that reached the owner (or was answered for
  them) resolves: `{ id, session, machine, at, answered_at, wait_s, class, by, via, resolution }`. `GET /api/manager/roundtrips?hours=24` returns
  `{ summary: { median_s, mean_s, byClass, text }, records }`; the decided digest appends "Owner waits today: median 8 min, ... over 12 stops".
  Nothing in this repository wrote the file before (its writer was out of tree and stopped on 2026-10-09).
- **MiniMax credit fallback** (`minimax-fallback.js`): with no OpenRouter credit (402 cool-down or cached balance 0) or the Jev breaker open, AI triage
  and the ambiguous-stop Jev choice (`jev()`) use headless `mcode exec` (MiniMax M3; `--permission smart`, `--mode lightweight` when the installed mcode has it,
  empty temp `--cwd`, `--max-steps 1`, one process at a time (`fallback busy`), detached process group killed after 20 s, a tool call in the output is an error, only
  `MCODE_`/`MINIMAX_` environment). Merge / push / deploy evaluations (`jevPost()`) never use it: without Jev they keep the round-7 reasoning path. `manager.json`: `aiFallback` `"minimax"` (default) | `"off"`,
  `aiFallbackDailyCalls` (default 300). Every call writes `{type:'fallback', source:'minimax-fallback', cost:0}` to `stalls.jsonl`; triage and Jev records
  carry `source: 'minimax-fallback'`. `MCODE_BIN` / `MCODE_NODE_DIR` pick the binary.
- **Ready window** (`ready-window.js`): `POST /api/ready { device | host | session, minutes }` (1..240; no name = any session; `{ clear: <id>|"all" }`),
  `GET /api/ready`; voice "ready for 30 minutes [on <device>]". State `<state>/ready-windows.json`. While a window covers a session, a stop that asks
  for a hardware step (pair, press, plug, power-cycle; `owner_action` / `owner_decision`, no forbidden or hard topic) is answered "The owner is at the
  device until HH:MM: retry the step yourself; stop after 2 failures." through the normal manager gates; the third ask in the window escalates.
  The decided-for-you view lists these as kind `ready`. A chip "ready HH:MM" shows beside the priority badge.

## Integration lane (round 13, owner 2026-10-18)

Design: [docs/v2/INTEGRATION-LANE.md](v2/INTEGRATION-LANE.md). Sessions are developers: they push a branch and ask the lane to integrate it. One lane per
repository, run by the server in its own clone, one request at a time per repo (repos run in parallel).

- **Rule:** Never ask the owner, or end a turn waiting on anyone, for a merge or PR decision: run `integrate request`, then `STATUS: waiting: integration <id>`. A session that stops on a merge or PR decision anyway (`STATUS: waiting/blocked/needs-owner` naming a merge or PR) is classified `merge_wait`: the manager queues the branch with the lane and tells the session the integration id; with no lane repo it runs the merge evaluation. A failure is a manager item of kind `merge`; only a hard-floor word (force-push, secrets) reaches the owner.

- **Self-deploy restart (one waiter).** For `deploy.kind: 'self'` the lane launches one `safe-restart` waiter (files `<state>/integration/restart/<id>.{log,exit,pid}`). While it is alive (no `.exit`, pid file names a live safe-restart shell; a dead or recycled pid does not count) a later self-deploy pulls and checks as usual but launches no second waiter: `selfDeploy.restart: 'coalesced'`, `restartWaiter: <id>`, notice "restart pending (coalesced with <id>)". The pending waiter restarts into whatever the live checkout holds then, so the latest pulled sha goes live. Read from the persisted requests, so it survives a lane restart.

- **Config** `<state>/integration.json`: `{ repos: { <key>: { clone, remote: 'origin', target: 'main', test: '<cmd>'|null, testTimeoutMin: 30,
  ci: 'github'|null, ciTimeoutMin: 60, deploy: { env, defaultScope }|null, conventions: ['VERSION.txt'], conventionResolver: 'take-target'|'max-plus-one' } } }`.
- **API** (loopback + reporter token; remote clients with the `integrate` token flag): `POST /api/integration/requests { repo?, branch, session?, deploy?, note? }`
  -> `{ id, position }` (repo from the key, else matched from the session's `origin`); `GET /api/integration/requests?repo=&state=&limit=`;
  `GET /api/integration/requests/:id`; `GET /api/integration/requests/:id/wait?timeout=30` (long-poll to a final state);
  `POST /api/integration/requests/:id/cancel` (only while queued). A `v2/task/<id>` branch is merged only when the V2 store holds the owner's `integration:merge:*:<sha>` grant for the branch's exact SHA (otherwise the request is returned). `--approved-by` is accepted from a `manager` client or, by default, the loopback reporter token; `INTEGRATION_MANAGER_CLIENT_ONLY=1` removes the reporter-token path (the manager then needs a client token in its `~/.config/mycodebox/token`). `--migration-applied` (`migrationApplied`) needs the same gate.
- **Migrations merge by effect (Q199, owner 2026-10-20; additive ones are free, owner 2026-10-21).** The migration floor reads what the diff ADDS, not the path: the lane classifies the added lines of every migration file (comments and blank lines ignored) and calls it **additive** only when they are `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE ... ADD COLUMN` (a non-SQL migration such as an alembic `.py` only when its operations are `op.create_table`, `op.create_index`, `op.add_column`); anything unreadable is not additive. An additive migration can always be applied and merged: the session applies it itself, then `integrate request <branch>` merges it with no `--approved-by` / `--migration-applied` (both still accepted, ignored) and journals a `merge` decision with `migrationAdditive: true` in the owner's "Decided for you" feed. Otherwise the request returns with `migration is destructive: DROP COLUMN in db/migrations/x.sql` (also `DROP TABLE`, `ALTER ... TYPE`, `RENAME`, `UPDATE`/`DELETE`/`INSERT`, `TRUNCATE`, `op.drop_*`). Destructive and unreadable migrations stay the owner's, as do secrets, sudoers, units, red tests and conflicts; the text filter matches a migration only when it is described as destructive.
- **CLI** `scripts/integrate`: `request <branch> [--repo k] [--deploy scope] [--note t] [--approved-by who] [--migration-applied] [--wait]`, `status [<id>]`, `wait <id> [--timeout min]`, `cancel <id>`.
  Exit codes: 0 merged / deployed, 1 error, 3 returned (reason printed), 4 merged but CI red or deploy failed, 5 service unreachable.
- **States**: `queued`, `running`, then final `merged`, `deployed`, `returned` (reason + output tail; fix on the branch, request again), `merged_ci_red`
  (already on the target, never reverted automatically; the manager decides), `deploy_failed`, `cancelled`.
- **Steps** of a request: fetch, branch check, merge evaluation floor (sensitive files, conflicts), fresh worktree from `<remote>/<target>`, `git merge --no-ff`
  (convention files resolved by the repo's rule), the repo's test command, compare-and-swap push (target moved: re-merge, at most 3 times), CI on that
  commit, deploy (approved request, agent `integration:<id>`, through the deploy registry; `integration-deploys.js`).
- **Convention files are restamped, never copied.** A convention file (default `VERSION.txt`) that the branch changed is resolved by the repo's rule
  (`conventionResolver`: `take-target` keeps the target's side, `max-plus-one` takes the higher number) and then carries a **fresh build number**: one
  above every number either side used (the target's and the branch's). A merge must never reuse a build number: the deployed version has to move on
  (`take-target` used to copy the target's number into the merge, so two merges on 2026-10-23, virtualpytest, deployed as their parent's build and
  had to be restamped by hand). The build number is the last number of the file's build line (the `current:` / `version:` marker line, else the first
  bare version line); a convention file without one (a lockfile, a changelog) keeps the target's version as it is. The rest of the file (the label, the
  repo's own history line) stays the target's: the repo's own stamp tool owns that.
- **Telling the session** (`integration-notify.js`, `notify(request, event)`): on a final state a feed notice (`kind: integration`) and a manager event;
  a codebox session that is stopped (done, no draft, no menu) also gets one line through the guarded send (`by: 'integration'`):
  `Integration <id>: merged <branch> into <target> at <sha12>[, deployed <version> to <env>].` or
  `Integration <id> returned: <reason>. Fix it on your branch and run integrate request again.` plus the first lines of the failing output.
  A `mac:` session gets the feed notice and the manager event only (the Mac hook channel answers stops).
- **Routine notices stay out of the owner's feed (owner 2026-10-23).** The push feed keeps 50 items and every integration event took one, so ~40
  events in 3 h buried the one alert that mattered. A **merged** or **deployed** request therefore takes **no feed slot**: it waits for the periodic
  digest (one `ghosty-digest` entry, tag `ghosty-digest`). `returned`, `merged_ci_red`, `deploy_failed` and `cancelled` stay individual feed entries
  (they need the owner). `manager-events.jsonl` is unchanged: the manager still wakes on every one of them (`integration:<id>:<state>`).
  Switch: `manager.json` `integrationDigest` (default **on**; `false` restores one feed entry per event). The Integration view (`/?integration=1`)
  stays the full history of every request.
- **Own-job wake**: `STATUS: waiting: integration <id>` is the session's own job (`job-refs.js`, never a needs-you stop); `own-jobs.js` reads the request
  from the lane and types the same text when it reaches a final state.
- **View**: More menu "Integration" (`/?integration=1`, `public/integration-view.js`): per repo the queue (position, branch, session, requested deploy), the
  running request with its step and live output tail, recent results; a queued request is cancelled with a second tap.
