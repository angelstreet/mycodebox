#!/usr/bin/env python3
"""rtsp_replace: the nightly RTSP policy (docs/RTSP-NIGHTLY.md). stdlib only; uses rtsp_check.py.

  rtsp_replace.py [--mode dry|live]        check every rtsp device, apply the policy, journal, print the report
  rtsp_replace.py --apply ENV HOST DEVICE SRC_FILE --out FILE   (internal: runs INSIDE the host lease)

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
backup when anything fails. A lease that was refused (the command never ran, nothing touched) and an apply step that
died (the host may be half-changed) are two different outcomes in the journal: lease_not_granted / apply_failed.
Journal: <state>/rtsp-nightly/journal.jsonl, redacted. Default mode is dry: no writes at all.
"""
import argparse, copy, datetime, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtsp_check as rc  # noqa: E402
import stream_catalog as sc  # noqa: E402

STATE = os.path.join(os.environ.get('GHOSTY_STATE_DIR') or os.path.expanduser('~/.local/state/ghosty'), 'rtsp-nightly')
SETTLE = int(os.environ.get('RTSP_SETTLE_SECONDS', '15'))
# The night verifies what it installed before it ends: a source can die minutes after it was put in place (a CDN
# whose signed segments expire), and the channel would then stay dead until the next night (bug-80678895).
INSTALL_VERIFY = int(os.environ.get('RTSP_INSTALL_VERIFY_SECONDS', '300'))
# The host reports its device list (with the device names) every 30 s. A renamed device shows its new name
# in the app only once the host has reported it, so the night waits for that report (bug-ee21b77c).
TITLE_CHECK = int(os.environ.get('RTSP_TITLE_CHECK_SECONDS', '90'))
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


def candidates(entry, pool, exclude=()):
    """Vetted pool sources usable for this device, current source excluded (and the ones that just died)."""
    for s in pool['sources']:
        if not s.get('vetted') or s['url'] == entry['url'] or s['url'] in exclude:
            continue
        if rc.is_http(s['url']) != rc.is_http(entry['url']):  # an HLS device gets an HLS source, an rtsp device an rtsp one
            continue
        if s['kind'] == 'loopback' and entry['host'] not in [h.strip() for h in os.environ.get(s.get('hostsEnv', ''), '').split(',')]:
            continue
        yield s


def probe_pool(pool, ssh_map, timeout):
    """Probe the pool's own candidates, so the report says whether the pool still plays (the pool is never edited here).

    A loopback source only exists on the host that runs it: it is probed from there (through that host's ssh alias),
    the public ones from codebox. Without an alias a loopback source reads 'unverified', never 'ok'.
    The entries are probed in parallel (bug-5473cd69): the public ones time out, and one after the other they added
    about 35 s to every night. The order of the pool file is kept in the report."""
    sources = pool.get('sources', [])

    def one(s):
        ssh, where = None, 'codebox'
        hosts = [h.strip() for h in (os.environ.get(s.get('hostsEnv') or '') or '').split(',') if h.strip()]
        if hosts:
            ssh = ssh_map.get(hosts[0])
            where = hosts[0] if ssh else f'{hosts[0]} (no ssh alias)'
        res = rc.check_stream(s['url'], timeout, ssh)
        return {'id': s['id'], 'kind': s.get('kind'), 'vetted': s.get('vetted'), 'status': res['status'], 'from': where, 'url': s['url']}

    if not sources:
        return []
    with ThreadPoolExecutor(max_workers=min(6, len(sources))) as ex:
        return list(ex.map(one, sources))


def pick_hls(entry, catalog, used_urls, ssh_map, timeout, tries=8, exclude=()):
    """restore (same channel, new URL) else replace (same group, unused on the host); first that plays, probed from the host."""
    ssh = ssh_map.get(entry['host'])
    for n, (how, c, new_name) in enumerate(sc.candidates(entry.get('name', ''), entry['url'], used_urls, catalog)):
        if n >= tries:
            break
        if c['url'] in exclude:  # a source that just died is never taken again
            continue
        if rc.check_stream(c['url'], timeout, ssh)['status'] == 'ok':
            return {'id': f"{how}:{c['name']}", 'url': c['url'], 'how': how, 'name': new_name, 'label': c['name']}
    return None


def confirm_down(entry, ssh_map, timeout):
    """A live TV channel can blink or answer slowly: re-probe 20 s later with 3x the timeout. -> the confirmed status."""
    time.sleep(int(os.environ.get('RTSP_CONFIRM_SECONDS', '20')))
    return rc.check_stream(entry['url'], timeout * 3, ssh_map.get(entry['host']))['status']


