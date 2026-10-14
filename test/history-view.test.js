import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionHistory } from '../session-history.js';
import { createHistoryView } from '../history-view.js';

const M = 60000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-'));
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const row = (label, ts, over = {}) => ({ id: `c:${label}:${ts}`, agent: 'claude', label, cwd: `/w/${label}`, ts, model: 'claude-x', usage: { input: 10, output: 5, cache_read: 100, cache_write_5m: 1, cache_write_1h: 2 }, cost: { total: 0.5 }, ...over });
const ledger = path.join(dir, 'usage-ledger.jsonl');
fs.writeFileSync(ledger, [
  row('a', T0 + 1 * M), row('a', T0 + 3 * M), row('a', T0 + 20 * M),               // gaps 2m, 17m -> capped 5m: active 7m
  row('a', T0 + 90 * M),                                                            // after a ended: a ledger-only row (round 6b)
  row('a', T0 + 24 * 3600e3 + 130 * M),                                             // second instance of a (next day)
  row('mm', T0 + 2 * M, { agent: 'minimax', cost: null }), row('mm', T0 + 4 * M, { agent: 'minimax', cost: null }),
  row('u', T0 + 2 * M, { cost: null }),
  row('r1', T0, { cwd: '/wt/run1' }),
].map((r) => JSON.stringify(r)).join('\n') + '\n{torn');
const file = path.join(dir, 'h.jsonl');
const h = createSessionHistory({ file });
const st = (name, ts, o = {}) => h.append({ kind: 'session.started', name, provider: 'claude', model: 'haiku', cwd: `/w/${name}`, started_by: 'dashboard', prompt_ref: null, handover_ref: null, ts, ...o });
await st('a', T0); await h.append({ kind: 'session.ended', name: 'a', ts: T0 + 30 * M, reason: 'killed' });
await st('a', T0 + 24 * 3600e3 + 120 * M, { started_by: 'cbsession', prompt_ref: '/h/a.prompt.md' });
await st('mm', T0, { provider: 'minimax', model: null });
await st('u', T0);
await st('run1', T0 - M, { started_by: 'v2', provider: 'claude', cwd: '/wt/run1' });
const view = createHistoryView({ history: h, ledgerFile: ledger, now: () => T0 + 2 * 24 * 3600e3 });

test('list: newest first, one row per instance, join by label and window', async () => {
  const r = await view.list();
  assert.equal(r.total, 6);   // 5 instances + the ledger-only row of a's turn after it ended (round 6b)
  assert.equal(r.sessions[0].name, 'a'); assert.equal(r.sessions[0].started_by, 'cbsession');
  const first = r.sessions.find((s) => s.name === 'a' && s.start === T0);
  assert.equal(first.turns, 3);
  assert.deepEqual(first.tokens, { input: 30, output: 15, cache_read: 300, cache_write: 9 });
  assert.equal(first.active_ms, 7 * M);
  assert.equal(first.cost_usd, 1.5);
  assert.equal(first.elapsed_ms, 30 * M);
  assert.deepEqual(first.days, [{ day: '2026-10-10', turns: 3, tokens: 354, cost_usd: 1.5 }]);
  assert.equal(r.sessions.find((s) => s.name === 'a' && s.end == null).turns, 1);
});

test('unknown stays null; subscription providers report billing, not cost; v2 joins by cwd', async () => {
  const all = (await view.list()).sessions;
  const by = (n) => all.find((s) => s.name === n);
  assert.equal(by('mm').billing, 'subscription'); assert.equal(by('mm').cost_usd, null); assert.equal(by('mm').turns, 2);
  assert.equal(by('u').cost_usd, null); assert.equal(by('u').turns, 1);
  assert.equal(by('run1').turns, 1);
  const none = (await createHistoryView({ history: h, ledgerFile: path.join(dir, 'missing.jsonl') }).list()).sessions[0];
  assert.deepEqual([none.tokens, none.cost_usd, none.active_ms], [null, null, null]);
});

