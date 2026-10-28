#!/usr/bin/env bash
# Read-only sweep for the manager: for every tmux session print "<session>: <last STATUS line>" when that line says
# needs-manager, needs-owner, blocked or ready-for-gate, and "<session>: done-with-leftovers: <first item>" when the last STATUS is done
# but the closing text lists work the session can do itself (same rules as done-leftovers.js; owner-only items do not count). A session whose last STATUS is one of these is never "idle".
#   scripts/manager-status-scan.sh [--json]      (exit code 0 always)
# Also lists `<TASK-NN>: orphaned-task: ...` for task docs with open rows and no live session (GET /api/unfinished).
# Also lists `<a>+<b>: overlap: <paths>` for two sessions changing the same file (GET /api/overlaps).
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
DONE = re.compile(r'^\W*STATUS:\s*(done|ok|complete|completed|finished)\b', re.I)
OWNER = re.compile(r'\b(owner|jev|you must|needs? you|account|purchase|buy|pay(ment)?|invoice|money|budget|credentials?|secrets?|tokens?|password|api[- ]?key|re-?plug|unplug|plug(ged)? in|press(ing)? the|power[- ]?cycle|physical(ly)?|sudoers?|customer)\b', re.I)
HEAD = re.compile(r'^\W*(left to do|leftovers?|remaining( work| items| steps)?|still (to do|open)|todo|to do|open( items)?)\s*:\s*(.*)$', re.I)
def first_item(pane):
    # the last closing block only: the node pipeline in done-leftovers.js is the tested reference, this mirrors it for a shell sweep
    items, last = [], None
    for i, l in enumerate(pane):
        if STATUS.match(l.strip()): last = i
    if last is None: return None
    m = re.search(r'\bopen\s*:\s*(.+)$', pane[last], re.I)
    if m: items += [x.strip() for x in m.group(1).split(';')]
    for i, l in enumerate(pane[:last]):
        h = HEAD.match(l)
        if not h: continue
        if h.group(h.re.groups).strip(): items += [x.strip() for x in h.group(h.re.groups).split(';')]
        for b in pane[i + 1:i + 15]:
            bm = re.match(r'^\s*(?:[-*•]|\d+[.)])\s+(.+)$', b)
            if bm: items.append(bm.group(1).strip())
            elif b.strip(): break
    items = [re.sub(r'[*_`]+', '', x).strip(' .;,') for x in items]
    items = [x for x in items if x and not re.match(r'^(none|nothing|n/a|-)$', x, re.I) and not OWNER.search(x)]
    return items[0] if items else None
hits = []
for s in tmux('list-sessions', '-F', '#{session_name}').splitlines():
    s = s.strip()
    if not s: continue
    last, pane = None, tmux('capture-pane', '-p', '-J', '-t', s + ':', '-S', '-' + back).splitlines()
    for line in pane:
        if STATUS.match(line.strip()): last = line.strip()
    if last and FLAG.search(last): hits.append({'session': s, 'status': last})
    elif last and DONE.match(last):
        item = first_item(pane)
        if item: hits.append({'session': s, 'status': 'done-with-leftovers: ' + item})
# orphaned tasks: open doc rows, no live session (unfinished.js; scripts/resume-task TASK-NN)
try:
    import os, urllib.request
    u = json.load(urllib.request.urlopen('http://127.0.0.1:%s/api/unfinished' % os.environ.get('PORT', '7777'), timeout=5))
    for o in u.get('orphaned', []):
        hits.append({'session': o['task'], 'status': 'orphaned-task: rows %s open, %s' % (','.join(r['n'] for r in o['open']), o['why'])})
except Exception: pass
# overlapping sessions: same file changed by two sessions (overlap-guard.js)
try:
    o = json.load(urllib.request.urlopen('http://127.0.0.1:%s/api/overlaps' % os.environ.get('PORT', '7777'), timeout=5))
    for x in o.get('overlaps', []):
        hits.append({'session': x['key'], 'status': 'overlap: %s (older %s, first seen %s)' % (', '.join(p['path'] for p in x['paths'][:4]), x['pair'][0], x.get('firstSeen', '?'))})
except Exception: pass
# unresolved found-bugs (found-bugs.js; resolve with `found-bug --resolve <id> --commit <sha>`)
try:
    b = json.load(urllib.request.urlopen('http://127.0.0.1:%s/api/bugs' % os.environ.get('PORT', '7777'), timeout=5))
    for x in b.get('bugs', []):
        if not x.get('resolved') and not x.get('test'): hits.append({'session': x['id'], 'status': 'open-bug: %s (%s)' % (x['title'][:100], x.get('session', '?'))})
except Exception: pass
if as_json: print(json.dumps(hits))
else:
    for h in hits: print(f"{h['session']}: {h['status']}")
PY
# open owner asks with no alert in the push feed (manager-ask-scan.sh); not in --json output
[ "$JSON" = 0 ] && "$(dirname "$0")/manager-ask-scan.sh"
exit 0
