import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeExtra, createAnthropicSpend, HOUR } from '../anthropic-spend.js';
import { apiCreditChips } from '../public/anthropic-chips.js';

const usage = { extra_usage: { is_enabled: false, monthly_limit: 20000, used_credits: 2008, currency: 'EUR', decimal_places: 2, disabled_reason: 'out_of_credits' } };
const creds = () => { const d = mkdtempSync(join(tmpdir(), 'ghosty-ds-')); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', expiresAt: 9e15 } })); return { d, f }; };
const resp = (j, ok = true, status = 200) => ({ ok, status, json: async () => j });

test('extra usage: minor units become money, left = limit - used', () => {
  assert.deepEqual(normalizeExtra(usage), { limit: 200, used: 20.08, left: 179.92, currency: 'EUR', enabled: false, reason: 'out_of_credits' });
  assert.equal(normalizeExtra({}), null);
  assert.equal(normalizeExtra({ extra_usage: { monthly_limit: null, used_credits: 0 } }), null);
});
test('pulls at most once an hour: a second get inside the hour (and after a restart) does not fetch', async () => {
  const { d, f } = creds(); let t = 1e12, calls = 0;
  const mk = () => createAnthropicSpend({ stateDir: d, credentialsFile: f, now: () => t, fetchFn: async () => { calls++; return resp(usage); }, ttlMs: 60000 /* clamped to 1 h */ });
  const a = mk(); await a.get(); await a.get(); t += HOUR - 1; await a.get();
  assert.equal(calls, 1);
  await mk().get(); assert.equal(calls, 1, 'a restart reads the disk cache');
  t += 2; await a.get(); assert.equal(calls, 2);
});
test('the token goes only in the Authorization header to anthropic, and is never in the cache file', async () => {
  const { d, f } = creds(); const seen = [];
  const s = createAnthropicSpend({ stateDir: d, credentialsFile: f, fetchFn: async (u, o) => { seen.push([u, o.headers.Authorization]); return resp(usage); } });
  await s.get();
  assert.deepEqual(seen, [['https://api.anthropic.com/api/oauth/usage', 'Bearer fake-token']]);
  assert.ok(!readFileSync(join(d, 'anthropic-spend.json'), 'utf8').includes('fake-token'));
});
test('a failed pull keeps the last good figure, marked stale', async () => {
  const { d, f } = creds(); let t = 1e12, ok = true;
  const s = createAnthropicSpend({ stateDir: d, credentialsFile: f, now: () => t, fetchFn: async () => (ok ? resp(usage) : resp({}, false, 500)) });
  await s.get(); ok = false; t += HOUR;
  const r = await s.get();
  assert.equal(r.extra.left, 179.92); assert.equal(r.extra.stale, 'http 500');
});
test('an expired or missing Claude login is an error, never a fetch', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ghosty-ds-')), f = join(d, 'c.json'); writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: 1 } }));
  let calls = 0; const s = createAnthropicSpend({ stateDir: d, credentialsFile: f, fetchFn: async () => { calls++; return resp(usage); } });
  assert.equal((await s.get()).extra.error, 'Claude login expired'); assert.equal(calls, 0);
});
test('API spend groups: the owner\'s names, spent/budget for the Claude API, spent only for the team, warn at 80 %, stale marked', () => {
  assert.equal(apiCreditChips(null), '');
  const c = { ok: true, orgs: [
    { org: 'max', label: 'Virtualpytest API org', budgetUsd: 200, spentUsd: 94.27, leftUsd: 105.73, usedPercent: 47 },
    { org: 'team', label: 'AngelStreet API org', budgetUsd: 1000, spentUsd: 850.5, leftUsd: 149.5, usedPercent: 85.05, stale: true, error: 'timeout' },
    { org: 'x', label: 'No key', budgetUsd: 50, spentUsd: null, noKey: true },
  ] };
  const h = apiCreditChips(c);
  assert.match(h, /<b>Claude API<\/b><span class="qi ok">94\/200\$</);
  assert.match(h, /<b>Claude team API<\/b><span class="qi warn old">851\$</);
  assert.match(h, /\$850\.50 of the \$1000\.00 limit/, 'the title keeps the cents');
  assert.doesNotMatch(h, /No key/);
  assert.match(apiCreditChips({ ok: true, orgs: [{ org: 'max', label: 'm', budgetUsd: 200, spentUsd: null }] }), /qi na">\?\/200\$</);
  assert.match(apiCreditChips({ ok: true, orgs: [{ org: 'm', label: '<b>', spentUsd: 3.5 }] }), /<b>&lt;b&gt;<\/b><span class="qi ok">4\$</);
});
test('API spend groups with credit: spent / credit left, red at the limit or with no credit, limit and credit in the title', () => {
  const h = apiCreditChips({ ok: true, orgs: [
    { org: 'max', label: 'Virtualpytest API org', budgetUsd: 1000, spentUsd: 94.27, leftUsd: 905.73, usedPercent: 9.4, creditLeftUsd: 945.09 },
    { org: 'team', label: 'AngelStreet API org', budgetUsd: 200, spentUsd: 200.2, leftUsd: -0.2, usedPercent: 100.1, creditLeftUsd: 10.85 },
    { org: 'dry', label: 'Dry org', budgetUsd: 1000, spentUsd: 10, usedPercent: 1, creditLeftUsd: -2.4 },
  ] });
  assert.match(h, /<b>Claude API<\/b><span class="qi ok">94\/945\$</);
  assert.match(h, /title="AngelStreet API org: API spend this month \$200\.20 of the \$200\.00 limit \(100%, API calls stopped until the 1st\), credit left about \$10\.85"><b>Claude team API<\/b><span class="qi crit">200\/11\$</);
  assert.match(h, /<b>Dry org<\/b><span class="qi crit">10\/-2\$</);
});
test('static: wired in server.js and the app, precached', () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(rd('../server.js'), /anthropicSpend\.start\(\)/); assert.match(rd('../server.js'), /\/api\/anthropic-spend/);
  assert.match(rd('../public/app.js'), /apiCreditChips\(state\.apiCredit\)/); assert.match(rd('../public/sw.js'), /'\/anthropic-chips\.js'/);
});
