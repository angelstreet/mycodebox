# Use mycodebox

[Documentation index](README.md) · [Installation and configuration](INSTALL.md)

## First session

Start an agent in tmux as the same Unix user as the dashboard service. For example, from a terminal in your project:

```bash
tmux new-session -s demo
# Inside tmux, run your installed agent CLI, or use the shell.
# Detach without stopping it: Ctrl-b, then d.
```

Open the URL configured in INSTALL from a device connected to your tailnet. Sessions appear after the next poll (normally about a second).
The new-session button can also launch an installed agent; configure `AGENT_CMD_*` first as described in INSTALL.

## Starting sessions from a shell

`scripts/cbsession` starts a tmux agent session (Claude with Remote Control, Codex, MiniMax, OpenCode) with a handover or
prompt. Keep `~/.local/bin/cbsession` as a symlink to it (`ln -sf <checkout>/scripts/cbsession ~/.local/bin/cbsession`);
see [docs/skills/codebox-sessions.md](skills/codebox-sessions.md). Past sessions: `GET /api/history` ([REFERENCE](REFERENCE.md)).

## Read and reply

1. Select a session on the board. Check its name and working directory before sending.
2. Use reader mode for the last answer, or terminal mode for the pane output. In reader mode a picture an agent sent or named shows inline (click: full size in a new tab) and an HTML mockup, PDF or video gets an "open ↗" link, served by the dashboard so it opens on any device on the tailnet. In terminal mode (>_) the same paths are links: tap one to open the file in a new tab; a relative path such as `out/ep01.mp4` is found in the session's folder. A text file an agent names (`docs/X.md`, `server.js:120`) is a link in both modes: it opens in a panel on the right (full screen on a phone) with copy content, copy path, full screen and new-tab buttons; Esc or back closes it. Messages the AI side typed (manager, checks, the integration lane, Claude Code's context summary) are gray with their sender, not blue like yours; a long one starts folded to its first line: click to open. A web address (`https://…`) is a link in both modes and opens in a new tab; the person button next to ⤒ / ⤓ jumps to your last request. Status is inferred from the screen unless a reporter supplies events; it can be wrong.
   With "Smooth scroll" enabled in the More menu or text popover, scrolling a fullscreen (Claude Code) terminal up shows the conversation and scrolls it locally; the bottom returns to the live screen. It is off by default, so terminal scrolling stays in the terminal ([why](SCROLL-DESIGN.md)).
3. Type a reply or choose a quick key. Sending types into the real tmux session. Check the selected target, especially in grid or multi-target mode.
4. Use filters for project, agent and state. P0/P1/P2 set priority; shared ordering and pins persist on the server, while some display preferences are per device.
   On phones, the default Tasks filter applies while there are visible sessions with a `TASK-` or `TASK_` prefix. If your filters leave the dashboard or Sessions drawer empty, tap **Clear filters** there.

Pause sends Escape once and holds automatic replies. Resume clears the hold and sends `continue`; neither is just a visual toggle.
Killing a session ends its tmux process. Parking is for eligible Claude sessions and is subject to idle, lease and running-job checks.

## Suggestions: yes or no before done

