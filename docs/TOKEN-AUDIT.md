# Token audit (how to redo it)

Use it for "where do the tokens go, what is waste". It covers the agent sessions on this host (Claude, Codex, MiniMax,
OpenCode). For the Claude API bill of the applications, use [ANTHROPIC-CACHE-AUDIT](ANTHROPIC-CACHE-AUDIT.md).
First run, its method and fixes: [token-audit-20261128.md](token-audit-20261128.md). Its results are on the private
page `token-audit-20261128-full`.

## Steps
1. **Figures:** `node scripts/token-audit.js --window FROM,TO` (UTC; default: last 48 h). It prints the comparison table,
   per agent and model, the top 10 sessions and the waste findings. It reads `usage-ledger.jsonl` only. Its output names
   sessions and costs: write it outside the repo and share it with `page publish`.
2. **Compare:** give several `--window`: the window of the last audit, the new one, and the same hours of earlier days.
3. **Live view:** the usage page (Waste tab) or `GET /api/usage`: `waste`, `perAccount`, `burn` (against the plan limits)
   and `loops` (the same command or prompt repeated in a session, from the transcripts). They cover the last 48 h only.
   First check `writer.behind`: `true` means the usage tailer runs older code than the checkout.
4. **Answer these**, with numbers: (a) context per call and the share from very large calls; (b) cache hit, and sessions
   under 90%; (c) what subagents read and cost; (d) loops and polling; (e) big models on tiny turns; (f) agents other
   than Claude. For (d) and for the cause behind any large session, read that session's transcript.
5. **Rank savings** by share of the window's cost. Say for each who acts: a harness change, the manager or the session's
   owner. Check what already shipped (last audit, [REFERENCE](REFERENCE.md) "Waste, accounts, burn and loops") first.
6. **After a fix:** rerun with a before and an after window. Report volume too: a quiet period alone is not proof.

## Traps
- Cost is the ledger's API-equivalent price, a proxy: subscription plans weigh models differently. Unpriced agents show
  $0, which does not mean free.
- "Context" is input plus cache reads and writes. A high cache hit does not make a 600k context cheap: look at size too.
- The account a Claude session ran on is not in the ledger. It is only known for sessions seen alive since 2026-11-28
  (`session-accounts.json`); the script does not split by account, `/api/usage` does.
- All waste findings of one session share one trace id: tell them apart by kind and id.
- Loop counts were once inflated by transcript lines without a time stamp (fixed). Confirm a surprising count by hand.
- Script against the first audit's window (2026-11-26T00:00,2026-11-28T00:14): its main figures match the private
  results closely. "Manager-labelled calls" (label contains `manager`) does not match the later re-measure, so compare
  that row only between windows run with this script.
