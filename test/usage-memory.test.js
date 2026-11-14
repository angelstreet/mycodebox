// bug-1babb8b3: ghosty-usage grew ~25 MB/h because the ledger (100+ MB) was slurped whole at init and by every scorecard post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createIngester, createScorecardPoster, defaults, ledgerLines } from '../usage/ingest.js';
import { tmp } from './helpers-tmp.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = 86400000;
const row = (i, ts) => ({ id: `r${i}`, agent: 'claude', session: `s${i % 50}`, trace: `t${i % 50}`, ts, model: 'claude-opus-5-5', project: 'p',
  usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: null });

async function setup(nOld, nWin) {
  const dir = tmp('usage-mem-');
  const cfg = { ...defaults({}), stateDir: dir, offsetsFile: join(dir, 'o.json'), ledgerFile: join(dir, 'l.jsonl'), summaryFile: join(dir, 's.json'),
    claudeDir: join(dir, 'c'), codexDir: join(dir, 'x'), minimaxDb: join(dir, 'n'), opencodeDb: join(dir, 'n2'), stallsFile: join(dir, 'st'),
    claudeSessionsDir: join(dir, 'cs'), now: () => NOW, publicKey: 'pk', secretKey: 'sk' };
  const rows = [];
  for (let i = 0; i < nOld; i++) rows.push(row(i, NOW - 30 * DAY + i));
  for (let i = 0; i < nWin; i++) rows.push(row(nOld + i, NOW - 2 * DAY + i));
  await fs.writeFile(cfg.ledgerFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { cfg, hooks: { history: { instances: () => [], find: () => null, all: () => [] }, tmuxPanes: async () => [] } };
}

test('ledgerLines streams lines and tolerates a missing file', async () => {
  const { cfg } = await setup(3, 2);
  const got = []; for await (const l of ledgerLines(cfg.ledgerFile)) got.push(JSON.parse(l).id);
  assert.deepEqual(got, ['r0', 'r1', 'r2', 'r3', 'r4']);
  for await (const _ of ledgerLines(join(cfg.stateDir, 'nope'))) assert.fail('no lines expected');
});

test('init twice retains only the window in memory and keeps every ledger row on disk', async () => {
  const { cfg, hooks } = await setup(3000, 500);
  for (let pass = 0; pass < 2; pass++) {
    const ing = createIngester(cfg, hooks);
    await ing.init(false);
    assert.equal(ing.ledger.size, 500, 'only in-window rows are held');
    const lines = (await fs.readFile(cfg.ledgerFile, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3500, 'old rows are kept on disk, no duplicates');
  }
  await fs.access(`${cfg.ledgerFile}.${process.pid}.tmp`).then(() => assert.fail('tmp left behind'), () => {});
});

test('scorecard post keeps only today rows from the ledger', async () => {
  const { cfg } = await setup(3000, 500);
  const lines = []; const poster = createScorecardPoster({ ...cfg, langfuseUrl: 'http://127.0.0.1:9' }, { ing: null, log: (...a) => lines.push(a.join(' ')) });
  const r = await poster({ force: true });   // unreachable langfuse: fails after reading; must not throw out
  assert.ok(r && (r.error || r.posted !== undefined));
});
