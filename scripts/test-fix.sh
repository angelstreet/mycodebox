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
#
# Accepts two caller forms per arg:
#   test/browser/qf-NN-...py                          — run every test_* in the file
#   test/browser/qf-NN-...py::test_specific_one        — run exactly that one
overall=0
for arg in "$@"; do
  # If the caller already passed a `file::test_id`, split it; otherwise
  # the spec path is the file and we collect all test_* IDs from it.
  if [[ "$arg" == *"::"* ]]; then
    file="${arg%%::*}"; tid="${arg##*::}"
    specs_to_run=("$tid")
  else
    file="$arg"
    mapfile -t specs_to_run < <(GHOSTY_URL="http://localhost:7778" pytest --collect-only -q "$file" \
          | sed -n 's/^.*:://p' | sed 's/[][\.*?^$()+{}|]//g' \
          | awk -F'[ .]' '{print $1}' | sort -u | grep -E '^test_')
  fi
  for tid in "${specs_to_run[@]}"; do
    echo "--- pytest $file::$tid ---"
    set +e
    GHOSTY_URL="http://localhost:7778" pytest -v "$file::$tid"
    code=$?
    set -e
    if [[ $code -ne 0 ]]; then overall=$code; fi
  done
done

bash scripts/test-server.sh stop
exit "$overall"
