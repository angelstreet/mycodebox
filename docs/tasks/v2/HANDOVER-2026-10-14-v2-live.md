# HANDOVER — mycodebox V2 merged and live (2026-10-14)

**One line:** V2 (task engine, goal loop, leases, routing, adapters, integration agent, scoring) is merged to `main`
(PR #1, merge `6eaf0d4`) and enabled on codebox as a pilot. The dashboard, sessions and manager work as before.

## Start here (fresh session)
1. `AGENTS.md`, then `docs/README.md` (index), `docs/MAP.md`, `docs/REFERENCE.md`.
2. This file, then `docs/tasks/v2/OWNER_DECISIONS.md` (owner rules for V2, rounds 1–4) and `V2_PROGRESS.md`.
3. V2 design and results: `docs/v2/ARCHITECTURE.md`, `docs/v2/SCORING.md` (benchmarks, model recommendation).
4. Skill `codebox-sessions` (user-level skill on codebox and on the owner's Mac): how to start tmux agent sessions
   with a model and a first prompt or handover, and how to submit a V2 task.

## Live state
| Item | State |
|---|---|
| Live checkout | `main` = merge `6eaf0d4` + the owner's QF quick fixes (uncommitted since 2026-10-11, now a commit on top) |
| Service | restarted 2026-10-14 11:40 UTC via `scripts/safe-restart.sh`; health 200 |
| V2 env (`.env`; previous file backed up outside the repo) | `GHOSTY_V2=1`, `GHOSTY_V2_WORK_ROOT`, `GHOSTY_V2_REPOS` = the `mycodebox-v2` pilot clone only, `GHOSTY_V2_PATH_DIRS`, `MCODE_NODE_DIR`, `LANGFUSE_PUBLIC_URL`; no `GHOSTY_V2_PUSH_REMOTE` (V2 never pushes) |
| Android app links | `$GHOSTY_STATE_DIR/assetlinks.json` (verbatim previous file) |
| V2 log at start | `[v2] controller lease held; recovered the store (0 open task(s))`, all runtimes available |
| Routing defaults | ladder MiniMax M3.1-Flash, M3, Haiku, Sonnet, Opus; light-model leash 120 s / 40 steps / effort low / 2 stalls |

Roll back V2: set `GHOSTY_V2=0` in `.env`, then `scripts/safe-restart.sh`.

## Open
0. Owner-interaction review of 2026-10-14 (what to automate next, measured waits): [HARNESS-REVIEW-2026-10-14](../../v2/reviews/HARNESS-REVIEW-2026-10-14.md); rounds 8 and 9 act on it.
1. **Live smoke task failed (defect, fix in progress):** a docs task in the pilot repo ended `waiting/no_progress`. The
   developer made the edit, but the project check (full `npm test`, about 1.8k tests) exceeded the evidence time limit
   (`unknown_exit`), and the second run, which correctly changed nothing, counted as a stall. Fix: docs-class checks
   scoped to docs, an adequate check timeout, and a no-change run after a committed head re-evaluates instead of stalling.
2. Add more repos to `GHOSTY_V2_REPOS` (each needs `.ai/project.json`) once the pilot is green.
3. `usage/prices.json` PLACEHOLDER rows (MiniMax-M3, gpt-6-*) need real prices; MiniMax is a flat subscription.
4. Live unit still sets `HOST=0.0.0.0` (warning at start); consider loopback plus Tailscale Serve.
5. Older worktrees and clones on codebox still carry the pre-rewrite git history (history rewritten 2026-10-11 to drop
   tailnet identifiers): rebase onto the new `origin/main` before pushing from them.
6. MiniMax TUI sessions: `permissionMode: bypassPermissions` in `~/.minimax/config.yaml` if prompts must be off.
