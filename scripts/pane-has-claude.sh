#!/usr/bin/env bash
# pane_has_claude <pane pid>: true when a claude process runs anywhere under the pane, not only as its direct child.
# The manager is started through a launch script (pane -> bash -c -> launch.sh -> claude), so `pgrep -P <pane>` alone
# misses it and the watchdog typed the launch command into the live session every 5 min (owner, 2026-10-29).
pane_has_claude() {
  local k
  for k in $(pgrep -P "$1" 2>/dev/null); do
    [ "$(ps -o comm= -p "$k" 2>/dev/null)" = claude ] && return 0
    pane_has_claude "$k" && return 0
  done
  return 1
}
