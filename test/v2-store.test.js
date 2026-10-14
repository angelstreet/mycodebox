import test from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'v2-store-'));
const open = (dir, fs) => createTaskStore({ dir, fs, ...clock() });
const logOf = (dir, id) => readFileSync(join(dir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const PATH = ['clarified', 'planned', 'ready', 'executing', 'evaluating'];
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-agent-2' };

async function toState(store, id, last = 'evaluating') {
  for (const s of PATH.slice(0, PATH.indexOf(last) + 1)) await store.transition(id, s, { actor: 'controller' });
}
const pass = (store, id, sha = SHA_A, check_id = 'unit', exit = 0) =>
  store.recordEvidence(id, { check_id, sha, command: ['npm', 'test'], exit, duration_ms: 1200, artifact: 'artifacts/unit.txt', actor: 'runner' });

// fs whose writes to the matching file write half the bytes, then throw: a crash mid-write.
function crashingFs(match, { after = 0 } = {}) {
  const paths = new Map();
  let n = 0;
  return {
    ...realFs,
    openSync(p, ...rest) { const fd = realFs.openSync(p, ...rest); paths.set(fd, String(p)); return fd; },
    writeSync(fd, data, ...rest) {
      if (match.test(paths.get(fd) || '') && n++ >= after) {
        const buf = Buffer.from(data);
        realFs.writeSync(fd, buf.subarray(0, Math.floor(buf.length / 2)));
        throw Object.assign(new Error('simulated crash mid-write'), { code: 'EIO' });
      }
      return realFs.writeSync(fd, data, ...rest);
    },
  };
}

test('createTask persists log, snapshot and index under the given dir only', async () => {
  const dir = tmp();
  const s = open(dir);
  const t = await s.createTask(spec());
  assert.equal(t.status, 'created');
  assert.equal(t.outcome, 'not_yet_done');
  assert.equal(t.head_sha, null);
  assert.ok(existsSync(join(dir, 'tasks', t.task_id, 'events.jsonl')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'tasks', t.task_id, 'snapshot.json'), 'utf8')).task_id, t.task_id);
  assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).tasks[t.task_id].status, 'created');
  await assert.rejects(s.createTask(spec({ goal: '' })), { code: 'E_INVALID_TASK' });
  await assert.rejects(s.createTask(spec({ task_id: '../escape' })), { code: 'E_INVALID_TASK' });
  await assert.rejects(s.createTask(spec({ status: 'accepted' })), { code: 'E_INVALID_TASK' });
});

test('T06: same createTask key -> one task, also concurrently and after restart', async () => {
  const dir = tmp();
  const s = open(dir);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => s.createTask(spec(), { idempotencyKey: 'ui-submit-1' })));
  assert.equal(a.task_id, b.task_id);
  assert.equal(a.task_id, c.task_id);
  assert.equal((await s.list()).length, 1);
  assert.equal(logOf(dir, a.task_id).length, 1);
  const s2 = open(dir);
  assert.equal((await s2.createTask(spec(), { idempotencyKey: 'ui-submit-1' })).task_id, a.task_id);
  assert.equal((await s2.list()).length, 1);
  assert.notEqual((await s2.createTask(spec(), { idempotencyKey: 'ui-submit-2' })).task_id, a.task_id);
});

test('T06: the same event twice has exactly one effect; seq is strictly increasing', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  const ev = { event_id: 'cb-42', kind: 'task.started', payload: { note: 'callback' } };
  assert.equal((await s.append(id, ev)).applied, true);
  assert.equal((await s.append(id, ev)).applied, false);
  assert.equal((await s.transition(id, 'clarified', { event_id: 'tr-1' })).applied, true);
  assert.equal((await s.transition(id, 'clarified', { event_id: 'tr-1' })).applied, false);   // redelivered, not re-applied
  assert.equal((await s.get(id)).status, 'clarified');
  assert.equal(logOf(dir, id).filter((e) => e.event_id === 'cb-42' || e.event_id === 'tr-1').length, 2);
  await assert.rejects(s.append(id, { event_id: 'old', kind: 'task.started', seq: 2 }), { code: 'E_SEQ' });
  await assert.rejects(s.append(id, { kind: 'task.started' }), { code: 'E_INVALID_EVENT' });
  await assert.rejects(s.append(id, { event_id: 'x', kind: 'task.nope' }), { code: 'E_INVALID_EVENT' });
  await assert.rejects(s.append('missing', { event_id: 'y', kind: 'task.started' }), { code: 'E_NOT_FOUND' });
  // Duplicate after restart is still a no-op.
  const s2 = open(dir);
  assert.equal((await s2.append(id, ev)).applied, false);
});

