import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeExtra, createAnthropicSpend, HOUR } from '../anthropic-spend.js';
import { anthropicChips, apiCreditChips } from '../public/anthropic-chips.js';

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
test('chips: extra left in its currency, warn at 80 % used, nothing without a reading', () => {
  assert.equal(anthropicChips(null), '');
  assert.match(anthropicChips({ ok: true, extra: { limit: 200, used: 20.08, left: 179.92, currency: 'EUR' } }), /qi ok[^>]*>extra €180 left/);
  assert.match(anthropicChips({ ok: true, extra: { limit: 200, used: 170, left: 30, currency: 'EUR' } }), /qi warn[^>]*>extra €30 left/);
  assert.equal(anthropicChips({ ok: true, extra: { error: 'x' } }), '');
});
test('API credit chips: one per org with a reading, short name, spent (budget in the title), warn at 80 %, stale marked', () => {
  assert.equal(apiCreditChips(null), '');
  const c = { ok: true, orgs: [
    { org: 'max', label: 'Virtualpytest API org', budgetUsd: 200, spentUsd: 0, leftUsd: 200, usedPercent: 0 },
    { org: 'team', label: 'AngelStreet API org', budgetUsd: 1000, spentUsd: 850.5, leftUsd: 149.5, usedPercent: 85.05, stale: true, error: 'timeout' },
    { org: 'x', label: 'No key', budgetUsd: 50, spentUsd: null, noKey: true },
  ] };
  const h = apiCreditChips(c);
  assert.match(h, /class="qi ok"[^>]*>Virtualpytest \$0</);
  assert.match(h, /class="qi warn old"[^>]*>AngelStreet \$851</);
  assert.doesNotMatch(h, /No key/);
  assert.match(apiCreditChips({ ok: true, orgs: [{ org: 'm', label: '<b>', spentUsd: 3.5 }] }), />&lt;b&gt; \$3\.50</);
});
test('static: wired in server.js and the app, precached', () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(rd('../server.js'), /anthropicSpend\.start\(\)/); assert.match(rd('../server.js'), /\/api\/anthropic-spend/);
  assert.match(rd('../public/app.js'), /anthropicChips\(state\.anthropic\)/); assert.match(rd('../public/app.js'), /apiCreditChips\(state\.apiCredit\)/); assert.match(rd('../public/sw.js'), /'\/anthropic-chips\.js'/);
});
