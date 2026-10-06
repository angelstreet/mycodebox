# Developer handover

Start with [AGENTS.md](AGENTS.md), the [documentation index](docs/README.md), and the [agent contract](docs/CONTRACT.md). The [repository map](docs/MAP.md) locates implementation and tests; [INSTALL](docs/INSTALL.md) is the sole installation/update runbook.

This is a portable development handover, not a record of a particular machine's live settings. Deployment identifiers, credentials and captured session output belong outside this public repository.

## Resume work

1. Read the user's task and `git status --short`; preserve other work. Use a separate worktree when appropriate.
2. Read the relevant source, tests and reference section. Task numbers in comments refer to external project history, not required local documents.
3. Test modules with fresh temporary state. Importing `server.js` starts the application; do not use it as a passive inspection tool.
4. Follow the contract for tests, staged-diff inspection and delivery. A handover does not authorize a merge, push or live restart.

## Implementation notes

- `stall.js` classifies stops; `manager.js` records outcomes, deduplicates repeated stops and guards scheduled sends. Repaints are not progress. Preserve forbidden-topic, draft, pause and cancellation checks.
- `reporter.js` supplies structured Claude turn facts, with pane heuristics as fallback. Its token and loopback checks also protect the local alert API. Plugin tests are separate from `npm test`; see [reporter reference](docs/REFERENCE.md#session-reporter-task-44-phase-8).
- `turn-meter.js` derives elapsed time and usage. Unknown values stay unknown; agents should not invent token/time counts.
- `deploy-runner.js` can recover detached children using persisted process/exit files. Preserve `KillMode=process` and those files. Still use the guarded restart procedure outside deploys.
- `usage/` includes ingestion, evaluation and experiments; external Langfuse/Jev behavior depends on the configured server versions. See [evaluation](docs/REFERENCE.md#langfuse-evaluation-task-44-phase-12).
- Check the current cache version in `public/sw.js` when changing the UI; historical version numbers are not useful configuration instructions.

## Known limitations to check before operations

- The source listener defaults to all interfaces. INSTALL explicitly configures loopback + private Serve.
- Default Claude/Codex UI launch commands bypass permissions; INSTALL overrides them. Parking/resume and scripts have their own launch paths to review.
- The safe-restart script treats an unreachable API as no active deploy. Verify API reachability and deployment state before invoking it.
- Status derived from terminal text is heuristic and can misclassify quoted prompts or unfamiliar CLI versions.
- Some platform adapters retain deployment-specific defaults. A generic install does not guarantee those integrations work; lease binding can act when its registry is reachable.
- UI feature availability depends on browser support, trusted HTTPS and permission state. Self-signed-warning acceptance is not a reliable PWA installation procedure.

Do not translate these documentation fixes into claims that runtime defaults were changed or that an existing installation is secured. Inspect and validate the actual deployment separately when asked.
