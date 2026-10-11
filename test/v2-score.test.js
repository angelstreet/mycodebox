// scripts/v2-score.js: read-only scoring over a synthetic store (OWNER_DECISIONS §8). Unknown stays unknown (T22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { scoreStore, renderTable, creditOf, foldTask } from '../scripts/v2-score.js';
import { loadRegistry } from '../orchestration/model-registry.js';
import { route } from '../orchestration/router.js';
import { spec, SHA_A, SHA_B } from './fixtures/v2-task.js';

const SCRIPT = new URL('../scripts/v2-score.js', import.meta.url).pathname;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const storeIn = (dir, tick = 1000) => { let t = T0; let n = 0; return createTaskStore({ dir, now: () => (t += tick), randomId: () => `r${++n}` }); };

async function accepted(s, id, who, { usd = [0.1], rework = 0, tick } = {}) {
  await s.createTask(spec({ task_id: id }));
  for (const st of ['clarified', 'planned', 'ready', 'executing']) await s.transition(id, st);
  for (let i = 0; i < rework; i++) { await s.transition(id, 'repair'); await s.transition(id, 'executing'); }
  await s.transition(id, 'evaluating');
  await s.setHead(id, SHA_A, { actor: { role: 'developer', id: who } });
  const [runtime, model] = who.split(':');
  for (const [i, u] of usd.entries()) await s.recordUsage(id, { runtime, model, usd: u, input_tokens: 10, output_tokens: 5, run_id: `${id}-${i}` });
  await s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: 'rev' }, verdict: 'approve', findings: [] });
  await s.transition(id, 'accepted');
}
async function failed(s, id, who) {
  await s.createTask(spec({ task_id: id }));
  await s.transition(id, 'waiting');
  await s.setHead(id, SHA_B, { actor: { role: 'developer', id: who } });
  await s.recordUsage(id, { runtime: who.split(':')[0], model: who.split(':')[1], usd: 0.05, input_tokens: 1, output_tokens: 1, run_id: `${id}-u` });
  await s.transition(id, 'failed_unrecoverable');
}

async function build() {
  const dir = mkdtempSync(join(tmpdir(), 'v2-score-'));
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:m1', { usd: [0.1, 0.05], rework: 1 });
  await accepted(s, 'a2', 'claude:m1', { usd: [0.25] });
  await failed(s, 'f1', 'claude:m1');
  await accepted(s, 'a3', 'codex:m2', { usd: [0.2] });
  await failed(s, 'f2', 'codex:m2');
  await s.createTask(spec({ task_id: 'open1' }));
  await s.createTask(spec({ task_id: 'can1' })); await s.transition('can1', 'cancelled');
  await s.createTask(spec({ task_id: 'info1', review_policy: { mode: 'informational', goal_loop: false } }));
  return dir;
}

test('per-model and per-runtime: rate, cost per verified completion, latency, rework', async () => {
  const r = scoreStore(await build());
  assert.deepEqual([r.tasks.accepted, r.tasks.failed, r.tasks.cancelled, r.tasks.open, r.tasks.informational], [3, 2, 1, 1, 1]);
  const m1 = r.by_model.find((g) => g.key === 'claude:m1');
  assert.deepEqual([m1.settled, m1.verified, m1.failed], [3, 2, 1]);
  assert.ok(Math.abs(m1.verified_rate - 2 / 3) < 1e-9);
  assert.equal(m1.rework.transitions, 1);
  assert.ok(m1.median_latency_ms > 0);
  const m2 = r.by_model.find((g) => g.key === 'codex:m2');
  assert.deepEqual([m2.settled, m2.verified], [2, 1]);
  assert.ok(Math.abs(m2.cost.per_verified_completion_usd - 0.25) < 1e-9, 'all spend (0.20 accepted + 0.05 failed) over 1 verified');
  assert.ok(Math.abs(m2.cost.spend_on_accepted - 0.2) < 1e-9);
  assert.deepEqual(r.by_runtime.map((g) => g.key).sort(), ['claude', 'codex']);
  assert.equal(r.by_runtime.find((g) => g.key === 'claude').verified, 2);
});

test('unknown cost stays unknown: one unpriced completion makes the figure null, not a partial mean or $0', async () => {
  const dir = await build();
  const s = storeIn(dir);
  await accepted(s, 'a-unpriced', 'claude:m1', { usd: [null] });   // an unpriced model: usd is null
  const m1 = scoreStore(dir).by_model.find((g) => g.key === 'claude:m1');
  assert.equal(m1.cost.per_verified_completion_usd, null);
  assert.equal(m1.cost.unknown_completions, 1);
  assert.ok(m1.cost.known_completions >= 2);
  assert.ok(m1.cost.usd_known_total > 0, 'the known part is still reported, labelled as such');
  assert.match(renderTable(scoreStore(dir)), /unknown/);
  assert.ok(scoreStore(dir).caveats.some((c) => /unknown cost/.test(c)));
});

