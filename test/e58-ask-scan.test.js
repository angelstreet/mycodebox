// E58: the hourly scan must not reprint the ledger's backlog of old drops every hour, and it must still catch a
// new one. Temp GHOSTY_STATE_DIR and synthetic wording only; the live ledger is never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scripts', 'manager-ask-scan.sh');
const STOP = 'deadbeef-dead-beef-dead-beefdeadbeef';   // the shape the E22 defect wrote as the replacement
const OLD = '2026-10-15T10:00:00.000Z';               // days old: the backlog the scan used to reprint every hour
const HOUR = 3600 * 1000;

const scan = (dir) => execFileSync('bash', [SCAN], { env: { ...process.env, GHOSTY_STATE_DIR: dir } })
  .toString().trim().split('\n').filter(Boolean);
const ask = (n, o = {}) => ({ at: OLD, id: `Q${n}`, session: `S${n}`, question: `Synthetic question ${n}?`, state: 'open', ...o });
const seed = (dir, rows, alerts = []) => {
  writeFileSync(join(dir, 'manager-owner-asks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (alerts.length) writeFileSync(join(dir, 'manager-ask-alerts.jsonl'), alerts.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// The historical shape of the live ledger: an old drop by a stop id (the E22 defect), an old drop whose
// replacement is a question that is gone, an answered ask, an open ask, and one NEW drop.
test('E58: the scan reports the new drop and does not reprint the historical rows', () => {
  const dir = tmp('e58-scan-');
  const now = new Date().toISOString();
  seed(dir, [
    ask(1),                                              // Q1: old, superseded by a stop id
    { at: OLD, id: 'Q1', state: 'superseded', by: STOP },
    ask(2), ask(3),                                      // Q2: old, superseded by a question that is gone
    { at: OLD, id: 'Q3', state: 'closed' },
    { at: OLD, id: 'Q2', state: 'superseded', by: 'Q3' },
    ask(4),                                              // Q4: answered by the owner
    { at: OLD, id: 'Q4', state: 'answered', answer: 'yes' },
    ask(5),                                              // Q5: open and alerted
    ask(6, { at: now }),                                 // Q6: the new drop
    { at: now, id: 'Q6', state: 'superseded', by: STOP },
  ], [{ id: 'Q5', at: Date.now(), via: 'manager-ask' }]);
  assert.deepEqual(scan(dir), [`!! ask-superseded-dropped Q6 ${STOP} (not a question in the ledger)`]);
});

test('E58: a drop is reported once, not on every scan', () => {
  const dir = tmp('e58-once-');
  const now = new Date().toISOString();
  seed(dir, [
    ask(1, { at: now }),
    { at: now, id: 'Q1', state: 'superseded', by: STOP },
  ]);
  assert.deepEqual(scan(dir), [`!! ask-superseded-dropped Q1 ${STOP} (not a question in the ledger)`]);
  assert.deepEqual(scan(dir), [], 'the same drop is not reprinted on the next scan');
});

test('E58: a drop that happened while the scan was off is still caught', () => {
  const dir = tmp('e58-off-');
  const now = new Date().toISOString();
  seed(dir, [
    ask(1, { at: now }),
    { at: now, id: 'Q1', state: 'superseded', by: STOP },
  ]);
  // the scan last ran three hours ago (its marker) and has seen nothing since
  writeFileSync(join(dir, 'manager-ask-scan.json'), JSON.stringify({ lastAt: new Date(Date.now() - 3 * HOUR).toISOString(), reported: [] }));
  assert.deepEqual(scan(dir), [`!! ask-superseded-dropped Q1 ${STOP} (not a question in the ledger)`]);
});

test('E58: a superseded ask whose replacement is still open is still reported', () => {
  const dir = tmp('e58-open-');
  seed(dir, [
    ask(1), ask(2),
    { at: OLD, id: 'Q1', state: 'superseded', by: 'Q2' },
  ], [{ id: 'Q2', at: Date.now(), via: 'manager-ask' }]);
  assert.deepEqual(scan(dir), ['!! ask-superseded-open Q1 Q2 "Synthetic question 2?"']);
});

test('E58: an answered ask is never reported', () => {
  const dir = tmp('e58-answered-');
  seed(dir, [
    ask(1), ask(2),
    { at: OLD, id: 'Q1', state: 'superseded', by: 'Q2' },
    { at: OLD, id: 'Q2', state: 'answered', answer: 'yes' },
  ], [{ id: 'Q2', at: Date.now(), via: 'manager-ask' }]);
  assert.deepEqual(scan(dir), []);
});

test('E58: a drop names the replacement: its id and its wording when it is a question', () => {
  const dir = tmp('e58-wording-');
  const now = new Date().toISOString();
  seed(dir, [
    ask(1, { at: now }), ask(2, { at: now }),
    { at: now, id: 'Q2', state: 'closed' },
    { at: now, id: 'Q1', state: 'superseded', by: 'Q2' },
  ], [{ id: 'Q2', at: Date.now(), via: 'manager-ask' }]);
  assert.deepEqual(scan(dir), ['!! ask-superseded-dropped Q1 Q2 "Synthetic question 2?" (the replacement is closed)']);
});
