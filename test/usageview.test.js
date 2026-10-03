import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtTok, fmtUsd, costOrNull, usageByLabel, sessionDays, sessionRows, topEntries, dayBars, summaryFresh } from '../public/usage.js';
import { createUsage } from '../usage-view.js';
import { buildSummary } from '../usage/ingest.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const z = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, cost: 0, unpriced: 0, turns: 0 };
// synthetic fixture: invented names and numbers
const summary = {
  generatedAt: '2026-10-03T11:59:00.000Z', windowDays: 14,
  total: { ...z, cost: 30, total: 3000, turns: 9 },
  perAgent: { claude: { ...z, cost: 30, total: 2000 }, minimax: { ...z, total: 1000, unpriced: 4, turns: 4 } },
  perProject: { alpha: { ...z, cost: 30, total: 2000 }, beta: { ...z, total: 1000, unpriced: 4 } },
  perModel: { 'model-x': { ...z, cost: 30, total: 2000 } },
  perDay: { '2026-10-02': { ...z, cost: 10, total: 1000 }, '2026-10-03': { ...z, cost: 20, total: 2000 } },
  today: { day: '2026-10-03', total: { ...z, cost: 20, total: 2000 }, perAgent: {}, perProject: {}, perModel: {} },
  perSession: [
    { ...z, id: 's1', session: 'busy', agent: 'claude', project: 'alpha', models: ['model-x'], cost: 25, total: 1500, turns: 5, activeHours: 2.5,
      today: { ...z, cost: 19, total: 1400, hours: 0.5, rate: 38 }, days: { '2026-10-02': { cost: 6, total: 100, unpriced: 0 }, '2026-10-03': { cost: 19, total: 1400, unpriced: 0 } } },
    { ...z, id: 's2', session: 'quiet', agent: 'claude', project: 'alpha', models: ['model-x'], cost: 5, total: 500, turns: 2, activeHours: 1,
      today: { ...z, cost: 1, total: 600, hours: 1, rate: 1 }, days: { '2026-10-03': { cost: 1, total: 600, unpriced: 0 } } },
    { ...z, id: 's3', session: 'mm', agent: 'minimax', project: 'beta', models: ['mm-1'], cost: 0, unpriced: 4, total: 1000, turns: 4, activeHours: 1,
      today: { ...z, cost: 0, unpriced: 4, total: 1000, hours: 1, rate: null }, days: { '2026-10-03': { cost: 0, total: 1000, unpriced: 4 } } },
    { ...z, id: 's4', session: 'old', agent: 'claude', project: 'alpha', models: ['model-x'], cost: 3, total: 100, turns: 1, activeHours: 0.1, today: null, days: { '2026-09-25': { cost: 3, total: 100, unpriced: 0 } } },
  ],
  outliers: [{ session: 'busy', id: 's1', project: 'alpha', agent: 'claude', ratio: 9.5, reason: '9.5x the alpha median: $38/h vs $4/h' }],
};

test('formatting: compact tokens, dollars, unpriced is a dash never $0', () => {
  assert.equal(fmtTok(12_345_678), '12.3M');
  assert.equal(fmtTok(845_000), '845k');
  assert.equal(fmtTok(312), '312');
  assert.equal(fmtTok(2_400_000_000), '2.4B');
  assert.equal(fmtTok(undefined), '0');
  assert.equal(fmtUsd(3.2), '$3.20');
  assert.equal(fmtUsd(0), '$0.00');
  assert.equal(fmtUsd(1234), '$1.2k');
  assert.equal(fmtUsd(null), '—');
  assert.equal(costOrNull({ cost: 0, unpriced: 7 }), null);
  assert.equal(costOrNull({ cost: 0, unpriced: 0 }), 0);
  assert.equal(costOrNull({ cost: 2, unpriced: 3 }), 2);
});

test('summary -> per-session status: used, idle-today, unpriced, outlier, no usage', () => {
  const m = usageByLabel(summary, NOW);
  assert.deepEqual(m.get('busy'), { todayCost: 19, todayTokens: 1400, totalCost: 25, outlier: '9.5x the alpha median: $38/h vs $4/h' });
  assert.equal(m.get('quiet').outlier, null);
  assert.equal(m.get('mm').todayCost, null);          // MiniMax: unpriced -> null, not 0
  assert.equal(m.get('mm').totalCost, null);
  assert.equal(m.get('mm').todayTokens, 1000);
  assert.equal(m.get('old').todayCost, 0);            // known session, nothing today
  assert.equal(m.get('old').todayTokens, 0);
  assert.equal(m.get('ghost'), undefined);            // no usage at all
  assert.equal(usageByLabel(null, NOW).size, 0);
});

