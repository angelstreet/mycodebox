#!/usr/bin/env bash
# Dependencies for a Claude Code cloud session (claude.ai/code, `claude --cloud`) on mycodebox. Idempotent.
# A no-op outside the cloud (CLAUDE_CODE_REMOTE=true there) unless --force. Run by the cloud environment's
# setup script (docs/CLOUD.md) and safe to run again by hand: `bash scripts/cloud-setup.sh`.
# Code only: no .env, no state dir, no service. Tests need Node 20+ and `ws` (npm ci).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || [ "${1:-}" = --force ] || exit 0
cd "$(dirname "$0")/.."
# Node 24, like codebox (owner-approved 2026-11-28): the cloud VM ships Node 22, where node --test prints TAP to a pipe and two
# tests failed only there. The npm registry is on the cloud's package-manager allowlist (nodejs.org may not be), so the binary
# comes from the node-linux-<arch> package; the VM's `node` is then pointed at it. Root only (the VM); elsewhere it only warns.
want_node=${CLOUD_NODE_MAJOR:-24}
# Exact version (security review 2026-11-28): a new release of the package is not installed as root unseen; bump on purpose.
node_ver=${CLOUD_NODE_VERSION:-24.22.3}
cur_node=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$cur_node" -lt "$want_node" ]; then
  case $(uname -m) in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch= ;; esac
  pre=${CLOUD_NODE_PREFIX:-/opt/node$want_node}
  bin=$pre/node_modules/node-linux-$arch/bin/node
  if [ -n "$arch" ] && { [ "$(id -u)" = 0 ] || [ -n "${CLOUD_NODE_PREFIX:-}" ]; } \
     && { [ -x "$bin" ] || npm install --prefix "$pre" --no-save --no-audit --no-fund --loglevel=error "node-linux-$arch@$node_ver" >/dev/null; } \
     && "$bin" -v >/dev/null; then
    ln -sf "$bin" "$(command -v node)"
    hash -r
  else
    echo "cloud-setup: could not switch to Node $want_node (still $(node -v)); tests run on it but may differ from codebox" >&2
  fi
fi
want=$(sha256sum package-lock.json | cut -c1-64)
stamp=node_modules/.cloud-setup
if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  # A codebox worktree may link node_modules to the live checkout; npm ci there empties the live folder (2026-11-28 outage).
  if [ -L node_modules ]; then echo "cloud-setup: node_modules is a symlink ($(readlink node_modules)); refusing npm ci" >&2; exit 2; fi
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
fi
echo "cloud-setup: mycodebox ready (node $(node -v)); run tests with: npm test"
