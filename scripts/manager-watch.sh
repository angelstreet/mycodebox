#!/usr/bin/env bash
# Token-free watchdog for the AI manager tmux session (every 5 min, see systemd/ghosty-manager-watch.timer).
# The manager died silently twice: (a) manager-fresh.sh sent /exit and the relaunch failed readiness, leaving a bare
# shell pane; (b) it ended a turn with no background waiter and no wakeup, so nothing ever woke it again. This script
# covers both: a dead pane is relaunched, a live pane that stopped taking turns gets one nudge. No tokens, no LLM.
#   scripts/manager-watch.sh            (systemd timer)
#   scripts/manager-watch.sh --dry-run  (print the decision only: no send, no relaunch, no stamp)
set -uo pipefail
S=manager; BASE="${GHOSTY_URL:-http://127.0.0.1:7777}"; H=(-H 'content-type: application/json' -H "origin: $BASE")
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/pane-has-claude.sh"
STATE_DIR="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
STAMP="$STATE_DIR/manager-watch.last"; EVENTS="$STATE_DIR/manager-events.jsonl"; WAKES="$STATE_DIR/manager-wakes.jsonl"
STALE_MS=$((75*60*1000)); DEBOUNCE_MS=$((60*60*1000))   # dead-loop threshold, one nudge per hour
DRY=0; if [ "${1:-}" = "--dry-run" ]; then DRY=1; fi
NUDGE='Watchdog: no wake for 75 min, your loop is dead. Relaunch `Bash run_in_background: ~/ghosty-sessions/scripts/manager-wait.sh` and ScheduleWakeup the hourly sweep (TASK-44-MANAGER.md §4), then do one sweep. Do not ask the owner anything already in manager-asks.jsonl.'
say() { echo "manager-watch: $1"; }

# Milliseconds of the newest wake from the wakes log, 0 when there is none. A manager turn is no signal here: manager
# sessions record no reporter turn (they are excluded from stop reporting) and lastSendAt only moves when someone
# types, so a manager waking on its own waiter or ScheduleWakeup read as dead after 75 min (2026-10-20, 08:52 wake,
# 08:53 nudge). Missing/unreadable log -> 0, i.e. the old turn/send behaviour. `end` is null while a wake is open, so
# fall back to `start`.
lastWake() {
  [ -r "$WAKES" ] || { echo 0; return; }
  tail -n 1 "$WAKES" 2>/dev/null | python3 -c "
import datetime,json,sys
try: w=json.loads(sys.stdin.read() or '{}')
except Exception: w={}
t=w.get('end') or w.get('start')
try: print(int(datetime.datetime.fromisoformat(str(t).replace('Z','+00:00')).timestamp()*1000))
except Exception: print(0)
" 2>/dev/null || echo 0
}

# No manager session to guard: nothing to do, and not an error (the session may be created later).
tmux has-session -t "=$S" 2>/dev/null || { say "no $S session, nothing to do"; exit 0; }
pane=$(tmux display -p -t "=$S:" '#{pane_pid}')

# No claude process under the pane means the agent is dead (bare shell). --now skips the idle wait and the /exit
# (nothing to exit) and relaunches on top; the command-exists and readiness checks inside still apply.
if ! pane_has_claude "$pane"; then
  if [ "$DRY" = 1 ]; then say "dry-run: pane $pane has no claude process, would run manager-fresh.sh --now (relaunch dead manager)"; exit 0; fi
  say "pane $pane has no claude process: relaunching"
  "$SCRIPT_DIR/manager-fresh.sh" --now && say "relaunched dead manager at $(date -u +%FT%TZ)" || say "relaunch failed (manager-fresh.sh exited non-zero)"
  exit 0
fi

# An empty or half-written body means the dashboard is restarting: exit quietly rather than nagging a healthy manager.
info=$(curl -s -m 5 "$BASE/api/sessions" | python3 -c "
import json,sys
def ms(v): return int(v) if isinstance(v,(int,float)) else 0
try: m=json.load(sys.stdin)['status'].get('$S',{})
except Exception: sys.exit(1)
r=m.get('reporter') if isinstance(m.get('reporter'),dict) else {}
print(m.get('state') or 'unknown', ms(r.get('turnAt')), ms(m.get('lastSendAt')))
" 2>/dev/null) || { say "dashboard unreachable or invalid JSON, nothing to do"; exit 0; }
[ -n "$info" ] || { say "empty session status, nothing to do"; exit 0; }
read -r st turnAt lastSendAt <<<"$info"
say "manager alive, state=$st lastTurn=${turnAt:-0} lastSend=${lastSendAt:-0}"

# Never interrupt a manager that is working: it may be mid-turn with a background waiter already armed.
[ "$st" = working ] && exit 0

now=$(date +%s%3N)
last=$(( turnAt > lastSendAt ? turnAt : lastSendAt ))
wakeAt=$(lastWake); case "$wakeAt" in ''|*[!0-9]*) wakeAt=0;; esac   # never let a garbage wake time into the arithmetic
[ "$wakeAt" -gt "$last" ] && last=$wakeAt
age=$(( now - last ))
[ "$age" -ge "$STALE_MS" ] || { say "last turn/send $(( age/60000 )) min ago (< 75), nothing to do"; exit 0; }

# Debounce: one nudge per hour. The stamp also remembers the turnAt at that nudge, so two nudges in a row with an
# unchanged turnAt can be reported as an unresponsive manager.
lastNudge=0; lastTurn=0; streak=0
if [ -r "$STAMP" ]; then read -r lastNudge lastTurn streak < "$STAMP" || true; fi
case "$lastNudge$lastTurn$streak" in *[!0-9]*) lastNudge=0; lastTurn=0; streak=0;; esac
if [ "$lastNudge" -gt 0 ]; then
  mins=$(( (now - lastNudge)/60000 ))
  [ "$mins" -ge 60 ] || { say "last nudge ${mins} min ago, debounced"; exit 0; }
fi
# Second consecutive nudge with no new turn since the previous one: the nudge is not waking it. Report once per
# stall episode, then keep nudging on the same hourly cadence (restarting is not an option, claude is alive).
if [ "$lastNudge" -gt 0 ] && [ "$lastTurn" -eq "$turnAt" ]; then
  streak=$(( streak + 1 ))
  if [ "$streak" -eq 1 ] && [ "$DRY" = 0 ]; then
    mkdir -p "$STATE_DIR"
    # Same shape as health-watch.js buildEvent(): key/title/body/url/priority, no legacy "text".
    python3 -c 'import json,sys;print(json.dumps({"at":sys.argv[1],"key":"health:manager-unresponsive","kind":"health","session":"health","title":"manager unresponsive to watchdog","body":"two hourly nudges, no new turn; claude process alive in tmux manager","url":"/?s=manager","priority":"high"}))' "$(date -u +%FT%T.%3NZ)" >> "$EVENTS"
    say "no new turn since the last nudge: logged 'manager unresponsive to watchdog' in $EVENTS"
  fi
else
  streak=0
fi

if [ "$DRY" = 1 ]; then say "dry-run: last turn/send $(( age/60000 )) min ago (> 75) with state=$st, would nudge the manager"; exit 0; fi
mkdir -p "$STATE_DIR"
python3 -c "import json,sys;print(json.dumps({'keys':sys.argv[1],'enter':True}))" "$NUDGE" | curl -s -X POST "$BASE/api/send/$S" "${H[@]}" -d @- >/dev/null
printf '%s %s %s\n' "$now" "$turnAt" "$streak" > "$STAMP"
say "nudged the manager at $(date -u +%FT%TZ) (no turn for $(( age/60000 )) min)"