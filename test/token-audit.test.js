import test from 'node:test';
import assert from 'node:assert/strict';
import { windowRows, metrics, report, parseWindow } from '../scripts/token-audit.js';

const row = (id, ts, extra = {}) => ({ id, ts, agent: 'claude', model: 'claude-opus-x', session: 's1', label: 'zz-demo',
  usage: { input: 10_000, cache_read: 90_000, output: 100 }, cost: { total: 1 }, ...extra });

test('the token audit counts one row per id, inside the window, without errors or manager rows', () => {
  const rows = [row('a', 1000), row('a', 1000), row('b', 2000, { subagent: true, usage: { cache_read: 400_000, output: 900 } }),
    row('c', 1500, { error: 'x' }), row('d', 1500, { agent: 'manager' }), row('e', 3_600_000)];
  const kept = windowRows(rows, 0, 3_600_000);
  assert.deepEqual(kept.map((r) => r.id), ['a', 'b']);
  const m = metrics(kept, 0, 3_600_000);
  assert.equal(m['Claude calls per hour'], '2');
  assert.equal(m['Avg context per call'], '250k');
  assert.equal(m['Calls above 300k'], '50.0%');
  assert.equal(m['Cache hit'], '98.0%');
  assert.equal(m['Subagent share of context'], '80.0%');
  assert.equal(m['Tiny turns (<150 out) of Opus/Fable calls'], '50.0%');
  assert.match(report(rows, [[0, 3_600_000]]), /zz-demo/);
});

test('the token audit reads windows as UTC and refuses a reversed one', () => {
  assert.deepEqual(parseWindow('2026-01-01T00:00,2026-01-01T01:00'), [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1, 1)]);
  assert.throws(() => parseWindow('2026-01-02,2026-01-01'), /bad --window/);
});
