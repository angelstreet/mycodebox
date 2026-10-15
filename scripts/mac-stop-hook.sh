#!/bin/sh
# mycodebox Stop hook for Claude Code on another machine (macOS): posts the session's FINAL assistant message to the dashboard's
# manager and, while the manager decides, waits for its answer. See docs/MAC-HOOK.md. POSIX sh + curl + awk/sed only (all on macOS by default).
#   ~/.claude/settings.json  hooks.Stop -> this script;  stdin = the hook JSON ({session_id, transcript_path, cwd, stop_hook_active, ...})
#   usage: mac-stop-hook.sh [--dry-run]   (--dry-run prints the payload that would be sent and sends nothing)
# Fails open FOR THE SESSION: any error exits 0 and the session simply stops as it does today. It sends nothing when the token file is
# missing or readable by others. Output on a manager answer: {"decision":"block","reason":"<answer>"} (Claude Code then continues with it).
#
# Transcript field path used (JSONL, one JSON object per line, compact):
#   assistant text : the LAST line with  "type":"assistant"  that holds  {"type":"text","text":"..."}  blocks -> message.content[].text
#   owner prompt   : the LAST line with  "type":"user"  whose  "content":"..."  is a string (not a tool_result list) -> its "timestamp"
#   session name   : the last  "customTitle":"..."  line, when Claude Code wrote one (/rename); else <project>-<first 6 of session_id>
# Newer Claude Code passes last_assistant_message in the hook JSON; it wins over the transcript (the transcript can lag the hook).
# Text stays JSON-escaped end to end: nothing is unescaped, so odd characters cannot break the payload.

DRY=0
[ "$1" = "--dry-run" ] && DRY=1
CFG_DIR="${MYCODEBOX_CONFIG_DIR:-$HOME/.config/mycodebox}"
MAX_TEXT=12000

log() { printf 'mycodebox-hook: %s\n' "$*" >&2; }
bail() { [ "$DRY" = 1 ] && log "$*"; exit 0; }             # silent for the session, loud in a dry run
trap 'exit 0' EXIT INT TERM HUP                             # whatever happens below, the session is never blocked by a failure

[ "${MYCODEBOX_HOOK:-}" = "off" ] && exit 0
[ -e "$CFG_DIR/disabled" ] && exit 0

# --- config (parsed, never sourced) and token ---
cfg() { [ -r "$CFG_DIR/config" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CFG_DIR/config" | tail -n 1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/'; }
URL=$(cfg url); WAIT=$(cfg wait)
case "$URL" in http://*|https://*) ;; *) URL="" ;; esac
URL=${URL%/}
case "$WAIT" in ''|*[!0-9]*) WAIT=45 ;; esac
[ "$WAIT" -gt 120 ] && WAIT=120
mode_of() { if [ "$(uname -s)" = Darwin ]; then stat -f %Lp "$1" 2>/dev/null; else stat -c %a "$1" 2>/dev/null; fi; }   # BSD stat on macOS; GNU stat elsewhere (tests)
TOKEN=""
TOKEN_OK=0
if [ -f "$CFG_DIR/token" ]; then
  M=$(mode_of "$CFG_DIR/token")
  case "$M" in
    ""|*[!0-7]*) log "cannot read the mode of $CFG_DIR/token" ;;
    *) if [ "$(( 0$M & 077 ))" -eq 0 ]; then TOKEN=$(tr -d '\r\n ' < "$CFG_DIR/token"); [ -n "$TOKEN" ] && TOKEN_OK=1; else log "$CFG_DIR/token must be mode 600 (it is $M): nothing is sent"; fi ;;
  esac
else
  [ "$DRY" = 1 ] && log "no token file at $CFG_DIR/token: nothing would be sent"
fi
if [ "$DRY" = 0 ]; then
  [ "$TOKEN_OK" = 1 ] || exit 0
  [ -n "$URL" ] || exit 0
fi

# --- the hook JSON ---
IN=$(cat)
field() { printf '%s' "$IN" | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" | head -n 1; }
SESSION_ID=$(field session_id); TPATH=$(field transcript_path); CWD=$(field cwd)
ACTIVE=false; printf '%s' "$IN" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && ACTIVE=true
[ -n "$SESSION_ID" ] || bail "no session_id in the hook input"

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }
unesc_path() { printf '%s' "$1" | sed 's/\\\//\//g; s/\\\\/\\/g'; }

