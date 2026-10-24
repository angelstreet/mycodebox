#!/usr/bin/env bash
# Hourly sweep check: every ask that is open in the ledger must have been alerted, and every ask that was
# closed must have been closed by a question that still exists.
# "Alerted" = an entry for that id in manager-ask-alerts.jsonl (the shared record ask-guard.js and
# manager-ask.js write when an alert really went out). The push feed (tag ask-<id>) is only a second
# source: it keeps the last 50 items, so a real alert scrolls out of it (2026-10-23: the scan printed a
# false "!! ask-not-alerted Q219" while the alert was in the record).
# Prints "!! ask-not-alerted <id>" for each open ask with no alert. Read-only apart from the scan marker below;
# exit 0 always.
# A closed ask is in no open set, so a question that was dropped with no replacement was invisible (E24).
# The scan reports the superseded asks too, one line each:
#   "!! ask-superseded-open <id> <replacement>"    the replacement is still open: the older question is still waiting
#   "!! ask-superseded-dropped <id> <replacement>" the replacement is not a question in the ledger: it was dropped
# The replacement is named, not a bare id: a question in the ledger is printed with its id and its wording, a
# replacement that is not a question says so plainly (E58: a raw stop id told the reader nothing).
# A drop is an event, not a state (E58): the ledger holds a backlog of old drops (the E22 defect wrote a stop
# id as the replacement) and reprinting them every hour buried the real signal. A drop is therefore reported
# ONCE, by the first scan that sees it. The scan keeps <stateDir>/manager-ask-scan.json (when it last ran,
# which drops it already reported): a drop is new when it is newer than the last run, so a scan that was off
# for a day still sees the drops of that day. On the very first run (no marker yet) only the drops of the last
# GHOSTY_ASK_SCAN_WINDOW_H hours (default 24) count, so the old backlog is not dumped.
#   scripts/manager-ask-scan.sh      (GHOSTY_STATE_DIR selects the state dir)
STATE="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
python3 - "$STATE" <<'PY'
import json, os, sys, time
from datetime import datetime, timezone
st = sys.argv[1]
GRACE_S = 120            # a drop that happens while the scan runs is still caught by the next one
WINDOW_H = float(os.environ.get('GHOSTY_ASK_SCAN_WINDOW_H') or 24)   # the first run: how far back a drop counts as new
def jl(p):
    out = []
    try:
        for l in open(p):
            try: out.append(json.loads(l))
            except Exception: pass
    except Exception: pass
    return out
def at_of(v):
    s = str(v or '')
    if not s: return None
    try:
        return datetime.fromisoformat(s[:-1] + '+00:00' if s.endswith('Z') else s).timestamp()
    except Exception: return None
now = time.time()
state = {}       # id -> open?
asked = set()    # ids that are questions (a row with the owner's wording)
answered = set() # ids the owner answered
sup = {}         # id -> (the id that replaced it, when)
questions = {}   # id -> the wording of the question
for r in jl(os.path.join(st, 'manager-owner-asks.jsonl')):
    i = r.get('id')
    if not i: continue
    if r.get('action') == 'ledger-close' or r.get('state') in ('answered', 'superseded', 'closed', 'resolved', 'withdrawn'): state[i] = False
    elif r.get('state') in ('open', 'partial', 'amended') or r.get('action') in ('log_intent', 'ledger-amend'): state[i] = True
    q = r.get('question')
    if isinstance(q, str) and q.strip():
        asked.add(i); questions[i] = q.strip()
    if r.get('state') == 'answered': answered.add(i)
    if r.get('state') == 'superseded' and r.get('by'): sup[i] = (str(r.get('by')), r.get('at'))
# what the scan already knows: when it last ran and which drops it has already reported
marker = {}
try:
    with open(os.path.join(st, 'manager-ask-scan.json')) as f: marker = json.load(f)
except Exception: marker = {}
last = at_of(marker.get('lastAt'))
since = (last - GRACE_S) if last else (now - WINDOW_H * 3600)
reported = set(marker.get('reported') or [])
# the shared alert record: one line per alert that really went out for an ask
alerted = {r.get('id') for r in jl(os.path.join(st, 'manager-ask-alerts.jsonl')) if isinstance(r, dict) and r.get('id')}
try: feed = json.load(open(os.path.join(st, 'push-feed.json')))
except Exception: feed = []
tags = {f.get('tag') for f in feed if isinstance(f, dict)}
def one(s, n=80): return ' '.join(str(s or '').split())[:n]
def replacement(by, dropped=False):
    q = questions.get(by)
    if q: return f'{by} "{one(q)}"' + (' (the replacement is closed)' if dropped else '')
    return f'{by} (not a question in the ledger)'
for i, o in state.items():
    if o and i not in alerted and f'ask-{i}' not in tags: print(f'!! ask-not-alerted {i}')
for i, (by, at) in sup.items():
    if state.get(by) is True and by in asked: print(f'!! ask-superseded-open {i} {replacement(by)}'); continue   # the older question is still waiting
    if by in answered: continue    # the owner answered the replacement: nothing was lost
    ts = at_of(at)
    if i not in reported and (ts is None or ts >= since): print(f'!! ask-superseded-dropped {i} {replacement(by, True)}')
    reported.add(i)
try:
    os.makedirs(st, exist_ok=True)
    with open(os.path.join(st, 'manager-ask-scan.json'), 'w') as f:
        json.dump({'lastAt': datetime.fromtimestamp(now, timezone.utc).isoformat().replace('+00:00', 'Z'), 'reported': sorted(reported)[-500:]}, f)
except Exception: pass    # a state dir that cannot be written must not break the scan
PY
exit 0
