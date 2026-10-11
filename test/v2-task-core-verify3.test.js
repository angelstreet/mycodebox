// Verification of 18e3485: actorKey folding, store.events() and store.independence(). `todo` tests record
// the open low findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore, actorKey } from '../orchestration/store.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'v2-verify3-'));
const open = (dir = tmp()) => createTaskStore({ dir, ...clock() });
const PATH = ['clarified', 'planned', 'ready', 'executing', 'evaluating'];
const toState = async (s, id) => { for (const x of PATH) await s.transition(id, x); };
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-2' };
const verdict = (s, id, actor, v, sha = SHA_A) => s.recordVerdict(id, { sha, actor, verdict: v, findings: v === 'reject' ? ['x'] : [] });

test('verify3: actorKey folds look-alikes but keeps genuinely different ids apart', () => {
  for (const [a, b] of [['dev-аgent-1', 'dev-agent-1'], ['dev-​agent-1', 'dev-agent-1'], ['dev-agent-1́', 'dev-agent-1'], ['расс', 'pacc'], ['ｄev', 'dev'], ['İx', 'ix']]) {
    assert.equal(actorKey(a), actorKey(b), `${JSON.stringify(a)} should fold to ${b}`);
  }
  for (const [a, b] of [['o0', 'oo'], ['l1', 'li'], ['dev_1', 'dev-1'], ['dev.1', 'dev-1'], ['a b', 'ab'], ['α', 'a'], ['ø', 'o'], ['ł', 'l'], ['ß', 'ss']]) {
    assert.notEqual(actorKey(a), actorKey(b), `${JSON.stringify(a)} must stay distinct from ${b}`);
  }
  assert.equal(actorKey('​‌'), null);
});

test('verify3: independence() is epoch-scoped, head-only, ignores caller identity, and treats anonymous rejects as sticky', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  assert.equal((await s.independence(id, SHA_A)).ok, false);
  await s.setHead(id, SHA_A, { actor: DEV });
  await verdict(s, id, DEV, 'approve');
  assert.deepEqual((await s.independence(id, SHA_A)).approvers, []);   // self-approval
  await verdict(s, id, VERIFIER, 'approve');
  assert.deepEqual((await s.independence(id, SHA_A)).approvers, ['verifier-2']);
  for (const sha of [SHA_B, SHA_A.toUpperCase(), undefined, '']) assert.equal((await s.independence(id, sha)).ok, false, String(sha));
  await verdict(s, id, VERIFIER, 'approve', SHA_B);   // pre-recorded for a SHA that is not yet head
  await s.setHead(id, SHA_B, { actor: DEV });
  assert.equal((await s.independence(id, SHA_B)).ok, false, 'approve recorded before the head moved does not count');
  await s.setHead(id, SHA_A, { actor: DEV });
  assert.equal((await s.independence(id, SHA_A)).ok, false, 'approve from the earlier A epoch is stale');
  await verdict(s, id, VERIFIER, 'approve');
  assert.equal((await s.independence(id, SHA_A)).ok, true);
  await s.setHead(id, SHA_A, { actor: { id: 'VERIFIER-2' } });   // verifier becomes a developer under other casing
  const r = await s.independence(id, SHA_A);
  assert.deepEqual([r.ok, r.developers.sort()], [false, ['dev-agent-1', 'verifier-2']]);
  await verdict(s, id, { id: 'rev-3' }, 'approve');
  assert.equal((await s.independence(id, SHA_A)).ok, true);
  await verdict(s, id, { role: 'anon' }, 'reject');
  await verdict(s, id, { role: 'anon' }, 'approve');
  assert.match((await s.independence(id, SHA_A)).reasons.join(), /without id rejects/);
});

test('verify3: events() returns isolated copies and E_NOT_FOUND for unknown tasks', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  const ev = await s.events(id);
  ev[0].kind = 'hacked';
  assert.deepEqual((await s.events(id)).map((e) => e.kind), ['task.created', 'task.transitioned']);
  await assert.rejects(s.events('nope'), { code: 'E_NOT_FOUND' });
});

async function corruptAfterApprove(dir) {
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await verdict(s, id, VERIFIER, 'approve');
  await s.setHead(id, SHA_B, { actor: DEV });   // the head moved on, but this line will sit behind a corrupt one
  const p = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, [...lines.slice(0, -1), 'garbage', lines.at(-1), ''].join('\n'));
  return id;
}

test('verify3: independence() and events() refuse or flag a task whose log is corrupt', { todo: 'finding (low-medium): on a corrupt-log task independence() answers ok:true from the partial replay (stale head A) and events() silently stops at the corrupt line; a controller could merge on it' }, async () => {
  const dir = tmp();
  const id = await corruptAfterApprove(dir);
  const s = open(dir);
  const r = await s.recover();
  assert.equal(r.corrupt.length, 1);
  const ind = await s.independence(id, SHA_A);
  assert.equal(ind.ok, false, JSON.stringify(ind));
  await assert.rejects(s.events(id), { code: 'E_STORE_FAILED' });
});

test('verify3: a reject from one verifier is not hidden by a later approve from an id that folds to the same key', { todo: 'finding (low): verdicts are collapsed per folded key, so "josé" rejects then "jose" approves -> independent approve, reject lost (same for casing)' }, async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await verdict(s, id, 'josé', 'reject');
  await verdict(s, id, 'jose', 'approve');
  assert.equal((await s.independence(id, SHA_A)).ok, false);
});