test('read-only: the store is byte-identical after scoring; torn tail tolerated; corrupt log excluded and listed', async () => {
  const dir = await build();
  const snap = () => Object.fromEntries(readdirSync(join(dir, 'tasks')).map((id) => [id, [readFileSync(join(dir, 'tasks', id, 'events.jsonl'), 'utf8'), statSync(join(dir, 'tasks', id, 'events.jsonl')).mtimeMs]]));
  appendFileSync(join(dir, 'tasks', 'a1', 'events.jsonl'), '{"torn":');   // a crash mid-write
  const before = snap();
  const r = scoreStore(dir);
  assert.deepEqual(snap(), before, 'no write, no truncation');
  assert.equal(r.tasks.unreadable.length, 0);
  assert.equal(r.by_model.find((g) => g.key === 'claude:m1').verified, 2, 'the acknowledged part of a1 still counts');
  const log = join(dir, 'tasks', 'a3', 'events.jsonl');
  const lines = readFileSync(log, 'utf8').split('\n');
  lines[2] = 'garbage';
  writeFileSync(log, lines.join('\n'));
  const r2 = scoreStore(dir);
  assert.deepEqual(r2.tasks.unreadable.map((u) => u.task_id), ['a3']);
  assert.equal(r2.by_model.find((g) => g.key === 'codex:m2').verified, 0, 'unreadable is not success');
  assert.ok(r2.caveats.some((c) => /could not be replayed/.test(c)));
});

test('credit goes to the developer of the accepted head; no developer falls back to the last usage, then unknown', () => {
  const ev = (kind, payload, seq, task_id = 't') => ({ event_id: `e${seq}`, task_id, seq, kind, timestamp: new Date(T0 + seq * 1000).toISOString(), payload });
  const base = { task_id: 't', status: 'created', review_policy: undefined };
  const f = foldTask([ev('task.created', { task: base }, 1), ev('task.head_changed', { sha: SHA_A, actor: { id: 'codex:old' } }, 2), ev('task.head_changed', { sha: SHA_B, actor: { id: 'claude:new' } }, 3),
    ev('task.transitioned', { to: 'accepted' }, 4)]);
  assert.deepEqual(creditOf(f), { runtime: 'claude', model: 'new', basis: 'developer' });
  const g = foldTask([ev('task.created', { task: base }, 1), ev('usage.recorded', { runtime: 'minimax', model: 'm', usd: null }, 2)]);
  assert.deepEqual(creditOf(g), { runtime: 'minimax', model: 'm', basis: 'last_usage' });
  assert.deepEqual(creditOf(foldTask([ev('task.created', { task: base }, 1)])), { runtime: 'unknown', model: 'unknown', basis: 'none' });
});

test('router_history is valid router input and omits unknown figures instead of zero-filling', async () => {
  const dir = await build();
  const s = storeIn(dir);
  await accepted(s, 'a-unpriced', 'codex:m2', { usd: [null] });
  const { router_history: h } = scoreStore(dir);
  assert.ok(h['claude:m1'].total_usd > 0 && h['claude:m1'].latency_ms > 0);
  assert.equal('total_usd' in h['codex:m2'], false, 'unknown cost is omitted');
  for (const v of Object.values(h)) assert.ok(Number.isInteger(v.attempts) && v.verified <= v.attempts && v.errors <= v.attempts);
  // The router accepts it unchanged (shadow mode; unknown entries are simply not in the registry).
  const reg = loadRegistry({ now: () => Date.parse('2026-10-11T00:00:00Z') });
  const id = reg.entries()[0].id;
  const out = route({ task_id: 't', goal: 'add a helper', risk_class: 'low', scope: ['a.js'] }, { registry: reg, history: { [id]: { attempts: 20, verified: 18, errors: 1, total_usd: 3.6, latency_ms: 4000 } }, now: () => Date.parse('2026-10-11T00:00:00Z') });
  assert.ok(out.candidates.length > 0);
});

test('--since filters by creation time; missing store reports it; CLI prints table and JSON, bad args exit 2', async () => {
  const dir = await build();
  assert.equal(scoreStore(dir, { since: '2999-01-01T00:00:00Z' }).tasks.total, 0);
  assert.ok(scoreStore(join(dir, 'nope')).caveats[0].includes('no task store'));
  assert.throws(() => scoreStore(dir, { since: 'yesterday-ish' }), /ISO/);
  const env = { PATH: process.env.PATH };
  const table = execFileSync(process.execPath, [SCRIPT, '--store', dir], { env, encoding: 'utf8' });
  assert.match(table, /model \(runtime:model\)/);
  assert.match(table, /claude:m1/);
  const j = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--store', dir, '--json'], { env, encoding: 'utf8' }));
  assert.equal(j.tasks.accepted, 3);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--bogus'], { env, stdio: 'pipe' }), (e) => e.status === 2);
});

test('a failed task with no usage record makes the group cost unknown (spend on it cannot be known)', async () => {
  const dir = await build();
  const s = storeIn(dir);
  await s.createTask(spec({ task_id: 'f-nousage' })); await s.transition('f-nousage', 'waiting');
  await s.setHead('f-nousage', SHA_B, { actor: { role: 'developer', id: 'codex:m2' } });
  await s.transition('f-nousage', 'failed_unrecoverable');
  const m2 = scoreStore(dir).by_model.find((g) => g.key === 'codex:m2');
  assert.equal(m2.cost.per_verified_completion_usd, null);
  assert.ok(m2.cost.spend_on_accepted > 0, 'accepted-only spend is still reported separately');
});
