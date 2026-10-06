# Documentation index

mycodebox is the product name; `ghosty-sessions` is the package, service and conventional checkout name.
Start here to choose the right guide. Examples use placeholders; replace them locally, never with private values in commits.

| Task | Read | What it owns |
|---|---|---|
| Understand the product | [README](../README.md) | Overview and quick start |
| Install or configure a machine | [Installation](INSTALL.md) | Prerequisites, Tailscale, service, verification, updates and removal |
| Use the dashboard | [Usage](USAGE.md) | First session, sending replies, pause, notifications and troubleshooting |
| Find implementation code | [Repository map](MAP.md) | Components, data flow, state and test locations |
| Work as an agent | [AGENTS.md](../AGENTS.md), then [agent contract](CONTRACT.md) | Safety invariants, workflow and completion evidence |
| Look up settings and behavior | [Technical reference](REFERENCE.md) | Environment settings, feature APIs and implementation details |
| Configure native HTTPS | [Certificates](../certs/README.md) | Certificate files, trust and renewal |
| Resume development | [Handover](../HANDOVER.md) | Verification checklist and known limitations |

## Documentation contract

- Installation commands belong in INSTALL; other pages link there instead of carrying a second runbook.
- AGENTS and CONTRACT describe required behavior. REFERENCE describes implementation; it is not permission to enable an integration.
- MAP locates code. HANDOVER is context, never proof of the current machine's configuration.
- Defaults are source defaults, not claims about a deployed service. Saved state and service environment can override them.
- When changing a setting, route, dependency or user flow, update its owning page in the same change.
- Verify claims against code and tests. Record unverified external integrations explicitly. Platform task IDs refer to external history, not prerequisites or files supplied by this repository.
- Keep machine names, addresses, secrets and captured session output out of documentation and test fixtures.
