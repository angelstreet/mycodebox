# V2 baseline inventory

Source revision: `b9a83e14b7167a2efb35fa6c4367a692fadb94d1`. These are source observations, not deployed configuration. The original checkout has unrelated server edits and untracked files; this baseline excludes them and preserves them in place.

| Area | Existing source evidence | V2 work / safety constraint |
|---|---|---|
| Network and startup | `server.js:104`, `1816`, `1861` | All-interface source default; server import starts listeners and optional polling. Temporary state alone does not isolate a server. |
| Create/resume | `server.js:1026`, `1058`, `1075`, `1154`; `parking.js:112` | Permission-bypass command defaults also feed resume. No general capability adapter. |
| Manager launch | `scripts/manager-fresh.sh:8` | Separate permission-bypass launch path; UI changes alone are insufficient. |
| Parking | `parking.js:166`, `188` | Injected IO; idle/attachment/prompt/child/lease checks; unknown leases refuse parking. Claude/MiniMax-specific rather than task/worktree ownership. |
| Stop/manager | `stall.js:370`; `manager.js:65`, `342`, `865` | Forbidden-topic and draft checks; optional auto-send off by default. Preserve hard floors during routing changes. |
| Router | `router.js:250`, `257`, `304`; `router-shadow.js:53` | Existing advice and shadow decisions, not a task execution engine. |
| Reporter | `reporter.js:24`, `41`; `server.js:1337` | Loopback/token intake and in-memory observations; no durable V2 event protocol. |
| Usage/quota | `usage/ingest.js:26`, `63`, `92`, `111`; `quota.js:115`, `126`, `187` | Unknown pricing stays null. Real transcript and quota adapters require injection in tests. |
| Leases | `leases.js:12`; `lease-watch.js:56`, `90` | Cached external observations; watcher defaults live. No proven in-repo atomic/fenced mutation authority. |
| Handoffs | `handoffs.js:55`, `64`, `131`; `vpt-locks.js:1` | Atomic local handoff save and observational remote locks do not establish integration fencing. |
| Deploy | `deploy-runner.js:149`, `185`, `327`, `364` | Default disabled; enabled legacy runner autoapproves awaiting-approval requests. V2 must not inherit that as authorization. |
| Restart | `scripts/safe-restart.sh:11`, `34` | Unreachable/malformed API currently treated as idle; requires fail-closed regression tests with fake commands. |
| Browser | `public/state.js`; `test/state.test.js` | Session status display exists; task graph, verification evidence and task approvals are proposed. |

No `orchestration/` engine exists at the baseline. Missing: durable task contract/DAG/events, capability registry, normalized runtime execution, exclusive worktree ownership, independent acceptance, budget authorization ledger, integration/CI gates, incident controller and universal goal loop.

## Existing state and migration boundaries

Manager switches, layout, reporter token, handoffs, deploy records and usage summaries live outside the repo. Preserve existing state readers and schemas; do not assume upgrades reset enabled switches. V2 should add separately versioned state with explicit migration and recovery tests. Uploads and agent homes are separate private stores. Neither was read for this inventory.

## Baseline checks and available execution

Node 24.21.0 / npm 11.19.0. Git worktrees work. Local executable discovery found Claude, Codex and MiniMax launchers, but executable presence does not prove credentials, capabilities or provider availability. OpenCode was not found on PATH. Reporter plugin's local mock test runner passed; no real-provider smoke was attempted.

The main suite uses pure helpers, injected mocks and temporary state. Baseline process environment was restricted to PATH, LANG and a new GHOSTY_STATE_DIR to exclude inherited provider credentials. No dashboard was started. Independent source review found no server import and confirmed fake transcript/quota/deploy adapters. Some manager tests retain inherited provider settings, making environment scrubbing necessary. MiniMax manager tests make real loopback HTTP reads at port 1; therefore the suite is not fully hermetic. No network/process trace proving absence of live reads was captured.

Baseline: 858 tests, 839 passed, 19 failed; all failures are decision-share date fixtures. Router dry run exits 0 but wake decisions match only 6/10 expectations. Reporter plugin: 25 passed, 0 failed. See `V2_VERIFICATION.md` for reproducible evidence.

## Next packages and gates

1. Repair stale test-clock fixtures without changing production behavior, independently verify.
2. Loopback and normal-permission defaults; audit all launch/resume/manager paths.
3. Strict fail-closed restart response handling with fake curl/systemctl; preserve live service untouched.
4. Establish task/store/event and lease contracts before active orchestration.

No browser, real-provider, remote-CI, installation, migration or production E2E pass is claimed. No V2 T/GL acceptance gate has run yet.
