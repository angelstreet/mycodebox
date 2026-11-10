# Pokemon run retention (owner rule, 2026-11-10)

Status: **owner decided 2026-11-10** ("for pokemon if it is the disk issue, keep the in-progress and the last completed only").
`scripts/pokemon-retention.js` is a dry run by default; `--apply` moves the deletions to a trash folder. No timer.

## Why
The disk returns to 85% after every cleanup (2026-11-03, 11-07, 11-09, 11-10). Worktrees are now removed by the lane after a merge
(REFERENCE, "Worktree cleanup"); the other grower is `~/vpt-private/pokemon` (17G on 2026-11-10).

## Measured 2026-11-10
| path | size | note |
|---|---|---|
| `canonical/runs` | 13G | ~665 run `.webm` (~21M each, 13.8G) + small `.json` (0.1G); oldest 2026-10-19; ~0.6G/day |
| `canonical/finished` | 454M | per-finish snapshots: keep |
| `canonical/memory_*.json` | 164M | periodic memory snapshots: keep (candidate for a later "keep last N per game") |
| named test/dev dirs | ~1.4G | fuchsiatest, saffrontest, storytest, celadontest, work, work-vr1f, yellow-dev, hostruns |
| ~60 `stall*`/`repro*`/`work*`/`replay*` dirs | ~1.2G | debugging artifacts, 16-60M each |

Run videos by age (`find canonical/runs -name '*.webm' -mtime +N`): >3 d 580 files, 10.8G; >7 d 353 files, 7.4G; >14 d 69 files, 0.9G.

## Rule (applied)
Scope: files `<id>.json` / `<id>.webm` in `<root>/*/runs/` (canonical, hostruns, ...). Per runs folder and per save (the json `save` field) keep
1. every in-progress run: json missing/unreadable, json without `video_end`, a file open by a process (`/proc/*/fd`), or a file modified in the last 15 min (`--live-min`);
2. the newest completed run.
Everything else in `runs/` is removed (video and json). Never touched: saves/states, ROMs, `canonical/finished`, `memory_*` snapshots, any folder that is not a `runs/`.

`node scripts/pokemon-retention.js` lists KEEP/REMOVE and the bytes (dry run). `--apply` renames the removals into `<root>/.trash-<date>/<same relative path>`
(same filesystem, so no copy) and purges `.trash-*` folders older than yesterday (bug-ffd2e84e). Test: `test/pokemon-retention.test.js` (temp dir).

Suggestion only, not in scope: run it daily from a timer so `runs/` stays at one completed run per save plus the live one.
