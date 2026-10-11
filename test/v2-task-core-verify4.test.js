// Verification of 46e8406: rejects keyed by raw id in acceptanceUnmet and independence(); read APIs refuse
// a task whose log is corrupt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'v2-verify4-'));
const open = (dir = tmp()) => createTaskStore({ dir, ...clock() });
const PATH = ['clarified', 'planned', 'ready', 'executing', 'evaluating'];
const DEV = { role: 'developer', id: 'dev-agent-1' };
async function ready(s) {
  const { task_id: id } = await s.createTask(spec());
  for (const x of PATH) await s.transition(id, x);
  await s.setHead(id, SHA_A, { actor: DEV });
  await s.recordEvidence(id, { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 0, actor: 'runner' });
  return id;
}
const verdict = (s, id, actor, v) => s.recordVerdict(id, { sha: SHA_A, actor, verdict: v, findings: v === 'reject' ? ['x'] : [] });

test('verify4: a reject survives a later approve from any id that merely folds to the same key; only the same raw id clears it', async () => {
  const blocked = [[['josé', 'reject'], ['jose', 'approve']], [['Jose', 'reject'], ['jose', 'approve']], [['jo​se', 'reject'], ['jose', 'approve']],
    [[{ id: 'josé' }, 'reject'], ['jose', 'approve']], [['jose', 'approve'], ['josé', 'reject']], [['v1', 'reject'], ['v2', 'approve']]];
  for (const seq of blocked) {
    const s = open();
    const id = await ready(s);
    for (const [a, v] of seq) await verdict(s, id, a, v);
    assert.equal((await s.independence(id, SHA_A)).ok, false, JSON.stringify(seq));
    await assert.rejects(s.transition(id, 'accepted'), { code: 'E_ACCEPTANCE_UNMET' }, JSON.stringify(seq));
  }
  const cleared = [[['jose', 'reject'], ['jose', 'approve']], [[' jose ', 'reject'], ['jose', 'approve']], [['v1', 'reject'], ['v1', 'approve'], ['v2', 'approve']],
    [['DEV-AGENT-1', 'reject'], ['v', 'approve']]];   // a developer's reject is not a verifier verdict
  for (const seq of cleared) {
    const s = open();
    const id = await ready(s);
    for (const [a, v] of seq) await verdict(s, id, a, v);
    assert.equal((await s.independence(id, SHA_A)).ok, true, JSON.stringify(seq));
    assert.equal((await s.transition(id, 'accepted')).applied, true, JSON.stringify(seq));
  }
});

test('verify4: events() and independence() refuse a task whose log is corrupt', async () => {
  const dir = tmp();
  const s = open(dir);
  const id = await ready(s);
  await verdict(s, id, 'v', 'approve');
  await s.setHead(id, SHA_B, { actor: DEV });
  const p = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, [...lines.slice(0, -1), 'garbage', lines.at(-1), ''].join('\n'));
  const s2 = open(dir);
  assert.equal((await s2.recover()).corrupt.length, 1);
  const ind = await s2.independence(id, SHA_A);
  assert.equal(ind.ok, false);
  assert.match(ind.reasons.join(), /store error/);
  await assert.rejects(s2.events(id), { code: 'E_STORE_FAILED' });
  assert.ok((await s2.get(id)).store_error);
});
