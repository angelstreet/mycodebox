import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaste, burnVsLimit, wasteLine, foldAccounts, accountAt, accountOfRow, ctxOf } from '../usage/waste.js';

const NOW = Date.parse('2026-11-28T00:00:00Z'), H = 3600000;
const row = (o) => ({ agent: 'claude', session: 's1', label: 'sess', trace: 't1', model: 'claude-sonnet-5-5', ts: NOW - H, subagent: false,
  usage: { input: 2, output: 500, cache_read: 100e3, cache_write_5m: 0, cache_write_1h: 0, ...(o.usage || {}) }, cost: { total: 0.1 }, ...o, ...(o.usage ? { usage: { input: 2, output: 500, cache_read: 100e3, cache_write_5m: 0, cache_write_1h: 0, ...o.usage } } : {}) });
const many = (n, o) => Array.from({ length: n }, (_, i) => row({ ...o, ts: NOW - H - i * 1000 }));

test('high average context, low cache hit, churn, subagent share, idle polling and expensive model all fire', () => {
  const rows = [
    ...many(40, { session: 'a', label: 'big', trace: 'ta', usage: { cache_read: 400e3 } }),
    ...many(40, { session: 'b', label: 'cold', trace: 'tb', usage: { cache_read: 50e3, cache_write_5m: 40e3 } }),
    ...many(40, { session: 'c', label: 'churn', trace: 'tc', usage: { cache_read: 100e3, cache_write_1h: 100e3 } }),
    ...many(40, { session: 'd', label: 'subs', trace: 'td', subagent: true, usage: { cache_read: 3e6 } }),
    ...many(40, { session: 'e', label: 'poll', trace: 'te', usage: { cache_read: 200e3, output: 20 } }),
    ...many(40, { session: 'f', label: 'opus-tiny', trace: 'tf', model: 'claude-opus-5-5', cost: { total: 0.5 }, usage: { output: 30 } }),
    ...many(10, { session: 'g', label: 'short', trace: 'tg', usage: { cache_read: 900e3 } }),   // under minTurns: ignored
  ];
  const w = buildWaste(rows, NOW);
  const kinds = (s) => w.findings.filter((f) => f.session === s).map((f) => f.kind);
  assert.ok(kinds('big').includes('high-avg-context'));
  assert.ok(kinds('cold').includes('low-cache-hit'));
  assert.ok(kinds('churn').includes('cache-churn'));
  assert.ok(kinds('subs').includes('subagent-heavy'));
  assert.ok(kinds('poll').includes('idle-polling'));
  assert.ok(kinds('opus-tiny').includes('expensive-model-cheap-work'));
  assert.deepEqual(kinds('short'), []);
  assert.equal(w.findings.find((f) => f.session === 'big').id, 'ta');
  assert.match(wasteLine(w), /findings/);
});

test('a healthy session raises nothing', () => {
  const w = buildWaste(many(60, { usage: { cache_read: 120e3, output: 600 } }), NOW);
  assert.deepEqual(w.findings, []);
  assert.equal(wasteLine(w), 'waste (48 h): none');
});

test('rows outside the window are ignored', () => {
  const w = buildWaste(many(60, { ts: NOW - 60 * H, usage: { cache_read: 900e3 } }).map((r, i) => ({ ...r, ts: NOW - 60 * H - i })), NOW);
  assert.deepEqual(w.findings, []);
  assert.equal(Object.keys(w.perAccount).length, 0);
});