test('filters, pagination and validation', async () => {
  assert.equal((await view.list({ status: 'running' })).total, 4);
  assert.equal((await view.list({ status: 'ended' })).total, 2);
  assert.equal((await view.list({ provider: 'minimax' })).total, 1);
  assert.equal((await view.list({ started_by: 'v2' })).sessions[0].name, 'run1');
  assert.equal((await view.list({ from: new Date(T0 + 3600e3).toISOString() })).total, 2);
  const p = await view.list({ limit: '2', offset: '1' }); assert.equal(p.sessions.length, 2); assert.equal(p.limit, 2);
  assert.equal((await view.list({ limit: '9999' })).limit, 200);
  await assert.rejects(view.list({ status: 'x' }), /status/);
  await assert.rejects(view.list({ from: 'nope' }), /from/);
});

test('detail by name and start; ledger index reads only appended bytes and rereads after truncation', async () => {
  assert.equal((await view.detail('a', String(T0))).turns, 3);
  assert.equal(await view.detail('nope'), null);
  fs.appendFileSync(ledger, '\n' + JSON.stringify(row('u', T0 + 3 * M)) + '\n');
  assert.equal((await view.detail('u')).turns, 2);
  fs.writeFileSync(ledger, JSON.stringify(row('u', T0 + M)) + '\n');   // compaction: smaller file
  assert.equal((await view.detail('u')).turns, 1);
});

test('window end is exclusive: a turn at a superseded end counts for the new instance only', async () => {
  const f = path.join(dir, 'h2.jsonl'), l = path.join(dir, 'l2.jsonl');
  fs.writeFileSync(l, JSON.stringify(row('z', T0 + 5 * M)) + '\n');
  const h2 = createSessionHistory({ file: f });
  await h2.append({ kind: 'session.started', name: 'z', provider: 'claude', cwd: '/w/z', started_by: 'dashboard', prompt_ref: null, handover_ref: null, ts: T0 });
  await h2.append({ kind: 'session.started', name: 'z', provider: 'claude', cwd: '/w/z', started_by: 'cbsession', prompt_ref: null, handover_ref: null, ts: T0 + 5 * M });
  const rows = (await createHistoryView({ history: h2, ledgerFile: l }).list()).sessions;
  assert.deepEqual(rows.map((r) => r.turns).sort(), [0, 1]);
});

test('ledger index: dedupes by id (last wins), survives a transient read error, rereads after an in-place rewrite', async () => {
  const l = path.join(dir, 'l3.jsonl'), f = path.join(dir, 'h3.jsonl');
  const h3 = createSessionHistory({ file: f });
  await h3.append({ kind: 'session.started', name: 'q', provider: 'claude', cwd: '/w/q', started_by: 'dashboard', prompt_ref: null, handover_ref: null, ts: T0 });
  const small = row('q', T0 + M); const big = { ...small, usage: { ...small.usage, output: 500 } };
  fs.writeFileSync(l, JSON.stringify(small) + '\n' + JSON.stringify(row('q', T0 + 2 * M)) + '\n');
  const v3 = createHistoryView({ history: h3, ledgerFile: l });
  assert.equal((await v3.detail('q')).turns, 2);
  fs.appendFileSync(l, JSON.stringify(big) + '\n');   // same id, larger record
  const d = await v3.detail('q');
  assert.deepEqual([d.turns, d.tokens.output], [2, 505]);
  // transient error: ledger path replaced by a directory for one call, then restored
  const hold = l + '.hold'; fs.renameSync(l, hold); fs.mkdirSync(l);
  await assert.rejects(v3.detail('q'));
  fs.rmdirSync(l); fs.renameSync(hold, l);
  assert.equal((await v3.detail('q')).turns, 2, 'the chain recovered');
  // in-place rewrite (same inode, not smaller): compaction with different content
  const fd = fs.openSync(l, 'r+'); const txt = JSON.stringify(row('q', T0 + 3 * M, { id: 'other-1' })) + '\n' + JSON.stringify(row('q', T0 + 4 * M, { id: 'other-2' })) + '\n' + JSON.stringify(row('q', T0 + 5 * M, { id: 'other-3' })) + '\n';
  fs.ftruncateSync(fd, 0); fs.writeSync(fd, txt, 0); fs.closeSync(fd);
  assert.equal((await v3.detail('q')).turns, 3);
});
