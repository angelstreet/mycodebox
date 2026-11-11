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
| Browser views, reader, input, icons | `public/app.js`, `public/index.html`, `public/style.css`, `public/icons.js`, `public/disk-banner.js` (the disk banner's text) | `test/buttons.test.js`, `test/ask-popup.test.js`, `test/disk-banner.test.js` |
| PWA cache and push | `public/sw.js`, `public/sw-update.js`, `push.js` | `test/push.test.js`, `test/push-tiers.test.js`, `test/integration-feed-noise.test.js` |
| Stop classification and safe automation (the escalation floor reads the action: `floorAction`, `readAsk`) | `stall.js`, `ops-ask.js`, `manager.js`, `triage.js`, `router.js`, `jev-breaker.js`, `scripts/floor-replay.mjs` (regression replay, [REFERENCE](REFERENCE.md) "The floor reads the action") | `test/stall.test.js`, `test/auto.test.js`, `test/manager.test.js`, `test/keyword-floor.test.js`, `test/approved-action.test.js` |
| Wakes for stopped sessions: own job ended, parked `blocked` / `waiting` stop whose dependency changed or aged out (`parkedWake`) | `own-jobs.js`, `job-refs.js`, `wait-ids.js` | `test/own-jobs.test.js`, `test/parked-wake.test.js` |
| Separate page mockups | `public/page-preview.html`, `public/page-preview.css`, `public/page-preview.js` | Sample data only; linked from the More menu |
| Reporter intake and local alerts | `reporter.js`, `api-extras.js`, `claude-plugin/ghosty-reporter/` | `test/reporter.test.js`, `test/manager-fixes.test.js`; plugin tests separate |
| Session priority, layout, parking | `session-meta.js`, `layout.js`, `parking.js`, `public/policy.js` | `test/layout.test.js`, `test/parking.test.js`, `test/policy.test.js` |
| Session history (start/end log, `GET /api/history`) | `session-history.js`, `history-view.js`, `scripts/cbsession`; UI: `public/history-view.js` (More menu > History, `openSessionHistory` in `public/app.js`) | `test/session-history.test.js`, `test/history-view.test.js`, `test/history-ui.test.js`, `test/cbsession.test.js`, `test/v2-server-wiring.test.js` (history) |
| Voice mode (hands-free queue, spoken answer matching, spoken digest, notification buttons) | `voice.js` (`/api/voice/*`), `push.js` (`voiceId`, `actions`); UI: `public/voice-view.js` (More menu > Voice mode, `/?voice=1`), `public/sw.js` (notification actions) | `test/voice.test.js`, `test/voice-view.test.js`, `test/voice-sw.test.js` |
| Usage, quota, health | `usage/`, `usage-view.js`, `quota.js`, `health.js`, `turn-meter.js` | `test/usage.test.js`, `test/quota-live.test.js`, `test/turn-meter.test.js` |
| Claude account rotation | `claude-accounts.js`, `scripts/claude-account` | `test/claude-accounts.test.js` |
| Disk-space safety policy (banner, 409 `disk_low`, top consumers) | `disk-guard.js`, `server.js` (`GET /api/disk`, the start/resume refusals), `orchestration/worktrees.js` (`admission`), `orchestration/goal-loop.js` (the `disk_low` wait) | `test/disk-guard.test.js`, `test/disk-guard-server.test.js` |
| Optional platform operations | `deploy-runner.js`, `catchup-supersede.js`, `scripts/deploy-catchup-audit.js`, `leases.js`, `lease-watch.js`, `handoffs.js`, `vpt-locks.js`, `ci-watch.js`, `rules-watch.js`, `overlap-guard.js`, `shared-checkout-guard.js`, `done-check.js`, `status-honesty.js`, `progress-watch.js`, `scripts/session-guard-hook.js`, `scripts/install-guard-hooks.js` | `test/deploy-runner.test.js`, `test/deploy-catchup-audit.test.js`, `test/lease-watch.test.js`, `test/handoffs.test.js`, `test/ci-watch.test.js`, `test/rules-watch.test.js`, `test/overlap-guard.test.js`, `test/shared-checkout-guard.test.js`, `test/done-check.test.js`, `test/closing-review.test.js`, `test/status-honesty.test.js`, `test/session-guard-hook.test.js`, `test/grant-notice.test.js`, `test/progress-watch.test.js` |
| Manager wake loop (event feed, wait with batch window, event policy, wake summary) | `manager-events.js`, `scripts/manager-wait.sh`, `scripts/manager-event-filter.sh`, `scripts/manager-event-policy.json` + `.js`, `scripts/manager-wake-summary.sh`, `pending-wakes.js` | `test/manager-events.test.js`, `test/manager-wait.test.js`, `test/manager-event-filter.test.js`, `test/manager-event-policy.test.js`, `test/pending-wakes.test.js` |
| Central lease service (one writer of leases and the deploy queue; `/api/lease/v1`; design in `docs/v2/LEASES-CENTRAL.md`) | `lease-service.js`, `lease-routes.js`, `scripts/lease-token.js`, `scripts/lease-import.js`, `scripts/lease-export.js` | `test/lease-service.test.js`, `test/lease-routes.test.js` |
| Lease client and its dashboard-side guards (holder reaper, unused grants, watchdog, client install) | `scripts/vpt-lease`, `lease-holder-reaper.js`, `lease-nudge.js`, `lease-client-sync.js` | `test/vpt-lease-*.test.js`, `test/lease-abandoned-waiter.test.js`, `test/lease-holder-reaper.test.js`, `test/lease-nudge.test.js`, `test/lease-client-sync.test.js` |
| Remote stops (Mac Stop hook intake, `/api/remote/v1`; install in `docs/MAC-HOOK.md`) | `remote-stops.js`, `scripts/mac-stop-hook.sh`, `manager.js` (marked remote hook block) | `test/remote-stops.test.js`, `test/mac-hook.test.js` |
| Manager owner questions (command, server safety net, alert scan) | `scripts/manager-ask.js`, `ask-guard.js`, `scripts/manager-ask-scan.sh`, `owner-asks.js`, `ask-fold.js` (one open ask per session folds alerts) | `test/manager-ask-enforce.test.js`, `test/owner-asks.test.js`, `test/ask-fold.test.js`, `test/system-wait.test.js` |
| Lane release-note merge (target's file + branch's added Unreleased entries) | `release-note-merge.js`, hook in `integration-lane.js` `resolveUnion` | `test/release-note-merge.test.js`, `test/integration-lane.test.js` |
| Worktree cleanup after a lane merge (guards, journal, `worktreeCleanup` switch) | `worktree-cleanup.js`, hook in `integration-lane.js`, wiring in `server.js` | `test/worktree-cleanup.test.js` |
| Pokemon run retention (per Pokemon game: keep in-progress games + the latest played game) | `scripts/pokemon-retention.js`, [POKEMON-RETENTION](POKEMON-RETENTION.md) | dry run writes a plan + sha; `--apply --plan --sha` moves to `.trash-<date>`; `--purge` (own call) after 7 days |
| Daily disk cleanup (merged worktrees, idle caches, lane merge trees, log caps; dry run until the owner's `live` switch) | `scripts/disk-cleanup.js`, `scripts/disk-cleanup-policy.json`, `systemd/ghosty-disk-cleanup.*`, [DISK-CLEANUP](DISK-CLEANUP.md) | reuses `worktree-prune.js`; the disk push in `server.js` names the top 5 of `$HOME` |
| Merged-worktree prune (idle, clean, merged worktrees of virtualpytest + ghosty-sessions) | `scripts/worktree-prune.js`, [REFERENCE](REFERENCE.md) "Worktree prune" | dry run writes a plan + sha; `--apply --plan --sha` runs `git worktree remove` (no `--force`) and logs to `worktree-prune.jsonl` |
| Client scripts served for `integrate self-update` (`GET /api/integration/client-scripts`) | `client-scripts.js`, `integration-routes.js`, `scripts/integrate`, `scripts/found-bug` | `test/client-scripts.test.js` |
| Integration lane notices (owner feed, manager event, session line) | `integration-notify.js` | `test/integration-feed-noise.test.js`, `test/integration-sessions.test.js` |
| Owner round-trip ledger (`owner-roundtrips.jsonl`, `GET /api/manager/roundtrips`) | `roundtrips.js`, `manager.js` (`settleRoundtrip`) | `test/roundtrips.test.js` |
| Session delete guard + caller ledger (`session-deletes.jsonl`), JSON-safe ledger append | `session-delete-guard.js`, `jsonl-append.js`, `scripts/manager-action-append.js`, `server.js` (`killSession`) | `test/session-delete-guard.test.js` |
| V2 task contract, store, policy, intake | `orchestration/task-contract.js`, `store.js`, `policy.js`, `intake.js`, `events.js` | `test/v2-task-core*.test.js`, `test/v2-store*.test.js`, `test/v2-policy.test.js` |
| V2 goal loop and verifier | `orchestration/goal-loop.js`, `verifier.js`, `roles.js` | `test/v2-goal-loop.test.js` |
| V2 router, registry, budget (shadow only) | `orchestration/router.js`, `model-registry.js`, `models.json`, `budget.js` | `test/v2-routing*.test.js`, `test/v2-budget.test.js` |
| V2 runtime adapters, worktrees | `orchestration/adapters/`, `worktrees.js` | `test/v2-adapters*.test.js`, `test/v2-worktrees*.test.js` |
| V2 leases, incidents, system operations | `orchestration/lease-authority.js`, `incidents.js`, `telemetry.js`, `system-ops.js` | `test/v2-lease-authority*.test.js`, `test/v2-system-ops*.test.js` |
| V2 HTTP routes and Tasks view | `orchestration/http.js`, `public/tasks-view.js` | `test/v2-http.test.js`, `test/v2-tasks-view.test.js`; browser: `scripts/v2-ui-check.js` (dev only) |
| V2 server wiring (engine assembly, scheduler, server integration hook) | `orchestration/v2-runtime.js` (imported by `server.js` only with `GHOSTY_V2=1`), `orchestration/v2-integrate.js` | `test/v2-server-wiring.test.js` (boots the real `server.js` as a child) |
| V2 scoring report, scorecard, tool score, proposals | `scripts/v2-score.js`, `scripts/v2-ledger.js`, `orchestration/scorecard.js`, `orchestration/proposals.js`, [SCORING](v2/SCORING.md) | `test/v2-score.test.js`, `test/v2-ledger.test.js`, `test/v2-scorecard.test.js` |
| V2 integration agent and delivery bridge | `orchestration/integration-controller.js`, `integration-queue.js`, `ci-gates.js`, `delivery.js` | `test/v2-integration*.test.js`, `test/v2-delivery*.test.js` |
| V2 acceptance and live smoke (dev only) | `scripts/v2-acceptance.js`, `scripts/v2-live-smoke.js`, [ACCEPTANCE](v2/ACCEPTANCE.md) | `test/v2-acceptance-*.test.js`, shared fixture `test/fixtures/v2-world.js` |
| Nightly RTSP check and replacement | `scripts/agent/rtsp_check.py`, `rtsp_replace.py`, `config/rtsp-pool.json`, `scripts/rtsp-nightly/`, `systemd/rtsp-nightly.*`, [RTSP-NIGHTLY](RTSP-NIGHTLY.md) | `test/rtsp-check.test.js` |
| Documentation links | `README.md`, `docs/` | `test/v2-docs-links.test.js` |
| Operations and reports | `scripts/` (daily checks incl. `harness-health-check.js`), `systemd/` | `test/daily-checks.test.js`, `test/harness-health-check.test.js`, `test/scorecard.test.js` |

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
