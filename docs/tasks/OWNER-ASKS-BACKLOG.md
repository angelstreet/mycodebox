# Owner-asks backlog (2026-10-31)

On 2026-10-31 the owner asked why there are so many questions and why old ones pile up. Two fixes shipped on
`fix/stale-owner-asks`: an owner tap on a NEEDS YOU option closes its ledger line (`recordOwnerAnswer`), and open asks
older than 48 h are listed by the sweep (`manager-ask.js --stale`). What is left, smallest first:

## 1. Close an ask when its session reports the work done

Evidence: Q260 was settled by the session finishing the work, and the manager had to notice by hand. Q245 was settled
the same way: the task doc recorded the lab-box login as done on 10-27, and the ask stayed open until 10-31.

Proposal: when a stop's STATUS line is `done` and the session holds an open ask (`ask-fold.js` `openAskOf`), the stop
handler does not resolve the ask itself (a done line can be wrong). It puts one manager item on the sweep instead:
`!! ask-done-session <id> <session>: the session reports done, resolve or keep`. The same goes for a session that no
longer exists (`!! ask-session-gone`). Size: small (`stall.js` stop path + the scan). Test: a done stop with an open ask
gives exactly one item, and no item without an ask.

## 2. Classifier false positives on floor words

Evidence, today:
- A `STATUS: done ... needs you: reload the page [hard: deploy]` line was classified as a hard-floor ask because of the
  word "deploy". A done line with a "needs you" hint about a page reload is a statement, not an ask.
- bug-631b02d0: a credential flag was raised because session output contained the header prefix `X-Amz-` (a signed URL's
  parameter name, not a secret value).
- bug-8a9bc5dc: the merge evaluator calls `ALTER VIEW` destructive even when the same migration creates that view.

Proposal (conservative, each with a test): (a) a `done` STATUS is never an owner ask; its `needs you:` part becomes a
manager note unless it contains a "?"; (b) the credential detector needs a value-shaped token after the name
(`X-Amz-Signature=` followed by 32+ hex characters), not the bare prefix; (c) `ALTER VIEW` / `CREATE OR REPLACE VIEW` on
a view created earlier in the same migration file counts as additive. Each one is its own small branch.

## 3. Idle leases that block a queued session

Evidence: today the lane asked two sessions to narrow idle host leases (`vpt-lease narrow <id> --resource <host>/<device>`),
and a queued session waited about 22 minutes behind a whole-host lease nobody was using.

Proposal, to be checked against docs/LEASE-RULES.md before any code: the harness never releases another session's
lease (LEASE-RULES: only the holder releases; no `--force`). It can (a) send the holder one nudge after N minutes idle
with no run (already done by the lane), then (b) put the lease on the owner's feed as "idle N min, queue waiting",
and (c) let leases carry an `--idle-release <min>` the holder opts into when claiming, so the registry releases them
itself. (c) changes the lease contract, so it needs an owner decision and is written here, not built.
