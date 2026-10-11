# Routing (Phase 4) notes

Modules: `orchestration/model-registry.js`, `orchestration/router.js` (shadow only), `orchestration/budget.js`.

## Integration requirements for the goal loop

* **Working-directory floor.** When a task carries `cwd`, `worktree` or `worktree_path`, the router requires it to be
  an absolute path inside one of `policy.allowed_roots` (exported as `WORKDIR_ROOTS_KEY`). The goal loop must pass the
  V2 worktree root in `policy.allowed_roots`; with no roots configured **every worktree route is denied** (fail closed).
  Pass `realpath` (for example `fs.realpathSync`) in the `route()` options so symlinks cannot escape a root; without it
  paths are compared lexically. A path that cannot be resolved is denied.
* **Policy checker.** Inject `checkAction(policy, task, action)` (ARCHITECTURE §4). The router always applies its own
  floors first (non-object task, critical risk, forbidden topic, unserialisable text); only `allow === true` passes.
  High-risk approval belongs to `policy.js`; the built-in stub only mirrors it.
* **Budget dimensions.** `max_usd`, `max_input_tokens`, `max_output_tokens`, `max_duration_ms`, `max_turns` (ledger and
  estimate key `turns`), whole task and `per_attempt`. Unknown, malformed or negative values under a cap give
  `awaiting_approval`; exhausted provider quota gives `waiting` unless a cap stop applies.
* **History.** Counts must be coherent (integers, verified <= attempts, errors <= attempts, non-negative spend);
  otherwise the entry is ignored and the rationale says so.
* **Fallback.** `retry_after_ms` is clamped to (0, 900000] ms; anything else uses the default backoff.
