// An owner tap closes its ask, and an old open ask is listed as stale for the sweep (owner, 2026-10-31: Q245/Q262 stayed open
// after the owner answered, Q245/Q246 sat 4 days after the world moved on). Temp state dir and synthetic wording only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { ownerAnswerOf, recordOwnerAnswer, staleAsks, readLedger, openAsksFromRecords } from '../owner-asks.js';
import { answerText } from '../public/manager-ask.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ask = (n, o = {}) => ({ at: '2026-10-27T10:00:00.000Z', id: `Q${n}`, session: `S${n}`, question: `Synthetic question ${n}?`, floor: 'owner_fact', options: ['1 yes', '2 no'], state: 'open', ...o });
const seed = (rows) => { const dir = tmp('ask-tap-'); writeFileSync(join(dir, 'manager-owner-asks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); return dir; };
const open = async (dir) => openAsksFromRecords((await readLedger(join(dir, 'manager-owner-asks.jsonl'))).records).map((a) => a.id);

test('ownerAnswerOf reads exactly the popup wording', () => {
  assert.deepEqual(ownerAnswerOf(answerText({ id: 'Q7' }, { n: '1', label: 'yes, go' })), { id: 'Q7', option: '1', label: 'yes, go' });
  assert.equal(ownerAnswerOf('Owner answer to Q21 (relayed by the manager): use voice 7'), null);
  assert.equal(ownerAnswerOf('please look at Q7 — option 1'), null);
  assert.equal(ownerAnswerOf(undefined), null);
});

test('an owner tap closes the open ask; a manager send or a closed ask changes nothing', async () => {
  const dir = seed([ask(1), ask(2), ask(3), { id: 'Q3', state: 'answered', answer: 'x' }]);
  const file = join(dir, 'manager-owner-asks.jsonl');
  const text = (id) => answerText({ id }, { n: '2', label: 'no' });
  assert.equal(await recordOwnerAnswer(file, { session: 'S2', by: 'manager-agent', text: text('Q2') }), null, 'not the owner');
  assert.equal(await recordOwnerAnswer(file, { session: 'S3', text: text('Q3') }), null, 'already closed');
  assert.equal(await recordOwnerAnswer(file, { session: 'manager', text: text('Q2') }), 'Q2', 'sent to the manager still counts');
  assert.deepEqual(await open(dir), ['Q1']);
  const last = (await readLedger(file)).records.at(-1);
  assert.equal(last.state, 'answered'); assert.equal(last.answer, 'option 2: no'); assert.equal(last.via, 'owner-tap');
  assert.equal(await recordOwnerAnswer(file, { session: 'S2', text: text('Q2') }), null, 'a second tap writes nothing');
});

test('staleAsks lists open asks at or over the age, oldest first; closed and fresh ones are not listed', () => {
  const now = Date.parse('2026-10-31T10:00:00.000Z');
  const recs = [ask(1), ask(2, { at: '2026-10-30T10:00:00.000Z' }), ask(3, { at: '2026-10-25T10:00:00.000Z' }), ask(4), { id: 'Q4', state: 'answered' }];
  assert.deepEqual(staleAsks(recs, { now }).map((a) => [a.id, a.ageH]), [['Q3', 144], ['Q1', 96]]);
  assert.deepEqual(staleAsks(recs, { now, hours: 12 }).map((a) => a.id), ['Q3', 'Q1', 'Q2']);
});

test('manager-ask --stale prints one line per stale ask and exits 0', () => {
  const dir = seed([ask(1, { at: new Date(Date.now() - 72 * 3600_000).toISOString() }), ask(2, { at: new Date().toISOString() })]);
  const out = execFileSync('node', [join(ROOT, 'scripts', 'manager-ask.js'), '--stale'], { env: { ...process.env, GHOSTY_STATE_DIR: dir, GHOSTY_ASK_STALE_H: '' } }).toString().trim().split('\n');
  assert.equal(out.length, 1);
  assert.match(out[0], /^!! ask-stale Q1 S1 7[12]h "Synthetic question 1\?": still true today\?.*--resolve Q1/);
});
