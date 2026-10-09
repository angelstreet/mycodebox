#!/usr/bin/env bash
# scripts/test-server.sh — start a worktree-local ghosty daemon on a
# separate port for Playwright tests. Uses a throwaway STATE_DIR so the
# running live daemon on :7777 is never touched.
#
# Usage:
#   bash scripts/test-server.sh start   # background, prints PID, exits
#   bash scripts/test-server.sh stop    # stop the running instance
#   bash scripts/test-server.sh         # foreground (Ctrl-C to stop)
#
# Env (overrides):
#   GHOSTY_TEST_PORT   default 7778
#   GHOSTY_TEST_STATE  default mktemp -d /tmp/ghosty-test-state.XXXXXX
#
# Always exports GHOSTY_URL=http://localhost:$GHOSTY_TEST_PORT so a
# following `pytest test/browser/qf-NN-*.py` hits the worktree daemon,
# not the live :7777.

set -euo pipefail
PORT="${GHOSTY_TEST_PORT:-7778}"
PIDFILE="${GHOSTY_TEST_PIDFILE:-/tmp/ghosty-test-server.pid}"
LOGFILE="${GHOSTY_TEST_LOGFILE:-/tmp/ghosty-test-server.log}"

case "${1:-fg}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid=$(cat "$PIDFILE"), port=$PORT)"
      exit 0
    fi
    STATE_DIR="${GHOSTY_TEST_STATE:-$(mktemp -d /tmp/ghosty-test-state.XXXXXX)}"
    PORT="$PORT" GHOSTY_STATE_DIR="$STATE_DIR" nohup node server.js \
      >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    # wait until /api/sessions is up (≤ 5 s)
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sS -o /dev/null -m 1 "http://localhost:$PORT/api/sessions"; then
        echo "test server up: http://localhost:$PORT (pid=$(cat "$PIDFILE"), state=$STATE_DIR, log=$LOGFILE)"
        exit 0
      fi
      sleep 0.5
    done
    echo "test server failed to start within 5 s — see $LOGFILE" >&2
    exit 1
    ;;
  stop)
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      kill "$PID" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "test server stopped (pid=$PID)"
    else
      echo "no pidfile ($PIDFILE) — nothing to stop"
    fi
    exit 0
    ;;
  fg|"")
    STATE_DIR="${GHOSTY_TEST_STATE:-$(mktemp -d /tmp/ghosty-test-state.XXXXXX)}"
    echo "test server starting (state=$STATE_DIR, port=$PORT, log=$LOGFILE)"
    PORT="$PORT" GHOSTY_STATE_DIR="$STATE_DIR" exec node server.js
    ;;
  *)
    echo "usage: $0 [start|stop|fg]" >&2
    exit 2
    ;;
esac