def pick(entry, pool, ssh_map, timeout, exclude=()):
    """First vetted candidate that plays now, probed from the host when we have an ssh alias for it (its network matters)."""
    for s in candidates(entry, pool, exclude):
        ssh = ssh_map.get(entry['host'])
        if rc.is_loopback(s['url']) and not ssh:
            continue
        if rc.check_stream(s['url'], timeout, ssh)['status'] == 'ok':
            return s
    return None


# The lease CLI says on stderr when it got the lease ("lease <id> held, running ..."); when it did not,
# the command never ran and nothing was touched. The two must not be reported as the same thing: a failed
# apply step can leave the host half-changed, a refused lease cannot.
LEASE_GRANTED_MARKERS = ('held, running', 'vpt-lease: granted')
LEASE_REFUSED_MARKERS = ('busy', 'waiting claim cancelled', 'claim again if you still need it',
                          'e_not_authority', 'held by', 'lease is fenced')


def apply_failure(detail, cli_missing):
    """Why the apply step produced no result -> 'lease_not_available' | 'lease_not_granted' | 'apply_failed'."""
    if cli_missing:
        return 'lease_not_available'
    low = (detail or '').lower()
    if any(m in low for m in LEASE_GRANTED_MARKERS):
        return 'apply_failed'   # the lease was granted: the apply step itself died
    if any(m in low for m in LEASE_REFUSED_MARKERS):
        return 'lease_not_granted'
    return 'lease_not_granted'  # the lease CLI failed before it could say anything: nothing ran


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
    base = {'event': 'replace', 'host': host, 'device': device, 'pool': pool_id}
    result = {'outcome': 'refused'}

    def done(outcome, **kw):
        result.update(outcome=outcome, **kw)
        journal({**base, 'outcome': outcome, **kw})
        with open(out, 'w') as f:
            json.dump(result, f)
        return 0 if outcome == 'replaced' else 3

    try:
        token = rc.server_token()
        cfg = rc.host_config(server, token, host)
    except Exception as e:
        # The apply step must always leave a result behind: a silent death reads like a refused lease,
        # and the two are not the same thing (this one may have left the host half-changed).
        return done('apply_failed', reason=f'host-config read failed: {type(e).__name__}')
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
    return ['vpt-lease', 'run', os.environ.get('RTSP_LEASE_ENV', 'node1-vpt'), host, '--agent', AGENT, '--kind', 'host', '--priority', 'P3', '--ttl', '10',
            '--max-wait', str(max_wait if max_wait is not None else os.environ.get('RTSP_LEASE_MAX_WAIT', '5')),
            '--purpose', f'rtsp nightly: replace {device} source', '--',
            sys.executable, os.path.abspath(__file__), '--apply', env, host, device, pool_id, '--out', out]  # env = the server label of RTSP_CHECK_SERVERS


def same_title(a, b):
    """Two device titles are the same when they only differ in case or surrounding spaces."""
    return (a or '').strip().casefold() == (b or '').strip().casefold()


def app_device_name(server, host, device, expected=None, timeout=None):
    """The title the app shows for a device.

    The app's device list comes from the host's heartbeat: the host reports its devices with their names
    every 30 s and the server serves that list. A device renamed in the host config shows under its new name
    only once the host reports it, so the night polls until the name shows up (or the timeout is over).
    -> the name the app shows, None when the host never reported the device.
    """
    timeout = TITLE_CHECK if timeout is None else timeout
    try:
        token = rc.server_token()
    except Exception:
        return None
    deadline = time.time() + max(0, timeout)
    while True:
        name = None
        try:
            for h in rc.api(server, '/server/system/getAllHosts', token).get('hosts') or []:
                if h.get('host_name') != host:
                    continue
                for d in h.get('devices') or []:
                    if str(d.get('device_id') or '').lower() == device.lower():
                        name = d.get('device_name')
        except Exception:
            pass
        if name and (expected is None or same_title(name, expected)):
            return name
        if time.time() >= deadline:
            return name
        time.sleep(10)