test('concurrent appends to one task never interleave', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => s.append(id, { event_id: `e${i}`, kind: 'task.started', payload: { i } })));
  assert.ok(results.every((r) => r.applied));
  const log = logOf(dir, id);
  assert.deepEqual(log.map((e) => e.seq), Array.from({ length: 61 }, (_, i) => i + 1));
  assert.equal(new Set(log.map((e) => e.event_id)).size, 61);
});

test('illegal transitions throw and leave state and log untouched', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await assert.rejects(s.transition(id, 'executing'), { code: 'E_ILLEGAL_TRANSITION' });
  await assert.rejects(s.transition(id, 'accepted'), { code: 'E_ILLEGAL_TRANSITION' });
  await assert.rejects(s.append(id, { event_id: 'sneak', kind: 'task.transitioned', payload: { to: 'evaluating' } }), { code: 'E_ILLEGAL_TRANSITION' });
  assert.equal((await s.get(id)).status, 'created');
  assert.equal(logOf(dir, id).length, 1);
});

test('acceptance: passing evidence on head plus an independent approve -> accepted (GL02 unit level)', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await s.transition(id, 'accepted', { actor: 'controller' });
  const t = await s.get(id);
  assert.equal(t.status, 'accepted');
  assert.equal(t.outcome, 'done');
  await assert.rejects(s.transition(id, 'repair'), { code: 'E_TERMINAL' });
  await assert.rejects(s.recordUsage(id, { runtime: 'fake', input_tokens: 1 }), { code: 'E_TERMINAL' });
});

test('acceptance guard rejects missing evidence, unknown or failing exit, and missing verdict (GL04)', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await assert.rejects(s.transition(id, 'accepted'), (e) => e.code === 'E_ACCEPTANCE_UNMET' && /head SHA unknown/.test(e.message));
  await s.setHead(id, SHA_A, { actor: DEV });
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => e.code === 'E_ACCEPTANCE_UNMET' && /required check unit/.test(e.message));
  await pass(s, id, SHA_A, 'lint');   // optional check does not stand in for the required one
  await s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], actor: 'runner' });   // exit unknown
  await pass(s, id, SHA_A, 'unit', 1);
  await assert.rejects(s.transition(id, 'accepted'), { code: 'E_ACCEPTANCE_UNMET' });
  // A raw completion event cannot bypass the guard either.
  await assert.rejects(s.append(id, { event_id: 'fake-done', kind: 'task.completed', payload: {} }), { code: 'E_ACCEPTANCE_UNMET' });
  assert.equal((await s.get(id)).status, 'evaluating');
  assert.equal((await s.get(id)).evidence.find((e) => e.exit === null).exit, null);
});

test('acceptance guard rejects self-approval and a standing reject (GL04)', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: DEV.id }, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => e.code === 'E_ACCEPTANCE_UNMET' && /self-approval/.test(e.message));
  await s.recordVerdict(id, { sha: SHA_A, actor: 'verifier-x', verdict: 'approve', findings: [] });
  await s.recordVerdict(id, { sha: SHA_A, actor: 'verifier-y', verdict: 'reject', findings: ['edge case missing'] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /verifier-y rejects/.test(e.message));
  await s.recordVerdict(id, { sha: SHA_A, actor: 'verifier-y', verdict: 'approve', findings: [] });   // re-reviewed
  await s.transition(id, 'accepted');
});

test('acceptance guard: head without a recorded developer cannot be independently approved', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A);
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /no developer actor/.test(e.message));
});

