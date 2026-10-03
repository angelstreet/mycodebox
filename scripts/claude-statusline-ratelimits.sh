#!/usr/bin/env bash
# Claude Code status-line command that also records the subscription rate limits for ghosty.
# Claude Code passes a JSON document on stdin; for Pro/Max logins it contains
# rate_limits.five_hour / seven_day {used_percentage, resets_at} after the first reply of a session.
# This script writes them to $GHOSTY_STATE_DIR/claude-rate-limits.json (atomic) and prints a short
# status line. It reads nothing but stdin; it never touches credentials.
set -u
state="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
mkdir -p "$state"
in="$(cat)"
rl="$(printf '%s' "$in" | jq -c '.rate_limits // empty' 2>/dev/null)"
if [ -n "$rl" ]; then
  tmp="$(mktemp "$state/.claude-rl.XXXXXX")"
  printf '%s' "$rl" | jq -c --argjson at "$(date +%s%3N)" '{at: $at, rate_limits: .}' > "$tmp" && mv "$tmp" "$state/claude-rate-limits.json" || rm -f "$tmp"
fi
printf '%s' "$in" | jq -r '"\(.model.display_name // "claude")" + (if .rate_limits.five_hour then " 5h \(.rate_limits.five_hour.used_percentage | floor)%" else "" end) + (if .rate_limits.seven_day then " wk \(.rate_limits.seven_day.used_percentage | floor)%" else "" end)' 2>/dev/null || echo claude
