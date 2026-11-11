#!/usr/bin/env python3
"""rtsp_replace: the nightly RTSP policy (docs/RTSP-NIGHTLY.md). stdlib only; uses rtsp_check.py.

  rtsp_replace.py [--mode dry|live]        check every rtsp device, apply the policy, journal, print the report
  rtsp_replace.py --apply ENV HOST DEVICE POOL_ID --out FILE   (internal: runs INSIDE the host lease)

Policy (data: config/rtsp-pool.json):
  ok                          nothing to do
  ip_camera not ok            REPORTED only, never replaced (owner hardware)
  public / loopback not ok    replaced by the first VETTED pool source that plays right now (loopback sources only on
                              the hosts that run vpt-rtsp), at most maxReplacementsPerNight (3) per UTC day, live mode only
Replacement: a lease on the host (`vpt-lease run`; BUSY => the command never runs, nothing is touched), the FULL current
host-config GET devices merged with the one changed DEVICE<n>_VIDEO (never devices:{}: that deletes every DEVICE<n> key,
bug-591e8166), a payload backup (0600) in the state dir, POST /server/settings/host-config, read-back diff, restart of
vpt-stream through /server/system/controlHostService (allowlisted unit), rtsp_check of the new source, rollback to the
backup when anything fails. Journal: <state>/rtsp-nightly/journal.jsonl, redacted. Default mode is dry: no writes at all.
"""
import copy, datetime, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtsp_check as rc  # noqa: E402

STATE = os.path.join(os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty'), 'rtsp-nightly')
SETTLE = int(os.environ.get('RTSP_SETTLE_SECONDS', '15'))
AGENT = 'codebox:rtsp-nightly'


def journal(ev):
    os.makedirs(STATE, exist_ok=True)
    ev = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), **ev}
    with open(os.path.join(STATE, 'journal.jsonl'), 'a', encoding='utf-8') as f:
        f.write(rc.redact(json.dumps(ev, ensure_ascii=False)) + '\n')


def replaced_today():
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    n = 0
    try:
        for line in open(os.path.join(STATE, 'journal.jsonl'), encoding='utf-8'):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('event') == 'replace' and e.get('outcome') in ('replaced', 'rolled_back') and e.get('at', '').startswith(today):
                n += 1
    except OSError:
        pass
    return n


def candidates(entry, pool):
    """Vetted pool sources usable for this device, current source excluded."""
    for s in pool['sources']:
        if not s.get('vetted') or s['url'] == entry['url']:
            continue
        if s['kind'] == 'loopback' and entry['host'] not in [h.strip() for h in os.environ.get(s.get('hostsEnv', ''), '').split(',')]:
            continue
        yield s


def pick(entry, pool, ssh_map, timeout):
    """First vetted candidate that plays now, probed from the host when we have an ssh alias for it (its network matters)."""
    for s in candidates(entry, pool):
        ssh = ssh_map.get(entry['host'])
        if rc.is_loopback(s['url']) and not ssh:
            continue
        if rc.check_stream(s['url'], timeout, ssh)['status'] == 'ok':
            return s
    return None


# ---------------- the apply step (inside the host lease) ----------------
def other_fields(devices, device):
    return {(d, k): v for d, f in devices.items() for k, v in f.items() if not (d == device and k == 'DEVICE_VIDEO')}


def apply_one(env, host, device, pool_id, out):
    servers = rc.parse_pairs(os.environ.get('RTSP_CHECK_SERVERS'))
    server = servers[env]
    pool = rc.load_pool()
    src = next(s for s in pool['sources'] if s['id'] == pool_id and s.get('vetted'))
    ssh = rc.parse_pairs(os.environ.get('RTSP_CHECK_SSH')).get(host)
    token = rc.server_token()
    base = {'event': 'replace', 'host': host, 'device': device, 'pool': pool_id}
    result = {'outcome': 'refused'}

    def done(outcome, **kw):
        result.update(outcome=outcome, **kw)
        journal({**base, 'outcome': outcome, **kw})
        with open(out, 'w') as f:
            json.dump(result, f)
        return 0 if outcome == 'replaced' else 3

    cfg = rc.host_config(server, token, host)
    devices = cfg.get('devices') or {}
    # The guard that matters: a payload without the other devices deletes them on the host.
    if not devices or device not in devices or not rc.is_rtsp(devices[device].get('DEVICE_VIDEO', '')):
        return done('refused', reason='device not found or not an rtsp source (nothing sent)')
    old = rc.clean_value(devices[device]['DEVICE_VIDEO'])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    os.makedirs(os.path.join(STATE, 'backups'), exist_ok=True)
    backup = os.path.join(STATE, 'backups', f'{host}-{stamp}.json')
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)  # holds camera credentials: never in the journal
    with os.fdopen(fd, 'w') as f:
        json.dump({'host': host, 'devices': devices}, f)
    base['backup'] = os.path.basename(backup)
    new = copy.deepcopy(devices)
    new[device]['DEVICE_VIDEO'] = src['url']

    def save(payload):
        r = rc.api(server, '/server/settings/host-config', token, {'host_name': host, 'devices': payload}, timeout=60)
        return bool(r.get('success'))

    def restart():
        r = rc.api(server, '/server/system/controlHostService', token, {'host_name': host, 'service': 'vpt-stream', 'action': 'restart'}, timeout=90)
        return bool(r.get('success'))

    def rollback(why):
        ok = False
        try:
            ok = save(devices) and restart()
        except Exception as e:
            why += f' (rollback error {type(e).__name__})'
        return done('rolled_back' if ok else 'rollback_failed', reason=why, old=rc.redact(old))

    try:
        if not save(new):
            return rollback('host-config POST refused')
        after = rc.host_config(server, token, host).get('devices') or {}
        if set(after) != set(devices) or other_fields(after, device) != other_fields(devices, device) \
                or rc.clean_value(after.get(device, {}).get('DEVICE_VIDEO', '')) != src['url']:
            return rollback('read-back differs from the merged payload')
        if not restart():
            return rollback('vpt-stream restart failed')
        time.sleep(SETTLE)
        res = rc.check_stream(src['url'], 10, ssh)
        if res['status'] != 'ok':
            return rollback(f"new source not playing: {res['status']}")
    except Exception as e:
        return rollback(f'{type(e).__name__}')
    return done('replaced', old=rc.redact(old), new=src['url'])