def apply_with_lease(e, s, max_wait=None):
    """Run the apply step inside the host lease. -> (res, detail, cli_missing). res is None when the lease was not
    granted (nothing was touched) or the apply step wrote no result. detail is the whole output (the journal
    keeps its tail): the "the lease was granted" marker is printed before the command runs, so a tail would lose it."""
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
        detail = rc.redact((p.stdout or '') + '\n' + (p.stderr or ''))
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
    pool_state = probe_pool(pool, ssh_map, timeout)  # does the pool still play? (read-only: the pool is never edited here)
    capture_mode = read_mode('capture-mode')  # the capture-driven repair has its own switch: dry until one clean night
    budget = int(pool.get('maxReplacementsPerNight', 3)) - replaced_today()
    rows = []
    catalog = None
    chosen = {}
    deferred = []   # repairs the host lease blocked: retried at the end of the night
    installed = []  # the sources this night put in place: verified again before the night ends

    def choose(e, exclude=()):
        """The source this device could get tonight: the same channel under a new URL, else another channel of the
        same group (hls), else the first vetted pool source that plays (rtsp). -> the choice, or None."""
        nonlocal catalog
        if e['kind'] == 'hls':
            if catalog is None:
                catalog, cat_err = sc.load()
                errors.extend(cat_err)
            used = [x['url'] for x in entries if x['host'] == e['host']] + chosen.setdefault(e['host'], [])
            s = pick_hls(e, catalog, used, ssh_map, timeout, exclude=exclude)
            if s:
                chosen[e['host']].append(s['url'])  # one channel per host: never give it to a second device tonight
            return s
        p0 = pick(e, pool, ssh_map, timeout, exclude)
        return p0 and {'id': p0['id'], 'url': p0['url'], 'how': 'replace', 'label': f"pool {p0['id']}"}

    def apply_choice(e, s, row, max_wait=None):
        """Apply a chosen source under the host lease; the row says what happened. -> the outcome."""
        res, detail, cli_missing = apply_with_lease(e, s, max_wait)
        if res is None:  # the lease was refused or the apply step died: no stream was replaced
            why = apply_failure(detail, cli_missing)
            if why == 'lease_not_available':
                row['action'] = 'report: the lease command could not be run (vpt-lease missing), nothing touched'
            elif why == 'apply_failed':
                row['action'] = 'report: the lease was granted but the apply step failed (see the journal), the host may be half-changed'
            else:
                row['action'] = 'report: host lease not granted (busy or refused), nothing touched'
            journal({'event': 'replace', 'host': e['host'], 'device': e['device'], 'outcome': why, 'detail': detail[-200:]})
            return why
        row['action'] = (f"report: the apply step failed ({res.get('reason', 'see the journal')}), nothing replaced"
                         if res['outcome'] == 'apply_failed' else f"{res['outcome']} ({s['how']}: '{s['label']}')")
        return res['outcome']
    for e, r, cap in zip(entries, results, caps):
        row = rc.public_entry(e, r)
        row.update({k: v for k, v in cap.items() if k != 'detail'})
        src_ok = r['status'] in rc.OK_STATES
        black_src = False
        file_black = src_ok and cap['capture'] == 'black' and e['kind'] == 'file'
        if src_ok and cap['capture'] == 'black' and e['kind'] == 'hls':
            # Judge the channel over a WINDOW of frames, not on its first frame (2026-11-14): the first frame of a
            # Pluto TV channel is the dark start of an ad break (17/255 on vpt-nipogi/DEVICE7) while the channel
            # itself is bright (103-119 over the window). A channel that is really black stays dark in every
            # sample (16/255 on vpt-nipogi/DEVICE31), so the window does not hide a dead channel.
            y = rc.source_luma(e['url'], 20, ssh_map.get(e['host']))
            row['source_luma'] = None if y is None else round(y, 1)
            black_src = y is not None and y < rc.BLACK_LUMA
        if file_black:
            # A file is only reported, never changed, and never blamed on the capture side (owner, 2026-11-13).
            # The clip's own picture is measured now (bug-59664715), so the line says what was seen instead of
            # assuming a cause: the clip's own dark frame, or a tile that shows something else.
            fl = rc.file_luma(e['url'], 20, ssh_map.get(e['host']))
            row['source_luma'] = None if fl is None else round(fl, 1)
            if fl is None:
                row['action'] = ("report: the tile's snapshot and its live video are black: the clip's own picture could"
                                 " not be read (the capture side is not proven), not changed")
            elif fl < rc.BLACK_LUMA:
                row['action'] = ("report: the tile's snapshot and its live video are black, and the clip's own picture is"
                                 f" dark too (luma {row['source_luma']}): the black frame is the clip's own, not a dead"
                                 " stream, not changed")
            else:
                row['action'] = (f"report: the clip plays (luma {row['source_luma']}) but the tile's snapshot and its live"
                                 " video are black: the tile's own frames are dark, not changed")
        elif src_ok and not black_src and cap['capture'] not in ('ok', 'unknown'):
            if cap['capture'] == 'multi_audio':
                row['action'] = (f"report: the source plays but the host stream has {cap.get('audio')} audio tracks: the browser's"
                                 " live player cannot play it: the host's vpt-stream runs a run_ffmpeg.sh from before the one-track"
                                 " fix (bug-ea31641c): restart vpt-stream on that host under its lease, not changed")
            else:
                what = ("the tile's snapshot and its live video are black" if cap['capture'] == 'black'
                        else f"the tile's snapshot is {cap['capture']}")
                row['action'] = (f"report: the source plays but {what}"
                                 + (f" ({cap['age']} s old)" if cap['capture'] == 'stale' and cap.get('age') is not None else '')
                                 + ": host capture side (vpt-stream / thumbnails), not changed")
        elif src_ok and not black_src:
            # The thumbnail was dark but the live video plays: the tile is not broken, a looping clip simply moves
            # (2026-11-13, bug-6b227d92). Say so instead of losing it.
            dark_thumb = cap.get('luma') is not None and cap['luma'] < rc.BLACK_LUMA
            moment = 'clip' if e['kind'] == 'file' else 'channel'
            if cap['capture'] == 'ok' and dark_thumb:
                # the two numbers are the proof of the note (bug-6c8bbe31): the reader must not need the JSON for them
                nums = f"snapshot luma {cap['luma']:.0f}"
                if cap.get('live_luma') is not None:
                    nums += f", live luma {cap['live_luma']:.0f}"
                row['action'] = (f"note: the tile's snapshot was dark but the live video plays (a dark moment of the {moment}),"
                                 f" not changed ({nums})")
            else:
                if cap['capture'] == 'unknown' and dark_thumb:
                    # the live video could not be read: the tile is not proven broken, and it is not blamed either
                    row['action'] = ("report: the tile's snapshot is dark and its live video could not be read: the tile is not"
                                     " proven broken (the capture side), not changed")
                else:
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
            s = choose(e)
            if not s:
                row['action'] = ('report: no working same channel or same-group channel in the lists' if e['kind'] == 'hls'
                                 else 'report: no vetted pool source plays now')
            elif mode != 'live':
                row['action'] = f"dry: would {s['how']} with '{s['label']}'" + (f" (device renamed '{s['name']}')" if s.get('name') and s['name'] != e.get('name') else '')
            else:
                outcome = apply_choice(e, s, row)
                if outcome in ('replaced', 'rolled_back'):
                    budget -= 1
                if outcome == 'lease_not_granted':
                    # The host was busy for the short wait: try again at the end of the night, when the other
                    # work is done and the lease is more likely free. A busy lease must not cost the night a stream.
                    deferred.append((e, s, row))
                elif outcome == 'replaced':
                    installed.append((e, s, row))
        rows.append(row)
        journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'capture': row.get('capture'), 'luma': row.get('luma'), 'action': row['action'], 'source': row['source']})
    # The night is over: retry the repairs the host lease blocked, with the long wait.
    for e, s, row in deferred:
        if budget <= 0:
            row['action'] = 'report: replacement budget used up tonight'
            continue
        outcome = apply_choice(e, s, row, max_wait=int(os.environ.get('RTSP_LEASE_RETRY_MAX_WAIT', '20')))
        if outcome in ('replaced', 'rolled_back'):
            budget -= 1
        if outcome == 'replaced':
            installed.append((e, s, row))
        elif outcome == 'lease_not_granted':
            row['action'] = 'report: host lease not granted again at the end of the night, nothing touched'
        elif outcome == 'apply_failed':
            row['action'] = ('report: the lease was granted but the apply step failed at the end of the night (see the journal),'
                             ' the host may be half-changed')
        journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'capture': row.get('capture'), 'luma': row.get('luma'), 'action': row['action'], 'source': row['source']})
    # Before the night ends: verify what it installed. A source can die minutes after it was put in place (a CDN
    # whose signed segments expire, bug-80678895) and the channel would then stay dead until the next night.
    if mode == 'live' and installed:
        time.sleep(INSTALL_VERIFY)
        for e, s, row in list(installed):
            st = rc.check_stream(s['url'], timeout * 3, ssh_map.get(e['host']))['status']
            if st in ('ok', 'unverified', 'frozen'):
                row['action'] += ' (the new source still plays)'
                journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': 'plays', 'source': s['url']})
                # The title the app shows for the device comes from the host's device list: a renamed
                # device is renamed on the tile only once the host has reported the new name
                # (bug-ee21b77c). Only a device the night really renamed is checked.
                new_title = (s.get('name') or '').strip()
                if new_title and not same_title(new_title, e.get('name')):
                    shown = app_device_name(e['server'], e['host'], e['device'], expected=new_title)
                    row['app_title'] = shown
                    if shown and same_title(shown, new_title):
                        row['action'] += f" (the app shows the new title {shown!r})"
                        journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': 'title_updated', 'name': new_title})
                    else:
                        row['action'] += (f" (the app still shows the title {shown!r})" if shown
                                          else " (the app shows no title for the device)")
                        journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': 'title_stale', 'name': new_title, 'shown': shown})
                continue
            # the source the night installed is dead again: take the next candidate that plays
            if budget <= 0:
                row['action'] += ' (the new source died again: the replacement budget is used up tonight)'
                journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': 'died_again', 'source': s['url'], 'detail': 'no budget left tonight'})
                continue
            s2 = choose(e, exclude=(s['url'],))
            if not s2:
                row['action'] += ' (the new source died again and no other source plays now)'
                journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': 'died_again', 'source': s['url'], 'detail': 'no other candidate plays'})
                continue
            before = row['action']
            outcome = apply_choice(e, s2, row)
            if outcome in ('replaced', 'rolled_back'):
                budget -= 1
            row['action'] = f"{before}, but the new source died again: {row['action']}"
            journal({'event': 'verify', 'host': e['host'], 'device': e['device'], 'outcome': f"died_again_{outcome}", 'source': s['url'], 'new': s2['url']})
        for e, s, row in installed:
            journal({'event': 'check', 'host': row['host'], 'device': row['device'], 'kind': row['kind'], 'status': row['status'], 'capture': row.get('capture'), 'luma': row.get('luma'), 'action': row['action'], 'source': row['source']})
    return {'mode': mode, 'streams': rows, 'errors': errors, 'hosts': hosts, 'pool': pool_state}