test('stale summary (written on an earlier UTC day) reports no today usage and no outlier', () => {
  const next = NOW + 86400000;
  assert.equal(summaryFresh(summary, next), false);
  const m = usageByLabel(summary, next);
  assert.equal(m.get('busy').todayCost, 0);
  assert.equal(m.get('busy').outlier, null);
  assert.equal(m.get('busy').totalCost, 25);
});

test('sessionDays: 14 days, gaps are zero, oldest first', () => {
  const d = sessionDays(summary, 'busy', 14, NOW);
  assert.equal(d.length, 14);
  assert.equal(d[0].day, '2026-09-20');
  assert.deepEqual(d.at(-1), { day: '2026-10-03', cost: 19, total: 1400 });
  assert.equal(d.at(-2).cost, 6);
  assert.equal(sessionDays(summary, 'mm', 14, NOW).at(-1).cost, null);
});

test('sessionRows: outliers first, then cost, unpriced last; today tab drops idle sessions', () => {
  assert.deepEqual(sessionRows(summary, 'today', NOW).map((r) => r.session), ['busy', 'quiet', 'mm']);
  assert.deepEqual(sessionRows(summary, '14d', NOW).map((r) => r.session), ['busy', 'quiet', 'old', 'mm']);
  const mm = sessionRows(summary, '14d', NOW).find((r) => r.session === 'mm');
  assert.equal(mm.cost, null); assert.equal(mm.rate, null);
  assert.equal(sessionRows(summary, 'today', NOW)[0].rate, 38);
  assert.equal(sessionRows(summary, '14d', NOW)[1].rate, 5);   // 5 / 1 h
});

test('topEntries / dayBars', () => {
  const a = topEntries(summary.perAgent);
  assert.deepEqual(a.map((e) => [e.name, e.cost]), [['claude', 30], ['minimax', null]]);
  assert.equal(topEntries(summary.perProject, 1).length, 1);
  const b = dayBars(summary, 14, NOW);
  assert.equal(b.length, 14);
  assert.equal(b.at(-1).frac, 1);
  assert.equal(b.at(-2).frac, 0.5);
  assert.equal(b[0].frac, 0);
});

test('buildSummary emits today block, per-session today/days/activeHours and an outlier reason', () => {
  const mk = (trace, ts, cost, agent = 'claude') => ({ id: `x:${trace}:${ts}`, agent, trace, label: trace, project: 'p', model: 'm', ts,
    usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: cost == null ? null : { total: cost } });
  const t = NOW - 3600000;
  const s = buildSummary([mk('a', t, 1), mk('b', t, 1.2), mk('c', t, 10), mk('c', NOW - 2 * 86400000, 4), mk('mm', t, null, 'minimax'), mk('old', NOW - 5 * 86400000, 50)], NOW, 14);
  assert.equal(s.today.day, '2026-10-03');
  assert.equal(s.today.total.cost, 12.2);
  assert.equal(s.today.perAgent.minimax.unpriced, 1);
  const c = s.perSession.find((x) => x.session === 'c');
  assert.equal(c.cost, 14); assert.equal(c.today.cost, 10);
  assert.deepEqual(Object.keys(c.days), ['2026-10-01', '2026-10-03']);
  assert.equal(c.activeHours, 0.17);
  assert.equal(s.perSession.find((x) => x.session === 'old').today, null);
  assert.equal(s.perSession.find((x) => x.session === 'mm').today.rate, null);
  assert.match(s.outliers[0].reason, /8\.3x the p median/);
  // and it maps straight to the status field
  assert.equal(usageByLabel(s, NOW).get('c').outlier, s.outliers[0].reason);
});

test('createUsage: missing file -> null / null body (404-safe); present file is cached ~30 s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gu-'));
  const file = join(dir, 'usage-summary.json');
  let t = NOW;
  const u = createUsage({ file, now: () => t });
  assert.equal(await u.get(), null);
  assert.equal(await u.body(['busy']), null);
  assert.equal(u.forSession('busy'), null);
  writeFileSync(file, JSON.stringify(summary));
  t += 10_000;
  assert.equal(await u.get(), null);           // still within the 30 s cache of the miss
  t += 25_000;
  assert.equal((await u.get()).total.cost, 30);
  const b = await u.body(['busy', 'ghost']);
  assert.deepEqual(Object.keys(b.sessions), ['busy']);
  assert.equal(b.sessions.busy.days.length, 14);
  assert.deepEqual(u.forSession('busy'), { todayCost: 19, todayTokens: 1400, totalCost: 25, outlier: '9.5x the alpha median: $38/h vs $4/h' });
  assert.equal(u.forSession('ghost'), null);
  writeFileSync(file, '{ not json');
  t += 31_000;
  assert.equal(await u.get(), null);           // corrupt file: null, no throw
});
