# Scheduled bug drain (owner, 2026-11-11)

Owner: "any session to handle those bugs? when or how frequent do you check and drain bugs?" Before this, nothing ran on a schedule:
the manager counted bugs at the hourly sweep and started workers ad hoc. Now `scripts/bug-drain-tick.js` runs every 3 hours.

| Piece | Where |
|---|---|
| The tick | `scripts/bug-drain-tick.js` (pure planner + one `tick()`), tests `test/bug-drain-tick.test.js` (fake ledger, sessions, quota, cbsession) |
| Timer | `systemd/ghosty-bug-drain.timer` + `.service`: 08:05, 11:05, 14:05, 17:05, 20:05 UTC (none from 23:58 to 07:30: nightly fleet, RTSP, Pokemon and CoC reviews; `:05` is clear of the `:25-:50` deploy span) |
| Mode | `<state>/bug-drain/mode`: `dry` (default) or `live`. `--dry` / `--live` on the command line win |
| Output | `<state>/bug-drain/journal.jsonl` (one line per tick), `<state>/bug-drain/scorecard.json` (latest numbers), one `bug-drain:tick` line in `manager-events.jsonl` (dry and live) |

## Policy

1. Reads the ledger (`GET /api/bugs`, limit 1000, open) and drops: owner-only / hard floor (`why` owner-floor or credentials, or the title names a db repair, a
   physical replug, credentials / login, money), bugs with a live fix claim (`found-bug --claim`, 2 h), bugs filed by a **live** session in the last 2 h
   (the send-back wake handles those) or marked `live-session-task`, and bugs whose area a live session owns (every distinctive word of that session's name occurs in the report).
   **Floor filter** (manager, 2026-11-11): a bug whose title, endpoint, repro, error, workaround or reason mentions sudo / sudoers, cron / crontab, systemd / systemctl / unit files, proxmox, a hypervisor,
   the docker daemon, nginx, host config, `.env`, secrets, DNS, firewall, credentials, deletion of data, a DB migration / repair, a corrupt table or index, postgres, sqlite, vacuum or reindex is owner-only and never auto-started; the ids go under `ownerOnly` in the
   journal line. A bug about a host a worker cannot reach (named `vpt-pi*` / `vpt-mf*` / `vpt-lenovo*` / `host-clone-*` / `labox-*` / `runner-*` with no healthy entry in `vpt-lease inventory node1-vpt`, or the
   inventory unreadable) is skipped too (`unreachable` ids in the journal).
2. Ranks: blocking first, then age (older first), then impact (deploy / lease / CI / data > other > UI > idea). Takes at most 3, never more than 2 drain workers alive (`bugdrain-*`).
3. Starts one `cbsession` worker per bug (own worktree of the main checkout, `-g fix <id>`, brief in `<state>/bug-drain/brief-<id>.md`): **small and clear** (repro and exact error, not
   blocking, not large, not an idea) -> `-p minimax` (MiniMax-M3) while the MiniMax 5h window is <= 80 %; otherwise `-m sonnet` only while the Claude default account's weekly window is < 85 %
   (account rotation handles the rest). A gate that is closed skips the bug for this tick; an unknown quota starts no Sonnet worker.
4. Live: the tick claims the bug for the worker's session (`POST /api/bugs/<id>/claim`) before starting it; a refused claim starts nothing; a failed start releases the claim.
5. Never starts anything when the disk is >= 90 % (same threshold as `disk-guard.js`), when two workers are alive, or when `/api/sessions` is unreachable.
6. The brief (cbsession refuses a brief with no checkable `Done when:` list, GOAL-RULE): `Goal:`, `Done when:` (bug resolved in the ledger, integration merged, touched tests pass), `Time box: 2 h`, bug fields, `found-bug --claim` first, reproduce, fix in the worktree, tests, `integrate request`, `found-bug --resolve`, public-repo rules, STATUS vocabulary.

## Numbers (journal and scorecard)

Open now (and blocking), opened and closed in the last 24 h, median age of open bugs (hours), and fixed bugs split into fixed by the finder (`resolvedBy` = the filing session),
by a worker (`resolvedBy` bug-drain*), and other.

## Install and switch (user timer, host-unit routine path)

    cp ~/.config/systemd/user/ghosty-bug-drain.service{,.bak-$(date +%F)} 2>/dev/null   # backup if one exists
    sed 's#/home/<user>#'"$HOME"'#g' ~/ghosty-sessions/systemd/ghosty-bug-drain.service > ~/.config/systemd/user/ghosty-bug-drain.service
    cp ~/ghosty-sessions/systemd/ghosty-bug-drain.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now ghosty-bug-drain.timer
    systemctl --user list-timers ghosty-bug-drain.timer
    echo live > ~/.local/state/ghosty/bug-drain/mode        # the manager does this after reading one dry tick (back: echo dry > ...)

Rollback: `systemctl --user disable --now ghosty-bug-drain.timer && rm ~/.config/systemd/user/ghosty-bug-drain.{service,timer} && systemctl --user daemon-reload`.
Dry run by hand: `node scripts/bug-drain-tick.js --dry`.
