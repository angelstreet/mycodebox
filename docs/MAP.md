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
GHOSTY_V2=1: /api/v2/* -> orchestration/v2-runtime.js -> http.js + intake + task store ($GHOSTY_STATE_DIR/v2)
             + goal loop (controller lease, recover, scheduler) -> worktrees under GHOSTY_V2_WORK_ROOT
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
| Separate page mockups | `public/page-preview.html`, `public/page-preview.css`, `public/page-preview.js` | Sample data only; linked from the More menu |
| Reporter intake and local alerts | `reporter.js`, `api-extras.js`, `claude-plugin/ghosty-reporter/` | `test/reporter.test.js`, `test/manager-fixes.test.js`; plugin tests separate |
| Session priority, layout, parking | `session-meta.js`, `layout.js`, `parking.js`, `public/policy.js` | `test/layout.test.js`, `test/parking.test.js`, `test/policy.test.js` |
| Session history (start/end log, `GET /api/history`) | `session-history.js`, `history-view.js`, `scripts/cbsession`; UI: `public/history-view.js` (More menu > History, `openSessionHistory` in `public/app.js`) | `test/session-history.test.js`, `test/history-view.test.js`, `test/history-ui.test.js`, `test/cbsession.test.js`, `test/v2-server-wiring.test.js` (history) |
| Voice mode (hands-free queue, spoken answer matching, spoken digest, notification buttons) | `voice.js` (`/api/voice/*`), `push.js` (`voiceId`, `actions`); UI: `public/voice-view.js` (More menu > Voice mode, `/?voice=1`), `public/sw.js` (notification actions) | `test/voice.test.js`, `test/voice-view.test.js`, `test/voice-sw.test.js` |
| Usage, quota, health | `usage/`, `usage-view.js`, `quota.js`, `health.js`, `turn-meter.js` | `test/usage.test.js`, `test/quota-live.test.js`, `test/turn-meter.test.js` |
| Optional platform operations | `deploy-runner.js`, `leases.js`, `lease-watch.js`, `handoffs.js`, `vpt-locks.js`, `ci-watch.js` | `test/deploy-runner.test.js`, `test/lease-watch.test.js`, `test/handoffs.test.js`, `test/ci-watch.test.js` |
| Central lease service (one writer of leases and the deploy queue; `/api/lease/v1`; design in `docs/v2/LEASES-CENTRAL.md`) | `lease-service.js`, `lease-routes.js`, `scripts/lease-token.js`, `scripts/lease-import.js`, `scripts/lease-export.js` | `test/lease-service.test.js`, `test/lease-routes.test.js` |
| V2 task contract, store, policy, intake | `orchestration/task-contract.js`, `store.js`, `policy.js`, `intake.js`, `events.js` | `test/v2-task-core*.test.js`, `test/v2-store*.test.js`, `test/v2-policy.test.js` |
| V2 goal loop and verifier | `orchestration/goal-loop.js`, `verifier.js`, `roles.js` | `test/v2-goal-loop.test.js` |
| V2 router, registry, budget (shadow only) | `orchestration/router.js`, `model-registry.js`, `models.json`, `budget.js` | `test/v2-routing*.test.js`, `test/v2-budget.test.js` |
| V2 runtime adapters, worktrees | `orchestration/adapters/`, `worktrees.js` | `test/v2-adapters*.test.js`, `test/v2-worktrees*.test.js` |
| V2 leases, incidents, system operations | `orchestration/lease-authority.js`, `incidents.js`, `telemetry.js`, `system-ops.js` | `test/v2-lease-authority*.test.js`, `test/v2-system-ops*.test.js` |
| V2 HTTP routes and Tasks view | `orchestration/http.js`, `public/tasks-view.js` | `test/v2-http.test.js`, `test/v2-tasks-view.test.js`; browser: `scripts/v2-ui-check.js` (dev only) |
| V2 server wiring (engine assembly, scheduler, server integration hook) | `orchestration/v2-runtime.js` (imported by `server.js` only with `GHOSTY_V2=1`), `orchestration/v2-integrate.js` | `test/v2-server-wiring.test.js` (boots the real `server.js` as a child) |
| V2 scoring report, scorecard, tool score, proposals | `scripts/v2-score.js`, `orchestration/scorecard.js`, `orchestration/proposals.js`, [SCORING](v2/SCORING.md) | `test/v2-score.test.js`, `test/v2-scorecard.test.js` |
| V2 integration agent and delivery bridge | `orchestration/integration-controller.js`, `integration-queue.js`, `ci-gates.js`, `delivery.js` | `test/v2-integration*.test.js`, `test/v2-delivery*.test.js` |
| V2 acceptance and live smoke (dev only) | `scripts/v2-acceptance.js`, `scripts/v2-live-smoke.js`, [ACCEPTANCE](v2/ACCEPTANCE.md) | `test/v2-acceptance-*.test.js`, shared fixture `test/fixtures/v2-world.js` |
| Documentation links | `README.md`, `docs/` | `test/v2-docs-links.test.js` |
| Operations and reports | `scripts/`, `systemd/` | `test/daily-checks.test.js`, `test/scorecard.test.js` |

Find a route with `rg -n '/api/<name>' server.js api-extras.js`; follow imported helpers and matching `test/` files.
Do not import `server.js` into a unit test: importing it starts listeners and background polling.

## Persistent data and boundaries

| Location | Contents | Handling |
|---|---|---|
| `$GHOSTY_STATE_DIR/v2` | V2 task store: `tasks/<id>/events.jsonl` (source of truth), derived `snapshot.json`, `index.json`; `leases/` (controller and worktree leases), `controller.*.intent.json`, `incidents/` | Created only when `GHOSTY_V2=1`; separate from V1 state; removing it reverts V2 (see [migration](v2/MIGRATION.md)) |
| `$GHOSTY_V2_WORK_ROOT` | V2 task worktrees (`wt/<task_id>`), reviewer checkouts, check temp files and artifacts | Outside the checkout, the state dir and every allowlisted repo; disposable once tasks are closed |
| `$GHOSTY_STATE_DIR` (default `~/.local/state/ghosty`) | Manager switches, `layout.json`, session metadata, budgets, logs, reporter token, push keys, deploy records and usage summaries | Private; back up securely; use a fresh temp directory for tests |
| `~/.ghosty/uploads/` | Attached images | Private; outside GHOSTY_STATE_DIR; include separately in backup/removal decisions |
| `.env` or a private service environment file | Local settings and optional credentials | Not automatically loaded by Node; mode 0600; never commit |
| `certs/key.pem`, `certs/cert.pem` | Optional native TLS files | Ignored exact paths; other filenames are not automatically ignored |
| Agent CLI home directories | Login state, transcripts, reporter settings | Not owned by this repository; never delete on uninstall |
| Browser storage | Device preferences and cached app shell | Separate from the server's shared layout |

Optional Jev, Langfuse, ntfy and platform integrations cross process/network boundaries. See the feature's reference before enabling it; the core dashboard does not require them.
