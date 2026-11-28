# Cloud node 24 suite check (2026-11-28)

Branch: claude/cloud-node24-suite-20261128 (no product change).

- `node -v` before `scripts/cloud-setup.sh`: v22.23.5 (uid 0)
- `node -v` after, in a new Bash call: v24.22.3
- Setup: exit 0, 4 s
- `npm test`: exit 1; selection `full` (428 of 428 test files)

| tests | pass | fail | cancelled | skipped | todo |
|---|---|---|---|---|---|
| 4477 | 4469 | 6 | 0 | 2 | 0 |

## Failing tests
1. `test/minimax-fallback.test.js` "a timeout kills the whole process group, children included": `pid 11503 is gone` (true !== false)
2. `test/mm-manager.test.js` "mm-manager.sh --once --dry writes a prompt with events + rules; tolerates a closed port": `exactly one prompt file` (0 !== 1)
3. `test/mm-manager.test.js` "mm-manager.sh --once with a fake mcode records proposals, mm_ms and tokens (no network)": `ENOENT ... mm-manager-decisions.jsonl`
4. `test/owner-ask.test.js` "an unreadable ledger is reported, not mistaken for an empty one": `nothing is readable` (got the Q1 entry, expected `[]`; likely because tests run as root, so chmod does not make the file unreadable)
5. `test/rtsp-check.test.js` "the summary separates the streams that are down from the devices without a source, and a YouTube device is not down": `nothing is down and nothing errored: the night exits 0` (1 !== 0)
6. `test/v2-ui-docs-verify.test.js` "store_error exposed by GET does not leak absolute filesystem paths": `Missing expected rejection`

## Skipped tests
- "the real reviewer of the product imports from its export alone" (no product clone here)
- "T26: unwritable backend dir -> E_UNAVAILABLE" (SKIP)
