import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredits, createCreditAlerts, createCredits, fmtUsd } from '../credits.js';
import { creditHtml, creditChip, jevTabHtml } from '../public/jev-view.js';

const body = (balance, extra = {}) => ({ success: true, at: '2026-10-04T10:00:00Z', endpoints: [
  { endpoint: 'openrouter', has_key: true, total_credits: 210, total_usage: 210 - balance, balance,
    key: { limit: 50, limit_remaining: 12.5, usage: 40, usage_daily: 0.3, usage_monthly: 37.5, is_free_tier: false }, ...extra }] });

test('normalize: balance, key limits, errors; the headline balance is the lowest', () => {
  const c = normalizeCredits(body(-0.21));
  assert.equal(c.ok, true);
  assert.equal(c.balance, -0.21);
  assert.deepEqual(c.endpoints[0].key, { limit: 50, limit_remaining: 12.5, usage: 40, usage_daily: 0.3, usage_monthly: 37.5, is_free_tier: false });
  const two = normalizeCredits({ endpoints: [{ endpoint: 'a', balance: 5 }, { endpoint: 'b', balance: 1.5, key_error: 'key 401' }, { endpoint: 'c', balance: null }] });
  assert.equal(two.balance, 1.5);
  assert.deepEqual(two.endpoints[1].errors, ['key 401']);
  assert.equal(two.endpoints[2].balance, null);
  assert.equal(normalizeCredits({ endpoints: [] }).balance, null);
  assert.equal(fmtUsd(-0.214), '-$0.21');
});

test('alerts: seed silently, once at <= $2, again at <= $0, re-arm above $2', () => {
  const sent = [];
  const a = createCreditAlerts((k, m) => sent.push(m.title));
  a.check(50);            // seed
  a.check(30); assert.equal(sent.length, 0);
  a.check(1.9); assert.equal(sent.length, 1); assert.match(sent[0], /nearly reached/);
  a.check(1.5); assert.equal(sent.length, 1, 'no repeat while low');
  a.check(-0.21); assert.equal(sent.length, 2); assert.match(sent[1], /OpenRouter limit reached/);
  a.check(-1); assert.equal(sent.length, 2);
  a.check(10);            // topped up: re-armed
  a.check(2); assert.equal(sent.length, 3);
  a.check(null); a.check(0); assert.equal(sent.length, 4);
  const b = createCreditAlerts((k, m) => sent.push('b')); b.check(-3); b.check(-4);
  assert.equal(sent.length, 4, 'a restart while empty is not news');
});

test('poller: older server (404 / 400) is "not available"; cached 10 min; a failed refresh keeps the last good reading as stale', async () => {
  let status = 404, bal = 3, calls = 0, t = 0; const sent = [], changes = [];
  const fetchFn = async (u, o) => { calls++; assert.equal(u, 'http://h:5109/server/ai/credits'); assert.equal(o.headers['X-API-Key'], 'k');
    return status === 200 ? { ok: true, status, json: async () => body(bal) } : { ok: false, status, json: async () => ({ success: false, error: 'host_name required' }) }; };
  const c = createCredits({ jevUrl: 'http://h:5109/server/ai/decide', apiKey: 'k', fetchFn, now: () => t, alert: (k, m) => sent.push(m.title), onChange: (x) => changes.push(x.ok) });
  assert.equal((await c.get()).ok, false);
  assert.equal(c.peek().status, 404);
  await c.get(); assert.equal(calls, 1, 'cached');
  status = 400; t += 11 * 60e3; assert.equal((await c.get()).ok, false); assert.equal(calls, 2);
  status = 200; t += 11 * 60e3; assert.equal((await c.get()).balance, 3);
  bal = 1; t += 11 * 60e3; await c.get(); assert.equal(sent.length, 1);
  status = 500; t += 11 * 60e3; const s = await c.get();
  assert.equal(s.ok, true); assert.ok(s.stale); assert.equal(s.balance, 1);
  assert.deepEqual(changes, [false, false, true, true, true]);
  assert.equal((await createCredits({ jevUrl: '', apiKey: '' }).get()).ok, false);
});

test('views: red balance, key limits, not-available text, quota chip, tab shows credit first', () => {
  const c = normalizeCredits(body(-0.21));
  const h = creditHtml(c);
  assert.match(h, /jbal bad">-\$0\.21/);
  assert.match(h, /Jev will stop/);
  assert.match(h, /limit \$50\.00, \$12\.50 left/);
  assert.match(h, /today \$0\.30/); assert.match(h, /this month \$37\.50/);
  assert.doesNotMatch(creditHtml(normalizeCredits(body(40))), /used up/);
  assert.match(creditHtml({ ok: false, status: 404 }), /not available until the server is updated/);
  assert.match(creditHtml(null), /not available until the server is updated/);
  assert.equal(creditChip(c), '<span class="qi crit" title="OpenRouter credit">openrouter -$0.21</span>');
  assert.match(creditChip(normalizeCredits(body(1))), /qi warn.*openrouter \$1\.00/);
  assert.equal(creditChip({ ok: false }), '');
  const tab = jevTabHtml({ windowDays: 14, usageKey: 'text.decision', logged: true, queued: 0, credits: c,
    manager: { days: [], total: { calls: 0, failed: 0, cost: 0 }, health: { state: 'none' } }, reviewer: { days: [], total: { calls: 0, failed: 0, cost: 0 }, health: { state: 'none' } }, product: { available: false } });
  assert.ok(tab.indexOf('OpenRouter credit') < tab.indexOf('Manager Jev'));
});
