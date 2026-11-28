import test from 'node:test';
import assert from 'node:assert/strict';
import { hourMetrics, report } from '../scripts/token-watch.js';

const row = (o) => ({ agent: 'claude', session: 's1', label: 'a', model: 'claude-opus-5-5', ts: 1000, usage: { input: 0, output: 500, cache_read: 200e3, cache_write_5m: 0, cache_write_1h: 0 }, cost: { total: 1 }, ...o });

test('hourMetrics: fable, >300k, poll-size and subagent shares over the window only', () => {
  const rows = [
    row({}),
    row({ model: 'claude-fable-5-2', cost: { total: 3 } }),
    row({ usage: { output: 50, cache_read: 400e3 }, cost: { total: 2 } }),
    row({ subagent: true, model: 'claude-sonnet-5-5', usage: { output: 900, cache_read: 200e3 }, cost: { total: 2 } }),
    row({ ts: 5000 }),                                 // outside
    row({ agent: 'manager' }),                         // the judge is not a session
    row({ agent: 'minimax', label: 'nightly', usage: { output: 20, cache_read: 220e3 }, cost: null }),
  ];
  const m = hourMetrics(rows, 0, 2000);
  assert.equal(m.claude.calls, 4);
  assert.equal(m.claude.cost, 8);
  assert.equal(m.claude.fableCalls, 1);
  assert.equal(m.claude.fableCostShare, 0.375);
  assert.equal(m.claude.over300kCalls, 1);
  assert.equal(m.claude.over300kCallCostShare, 0.25);
  assert.equal(m.claude.over300kCostShare, 0.063);
  assert.equal(m.claude.pollCalls, 1);
  assert.equal(m.claude.subagentCtxShare, 0.2);
  assert.deepEqual(m.claude.subagentModels, { 'claude-sonnet-5-5': 1 });
  assert.equal(m.minimax.calls, 1);
  assert.equal(m.minimax.pollShare, 1);
  const txt = report({ at: 2000, waste: { total: 12, counts: { 'idle-polling': 5 } }, hour: m }, { waste: { total: 18 } });
  assert.match(txt, /waste findings \(48 h window\): 12 \(last check 18, -6\), audit 18 \(better\)/);
  assert.match(txt, /Fable 1 calls, 37.5% of cost/);
});
