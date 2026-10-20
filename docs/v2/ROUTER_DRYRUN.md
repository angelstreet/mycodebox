# Router dry-run findings (Phase 4)

Scope: the existing root `router.js` (Jev manager router, shadow only). It is not live and this change does not make it
live. The new V2 router lives separately in `orchestration/router.js`.

Command (no network in `--dry`: `post` is replaced by a local function that returns the request body, and the script
exits before any `fetch` is reachable):

    env -i PATH="$PATH" LANG=C.UTF-8 GHOSTY_STATE_DIR="$(mktemp -d)" node scripts/router-dryrun.js --dry

Note on what "agreement" measures: in `--dry` no model answers, so every `choice` is the floor result or the rule
default (`source` is `rule` or `forced`). The 6/10 is therefore the agreement of the **rule defaults** with the
fixture `expect` values, not of Jev with them. Model agreement can only be measured with a live server call.

## Baseline: wake 6/10 (builder 8/10 and stop 9/10 rule-default agreement are explained by forced floors, see below)

| fixture (`test/fixtures/router-states.json`, point wake) | expected | got | cause | action |
|---|---|---|---|---|
| P0 blocked at 3am | wake_opus | wake_cheap | Rule defect | `wake.ruleDefault` returned `wake_opus` only for `escalated`. The floor already removed `ignore`/`rules_handle` for p0_blocked, so the rule fell through to the first allowed option (`wake_cheap`). The `wake_opus` criterion says "escalated, risky or already broken", and P0 blocked is already broken. Fixed: p0_blocked takes `wake_opus`. |
| deploy failed on the staging host | wake_opus | wake_cheap | Rule defect (same) | Fixed: a failed deploy (`event.kind==='deploy'` and `deploy.state==='failed'`) takes `wake_opus`. |
| forbidden topic + p0 blocked | wake_opus | wake_cheap | Rule defect (same) | Fixed by the p0_blocked rule; the forbidden-topic floor still removes `rules_handle`. |
| forbidden topic, nothing critical | wake_cheap | ignore | Rule defect (unsafe) | The floor removed `rules_handle`, the rule still asked for it, and the clamp-to-first-allowed fallback chose `ignore`: a forbidden topic would have been ignored by default. Fixed: forbidden topic defaults to `wake_cheap`. |

None of the four is a fixture defect: each fixture's `expect` matches its own label and the documented option
criteria. None is a genuine model/rules difference either, because no model was consulted. Disk/quota-only hot states
stay `wake_cheap` (fixtures "disk at 97 percent" and "codex plan quota at 96 percent" agree). Root cause class: the
rule default did not account for the clamp to the floor's allowed list, so hot or forbidden states fell to an
accidental first-allowed option.

Result after the fix: wake rule 10/10 (was 6/10). Regression tests in `test/router.test.js` (the old assertion that
p0_blocked defaults to `wake_cheap` encoded the defect and was replaced).

## Exposure of `ruleDefault`, and the wake floor (verifier follow-up)

`ruleDefault` is not private. It is sent to Jev as `refs.rule_default` in the decide request and it reaches the manager
LLM prompt through the manager-events lines written for `scripts/mm-manager.sh`. A wrong default therefore also biases
the model, which is why the three P0/failed-deploy defects mattered beyond the dry-run number.

The wake floor as first fixed still let Jev pick `ignore` on a forbidden topic (only `rules_handle` was removed). That is
now closed too: a forbidden topic removes both `rules_handle` and `ignore`, leaving `wake_cheap`/`wake_opus`. Test:
`wake: forbidden_topic removes rules_handle and ignore` in `test/router.test.js`.

## Other points (not in scope of the 6/10, recorded for completeness)

| point | rule-default agreement | cause | action |
|---|---|---|---|
| builder 8/10 (Jev 10/10) | 2 misses | The two fixtures with `p0_product_decision` are decided by the floor (`forced: opus`), so the rule default is never consulted in production; the dry-run script counts `ruleDefault` (sonnet) for them. | Genuine reporting artifact; documented, no rule change. |
| stop 9/10 | 1 miss | "forbidden_topic on continue": `forced: escalate` by the floor, rule default (`answer`) is never reached. | Same reporting artifact; the forced result is correct and unsafe picks are 0. |

Follow-up (not done): the dry-run roll-up should report agreement of the *effective* decision (forced or rule) as well
as raw `ruleDefault`; that is a script change outside this package's rules.

## What still needs owner decisions

* Live Jev agreement/cost/latency/unsafe-pick numbers need a server run with `JEV_URL`/`JEV_API_KEY`; not done here.
* The router stays shadow only; no flag was added or flipped.

## Re-check and extended set with real manager events (2026-10-19)

Re-verification of the original fixtures on current main: wake rule default **10/10** (was 6/10 at baseline; the four
misses and their verdicts are in the table above: three rule defects, one unsafe rule defect, no fixture defects, no
open cases). Nothing in `router.js` needed changing in this pass.

Extended set: `test/fixtures/router-states-real-events.json`, 24 sanitized wake events taken from the live
`manager-events.jsonl` of 2026-10-18/19 (session, host, deploy and lease names, URLs and text replaced by generic labels;
only the fields the wake point reads are kept). The label is the observed outcome in `stalls.jsonl`
(`wake_outcome`: needed = a manager-agent alert, a send/answer on the session or a deploy action inside 15 min), or a
judged label where the observed one is known to mislead. Each fixture says which (`expect_source`) and why (`reason`).
`expect_any` lists the acceptable choices: needed means `wake_cheap|wake_opus`, not_needed means `ignore|rules_handle`.
The dry-run script accepts `expect_any`. Run it with `--fixtures test/fixtures/router-states-real-events.json`.

Result: wake rule default **21/24 (87.5 %)**; no rule change, because the three misses cannot be fixed by a general
rule from the facts the event line carries:

| fixture | rule | label | verdict |
|---|---|---|---|
| escalated ask parked until the owner is back (nobody acted in 15 min) | wake_opus | rules_handle/ignore | Open case. The label is weak (a real question for the owner). |
| session waiting on a device lease ticket | wake_opus | rules_handle/ignore | Open case. A queued claim is not a question, but `escalated` is set upstream by the stall classifier; the router sees only that flag. |
| session waiting on a deploy queue ticket | wake_opus | rules_handle/ignore | Open case, same cause. Fix belongs in `stall.js` (do not mark a "STATUS: waiting" on a ticket as escalated), not in the router. Across all logged `asks`, 136 of 302 were not_needed. |

One fixture was relabelled during this pass: a permission-style confirm prompt first labelled wake-only. The needed label
also counts the rules-only auto-answer as an action, so `rules_handle` is correct (fixture defect, fixed).
One fixture (CI fixer stuck after 4 attempts) agrees with the rule but is flagged open: Jev leans `wake_cheap`, the observed
outcome says nobody was needed because the owner is pushed directly.

Caveats: the labels are only as good as `observedNeed` (failed deploys were not_needed in the log although they were
real failures, hence judged labels); `escalated` for session events is inferred from the logged rule default; 24 events
is a sample, not a scorecard. Failed deploys, critical quota and escalated asks agree; the day was otherwise dominated by
never-pushed lease/integration events, all rules_handle.
