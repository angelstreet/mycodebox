#!/usr/bin/env bash
# Hourly sweep check: every ask that is open in the ledger must have an alert (tag ask-<id>) in the push feed.
# Prints "!! ask-not-alerted <id>" for each one that has none. Read-only; exit 0 always.
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
try: feed = json.load(open(os.path.join(st, 'push-feed.json')))
except Exception: feed = []
tags = {f.get('tag') for f in feed if isinstance(f, dict)}
for i, o in state.items():
    if o and f'ask-{i}' not in tags: print(f'!! ask-not-alerted {i}')
PY
exit 0
