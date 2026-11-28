# Token audit 2026-11-28 (method and what shipped)

This public file keeps the method, the scripts and the changes made. The measured results (usage, cost, plan limits,
session names) are on a private codebox page: slug `token-audit-20261128-full` (list at `/p/`). To run the audit again:
[TOKEN-AUDIT](TOKEN-AUDIT.md).

## Sources

`usage-ledger.jsonl` (errors excluded), the rate-limit files and, for loops, the Claude transcripts of the window. Cost is
the ledger's API-equivalent price, a proxy for plan burn (the plans weigh models differently). `usage/waste.js` and
`usage/loops.js` now produce the same kind of figures continuously (fields `waste`, `perAccount`, `burn`, `loops` of
`/api/usage`); `scripts/token-audit.js` prints them for any time window.

## Account split

The account of a Claude session is not in the ledger or the transcripts (all accounts share `~/.claude/projects`). Only a
running process knows it (`GHOSTY_CLAUDE_ACCOUNT` in its environment). The usage tick reads it from the live sessions and
keeps a per-session history in `session-accounts.json`; a swap appends an entry. Account files are never read, so older
calls cannot be attributed.

## Questions a to f

- **(a) Context per call:** average, p95, share of tokens by call size, sessions with a very large average context.
- **(b) Cache:** hit rate overall and per session, tokens written to the cache, 5-minute against 1-hour writes.
- **(c) Subagents:** their share of context and cost, and the sessions they come from.
- **(d) Loops and polling:** the same command or prompt repeated in one session (transcripts), and calls with very little
  output on a large context.
- **(e) Big model on small work:** large-model calls with very little output; cost per context token by model.
- **(f) Agents other than Claude:** the same view per session; some plans count calls, so polling calls matter there.

## Kinds of saving proposed

Numbers 1 to 5 are the ones other documents and code comments refer to.

1. The most expensive model only for hard turns; a cheaper one by default.
2. Compact or restart sessions that stay on a very large context.
3. Narrower subagent prompts and a context cap.
4. Waiting without model calls: longer sleeps, fewer wakes.
5. Small turns on a smaller model; a 1-hour cache lifetime for sessions with long idle gaps.

## What shipped

- **Detectors:** `/api/usage` and `usage-summary.json` have `perAccount`, `waste` (thresholds in `WASTE_DEFAULTS`),
  `burn`, `loops`, a filled `outliers` list, and the scorecard has a daily `waste` line. The usage page has a Waste tab.
- **Fixes to waiting and context:** fewer model wakes, smaller context, waits that make no model call.
- **Advisories:** high context, subagent-heavy (saving 3: `context-advisory.js` sends the manager a narrow-prompt brief)
  and a manager restart advisory (saving 2: at a natural stop, one line in the handover log, then
  `scripts/manager-fresh.sh`, whose kickoff reads that line). `advisory-kinds.js` is the single list of kinds, with a drift
  test. The Waste tab shows when each kind last fired.
- **Advisory feed corrections:** `manager-events.js` and `manager-event-filter.sh` had dropped the new kinds; the
  advisory state is keyed by `<kind>:<id>` because the findings of one session share one trace id.
- **Loop detector:** it counted transcript lines without a time stamp, so older repeats passed the window
  (`usage/loops.js`, `test/usage-loops.test.js`).
- **Deploys of usage code:** `scripts/safe-restart.sh` also restarts `ghosty-usage`, which writes the summary.
- **Phone layout of the usage page:** fixed, and checked daily by `scripts/ui-overflow-check.js` over
  `scripts/ui-pages.json`.
- **Waiting rules for nightly agents:** added to `scripts/rtsp-nightly/prompt.md` and to the coc-daily prompt.

## Decision: 1-hour cache lifetime

Closed with "no" (manager, 2026-11-28). Interactive sessions on a subscription already write 1-hour entries. The 5-minute
writes came from bursty subagents and short scheduled checks, where the dearer 1-hour write would not pay. The switch
(`cache-ttl.js`) stays built and off, for a session with long idle gaps on the 5-minute lifetime.
