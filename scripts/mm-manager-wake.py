#!/usr/bin/env python3
"""Wake the interactive MiniMax manager session (owner Q37, 2026-10-06).

Follows <state>/manager-events.jsonl from EOF, passes new lines through scripts/manager-event-filter.sh (with its
own dedupe file under <state>/mm/, so the Claude manager's dedupe is untouched), batches them for BATCH_S seconds,
then types ONE line into the session (default `mm-manager`) once it is not working and has no draft.

  scripts/mm-manager-wake.py            run forever
Env: GHOSTY_STATE_DIR, GHOSTY_PORT (7777), MM_SESSION (mm-manager), BATCH_S (60)
"""
import json, os, subprocess, sys, time, urllib.request

STATE = os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty')
PORT = os.environ.get('GHOSTY_PORT', '7777')
SESSION = os.environ.get('MM_SESSION', 'mm-manager')
BATCH_S = float(os.environ.get('BATCH_S', '60'))
EVENTS = os.path.join(STATE, 'manager-events.jsonl')
FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manager-event-filter.sh')
FILTER_ENV = dict(os.environ, GHOSTY_STATE_DIR=os.path.join(STATE, 'mm'))
BASE = f'http://127.0.0.1:{PORT}'


def api(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json'}, method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b'{}')


def filtered(lines):
    p = subprocess.run(['bash', FILTER], input=''.join(lines), capture_output=True, text=True, env=FILTER_ENV)
    return [l for l in p.stdout.splitlines() if l.strip()]


def summary(line):
    try:
        e = json.loads(line)
    except ValueError:
        return line[:160]
    e = e.get('l', e)  # the filter wraps each event as {k, l}
    jev = e.get('jev') or {}
    j = f" [jev {jev.get('pick')} {jev.get('confidence')}]" if jev.get('pick') else ''
    raw = ' '.join(str(e.get('body') or '').split())
    body = raw[:160] + ('…' if len(raw) > 160 else '')
    return f"[{e.get('kind')}] {e.get('title')} — {body}{j}"


def self_session(line):
    # Drop events for the woken session itself (mm-manager); otherwise its own
    # stops keep re-waking it. Match on session / key prefix / title prefix —
    # the feed records use all three shapes.
    try:
        e = json.loads(line)
    except ValueError:
        return False
    e = e.get('l', e)
    if e.get('session') == SESSION:
        return True
    key = e.get('key')
    if isinstance(key, str) and key.startswith(SESSION + ':'):
        return True
    title = e.get('title')
    if isinstance(title, str) and title.startswith(SESSION + ' '):
        return True
    return False


def ready():
    st = (api('/api/sessions').get('status') or {}).get(SESSION)
    if not st:
        return None
    return st.get('state') != 'working' and not (st.get('stall') or {}).get('draft')


def deliver(items):
    msg = f"EVENTS ({len(items)}) — handle per your brief: " + ' | '.join(f"{i + 1}) {s}" for i, s in enumerate(items))
    msg = msg[:1800]
    msg += " (summaries — for the full text read status[<session>].stall and GET /api/reply/<session> of the session named in each event)"
    while True:
        try:
            r = ready()
            if r is None:
                print(f'mm-wake: session {SESSION} missing, dropping {len(items)} events', flush=True)
                return
            if r:
                api(f'/api/send/{SESSION}', {'keys': msg, 'enter': True, 'by': 'mm-manager-wake'})
                print(f'mm-wake: sent {len(items)} events', flush=True)
                return
        except Exception as ex:  # ghosty restarting: retry
            print(f'mm-wake: {ex}', flush=True)
        time.sleep(15)


def main():
    f = open(EVENTS)
    f.seek(0, os.SEEK_END)
    pending, first = [], None
    while True:
        line = f.readline()
        if line:
            pending.append(line)
            first = first or time.time()
            continue
        if os.path.getsize(EVENTS) < f.tell():  # rotated / truncated
            f.close(); f = open(EVENTS)
        if pending and time.time() - first >= BATCH_S:
            kept = [l for l in pending if not self_session(l)]
            pending, first = [], None
            items = [summary(l) for l in filtered(kept)]
            if items:
                deliver(items)
        time.sleep(1)


if __name__ == '__main__':
    sys.exit(main())


# --- tiny self-test ----------------------------------------------------------
# python3 -c 'import importlib.util, json
# spec = importlib.util.spec_from_file_location("mmw", "scripts/mm-manager-wake.py")
# mm = importlib.util.module_from_spec(spec); spec.loader.exec_module(mm)
# mm.SESSION = "mm-manager"
# self_line  = json.dumps({"k":"mm-manager|done|x","l":{"key":"mm-manager:done","session":"mm-manager","title":"mm-manager is done","kind":"done","body":"x"*200}})
# other_line = json.dumps({"k":"other|asks|x",      "l":{"key":"other:asks",     "session":"other",      "title":"other asks you","kind":"asks","body":"y"*200}})
# assert mm.self_session(self_line)  is True
# assert mm.self_session(other_line) is False
# assert mm.summary(other_line).endswith("\u2026")
# sent = []
# mm.api = lambda path, body=None: sent.append(body) or {}
# mm.ready = lambda: True
# mm.deliver([mm.summary(self_line), mm.summary(other_line)])
# msg = sent[0]["keys"]
# suffix = " (summaries \u2014 for the full text read status[<session>].stall and GET /api/reply/<session> of the session named in each event)"
# assert msg.endswith(suffix) and msg.count(suffix) == 1
# print("OK")'
# ---------------------------------------------------------------------------
