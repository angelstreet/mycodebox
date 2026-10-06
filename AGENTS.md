# AGENTS.md

Guidance for AI coding agents working in, or installing, this repo (mycodebox, repo name `ghosty-sessions`).

- **Install on a machine:** follow `docs/INSTALL.md`. It lists the prerequisites, the core steps, which optional
  features need what, and the security rules.
- **What the product is and every feature:** `README.md`. Developer hand-over notes: `HANDOVER.md`.

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
- UI icons come from `public/icons.js`; add an icon there instead of pasting emoji or one-off SVG.
- Match the surrounding code: terse comments that explain why, no new dependencies without a reason.

## Safety rules of the product

- The server has no login; the Tailscale tailnet is the only gate. Do not expose it publicly.
- The AI manager must never answer on the owner's behalf about deploys, merges to main, deletes, credentials, money or
  customers. The forbidden-topic filter always wins. Automatic answers are off by default.
