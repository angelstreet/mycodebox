# TASK-70 — QuickFix for codebox (parent task for codebox-side fixes)

**Session:** `codebox-quickfix`
**Repo / worktree:** `ghosty-sessions` (= mycodebox) at
`/home/jndoye/ghosty-quickfix-codebox`, branch `codebox-quickfix`. This task
**lives on the codebox project** — the manager UI repo, not vpt-manager.
**State:** planning — no product code written yet
**Raised by:** owner, 2026-10-07 · **Manager:** mm-manager

> **Why this move.** Original draft of the MD was staged in vpt-manager
> because the task also covers vpt-manager upkeep (AGENTS.md, MEMORY.md,
> scripts). Owner correction 2026-10-07: the task belongs on the codebox
> project (= ghosty-sessions) because the work — TTS audio for the manager
> UI, lease-watch chips, NEEDS YOU strip — is ghosty-sessions work. vpt-manager
> pieces are a small tail; cross-repo reads from this worktree are fine.

## Goal

A parent task that captures **codebox-side** fixes — small features and bugs
affecting the manager, the lease registry, the deploy scripts, ghosty's daily
reports, AGENTS.md / MEMORY.md upkeep, runtime-state schema tweaks, and anything
else that runs on the codebox machine itself. This is **not** virtualpytest-
side work (those items go in `TASK-68-quickfix`).

What belongs here (and not in TASK-68):

- **ghosty-sessions / mycodebox** — manager UI (panel, NEEDS YOU strip, lease
  display, alerts), wake script, AI routing inside the manager, the
  `daily-checks` and `health-watch` jobs.
- **vpt-manager** — AGENTS.md / CLAUDE.md / MEMORY.md upkeep, deploy glue,
  internal scripts (`scripts/vm_diag.sh`, `scripts/gen_docs_index.py`,
  etc.), Claude-manager actions log conventions. vpt-manager is a worktree of
  `virtualpytest-internal` (`git-common-dir` = `virtualpytest/.git`), so
  "which repo" really means "which worktree" of one repo.
- **runtime state at `~/.local/state/ghosty/`** — schema for
  `manager-owner-asks.jsonl`, `mm-manager-actions.jsonl`, etc.
- **the lease registry is NOT on the codebox box** — it lives on proxmox at
  `~/agent-leases/` (`leases.json`, `waiters.json`, `deploys.jsonl`,
  `lease-events.jsonl`), driven by `~/bin/vpt-lease`. Read it with
  `ssh proxmox 'cat ~/agent-leases/leases.json'` or via the manager API
  `GET /api/leases`. There is no `~/.local/state/ghosty/leases/` directory;
  a doc claiming one is wrong.

## Parts

| # | Part | Done when | State |
|---|------|-----------|-------|
| 1 | **TTS audio for NEEDS YOU items** (chat-raised 2026-10-07) — every wake event that needs the owner (NEEDS YOU strip, owner-asks chips, and any item with a stall question) gets an audio version the owner can play in the manager. **TTS source**: backend-rendered **piper** (offline, no API key, no vendor quota). **What's read**: the wake brief / stall summary text itself (the truncated `[kind] title — body [jev pick]` body, or the full stall block for `[asks]` events). **Player UX**: each audio chip carries (a) a **play / pause** icon that toggles playback, (b) a **download** icon that pulls the rendered file, (c) a **speed selector** with three buttons: **1x / 1.25x / 1.5x** (default 1x). **Loading state** while the backend is rendering: the icon gets a CSS pulse / loading-animation so the owner knows it's on its way, and BOTH the play and download buttons are `disabled` until the backend returns (no double-clicks, no race). **Backend**: a small `POST /server/tts/<wake-hash>` route in `backend_server/` that runs piper against the cached wake-brief text and returns an MP3; results cached at `~/.local/state/ghosty/tts/<wake-hash>.mp3` so repeat plays are instant and the download button is just `GET` of that file. **Frontend** (ghosty-sessions): HTML5 `<audio>` element with `playbackRate` driven by the speed selector. **Voice**: English, en_US default. | rendered audio file at `~/.local/state/ghosty/tts/<wake-hash>.mp3`, manager UI shows the chip with pulse + disabled buttons while pending and the 1x / 1.25x / 1.5x selector on play, all green in CI | not started |
| 2 | **NEEDS YOU count coherence + mobile card header cleanup** (chat-raised 2026-10-08) — bundle of two small UI fixes: (a) the strip's headline count and rendered chips are now the same set as the answer-popup pill (only sessions where `isOwnersTurn` is true). Leftover ledger questions about sessions no longer in `waiting` no longer inflate the badge — they still live in `manager-owner-asks.jsonl` but are not surfaced in the strip. (b) On mobile widths (≤720px, the existing `isPhone()` cutoff) the focused card header hides four controls that don't have room: `.pr` (priority chip), `.rn` (rename pencil), `.proj` (project chip), `.td` (MD task-doc button). Desktop keeps all four. | (a) `NEEDS YOU N` on the strip = `N need you` on the dialog pill; (b) mobile focused card header shows only the controls that fit; both verified manually | shipped (commit `9ec9d85` on `task70-tts-needs-you`) |
| 3 | (next chat-raised items append here; do not bump the file NN) | | not started |

