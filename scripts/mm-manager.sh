#!/usr/bin/env bash
# mm-manager (TASK-47 G11, SHADOW only): a manager loop run by MiniMax that proposes what the manager should
# do for each event, calls Sonnet only when in doubt, and NEVER acts. Compares against the real (Sonnet)
# manager via scripts/mm-manager-compare.js.
#
# Usage:
#   scripts/mm-manager.sh                        tail <state>/manager-events.jsonl and process batches
#   scripts/mm-manager.sh --once <file>          process the lines of <file> once and exit (tests/dry runs)
#   scripts/mm-manager.sh --dry                  with --once: write the prompt only, no mcode call
#
# Env (sane defaults):
#   GHOSTY_STATE_DIR   ~/.local/state/ghosty
#   GHOSTY_PORT        7777           (read-only GETs to 127.0.0.1 here)
#   BATCH_S            60             (seconds to collect lines after the first one)
#   MM_RUNBOOK         <repo>/.manager-s4.md   (decision table; built-in short table if missing)
#   MCODE              ~/.local/bin/mcode
#   NODE_BIN           ~/.local/node-v24.21.0-linux-x64/bin
#   MCODE_TIMEOUT      10m

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
GHOSTY_PORT="${GHOSTY_PORT:-7777}"
BATCH_S="${BATCH_S:-60}"
MM_RUNBOOK="${MM_RUNBOOK:-$REPO/.manager-s4.md}"
MCODE="${MCODE:-$HOME/.local/bin/mcode}"
NODE_BIN="${NODE_BIN:-$HOME/.local/node-v24.21.0-linux-x64/bin}"
MCODE_TIMEOUT="${MCODE_TIMEOUT:-10m}"

MM_LOG="$STATE_DIR/mm-manager-decisions.jsonl"
BATCH_DIR="$STATE_DIR/mm-manager"
LOCK_DIR="$STATE_DIR/mm-manager.lock"

mode="tail"
once_file=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --once) once_file="${2:-}"; mode="once"; shift 2;;
    --dry) dry=1; shift;;
    -h|--help)
      sed -n '2,/^[^#]/p' "$0" | sed '/^$/d' | head -n 40
      exit 0
      ;;
    *)
      echo "mm-manager: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$STATE_DIR" "$BATCH_DIR" 2>/dev/null || true

# Lock (mkdir is atomic; another instance already holds it -> bail).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  old_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "mm-manager: another instance (pid $old_pid) holds $LOCK_DIR" >&2
    exit 1
  fi
  # stale lock (holder died without cleanup, e.g. SIGKILL / reboot): take it over
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "mm-manager: cannot take $LOCK_DIR" >&2
    exit 1
  fi
fi
echo "$$" > "$LOCK_DIR/pid"
stopping=0
tail_pid=""
cleanup() {
  [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null || true
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'stopping=1' TERM INT

# ---- helpers ----

gen_batch_id() {
  printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$RANDOM"
}

# One path-safe inline JSON parse helper (no jq dependency).
parse_json_text() {
  NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e "$1" 2>/dev/null
}

# Trim old batches (keep last 200). Explicit file names only, never `rm -rf` with a computed glob.
trim_batches() {
  [ -d "$BATCH_DIR" ] || return
  # two files per batch (.prompt + .json): keep the newest 400 files = 200 batches
  local i=0
  while IFS= read -r f; do
    case "$f" in *.prompt|*.json) ;; *) continue;; esac
    i=$((i + 1))
    if [ "$i" -gt 400 ]; then
      rm -f -- "$BATCH_DIR/$f" 2>/dev/null || true
    fi
  done < <(ls -1t "$BATCH_DIR" 2>/dev/null)
}

