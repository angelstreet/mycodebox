#!/usr/bin/env bash
# Restart the manager agent in a FRESH Claude session (short context = cheap wakes). Its state lives in files
# (manager.json, manager-actions.jsonl, manager-events.jsonl + its last-seen, MANAGER.md), so nothing that matters is lost.
# Waits (up to 60 min) until the manager is idle with no draft, /exit, relaunch on Opus, send the restart kickoff.
#   scripts/manager-fresh.sh            (cron: nightly)
set -euo pipefail
S=manager; BASE="${GHOSTY_URL:-http://127.0.0.1:7777}"; H=(-H 'content-type: application/json' -H "origin: $BASE")
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# The timer's PATH may lack the user-local CLI dir the old hard-coded path used.
export PATH="$HOME/.local/bin:$PATH"
CMD=$(node "$SCRIPT_DIR/manager-command.js")
state() { curl -s -m 5 "$BASE/api/sessions" | python3 -c "import json,sys;v=json.load(sys.stdin)['status'].get('$S',{});s=v.get('stall') if isinstance(v.get('stall'),dict) else {};print(v.get('state'), 'draft' if s.get('draft') else 'ok')"; }
# Abort BEFORE touching tmux if the launch command cannot run: typing it into a shell would only print "command not found",
# and the KICK text after it would then be typed into that bare shell. Skip leading VAR=value words (env prefixes).
exe=
for w in $CMD; do case "$w" in *=*) ;; *) exe=$w; break;; esac; done
if [ -z "$exe" ] || ! command -v "$exe" >/dev/null 2>&1; then
  echo "manager command not found: '${exe:-<empty>}' (check AGENT_CMD_CLAUDE and that its .env is loaded); not restarted" >&2; exit 1
fi
tmux has-session -t "=$S" 2>/dev/null || { echo "no $S session"; exit 1; }
for i in $(seq 1 120); do case "$(state)" in "done ok"|"idle ok") break;; esac; sleep 30; done
case "$(state)" in "done ok"|"idle ok") ;; *) echo "manager never idle, not restarted"; exit 1;; esac
git -C "$HOME/vpt-manager" fetch -q origin && git -C "$HOME/vpt-manager" checkout -q --detach origin/task44-ai-manager || true
pane=$(tmux display -p -t "=$S:" '#{pane_pid}')
curl -s -X POST "$BASE/api/send/$S" "${H[@]}" -d '{"keys":"/exit","enter":true}' >/dev/null
for i in $(seq 1 30); do
  pgrep -P "$pane" -f claude >/dev/null || break
  # /exit with background work (its waits, a scheduled sweep) asks first: option 1 "Exit and stop tasks" is preselected
  tmux capture-pane -p -t "=$S:" | grep -q "Exit and stop tasks" && tmux send-keys -t "=$S:" Enter
  sleep 1
done
pgrep -P "$pane" -f claude >/dev/null && { echo "claude did not exit"; exit 1; }
tmux send-keys -t "=$S:" -l "$CMD"; sleep 0.3; tmux send-keys -t "=$S:" Enter
ready=0
for i in $(seq 1 30); do sleep 2; if tmux capture-pane -p -t "=$S:" | grep -q "remote-control is active"; then ready=1; break; fi; done
# Never type the kickoff into a pane that is not the agent (launch failed, bare shell, login prompt).
[ "$ready" = 1 ] || { echo "manager did not report remote-control active in 60s; kickoff NOT sent" >&2; exit 1; }
sleep 3
KICK='Fresh start of the AI manager (nightly restart, short context on purpose). Read ~/vpt-manager/docs/tasks/TASK-44-MANAGER.md (§0 start, §2 authority, §4 loop, §5 actions, §5b delegating, §6 escalation, §7 report) and ~/vpt-manager/docs/tasks/TASK-44-ai-manager.md. Your settings are in ~/.local/state/ghosty/manager.json (owner delegations already recorded: keep them). Resume from your last-seen event (GET /api/manager/events?since=<last at in ~/.local/state/ghosty/manager-actions.jsonl or your last-seen file>) and the open items in manager-actions.jsonl / manager-asks.jsonl. Wait for events ONLY with `Bash run_in_background: ~/ghosty-sessions/scripts/manager-wait.sh` (it exits on the first filtered event; re-run it after each wake) — never a Monitor (its 30-min expiry wakes you for nothing). Hourly sweep with ScheduleWakeup as before. Stay lean: short wakes, delegate building. Budget = tokens and % of the weekly Claude plan (scorecard), never dollars.'
python3 -c "import json,sys;print(json.dumps({'keys':sys.argv[1],'enter':True}))" "$KICK" | curl -s -X POST "$BASE/api/send/$S" "${H[@]}" -d @- >/dev/null
echo "manager restarted fresh at $(date -u +%FT%TZ)"
