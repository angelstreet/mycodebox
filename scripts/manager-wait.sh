#!/usr/bin/env bash
# Manager agent: block until its event filter emits a line, print it (plus anything within 2 s), then exit.
# Run it with Bash run_in_background: it has no 30-min expiry like a Monitor, so the agent wakes ONLY on a real event.
#   scripts/manager-wait.sh [filter-command]
# Default (no argument): reads manager-events.jsonl from a stored byte offset (<state dir>/manager-reports/.cursor), feeds the
# new lines through scripts/manager-event-filter.sh, and writes the offset back once something is delivered. Events that land
# while the manager is busy are therefore delivered by the next call. First run (no cursor) starts at EOF.
# With a custom filter-command: legacy behaviour, the command is run as-is and has to do its own tailing (no cursor).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MANAGER_WAIT_DEFAULT_FILTER="$HERE/manager-event-filter.sh"
exec python3 - "$1" <<'PY'
import os, select, signal, subprocess, sys, time
filt = sys.argv[1]
state = os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty')
events = os.path.join(state, 'manager-events.jsonl')
cursor_file = os.path.join(state, 'manager-reports', '.cursor')
poll = float(os.environ.get('MANAGER_WAIT_POLL', '0.5'))
grace = float(os.environ.get('MANAGER_WAIT_GRACE', '2'))

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
    tmp = cursor_file + '.tmp'
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
    first_at = None
    alive = True
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
            out.append(line.decode() + '\n')
            if first_at is None: first_at = time.time()
        if first_at is not None and time.time() - first_at >= grace: break
        if p.poll() is not None and not alive: break
    # flush: stop feeding, let the filter drain what it already has
    try: p.stdin.close()
    except OSError: pass
    t0 = time.time()
    while time.time() - t0 < 3 and pump(0.2): pass
    while b'\n' in buf:
        line, _, buf = buf.partition(b'\n'); out.append(line.decode() + '\n')
    kill(p)
    if out: write_cursor(off)                          # delivered: the cursor moves; otherwise noise is just re-read
    sys.stdout.write(''.join(out))

if filt and os.path.realpath(filt) != os.path.realpath(os.environ['MANAGER_WAIT_DEFAULT_FILTER']): legacy()
else: cursored()
PY
