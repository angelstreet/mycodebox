#!/usr/bin/env python3
"""rtsp_replace: the nightly RTSP policy (docs/RTSP-NIGHTLY.md). stdlib only; uses rtsp_check.py.

  rtsp_replace.py [--mode dry|live]        check every rtsp device, apply the policy, journal, print the report
  rtsp_replace.py --apply ENV HOST DEVICE POOL_ID --out FILE   (internal: runs INSIDE the host lease)

Policy (data: config/rtsp-pool.json); scope: every rtsp_video device and any rtsp:// source:
  ok                          nothing to do
  hls / file / no_source      REPORTED only (no channel or file pool exists)
  ip_camera not ok            REPORTED only, never replaced (owner hardware)
  hls                         restore (same channel, new URL, upstream iptv-org list) else replace (same group, unused on the host,
                              our verified list; device renamed), re-probed 20 s later first; stream_catalog.py
  public / loopback (rtsp)    replaced by the first VETTED pool source that plays right now (loopback sources only on
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
import stream_catalog as sc  # noqa: E402

STATE = os.path.join(os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty'), 'rtsp-nightly')
SETTLE = int(os.environ.get('RTSP_SETTLE_SECONDS', '15'))
AGENT = 'codebox:rtsp-nightly'


def read_mode(name, default='dry'):
    try:
        with open(os.path.join(STATE, name), encoding='utf-8') as f:
            return 'live' if f.read().strip() == 'live' else default
    except OSError:
        return default


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
        if rc.is_http(s['url']) != rc.is_http(entry['url']):  # an HLS device gets an HLS source, an rtsp device an rtsp one
            continue
        if s['kind'] == 'loopback' and entry['host'] not in [h.strip() for h in os.environ.get(s.get('hostsEnv', ''), '').split(',')]:
            continue
        yield s


def pick_hls(entry, catalog, used_urls, ssh_map, timeout, tries=8):
    """restore (same channel, new URL) else replace (same group, unused on the host); first that plays, probed from the host."""
    ssh = ssh_map.get(entry['host'])
    for n, (how, c, new_name) in enumerate(sc.candidates(entry.get('name', ''), entry['url'], used_urls, catalog)):
        if n >= tries:
            break
        if rc.check_stream(c['url'], timeout, ssh)['status'] == 'ok':
            return {'id': f"{how}:{c['name']}", 'url': c['url'], 'how': how, 'name': new_name, 'label': c['name']}
    return None


def confirm_down(entry, ssh_map, timeout):
    """A live TV channel can blink or answer slowly: re-probe 20 s later with 3x the timeout. -> the confirmed status."""
    time.sleep(int(os.environ.get('RTSP_CONFIRM_SECONDS', '20')))
    return rc.check_stream(entry['url'], timeout * 3, ssh_map.get(entry['host']))['status']


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
def other_fields(devices, device, changed=('DEVICE_VIDEO',)):
    return {(d, k): v for d, f in devices.items() for k, v in f.items() if not (d == device and k in changed)}


def apply_one(env, host, device, src_file, out):
    servers = rc.parse_pairs(os.environ.get('RTSP_CHECK_SERVERS'))
    server = servers[env]
    with open(src_file, encoding='utf-8') as f:
        src = json.load(f)  # {id, url, how, name?}: chosen and probed by the nightly run just before the lease
    pool_id = src['id']
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
    if not devices or device not in devices or not (rc.is_rtsp(devices[device].get('DEVICE_VIDEO', '')) or rc.is_http(devices[device].get('DEVICE_VIDEO', ''))):
        return done('refused', reason='device not found or not an rtsp/http stream source (nothing sent)')
    old = rc.clean_value(devices[device]['DEVICE_VIDEO'])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    os.makedirs(os.path.join(STATE, 'backups'), exist_ok=True)
    backup = os.path.join(STATE, 'backups', f'{host}-{device}-{stamp}.json')  # two repairs on one host in one second collided
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)  # holds camera credentials: never in the journal
    with os.fdopen(fd, 'w') as f:
        json.dump({'host': host, 'devices': devices}, f)
    base['backup'] = os.path.basename(backup)
    new = copy.deepcopy(devices)
    new[device]['DEVICE_VIDEO'] = src['url']
    renamed = bool(src.get('name')) and src['name'] != devices[device].get('DEVICE_NAME')
    if renamed:
        new[device]['DEVICE_NAME'] = src['name']
    changed = {'DEVICE_VIDEO', 'DEVICE_NAME'} if renamed else {'DEVICE_VIDEO'}

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
        if set(after) != set(devices) or other_fields(after, device, changed) != other_fields(devices, device, changed) \
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
    return done('replaced', how=src.get('how', 'pool'), old=rc.redact(old), new=src['url'],
                old_name=devices[device].get('DEVICE_NAME', ''), new_name=new[device].get('DEVICE_NAME', ''))


# ---------------- the nightly run ----------------
def lease_cmd(env, host, device, pool_id, out, max_wait=None):
    # The first wait is short (5 min): a busy host must not hold the whole night. A repair the lease blocked is
    # retried at the end of the night with the long wait (RTSP_LEASE_RETRY_MAX_WAIT).
    return ['vpt-lease', 'run', os.environ.get('RTSP_LEASE_ENV', 'node1-vpt'), host, '--agent', AGENT, '--kind', 'host', '--ttl', '20',
            '--max-wait', str(max_wait if max_wait is not None else os.environ.get('RTSP_LEASE_MAX_WAIT', '5')),
            '--purpose', f'rtsp nightly: replace {device} source', '--',
            sys.executable, os.path.abspath(__file__), '--apply', env, host, device, pool_id, '--out', out]  # env = the server label of RTSP_CHECK_SERVERS


def apply_with_lease(e, s, max_wait=None):
    """Run the apply step inside the host lease. -> (res, detail, cli_missing). res is None when the lease was not
    granted (nothing was touched) or the apply step wrote no result."""
    out = os.path.join(STATE, f"apply-{e['host']}-{e['device']}.json")
    src_file = os.path.join(STATE, f"apply-src-{e['host']}-{e['device']}.json")
    os.makedirs(STATE, exist_ok=True)
    with open(src_file, 'w', encoding='utf-8') as f:
        json.dump(s, f)
    p = None
    try:
        p = subprocess.run(lease_cmd(e['env'], e['host'], e['device'], src_file, out, max_wait), capture_output=True, text=True)
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
    finally:
        # the chosen source is scratch: it must not pile up in the state dir night after night
        try:
            os.unlink(src_file)
        except OSError:
            pass
    return res, detail, p is None


def run(mode, timeout=10):
    pool = rc.load_pool()
    ssh_map = rc.parse_pairs(os.environ.get('RTSP_CHECK_SSH'))
    entries, errors, hosts = rc.inventory(rc.parse_pairs(os.environ.get('RTSP_CHECK_SERVERS')), pool)
    results = rc.check_entries(entries, ssh_map, timeout)
    caps = rc.check_captures(entries)  # what the app shows: the tile's snapshot through its server
    capture_mode = read_mode('capture-mode')  # the capture-driven repair has its own switch: dry until one clean night
    budget = int(pool.get('maxReplacementsPerNight', 3)) - replaced_today()
    rows = []
    catalog = None
    chosen = {}
    deferred = []  # repairs the host lease blocked: retried at the end of the night
    for e, r, cap in zip(entries, results, caps):
        row = rc.public_entry(e, r)
        row.update({k: v for k, v in cap.items() if k != 'detail'})
        src_ok = r['status'] in rc.OK_STATES
        black_src = False
        if src_ok and cap['capture'] == 'black' and e['kind'] == 'hls':
            y = rc.luma(e['url'], 20, ssh_map.get(e['host']))  # is the channel itself black, or only the host's capture?
            row['source_luma'] = None if y is None else round(y, 1)
            black_src = y is not None and y < rc.BLACK_LUMA
        if src_ok and not black_src and cap['capture'] not in ('ok', 'unknown'):
            row['action'] = (f"report: the source plays but the host stream has {cap.get('audio')} audio tracks: the browser's"
                             " live player cannot play it: the host's vpt-stream runs a run_ffmpeg.sh from before the one-track"
                             " fix (bug-ea31641c): restart vpt-stream on that host under its lease, not changed") if cap['capture'] == 'multi_audio' else (
                             f"report: the source plays but the tile's snapshot is {cap['capture']}"
                             + (f" ({cap['age']} s old)" if cap['capture'] == 'stale' and cap.get('age') is not None else '')
                             + ": host capture side (vpt-stream / thumbnails), not changed")
        elif src_ok and not black_src:
            row['action'] = ('none' if r['status'] == 'ok' or cap['capture'] == 'ok'
                             else 'report: cannot verify from codebox (no ssh alias, no host snapshot)')
        elif black_src and capture_mode != 'live':
            row['action'] = "report: the channel's own picture is black (host snapshot and source frame); capture checks are dry, nothing changed"
        elif black_src and budget <= 0:
            row['action'] = 'report: black channel; replacement budget used up tonight'
        elif r['status'] == 'ok' and not black_src:
            row['action'] = 'none'
        elif r['status'] == 'unverified' and not black_src:
            row['action'] = 'report: cannot verify from codebox (no ssh alias for the host)'
        elif e['kind'] in ('file', 'no_source'):
            row['action'] = f"report: {e['kind']} source not ok (never replaced automatically: no file pool, and an empty source is the owner's call)"
        elif e['kind'] == 'ip_camera':
            row['action'] = 'report: camera down (owner hardware, never replaced)'
        elif budget <= 0:
            row['action'] = 'report: replacement budget used up tonight'
        elif not black_src and (confirmed := confirm_down(e, ssh_map, timeout)) in rc.OK_STATES:
            row['action'] = f"report: {r['status']} once, played on the re-probe (slow or flaky), nothing touched"
        elif not black_src and confirmed == 'frozen':
            row['action'] = 'report: frozen picture confirmed (could be a still or radio channel), not changed automatically'
        else:
            if e['kind'] == 'hls':
                if catalog is None:
                    catalog, cat_err = sc.load()
                    errors += cat_err
                used = [x['url'] for x in entries if x['host'] == e['host']] + chosen.setdefault(e['host'], [])
                s = pick_hls(e, catalog, used, ssh_map, timeout)
                if s:
                    chosen[e['host']].append(s['url'])  # one channel per host: never give it to a second device tonight
            else:
                p0 = pick(e, pool, ssh_map, timeout)
                s = p0 and {'id': p0['id'], 'url': p0['url'], 'how': 'replace', 'label': f"pool {p0['id']}"}
            if not s:
                row['action'] = ('report: no working same channel or same-group channel in the lists' if e['kind'] == 'hls'
                                 else 'report: no vetted pool source plays now')
            elif mode != 'live':
                row['action'] = f"dry: would {s['how']} with '{s['label']}'" + (f" (device renamed '{s['name']}')" if s.get('name') and s['name'] != e.get('name') else '')
            else:
                res, detail, cli_missing = apply_with_lease(e, s)
                if res is None:  # BUSY / lease error: vpt-lease never ran the command, nothing was touched
                    row['action'] = ('report: the lease command could not be run (vpt-lease missing), nothing touched'
                                     if cli_missing else 'report: host lease not granted (or the apply step stopped before any write), nothing touched')
                    journal({'event': 'replace', 'host': e['host'], 'device': e['device'],
                             'outcome': 'lease_not_available' if cli_missing else 'lease_not_granted', 'detail': detail})
                    if not cli_missing:
                        # The host was busy for the short wait: try again at the end of the night, when the other
                        # work is done and the lease is more likely free. A busy lease must not cost the night a stream.
                        deferred.append((e, s, row))
                else:
                    row['action'] = f"{res['outcome']} ({s['how']}: '{s['label']}')"
                    if res['outcome'] in ('replaced', 'rolled_back'):
                        budget -= 1
        rows.append(row)
        journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'capture': row.get('capture'), 'luma': row.get('luma'), 'action': row['action'], 'source': row['source']})
    # The night is over: retry the repairs the host lease blocked, with the long wait.
    for e, s, row in deferred:
        if budget <= 0:
            row['action'] = 'report: replacement budget used up tonight'
            continue
        res, detail, cli_missing = apply_with_lease(e, s, max_wait=int(os.environ.get('RTSP_LEASE_RETRY_MAX_WAIT', '20')))
        if res is None:
            row['action'] = 'report: host lease not granted again at the end of the night, nothing touched'
            journal({'event': 'replace', 'host': e['host'], 'device': e['device'], 'outcome': 'lease_not_granted', 'detail': detail})
        else:
            row['action'] = f"{res['outcome']} ({s['how']}: '{s['label']}')"
            if res['outcome'] in ('replaced', 'rolled_back'):
                budget -= 1
        journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'capture': row.get('capture'), 'luma': row.get('luma'), 'action': row['action'], 'source': row['source']})
    return {'mode': mode, 'streams': rows, 'errors': errors, 'hosts': hosts}


def main(argv):
    a = list(argv)
    if '--apply' in a:
        i = a.index('--apply'); env, host, device, pid = a[i + 1:i + 5]  # pid = the chosen-source JSON file
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
    bad = [r for r in rep['streams'] if r['status'] not in rc.OK_STATES]
    unv = sum(r['status'] == 'unverified' for r in rep['streams'])
    by = {}
    for r in rep['streams']:
        by.setdefault(r['kind'], {}).setdefault(r['status'], 0)
        by[r['kind']][r['status']] += 1
    print(f"{len(rep['streams'])} streams, {len(bad)} down, {unv} unverified; by kind: {json.dumps(by)}")
    capc = {}
    for r in rep['streams']:
        capc[r.get('capture', 'unknown')] = capc.get(r.get('capture', 'unknown'), 0) + 1
    print(f"tile snapshots (what the app shows): {json.dumps(capc)}; capture repairs: {read_mode('capture-mode')}")
    walked = f"{rep['hosts']['walked']} host(s) walked, {rep['hosts']['read']} read"
    if not rep['streams']:
        print('no stream devices found' + (' (inventory errors above)' if rep['errors'] else '') + f' ({walked})')
    else:
        print(walked)
    return 1 if (bad or rep['errors']) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