test('GL12: a new head SHA invalidates earlier evidence and verdicts, even when it moves back', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await s.setHead(id, SHA_B, { actor: DEV });
  await assert.rejects(s.transition(id, 'accepted'), (e) => e.code === 'E_ACCEPTANCE_UNMET' && e.message.includes(SHA_B));
  await pass(s, id, SHA_A);   // stale SHA evidence does not count
  await assert.rejects(s.transition(id, 'accepted'), { code: 'E_ACCEPTANCE_UNMET' });
  await s.setHead(id, SHA_A, { actor: DEV });   // back to A: the old passes predate this head
  await assert.rejects(s.transition(id, 'accepted'), { code: 'E_ACCEPTANCE_UNMET' });
  await pass(s, id, SHA_A);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await s.transition(id, 'accepted');
});

test('T14: after cancel every write is rejected with E_CANCELLED; reads still work', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id, 'executing');
  await s.recordEffect(id, { effect_id: 'fx1', idempotency_key: 'push:feature', kind: 'git.push', phase: 'attempted' });
  await s.transition(id, 'cancelled', { actor: 'owner', reason: 'owner cancelled' });
  const C = { code: 'E_CANCELLED' };
  await assert.rejects(s.transition(id, 'repair'), C);
  await assert.rejects(s.append(id, { event_id: 'late', kind: 'task.started' }), C);
  await assert.rejects(s.setHead(id, SHA_A, { actor: DEV }), C);
  await assert.rejects(pass(s, id), C);
  await assert.rejects(s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] }), C);
  await assert.rejects(s.recordUsage(id, { runtime: 'fake', input_tokens: 1 }), C);
  await assert.rejects(s.snapshotPolicy(id, { a: 1 }, { run_id: 'r2' }), C);
  await assert.rejects(s.recordEffect(id, { effect_id: 'fx2', idempotency_key: 'push:other', kind: 'git.push', phase: 'attempted' }), C);
  // The outcome of an effect already in flight is still recorded: hiding it would misreport external state.
  assert.equal((await s.recordEffect(id, { effect_id: 'fx1', phase: 'confirmed' })).applied, true);
  const t = await s.get(id);
  assert.equal(t.status, 'cancelled');
  assert.equal(t.outcome, 'cancelled');
  const s2 = open(dir);
  await assert.rejects(s2.transition(id, 'repair'), C);
});

test('T07: attempted-but-unconfirmed effect across restart -> unknown_external_effect, never repeated', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id, 'executing');
  await s.recordEffect(id, { effect_id: 'fx1', idempotency_key: 'push:v2/task/x', kind: 'git.push', phase: 'attempted' });
  // simulated restart: a fresh store over the same dir
  const s2 = open(dir);
  const r = await s2.recover();
  assert.equal(r.pendingEffects.length, 1);
  assert.equal(r.pendingEffects[0].effect_id, 'fx1');
  assert.equal(r.pendingEffects[0].phase, 'possibly_applied');
  let t = await s2.get(id);
  assert.equal(t.status, 'unknown_external_effect');
  assert.equal(t.effects[0].phase, 'possibly_applied');
  const lines = logOf(dir, id).length;
  // No blind repeat, no leaving the state before reconciliation.
  await assert.rejects(s2.recordEffect(id, { effect_id: 'fx1-retry', idempotency_key: 'push:v2/task/x', kind: 'git.push', phase: 'attempted' }), { code: 'E_EFFECT_UNRECONCILED' });
  await assert.rejects(s2.transition(id, 'executing'), { code: 'E_EFFECT_UNRECONCILED' });
  // A second restart neither duplicates events nor transitions.
  const s3 = open(dir);
  const r3 = await s3.recover();
  assert.equal(logOf(dir, id).length, lines);
  assert.equal(r3.pendingEffects[0].moved, false);
  // Reconcile (remote says it landed), then leave; the same idempotency key is never re-attempted.
  assert.equal((await s3.recordEffect(id, { effect_id: 'fx1', phase: 'confirmed' })).applied, true);
  assert.equal((await s3.recordEffect(id, { effect_id: 'fx1', phase: 'confirmed' })).applied, false);   // T06 for effects
  await s3.transition(id, 'executing');
  await assert.rejects(s3.recordEffect(id, { effect_id: 'fx1-again', idempotency_key: 'push:v2/task/x', kind: 'git.push', phase: 'attempted' }), { code: 'E_EFFECT_DUPLICATE' });
  t = await s3.get(id);
  assert.equal(t.effects.length, 1);
  assert.deepEqual(t.effects[0].history.map((h) => h.phase), ['attempted', 'possibly_applied', 'confirmed']);
  await assert.rejects(s3.recordEffect(id, { effect_id: 'fx1', phase: 'failed' }), { code: 'E_ILLEGAL_EFFECT' });
});

