#!/usr/bin/env python3
"""rtsp_check: is a network/file stream source alive? (stdlib only; ffprobe + ffmpeg on PATH)

Scope (owner, 2026-11-11): every device of model `rtsp_video` (the app's generic stream model: rtsp://, HLS http(s)://, looping
local files, empty source) plus any rtsp:// source. Kinds: loopback | public | ip_camera (rtsp), hls, file, no_source.

Per stream: connects (ffprobe, 10 s), has a video stream (codec / resolution), and frames advance
(ffmpeg decodes 12 frames, per-frame md5s must differ and pts must move). Statuses: ok, no_connect, no_video,
frozen, timeout, unverified (loopback source on a host we cannot reach). Credentials never leave memory:
every printed or journaled string goes through redact().

  rtsp_check.py URL [URL...]            check URLs (label = redacted URL)
  rtsp_check.py --inventory             check every rtsp DEVICE<n>_VIDEO of the hosts on RTSP_CHECK_SERVERS
  --host H   probe these URLs from the host H (its ssh alias comes from RTSP_CHECK_SSH): a loopback source is
             only reachable there
  --ssh ALIAS   probe these URLs from that ssh alias directly
  --json   JSON only   --timeout N   per-step seconds (default 10)
Exit: 0 all ok or unverified, 1 a stream is not ok, 2 nothing could be checked (no server, no streams, auth failure).
Env: RTSP_CHECK_SERVERS="<label>=<server url>,..." ; RTSP_CHECK_TOKEN_CMD (prints an X-Auto-Sign token);
     RTSP_CHECK_SSH="<host>=<ssh alias>,..." (probe loopback sources on the host itself).
"""
import json, os, re, subprocess, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

FFPROBE = os.environ.get('RTSP_CHECK_FFPROBE', 'ffprobe')
FFMPEG = os.environ.get('RTSP_CHECK_FFMPEG', 'ffmpeg')
CRED = re.compile(r'(?i)(rtsps?|https?|rtmp|udp)://[^/\s@]*@')
OK_STATES = ('ok', 'unverified')  # unverified = could not be probed from here, not a failure
LOOPBACK = {'127.0.0.1', 'localhost', '::1'}


def redact(text):
    """Strip user:password@ from any URL inside text."""
    return CRED.sub(lambda m: m.group(1) + '://***@', str(text))


def clean_value(raw):
    """A host-config value may carry an inline `  # comment`; the source is what is before it."""
    return re.split(r'\s+#', str(raw).strip(), maxsplit=1)[0].strip()


def is_rtsp(value):
    return clean_value(value).lower().startswith(('rtsp://', 'rtsps://'))


def is_http(value):
    return clean_value(value).lower().startswith(('http://', 'https://'))


def is_file(value):
    v = clean_value(value)
    return v.startswith('file://') or v.startswith('/')


def host_of(url):
    try:
        return (urllib.parse.urlsplit(url).hostname or '').lower()
    except ValueError:
        return ''


def is_loopback(url):
    return host_of(url) in LOOPBACK


