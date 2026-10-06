# Repository map

[Documentation index](README.md) · [Agent contract](CONTRACT.md)

## Runtime and data flow

Node.js 20+ runs ES modules directly. `ws` is the only npm runtime dependency; `public/` is served without a build step.
Run as the Unix user who owns the tmux sessions. A different user or tmux socket sees a different session list.

```text
phone/laptop on Tailscale
  -> private HTTPS endpoint -> server.js HTTP + WebSocket handlers
                                 -> tmux capture-pane -> status / reply -> browser
                                 -> validated send -> tmux send-keys
                                 -> stall + manager -> log / proposed reply / guarded action
Claude reporter -> loopback + token -> reporter.js -> structured turn facts
usage transcripts -> usage/ingest.js -> ledger + summary -> usage-view.js
```

The recommended endpoint is Tailscale Serve forwarding to loopback. Native TLS is an alternative; see [INSTALL](INSTALL.md).
Origin checks protect browser requests but are not user authentication. Any allowed client can control sessions.

## Code ownership map

| Concern | Entry points | Tests |
|---|---|---|
| HTTP routes, WebSockets, tmux, static files | `server.js`; route inventory at its top, handlers below | `test/send-guard.test.js`, `test/state.test.js` |
| Browser views, reader, input, icons | `public/app.js`, `public/index.html`, `public/style.css`, `public/icons.js` | `test/buttons.test.js`, `test/ask-popup.test.js` |
| PWA cache and push | `public/sw.js`, `public/sw-update.js`, `push.js` | `test/push.test.js`, `test/push-tiers.test.js` |
| Stop classification and safe automation | `stall.js`, `manager.js`, `triage.js`, `router.js`, `jev-breaker.js` | `test/stall.test.js`, `test/auto.test.js`, `test/manager.test.js` |
| Reporter intake and local alerts | `reporter.js`, `api-extras.js`, `claude-plugin/ghosty-reporter/` | `test/reporter.test.js`, `test/manager-fixes.test.js`; plugin tests separate |
| Session priority, layout, parking | `session-meta.js`, `layout.js`, `parking.js`, `public/policy.js` | `test/layout.test.js`, `test/parking.test.js`, `test/policy.test.js` |
| Usage, quota, health | `usage/`, `usage-view.js`, `quota.js`, `health.js`, `turn-meter.js` | `test/usage.test.js`, `test/quota-live.test.js`, `test/turn-meter.test.js` |
| Optional platform operations | `deploy-runner.js`, `leases.js`, `lease-watch.js`, `handoffs.js`, `vpt-locks.js` | `test/deploy-runner.test.js`, `test/lease-watch.test.js`, `test/handoffs.test.js` |
| Operations and reports | `scripts/`, `systemd/` | `test/daily-checks.test.js`, `test/scorecard.test.js` |

Find a route with `rg -n '/api/<name>' server.js api-extras.js`; follow imported helpers and matching `test/` files.
Do not import `server.js` into a unit test: importing it starts listeners and background polling.

## Persistent data and boundaries

| Location | Contents | Handling |
|---|---|---|
| `$GHOSTY_STATE_DIR` (default `~/.local/state/ghosty`) | Manager switches, `layout.json`, session metadata, budgets, logs, reporter token, push keys, deploy records and usage summaries | Private; back up securely; use a fresh temp directory for tests |
| `~/.ghosty/uploads/` | Attached images | Private; outside GHOSTY_STATE_DIR; include separately in backup/removal decisions |
| `.env` or a private service environment file | Local settings and optional credentials | Not automatically loaded by Node; mode 0600; never commit |
| `certs/key.pem`, `certs/cert.pem` | Optional native TLS files | Ignored exact paths; other filenames are not automatically ignored |
| Agent CLI home directories | Login state, transcripts, reporter settings | Not owned by this repository; never delete on uninstall |
| Browser storage | Device preferences and cached app shell | Separate from the server's shared layout |

Optional Jev, Langfuse, ntfy and platform integrations cross process/network boundaries. See the feature's reference before enabling it; the core dashboard does not require them.
