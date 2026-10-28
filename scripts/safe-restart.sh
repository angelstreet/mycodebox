#!/usr/bin/env bash
# A fresh idle snapshot is required twice; this is a guard, not an atomic deploy lease.
#   scripts/safe-restart.sh            refuse while work can run
#   scripts/safe-restart.sh --wait 15  wait up to 15 minutes for work to finish
set -euo pipefail
WAIT_MIN=0
if [ "$#" -gt 0 ]; then
  if [ "$1" != '--wait' ] || [ "$#" -gt 2 ]; then
    echo 'usage: scripts/safe-restart.sh [--wait [minutes]]' >&2; exit 2
  fi
  WAIT_MIN="${2-10}"
  # Bound arithmetic input before expansion; one day is the maximum wait.
  if ! [[ "$WAIT_MIN" =~ ^[0-9]{1,4}$ ]] || [ "$((10#$WAIT_MIN))" -gt 1440 ]; then
    echo 'wait minutes must be an integer from 0 to 1440' >&2; exit 2
  fi
  WAIT_MIN=$((10#$WAIT_MIN))
fi
BASE="${GHOSTY_URL:-http://localhost:7777}"

check_idle() {
  local response now
  if ! response=$(curl --fail --silent --show-error --max-time 5 --write-out '\n%{http_code}' "$BASE/api/deploys"); then
    echo 'NOT restarting: deploy API unavailable' >&2; return 2
  fi
  now=$(date +%s%3N)
  # Exit 1 means known busy; exit 3 means the registry is unavailable (retried under --wait, never idle); exit 2 means unknown.
  printf '%s' "$response" | python3 -c '
import json, math, sys
try:
    raw, status = sys.stdin.read().rsplit("\n", 1)
    if len(status) != 3 or not status.isdecimal() or not 200 <= int(status) < 300:
        raise ValueError()
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError()
            result[key] = value
        return result
    d = json.loads(raw, object_pairs_hook=unique)
    # The runner could not read the lease registry (service down, mid-deploy): a transient unknown. Name the cause and let
    # --wait retry (exit 3); it is never read as idle. A stale timestamp or a missing error text stays a plain refusal.
    if isinstance(d, dict) and d.get("ok") is False and isinstance(d.get("error"), str) and d["error"] and type(d.get("at")) in (int, float) and 0 <= int(sys.argv[1]) - d["at"] <= 60000:
        print("NOT restarting: lease registry unavailable (" + d["error"][:200].replace("\n", " ") + ")", file=sys.stderr)
        sys.exit(3)
    if not isinstance(d, dict) or d.get("ok") is not True or d.get("error") != "": raise ValueError()
    at = d.get("at")
    if type(at) not in (int, float) or not math.isfinite(at) or not 0 <= int(sys.argv[1]) - at <= 60000: raise ValueError()
    if type(d.get("enabled")) is not bool or not isinstance(d.get("running"), dict): raise ValueError()
    if not isinstance(d.get("deploys"), list): raise ValueError()
    if not isinstance(d.get("envs"), list) or any(not isinstance(e, str) or not e for e in d["envs"]): raise ValueError()
    if any(not key or not isinstance(value, str) or not value for key, value in d["running"].items()): raise ValueError()
    states = {"awaiting-approval", "queued", "approved", "running", "done", "failed", "cancelled"}
    ids = set()
    busy = bool(d["running"])
    for item in d["deploys"]:
        if not isinstance(item, dict) or item.get("state") not in states: raise ValueError()
        if any(not isinstance(item.get(k), str) or not item[k] for k in ("id", "env")): raise ValueError()
        if "blocked" in item and type(item["blocked"]) is not bool: raise ValueError()
        if item["id"] in ids: raise ValueError()
        ids.add(item["id"])
        # awaiting-approval does NOT block: it can only be approved after the restart (it would deadlock the restart)
        # approved = owner said yes, the runner starts it as soon as its leases are free: busy whether or not the runner is on
        # `blocked` (runner Q199) = the last start attempt for the deploy was refused (a held lease or a ticket): it
        # cannot start before the restart, so it is not pending work. An older server without the field keeps the safe rule.
        blocked = item.get("blocked", False)
        busy |= item["state"] == "running" or (not blocked and (item["state"] == "approved" or (d["enabled"] and item["state"] == "queued")))
except Exception:
    print("NOT restarting: invalid, unsuccessful, or stale deploy snapshot", file=sys.stderr)
    sys.exit(2)
sys.exit(1 if busy else 0)
' "$now"
}

deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
while :; do
  if check_idle; then
    # Recheck immediately before the operation; a subsequent deploy race still requires a lease to prevent.
    if check_idle; then break; else status=$?; fi
  else
    status=$?
  fi
  { [ "$status" -eq 1 ] || { [ "$status" -eq 3 ] && [ "$WAIT_MIN" -gt 0 ]; }; } || exit 2
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$status" -eq 3 ]; then echo 'NOT restarting: the lease registry stayed unavailable for the whole wait' >&2; exit 2; fi
    echo 'NOT restarting: deploy work is running or can start automatically' >&2
    echo 'wait for completion, or use: scripts/safe-restart.sh --wait 15' >&2
    exit 1
  fi
  [ "$status" -eq 3 ] && echo 'lease registry unavailable, waiting...' >&2 || echo 'deploy work pending, waiting...' >&2
  sleep 15
done

if sudo -n systemctl restart ghosty-sessions; then
  echo 'restarted via systemctl'
else
  echo 'restart failed; no PID fallback attempted' >&2
  exit 2
fi
