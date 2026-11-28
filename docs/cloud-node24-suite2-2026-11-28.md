# Cloud node 24 suite check 2 (2026-11-28)

- Head sha: 4c2c5fd
- `node -v` before setup: v22.23.5 (uid 0); in a new Bash call after `scripts/cloud-setup.sh`: v24.22.3
- `scripts/cloud-setup.sh`: exit 0, 5 s
- `npm test`: exit 0, 435 s, scope 428 of 428 test files (full)
- Counts: tests 4477, pass 4473, fail 0, cancelled 0, skipped 4
- Failing tests: none
- Skipped tests:
  - an unreadable ledger is reported, not mistaken for an empty one (root reads past chmod)
  - the real reviewer of the product imports from its export alone (no product clone here)
  - T26: unwritable backend dir -> E_UNAVAILABLE
  - store_error exposed by GET does not leak absolute filesystem paths (root reads past chmod)
