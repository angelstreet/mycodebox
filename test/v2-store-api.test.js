// Store read APIs used by controllers: events() and independence() (judged from the store's own records).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../orchestration/store.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';

const open = () => createTaskStore({ dir: mkdtempSync(join(tmpdir(), 'v2-store-api-')), ...clock() });
const DEV = { role: 'developer', id: 'dev-1' };

test('events(): the validated log in seq order; unknown task -> E_NOT_FOUND', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  const ev = await s.events(id);
  assert.deepEqual(ev.map((e) => e.kind), ['task.created', 'task.transitioned']);
  assert.deepEqual(ev.map((e) => e.seq), [1, 2]);
  await assert.rejects(s.events('nope'), { code: 'E_NOT_FOUND' });
});

test('independence(): developer from setHead, not from the caller; look-alike ids are the developer', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await s.setHead(id, SHA_A, { actor: DEV });
  assert.equal((await s.independence(id, SHA_A)).ok, false);
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: 'DEV-​1' }, verdict: 'approve', findings: [] });
  const self = await s.independence(id, SHA_A);
  assert.equal(self.ok, false, 'a look-alike of the developer is not independent');
  assert.deepEqual(self.developers, ['dev-1']);
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: 'rev-1' }, verdict: 'approve', findings: [] });
  const r = await s.independence(id, SHA_A);
  assert.deepEqual([r.ok, r.approvers], [true, ['rev-1']]);
  assert.equal((await s.independence(id, 'f'.repeat(40))).ok, false, 'not the current head');
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', id: 'rev-2' }, verdict: 'reject', findings: ['x'] });
  assert.equal((await s.independence(id, SHA_A)).ok, false, 'an independent reject blocks');
});

test('usage: an adapter-reported incomplete flag is kept and makes totals incomplete; non-boolean refused', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await s.recordUsage(id, { runtime: 'minimax', provider: 'minimax', model: 'm', input_tokens: 10, output_tokens: 2, usd: null, incomplete: true });
  const v = await s.get(id);
  assert.equal(v.usage.at(-1).incomplete, true);
  assert.equal(v.usage_totals.incomplete, true);
  assert.equal(v.usage_totals.usd, null);
  await assert.rejects(s.recordUsage(id, { runtime: 'x', incomplete: 'yes' }), { code: 'E_INVALID' });
});
