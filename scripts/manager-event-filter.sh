#!/bin/bash
# manager event filter (owner-approved 2026-10-04), reads manager-events.jsonl lines on STDIN (manager-wait.sh feeds it from the cursor):
# drops routine deploy start/done, the deploy runner's own lease releases (manager:deploy), deploy events and lease releases Jev says "ignore" at >= 0.9 (the runner starts a waiting deploy on release itself)
# (never for asks/waiting/hold/quota/disk/credits or failed/orphan deploys), and repeats of the same stop (per run).
# Every routine lease released/expired event is dropped (bug-0809f1cc: CI sweep and dispatch leases woke the manager every 2-10 min);
# lease events that need a human (denied, stuck/overdue, narrowed by another agent, ...) still pass.
# The deploy runner's own per-host narrowing (agent manager:deploy, "deploy <id>: done on <host>") is dropped (one host deploy woke the manager ~20 times, 2026-11-03). A `system-wait` (a session waiting on a live ticket or
# a running deploy, owner 2026-10-31) is dropped too: the queue or the runner resolves it, the lease watchdog tells the session.
# Routine integration success (`int-<id>:merged` / `int-<id>:deployed`, default priority; owner 2026-11-02, wake noise): dropped here, still in
# manager-events.jsonl; manager-status-scan.sh prints the hourly count. returned / failed / blocked / cancelled / CI-red integrations pass.
# `external-result` (the result of an integration queued for a Mac/cloud session, external-result.js; owner/manager 2026-11-02): a failure (priority high) ALWAYS wakes; a routine one
# (default priority) is dropped since 2026-11-11 (TASK-239 wake economy: 66 of 80 wakes on it did nothing; the relay tells the session). test/manager-event-filter.test.js pins both.
# Also dropped at default priority (replay scripts/manager-wake-replay.js, 2026-11-11, zero lost actions): `share:*` notices, `bug found: idea:` low non-blocking bugs, session notices
# (kpi-*, pokestall-*, pokemon-daily-*, content-*, ...). They stay in manager-events.jsonl and the hourly sweep. `told` (rules-watch re-read notice) and `unseen:*` (a session's detached job) are dropped (they stay in manager-events.jsonl; the sessions are told
# directly); `orphaned-task` is deduped across runs for 6 h like asks (owner 2026-11-02, wake noise).
# Residual risk (Codex review 2026-10-22 s4, kept on purpose): the runner's own lease release is dropped even if the runner then crashes,
# so the release alone is not a wake-up. A safe "failed/blocked event of the same deploy in this batch" rule needs the whole batch
# (a streaming jq cannot see a later event), so it is not done here; the wake-up for a dead runner is the deploy's failed / orphan /
# blockedBy event (never dropped, tested) and the manager's hourly sweep.
# The key drops the STATUS meter ("· 1m 09s · 832k tok") so a re-fired stop (no meter) matches the original; first 80 chars.
# When the body has a "needs-owner:" STATUS, the key is that question only (up to its [options]): ghosty re-cuts the body differently on re-fire.
# Across runs (separate manager-wait invocations), asks / waiting / lease are also deduped for 6 h — a stop that ghosty re-emits
# for a no-new-turn ~10 min later must not wake the manager again. The seen-keys file lives at
# ${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}/manager-reports/.seen-keys (one "<unix_seconds> <key>" per line);
# health events dedupe by their key (health:load, health:disk, ...) for 6 h too;
# deploy / hold / quota / disk / credits keep per-run dedupe only (the awk array, as before).
# Policy (owner, 2026-11-02; DeepSeek review P1): scripts/manager-event-policy.json (repo defaults) merged with
# $GHOSTY_STATE_DIR/manager-event-policy.json (the owner's copy wins per key): '<kind>' or '<kind>:<state>' -> pass | ignore | urgent.
# ignore drops the event before the built-in rules; pass keeps it even where a built-in rule would drop it; urgent marks the output line
# (`u: true`) so manager-wait.sh closes its batch window at once. An event the lane or a wake already delivered to its session
# (`handled: "session"`, integration-notify.js) is routine for the manager unless the policy says pass.
# Rules before the manager (owner 2026-11-12, TASK-239 G6; the STATUS table says nobody acts on `waiting` / `running`). Dropped at default priority:
# - a `*:manager-item` stop that is a wait ("<session> waits for a deploy: ...", case waiting_deploy): the parked wake re-checks it and the lease
#   nudge answers a free equivalent;
# - notices of a check the harness already answered itself: done-check ("said done, git disagrees"), goal-check ("done not accepted"),
#   session-closed:* (bug-unreported still passes: a test pins it);
# - disk / quota alerts under 95%: once per 5-point bucket per 6 h across runs (key `pctx|<key>|<bucket>`); 95% and over always passes.
# Deferred (`d: true`): a non-blocking bug filing is delivered with the next wake or after MANAGER_WAIT_DEFER (manager-wait.sh, 1 h), never a wake
# of its own. Replay: scripts/manager-wake-rules-replay.py <day>.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
POLICY_DEFAULT="$HERE/manager-event-policy.json"
POLICY_OWNER="$STATE_DIR/manager-event-policy.json"
PD=$(jq -c . "$POLICY_DEFAULT" 2>/dev/null || echo '{}')
PO=$({ [ -f "$POLICY_OWNER" ] && jq -c . "$POLICY_OWNER" 2>/dev/null; } || echo '{}')
POLICY=$(jq -c -n --argjson d "$PD" --argjson o "$PO" '$d + $o' 2>/dev/null || echo '{}')
SEEN_FILE="$STATE_DIR/manager-reports/.seen-keys"
mkdir -p "$(dirname "$SEEN_FILE")"
NOW=$(date +%s)
THRESH=$(( NOW - 6*3600 ))
# prune entries older than 6 h on startup; if the prune fails (e.g. file vanished), leave the file alone
if [ -f "$SEEN_FILE" ]; then
  awk -v th="$THRESH" 'NF>=2 && ($1+0) >= th { print }' "$SEEN_FILE" > "$SEEN_FILE.tmp" 2>/dev/null && mv "$SEEN_FILE.tmp" "$SEEN_FILE" || rm -f "$SEEN_FILE.tmp"
