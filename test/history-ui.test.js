// History view helpers (public/history-view.js): durations, tokens, cost honesty, query mapping, escaping, static rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmtDuration, fmtTokens, fmtCost, fmtWhen, fmtModel, buildQuery, rowHtml, listHtml, detailHtml, filtersHtml } from '../public/history-view.js';

const row = (o = {}) => ({ name: 'demo', provider: 'claude', model: 'm1', started_by: 'dashboard', cwd: '/x', prompt_ref: '/p/h.md', handover_ref: null, start: 1e12, end: 1e12 + 60000,
  elapsed_ms: 60000, active_ms: 30000, turns: 2, tokens: { input: 1500, output: 300, cache_read: 4000, cache_write: 1000 }, billing: 'metered', cost_usd: 1.234, days: [], ...o });

test('durations', () => {
  assert.equal(fmtDuration(null), '—'); assert.equal(fmtDuration(-1), '—'); assert.equal(fmtDuration(4000), '4s');
  assert.equal(fmtDuration(125000), '2m 5s'); assert.equal(fmtDuration(3725000), '1h 2m'); assert.equal(fmtDuration(90061000), '1d 1h'); assert.equal(fmtDuration(0), '0s');
});
test('tokens: unknown is a dash, cache folds read+write', () => {
  assert.equal(fmtTokens(null), '—');
  assert.equal(fmtTokens(row().tokens), 'in 2k · out 300 · cache 5k');
});
test('cost: subscription, unknown and real values; unknown is never $0', () => {
  assert.equal(fmtCost(row({ billing: 'subscription', cost_usd: null })).text, 'subscription');
  assert.equal(fmtCost(row({ cost_usd: null })).text, 'unknown');
  assert.equal(fmtCost(row({ cost_usd: undefined })).text, 'unknown');
  assert.equal(fmtCost(row({ cost_usd: 1.234 })).text, '$1.23');
  assert.equal(fmtCost(row({ cost_usd: 0 })).text, '$0.00');   // a priced zero is real; only null is unknown
  assert.doesNotMatch(rowHtml(row({ cost_usd: null }), 0), /\$0/);
});
test('when and model labels', () => {
  assert.equal(fmtWhen(null), '—'); assert.match(fmtWhen(1e12), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(fmtModel(row()), 'claude / m1'); assert.equal(fmtModel(row({ model: null })), 'claude'); assert.equal(fmtModel({}), 'unknown');
});
test('filters map to the API query', () => {
  const q = new URLSearchParams(buildQuery({ provider: 'claude', model: '', started_by: 'v2', status: 'running', from: '2026-10-01', to: '2026-10-02' }, 50, 50));
  assert.equal(q.get('provider'), 'claude'); assert.equal(q.get('started_by'), 'v2'); assert.equal(q.get('status'), 'running'); assert.equal(q.has('model'), false);
  assert.equal(q.get('offset'), '50'); assert.equal(q.get('limit'), '50');
  assert.ok(Number(q.get('to')) - Number(q.get('from')) >= 86400000 && Number(q.get('to')) - Number(q.get('from')) < 2 * 86400000);
  assert.equal(new URLSearchParams(buildQuery({})).has('from'), false);
});
test('rows: running vs ended, escaping, refs are not links', () => {
  const run = rowHtml(row({ end: null, name: '<b>x</b>', prompt_ref: 'say "hi" <i>' }), 3);
  assert.match(run, /running/); assert.match(run, /data-hs-i="3"/); assert.doesNotMatch(run, /<b>x<\/b>/); assert.doesNotMatch(run, /<i>/); assert.doesNotMatch(run, /<a /);
  assert.match(rowHtml(row(), 0), /ended/);
});
test('list: empty state and load more only when more remain', () => {
  assert.match(listHtml([], 0), /No sessions match/);
  assert.match(listHtml([row()], 5), /data-hs-more/); assert.doesNotMatch(listHtml([row()], 1), /data-hs-more/);
});
test('detail shows per-day usage; filters keep the selection', () => {
  const d = detailHtml(row({ days: [{ day: '2026-10-01', turns: 2, tokens: 5000, cost_usd: null }] }));
  assert.match(d, /2026-10-01/); assert.match(d, /5k/); assert.match(d, /unknown/);
  assert.match(filtersHtml({ provider: 'codex' }), /<option value="codex" selected>/);
});
test('static: wired in the More menu, precached, icon from icons.js, no emoji', () => {
  assert.match(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /id="historyBtn"/);
  assert.match(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), /'\/history-view\.js'/);
  assert.match(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), /historyBtn'\)\.onclick = openSessionHistory/);
  assert.doesNotMatch(readFileSync(new URL('../public/history-view.js', import.meta.url), 'utf8'), /\p{Extended_Pictographic}/u);
});
