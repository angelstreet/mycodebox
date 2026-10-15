# Documentation index

mycodebox is the product and repository name. The package, systemd service and existing checkout paths still use
the legacy name `ghosty-sessions`; keep operational commands consistent with those identifiers until migrated.
Start here to choose the right guide. Examples use placeholders; replace them locally, never with private values in commits.

| Task | Read | What it owns |
|---|---|---|
| Understand the product | [README](../README.md), [goals](GOALS.md) | Overview and quick start; what the product is for and what is shipped |
| Install or configure a machine | [Installation](INSTALL.md) | Prerequisites, Tailscale, service, verification, updates and removal |
| Use the dashboard | [Usage](USAGE.md) | First session, sending replies, pause, notifications and troubleshooting |
| Find implementation code | [Repository map](MAP.md) | Components, data flow, state and test locations |
| Work as an agent | [AGENTS.md](../AGENTS.md), then [agent contract](CONTRACT.md) | Safety invariants, workflow and completion evidence |
| Look up settings and behavior | [Technical reference](REFERENCE.md) | Environment settings, feature APIs and implementation details |
| Work hands-free (phone, car, gym) | [Voice](VOICE.md) | Voice mode page, spoken digest, notification buttons, headset controls and platform limits |
| Configure native HTTPS | [Certificates](../certs/README.md) | Certificate files, trust and renewal |
| Try or upgrade to V2 (opt-in task engine) | [README roadmap](../README.md#current-capabilities--v2-roadmap), [Migration](v2/MIGRATION.md), [Scoring](v2/SCORING.md) | What is shipped vs planned, upgrade and rollback notes, per-model scoring report |
- [Harness review 2026-10-14](v2/reviews/HARNESS-REVIEW-2026-10-14.md): where the owner was stopped, how long sessions waited, ranked fixes (input to V2 rounds 8 and 9).
| Leases (who may deploy or drive a device) | [Lease rules](LEASE-RULES.md), [central lease service](v2/LEASES-CENTRAL.md) | What to claim, waiting instead of asking, the service design and its cut-over |
| Understand the V2 design | [V2 architecture](v2/ARCHITECTURE.md), [verification](../V2_VERIFICATION.md) | Frozen interfaces and recorded test evidence |
| Resume development | [Handover](../HANDOVER.md) | Verification checklist and known limitations |

## Documentation contract

- Installation commands belong in INSTALL; other pages link there instead of carrying a second runbook.
- AGENTS and CONTRACT describe required behavior. REFERENCE describes implementation; it is not permission to enable an integration.
- MAP locates code. HANDOVER is context, never proof of the current machine's configuration.
- Defaults are source defaults, not claims about a deployed service. Saved state and service environment can override them.
- When changing a setting, route, dependency or user flow, update its owning page in the same change.
- Verify claims against code and tests. Record unverified external integrations explicitly. Platform task IDs refer to external history, not prerequisites or files supplied by this repository.
- Keep machine names, addresses, secrets and captured session output out of documentation and test fixtures.
