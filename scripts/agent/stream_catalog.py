#!/usr/bin/env python3
"""stream_catalog: the free TV channel lists the nightly uses to repair a dead HLS device (owner, 2026-11-11).

Order for a dead HLS channel (docs/RTSP-NIGHTLY.md):
  1. restore: the SAME channel (same tvg-id, else same name) under a new URL in the fresh upstream list;
  2. replace: another channel of the SAME group (News, Music, ...) from our verified list, not already on that host,
     same resolution tag first; the device is renamed to it, its prefix kept ("FR Regional 3 — <new channel>");
  3. nothing found: report.
Every candidate is probed by the caller before use. Lists (RTSP_CHANNEL_LISTS, comma separated paths or URLs; default
below): the iptv-org upstream playlist first (freshest URLs), then the verified repo copy (virtualpytest
docs/agent/iptv-france-streams/fr.m3u). A list that cannot be read is skipped.
"""
import os, re, urllib.request

DEFAULT_LISTS = ['https://iptv-org.github.io/iptv/countries/fr.m3u',
                 os.path.expanduser('~/virtualpytest/docs/agent/iptv-france-streams/fr.m3u')]
RES = re.compile(r'\s*\((\d{3,4}p)\)')
TAGS = re.compile(r'\s*\[[^\]]*\]')


def base_url(url):
    return (url or '').split('?')[0].strip()


def norm(name):
    """'FR Regional 3 — Littoral FM TV (720p)' -> 'littoral fm tv'"""
    n = name.split('—')[-1]
    n = TAGS.sub('', RES.sub('', n))
    return re.sub(r'\s+', ' ', n).strip().lower()


def parse_m3u(text, source=''):
    out, cur = [], None
    for line in (text or '').splitlines():
        line = line.strip()
        if line.startswith('#EXTINF'):
            name = line.rsplit(',', 1)[-1].strip()
            g = re.search(r'group-title="([^"]*)"', line)
            t = re.search(r'tvg-id="([^"]*)"', line)
            res = RES.search(name)
            cur = {'name': RES.sub('', TAGS.sub('', name)).strip(), 'key': norm(name), 'tvg_id': t.group(1) if t else '',
                   'group': (g.group(1) if g else '').split(';')[0], 'res': res.group(1) if res else '',
                   'ua': 'http-user-agent' in line, 'list': source}
        elif cur and line.startswith('#EXTVLCOPT') and 'user-agent' in line:
            cur['ua'] = True
        elif cur and line.startswith('http'):
            cur['url'] = line
            out.append(cur)
            cur = None
    return out


def read_list(src, timeout=30):
    if src.startswith(('http://', 'https://')):
        req = urllib.request.Request(src, headers={'User-Agent': 'rtsp-nightly/1'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode('utf-8', 'replace')
    with open(os.path.expanduser(src), encoding='utf-8') as f:
        return f.read()


def load(lists=None):
    """-> (entries, errors). Upstream first: its URLs are the freshest."""
    lists = lists or [x.strip() for x in (os.environ.get('RTSP_CHANNEL_LISTS') or '').split(',') if x.strip()] or DEFAULT_LISTS
    entries, errors = [], []
    for i, src in enumerate(lists):
        try:
            entries += parse_m3u(read_list(src), 'upstream' if i == 0 else 'repo')
        except Exception as e:  # a list we cannot read is skipped, the others still serve
            errors.append(f'channel list {i + 1}: {type(e).__name__}')
    return entries, errors


def url_tokens(url):
    """host + long path segments: a channel's stream id survives a URL change ('/manifest/<id>/...' -> '/master/<id>/...')."""
    try:
        from urllib.parse import urlsplit
        u = urlsplit(base_url(url))
    except ValueError:
        return set()
    return {(u.hostname or '', seg) for seg in u.path.split('/') if len(seg) >= 16}


def identify(name, url, catalog):
    """The catalog entry of the channel a device plays: same URL, else a shared stream id, else same name, else name prefix."""
    b = base_url(url)
    for c in catalog:
        if base_url(c['url']) == b:
            return c
    t = url_tokens(url)
    for c in catalog:
        if t & url_tokens(c['url']):
            return c
    k = norm(name or '')
    if not k:
        return None
    return (next((c for c in catalog if c['key'] == k), None)
            or next((c for c in catalog if len(k) >= 6 and (c['key'].startswith(k) or k.startswith(c['key']))), None))


def candidates(name, url, used_urls, catalog):
    """Yields (kind, entry, new_device_name). kind: restore | replace."""
    cur = identify(name, url, catalog)
    used = {base_url(u) for u in used_urls}
    seen = set()
    if cur:
        for c in catalog:  # 1. same channel, new URL
            same = (cur['tvg_id'] and c['tvg_id'] == cur['tvg_id']) or c['key'] == cur['key']
            if same and base_url(c['url']) != base_url(url) and base_url(c['url']) not in seen:
                seen.add(base_url(c['url']))
                yield 'restore', c, name
    group = cur['group'] if cur else ''
    res = cur['res'] if cur else ''
    if not group:
        return
    pool = [c for c in catalog if c['group'] == group and not c['ua'] and base_url(c['url']) not in used
            and (not cur or c['key'] != cur['key'])]
    pool.sort(key=lambda c: (c['res'] != res, c['list'] != 'repo'))  # same resolution, verified list first
    prefix = name.split('—')[0].strip() if name and '—' in name else ''
    for c in pool:  # 2. another channel of the same group
        if base_url(c['url']) in seen:
            continue
        seen.add(base_url(c['url']))
        label = c['name'] + (f" ({c['res']})" if c['res'] else '')
        yield 'replace', c, (f'{prefix} — {label}' if prefix else label)
