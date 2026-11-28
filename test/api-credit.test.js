import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCostReport, normalizeBudgets, createApiCredit, monthStart, keyHint, POLL_MS, FORCE_MIN_MS } from '../api-credit.js';

const fx = (n) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8'));
const NOW = Date.UTC(2026, 10, 28, 10, 0);
const resp = (j, ok = true, status = 200) => ({ ok, status, json: async () => j });
const made = [];
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const dirs = (keys = {}) => {
  const state = mkdtempSync(join(tmpdir(), 'ghosty-ac-')), keyDir = join(state, 'keys');
  made.push(state);
  mkdirSync(keyDir);
  for (const [org, k] of Object.entries(keys)) writeFileSync(join(keyDir, `${org}.admin.key`), `${k}\n`);
  return { state, keyDir };
};

test('parseCostReport: analytics rows and legacy bucket results, cents strings summed', () => {
  assert.deepEqual(parseCostReport(fx('anthropic-cost-analytics.json')), { cents: 16745.67, rows: 2, hasMore: false, nextPage: null, refreshedAt: '2026-11-28T06:00:00Z' });
  assert.deepEqual(parseCostReport(fx('anthropic-cost-report-legacy.json')), { cents: 300, rows: 2, hasMore: true, nextPage: 'page_2', refreshedAt: null });
  // the shape the live API answers (2026-11-28): the amount sits under cost; reading only a top-level amount showed $0
  assert.deepEqual(parseCostReport(fx('anthropic-cost-analytics-live.json')), { cents: 20020.323341, rows: 1, hasMore: false, nextPage: null, refreshedAt: '2026-11-28T15:28:07Z' });
  assert.deepEqual(parseCostReport({ data: [], data_refreshed_at: null }), { cents: 0, rows: 0, hasMore: false, nextPage: null, refreshedAt: null });
  assert.throws(() => parseCostReport({ error: { type: 'x' } }));
});

test('budgets: defaults are Max 200 and Team 1000 a month; the state file overrides; bad org names dropped', () => {
  assert.deepEqual(normalizeBudgets(null).map((b) => [b.org, b.budgetUsd]), [['max', 200], ['team', 1000]]);
  assert.deepEqual(normalizeBudgets({ team: { label: 'Team', budgetUsd: 1500 }, '../x': { budgetUsd: 1 } }), [{ org: 'team', label: 'Team', budgetUsd: 1500, period: 'month' }]);
  assert.equal(monthStart(NOW), '2026-11-01T00:00:00Z');
});

test('no key: a plain row, no request made', async () => {
  const { state, keyDir } = dirs(); let calls = 0;
  const c = createApiCredit({ stateDir: state, keyDir, now: () => NOW, fetchFn: async () => { calls++; return resp({}); } });
  const r = await c.get();
  assert.equal(calls, 0);
  assert.deepEqual(r.orgs.map((o) => [o.org, o.spentUsd, o.error]), [['max', null, keyHint('max')], ['team', null, keyHint('team')]]);
  assert.equal(keyHint('team'), 'no admin key: add ~/.config/anthropic/team.admin.key');
});

test('spent / budget / left this month; the key goes only to api.anthropic.com in x-api-key and never into the cache', async () => {
  const { state, keyDir } = dirs({ team: 'sk-ant-admin01-fake' }); const seen = [];
  const c = createApiCredit({ stateDir: state, keyDir, now: () => NOW, fetchFn: async (u, o) => { seen.push([u, o.headers['x-api-key'], o.headers['anthropic-beta']]); return resp(fx('anthropic-cost-analytics.json')); } });
  const r = await c.get();
  const team = r.orgs.find((o) => o.org === 'team');
  assert.deepEqual([team.spentUsd, team.budgetUsd, team.leftUsd, team.usedPercent], [167.46, 1000, 832.54, 16.7]);
  assert.equal(seen.length, 1);
  assert.match(seen[0][0], /^https:\/\/api\.anthropic\.com\/v1\/organizations\/analytics\/cost\?starting_at=2026-11-01T00%3A00%3A00Z$/);
  assert.equal(seen[0][1], 'sk-ant-admin01-fake');
  assert.equal(seen[0][2], 'analytics-usage-cost-2026-08-24');
  assert.ok(!readFileSync(join(state, 'api-credit.json'), 'utf8').includes('sk-ant'));
});

