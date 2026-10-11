// Re-verification of v2/02-task-core at c246b9f: pins the fixes for the 13 findings, D-007 and the terminal
// write guard; `todo` tests record the low residuals left open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore, actorKey } from '../orchestration/store.js';
import { restrictedTopics } from '../orchestration/policy.js';
import { TRANSITIONS } from '../orchestration/task-contract.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'v2-verify2-'));
const open = (dir = tmp()) => createTaskStore({ dir, ...clock() });
const PATH = ['clarified', 'planned', 'ready', 'executing', 'evaluating'];
const toState = async (s, id, last = 'evaluating') => { for (const x of PATH.slice(0, PATH.indexOf(last) + 1)) await s.transition(id, x); };
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-agent-2' };
const pass = (s, id) => s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: 'runner' });
const UNMET = { code: 'E_ACCEPTANCE_UNMET' };
async function readyToAccept(s, dev = DEV) {
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: dev });
  await pass(s, id);
  return id;
}

test('verify2: D-007 waiting -> integrating does not open a path around the acceptance guard', async () => {
  assert.deepEqual(Object.entries(TRANSITIONS).filter(([, to]) => to.includes('accepted')).map(([f]) => f), ['evaluating', 'release_verifying']);
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  for (const to of ['waiting', 'integrating', 'release_verifying']) await s.transition(id, to);
  await assert.rejects(s.transition(id, 'accepted'), UNMET);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  assert.equal((await s.transition(id, 'accepted')).applied, true);
});

test('verify2: id-less actors never show independence; an id-less reject still blocks', async () => {
  const s = open();
  const id = await readyToAccept(s, { role: 'developer', runtime: 'claude', model: 'm' });
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /no developer actor/.test(e.message));
  const s2 = open();
  const id2 = await readyToAccept(s2);
  await s2.recordVerdict(id2, { sha: SHA_A, actor: { role: 'verifier' }, verdict: 'approve', findings: [] });
  await assert.rejects(s2.transition(id2, 'accepted'), (e) => /no independent approve/.test(e.message));
  await s2.recordVerdict(id2, { sha: SHA_A, actor: { role: 'other' }, verdict: 'reject', findings: ['x'] });
  await s2.recordVerdict(id2, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s2.transition(id2, 'accepted'), (e) => /without id rejects/.test(e.message));
  await assert.rejects(s2.recordEvidence(id2, { check_id: 'unit', sha: SHA_A, command: ['x'], exit: 0, actor: { role: 'runner' } }), { code: 'E_INVALID' });
});

test('verify2: terminal tasks reject every write except resolving an effect already in flight', async () => {
  const s = open();
  const id = await readyToAccept(s);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await s.recordEffect(id, { effect_id: 'fx', idempotency_key: 'k', kind: 'push', phase: 'attempted' });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /fx is attempted/.test(e.message));
  await s.recordEffect(id, { effect_id: 'fx', phase: 'confirmed' });
  await s.transition(id, 'accepted');
  const T = { code: 'E_TERMINAL' };
  await assert.rejects(s.recordUsage(id, { runtime: 'fake', usd: 1 }), T);
  await assert.rejects(pass(s, id), T);
  await assert.rejects(s.recordEffect(id, { effect_id: 'fx2', idempotency_key: 'k2', kind: 'push', phase: 'attempted' }), T);
  await assert.rejects(s.transition(id, 'cancelled'), T);
  await assert.rejects(s.append(id, { event_id: 'rt', kind: 'recovery.torn_tail', payload: {} }), T);
  await assert.rejects(s.createTask(spec({ parent_task_id: id })), T);
  const s2 = open();
  const { task_id: id2 } = await s2.createTask(spec());
  await toState(s2, id2, 'executing');
  await s2.recordEffect(id2, { effect_id: 'fx', idempotency_key: 'k', kind: 'push', phase: 'attempted' });
  await s2.transition(id2, 'failed_unrecoverable');
  assert.equal((await s2.recordEffect(id2, { effect_id: 'fx', phase: 'confirmed' })).applied, true);
  await assert.rejects(s2.recordUsage(id2, { runtime: 'fake' }), T);
});

test('verify2: seq is dense on write and on replay; a hand-written gap is corrupt, not silently accepted', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.append(id, { event_id: 'a', kind: 'task.started', seq: 2 });
  for (const seq of [4, Number.MAX_SAFE_INTEGER, 2.5, 2]) await assert.rejects(s.append(id, { event_id: `s${seq}`, kind: 'task.started', seq }), { code: 'E_SEQ' });
  await s.append(id, { event_id: 'b', kind: 'task.started' });
  const log = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3]);
  const ev = JSON.parse(lines[1]);
  writeFileSync(log, [...lines, JSON.stringify({ ...ev, seq: 5, event_id: 'gap' }), ''].join('\n'));
  assert.equal((await open(dir).recover()).corrupt.length, 1);
});

test('verify2: actor identity folds homoglyphs, zero-width and combining marks', { todo: 'residual (low): actorKey is NFKC+trim+casefold only; "dev-аgent-1" (Cyrillic a), "dev-​agent-1" and "dev-agent-1́" pass as independent of dev-agent-1' }, async () => {
  for (const actor of ['dev-аgent-1', 'dev-​agent-1', 'dev-agent-1́']) {
    const s = open();
    const id = await readyToAccept(s);
    await s.recordVerdict(id, { sha: SHA_A, actor, verdict: 'approve', findings: [] });
    await assert.rejects(s.transition(id, 'accepted'), UNMET, JSON.stringify(actor));
  }
  assert.equal(actorKey('dev-​agent-1'), 'dev-agent-1');
});

test('verify2: snapshot.json of a task with a corrupt log carries the store_error, not the pre-corruption state', { todo: 'residual (low): recover() skips saveSnapshot for broken tasks, so an external reader of snapshot.json sees the stale healthy status' }, async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  await s.transition(id, 'planned');
  const p = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n');
  writeFileSync(p, [lines[0], 'garbage', lines[1], lines[2], ''].join('\n'));
  await open(dir).recover();
  const snap = JSON.parse(readFileSync(join(dir, 'tasks', id, 'snapshot.json'), 'utf8'));
  assert.ok(snap.store_error, `snapshot: ${JSON.stringify({ status: snap.status, store_error: snap.store_error })}`);
});

test('verify2: two-layer obfuscations (split + leet / split + join char) are caught', { todo: 'residual (low): splitJoins runs on the base variant only and splits on whitespace/dashes; "d3 pl0y", "de- ploy" and "de_pl oy" are not restricted' }, () => {
  for (const t of ['d3 pl0y', 'de- ploy', 'de_pl oy']) assert.ok(restrictedTopics(t).some((x) => x.class === 'deploy'), t);
});
