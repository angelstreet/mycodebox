import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers-tmp.js';

const dir = tmp('sc-cache-');
const env = { ...process.env, GHOSTY_STATE_DIR: dir };
const { cachedScorecard, _resetScorecardCache } = await import('../scorecard.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('cachedScorecard: fresh answers are shared, a stale one is served at once and refreshed once in the background', async () => {
  _resetScorecardCache();
  fs.writeFileSync(path.join(dir, 'usage-ledger.jsonl'), '');
  const first = await cachedScorecard({ days: 2, ttlMs: 60, staleMs: 5000, env });
  assert.equal(await cachedScorecard({ days: 2, ttlMs: 60, staleMs: 5000, env }), first, 'inside the ttl: the same object');
  await wait(90);
  const t0 = Date.now();
  const stale = await cachedScorecard({ days: 2, ttlMs: 60, staleMs: 5000, env });
  assert.equal(stale, first, 'past the ttl but not stale: the old value comes back without waiting');
  assert.ok(Date.now() - t0 < 30, 'at once');
  await wait(200);   // the background refresh lands
  const fresh = await cachedScorecard({ days: 2, ttlMs: 60000, staleMs: 5000, env });
  assert.notEqual(fresh, first, 'the background load replaced it');
});

test('cachedScorecard: past staleMs the caller waits for a new load', async () => {
  _resetScorecardCache();
  const first = await cachedScorecard({ days: 1, ttlMs: 10, staleMs: 40, env });
  await wait(80);
  const next = await cachedScorecard({ days: 1, ttlMs: 10, staleMs: 40, env });
  assert.notEqual(next, first);
});