# Built-in short table (fallback when the runbook file is missing/unreadable).
builtin_table() {
  cat <<'EOF'
| Case / kind | What the SHADOW manager should propose |
|---|---|
| continue, stopped_short, ask_status | "Yes, continue." if the rule set's safety gates allow (case in autoCases, no draft, no forbidden topic); else escalate as a batch item |
| menu_recommended | read `stall.options`; if the recommended option is non-forbidden and the question is "how", send its number or "Yes, go with your recommendation." — otherwise escalate |
| owner_decision | never guess; escalate with a one-line proposed reply |
| waiting_deploy | never answer; check leases and escalate the deploy request / blocking lease |
| owner_action | escalate, batched, with `stall.action` |
| permission | escalate (sessions run --dangerously-skip-permissions; never press 1) |
| error | GET /api/quota: plan's 5h window full -> wait for resetsAt; API error -> re-check 10 min, escalate after 30 min |
| done, no question | nothing (no_status on P0/P1 may justify the ask_status question) |
| background_wait | nothing; re-check 15 min; > 60 min treat as done |
| waiting with stall:null | read the pane; usually a menu -> owner_decision path |
| idle > 6 h (task doc says work remains) | note in report; do not restart |
| deploy event, state=failed | read the log tail; escalate with the cause |
| deploy event, queued > 30 min | name the blocking lease |
| quota:<plan>:<window> | which P0/P1 use that plan; never override a hold |
| disk:<path> / credits | escalate with the top consumer (`du`, `ps`) or the credit left |

Hard floors: a forbidden topic (deploy, push/merge to main, delete/remove, migration, .env, credentials,
money, customer) or a case in {permission, owner_action, waiting_deploy} -> proposal=escalate, no call
to Jev, no call to Sonnet.

Priority + quota: P0 first; a P2 stop on a plan whose 5h window is >= 80% is held by policy.
Never type into a `held` or `paused` session.
EOF
}

get_runbook_table() {
  if [ -r "$MM_RUNBOOK" ]; then
    cat "$MM_RUNBOOK"
  else
    builtin_table
  fi
}

# Read-only GET helper: empty JSON on failure (closed port, timeout).
get_json() {
  local url="$1"
  local resp
  resp=$(curl -sS --max-time 5 "$url" 2>/dev/null) || resp=''
  if [ -z "$resp" ]; then
    printf '{}'
  else
    printf '%s' "$resp"
  fi
}

# Gather facts JSON for the batch.
# Reads events from stdin (one JSON object per line) and emits one JSON object on stdout:
#   { "sessions": {<name>: {status, stall, priority}}, "deploys": <array or null> }
# Tolerates any GET failure (closed port) by returning empty objects.
gather_facts_json() {
  local events_json="$1"
  local port="$GHOSTY_PORT"
  local sessions_json deploy_resp want_deploy

  # Extract session names from "<session>:<kind>" keys (skip head in a fixed blocklist).
  sessions_json=$(printf '%s' "$events_json" | NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
    let buf="";process.stdin.on("data",c=>buf+=c);process.stdin.on("end",()=>{
      const out=new Set();
      try {
        const arr=JSON.parse(buf||"[]");
        for (const e of arr) {
          const k=String(e&&e.key||"");
          const i=k.indexOf(":");
          if (i<0) continue;
          const head=k.slice(0,i);
          if (!["deploy","quota","disk","openrouter","manager-agent"].includes(head)) out.add(head);
        }
      } catch {}
      process.stdout.write(JSON.stringify([...out]));
    });
  ' 2>/dev/null) || sessions_json='[]'

  want_deploy=0
  if printf '%s' "$events_json" | grep -q '"key":"deploy:'; then
    want_deploy=1
  fi

  local sess_resp='{}'
  if [ "$sessions_json" != "[]" ]; then
    sess_resp=$(get_json "http://127.0.0.1:${port}/api/sessions")
  fi

  local deploy_arg='null'
  if [ "$want_deploy" -eq 1 ]; then
    local d
    d=$(get_json "http://127.0.0.1:${port}/api/deploys")
    deploy_arg=$(printf '%s' "$d" | NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
      let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
        try { process.stdout.write(JSON.stringify(JSON.parse(s||"{}"))); }
        catch { process.stdout.write("null"); }
      });
    ' 2>/dev/null) || deploy_arg='null'
  fi

  printf '%s' "$sess_resp" | WANTED="$sessions_json" DEPLOYS="$deploy_arg" NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
    let buf="";process.stdin.on("data",c=>buf+=c);process.stdin.on("end",()=>{
      const wanted = JSON.parse(process.env.WANTED || "[]");
      const deploys = process.env.DEPLOYS || "null";
      let all = {};
      try { all = JSON.parse(buf || "{}"); } catch {}
      const list = Array.isArray(all) ? all : (Array.isArray(all.sessions) ? all.sessions : []);
      const filtered = {};
      for (const w of wanted) {
        for (const x of list) {
          if (x && (x.name===w || x.session===w || x.id===w)) {
            filtered[w] = {
              status: x.status || null,
              stall: x.stall || null,
              priority: x.priority || null,
            };
            break;
          }
        }
      }
      let dep = null;
      try { dep = JSON.parse(deploys); } catch { dep = null; }
      process.stdout.write(JSON.stringify({ sessions: filtered, deploys: dep }));
    });
  ' 2>/dev/null \
    || echo '{"sessions":{},"deploys":null}'
}