def report_path(day, mode):
    """Where the day's report goes. A dry run never overwrites the day's LIVE report: a read-only run
    must not destroy the night's evidence (the report of 2026-11-19 was replaced by an empty dry one
    this way). A dry run beside a live report gets its own file."""
    path = os.path.join(STATE, f'report-{day}.json')
    if mode != 'dry':
        return path
    try:
        with open(path, encoding='utf-8') as f:
            if json.load(f).get('mode') == 'live':
                return os.path.join(STATE, f'report-{day}-dry.json')
    except (OSError, ValueError):
        pass
    return path


def main(argv):
    # A real parser: an unknown flag used to be ignored and the night ran anyway (bug: `--help` ran a
    # dry pass and overwrote the day's live report). Now `--help` prints the usage and exits, and an
    # unknown flag is an error: nothing runs.
    ap = argparse.ArgumentParser(prog='rtsp_replace.py', description='the nightly RTSP check and replacement policy')
    ap.add_argument('--mode', choices=('dry', 'live'), default=os.environ.get('RTSP_NIGHTLY_MODE', 'dry'),
                    help='dry: probe and report only (default); live: apply the policy')
    ap.add_argument('--apply', nargs=4, metavar=('ENV', 'HOST', 'DEVICE', 'SRC_FILE'), help=argparse.SUPPRESS)
    ap.add_argument('--out', help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.apply:
        return apply_one(a.apply[0], a.apply[1], a.apply[2], a.apply[3], a.out)  # pid = the chosen-source JSON file
    mode = a.mode
    rep = run(mode)
    os.makedirs(STATE, exist_ok=True)
    day = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    with open(report_path(day, mode), 'w') as f:
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
    if rep.get('pool'):
        print('pool: ' + ', '.join(f"{p['id']} {p['status']} (from {p['from']})" for p in rep['pool']))
    walked = f"{rep['hosts']['walked']} host(s) walked, {rep['hosts']['read']} read"
    if not rep['streams']:
        print('no stream devices found' + (' (inventory errors above)' if rep['errors'] else '') + f' ({walked})')
    else:
        print(walked)
    return 1 if (bad or rep['errors']) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
