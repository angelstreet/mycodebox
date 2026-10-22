#!/usr/bin/env bash
# Read-only sweep for the manager: for every tmux session print "<session>: <last STATUS line>" when that line says
# needs-manager, needs-owner, blocked or ready-for-gate. A session whose last STATUS is one of these is never "idle".
#   scripts/manager-status-scan.sh [--json]      (exit code 0 always)
# --json prints [{"session": ..., "status": ...}, ...]. Only reads panes (tmux capture-pane), never types into one.
JSON=0; [ "$1" = "--json" ] && JSON=1
LINES_BACK="${STATUS_SCAN_LINES:-300}"
python3 - "$JSON" "$LINES_BACK" <<'PY'
import json, re, subprocess, sys
as_json, back = sys.argv[1] == '1', sys.argv[2]
FLAG = re.compile(r'needs-manager|needs-owner|blocked|ready-for-gate', re.I)
STATUS = re.compile(r'^\W*STATUS:', re.I)
def tmux(*a):
    try: return subprocess.run(['tmux', *a], capture_output=True, text=True, timeout=10).stdout
    except Exception: return ''
hits = []
for s in tmux('list-sessions', '-F', '#{session_name}').splitlines():
    s = s.strip()
    if not s: continue
    last = None
    for line in tmux('capture-pane', '-p', '-J', '-t', s + ':', '-S', '-' + back).splitlines():
        if STATUS.match(line.strip()): last = line.strip()
    if last and FLAG.search(last): hits.append({'session': s, 'status': last})
if as_json: print(json.dumps(hits))
else:
    for h in hits: print(f"{h['session']}: {h['status']}")
PY
exit 0