test('recover reports unconfirmed effects it cannot park without breaking the transition table', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id, 'executing');
  await s.recordEffect(id, { effect_id: 'fx1', idempotency_key: 'k1', kind: 'notify', phase: 'attempted' });
  await s.transition(id, 'evaluating');
  const r = await open(dir).recover();
  assert.equal(r.pendingEffects[0].state, 'evaluating');
  assert.equal(r.pendingEffects[0].moved, false);
  const s2 = open(dir);
  await s2.setHead(id, SHA_A, { actor: DEV });
  await pass(s2, id);
  await s2.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s2.transition(id, 'accepted'), (e) => /fx1 is possibly_applied/.test(e.message));
});

test('T18: crash mid-write of the completion leaves a torn tail; recovery drops it, no false completion', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  const crashing = createTaskStore({ dir, fs: crashingFs(/events\.jsonl$/), ...clock(Date.parse('2026-02-01T00:00:00Z')) });
  await assert.rejects(crashing.transition(id, 'accepted'), { code: 'EIO' });
  await assert.rejects(crashing.transition(id, 'accepted'), { code: 'E_STORE_FAILED' });   // no writes onto a torn file
  assert.ok(!readFileSync(join(dir, 'tasks', id, 'events.jsonl'), 'utf8').endsWith('\n'));
  const s2 = open(dir);
  const r = await s2.recover();
  assert.equal(r.torn.length, 1);
  assert.ok(r.torn[0].dropped_bytes > 0);
  const t = await s2.get(id);
  assert.equal(t.status, 'evaluating');
  assert.equal(t.outcome, 'not_yet_done');
  const log = logOf(dir, id);   // every line parses again
  assert.equal(log.at(-1).kind, 'recovery.torn_tail');
  assert.equal(log.at(-1).payload.recovered_torn_tail, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'tasks', id, 'snapshot.json'), 'utf8')).status, 'evaluating');
  await s2.transition(id, 'accepted');   // the unacknowledged write can simply be retried
});

test('T18: crash after the log write but before the snapshot: the event is durable and a retry is a no-op', async () => {
  const dir = tmp();
  const { task_id: id } = await open(dir).createTask(spec());
  let armed = false;
  const fs = { ...realFs, renameSync(...a) { if (armed) throw Object.assign(new Error('crash before rename'), { code: 'EIO' }); return realFs.renameSync(...a); } };
  const crashing = createTaskStore({ dir, fs, ...clock(Date.parse('2026-02-01T00:00:00Z')) });
  await crashing.init();
  armed = true;
  await assert.rejects(crashing.transition(id, 'clarified', { event_id: 'tr-1' }), { code: 'EIO' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'tasks', id, 'snapshot.json'), 'utf8')).status, 'created');   // stale cache
  const s2 = open(dir);
  assert.equal((await s2.get(id)).status, 'clarified');   // the log wins
  assert.equal((await s2.transition(id, 'clarified', { event_id: 'tr-1' })).applied, false);
});

test('T18: crash while writing task.created -> no half task; the same key creates it once later', async () => {
  const dir = tmp();
  const crashing = createTaskStore({ dir, fs: crashingFs(/events\.jsonl$/), ...clock() });
  await assert.rejects(crashing.createTask(spec(), { idempotencyKey: 'sched-7' }), { code: 'EIO' });
  const s = open(dir);
  const r = await s.recover();
  assert.deepEqual(r.tasks, []);
  const t = await s.createTask(spec(), { idempotencyKey: 'sched-7' });
  assert.deepEqual((await s.list()).map((x) => x.task_id), [t.task_id]);
});