def _run(cmd, timeout, ssh=None):
    if ssh:  # the source is only reachable from the host: run the same tool there
        cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, ' '.join(_q(c) for c in cmd)]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _q(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def check_stream(url, timeout=10, ssh=None):
    """-> dict(status, detail, codec, width, height, frames, distinct). Never contains the credentials."""
    url = clean_value(url)
    if not url:
        return {'status': 'no_source', 'detail': 'DEVICE_VIDEO is empty', 'codec': None, 'width': None, 'height': None, 'frames': 0, 'distinct': 0}
    out = {'status': 'no_connect', 'detail': '', 'codec': None, 'width': None, 'height': None, 'frames': 0, 'distinct': 0}
    if (is_loopback(url) or is_file(url)) and not ssh:
        out.update(status='unverified', detail='loopback/file source: only the host can reach it (no ssh alias set)')
        return out
    # input options only the matching demuxer/protocol knows: an unknown one makes ffmpeg refuse the input
    opts = (['-rtsp_transport', 'tcp', '-timeout', str(int(timeout * 1e6))] if is_rtsp(url)
            else ['-rw_timeout', str(int(timeout * 1e6))] if is_http(url) else [])
    try:
        p = _run([FFPROBE, '-v', 'error', *opts,
                  '-show_streams', '-select_streams', 'v', '-of', 'json', url], timeout, ssh)
    except subprocess.TimeoutExpired:
        out.update(status='timeout', detail=f'ffprobe timed out after {timeout}s')
        return out
    except OSError as e:
        out.update(detail=redact(f'cannot run ffprobe: {e}'))
        return out
    if p.returncode != 0:
        out['detail'] = redact((p.stderr or 'ffprobe failed').strip().splitlines()[-1] if (p.stderr or '').strip() else 'ffprobe failed')[:200]
        return out
    try:
        streams = json.loads(p.stdout or '{}').get('streams') or []
    except ValueError:
        streams = []
    if not streams:
        out.update(status='no_video', detail='connected, no video stream')
        return out
    s = streams[0]
    out.update(codec=s.get('codec_name'), width=s.get('width'), height=s.get('height'))
    # Decode 12 frames sampled at 4 fps (~3 s of picture: a still scene of 0.5 s is not a frozen stream), bounded by the timeout. Not `-t 3`: an RTSP stream's first
    # pts is the publisher's uptime, so -t cut everything on a live smoke stream. framemd5 prints one line per frame:
    # "0, pts, dts, dur, size, md5".
    try:
        stdout = _run([FFMPEG, '-v', 'error', *opts, '-i', url,
                       '-vf', 'fps=4', '-frames:v', '12', '-an', '-f', 'framemd5', '-'], timeout, ssh).stdout
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout.decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
    frames = []
    for line in stdout.splitlines():
        parts = [x.strip() for x in line.split(',')]
        if len(parts) >= 6 and parts[0].isdigit():
            frames.append((parts[1], parts[-1]))
    out['frames'] = len(frames)
    out['distinct'] = len({m for _, m in frames})
    pts = {t for t, _ in frames}
    if len(frames) < 2:
        out.update(status='frozen', detail=f'{len(frames)} frame(s) decoded')
    elif out['distinct'] < 2 or len(pts) < 2:
        out.update(status='frozen', detail='frames do not change')
    else:
        out.update(status='ok', detail='')
    return out


# ---- inventory through the server's host-config route (GET only here) ----
def parse_pairs(text):
    d = {}
    for part in (text or '').split(','):
        if '=' in part:
            k, v = part.split('=', 1)
            d[k.strip()] = v.strip()
    return d


def server_token():
    cmd = os.environ.get('RTSP_CHECK_TOKEN_CMD') or os.path.expanduser('~/virtualpytest/scripts/agent/auto_sign_token.sh')
    return subprocess.run([cmd], capture_output=True, text=True, timeout=30).stdout.strip()


def api(server, path, token, body=None, timeout=60, retries=None):
    """GETs retry on 5xx / network errors (a slow server behind its proxy answers 502 now and then: one blip skipped a whole
    server's hosts for the night). A POST is never retried."""
    import time, urllib.error
    tries = (int(os.environ.get('RTSP_API_RETRIES', '3')) if retries is None else retries) if body is None else 1
    for attempt in range(tries):
        try:
            return _api_once(server, path, token, body, timeout)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
        time.sleep(float(os.environ.get('RTSP_API_RETRY_SECONDS', '10')) * (attempt + 1))


def _api_once(server, path, token, body=None, timeout=60):
    req = urllib.request.Request(server.rstrip('/') + path, headers={'X-Auto-Sign': token, 'Content-Type': 'application/json', 'User-Agent': 'rtsp-nightly/1'},
                                 data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or '{}')


def host_names(server, token):
    return sorted(h.get('host_name') for h in api(server, '/server/system/getAllHosts', token).get('hosts', []) if h.get('host_name'))


def host_config(server, token, host):
    return api(server, '/server/settings/host-config?host_name=' + urllib.parse.quote(host), token, timeout=40)


def classify(url, pool):
    """no_source | file | hls | loopback | public (host is in the pool's public hosts) | ip_camera (any other rtsp: owner hardware)."""
    if not clean_value(url):
        return 'no_source'
    if is_file(url):
        return 'file'
    if is_http(url):
        return 'hls'
    h = host_of(clean_value(url))
    if h in LOOPBACK:
        return 'loopback'
    if h in {host_of(e['url']) for e in pool.get('sources', []) if e.get('kind') == 'public'}:
        return 'public'
    return 'ip_camera'


def load_pool(path=None):
    path = path or os.environ.get('RTSP_POOL_FILE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'config', 'rtsp-pool.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def inventory(servers, pool):
    """-> (entries, errors, hosts). entries carry the raw url in memory only (key 'url'); use public_entry() to print.
    hosts: how much was looked at ('walked' hosts listed, 'read' hosts that answered), so a night with no rtsp
    device says how much was walked instead of looking like an empty inventory."""
    entries, errors = [], []
    walked = read = 0
    for env, server in servers.items():
        try:
            token = server_token()
            names = host_names(server, token)
        except Exception as e:
            errors.append(f'{env}: {type(e).__name__}')
            continue
        walked += len(names)
        for host in names:
            try:
                devs = host_config(server, token, host).get('devices') or {}
            except Exception as e:
                errors.append(f'{env}/{host}: {type(e).__name__}')
                continue
            read += 1
            for dev, f in sorted(devs.items()):
                v = f.get('DEVICE_VIDEO', '')
                if is_rtsp(v) or f.get('DEVICE_MODEL') == 'rtsp_video':
                    entries.append({'env': env, 'server': server, 'host': host, 'device': dev, 'name': f.get('DEVICE_NAME', ''),
                                    'url': clean_value(v), 'kind': classify(v, pool)})
    return entries, errors, {'walked': walked, 'read': read}


def public_entry(e, res=None):
    d = {k: v for k, v in e.items() if k not in ('url', 'server')}
    d['source'] = redact(e['url'])
    if res:
        d.update(res)
    return d


def check_entries(entries, ssh_map, timeout):
    with ThreadPoolExecutor(max_workers=4) as ex:
        return list(ex.map(lambda e: check_stream(e['url'], timeout, ssh_map.get(e['host'])), entries))


def table(rows):
    cols = ['host', 'device', 'kind', 'status', 'codec', 'res', 'source']
    lines = [[str(r.get(c, '') or '') for c in cols] for r in rows]
    for r, l in zip(rows, lines):
        l[5] = f"{r.get('width')}x{r.get('height')}" if r.get('width') else ''
    w = [max(len(c), *(len(l[i]) for l in lines)) if lines else len(c) for i, c in enumerate(cols)]
    fmt = lambda l: '  '.join(x.ljust(w[i]) for i, x in enumerate(l)).rstrip()
    return '\n'.join([fmt(cols), *map(fmt, lines)])


def main(argv=None):
    a = list(sys.argv[1:] if argv is None else argv)
    as_json = '--json' in a
    timeout = 10
    if '--timeout' in a:
        i = a.index('--timeout'); timeout = int(a[i + 1]); del a[i:i + 2]
    ssh_map = parse_pairs(os.environ.get('RTSP_CHECK_SSH'))
    ssh = None
    # A loopback source is only reachable from the host that runs it: without an alias the probe can only say
    # 'unverified'. --host takes the alias of that host from RTSP_CHECK_SSH, --ssh names it directly.
    if '--ssh' in a:
        i = a.index('--ssh'); ssh = a[i + 1]; del a[i:i + 2]
    if '--host' in a:
        i = a.index('--host'); ssh = ssh_map.get(a[i + 1]); del a[i:i + 2]
    flags = {x for x in a if x.startswith('--')}
    urls = [x for x in a if not x.startswith('--')]
    errors, rows = [], []
    hosts = None
    if '--inventory' in flags:
        pool = load_pool()
        entries, errors, hosts = inventory(parse_pairs(os.environ.get('RTSP_CHECK_SERVERS')), pool)
        rows = [public_entry(e, r) for e, r in zip(entries, check_entries(entries, ssh_map, timeout))]
    else:
        for u in urls:
            rows.append({'host': '-', 'device': '-', 'kind': 'adhoc', 'source': redact(u), **check_stream(u, timeout, ssh)})
    report = {'streams': rows, 'errors': errors, 'ok': sum(r['status'] == 'ok' for r in rows), 'total': len(rows)}
    if hosts is not None:
        report['hosts'] = hosts
    print(json.dumps(report, indent=2) if as_json else table(rows) + ''.join(f'\nERROR {e}' for e in errors) + f"\n{report['ok']}/{report['total']} ok"
          + (f" ({hosts['walked']} host(s) walked, {hosts['read']} read)" if hosts else ''))
    if not rows:
        return 2
    return 0 if all(r['status'] in OK_STATES for r in rows) and not errors else 1


if __name__ == '__main__':
    sys.exit(main())
