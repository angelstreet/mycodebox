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

## Read and reply

1. Select a session on the board. Check its name and working directory before sending.
2. Use reader mode for the last answer, or terminal mode for the pane output. Status is inferred from the screen unless a reporter supplies events; it can be wrong.
3. Type a reply or choose a quick key. Sending types into the real tmux session. Check the selected target, especially in grid or multi-target mode.
4. Use filters for project, agent and state. P0/P1/P2 set priority; shared ordering and pins persist on the server, while some display preferences are per device.

Pause sends Escape once and holds automatic replies. Resume clears the hold and sends `continue`; neither is just a visual toggle.
Killing a session ends its tmux process. Parking is for eligible Claude sessions and is subject to idle, lease and running-job checks.

## Phone features

On the grid, swipe inside the focused card to scroll its output. Swipe on an unfocused card to scroll the board; tap it first to focus it.

Use a trusted HTTPS URL for installation, microphone and Web Push. Install from your browser's app menu when supported.
On iOS/iPadOS, use Add to Home Screen and open the installed app before enabling notifications where required by the OS.
Tap the bell to subscribe and use the notification test. The phone must be able to reach the tailnet endpoint when fetching notification details.
Voice requires the optional local transcription dependency; attaching images stores them in `~/.ghosty/uploads/`.
Browser and OS support varies; accepting a certificate warning is not a reliable secure-context setup.

## Optional panels

The More menu also has **Preview new pages**, which opens a separate tab with sample-data designs for AI manager,
Review stops, Platforms, Jev decisions, Usage & cost, Alerts and Install app. This is a visual preview: its buttons
do not change settings or sessions. Use the existing menu items for the live panels.

Usage/quota may be unavailable until the relevant CLI or tailer is configured. Costs are estimates at API-equivalent prices, not subscription invoices.
The AI manager panel shows its effective state at the top and places unrated stops in the review queue. Expand
Automatic replies to choose routine cases, AI reviewer to choose Suggest or Auto and any AI reply types, and Deploys
to inspect the runner. AI Auto sends only when the reviewer is configured, automatic replies are on, and an eligible
AI reply type is selected. Suggestions alone do not send anything.
Platforms, leases and deploys require the external platform integration; an empty panel is not an installation failure.
See [REFERENCE](REFERENCE.md) for each feature's settings and API.

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
| Old UI after update | Reload; close/reopen installed app; inspect service-worker update before clearing browser storage |

Use local logs for diagnosis, but redact session text, keys and infrastructure details before sharing an issue.
