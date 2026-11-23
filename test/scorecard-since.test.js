// readJsonl(since): old rows are skipped without parsing, undated rows are kept (owner 2026-11-23: the scorecard re-read a 190 MB ledger on every load).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../scorecard.js';

test('since keeps recent ms-ts and ISO-at rows and undated rows, drops old ones, tolerates bad lines', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'sc-since-')), 'x.jsonl');
  const since = Date.parse('2026-11-10T00:00:00Z');
  writeFileSync(f, [
    JSON.stringify({ id: 'old-ts', ts: since - 5 * 86400000 }),
    JSON.stringify({ id: 'new-ts', ts: since + 1000 }),
    JSON.stringify({ id: 'old-at', at: '2026-11-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'new-at', at: '2026-11-20T00:00:00.000Z' }),
    JSON.stringify({ id: 'undated' }),
    '{not json', '',
  ].join('\n'));
  const rows = await readJsonl(f, { silent: true, since });
  assert.deepEqual(rows.map((r) => r.id), ['new-ts', 'new-at', 'undated']);
  assert.equal((await readJsonl(f, { silent: true })).length, 5);   // no since: everything
  assert.deepEqual(await readJsonl(join(tmpdir(), 'no-such-file.jsonl')), []);
});