test('analytics not open (404): legacy cost report, every page followed', async () => {
  const { state, keyDir } = dirs({ max: 'k' }); const urls = [];
  const c = createApiCredit({ stateDir: state, keyDir, now: () => NOW, fetchFn: async (u) => {
    urls.push(u);
    if (u.includes('/analytics/')) return resp({}, false, 404);
    return resp(u.includes('page=page_2') ? { data: [{ results: [{ amount: '700' }] }], has_more: false } : fx('anthropic-cost-report-legacy.json'));
  } });
  const max = (await c.get()).orgs.find((o) => o.org === 'max');
  assert.equal(max.spentUsd, 10);
  assert.match(max.source, /cost report/);
  assert.equal(urls.length, 3);
});

test('at most every 15 min (also across a restart); a failure keeps the last figure marked stale', async () => {
  const { state, keyDir } = dirs({ team: 'k' }); let t = NOW, calls = 0, fail = false;
  const mk = () => createApiCredit({ stateDir: state, keyDir, now: () => t, ttlMs: 1000, fetchFn: async () => { calls++; return fail ? resp({}, false, 500) : resp(fx('anthropic-cost-analytics.json')); } });
  const a = mk(); await a.get(); t += POLL_MS - 1; await a.get();
  assert.equal(calls, 1);
  await mk().get(); assert.equal(calls, 1, 'restart reads the disk cache');
  t += 2; fail = true;
  const team = (await a.get()).orgs.find((o) => o.org === 'team');
  assert.equal(calls, 2);
  assert.deepEqual([team.spentUsd, team.stale, team.error], [167.46, true, 'http 500']);
});

test('a refused key: the row carries the API\'s own 401 reason', async () => {
  const { state, keyDir } = dirs({ team: 'sk-ant-api03-notadmin' });
  const msg = 'The Admin API requires an Admin API key or an organization-scoped API key';
  const c = createApiCredit({ stateDir: state, keyDir, now: () => NOW, fetchFn: async () => resp({ type: 'error', error: { type: 'authentication_error', message: msg } }, false, 401) });
  const team = (await c.get()).orgs.find((o) => o.org === 'team');
  assert.equal(team.spentUsd, null);
  assert.ok(team.error.startsWith(`key refused (http 401): ${msg}`), team.error);
  assert.ok(!team.error.includes('notadmin'));
});

test('force (the popup refresh button): a new key shows at once, but at most one forced pull a minute', async () => {
  const { state, keyDir } = dirs();
  let t = NOW, calls = 0;
  const c = createApiCredit({ stateDir: state, keyDir, now: () => t, fetchFn: async () => { calls++; return resp(fx('anthropic-cost-analytics.json')); } });
  assert.equal((await c.get()).orgs[0].noKey, true);
  writeFileSync(join(keyDir, 'max.admin.key'), 'sk-ant-admin01-fake\n');
  t += 30e3;
  assert.equal((await c.get({ force: true })).orgs[0].noKey, true, 'under a minute: cached, no pull');
  assert.equal((await c.get()).orgs[0].noKey, true, 'plain get keeps the 15 min cache');
  assert.equal(calls, 0);
  t = NOW + FORCE_MIN_MS;
  const r = await c.get({ force: true });
  assert.equal(r.orgs[0].spentUsd, 167.46);
  assert.equal(calls, 1);
  assert.ok(FORCE_MIN_MS < POLL_MS);
});
