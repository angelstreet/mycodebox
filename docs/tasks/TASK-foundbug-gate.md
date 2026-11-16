# TASK foundbug-gate (owner 2026-11-16)

Goal: sessions fix the bugs they can fix instead of filing them: `found-bug` accepts only filings that prove the bug is real on current
main and could not be fixed by the filer, and stale ones never reach a worker.

Done when: (1) `found-bug` / `/api/bugs` refuse a filing without `--checked-main`, exact error and `--tried` (exit 2 / 400, tests);
(2) effort / time wording or a claimable equivalent sends a live filer's bug back once, commits on main mark open bugs possibly-fixed and
the drain skips them until checked (tests); (3) the scorecard shows per day filed / fixed by filer / closed stale, baseline below;
(4) AGENTS.md + REFERENCE.md updated, merged, deployed, bugs resolved with the integration id.

## What shipped

See REFERENCE.md "Proof gate and stale filter". Code: `found-bugs.js` (`proofMissing`, `effortOf`, `equivalentFreeOf`, `possiblyFixedOf`,
`checked`, `week().daily`), `server.js` (`bugProof`, git facts cache, `/api/bugs/<id>/checked`), `scripts/found-bug` (v5), `scripts/bug-drain-tick.js`.

## Baseline (found-bugs.jsonl on 2026-11-16, 844 real reports since 2026-10-28)

Resolved: fixed 437 (by the filer 196, by a worker/other 241), wontfix 66, duplicate 14, doc-only 22. Open 305. Reports with `why` missing 493
(old clients). The drain reports about 108 triage closures that were already fixed or stale; the ledger-only heuristic (`staleClosed`:
duplicate / wontfix / a note saying already fixed or stale) sees 82 of them, because many closures carry a free-text note only.

| day (UTC) | filed | fixed by filer % | stale-closed % |
|---|---|---|---|
| 2026-11-10 | 103 | 19 | 8 |
| 2026-11-11 | 181 | 27 | 8 |
| 2026-11-12 | 68 | 25 | 9 |
| 2026-11-13 | 91 | 40 | 3 |
| 2026-11-14 | 37 | 32 | 3 |
| 2026-11-15 | 52 | 52 | 6 |
| 2026-11-16 | 50 | 40 | 2 |

(Earlier days: `curl localhost:7777/api/manager/scorecard?days=30` -> `bugs.daily`.) Target after the gate: filed per day falls, fixed-by-filer
share rises, stale-closed share goes to about 0 because a filing carries a sha of current main.

## Possibly stale open bugs for the bug-drain to check (not closed by this task)

Found by `possiblyFixedOf` against the last 400 commits of origin/main, plus a looser 3-word pass (verify each on main before closing):
bug-61e4265b (manager manual vs contract; 6d1a05b6 docs(contract)), bug-c54ea30f (network stream audio drift; dc61356c rtsp-nightly multi_audio),
bug-acc369c2 (`vpt-lease run --no-auto-equivalent`; merge feat/lease-named-device-fix), bug-81094e7d (holder-pid check; 2ebecf5f idle release),
bug-da4e6466 (parallel sessions on a red main; a3a24ad0), bug-2a939202 (host deploy left units running; 9d87f73f), bug-cc0695b9 (lane
restarts the live service for docs; 53bcff5d docs-only notes), plus idea bugs already shipped: bug-bf0c99af, bug-ffd2e84e (pokemon retention),
bug-b2cffe7a (worktree prune). The live server now marks these `possiblyFixed` on `GET /api/bugs`.
