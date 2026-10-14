// Round 6b (live defect 2026-10-14): after PR #4 went live, sessions that existed before the restart were first seen
// (started_by unknown) at the restart and showed 0 turns although the ledger held their whole history; sessions that
// ended before history existed did not appear at all. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionHistory } from '../session-history.js';
import { createHistoryView } from '../history-view.js';

const M = 60000, D = 24 * 3600e3;
const T0 = Date.UTC(2026, 9, 11, 9, 0, 0);
const RESTART = T0 + 3 * D;   // history begins here
const row = (label, ts, over = {}) => ({ id: `c:${label}:${ts}`, agent: 'claude', label, cwd: `/w/${label}`, ts, model: 'claude-x',
  usage: { input: 10, output: 5, cache_read: 100, cache_write_5m: 1 }, cost: { total: 0.25 }, ...over });

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv6b-'));
  const ledger = path.join(dir, 'usage-ledger.jsonl');
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => row('live', T0 + i * 2 * M)),                 // the long-running session, days before history
    row('live', T0 + D), row('live', T0 + 2 * D),
    row('gone', T0 + 5 * M), row('gone', T0 + 9 * M), row('gone', T0 + D + 1 * M),        // ended before history existed
    row('gone-mm', T0 + 3 * M, { agent: 'minimax', model: 'MiniMax-M3', cost: null }),
    row('reborn', T0 + 10 * M),                                                           // old turns, then a dashboard start
    row('worker', T0 + 50 * M, { cwd: '/wt/run9' }),                                      // a V2 run's turn: joined by cwd, never a label row
  ];
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const h = createSessionHistory({ file: path.join(dir, 'session-history.jsonl') });
  let t = RESTART + 10 * M;
  const view = createHistoryView({ history: h, ledgerFile: ledger, now: () => t });
  return { dir, ledger, h, view, add: (r) => fs.appendFileSync(ledger, JSON.stringify(r) + '\n'), tick: (ms) => { t += ms; } };
}
const start = (h, name, ts, o = {}) => h.append({ kind: 'session.started', name, provider: 'claude', model: null, cwd: `/w/${name}`, started_by: 'unknown', prompt_ref: null, handover_ref: null, ts, ...o });

test('a first-seen session starts at its earliest ledger turn and counts every turn of its label', async () => {
  const w = world();
  await start(w.h, 'live', RESTART);
  const r = await w.view.detail('live');
  assert.equal(r.start, T0, 'start from the earliest ledger turn, not the restart');
  assert.equal(r.start_source, 'ledger');
  assert.equal(r.recorded_start, RESTART);
  assert.equal(r.turns, 42);
  assert.deepEqual(r.tokens, { input: 420, output: 210, cache_read: 4200, cache_write: 42 });
  assert.equal(r.cost_usd, 10.5);
  assert.ok(r.active_ms > 0);
  assert.equal(r.end, null);
  assert.equal(r.days.length, 3);
  // the detail route also finds it by the start the client got from the list, or by the recorded one
  assert.equal((await w.view.detail('live', String(T0))).turns, 42);
  assert.equal((await w.view.detail('live', String(RESTART))).turns, 42);
});

test('new turns after the restart join the running session on the next read', async () => {
  const w = world();
  await start(w.h, 'live', RESTART);
  assert.equal((await w.view.detail('live')).turns, 42);
  w.add(row('live', RESTART + 5 * M)); w.add(row('live', RESTART + 6 * M));
  w.tick(30_000);
  const r = await w.view.detail('live');
  assert.equal(r.turns, 44);
  assert.equal(r.tokens.input, 440);
});