test('a corrupt line in the middle of a log is reported and blocks writes, not skipped', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  const path = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n');
  writeFileSync(path, [lines[0], '{"garbage":', lines[1], ''].join('\n'));
  const s2 = open(dir);
  const r = await s2.recover();
  assert.equal(r.corrupt.length, 1);
  assert.equal((await s2.get(id)).status, 'created');
  await assert.rejects(s2.transition(id, 'clarified'), { code: 'E_STORE_FAILED' });
});

test('T22/GL13: unknown usage stays null, never 0', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await s.recordUsage(id, { runtime: 'fake', provider: 'fake', model: 'fake-1', input_tokens: 100, output_tokens: 20, usd: 0.01 });
  await s.recordUsage(id, { runtime: 'claude', provider: 'anthropic', model: 'm', input_tokens: 50 });
  let t = await s.get(id);
  assert.equal(t.usage[1].usd, null);
  assert.equal(t.usage[1].output_tokens, null);
  assert.deepEqual(t.usage[1].unknown, ['output_tokens', 'usd']);
  assert.equal(t.usage_totals.input_tokens, 150);
  assert.equal(t.usage_totals.usd, null);
  assert.equal(t.usage_totals.output_tokens, null);
  assert.deepEqual(t.usage_totals.unknown, ['output_tokens', 'usd']);
  await assert.rejects(s.recordUsage(id, { usd: 0, unknown: ['usd'] }), { code: 'E_INVALID' });
  await assert.rejects(s.recordUsage(id, { usd: -1 }), { code: 'E_INVALID' });
  await assert.rejects(s.recordUsage(id, { usd: 'free' }), { code: 'E_INVALID' });
  await assert.rejects(s.recordUsage(id, { cost: 1 }), { code: 'E_INVALID' });
  const s2 = open(tmp());
  const { task_id: id2 } = await s2.createTask(spec());
  t = await s2.get(id2);
  assert.deepEqual(t.usage_totals, { records: 0, input_tokens: null, output_tokens: null, usd: null,
    unknown: ['input_tokens', 'output_tokens', 'usd'] });   // nothing measured is unknown, not zero
  await s2.recordUsage(id2, { runtime: 'fake', input_tokens: 0, output_tokens: 0, usd: 0 });   // a measured zero stays a zero
  assert.equal((await s2.get(id2)).usage[0].usd, 0);
});

test('decisions are validated against §9 and idempotent by decision_id', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  const d = { decision_id: 'dec-1', kind: 'strategy', question: 'same failure 3x: what next?', chosen: 'replan',
    alternatives: [{ option: 'replan', pros: ['new approach'], cons: [] }, { option: 'retry', pros: [], cons: ['same signature'] }],
    evidence: ['ev-1'], expected_effect: 'new failure signature or pass', rationale: 'no-progress rule',
    actor: { role: 'manager', runtime: null, model: null }, confidence: null, policy_ref: 'OWNER_DECISIONS §4',
    reversible: true, rollback: 'return to the previous plan' };
  assert.equal((await s.recordDecision(id, d)).applied, true);
  assert.equal((await s.recordDecision(id, d)).applied, false);
  await assert.rejects(s.recordDecision(id, { ...d, decision_id: 'dec-2', alternatives: [] }), { code: 'E_INVALID' });
  await assert.rejects(s.recordDecision(id, { ...d, decision_id: 'dec-3', task_id: 'other' }), { code: 'E_INVALID' });
  assert.equal((await s.get(id)).decisions.length, 1);
});

test('policy snapshot is immutable within a run and refreshed by a new run', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  assert.equal((await s.snapshotPolicy(id, { v: 1 }, { run_id: 'run-1' })).applied, true);
  assert.equal((await s.snapshotPolicy(id, { v: 1 }, { run_id: 'run-1' })).applied, false);
  await assert.rejects(s.snapshotPolicy(id, { v: 2 }, { run_id: 'run-1' }), { code: 'E_POLICY_IMMUTABLE' });
  await s.snapshotPolicy(id, { v: 2 }, { run_id: 'run-2' });
  const t = await s.get(id);
  assert.equal(t.policy_snapshot.run_id, 'run-2');
  assert.deepEqual(t.policy_snapshot.policy, { v: 2 });
});

