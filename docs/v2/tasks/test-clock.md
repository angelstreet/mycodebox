# Decision-share deterministic test clock

- Base: `b9a83e1`; branch: `v2/00-test-clock`.
- Scope: repair calendar-dependent fixtures in `test/decision-share.test.js` only; no production behavior changes.
- Cause: October 1 fixtures aged outside the default seven-day reporting window.
- Approach: pass the existing `now` option in module tests; preload a temporary test-only clock in the CLI subprocess. Retain seven-day filtering and assert the inclusive cutoff and exclusion immediately before it.
- Isolation: synthetic fixtures, disposable state, sanitized environment; no server, provider, service, or live-state access.
- Acceptance: focused tests and full `npm test` pass; CLI still exercises direct invocation and excludes old records.
- Rollback: revert this scoped commit. Independent verification remains required before integration.

## Developer evidence

Node v24.21.0, with `env -i PATH="$PATH" LANG=C.UTF-8 GHOSTY_STATE_DIR="$(mktemp -d)"`:

- `node --test test/decision-share.test.js`: exit 0, 24/24 pass, 126 ms.
- `npm test`: exit 0, 859/859 pass, 16.9 s, no skips.
- Production source is unchanged; the CLI preload is generated inside its disposable fixture directory.
- Staged diff reviewed for scope and private data before commit.
