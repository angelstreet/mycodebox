#!/usr/bin/env bash
# scripts/test-fix.sh <QF-NN-spec> [more specs...] — start the worktree
# test server on :7778, run the given Playwright specs with the verifier
# pass, and stop the server. Lets a `verifier` sub-agent (or this script
# directly) test ANY fix headless without touching the live :7777 daemon.
#
# Examples:
#   bash scripts/test-fix.sh test/browser/qf-15-pill-vs-jump.py
#   bash scripts/test-fix.sh test/browser/qf-14-dock-layout.py test/browser/qf-15-pill-vs-jump.py
#
# Exit code: 0 if all specs pass, non-zero otherwise. The test server is
# always stopped before exiting (no leaked :7778 daemons).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <spec.py> [more specs...]" >&2
  exit 2
fi

# Start the worktree server. Idempotent — if it's already running, the
# start command exits 0 and we reuse it.
bash scripts/test-server.sh start

# Run each TEST FUNCTION (each `def test_*(...)` in any spec file) in
# its own pytest subprocess. Sharing a pytest process across multiple
# test_* functions in the same file fails on the 2nd+ because
# pytest-asyncio leaves an asyncio loop running, and Playwright's
# sync_playwright refuses to start inside one ("Please use the Async
# API instead"). Splitting by test ID sidesteps it permanently —
# no spec file is ever limited to one test again.
overall=0
for spec in "$@"; do
  ids=$(GHOSTY_URL="http://localhost:7778" pytest --collect-only -q "$spec" \
          | sed -n 's/^.*:://p' | sed 's/[][\.*?^$()+{}|]//g' \
          | awk -F'[ .]' '{print $1}' | sort -u | grep -E '^test_')
  for tid in $ids; do
    echo "--- pytest $spec::$tid ---"
    set +e
    GHOSTY_URL="http://localhost:7778" pytest -v "$spec::$tid"
    code=$?
    set -e
    if [[ $code -ne 0 ]]; then overall=$code; fi
  done
done

bash scripts/test-server.sh stop
exit "$overall"
