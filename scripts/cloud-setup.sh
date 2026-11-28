#!/usr/bin/env bash
# Dependencies for a Claude Code cloud session (claude.ai/code, `claude --cloud`) on mycodebox. Idempotent.
# A no-op outside the cloud (CLAUDE_CODE_REMOTE=true there) unless --force. Run by the cloud environment's
# setup script (docs/CLOUD.md) and safe to run again by hand: `bash scripts/cloud-setup.sh`.
# Code only: no .env, no state dir, no service. Tests need Node 20+ and `ws` (npm ci).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || [ "${1:-}" = --force ] || exit 0
cd "$(dirname "$0")/.."
want=$(sha256sum package-lock.json | cut -c1-64)
stamp=node_modules/.cloud-setup
if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
fi
echo "cloud-setup: mycodebox ready (node $(node -v)); run tests with: npm test"
