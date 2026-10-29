#!/usr/bin/env bash
# Restart the manager agent in a FRESH Claude session (short context = cheap wakes). Its state lives in files
# (manager.json, manager-actions.jsonl, manager-events.jsonl + its last-seen, MANAGER.md), so nothing that matters is lost.
# The relaunch reuses AGENT_CMD_CLAUDE (default skips permission prompts: owner decision 2026-10-11) and pre-accepts folder trust.
# Waits (up to 60 min) until the manager is idle with no draft, /exit, relaunch on Sonnet (MANAGER_MODEL overrides), send the restart kickoff.
#   scripts/manager-fresh.sh            (cron: nightly)
#   scripts/manager-fresh.sh --now      (manager-watch.sh: relaunch a dead manager without the wait and without /exit)
set -euo pipefail
S=manager; BASE="${GHOSTY_URL:-http://127.0.0.1:7777}"; H=(-H 'content-type: application/json' -H "origin: $BASE")
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/pane-has-claude.sh"
# The timer's PATH may lack the user-local CLI dir the old hard-coded path used.
export PATH="$HOME/.local/bin:$PATH"
CMD=$(node "$SCRIPT_DIR/manager-command.js")
NOW=0; if [ "${1:-}" = "--now" ]; then NOW=1; fi
# An unreachable dashboard (empty body) or a half-written one must not crash this with a traceback: report
# "unknown" and let the caller decide. "unknown" matches no restartable state, so the wait ends in "not restarted".
state() { curl -s -m 5 "$BASE/api/sessions" | python3 -c "
import json,sys
try: v=json.load(sys.stdin)['status'].get('$S',{})
except Exception: v={}
s=v.get('stall') if isinstance(v.get('stall'),dict) else {}
print(v.get('state') or 'unknown', 'draft' if s.get('draft') else 'ok')
"; }
# Abort BEFORE touching tmux if the launch command cannot run: typing it into a shell would only print "command not found",
# and the KICK text after it would then be typed into that bare shell. Skip leading VAR=value words (env prefixes).
exe=
# Also look through wrappers (env, exec, nohup, command) and their options to the real executable.
for w in $CMD; do case "$w" in *=*|env|exec|nohup|command|-*) ;; *) exe=$w; break;; esac; done
if [ -z "$exe" ] || ! command -v "$exe" >/dev/null 2>&1; then
  echo "manager command not found: '${exe:-<empty>}' (check AGENT_CMD_CLAUDE and that its .env is loaded); not restarted" >&2; exit 1
fi
tmux has-session -t "=$S" 2>/dev/null || { echo "no $S session"; exit 1; }
pane=$(tmux display -p -t "=$S:" '#{pane_pid}')
# A pane with no claude process under it is a bare shell: the manager is dead (its /exit succeeded and the relaunch
# failed readiness, or the agent was killed). --now then skips BOTH the idle wait and the /exit (there is nothing to
# exit, and no point waiting for an "idle" that can never come) and goes straight to trust + launch + readiness + kick.
# With claude still alive, --now behaves exactly like the normal mode.
dead=0; pane_has_claude "$pane" || dead=1
if [ "$NOW" = 1 ] && [ "$dead" = 1 ]; then
  echo "manager pane has no claude process: relaunching now (--now)"
else
  # "waiting ok" counts as restartable: the state lives in files, so a manager that ended its turn on a
  # needs-owner question keeps everything it wrote and just needs its loop restored.
  for i in $(seq 1 120); do case "$(state)" in "done ok"|"idle ok"|"waiting ok") break;; esac; sleep 30; done
  case "$(state)" in "done ok"|"idle ok"|"waiting ok") ;; *) echo "manager never idle, not restarted"; exit 1;; esac
  git -C "$HOME/vpt-manager" fetch -q origin && git -C "$HOME/vpt-manager" checkout -q --detach origin/task44-ai-manager || true
  curl -s -X POST "$BASE/api/send/$S" "${H[@]}" -d '{"keys":"/exit","enter":true}' >/dev/null
  for i in $(seq 1 30); do
    pane_has_claude "$pane" || break
    # /exit with background work (its waits, a scheduled sweep) asks first: option 1 "Exit and stop tasks" is preselected
    tmux capture-pane -p -t "=$S:" | grep -q "Exit and stop tasks" && tmux send-keys -t "=$S:" Enter
    sleep 1
  done
  pane_has_claude "$pane" && { echo "claude did not exit"; exit 1; }
