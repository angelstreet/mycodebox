#!/bin/bash
# Nightly RTSP check + replace (owner, 2026-11-11): starts one MiniMax session that runs scripts/agent/rtsp_replace.py
# and follows docs/RTSP-NIGHTLY.md. Started by ~/.config/systemd/user/rtsp-nightly.timer (systemd/rtsp-nightly.*).
#
# Mode: `dry` (report only, no writes) unless <state>/rtsp-nightly/mode says `live`. The owner/manager flips it:
#   echo live > ~/.local/state/ghosty/rtsp-nightly/mode      (back: echo dry > ...)
# Private config (server URLs, ssh aliases: never in the repo): ~/.config/rtsp-nightly/env, sourced here, e.g.
#   RTSP_CHECK_SERVERS="<label>=<server url>,<label2>=<server url2>"
#   RTSP_CHECK_SSH="<host>=<ssh alias>,..."
set -uo pipefail
export PATH=/home/jndoye/.local/bin:/usr/local/bin:/bin:/usr/bin
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}/rtsp-nightly
mkdir -p "$STATE"
MODE=$(tr -d '[:space:]' < "$STATE/mode" 2>/dev/null || true)
[ "$MODE" = live ] || MODE=dry
CONF=$HOME/.config/rtsp-nightly/env
[ -r "$CONF" ] || echo "rtsp-nightly: $CONF missing: the session will report 'no servers'" >&2
# The prompt names the mode; the session sources the private config itself.
PROMPT=$(mktemp "$STATE/prompt-XXXXXX.md")
{ sed "s/__MODE__/$MODE/g" "$HERE/prompt.md"; } > "$PROMPT"
exec cbsession -n "rtsp-nightly-$(date -u +%Y%m%d)" -d "$HOME/ghosty-sessions" -p minimax -f "$PROMPT"