### Part 1 open questions (must be answered before any TTS code)

mm-manager already logged the four TTS questions in the ledger; my original
ids (`Q88`–`Q91`) collided with `TASK71-masterchief`, so they were relabelled
to **`Q93`–`Q96`**. The split-vs-single-worktree decision is `Q97`. Answers
gate the implementation — see the plan the session posts for each.

| Q | Question | Recommendation |
|---|---|---|
| Q93 | **Voice**: `piper`'s default low-quality voice, or a medium one? | `en_US-joe-medium` — a wake alert the owner cannot follow is worse than no audio |
| Q94 | **Surfaces**: which get a chip — NEEDS YOU strip only, or also owner-asks chips and stall blocks? | NEEDS YOU strip + `[asks]` stall blocks; owner-asks chips only on hover, to avoid icon soup |
| Q95 | **Cache + TTL**: cache is server-side at `~/.local/state/ghosty/tts/<wake-hash>.mp3`. What TTL, and do old files get pruned? | 14-day prune, matching `daily-checks.json` `keepDays`; the hash already makes a re-render free |
| Q96 | **`backend_server/` route**: `POST /server/tts/<wake-hash>` renders on demand. Synchronous render of a short brief is ~1 s, but a first piper run loads the model. Render async and have the UI poll, or block the request? | Async + poll; a blocked request can hold a worker through model load |
| Q97 | **Two-repo split**: part 1 spans `backend_server/` and `ghosty-sessions`, which are not the same repo. One worktree or two? | Split into two worktrees (one per repo, two PRs) — keeps each PR reviewable in one repo |
| Q98 | **Session migration**: this session's cwd is still the old `vpt-mgr-quickfix-codebox` worktree (the one staged before the move). Should it now be DELETEd + recreated in `ghosty-quickfix-codebox`, or deferred to next natural restart? | Migrate now (delete + recreate with `minimax` / M3.1-Flash-Preview), so the rule "session runs in its own worktree of the right repo" holds without a stale cwd |

## Why a separate file from TASK-68

TASK-68 lives in `virtualpytest/docs/tasks/` because the chat-raised items so
far have been virtualpytest UI work (Atlas attachments, the +n CI chip, etc.).
Codebox items don't fit the virtualpytest house and would be misplaced if
appended there. Two parallel queues, one per worktree-of-the-super-repo.

## Hard rules

- Plan first. No code edits until the owner approves each sub-part.
- This task lives in `ghosty-sessions/docs/tasks/`. The **session name is
  NOT TASK-numbered** (per the standing rule: *"Sessions in ghosty-sessions /
  mycodebox are not TASK-numbered"*) — `codebox-quickfix` is the session name.
  The MD file keeps the `TASK-<NN>-slug.md` shape for cross-repo slotting.
- No push to `main`, no merge, no deploy from this task. Deploy happens via
  `update_core.sh` on `main`, after CI is green for that exact commit.
- No `.env` changes. No secrets in code, logs, or commits.
- For ghosty-sessions worktrees: the worktree path uses the
  `/home/jndoye/ghosty-<slug>/` prefix — not the `/home/jndoye/vpt-<slug>/`
  prefix reserved for virtualpytest / vpt-manager sessions, and not the
  `/home/jndoye/vpt-manager-<slug>/` (vpt-mgr-…) prefix.
- When the session is DELETEd via the API, also remove the worktree per the
  MEMORY.md worktree-cleanup rule.

## Open questions for the owner

The session raises these in its `Waiting-for-you` block, numbered from
`~/.local/state/ghosty/manager-owner-asks.jsonl` (start at the next free id).

**Numbering floor: `Q98`.** The ledger already holds `Q1`–`Q97` — `Q88`–`Q92`
belong to `TASK71-masterchief`, and `Q93`–`Q97` to this task (relabelled by
mm-manager from my original `Q88`–`Q91`, plus `Q97` for the split decision).
Never renumber or reuse an existing id; append from `Q98` up and say when you
relabelled.
