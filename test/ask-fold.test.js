// One open ask per session (owner, 2026-10-31): an open ledger ask folds that session's further asks / waiting alerts.
// Temp state dir and synthetic wording only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createAskFold } from '../ask-fold.js';

const row = (o) => JSON.stringify({ at: '2026-10-31T10:00:00.000Z', floor: 'credentials', state: 'open', ...o }) + '\n';

test('an open ask folds asks / waiting alerts of its session until it is answered or superseded', async () => {
  const dir = tmp('ask-fold-');
  const file = join(dir, 'manager-owner-asks.jsonl');
  writeFileSync(file, row({ id: 'Q1', session: 'S1', question: 'Synthetic question 1?' }));
  let t = 0;
  const fold = createAskFold({ file, ttlMs: 1000, now: () => t });
  await fold.refresh();
  assert.equal(fold.folds('S1', 'asks'), true);
  assert.equal(fold.folds('S1', 'waiting'), true);
  assert.equal(fold.folds('S1', 'done'), false, 'a done report is never folded');
  assert.equal(fold.folds('S2', 'asks'), false, 'another session is not folded');
  assert.equal(fold.openAskOf('S1'), 'Q1');
  // superseded by a newer ask of the same session: still folded (into the new one)
  appendFileSync(file, row({ id: 'Q2', session: 'S1', question: 'Synthetic question 2?' }) + JSON.stringify({ id: 'Q1', state: 'superseded', by: 'Q2' }) + '\n');
  t = 5000; fold.openAskOf('S1'); await fold.refresh();
  assert.equal(fold.openAskOf('S1'), 'Q2');
  // answered: alerts go out again
  appendFileSync(file, JSON.stringify({ id: 'Q2', state: 'answered', answer: 'yes' }) + '\n');
  t = 10000; fold.openAskOf('S1'); await fold.refresh();
  assert.equal(fold.folds('S1', 'asks'), false);
});

test('a missing or unreadable ledger folds nothing', async () => {
  const fold = createAskFold({ file: join(tmp('ask-fold-none-'), 'missing.jsonl') });
  await fold.refresh();
  assert.equal(fold.folds('S1', 'asks'), false);
  const broken = createAskFold({ file: 'x', read: async () => { throw new Error('boom'); } });
  await broken.refresh();
  assert.equal(broken.folds('S1', 'asks'), false);
});