test('account history: a swap appends, the row takes the account of its time, unknown when never seen', () => {
  let m = foldAccounts({}, { s1: 'default', s2: null }, 1000);
  m = foldAccounts(m, { s1: 'default' }, 2000);
  assert.deepEqual(m.s1, [{ account: 'default', at: 1000 }]);
  m = foldAccounts(m, { s1: 'team1' }, 3000);
  assert.equal(accountAt(m, 's1', 2500), 'default');
  assert.equal(accountAt(m, 's1', 3500), 'team1');
  assert.equal(accountAt(m, 'nope', 3500), null);
  assert.equal(accountOfRow({ agent: 'claude', session: 'nope', ts: 1 }, m), 'unknown');
  assert.equal(accountOfRow({ agent: 'minimax', session: 'x', ts: 1 }, m), 'minimax');
  const w = buildWaste(many(3, { session: 's1' }).map((r) => ({ ...r, ts: NOW - H })), NOW, {}, { s1: [{ account: 'team2', at: 0 }] });
  assert.equal(w.perAccount.team2.turns, 3);
  assert.equal(ctxOf(row({})), 100002);
});

test('burn vs limit: average pace, time to 100 %, hits before reset', () => {
  const limits = { team1: { five_hour: { used_percentage: 60, resets_at: (NOW + 2 * H) / 1000 }, seven_day: { used_percentage: 10, resets_at: (NOW + 100 * H) / 1000 } }, old: { five_hour: { used_percentage: 5, resets_at: (NOW - H) / 1000 } } };
  const hourly = [{ account: 'team1', hour: NOW - H, cost: 30 }, { account: 'team1', hour: NOW - 5 * H, cost: 99 }];
  const b = burnVsLimit(limits, hourly, NOW);
  const f = b.find((x) => x.account === 'team1' && x.window === 'five_hour');
  assert.equal(f.avgPctPerHour, 20);           // 60 % in the 3 h since the window opened
  assert.equal(f.etaHours, 2);                 // 40 % left at 20 %/h
  assert.equal(f.hitsBeforeReset, false);      // reset in exactly 2 h: not before
  assert.equal(f.recentCostPerHour, 10);
  assert.equal(b.find((x) => x.account === 'team1' && x.window === 'seven_day').hitsBeforeReset, false);
  assert.equal(b.find((x) => x.account === 'old').stale, true);
});

test('scorecard has a daily waste line from the day rows', async () => {
  const { wasteSection, buildScorecard } = await import('../scorecard.js');
  const from = NOW - 24 * H, to = NOW;
  const rows = many(40, { session: 'a', label: 'big', trace: 'ta', usage: { cache_read: 400e3 } });
  const s = wasteSection({ ledgerRows: rows, from, to });
  assert.match(s.line, /^waste \(day\): 1 finding/);
  assert.equal(s.top[0].kind, 'high-avg-context');
  assert.equal(wasteSection({ ledgerRows: [], from, to }).findings, 0);
  assert.equal(buildScorecard({ ledgerRows: rows, from, to, now: to }).waste.findings, 1);
});

test('usage page: Waste view renders accounts, burn, findings and loops; escapes names; says so without data', async () => {
  const { wasteHtml, pageHtml } = await import('../public/usage-view.js');
  assert.match(wasteHtml({}), /no waste data yet/);
  const w = buildWaste(many(40, { session: 'a', label: '<b>big</b>', trace: 'ta', usage: { cache_read: 400e3 } }), NOW, {}, { a: [{ account: 'team1', at: 0 }] });
  const u = { waste: w, perAccount: w.perAccount, wasteLine: wasteLine(w), burn: burnVsLimit({ team1: { five_hour: { used_percentage: 90, resets_at: (NOW + 4 * H) / 1000 } } }, w.hourly, NOW), loops: [{ kind: 'test-loop', count: 9, sample: 'npm test <x>', label: 'sess' }] };
  const h = wasteHtml(u);
  for (const s of ['By account', 'team1', 'Burn vs plan limit', 'hits the limit first', 'big context', 'test loop', '9× npm test &lt;x&gt;']) assert.ok(h.includes(s), s);
  assert.ok(!h.includes('<b>big</b>'));
  assert.match(pageHtml({ usage: u, tab: '14d', ui: { view: 'waste' } }), /data-view="waste"/);
});
