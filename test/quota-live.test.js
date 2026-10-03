// Live quota sources (TASK-44): Codex via a fake app-server script, MiniMax via an injected fetch and token reader.
// Nothing here touches the real codex binary, the network or any auth file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createQuota, readCodex, readMinimax, parseMinimaxRemains, askCodex, POLL_MS } from '../quota.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const fakeCmd = () => ({ file: process.execPath, args: [FAKE] });
const withMode = async (mode, fn) => { const old = process.env.FAKE_MODE; process.env.FAKE_MODE = mode; try { return await fn(); } finally { if (old === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = old; } };
const NOW = 1791099000 * 1000;   // before the fake's resets

test('codex: JSON-RPC round trip yields the 5h and weekly windows', async () => {
  const c = await readCodex({ codexCmd: fakeCmd() }, NOW);
  assert.equal(c.stale, false);
  assert.equal(c.error, undefined);
  assert.equal(c.planType, 'plus');
  assert.deepEqual(c.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [['5h', 0, 1791100000], ['week', 32, 1791600000]]);
});

test('codex: a passed reset reads as 0 / expired', async () => {
  const cfg = { codexCmd: fakeCmd() };
  await readCodex(cfg, NOW);
  const later = await readCodex(cfg, 1791100500 * 1000 - 1);   // cached, 5h window passed
  assert.deepEqual(later.windows.map((w) => [w.name, w.usedPercent, !!w.expired]), [['5h', 0, true], ['week', 32, false]]);
});

test('codex: the cache holds for 5 minutes, then asks again', async () => {
  const cfg = { codexCmd: fakeCmd() };
  const a = await readCodex(cfg, NOW);
  // a broken command inside the window is never spawned
  cfg.codexCmd = { file: '/nonexistent/codex', args: [] };
  const b = await readCodex(cfg, NOW + POLL_MS - 1);
  assert.equal(b.at, a.at); assert.equal(b.stale, false);
  const c = await readCodex(cfg, NOW + POLL_MS + 1);
  assert.equal(c.stale, true);
});

test('codex: failure keeps the last good value as stale with an error', async () => {
  const cfg = { codexCmd: fakeCmd() };
  await readCodex(cfg, NOW);
  cfg.codexCmd = { file: process.execPath, args: [FAKE] };
  const bad = await withMode('error', () => readCodex(cfg, NOW + POLL_MS + 1));
  assert.equal(bad.stale, true);
  assert.match(bad.error, /not signed in/);
  assert.deepEqual(bad.windows.map((w) => [w.name, w.usedPercent]), [['5h', 0], ['week', 32]]);
  const ok = await readCodex(cfg, NOW + POLL_MS + 2);   // a failure is retried at the next poll, not cached
  assert.equal(ok.stale, false); assert.equal(ok.error, undefined);
});

test('codex: no good value yet and a failure -> empty windows, stale, error', async () => {
  for (const [mode, re] of [['die', /exited/], ['error', /not signed in/]]) {
    const r = await withMode(mode, () => readCodex({ codexCmd: fakeCmd() }, NOW));
    assert.deepEqual(r.windows, []); assert.equal(r.stale, true); assert.match(r.error, re);
  }
  const miss = await readCodex({ codexCmd: { file: '/nonexistent/codex', args: [] } }, NOW);
  assert.equal(miss.stale, true); assert.ok(miss.error);
});

test('codex: a hanging app-server is given up on at the timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(withMode('hang', () => askCodex(fakeCmd(), { timeoutMs: 300 })), /timed out/);
  assert.ok(Date.now() - t0 < 5000);
});

// ---- MiniMax ----
const MM_NOW = 1791070000 * 1000;   // inside the synthetic 5h window
const body = (over = {}) => ({ model_remains: [
  { model_name: 'general', end_time: 1791072000000, weekly_end_time: 1791158400000, current_interval_status: 1, current_interval_remaining_percent: 98, current_weekly_status: 3, current_weekly_remaining_percent: 100, ...over },
  { model_name: 'video', current_interval_status: 3 }], base_resp: { status_code: 0, status_msg: 'success' } });