# --- the last assistant message (already JSON-escaped) ---
extract_text() {   # stdin: one JSONL line -> the joined text blocks, still escaped
  awk -v max="$MAX_TEXT" '{
    s = $0; out = ""
    while (match(s, /"type": *"text", *"text": *"([^"\\]|\\.)*"/)) {
      seg = substr(s, RSTART, RLENGTH); sub(/^"type": *"text", *"text": *"/, "", seg); sub(/"$/, "", seg)
      out = out (out == "" ? "" : "\\n\\n") seg; s = substr(s, RSTART + RLENGTH)
    }
    if (length(out) > max) { out = substr(out, length(out) - max + 1); sub(/^[\\"]+/, "", out) }
    print out
  }'
}
TEXT=$(field last_assistant_message)
TP=$(unesc_path "$TPATH")
if [ -z "$TEXT" ] && [ -n "$TP" ] && [ -r "$TP" ]; then
  TEXT=$(grep -E '"type": *"assistant"' "$TP" | grep -E '"type": *"text"' | tail -n 1 | extract_text)
else
  TEXT=$(printf '%s' "$TEXT" | awk -v max="$MAX_TEXT" '{ if (length($0) > max) { $0 = substr($0, length($0) - max + 1); sub(/^[\\"]+/, "") } print }')
fi
[ -n "$TEXT" ] || bail "no assistant text found (transcript: ${TP:-none})"

PROMPT_AT=""; NAME=""
if [ -n "$TP" ] && [ -r "$TP" ]; then
  PROMPT_AT=$(grep -E '"type": *"user"' "$TP" | grep -E '"content": *"' | grep -v '"tool_use_id"' | tail -n 1 | sed -n 's/.*"timestamp": *"\([0-9TZ:.+-]*\)".*/\1/p' | head -n 1)
  NAME=$(grep '"customTitle"' "$TP" | tail -n 1 | sed -nE 's/.*"customTitle": *"(([^"\\]|\\.)*)".*/\1/p' | head -n 1)
fi

# --- machine / project ---
MACHINE=$(scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || hostname 2>/dev/null)
[ -n "$MACHINE" ] || MACHINE=unknown-machine
WD=$(unesc_path "$CWD")
TOP=""
[ -n "$WD" ] && [ -d "$WD" ] && TOP=$(git -C "$WD" rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(basename "${TOP:-${WD:-unknown}}")
[ -n "$NAME" ] || NAME="${PROJECT}-$(printf '%s' "$SESSION_ID" | cut -c1-6)"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

PAYLOAD="{\"machine\":\"$(esc "$MACHINE")\",\"project\":\"$(esc "$PROJECT")\",\"session_id\":\"$(esc "$SESSION_ID")\",\"session_name\":\"$(printf '%s' "$NAME" | sed 's/[^A-Za-z0-9 ._@:+-]/-/g' | cut -c1-80)\",\"cwd\":\"$(esc "$WD")\",\"text\":\"$TEXT\",\"stop_hook_active\":$ACTIVE,\"at\":\"$NOW\""
[ -n "$PROMPT_AT" ] && PAYLOAD="$PAYLOAD,\"prompt_at\":\"$PROMPT_AT\""
[ -n "${MYCODEBOX_RC_URL:-}" ] && PAYLOAD="$PAYLOAD,\"remote_control_url\":\"$(esc "$MYCODEBOX_RC_URL")\""
PAYLOAD="$PAYLOAD}"

if [ "$DRY" = 1 ]; then
  printf '%s\n' "$PAYLOAD"
  log "dry run: would POST to ${URL:-<url missing in $CFG_DIR/config>}/api/remote/v1/stops and wait up to ${WAIT}s for an answer; token ok=$TOKEN_OK"
  exit 0
fi

# --- send (the token goes in a 0600 header file, never on the command line) ---
HDR=$(mktemp "${TMPDIR:-/tmp}/mycodebox-hook.XXXXXX") || exit 0
chmod 600 "$HDR"
trap 'rm -f "$HDR"; exit 0' EXIT INT TERM HUP
printf 'authorization: Bearer %s\ncontent-type: application/json\n' "$TOKEN" > "$HDR"
RESP=$(printf '%s' "$PAYLOAD" | curl -sS --max-time 10 -H "@$HDR" --data-binary @- "$URL/api/remote/v1/stops" 2>/dev/null) || exit 0
ID=$(printf '%s' "$RESP" | sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p')
[ -n "$ID" ] || exit 0
[ "$ACTIVE" = true ] && exit 0                                   # loop guard: the stop is journalled, never answered
printf '%s' "$RESP" | grep -q '"answerable":false' && exit 0
MAXW=$(printf '%s' "$RESP" | sed -n 's/.*"wait_max_s":\([0-9]*\).*/\1/p'); case "$MAXW" in ''|*[!0-9]*) MAXW=$WAIT ;; esac
[ "$MAXW" -lt "$WAIT" ] && WAIT=$MAXW

# --- wait for the manager's answer (long-poll; the server also ends it on escalation or a cancelled countdown) ---
START=$(date +%s)
while :; do
  LEFT=$(( WAIT - ( $(date +%s) - START ) ))
  [ "$LEFT" -le 0 ] && exit 0
  R=$(curl -sS --max-time $(( LEFT + 8 )) -H "@$HDR" "$URL/api/remote/v1/stops/$ID/answer?wait=$LEFT" 2>/dev/null) || exit 0
  case "$R" in
    *'"state":"pending"'*) sleep 1 ;;
    *'"state":"answered"'*)
      ANS=$(printf '%s' "$R" | sed -nE 's/.*"answer":"(([^"\\]|\\.)*)".*/\1/p' | head -n 1)
      [ -n "$ANS" ] || exit 0
      printf '{"decision":"block","reason":"Answer from the mycodebox manager on behalf of the owner (the owner can correct it): %s"}\n' "$ANS"
      exit 0 ;;
    *) exit 0 ;;
  esac
done
