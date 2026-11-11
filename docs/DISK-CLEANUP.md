# Disk cleanup (2026-11-11)

Why: the codebox disk froze the host on 10-18, 10-20, 11-01 and 11-07 and every session was lost
([harness review](HARNESS-REVIEW-2026-11-11.md), Q1). On 11-11 it stood at 88 % (16 GB free of 128 GB), growing about one point an hour.
Existing pieces: `scripts/health-watch.js` (every 5 min, trims `/tmp`, scratch and the npm cache once the disk passes 85 %),
`scripts/worktree-prune.js` (reviewed plan, no `--force`), `worktree-cleanup.js` (the lane removes a merged request's own worktree).
Nothing ran **daily and on its own over worktrees, dependency caches, lane merge trees and logs**. That is `scripts/disk-cleanup.js`.

## Measurement (read-only, 2026-11-11 ~12:30 UTC, codenames only)

Sizes are `du` (GB, rounded). Class: **auto** = the timer may delete; **age** = delete only when idle for N days; **owner** = holds data,
results or secrets: never touched by a script, the owner decides.

| Consumer | GB | Class | Note / who handles it |
|---|---:|---|---|
| `~/vpt-private` | 8.8 | owner | data and secrets |
| `~/vpt-deliverables` | 2.5 | owner | delivered results |
| `~/task103-data` | 1.7 | owner | data |
| `~/vpt-apk-stage`, `-build`, `-verify` | 2.8 | owner | build outputs, results |
| `~/vpt-backups` | n/a | owner | backups, listed in the policy `never` |
| `~/.minimax/v2/sqlite` | 6.1 | owner | live runtime db 3.0 + `backups/` 3.0 (a pre-migration copy; the owner may drop it) |
| `~/.minimax/v2/sessions`, `background-tasks` | 2.9 | owner | agent history |
| `/var/lib/docker` | 9.5 | owner | needs sudo to inspect; images/volumes not classified |
| `~/.claude/projects` (transcripts) + `~/.codex` | 4.4 | owner | session history, resume needs it |
| 83 worktrees `~/virtualpytest-*`, `~/vpt-stall-fix-*` (about 0.25 each) + ~25 `~/ghosty-*`, `~/wt/*` | 16.5 | **auto** (a) | merged, clean, unused, idle > 24 h; most are kept (dirty, in use, unpushed) |
| `node_modules`, `.vite`, `.playwright` inside worktrees | 0.3 | **age** (b) | idle > 3 days; only 6 `node_modules` exist today |
| `~/.local/state/ghosty/integration/wt/int-*` | 1.7 | **auto** (d) | lane merge trees of finished requests; the lane leaves them behind (9 today, all merged or deployed) |
| `~/.local/state/ghosty/stalls.jsonl` | 0.05 | **auto** (c) | log, capped at 64 MB |
| `~/.local/state/ghosty/integration/requests.jsonl` | 0.16 | owner | the lane's request ledger, not a log |
| `~/.local/state/ghosty/usage-ledger.jsonl` | 0.10 | owner | usage ledger |
| `~/.cache/ms-playwright` | 1.2 | age | browsers; `npx playwright install` brings them back; not in the timer yet |
| `~/.gradle`, `~/android-sdk`, `~/.jdks` | 4.7 | age | build tooling, not in the timer yet |
| `~/.npm` | 0.6 | auto | health-watch cleans it above 256 MB |
| `/tmp` | 2.7 | auto | health-watch removes stale test dirs |
| `~/.local/share/{claude,pnpm,pokemon-dispatch,game-dispatch,vpt-stall-*}` | 4.7 | age | tool versions and dispatcher work dirs; not in the timer yet |

Home is 75 GB; the rest of the disk is docker, `/var/log` (1.0 GB) and the system.

## What the timer does

`systemd/ghosty-disk-cleanup.timer` runs `scripts/disk-cleanup.js` daily at 04:30 Europe/Zurich. Policy is data in
`scripts/disk-cleanup-policy.json` (repos, ages, caps, never-list). The script is a **dry run** unless
`$GHOSTY_STATE_DIR/disk-cleanup.json` contains `{"live": true}`; `--dry-run` always wins. The dry run prints per item
the size and the reason, the total it would free, and what it skipped, and writes `$GHOSTY_STATE_DIR/disk-cleanup/last.txt`.

| Step | Removes | Only when |
|---|---|---|
| a worktrees | worktree + merged local branch, through `worktree-prune.js` `plan` + `apply` (`git worktree remove`, never `--force`) | branch merged to `origin/main` (patch-equivalent counts), clean tree, nothing unpushed, no pane/process cwd, no live session, open request or lease, idle > 24 h, no non-cache ignored file (`.env`, keystores) |
| b caches | `node_modules`, `.vite`, `.playwright` (depth <= 3) of worktrees that stay | worktree idle > 3 days and not busy; the dir is gitignored and holds no tracked file |
| c logs | the head of listed logs over their cap (keeps the tail, cut at a line) | file is named in the policy and sits directly in the state dir |
| d lane trees (the lane itself now also drops `wt/<id>` at every final transition, 2026-11-11; this step is the safety net) | `<state>/integration/wt/<id>` with `git worktree remove` (no `--force`) | request `merged`/`deployed`/`failed`/... and idle > 24 h |

Never touched: the policy `never` list (live checkouts `~/ghosty-sessions`, `~/virtualpytest`, `~/vpt-private`, `~/vpt-backups`,
`~/vpt-deliverables`), any path named in `parked-worktrees-review.md`, `parked-sessions.json` or `parked.json` (state dir), `.env` files,
state files that are not a listed log. Each live removal is appended to `$GHOSTY_STATE_DIR/disk-cleanup.jsonl`; worktree removals also
go to `worktree-prune.jsonl` with the tip sha (`git branch <name> <sha>` recreates a branch).
A truncated log loses its head (the stall log is a diagnostic record, not a ledger).

### Install (host unit, normal path: backup and rollback line)

```sh
mkdir -p ~/.config/systemd/user
sed "s#/home/<user>#$HOME#" systemd/ghosty-disk-cleanup.service > ~/.config/systemd/user/ghosty-disk-cleanup.service
cp systemd/ghosty-disk-cleanup.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ghosty-disk-cleanup.timer
node scripts/disk-cleanup.js --dry-run          # read the table first
# rollback: systemctl --user disable --now ghosty-disk-cleanup.timer && rm ~/.config/systemd/user/ghosty-disk-cleanup.{service,timer}
# the owner's switch (first live run): echo '{"live": true}' > $GHOSTY_STATE_DIR/disk-cleanup.json   (back: delete the file)
```

No existing unit file is overwritten (new names), so there is nothing to back up.

## Alarm

The existing disk event in `server.js` (`healthTick`, ntfy `codebox disk / N% full`) used to fire only at the health `crit` level (95 %).
It now fires from `GHOSTY_DISK_PUSH_PCT` (default 90, the disk-guard hold line too) and its body names the 5 biggest children of `$HOME`
(`disk-guard.js` `topHomeConsumers`, one `du -x --max-depth=1`, cached 30 min, taken before the first push of a crossing). Reminders every 6 h
as before; no second event.

## Not in the timer (owner or later)

`~/.minimax/v2/sqlite/backups` (3.0 GB, a pre-migration copy), docker images/volumes, the dispatcher work dirs under
`~/.local/share`, playwright browsers and gradle caches, and `integration/requests.jsonl` (needs a lane-side rotation).

## First dry run (2026-11-11 ~13:00 UTC)

Would free **0.45 GB**: 2 merged worktrees (0.01), 1 idle `node_modules` (0.24), 2 lane merge trees (0.20), logs under their caps.
29 items skipped: 4 worktrees named in the parked review, `.vite` dirs holding tracked files, and 7 lane trees that are under 24 h old or whose request is still open.
The 82 other worktrees are kept (31 have uncommitted files, 10 are in use, 6 changed under 24 h ago, 3 hold untracked non-ignored caches), so the
timer alone does **not** stop a 1 point/hour climb: the large movable items are in the "Not in the timer" list above and need the owner's call.
