#!/usr/bin/env bash
# Restart ghosty-sessions only when no deploy is running (the deploy runner lives in this process: a restart kills a
# running deploy mid-build and it ends as failed).
#   scripts/safe-restart.sh            refuse (exit 1) while a deploy is running
#   scripts/safe-restart.sh --wait 15  wait up to 15 minutes for the running deploy to finish, then restart
set -euo pipefail
WAIT_MIN=0
[ "${1:-}" = "--wait" ] && WAIT_MIN="${2:-10}"
BASE="${GHOSTY_URL:-http://localhost:7777}"

running() {   # prints the running deploys (empty = none); an unreachable API counts as "none running"
  curl -s -m 5 "$BASE/api/deploys" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
r = [x for x in d.get('deploys', []) if x.get('state') == 'running'] 
r = r or list((d.get('running') or {}).items())
for x in r: print(x if not isinstance(x, dict) else f\"{x.get('id')} {x.get('env')} {x.get('scope')} {x.get('ref')}\")
" 2>/dev/null || true
}

deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
while :; do
  R="$(running)"
  [ -z "$R" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "NOT restarting: a deploy is running:" >&2; echo "$R" >&2
    echo "wait for its done event, or use: scripts/safe-restart.sh --wait 15" >&2
    exit 1
  fi
  echo "deploy running ($R), waiting..." >&2; sleep 15
done

if sudo -n systemctl restart ghosty-sessions 2>/dev/null; then echo "restarted via systemctl"; exit 0; fi
PID="$(systemctl show ghosty-sessions -p MainPID --value 2>/dev/null || true)"
[ -n "$PID" ] && [ "$PID" != "0" ] || { echo "no main pid" >&2; exit 2; }
kill -9 "$PID"        # Restart=on-failure brings it straight back
sleep 6
echo "restarted (pid $PID -> $(systemctl show ghosty-sessions -p MainPID --value))"