# Build the prompt file for MiniMax.
build_prompt() {
  local events_json="$1"
  local facts_json="$2"
  local outfile="$3"

  cat > "$outfile" <<EOF
You are a SHADOW manager: propose, never act. The real (Sonnet) manager is acting on the same events
in parallel; you only propose what it should do, so we can compare later. NEVER call any
state-changing API (no POST/PUT/DELETE, no send, no alert, no wake).

# Decision table (from .manager-s4.md)

$(get_runbook_table)

# Events (one JSON object per line)

$events_json

Each event line may carry a \`jev\` field: Jev's wake opinion for that event (a hint, not an order).

# Facts (read-only GETs to the local ghosty API)

$facts_json

# Per-event output rules

For each event output EXACTLY ONE JSON line (no other text), with this schema:

  {"key":<event key>, "at":<event at>,
   "proposal":"none"|"answer"|"escalate"|"alert",
   "reply": <string only when proposal=answer, <=200 chars>,
   "message": <string only when proposal=escalate or alert, <=300 chars>,
   "why": "<= 20 words>",
   "jev_ask": <the jev-ask JSON line if you ran it, else null>,
   "sonnet": <true|false>,
   "sonnet_usd": <number from Sonnet's JSON total_cost_usd if you called it, else null>}

# When to ask Jev or Sonnet

When you are unsure (case ambiguous, multiple actions possible, conflict with quota/priority), run Jev:

  node $REPO/scripts/jev-ask.js stop --facts '<json>'

Take Jev's pick only if confidence >= 0.7. Jev's \`source\` is forced|jev|rule.

ONLY if Jev's source is "rule" (Jev was unsure) AND the event is NOT forced by a hard floor
(forbidden topic, case in permission|owner_action|waiting_deploy), call Sonnet:

  claude -p "<question with the facts>" --model sonnet --output-format json --disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task"

(Keep exactly this order and the comma-separated, quoted tool list: --disallowedTools is variadic and would
swallow the question otherwise.)

Take Sonnet's answer. Include its total_cost_usd as \`sonnet_usd\` in your JSON line.

NEVER run any other command that changes anything. Print ONLY the JSON lines, one per event.
EOF
}

# Parse mcode exec JSON output and append per-event decision records.
# mcode exec --output-format json returns an object with the model's final text plus a usage block;
# this is implementation-specific, so we read both .text (or .result.text) and .usage.
record_batch() {
  local mcode_json="$1"
  local batch_id="$2"
  local events_json="$3"
  local mm_ms="${4:-0}"

  printf '%s' "$mcode_json" | EVENTS="$events_json" BATCH="$batch_id" MM_MS="$mm_ms" NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
    let buf="";process.stdin.on("data",c=>buf+=c);process.stdin.on("end",()=>{
      const events=JSON.parse(process.env.EVENTS||"[]");
      const batchId=process.env.BATCH;
      let mcode={};
      try { mcode=JSON.parse(buf||"{}"); } catch {}
      const result = mcode.result || mcode;
      const text = String(result.text || result.output || result.content || "");
      const usage = (mcode.usage && typeof mcode.usage==="object")
        ? mcode.usage
        : ((result.usage && typeof result.usage==="object") ? result.usage : {});
      const tokens = {
        input: usage.input || 0,
        output: usage.output || 0,
        cache_read: usage.cache_read || 0,
      };
      const lines = text.split(/\r?\n/);
      const byKey = new Map();
      for (const ln of lines) {
        const t = ln.trim();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t);
          if (j && typeof j.key === "string") byKey.set(j.key, j);
        } catch {}
      }
      const out=[];
      for (const e of events) {
        const k = e.key;
        const d = byKey.get(k);
        if (!d) {
          out.push({ key:k, at:e.at, error:"no decision from mm", batch_id:batchId, mm_tokens:tokens });
          continue;
        }
        const rec = {
          key: k,
          at: e.at,
          proposal: d.proposal || "none",
          why: d.why ? String(d.why).slice(0,200) : null,
          sonnet: d.sonnet === true,
          batch_id: batchId,
          mm_ms: Number(process.env.MM_MS) || 0,
          mm_tokens: tokens,
        };
        if (d.reply) rec.reply = String(d.reply).slice(0,500);
        if (d.message) rec.message = String(d.message).slice(0,500);
        if (d.jev_ask) rec.jev_ask = d.jev_ask;
        if (d.sonnet_usd != null) rec.sonnet_usd = Number(d.sonnet_usd) || 0;
        out.push(rec);
      }
      process.stdout.write(out.map(r=>JSON.stringify(r)).join("\n") + "\n");
    });
  ' >> "$MM_LOG"
}

# Append {key, error} per event when mcode failed or timed out.
record_errors() {
  local events_json="$1"
  local batch_id="$2"
  local err="$3"
  local mm_ms="${4:-0}"
  printf '%s' "$events_json" | E="$err" B="$batch_id" MM_MS="$mm_ms" NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
    let buf="";process.stdin.on("data",c=>buf+=c);process.stdin.on("end",()=>{
      const events=JSON.parse(buf||"[]");
      const out = events.map(e => JSON.stringify({
        key: e.key, at: e.at, error: process.env.E, mm_ms: Number(process.env.MM_MS) || 0,
        batch_id: process.env.B,
        mm_tokens: { input: 0, output: 0, cache_read: 0 },
      }));
      process.stdout.write(out.join("\n") + "\n");
    });
  ' >> "$MM_LOG"
}

# Validate and collect event lines into a JSON array.
build_events_json() {
  local -a evs=("$@")
  local joined=''
  local first=1
  for line in "${evs[@]}"; do
    [ -z "$line" ] && continue
    if ! NODE_PATH="$NODE_BIN" "$NODE_BIN/node" -e '
      let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
        try { JSON.parse(s); process.exit(0); } catch { process.exit(1); }
      });
    ' <<< "$line" 2>/dev/null; then
      continue
    fi
    if [ "$first" -eq 0 ]; then joined+=','; fi
    first=0
    joined+="$line"
  done
  printf '[%s]' "$joined"
}

# Process one batch of event lines.
process_batch() {
  local batch_id="$1"
  shift
  local -a events=("$@")

  local events_json
  events_json=$(build_events_json "${events[@]}")
  if [ "$events_json" = "[]" ]; then
    return 0
  fi

  local facts_json
  facts_json=$(gather_facts_json "$events_json") || facts_json='{"sessions":{},"deploys":null}'

  local prompt_file="$BATCH_DIR/${batch_id}.prompt"
  build_prompt "$events_json" "$facts_json" "$prompt_file"

  if [ "$dry" -eq 1 ]; then
    return 0
  fi

  local raw_file="$BATCH_DIR/${batch_id}.json"
  local mcode_out t0 mm_ms
  t0=$(date +%s%N)
  mcode_out=$(PATH="$NODE_BIN:$PATH" "$MCODE" exec \
      --cwd "$REPO" \
      --prompt-mode coding \
      --permission smart \
      --timeout "$MCODE_TIMEOUT" \
      --output-format json \
      --input - < "$prompt_file" 2>/dev/null) || mcode_out=''

  mm_ms=$(( ($(date +%s%N) - t0) / 1000000 ))

  printf '%s' "$mcode_out" > "$raw_file"

  if [ -z "$mcode_out" ]; then
    record_errors "$events_json" "$batch_id" "mcode exec failed or timed out" "$mm_ms"
  else
    record_batch "$mcode_out" "$batch_id" "$events_json" "$mm_ms" || record_errors "$events_json" "$batch_id" "could not record mcode output" "$mm_ms"
  fi

  trim_batches
}

# ---- main ----

if [ "$mode" = "once" ]; then
  if [ -z "$once_file" ] || [ ! -r "$once_file" ]; then
    echo "mm-manager: --once requires a readable file" >&2
    exit 2
  fi
  batch_id=$(gen_batch_id)
  mapfile -t events < "$once_file" || true
  if [ "${#events[@]}" -gt 0 ]; then
    process_batch "$batch_id" "${events[@]}"
  fi
  exit 0
fi

# tail mode: follow manager-events.jsonl, collect lines for BATCH_S seconds after the first one.
events=()
batch_started=0

if [ ! -r "$STATE_DIR/manager-events.jsonl" ]; then
  # Fresh start: wait for the file to appear, then tail.
  while [ ! -r "$STATE_DIR/manager-events.jsonl" ] && [ "$stopping" -eq 0 ]; do
    sleep 1
  done
fi
[ "$stopping" -eq 1 ] && exit 0

exec 3< <(tail -n0 -F "$STATE_DIR/manager-events.jsonl" 2>/dev/null)
tail_pid=$!
# (-F follows the name, so the rename to manager-events.jsonl.1 on rotation is survived)

while [ "$stopping" -eq 0 ]; do
  line=""
  IFS= read -r -t 5 line <&3
  rc=$?
  if [ "$rc" -gt 128 ]; then continue; fi   # idle timeout slice: re-check `stopping`
  if [ "$rc" -ne 0 ]; then break; fi        # tail died
  [ -z "$line" ] && continue
  events=("$line")
  # Collect more lines until BATCH_S seconds after the first one (a fixed deadline, not per line).
  deadline=$(( $(date +%s) + BATCH_S ))
  while :; do
    left=$(( deadline - $(date +%s) ))
    [ "$left" -le 0 ] && break
    [ "$stopping" -eq 1 ] && break
    extra=""
    [ "$left" -gt 5 ] && left=5     # short reads so SIGTERM is noticed (bash defers traps during read)
    IFS= read -r -t "$left" extra <&3
    rc=$?
    if [ "$rc" -gt 128 ]; then continue; fi   # timeout slice: loop re-checks deadline + stopping
    if [ "$rc" -ne 0 ]; then break; fi
    [ -z "$extra" ] && continue
    events+=("$extra")
  done
  batch_id=$(gen_batch_id)
  # A failed batch must never kill the loop.
  process_batch "$batch_id" "${events[@]}" || echo "mm-manager: batch $batch_id failed" >&2
  events=()
done

exec 3<&-
exit 0
