# Anthropic prompt-cache audit (how to redo it)

Use it when the Claude Console warns about a low prompt-cache hit rate, or to find which key or code spends.
First run: 2026-11-28. Dated results hold real key names and costs, so they stay out of this public repo: publish them with
`page publish` (that run: page slug `cache-hit-rate-report-20261128`, list at `/p/`).

## Rules
- Usage and cost need the Admin API keys the dashboard already uses (`~/.config/anthropic/<org>.admin.key`).
  Local call logs show only what writes to them, never what the Console counts. Get the owner's go-ahead for this use
  of the keys; only GET reports, never print a key, commit no output.
- The reports cost nothing. A model run to "prove" a fix costs money: ask first.

## Steps
1. **Anthropic's figures:** `scripts/anthropic-cache-audit.py --days 30 > <private dir>/cache-audit-<date>.md`.
   The newest data can be missing: say which last day the output holds.
2. **Read the days, not only the total.** One large well-cached job hides weeks of misses. For each organisation, key and
   model, find days with a low read share, and days where `written` is large and `read` is near zero (paid, never reused).
3. **Zoom in:** `--org <org> --hourly --from <day> --to <day>`. The hour shows the burst to match with runs and commits.
4. **Match local logs.** In VirtualPyTest, `ai_calls` (`ts, server, usage_key, endpoint, model, tokens_in,
   tokens_cache_read, tokens_cache_write, cost`; `tokens_in` includes cache read and write). Group by day, model and
   `usage_key`. A day whose token counts equal the Console's identifies the key and the path. One local endpoint can be
   billed to more than one organisation (billing fallback), so compare the sum too.
5. **What is not in the logs:** other apps' keys, other servers' databases, and scripts that call without a DB write
   (benchmarks, labelling runs). Check `git log` of the unexplained days. Name what stays unmatched as unknown.
6. **Code inventory:** grep every repo for `api.anthropic.com/v1/messages`, `messages.create(`, `messages.stream(`,
   `new Anthropic(` and `cache_control`. Per site: model, key variable name, whether it caches, whether the prefix repeats.
7. **Fix only what pays.** Cost of a cached prefix against plain input: write 1.25x (5 min) or 2x (1 h), read 0.1x or less.
   A prefix under the model's minimum is silently not cached. Check current prices and minimums in Anthropic's docs.
8. **Report:** cause, before and after per fixed path, what is unverified. Then check the days after the deploy with step 1.

## Traps found on 2026-11-28
- Settings can add `cache_control` outside the code: a model profile's `extra` JSON in the database put automatic caching
  on one-shot calls and bypassed the code's guard. Search the data, not only the source.
- Automatic (top-level) caching marks the last block. On a one-shot call that is the unique part: a write never read.
- Adapters in one file can differ: check that the `cache_control` you found belongs to the adapter that calls Anthropic.
- A 0% path that never writes and has short prompts costs little. Price it before calling it waste.
- The Console's "could save up to N%" has no formula or window in the reports; do not promise to reproduce it.
- `analytics/cost` can answer 200 with 0 while `/v1/organizations/cost_report` has spend (bug-28e6db75): use `cost_report`.