fi

jq -c --unbuffered --argjson policy "$POLICY" '
  def pol: ($policy[((.kind//"")|tostring)+":"+((.state//"")|tostring)] // $policy[((.kind//"")|tostring)] // "default");
  def pct: ([(.title//"")|match("([0-9]+)%").captures[0].string|tonumber][0] // null);
  def routine:
    ((.kind=="deploy") and (.state=="start" or .state=="done") and ((.blockedBy//[])|length)==0)
    or ((.jev.pick=="ignore") and ((.jev.confidence//0) >= 0.9) and (.kind=="deploy") and (.state!="failed") and (.state!="orphan"))
    or ((.jev.pick=="ignore") and ((.jev.confidence//0) >= 0.9) and (.kind=="lease") and (.state=="released"))
    or ((.kind=="lease") and (.state=="released") and (((.title//"")|test("\\((agent )?manager:deploy\\)")) or ((.body//"")|test("by manager:deploy \\(deploy-finished\\)"))))
    or ((.kind=="lease") and (.state=="narrowed") and ((.title//"")|test("\\(agent manager:deploy\\)$")) and ((.body//"")|test("by manager:deploy \\(deploy [0-9a-f]+: done on [^)]+\\)")))
    or (((.kind//"")|tostring|test("^int-[0-9a-f]+:(merged|deployed)$")) and ((.priority//"default")=="default"))
    or ((.kind=="told") or ((.kind//"")|tostring|test("^unseen:")))
    or ((.kind=="lease") and (.state=="released" or .state=="expired" or .state=="system-wait"))
    or ((.handled//"")=="session")
    or ((.kind=="external-result") and ((.priority//"default")=="default"))
    or (((.kind//"")|tostring|test("^share:")) and ((.priority//"default")=="default"))
    or ((.kind=="bug") and ((.priority//"")=="low") and ((.bug.blocking//false)==false) and ((.title//"")|test("bug found: idea:")))
    or (((.key//"")|tostring|test(":manager-item$")) and ((.body//"")|test("^\\S+ waits for a deploy:")))
    or ((((.session//"")=="done-check") or ((.session//"")=="goal-check") or ((.kind//"")|tostring|test("^session-closed:"))) and ((.priority//"default")=="default"))
    or (((.kind//"")|tostring|test("^(kpi-|pokestall-|pokemon-daily-|mobile-orchtnet-owner$|opus-openexit$|content-|mi-bugs-|pi1-load-|task208-)")) and ((.priority//"default")=="default"));
  select(pol != "ignore") | select(pol == "pass" or (routine|not))
  | {k:(if ((.kind=="disk" or .kind=="quota") and (pct != null) and (pct < 95)) then ("pctx|"+((.key//.kind)|tostring|gsub("\\s";""))+"|"+((pct/5|floor)|tostring)) else (.session//"")+"|"+.kind+"|"+(if .kind=="health" then (.key//"") else ((.body//"") as $b | (if ($b|test("needs-owner:")) then ($b|capture("needs-owner:(?<q>[^\\[]*)").q) else $b end) | gsub("·\\s*[0-9][0-9hms ]*·\\s*[0-9.]+[kM]?\\s*tok\\s*";"")|gsub("\\s";"")|.[0:80]) end) end),
     u:(pol=="urgent" or ((.priority//"")=="high") or ((.priority//"")=="urgent") or ((.kind=="bug") and ((.bug.blocking//false)==true))),
     d:((.kind=="bug") and ((.bug.blocking//false)==false) and ((.priority//"")!="high") and ((.priority//"")!="urgent") and (pol!="urgent") and (pol!="pass")), l:.}' \
| awk -W interactive -v now="$NOW" -v seen="$SEEN_FILE" '
    function persist(k) { printf "%d %s\n", now, k >> seen; fflush(seen) }
    BEGIN {
      while ((getline line < seen) > 0) {
        nf = split(line, a, " ")
        if (nf >= 2) seenmap[a[2]] = 1
      }
      close(seen)
    }
    {
      match($0, /^\{"k":"[^"]*"/)
      k = substr($0, RSTART+6, RLENGTH-7)
      match($0, /"kind":"[^"]*"/)
      ks = substr($0, RSTART+8, RLENGTH-9)
      cross = (ks == "asks" || ks == "orphaned-task" || ks == "waiting" || ks == "lease" || ks == "health" || k ~ /^pctx\|/)
      if (cross && (k in seenmap)) next
      if (!(k in runmap)) {
        runmap[k] = 1
        if (cross) persist(k)
        print $0
      }
    }'