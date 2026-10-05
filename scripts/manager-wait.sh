#!/usr/bin/env bash
# Manager agent: block until its event filter emits a line, print it (plus anything within 2 s), then exit.
# Run it with Bash run_in_background: it has no 30-min expiry like a Monitor, so the agent wakes ONLY on a real event.
#   scripts/manager-wait.sh [filter-command]   default: ~/.local/state/ghosty/manager-reports/monitor-filter.sh
FILTER="${1:-$HOME/.local/state/ghosty/manager-reports/monitor-filter.sh}"
exec python3 - "$FILTER" <<'PY'
import os, select, signal, subprocess, sys, time
p = subprocess.Popen(['bash', '-c', sys.argv[1]], stdout=subprocess.PIPE, text=True, start_new_session=True)
out = [p.stdout.readline()]
end = time.time() + 2
while time.time() < end:
    r, _, _ = select.select([p.stdout], [], [], max(0, end - time.time()))
    if not r: break
    line = p.stdout.readline()
    if not line: break
    out.append(line)
try: os.killpg(p.pid, signal.SIGTERM)
except ProcessLookupError: pass
sys.stdout.write(''.join(out))
PY