test('subtasks: createTask refuses a child that weakens its parent; list filters', async () => {
  const s = open(tmp());
  const parent = await s.createTask(spec({ project_id: 'p1', risk_class: 'high', budget_policy: { mode: 'cap', max_usd: 5 } }));
  await assert.rejects(s.createTask(spec({ project_id: 'p1', parent_task_id: parent.task_id, risk_class: 'low',
    budget_policy: { mode: 'cap', max_usd: 5 } })), (e) => e.code === 'E_NARROWING' && e.details.some((v) => v.field === 'risk_class'));
  await assert.rejects(s.createTask(spec({ project_id: 'p1', parent_task_id: parent.task_id, risk_class: 'high' })), { code: 'E_NARROWING' });
  await assert.rejects(s.createTask(spec({ project_id: 'p1', parent_task_id: 'nope' })), { code: 'E_NOT_FOUND' });
  const child = await s.createTask(spec({ project_id: 'p1', parent_task_id: parent.task_id, risk_class: 'critical',
    budget_policy: { mode: 'cap', max_usd: 1 } }));
  await s.createTask(spec({ project_id: 'p2' }));
  assert.deepEqual((await s.list({ parent_task_id: parent.task_id })).map((t) => t.task_id), [child.task_id]);
  assert.equal((await s.list({ project_id: 'p1' })).length, 2);
  assert.equal((await s.list({ state: 'created' })).length, 3);
  assert.equal((await s.list({ state: 'accepted' })).length, 0);
});

test('a torn tail after an appended partial line from another writer is also recovered', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  appendFileSync(join(dir, 'tasks', id, 'events.jsonl'), '{"event_id":"half","kind":"task.compl');
  const s2 = open(dir);
  const r = await s2.init();
  assert.equal(r.torn[0].task_id, id);
  await s2.transition(id, 'clarified');
  assert.deepEqual(logOf(dir, id).map((e) => e.kind), ['task.created', 'recovery.torn_tail', 'task.transitioned']);
});

test('actor identity: id only, normalized; id-less approve never counts, id-less reject still blocks', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: { role: 'developer', id: ' Dev-Agent-1 ' } });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', runtime: 'codex', model: 'm' }, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /no independent approve/.test(e.message));
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier' }, verdict: 'reject', findings: ['broken'] });
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /without id rejects/.test(e.message));
  await assert.rejects(s.recordVerdict(id, { sha: SHA_A, verdict: 'approve', findings: [] }), { code: 'E_INVALID' });
  await assert.rejects(s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: { role: 'runner' } }), { code: 'E_INVALID' });
});

test('terminal tasks: no writes after accepted or failed, no children of a cancelled parent, no raw torn-tail marker after cancel', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  await s.transition(id, 'waiting');
  await s.transition(id, 'failed_unrecoverable');
  await assert.rejects(s.append(id, { event_id: 'late', kind: 'task.started' }), { code: 'E_TERMINAL' });
  const p = await s.createTask(spec());
  await s.transition(p.task_id, 'cancelled');
  await assert.rejects(s.append(p.task_id, { event_id: 'tt', kind: 'recovery.torn_tail', payload: {} }), { code: 'E_CANCELLED' });
  await assert.rejects(s.createTask(spec({ parent_task_id: p.task_id })), { code: 'E_CANCELLED' });
  await assert.rejects(s.createTask(spec({ parent_task_id: id })), { code: 'E_TERMINAL' });
});

test('D-007: a task parked in waiting during integration resumes integrating', async () => {
  const s = open(tmp());
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.transition(id, 'integrating');
  await s.transition(id, 'waiting', { reason: 'remote CI pending' });
  await s.transition(id, 'integrating');
  assert.equal((await s.get(id)).status, 'integrating');
});
