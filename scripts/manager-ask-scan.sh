#!/usr/bin/env bash
# Hourly sweep check: every ask that is open in the ledger must have been alerted, and every ask that was
# closed must have been closed by a question that still exists.
# "Alerted" = an entry for that id in manager-ask-alerts.jsonl (the shared record ask-guard.js and
# manager-ask.js write when an alert really went out). The push feed (tag ask-<id>) is only a second
# source: it keeps the last 50 items, so a real alert scrolls out of it (2026-10-23: the scan printed a
# false "!! ask-not-alerted Q219" while the alert was in the record).
# Prints "!! ask-not-alerted <id>" for each open ask with no alert. Read-only; exit 0 always.
# A closed ask is in no open set, so a question that was dropped with no replacement was invisible (E24).
# The scan reports the superseded asks too, one line each:
#   "!! ask-superseded-open <id> <replacement>"    the replacement is still open: the older question is still waiting
#   "!! ask-superseded-dropped <id> <replacement>" the replacement is not a question in the ledger: it was dropped
#   scripts/manager-ask-scan.sh      (GHOSTY_STATE_DIR selects the state dir)
STATE="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}"
python3 - "$STATE" <<'PY'
import json, os, sys
st = sys.argv[1]
def jl(p):
    out = []
    try:
        for l in open(p):
            try: out.append(json.loads(l))
            except Exception: pass
    except Exception: pass
    return out
state = {}       # id -> open?
asked = set()    # ids that are questions (a row with the owner's wording)
answered = set() # ids the owner answered
sup = {}         # id -> the id that replaced it
for r in jl(os.path.join(st, 'manager-owner-asks.jsonl')):
    i = r.get('id')
    if not i: continue
    if r.get('action') == 'ledger-close' or r.get('state') in ('answered', 'superseded', 'closed', 'resolved', 'withdrawn'): state[i] = False
    elif r.get('state') in ('open', 'partial', 'amended') or r.get('action') in ('log_intent', 'ledger-amend'): state[i] = True
    q = r.get('question')
    if isinstance(q, str) and q.strip(): asked.add(i)
    if r.get('state') == 'answered': answered.add(i)
    if r.get('state') == 'superseded' and r.get('by'): sup[i] = str(r.get('by'))
# the shared alert record: one line per alert that really went out for an ask
alerted = {r.get('id') for r in jl(os.path.join(st, 'manager-ask-alerts.jsonl')) if isinstance(r, dict) and r.get('id')}
try: feed = json.load(open(os.path.join(st, 'push-feed.json')))
except Exception: feed = []
tags = {f.get('tag') for f in feed if isinstance(f, dict)}
for i, o in state.items():
    if o and i not in alerted and f'ask-{i}' not in tags: print(f'!! ask-not-alerted {i}')
for i, by in sup.items():
    if state.get(by) is True and by in asked: print(f'!! ask-superseded-open {i} {by}')   # the older question is still waiting
    elif by not in answered: print(f'!! ask-superseded-dropped {i} {by}')   # dropped with no replacement
PY
exit 0