const jres = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
const TOKEN = 'synthetic-token-for-tests';
// fetch stub: quota URL answers `quotaBody`; the account calls answer a synthetic workspace
function mockFetch({ quotaBody = body(), quotaStatus = 200, calls = [] } = {}) {
  const f = async (url, init) => {
    const u = String(url);
    calls.push({ url: u.split('?')[0], method: init.method, auth: init.headers.Authorization });
    if (u.includes('/coding_plan/remains')) return jres(quotaBody, quotaStatus);
    throw new Error(`unexpected ${u}`);
  };
  f.calls = calls;
  return f;
}
const mmCfg = (fetchFn, login = async () => ({ accessToken: TOKEN, expiresAtMs: MM_NOW + 3600e3 })) => ({ fetch: fetchFn, minimaxLogin: login });

test('minimax: parses 5h percent and unlimited weekly; one plain GET, nothing else', async () => {
  const f = mockFetch();
  const m = await readMinimax(mmCfg(f), MM_NOW);
  assert.equal(m.stale, false);
  assert.deepEqual(m.windows, [
    { name: '5h', usedPercent: 2, resetsAt: 1791072000 },
    { name: 'week', usedPercent: null, resetsAt: 1791158400, unlimited: true }]);
  assert.equal(f.calls.length, 1, 'only the remains call (no signed plan-info calls)');
  const q = f.calls.find((c) => c.url.endsWith('/coding_plan/remains'));
  assert.equal(q.method, 'GET');
  assert.ok(f.calls.every((c) => c.url.startsWith('https://')));
});

test('minimax: a limited weekly window becomes 100 - remaining', () => {
  const [h, w] = parseMinimaxRemains(body({ current_weekly_status: 1, current_weekly_remaining_percent: 40 }));
  assert.equal(h.usedPercent, 2); assert.equal(w.usedPercent, 60); assert.equal(w.unlimited, undefined);
  const [, w2] = parseMinimaxRemains(body({ current_weekly_status: 1, current_weekly_remaining_percent: undefined, current_weekly_total_count: 200, current_weekly_usage_count: 50 }));
  assert.equal(w2.usedPercent, 25);
  assert.throws(() => parseMinimaxRemains({ base_resp: { status_code: 1004 } }), /status 1004/);
  assert.throws(() => parseMinimaxRemains({ model_remains: [] }), /no model_remains/);
});

test('minimax: an unlimited weekly window stays unlimited after its reset time passes', async () => {
  const m = await readMinimax(mmCfg(mockFetch(), async () => ({ accessToken: TOKEN, expiresAtMs: null })), 1791200000 * 1000);
  const wk = m.windows.find((w) => w.name === 'week');
  assert.equal(wk.unlimited, true); assert.equal(wk.usedPercent, null); assert.equal(wk.expired, undefined);
});

test('minimax: an expired login is reported without any request', async () => {
  const f = mockFetch();
  const m = await readMinimax(mmCfg(f, async () => ({ accessToken: TOKEN, expiresAtMs: MM_NOW - 1 })), MM_NOW);
  assert.equal(m.stale, true); assert.equal(m.error, 'mcode login expired — open mcode once');
  assert.deepEqual(m.windows, []);
  assert.equal(f.calls.length, 0);
  const none = await readMinimax(mmCfg(f, async () => null), MM_NOW);
  assert.equal(none.error, 'mcode login expired — open mcode once');
});

test('minimax: HTTP 401 and network errors keep the last good value as stale', async () => {
  const cfg = mmCfg(mockFetch());
  await readMinimax(cfg, MM_NOW);
  cfg.fetch = mockFetch({ quotaStatus: 401 });
  const a = await readMinimax(cfg, MM_NOW + POLL_MS + 1);
  assert.equal(a.stale, true); assert.match(a.error, /mcode login expired/);
  assert.equal(a.windows[0].usedPercent, 2);
  cfg.fetch = async () => { throw new Error('ENETDOWN'); };
  const b = await readMinimax(cfg, MM_NOW + POLL_MS + 2);
  assert.equal(b.stale, true); assert.match(b.error, /ENETDOWN/);
});



test('minimax: the token never ends up in the reading', async () => {
  const m = await readMinimax(mmCfg(mockFetch()), MM_NOW);
  assert.ok(!JSON.stringify(m).includes(TOKEN));
});

test('createQuota polls all three plans; claude stays file-based', async () => {
  const cfg = { codexCmd: fakeCmd(), ...mmCfg(mockFetch()), claudeFile: '/nonexistent/claude.json', now: () => MM_NOW };
  const q = createQuota({ cfg });
  const v = await q.poll();
  assert.deepEqual(v.plans.map((p) => p.plan), ['codex', 'claude', 'minimax']);
  assert.equal(v.plans[0].windows[1].usedPercent, 32);
  assert.equal(v.plans[2].windows[1].unlimited, true);
});