A session that lists an improvement suggestion is not done until you answer it. It shows as **needs you** (red), and no "is done" notification
goes out. Open it, read the numbered list and reply in the send box (or type in the session): `yes 1 3, no 2`, `do 1, no to the rest`,
`no all`, or just the numbers you want (`1` = yes to 1, no to the rest). Each item is recorded; the ones you leave out stay open. Numbers
match the session's latest list or the dashboard's item numbers; if they could mean either, nothing is recorded and you are asked which.
A bare `ok` is not an answer, and neither is anything the
manager sends (except for a session the manager started: the manager answers those, never shows them to you as "needs you", and its
yes / no is listed in "Decided for you"; what only you may decide arrives as the manager's own question, naming the session). Approved items become the session's next task. Details: [reference](REFERENCE.md#no-done-while-a-suggestion-has-no-yes--no-owner-2026-11-26-suggestionsjs).

## Phone features

The phone dashboard opens one session card at a time. Tap **Sessions** to choose another session, or swipe left or right across the card header to switch. Swipe up or down inside the card to scroll its output.

Use a trusted HTTPS URL for installation, microphone and Web Push. Install from your browser's app menu when supported.
On iOS/iPadOS, use Add to Home Screen and open the installed app before enabling notifications where required by the OS.
Tap the bell to subscribe and use the notification test. The phone must be able to reach the tailnet endpoint when fetching notification details.
Voice requires the optional local transcription dependency; attaching images or text files (.md, .txt, .csv, .json, .yaml, .log) stores them in `~/.ghosty/uploads/` under their own name after a unique prefix.
Browser and OS support varies; accepting a certificate warning is not a reliable secure-context setup.

## Upload problems

An image or file that will not attach: open `/upload-debug.html` on the device that fails (the Mac browser or the phone app). It shows the browser's network facts, uploads a test image or the real file with its timing, and lists what the server and the browsers logged (refused type such as HEIC, too big, the connection dropped, offline). "copy for the agent" puts that log on the clipboard. Slow uploads from a Mac are usually the network path: `tailscale status` on the codebox shows `relay` instead of a direct address for that Mac; pictures over 250 KB are shrunk before sending for that reason.

## The More menu

- **Rules**: AGENTS.md, the STATUS table and the contract, read-only (`GET /api/rules`).
- **Session log**: the selected session's stats, your prompts, its STATUS lines and the manager's events in time order (`GET /api/timeline/<session>`; the prompts and STATUS lines come from a Claude session's own file).
- **Pages**: the pages, mockups and reports agents published with `page publish` (`/p/`), newest first; each opens at its own `/p/<slug>/` link, on a phone too.
- **Usage & cost**: tokens and API-equivalent cost per agent, project, model, day and session; "classic view" opens the compact sheet.
- **Notifications**: turns the phone / browser alert on; the bell shows the feed.
- **Legacy & rarely used**: V2 tasks, Install app, and the older pages a new page replaced.

## Optional panels

The More menu also has **Preview new pages**, which opens a separate tab with sample-data designs for AI manager,
Review stops, Platforms, Jev decisions, Usage & cost, Alerts and Install app. This is a visual preview: its buttons
do not change settings or sessions. Use the existing menu items for the live panels.

Usage/quota may be unavailable until the relevant CLI or tailer is configured. Costs are estimates at API-equivalent prices, not subscription invoices.
The quota button opens a centred dialog: API credit this month per Anthropic org (spent / budget / left; needs an admin or organization-scoped key in `~/.config/anthropic/<org>.admin.key`, budgets in `<state>/quota-budgets.json`), every Claude account with its 5h / week windows and limit mark, then the other plans.
The AI manager panel shows its effective state at the top and places unrated stops in the review queue. Expand
Automatic replies to choose routine cases, AI reviewer to choose Suggest or Auto and any AI reply types, and Deploys
to inspect the runner. AI Auto sends only when the reviewer is configured, automatic replies are on, and an eligible
AI reply type is selected. Suggestions alone do not send anything.
Platforms, leases and deploys require the external platform integration; an empty panel is not an installation failure.
See [REFERENCE](REFERENCE.md) for each feature's settings and API.

## Session history

Open **More (the three dots) > History**. It lists every agent session the server has recorded, newest first, one row per
run (a reused name is a new row). Phone: compact cards. Desktop: a table. **Load more** fetches the next 50.

| Column | Meaning |
| --- | --- |
| session, model | Session name and provider / model (the model seen in the ledger when none was recorded at start). |
| by | Who started it: `dashboard`, `cbsession`, `v2`, `manager` or `unknown`. |
| start, end | Local time. `running` while the session is still alive. |
| elapsed | End (or now) minus start. |
| active | Sum of the gaps between consecutive turns, each gap capped at 5 minutes, so idle waiting does not count. `—` when no turn was recorded. |
| turns, tokens | Turns found in the usage ledger for this run; input / output / cache tokens. `—` when none. |
| cost | API-equivalent USD, not an invoice. `subscription` for flat-rate providers (MiniMax); `unknown` when any turn could not be priced. Never shown as $0. |
| prompt / handover | The path, or the short sanitized text, recorded at start. It is not a link. |

Filters: provider, model, started by, running or ended, and a start-date range (from / to, your local days). Tap a row:
a running session that has a card on the dashboard opens that card; any other row opens a detail sheet with all fields and
the usage per day.

## V2 task board (opt-in)

The **V2 tasks** item in the More menu is for the V2 task engine and works only when the server was started with
`GHOSTY_V2=1`; otherwise it says the engine is off. Nothing else about the board changes.

- **List.** One row per task with a state badge, the goal, the next action and when it last changed. A task is shown as
  `done (accepted)` only when it was accepted with passing checks and an independent review. `waiting`, `needs owner`
  and `unknown` are separate badges: `unknown` means the log could not be read or an external effect is unconfirmed.
- **Detail.** Definition of done, each acceptance check with its latest evidence and commit SHA (evidence for an older
  SHA is labelled and does not count), reviewer verdicts, decisions with their rationale, usage (a missing figure reads
  `unknown`, never 0), resources and effects, and the state history.
- **New task.** Goal, optional repository path, optional acceptance command. It goes through the same intake as the API.
  The goal loop picks it up at once: it runs in a worktree under `GHOSTY_V2_WORK_ROOT`, only in repositories listed in
  `GHOSTY_V2_REPOS`, and stops at `accepted`, `waiting` or `needs owner` ([enable V2](INSTALL.md#optional-v2-task-engine-opt-in-off-by-default)).
- **Approve or deny.** Shown only while a task waits on a request. The buttons answer that exact request (its id and the
  head SHA are sent with the click); the answer is recorded as the owner. They never approve anything else.
- **Cancel.** Stops a task that is not finished; it cannot be resumed.

The view polls every few seconds while it is open and does nothing otherwise. Routes and fields: [REFERENCE](REFERENCE.md#v2-task-api-opt-in).

## Troubleshooting

| Symptom | Check |
|---|---|
| Phone cannot connect | Both devices connected to Tailscale; correct URL; grants/ACLs; `tailscale serve status`; service health. A loopback listener is intentionally inaccessible by direct tailnet IP. |
| No sessions | `tmux list-sessions` as the service user; same tmux socket/environment; active agent session |
| Page loads but cards freeze or send fails | WebSocket connection and browser console; proxy Host/Origin preservation; do not disable Origin checks |
| PWA, mic or bell unavailable | Trusted HTTPS with matching DNS name, browser permissions/support, installed-app requirements |
| Settings in `.env` ignored | Node does not load it automatically; check the service's EnvironmentFile path and use the guarded restart procedure |
| Reporter events missing | New Claude session loaded the plugin; loopback URL/port correct; same state directory or token-file override; token readable by that user |
| Usage/quota missing | Optional tailer/CLI authentication and feature settings; unknown or stale data is not zero usage |
| API credit row says "no admin key" or "key refused" | Put an Admin API key (Console > Settings > Admin keys, `sk-ant-admin01-...`; only an org admin can create one) for that org in `~/.config/anthropic/<org>.admin.key`, chmod 600, then press **refresh** in the quota popup (else it refreshes within 15 min). Other key types fail: a normal `sk-ant-api03` or service `sk-ant-svc` key gets 401 "requires an Admin API key"; an org-scoped `sk-ant-usr` key without the usage/cost read permission gets 403 "Missing permissions" |
| Old UI after update | Reload; close/reopen installed app; inspect service-worker update before clearing browser storage |

Use local logs for diagnosis, but redact session text, keys and infrastructure details before sharing an issue.
