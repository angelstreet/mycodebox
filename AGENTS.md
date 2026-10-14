# AGENTS.md

Guidance for AI coding agents working in, or installing, the `mycodebox` repository.

Use `mycodebox` for the product and repository name in instructions, documentation and visuals.
Legacy technical identifiers such as the `ghosty-sessions` package, systemd service and existing checkout paths
must match the actual configuration until they are migrated.

- **Start here:** [documentation index](docs/README.md). Read the [agent contract](docs/CONTRACT.md) before changes or installation.
- **Install/configure:** [docs/INSTALL.md](docs/INSTALL.md) is the canonical runbook, including Tailscale access and verification.
- **Use the product:** [README.md](README.md), then [docs/USAGE.md](docs/USAGE.md).
- **Find code and contracts:** [repository map](docs/MAP.md) and [technical reference](docs/REFERENCE.md). [HANDOVER.md](HANDOVER.md) is development context, not live configuration or authority to deploy.

## This repo is public: never leak anything

- No credentials, tokens, API keys, private keys, VAPID keys, `.env` content, ntfy topics or reporter tokens, in any
  file, commit, issue or PR. They live in `.env`, in `$GHOSTY_STATE_DIR` (default `~/.local/state/ghosty`) or in the
  service environment, none of which is tracked.
- No real IP addresses, tailnet names, host names, e-mail addresses, customer names or captured session output. Use
  placeholders such as `<tailscale-ip>`. In tests use obvious fakes.
- Never commit `certs/*.pem`, `.env`, anything from the state dir, or `stalls.jsonl`-style logs.
- Read `git diff --staged` before every commit and check for the above.

## Working in the code

- Node 20+, ES modules, one runtime dependency (`ws`). No build step: `server.js` serves `public/` as is.
- Run `npm test` (Node's test runner, `test/*.test.js`) before you commit; it must pass.
- Tests must not touch live state: point `GHOSTY_STATE_DIR` at a temp directory, and never write the live
  `layout.json`.
- The service is `ghosty-sessions` (systemd). Restart it with `scripts/safe-restart.sh`, never during a deploy.
  The guard requires a fresh successful deploy snapshot and refuses unknown or active deployment state.
- UI icons come from `public/icons.js`; add an icon there instead of pasting emoji or one-off SVG.
- Match the surrounding code: terse comments that explain why, no new dependencies without a reason.

## Safety rules of the product

- The server has no login; Tailscale policy is the only user-access gate. Do not expose it publicly.
  The source defaults to loopback (`127.0.0.1`); follow INSTALL for private Tailscale access.
- Owner's chosen default (2026-10-11): dashboard-created and resumed Claude/Codex sessions and the manager start with permission
  prompts skipped (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) and folder trust pre-accepted.
  `AGENT_CMD_*` overrides win verbatim. V2 orchestration workers keep their own launch modes and refuse bypass flags;
  the exception is MiniMax `mcode exec` workers (developers and reviewers), which run `--permission full`, started in their V2
  worktree (`--cwd` is not a sandbox: they can run any host command, the same threat model as the dashboard default; D-023).
- The AI manager must never answer on the owner's behalf about deploys, merges to main, deletes, credentials, money or
  customers. The forbidden-topic filter always wins. Automatic answers are off by default.
