// bug-71b3ff6a: a session that moved past the STATUS that raised its owner ask closes the ask (temp state dir, synthetic wording).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { resolveMovedOn, readLedger, readOpenAsks, staleAsks } from '../owner-asks.js';

const ask = (n, o = {}) => ({ at: '2026-11-22T10:00:00.000Z', id: `Q${n}`, session: `S${n}`, question: `Synthetic ${n}?`, floor: 'owner_fact', state: 'open', ...o });
const seed = (rows) => { const d = tmp('ask-moved-'); const f = join(d, 'manager-owner-asks.jsonl'); writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); return f; };
const now = new Date('2026-11-22T13:00:00.000Z');
const ids = async (f) => (await readOpenAsks(f)).map((a) => a.id);

test('a later done / running / waiting-on-a-system-id turn resolves the session ask, with reason and time', async () => {
  for (const [status, text] of [['done', ''], ['running', 'worker w1'], ['waiting', 'integration int-abc']]) {
    const f = seed([ask(1), ask(2)]);
    assert.deepEqual(await resolveMovedOn(f, 'S1', { status, text, now }), ['Q1']);
    assert.deepEqual(await ids(f), ['Q2'], 'dropped from the open view, other session untouched');
    const last = (await readLedger(f)).records.at(-1);
    assert.equal(last.state, 'resolved'); assert.equal(last.at, now.toISOString()); assert.match(last.reason, /moved past/);
    assert.equal(staleAsks((await readLedger(f)).records, { now, hours: 1 }).some((a) => a.id === 'Q1'), false);
  }
});

test('needs-owner / blocked / failed, a waiting on the owner, a fresh ask and a closed ask change nothing', async () => {
  const f = seed([ask(1), ask(2, { at: now.toISOString() }), ask(3), { id: 'Q3', state: 'answered' }]);
  for (const st of ['needs-owner', 'needs-manager', 'blocked', 'failed', '']) assert.deepEqual(await resolveMovedOn(f, 'S1', { status: st, now }), []);
  assert.deepEqual(await resolveMovedOn(f, 'S1', { status: 'waiting', text: 'owner answer to Q1', now }), []);
  assert.deepEqual(await resolveMovedOn(f, 'S2', { status: 'done', now }), [], 'raised by this very turn');
  assert.deepEqual(await resolveMovedOn(f, 'S3', { status: 'done', now }), []);
  assert.deepEqual(await ids(f), ['Q2', 'Q1']);
});