# ---------------- the nightly run ----------------
def lease_cmd(env, host, device, pool_id, out):
    return ['vpt-lease', 'run', os.environ.get('RTSP_LEASE_ENV', 'node1-vpt'), host, '--agent', AGENT, '--kind', 'host', '--ttl', '20', '--max-wait', '3',
            '--purpose', f'rtsp nightly: replace {device} source', '--',
            sys.executable, os.path.abspath(__file__), '--apply', env, host, device, pool_id, '--out', out]  # env = the server label of RTSP_CHECK_SERVERS


def run(mode, timeout=10):
    pool = rc.load_pool()
    ssh_map = rc.parse_pairs(os.environ.get('RTSP_CHECK_SSH'))
    entries, errors = rc.inventory(rc.parse_pairs(os.environ.get('RTSP_CHECK_SERVERS')), pool)
    results = rc.check_entries(entries, ssh_map, timeout)
    budget = int(pool.get('maxReplacementsPerNight', 3)) - replaced_today()
    rows = []
    for e, r in zip(entries, results):
        row = rc.public_entry(e, r)
        if r['status'] == 'ok':
            row['action'] = 'none'
        elif e['kind'] == 'ip_camera':
            row['action'] = 'report: camera down (owner hardware, never replaced)'
        elif r['status'] == 'unverified':
            row['action'] = 'report: cannot verify (no ssh alias for the host)'
        elif budget <= 0:
            row['action'] = 'report: replacement budget used up tonight'
        else:
            s = pick(e, pool, ssh_map, timeout)
            if not s:
                row['action'] = 'report: no vetted pool source plays now'
            elif mode != 'live':
                row['action'] = f"dry: would replace with pool '{s['id']}'"
            else:
                out = os.path.join(STATE, f"apply-{e['host']}-{e['device']}.json")
                p = None
                try:
                    p = subprocess.run(lease_cmd(e['env'], e['host'], e['device'], s['id'], out), capture_output=True, text=True)
                except OSError as exc:
                    # The lease CLI itself is missing (or not executable): nothing was touched, but the night must
                    # go on and report it instead of dying on the first down stream. (not `as e`: that unbinds the
                    # loop variable `e` at the end of the clause.)
                    detail = rc.redact(f'{type(exc).__name__}: {exc}')
                else:
                    detail = rc.redact((p.stderr or '')[-200:])
                try:
                    res = json.load(open(out)); os.unlink(out)
                except (OSError, ValueError):
                    res = None
                if res is None:  # BUSY / lease error: vpt-lease never ran the command, nothing was touched
                    row['action'] = ('report: the lease command could not be run (vpt-lease missing), nothing touched'
                                     if p is None else 'report: host lease not granted, nothing touched')
                    journal({'event': 'replace', 'host': e['host'], 'device': e['device'],
                             'outcome': 'lease_not_available' if p is None else 'lease_not_granted', 'detail': detail})
                else:
                    row['action'] = f"{res['outcome']} (pool '{s['id']}')"
                    if res['outcome'] in ('replaced', 'rolled_back'):
                        budget -= 1
        rows.append(row)
        journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'action': row['action'], 'source': row['source']})
    return {'mode': mode, 'streams': rows, 'errors': errors}


def main(argv):
    a = list(argv)
    if '--apply' in a:
        i = a.index('--apply'); env, host, device, pid = a[i + 1:i + 5]
        out = a[a.index('--out') + 1]
        return apply_one(env, host, device, pid, out)
    mode = os.environ.get('RTSP_NIGHTLY_MODE', 'dry')
    if '--mode' in a:
        mode = a[a.index('--mode') + 1]
    if mode not in ('dry', 'live'):
        print('mode must be dry or live', file=sys.stderr); return 2
    rep = run(mode)
    os.makedirs(STATE, exist_ok=True)
    day = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    with open(os.path.join(STATE, f'report-{day}.json'), 'w') as f:
        f.write(rc.redact(json.dumps(rep, indent=2)))
    print(f"mode={mode}\n" + rc.table([{**r, 'status': f"{r['status']} -> {r['action']}"} for r in rep['streams']]) + ''.join(f'\nERROR {e}' for e in rep['errors']))
    bad = [r for r in rep['streams'] if r['status'] != 'ok']
    print(f"{len(rep['streams']) - len(bad)}/{len(rep['streams'])} ok; {len(bad)} to act on or report")
    if not rep['streams']:
        print('no rtsp devices found' + (' (inventory errors above)' if rep['errors'] else ''))
    return 1 if (bad or rep['errors']) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