test('ledger-only sessions appear as ended rows; a known start keeps its history start and older turns become their own row', async () => {
  const w = world();
  await start(w.h, 'live', RESTART);
  await start(w.h, 'reborn', RESTART + M, { started_by: 'dashboard' });
  await start(w.h, 'task-x.run1', T0 + 40 * M, { started_by: 'v2', cwd: '/wt/run9' });
  await w.h.append({ kind: 'session.ended', name: 'task-x.run1', ts: T0 + 70 * M, reason: 'exited' });
  const { sessions, total } = await w.view.list({ limit: 200 });
  const by = (n) => sessions.filter((s) => s.name === n);
  // turns more than 6 h apart are separate sessions; start/end = first/last turn, last turn included
  const gone = by('gone').sort((a, b) => a.start - b.start);
  assert.deepEqual(gone.map((g) => [g.start, g.end, g.turns, g.started_by, g.source, g.provider]),
    [[T0 + 5 * M, T0 + 9 * M, 2, 'unknown', 'ledger', 'claude'], [T0 + D + M, T0 + D + M, 1, 'unknown', 'ledger', 'claude']]);
  const mm = by('gone-mm')[0];
  assert.deepEqual([mm.provider, mm.model, mm.billing, mm.cost_usd], ['minimax', 'MiniMax-M3', 'subscription', null]);
  // a dashboard start is not backfilled; its older turns are a separate ended row
  const reborn = by('reborn').sort((a, b) => a.start - b.start);
  assert.deepEqual(reborn.map((s) => [s.start, s.turns, s.source ?? 'history']), [[T0 + 10 * M, 1, 'ledger'], [RESTART + M, 0, 'history']]);
  // the V2 run's turn joins the run by cwd and is not a label row
  assert.equal(by('worker').length, 0);
  assert.equal(by('task-x.run1')[0].turns, 1);
  assert.equal(total, sessions.length);
  assert.deepEqual((await w.view.list({ status: 'ended' })).sessions.map((s) => s.name).sort(), ['gone', 'gone', 'gone-mm', 'reborn', 'task-x.run1']);
});

test('a first-seen instance after an earlier instance of the same name backfills only past that instance\'s end', async () => {
  const w = world();
  await start(w.h, 'live', T0 + 30 * M, { started_by: 'dashboard' });
  await w.h.append({ kind: 'session.ended', name: 'live', ts: T0 + 60 * M, reason: 'killed' });
  await start(w.h, 'live', RESTART);
  const rows = (await w.view.list()).sessions.filter((s) => s.name === 'live').sort((a, b) => a.start - b.start);
  // turns before the first instance: ledger row; [30m, 60m): dashboard instance; after 60m: the first-seen one
  assert.deepEqual(rows.map((s) => [s.source ?? s.start_source ?? 'history', s.turns]), [['ledger', 15], ['history', 15], ['ledger', 12]]);
  assert.equal(rows[2].start, T0 + 60 * M);
});

test('review: a reused name never backfills before its tmux session was created; older turns stay ledger rows', async () => {
  const w = world();
  await start(w.h, 'live', RESTART, { tmux_created: Math.floor((T0 + D - 30 * M) / 1000) });   // tmux session born on day 2
  const rows = (await w.view.list()).sessions.filter((s) => s.name === 'live').sort((a, b) => a.start - b.start);
  assert.deepEqual(rows.map((s) => [s.source ?? s.start_source, s.start, s.turns]), [['ledger', T0, 40], ['ledger', T0 + D, 2]]);
  assert.equal(rows[1].end, null, 'the running one');
});

test('review: a V2 run\'s turns are counted once (by cwd), never again in a label row or a backfilled instance', async () => {
  const w = world();
  w.add(row('live', T0 + 45 * M, { cwd: '/wt/run9' }));   // the worker row carries a label that matches a session
  await start(w.h, 'task-x.run1', T0 + 40 * M, { started_by: 'v2', cwd: '/wt/run9' });
  await w.h.append({ kind: 'session.ended', name: 'task-x.run1', ts: T0 + 70 * M, reason: 'exited' });
  await start(w.h, 'live', RESTART);
  const { sessions } = await w.view.list({ limit: 200 });
  assert.equal(sessions.find((s) => s.name === 'task-x.run1').turns, 2);
  assert.equal(sessions.find((s) => s.name === 'live').turns, 42, 'the worker row inside the backfilled window is not counted');
});

test('review: the joined list is cached but follows history and ledger changes', async () => {
  const w = world();
  await start(w.h, 'live', RESTART);
  const a = await w.view.list({ limit: 200 });
  assert.ok(a.sessions.some((s) => s.name === 'gone' && s.source === 'ledger'));
  await start(w.h, 'gone', RESTART + M, { started_by: 'dashboard' });   // history changes: a new instance of the name
  const b = await w.view.list({ limit: 200 });
  assert.equal(b.total, a.total + 1);
  w.add(row('brand-new', RESTART + 2 * M));                               // ledger changes: a new label
  const c = await w.view.list({ limit: 200 });
  assert.ok(c.sessions.some((s) => s.name === 'brand-new' && s.source === 'ledger'));
});
