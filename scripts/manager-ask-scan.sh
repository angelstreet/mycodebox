#!/usr/bin/env bash
# Hourly sweep check: every ask that is open in the ledger must have been alerted.
# "Alerted" = an entry for that id in manager-ask-alerts.jsonl (the shared record ask-guard.js and
# manager-ask.js write when an alert really went out). The push feed (tag ask-<id>) is only a second
# source: it keeps the last 50 items, so a real alert scrolls out of it (2026-10-23: the scan printed a
# false "!! ask-not-alerted Q219" while the alert was in the record).
# Prints "!! ask-not-alerted <id>" for each open ask with no alert. Read-only; exit 0 always.
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
state = {}
for r in jl(os.path.join(st, 'manager-owner-asks.jsonl')):
    i = r.get('id')
    if not i: continue
    if r.get('action') == 'ledger-close' or r.get('state') in ('answered', 'superseded', 'closed', 'resolved', 'withdrawn'): state[i] = False
    elif r.get('state') in ('open', 'partial', 'amended') or r.get('action') in ('log_intent', 'ledger-amend'): state[i] = True
# the shared alert record: one line per alert that really went out for an ask
alerted = {r.get('id') for r in jl(os.path.join(st, 'manager-ask-alerts.jsonl')) if isinstance(r, dict) and r.get('id')}
try: feed = json.load(open(os.path.join(st, 'push-feed.json')))
except Exception: feed = []
tags = {f.get('tag') for f in feed if isinstance(f, dict)}
for i, o in state.items():
    if o and i not in alerted and f'ask-{i}' not in tags: print(f'!! ask-not-alerted {i}')
PY
exit 0
