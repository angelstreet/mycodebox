# Phase 1: launch security defaults

Status: implementation pending independent review. Scope: loopback listener, normal Claude/Codex commands, create/resume trust behavior, manager restart command, redacted override diagnostics and migration docs. Separate workers own safe-restart and baseline date fixtures. No live service, tmux, state, push, merge or deployment actions.

Acceptance: default commands contain no permission bypass; saved resume args cannot restore bypass flags; explicit command overrides remain unchanged and known unsafe flags produce diagnostics containing only setting names; default listener is loopback; no implicit folder trust writes; manager restart uses the same configured Claude command. Run module/static tests without importing server, and full npm test with sanitized environment and temporary state (HOME unset). Independent reviewer repeats checks before integration. Rollback is reverting this patch in an isolated checkout, not changing running services.

Threats: old service overrides can retain unsafe behavior; arbitrary shell wrappers cannot be exhaustively classified. Warnings are advisory and never certify a custom command. Existing sessions and CLI configuration remain owner-controlled. Migration instructions must accompany defaults.

## Implementation and audit

- `launch-config.js` supplies loopback and normal Claude/Codex defaults; server create and resume share this configuration. Explicit shell command overrides remain verbatim. Diagnostics contain setting names only. Known bypass detection is advisory, not a shell parser or CLI policy audit.
- Server create/resume no longer call the folder trust writer. Existing external CLI trust/configuration is not edited.
- `parking.js` reconstructs resume flags from model/remote-control metadata, never copies old permission flags, rejects malformed conversation IDs and validates before creating tmux. Server resume revalidates canonical cwd under HOME through the same directory helper as create. Symlink/traversal fixtures and malicious saved IDs are covered.
- `scripts/manager-fresh.sh` uses the common Claude command helper. Existing manager wake/continue paths send to an existing session; they do not launch another CLI. MiniMax shadow manager uses its configured executable without a new bypass; its stale permission-table claim was corrected. Existing manager forbidden-topic, permission escalation and automation defaults are unchanged.
- Migration docs cover existing overrides, PATH, trust prompts and existing sessions. Coordinated safe-restart documentation describes the separate Phase 1 restart patch and must be integrated with it: this security branch does not implement or claim standalone verification of that script change.

## Evidence

Base: `b9a83e1`; verified clock fixture repair cherry-picked as `fe4dfa4`. Node v24.21.0. Focused launch/parking tests: 27/27 passed before interruption. The first full run before baseline repair had the known 19 clock failures plus two MiniMax harness failures due to missing explicit NODE_BIN with temporary HOME. A later full run after the repair with temporary HOME/state passed 866/866 (18.9 s); that invocation is recorded for accuracy, but subsequent validation leaves HOME unset in the scrubbed test environment.

Final reproducible validation uses `env -i PATH="$PATH" LANG=C.UTF-8 NODE_BIN="$(dirname "$(command -v node)")" GHOSTY_STATE_DIR="$(mktemp -d)" npm test`. No server import, live tmux invocation, service restart, push or deployment was used. The inherited MiniMax tests contact closed loopback port 1; this is a known harness limitation, not a live application call. Shell syntax, server syntax and diff whitespace checks passed. Independent review is still required; this task does not self-approve Phase 1 or claim all T03/T04 integration scenarios complete.

Final scrubbed-environment run: 866 tests passed, 0 failed, 0 skipped, exit 0, duration 19.7 seconds. Verification applies to this patch plus `fe4dfa4`; exact implementation commit is recorded by the coordinator after commit creation.
