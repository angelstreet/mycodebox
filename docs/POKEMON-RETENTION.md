# Pokemon run retention (owner rule, 2026-11-10)

Status: **owner rule 2026-11-10, revised the same day** ("for each of Blue, Yellow, Gold we want to keep the in-progress one and the
LATEST PLAYED game only, to save space"). `scripts/pokemon-retention.js` is a dry run by default; `--apply` only runs a reviewed plan. No timer.

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

## What a game is
A file pair `runs/<stamp>.json` + `.webm` is one **segment** (one run between two stops of the lane), not a game. A **game** is the
segments of one save (`save` in the json), grouped exactly like the page's publisher (virtualpytest `features/pokemon/lib/series_publish.py`):
a segment whose `summary.start_milestone` is `starter` after one that did not opens a new game; segments after a game's Hall of Fame stay
with it. The game's id is `<save>-<first stamp date>` (what the run picker shows). The Pokemon game is the json `game` field
(`blue_fr`, `yellow_en`, `gold_en`; Blue for old runs without it); one Pokemon game can have several saves (Blue: `latest`, `second`).

**Fragment vs playthrough.** A game whose first segment does not start at `starter` is a fragment: the page shows it as
"recorded from mid-game" (`complete_from_start` false). That is what is left when the earlier segments of a game are gone.

## Rule
Per runs folder (`<root>/*/runs/`) and per Pokemon game keep:
1. every **in-progress game**: the newest game of its save with no Hall of Fame yet;
2. the single **latest played game** of the other games, ranked: a playthrough beats a fragment; a finished game (Hall of Fame) beats an
   unfinished one; among finished games the newest start wins; among unfinished ones the most milestones, then badges, then the newest.
   Play time is not a criterion: a slower replay of the same story is not "more complete";
3. every file that is not a finished segment: no readable json, no `video_start`/`video_end`, open by a process (`/proc/*/fd`), or modified in
   the last 15 min (`--live-min`).

All segments of a removed game go (video and json). Never touched: saves/states, ROMs, `canonical/finished`, `memory_*`/`state_*`/`stall_*`
snapshots, any folder that is not a `runs/`. The object store copy of every published segment (`game-series/pokemon/<game>/runs/`) is never
touched by this script.

## How to run (dry run, review, apply, purge)
1. `node scripts/pokemon-retention.js` prints per folder and per Pokemon game each game with KEEP/REMOVE, its size and why
   (`--files` adds every file), writes the plan to `$GHOSTY_STATE_DIR/pokemon-retention/plan-<time>.json` and prints its sha256.
2. The manager (or the owner) reads that report. Only then:
   `node scripts/pokemon-retention.js --apply --plan <file> --sha <sha>`. It refuses when the sha does not match, the plan is over 24 h old
   or for another root, or any planned removal changed since (gone, other size, now kept). It moves exactly the planned files to
   `<root>/.trash-<date>/<same path>` and writes `MOVED.tsv` (game, path) there. It never purges.
3. `node scripts/pokemon-retention.js --purge` deletes `.trash-<date>` folders older than **7 days**, in its own call (`--apply --purge` is
   refused; `--keep-days` below 7 is refused). Never `rm -rf` a trash folder by hand: restore from it instead.

Restore: move the files of `.trash-<date>/<path>` back to `<root>/<path>`. After 7 days, or after a purge, a published segment can still be
downloaded from the object store (`game-series/pokemon/<game>/runs/<stamp>.json|.webm`, keys in `~/virtualpytest/.env`); then run
`pokemon_series_publish.py` so the page's index and manifests are rebuilt from the local folder.
Test: `test/pokemon-retention.test.js` (temp dirs only).

## Incident 2026-11-10 (why the rule changed)
The first rule kept "the newest completed run per save", treating one segment as a run. `--apply` (17:35 UTC) moved 1432 files (13.28G)
of `*/runs/` to `.trash-2026-11-10`, keeping one segment per save. At 17:49 the worker deleted that trash by hand (`rm -rf`) on the
owner's "just purge it", without reading what it held. The publisher then rebuilt the page index from the local folder, so the
run picker only showed one-segment fragments ("recorded from mid-game"). Recovery: all 651 published segments were still in the object
store. The latest played game of each Pokemon game was downloaded back (Blue `second-20261101` 122 segments, Yellow `yellow-20261107` 80,
Gold `gold-20261110` 21, 4.0G) and the page was republished. The older games (Blue `latest-20261019`, `second-20261023`, Yellow
`yellow-20261101`) exist only in the object store. Lost for good: about 34 Blue segments that were never published (runs after a Hall of
Fame of the saves `latest` and `second`, not part of any game on the page) and the debug folders' old runs.

Suggestion only, not in scope: run the dry run daily and have the manager apply the reviewed plan.
