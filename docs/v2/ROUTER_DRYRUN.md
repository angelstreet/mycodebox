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
