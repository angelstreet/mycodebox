# V2 reference specs

Reference specifications for the **planned** mycodebox V2 refactor. These are
proposals/contracts from the owner, not live requirements and not authorization
to deploy, merge, push, or change production settings.

| File | What it is |
|---|---|
| [MYCODEBOXV2_AGENT_TASK.md](MYCODEBOXV2_AGENT_TASK.md) | Phases 0–7 implementation plan, V2 additions (sections 12, 13), and the T01–T40 verification matrix. |
| [PROMPT.md](PROMPT.md) | Operational launch prompt for the V2 autonomous lead coordinator. Defines manager / developer / verifier / integration / system-ops roles and the execution loop. |
| [GOAL_LOOP_CONTRACT.md](GOAL_LOOP_CONTRACT.md) | Universal goal-loop contract (interpret → inspect → plan → execute → deterministic verify → independent evaluate → feedback) plus GL01–GL14 acceptance tests. Applies to every task after V2 ships, not only the refactor. |

## Reading order

1. `MYCODEBOXV2_AGENT_TASK.md` — scope, phases, exit criteria, T-matrix.
2. `PROMPT.md` — operating model for the lead coordinator and worker model.
3. `GOAL_LOOP_CONTRACT.md` — product-level behavior every task must satisfy.

## Status

Proposed, not implemented. None of the controls, schemas, leases, integration
agent, system-ops agent, or goal-loop acceptance tests in these docs are live.
Treat any reference to "V2 features" elsewhere in the repo as roadmap until the
matching code, tests, and CI evidence exist.
