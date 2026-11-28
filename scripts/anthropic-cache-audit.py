#!/usr/bin/env python3
"""Prompt-cache and cost audit per Anthropic organisation, from the Admin API (GET only, free).

  scripts/anthropic-cache-audit.py [--days 30] [--org NAME ...] [--hourly --from 2026-01-05 --to 2026-01-08]

One organisation per ~/.config/anthropic/<org>.admin.key (the files api-credit.js reads). A key is sent only to
api.anthropic.com and never printed. Output is markdown on stdout. It names API keys and costs: never commit it
(this repo is public). How to read it: docs/ANTHROPIC-CACHE-AUDIT.md.
"""
import argparse, collections, datetime as dt, glob, json, os, re, sys, urllib.error, urllib.parse, urllib.request

BASE = 'https://api.anthropic.com/v1/organizations'
COLS = ('uncached', 'read', 'written')


def clean(text):
    return re.sub(r'sk-ant-[\w-]+', '***', str(text))


def get(key, path, params):
    """Every row of a paged report. The key list pages by id, the reports by token."""
    rows, page = [], {}
    while True:
        query = urllib.parse.urlencode(list(params) + list(page.items()))
        req = urllib.request.Request(f'{BASE}{path}?{query}', headers={'x-api-key': key, 'anthropic-version': '2023-06-01'})
        try:
            body = json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{path}: http {e.code} {clean(e.read()[:300])}') from None
        rows += body.get('data', [])
        if not body.get('has_more'):
            return rows
        page = {'page': body['next_page']} if body.get('next_page') else {'after_id': body['last_id']}


def tokens(row):
    written = sum(v or 0 for v in (row.get('cache_creation') or {}).values())
    return (row.get('uncached_input_tokens') or 0, row.get('cache_read_input_tokens') or 0, written)


def summarise(buckets, label):
    """{label(bucket, row): [uncached, read, written, output]} summed over the report's buckets."""
    out = collections.defaultdict(lambda: [0, 0, 0, 0])
    for bucket in buckets:
        for row in bucket.get('results', []):
            for i, value in enumerate((*tokens(row), row.get('output_tokens') or 0)):
                out[label(bucket, row)][i] += value
    return dict(out)


def table(title, heads, data, by_size):
    print(f'\n### {title}\n\n| {" | ".join(heads)} | uncached | read | written | output | read share |')
    print('|' + '---|' * (len(heads) + 5))
    for label, v in sorted(data.items(), key=(lambda kv: -sum(kv[1][:3])) if by_size else (lambda kv: kv[0])):
        total = sum(v[:3])
        share = f'{100 * v[1] / total:.1f}%' if total else '-'
        print(f'| {" | ".join(label)} | {" | ".join(f"{n:,}" for n in v)} | {share} |')


def audit(org, key, args):
    window = [('starting_at', args.start)] + ([('ending_at', args.end)] if args.end else [])
    names = {k['id']: k['name'] for k in get(key, '/api_keys', [('limit', '100')])}
    hourly = args.hourly
    usage = get(key, '/usage_report/messages', window + [('bucket_width', '1h' if hourly else '1d'),
                ('limit', '168' if hourly else '31'), ('group_by[]', 'api_key_id'), ('group_by[]', 'model')])
    who = lambda r: names.get(r.get('api_key_id'), 'no key (Console)' if r.get('api_key_id') is None else r['api_key_id'])
    print(f'\n## {org}')
    table('By API key and model', ('key', 'model'), summarise(usage, lambda b, r: (who(r), r['model'])), True)
    when = 13 if hourly else 10
    table('By hour (UTC)' if hourly else 'By day (UTC)', ('time', 'key', 'model'),
          summarise(usage, lambda b, r: (b['starting_at'][:when], who(r), r['model'])), False)
    cost = collections.Counter()
    for bucket in get(key, '/cost_report', window + [('bucket_width', '1d'), ('limit', '31'), ('group_by[]', 'description')]):
        for r in bucket.get('results', []):
            cost[(r.get('model') or '-', r.get('token_type') or r.get('cost_type') or '-')] += float(r.get('amount') or 0) / 100
    print(f'\n### Cost (USD, daily buckets): total {sum(cost.values()):.2f}\n\n| model | kind | USD |\n|---|---|---|')
    for (model, kind), usd in cost.most_common():
        print(f'| {model} | {kind} | {usd:.2f} |')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--from', dest='start', help='YYYY-MM-DD (UTC), instead of --days')
    parser.add_argument('--to', dest='end', help='YYYY-MM-DD (UTC), not included')
    parser.add_argument('--hourly', action='store_true', help='hour rows; give --from/--to, at most 7 days')
    parser.add_argument('--org', action='append', help='only this <org>.admin.key (repeatable)')
    parser.add_argument('--key-dir', default=os.path.expanduser('~/.config/anthropic'))
    args = parser.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc)
    args.start = f'{args.start or (now - dt.timedelta(days=args.days)).date()}T00:00:00Z'
    args.end = f'{args.end}T00:00:00Z' if args.end else None
    orgs = args.org or sorted(os.path.basename(p)[:-len('.admin.key')] for p in glob.glob(os.path.join(args.key_dir, '*.admin.key')))
    if not orgs:
        sys.exit(f'no <org>.admin.key in {args.key_dir}')
    print(f'# Anthropic cache audit, from {args.start} to {args.end or "now"} (run {now:%Y-%m-%d %H:%M} UTC)')
    failed = False
    for org in orgs:
        try:
            with open(os.path.join(args.key_dir, f'{org}.admin.key')) as f:
                audit(org, f.read().strip(), args)
        except (OSError, RuntimeError, ValueError) as e:
            failed = True
            print(f'\n## {org}\n\nfailed: {clean(e)}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
