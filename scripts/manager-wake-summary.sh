#!/usr/bin/env bash
# Print EVERY event of a manager-wait output file, one per line, never truncated: time | kind | session | title | jev pick.
# Lines that need the manager (needs-manager, asks, hold) start with "!! ". Read this on every wake, not just the first event.
#   scripts/manager-wake-summary.sh <output-file>
[ -n "$1" ] && [ -r "$1" ] || { echo "usage: manager-wake-summary.sh <manager-wait output file>" >&2; exit 2; }
python3 - "$1" <<'PY'
import json, re, sys
FLAG_KINDS = {'asks', 'hold', 'needs-manager'}
n = 0
for raw in open(sys.argv[1], errors='replace'):
    raw = raw.strip()
    if not raw: continue
    try: o = json.loads(raw)
    except ValueError:
        print(f'?? unparsed | {raw[:200]}'); n += 1; continue
    e = o['l'] if isinstance(o, dict) and isinstance(o.get('l'), dict) else o     # manager-wait wraps each event as {"k":..., "l": event}
    jev = e.get('jev') if isinstance(e.get('jev'), dict) else {}
    kind = str(e.get('kind') or '-')
    text = ' '.join(str(e.get(k) or '') for k in ('title', 'body'))
    flag = kind in FLAG_KINDS or re.search(r'needs-manager', text, re.I)
    f = lambda v: str(v if v not in (None, '') else '-').replace('\n', ' ')
    print(f"{'!! ' if flag else '   '}{f(e.get('at'))} | {kind} | {f(e.get('session'))} | {f(e.get('title'))} | jev {f(jev.get('pick'))}")
    n += 1
PY
