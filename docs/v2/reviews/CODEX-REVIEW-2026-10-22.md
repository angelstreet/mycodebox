# Independent review — 2026-10-22

Scope: commits `a93e7647` and `ed90ab42`, the failover/filter/manager-session changes, and virtualpytest TASK-154. Focused tests in this checkout passed: 141/141.

## 1. Migration classifier (`a93e7647`)

Verdict: concerns.

- **Medium — `merge-policy.js:178-180, 307-316`**. `CREATE OR REPLACE FUNCTION` is classified additive. A migration containing `CREATE OR REPLACE FUNCTION public.authorize(...)` replaces an already deployed function body, so an existing security or authorization behavior can change while the merge policy records `migrationAdditive: true`. This is not a parser escape; it is an explicit classification that treats replacement as additive. Keep ordinary `CREATE FUNCTION` additive only when the object is new, or require an explicit non-additive classification/approval for `OR REPLACE`.
- **Low — `merge-policy.js:311-315`**. The SQL reader is intentionally fail-closed for unrecognized statements, comments, quoted identifiers, and `DO $$` blocks; the added tests cover the supplied gap cases. I found no concrete destructive `DROP`, `TRUNCATE`, `DELETE`, `ALTER ... DROP`, or unredeemed `REVOKE` input that passes the current classifier. The remaining concern is the function replacement above, not a comment/case/quoting bypass.
- **OK — `merge-policy.js:135-143, 347-370`**. A rollback suffix is excluded only under a migrations directory, `DROP TRIGGER` requires a later matching recreation, and sequence/function revokes require an earlier object created by the same file. `_down.sql` and rollback-looking files outside migrations remain migrations.

## 2. Deploy catch-up loop (`ed90ab42`)

Verdict: ok, with a low operational caveat.

- **OK — `deploy-runner.js:375-410, 470-486`**. Catch-ups do not pass `--skipped-hosts`, are capped at three attempts per env/ref/host, and exponentially back off. Registry-listed completed attempts are combined with in-memory attempts, so normal polling cannot loop forever or starve a newer ref behind an older running catch-up.
- **Low — `deploy-runner.js:209-211, 383-395`**. After a runner restart, only completed catch-ups still present in the registry contribute to the cap; completed records that have already aged out, plus the in-memory map, are forgotten. A persistently leased host can therefore receive three more attempts after each restart. This is bounded per process but not across restarts; persist the per-host counter or make the registry retain a durable attempt marker if the cap is intended to be global.

## 3. MiniMax failover

Verdict: bug.

- **High — `scripts/orchestrator-failover:52-73`**. Promotion is a check-then-act sequence with no lock or compare-and-set. Two watcher instances (for example, systemd accidentally duplicated during a restart) can both read `STATE=claude`, both see the same >=97% quota, both send the standby message, and both set `STATE=minimax`. The standby then receives two manager instructions and can perform duplicate work. Use an exclusive lock around the state transition and message, or an atomic state update that records the promoting process/run.
- **Medium — `scripts/orchestrator-failover:62-73`**. A stale `minimax` state is reset solely from the state file mtime. If MiniMax is still actively working after 12 hours, the next pass resets to `claude` and can promote/send again while the first standby remains active. Before reset, check an explicit standby heartbeat/active marker, or make the state durable with a lease/owner generation.
- **OK — `scripts/orchestrator-failover:20-29, 42-50`**. Missing, unreadable, malformed, or stale quota input is treated as unknown; defaults are 97% promotion and 90% handback; raw quota values are parsed as bounded integer percentages for the tested shape.

## 4. Manager event filter

Verdict: concerns.

- **Medium — `scripts/manager-event-filter.sh:35-39`**. Every `lease:released` event attributed to `manager:deploy` with `deploy-finished` is dropped. If the deploy runner has crashed or is disabled immediately after the lease release, the release is the only wake-up event that can cause the manager to reconsider a blocked deploy; the filter hides it and the manager waits for a later sweep. Keep the suppression only when the event includes evidence that the runner accepted/finished the follow-up, or emit a separate runner-health wake event.

## 5. Manager session owner questions

Verdict: bug.

- **High — `public/ask-model.js:20-24` and `server.js:1224`**. `managerSession` suppresses every waiting or done owner item, not only manager-operational stops. Scenario: the manager-listed session reaches a hard-floor question such as “delete the customer data?” or “apply the production migration?”; `server.js` marks it `managerSession: true`, and `isOwnersTurn` hides it from the NEEDS YOU strip and popup. The separate manager-asks ledger does not reliably cover a live session stall. Suppress only stops explicitly escalated to the manager or known operational cases; hard-floor owner questions must remain visible.

## 6. virtualpytest TASK-154 audit trail

Verdict: concerns.

- **Medium — `shared/src/lib/database/audit_events_db.py:120-131, 168-186`**. The bounded queue drops audit rows when full, and a failed batch drops all rows permanently. Scenario: Supabase is unavailable during a burst of more than 10,000 requests; the request succeeds but the audit trail silently loses the oldest/newest rows, with only process logs explaining the loss. Add a durable outbox or an explicit loss metric/alert and document that the trail is best-effort.
- **Medium — `shared/src/lib/database/audit_events_db.py:189-195`**. The retention worker deletes all rows older than the configured age through the service role, with no tenant predicate. A malformed or negative `VPT_AUDIT_RETENTION_DAYS` value can delete more than intended, and the operation is not auditable. Validate the setting to a positive bounded range and use a controlled retention job with deletion metrics/audit.
- **Medium — `shared/src/lib/database/audit_events_db.py:198-205` and `backend_server/src/lib/audit_emitter.py:79-95`**. Reads filter by `team_id`, but the service-role writer accepts arbitrary `team_id` and does not verify that the actor/request belongs to it. Scenario: an emitter passes another tenant’s UUID (or omits it and creates a NULL row); the row is written globally, and later visibility depends on the caller’s team filter rather than an enforced ownership check. Validate team membership at the emitter/database boundary and reject missing team context for tenant-scoped events.
- **Low — `setup/db/migrations/20261022a_audit_events.sql:15, 60-61`**. Every login stores `actor_email` and the auth trigger copies it directly. This is intentional audit context but is PII retained for 90 days and exposed to the service-role Activity reader. Document the retention/privacy basis or store a stable user identifier unless email is required.
- **OK — `setup/db/migrations/20261022a_audit_events.sql:45-52` and `audit_events_db.py:73-85`**. RLS/grants restrict direct table access to `service_role`, and raw IP storage is off unless `VPT_AUDIT_STORE_RAW_IP=1`; the default stores only a truncated salted hash. The login trigger catches exceptions and returns `NEW`, so an audit failure should not block login.
