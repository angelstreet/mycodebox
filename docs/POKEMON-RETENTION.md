# Pokemon run retention (proposal, not applied)

Status: **proposal only**. `scripts/pokemon-retention-dryrun.js` prints what the rule would delete and contains no delete code.
Nothing under `~/vpt-private/pokemon` has been changed. Applying it is a separate, reviewed change.

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

## Proposed rule
1. Keep every run `.json` forever.
2. Keep run `.webm` for 7 days; delete older ones, except a run whose id appears in a `canonical/finished/` snapshot.
3. Age out `stall*`/`repro*`/`work*`/`replay*` directories after 14 days without a modified file, skipping any that hold a save, state or ROM.
4. Never touch saves/states, ROMs, `canonical/` (other than rule 2) or the named test dirs.

Effect now: frees about 7.4G at once and caps `runs/` near 4-5G at 0.6G/day. Pokemon Gold adds runs at the same rate, so the cap holds.

## Next step
Review the dry run, then a small follow-up adds a `--apply` mode (or a daily timer) behind a switch, moving files to a trash dir for a day first.
