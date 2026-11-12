#!/usr/bin/env bash
# Manager agent: block until its event filter emits a line, then keep collecting for a batch window and print the batch, then exit.
# Batch window (owner, 2026-11-02; DeepSeek review P1: 652 wakes on 2026-11-01, one per event, 84 % did nothing): after the first
# delivered event the wait keeps collecting for MANAGER_WAIT_WINDOW seconds (default 60) so one wake carries the whole batch; an
# urgent event (`u: true` from the filter's policy: asks, needs-manager, hold, health, a failed deploy, a blocking bug, priority high)
# closes the window MANAGER_WAIT_GRACE seconds (default 2) after it arrived. A window below the grace is raised to it.
# Deferred lines (`d: true` from the filter: a non-blocking bug filing; owner 2026-11-12, TASK-239 G6) do not open the window: they are printed with
# the next real event, or alone after MANAGER_WAIT_DEFER seconds (default 3600); a held deferred line keeps the cursor, so a killed wait re-reads it.
# 40 wakes on 2026-11-11 carried only such a filing; 33 did nothing.
# Run it with Bash run_in_background: it has no 30-min expiry like a Monitor, so the agent wakes ONLY on a real event.
#   scripts/manager-wait.sh [filter-command]
# Default (no argument): reads manager-events.jsonl from a stored byte offset (<state dir>/manager-reports/.cursor), feeds the
# new lines through scripts/manager-event-filter.sh, and writes the offset back once something is delivered. Events that land
# while the manager is busy are therefore delivered by the next call. First run (no cursor) starts at EOF.
# With a custom filter-command: legacy behaviour, the command is run as-is and has to do its own tailing (no cursor).
# Single instance: two waits racing on .cursor crashed one of them on the shared .cursor.tmp, so the lock is taken
# before anything else and held for the whole life of the wait (the fd survives the exec, filters inherit it).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MANAGER_WAIT_DEFAULT_FILTER="$HERE/manager-event-filter.sh"
STATE="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
mkdir -p "$STATE"
exec {LOCKFD}>>"$STATE/manager-wait.lock"                     # append, never truncate: a loser must still read the winner's pid
if ! flock -n "$LOCKFD"; then
  printf 'another manager-wait is running (pid %s)\n' "$(tr -dc 0-9 <"$STATE/manager-wait.lock" 2>/dev/null)" >&2
  exit 3
fi
printf '%s\n' "$$" >"$STATE/manager-wait.lock"              # we hold it: record our pid for the next loser
exec python3 - "$1" <<'PY'
import os, select, signal, subprocess, sys, time
filt = sys.argv[1]
state = os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty')
events = os.path.join(state, 'manager-events.jsonl')
cursor_file = os.path.join(state, 'manager-reports', '.cursor')
poll = float(os.environ.get('MANAGER_WAIT_POLL', '0.5'))
grace = float(os.environ.get('MANAGER_WAIT_GRACE', '2'))
window = max(grace, float(os.environ.get('MANAGER_WAIT_WINDOW', '60')))
defer_max = float(os.environ.get('MANAGER_WAIT_DEFER', '3600'))   # a deferred line (`d: true`) never opens the window: it rides with the next real event, or goes out alone after this long

def urgent(line):
    # the filter marks urgent lines with `"u":true` (scripts/manager-event-filter.sh); an unparsable line counts as urgent (never delay the unknown)
    try:
        import json
        return bool(json.loads(line).get('u'))
    except Exception:
        return True

def deferred(line):
    try:
        import json
        o = json.loads(line)
        return bool(o.get('d')) and not o.get('u')
    except Exception:
        return False

def kill(p):
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: pass

def legacy():
    p = subprocess.Popen(['bash', '-c', filt], stdout=subprocess.PIPE, text=True, start_new_session=True)
    out = [p.stdout.readline()]
    end = time.time() + grace
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], max(0, end - time.time()))
        if not r: break
        line = p.stdout.readline()
        if not line: break
        out.append(line)
    kill(p)
    sys.stdout.write(''.join(out))

def size(path):
    try: return os.path.getsize(path)
    except OSError: return 0

def read_cursor():
    try:
        with open(cursor_file) as f: return int(f.read().strip())
    except (OSError, ValueError): return None

def write_cursor(n):
    os.makedirs(os.path.dirname(cursor_file), exist_ok=True)
    tmp = cursor_file + '.tmp.' + str(os.getpid())       # per-pid temp: a crash leaves one orphan, never a shared file to trip over
    with open(tmp, 'w') as f: f.write(str(n) + '\n')
    os.replace(tmp, cursor_file)

def read_from(path, off):
    # complete lines after byte `off`; returns (bytes, new offset)
    try:
        with open(path, 'rb') as f:
            f.seek(off); data = f.read()
    except OSError:
        return b'', off
    i = data.rfind(b'\n')
    if i < 0: return b'', off
    return data[:i + 1], off + i + 1

def cursored():
    off = read_cursor()
    if off is None:
        off = size(events); write_cursor(off)      # first run: start at EOF, do not flood the manager
    last_written = off                              # so write_cursor only touches disk when the value changes
    p = subprocess.Popen(['bash', '-c', os.environ['MANAGER_WAIT_DEFAULT_FILTER']], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         start_new_session=True)
    out = []
    fd = p.stdout.fileno()
    buf = b''
    def pump(timeout):
        nonlocal buf
        r, _, _ = select.select([fd], [], [], timeout)
        if r:
            chunk = os.read(fd, 65536)
            if not chunk: return False
            buf += chunk
        return True
    def feed(data):
        try: p.stdin.write(data); p.stdin.flush()
        except (BrokenPipeError, OSError): pass
    def advance(n):
        nonlocal last_written
        if n != last_written: write_cursor(n); last_written = n
    first_at = None
    defer_at = None                                  # the first deferred line held
    urgent_at = None                                 # the first urgent line: the window closes `grace` after it
    alive = True
    prev_off = off                                   # what `off` was at the last pump; if a tick fed nothing, the filter has had a full poll to react
    while alive:
        if size(events) < off:                        # rotated: finish the old file (.1), then start the new one
            data, noff = read_from(events + '.1', off)
            if data: feed(data)
            off = 0
        data, noff = read_from(events, off)
        if data: feed(data); off = noff
        alive = pump(poll)
        while b'\n' in buf:
            line, _, buf = buf.partition(b'\n')
            text = line.decode()
            out.append(text + '\n')
            if deferred(text):
                if defer_at is None: defer_at = time.time()
                continue
            if first_at is None: first_at = time.time()
            if urgent_at is None and urgent(text): urgent_at = time.time()
        if first_at is not None and time.time() - first_at >= window: break
        if urgent_at is not None and time.time() - urgent_at >= grace: break
        if first_at is None and defer_at is not None and time.time() - defer_at >= defer_max: break
        if p.poll() is not None and not alive: break
        if first_at is None and defer_at is None and off == prev_off:      # quiet tick, nothing new fed: every fed line has been dropped by the filter, move on
            advance(off)
        prev_off = off
    # flush: stop feeding, let the filter drain what it already has
    try: p.stdin.close()
    except OSError: pass
    t0 = time.time()
    while time.time() - t0 < 3 and pump(0.2): pass
    while b'\n' in buf:
        line, _, buf = buf.partition(b'\n'); out.append(line.decode() + '\n')
    kill(p)
    if out: advance(off)                             # delivered: cursor moves; quiet ticks may already have
    sys.stdout.write(''.join(out))

if filt and os.path.realpath(filt) != os.path.realpath(os.environ['MANAGER_WAIT_DEFAULT_FILTER']): legacy()
else: cursored()
PY