fi
node --input-type=module -e "import {pathToFileURL} from 'node:url'; const {trustFolder}=await import(pathToFileURL(process.argv[1]).href); await trustFolder('claude', process.argv[2]).catch(()=>{})" "$SCRIPT_DIR/../trust.js" "$(tmux display -p -t "=$S:" '#{pane_current_path}')" || true   # best effort
tmux send-keys -t "=$S:" -l "$CMD"; sleep 0.3; tmux send-keys -t "=$S:" Enter
ready=0
# Current Claude Code no longer prints "remote-control is active" under --remote-control; it prints a session link
# (https://claude.ai/code/session_...) and the normal prompt footer ("bypass permissions on"). Accept any of them,
# but only when a claude process is actually running under the pane — a bare shell that happens to show an old
# link from a previous session must not count, otherwise the kickoff would land in the wrong pane.
for i in $(seq 1 30); do sleep 2; if pane_has_claude "$pane" && tmux capture-pane -p -t "=$S:" | grep -qE "remote-control is active|claude\.ai/code/session_|bypass permissions on"; then ready=1; break; fi; done
# Never type the kickoff into a pane that is not the agent (launch failed, bare shell, login prompt).
[ "$ready" = 1 ] || { echo "manager did not show readiness in 60s; kickoff NOT sent" >&2; exit 1; }
sleep 3
KICK='Fresh start of the AI manager (nightly restart, short context on purpose). Read ~/vpt-manager/docs/tasks/TASK-44-MANAGER.md (§0 start, §2 authority, §4 loop, §5 actions, §5b delegating, §6 escalation, §7 report) and ~/vpt-manager/docs/tasks/TASK-44-ai-manager.md. Your settings are in ~/.local/state/ghosty/manager.json (owner delegations already recorded: keep them). Resume from your last-seen event (GET /api/manager/events?since=<last at in ~/.local/state/ghosty/manager-actions.jsonl or your last-seen file>) and the open items in manager-actions.jsonl / manager-asks.jsonl. Wait for events ONLY with `Bash run_in_background: ~/ghosty-sessions/scripts/manager-wait.sh` (it exits on the first filtered event; re-run it after each wake) — never a Monitor (its 30-min expiry wakes you for nothing). Hourly sweep with ScheduleWakeup as before. Waiting rule: show a Waiting-for-you block only when something truly blocks the owner, and then also POST /api/alert; otherwise print nothing about waiting. Stay lean: short wakes, delegate building. Close finished children (owner, 2026-10-22): close a session you started (listed in manager-children.jsonl) via DELETE /api/sessions/<s>?confirm=<s> when it is done, has nothing unmerged or uncommitted, holds no lease and its report was relayed (manual §4); never close an owner-started or unregistered session. Budget = tokens and % of the weekly Claude plan (scorecard), never dollars. On every wake read ALL events (scripts/manager-wake-summary.sh) and run scripts/manager-status-scan.sh in every hourly sweep; a session whose last STATUS is needs-manager/needs-owner/blocked is never "idle".'
python3 -c "import json,sys;print(json.dumps({'keys':sys.argv[1],'enter':True}))" "$KICK" | curl -s -X POST "$BASE/api/send/$S" "${H[@]}" -d @- >/dev/null
echo "manager restarted fresh at $(date -u +%FT%TZ)"
