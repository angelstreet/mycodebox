import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsks } from '../owner-asks.js';

const L = (...o) => o.map((x) => JSON.stringify(x));

test('openAsks: a question stays open until a resolution line closes it', () => {
  const r = openAsks(L(
    { at: '2026-10-06T01:00:00Z', id: 'Q1', session: 'A', question: 'merge?', floor: 'money', options: ['yes', 'no'], recommendation: 'yes', state: 'open' },
    { at: '2026-10-06T02:00:00Z', id: 'Q2', session: 'B', question: 'deploy?', floor: 'money', state: 'open' },
    { id: 'Q1', state: 'answered', owner_answer: 'yes', agreed: true },
  ));
  assert.deepEqual(r.map((a) => a.id), ['Q2']);
  assert.equal(r[0].session, 'B');
});

test('openAsks: partial and amended stay open, superseded and ledger-close close, newest first', () => {
  const r = openAsks(L(
    { at: '2026-10-06T01:00:00Z', id: 'Q1', session: 'A', question: 'one?', floor: 'money', state: 'open' },
    { id: 'Q1', state: 'partial' },
    { at: '2026-10-06T02:00:00Z', id: 'Q2', session: 'B', question: 'two?', floor: 'money', state: 'open' },
    { id: 'Q2', state: 'superseded' },
    { at: '2026-10-06T03:00:00Z', id: 'Q3', session: 'C', question: 'three?', floor: 'money', state: 'open' },
    { id: 'Q3', action: 'ledger-close' },
    { at: '2026-10-06T04:00:00Z', id: 'Q4', session: 'D', question: 'old?', floor: 'money', state: 'open' },
    { at: '2026-10-06T05:00:00Z', id: 'Q4', action: 'ledger-amend', question: 'new?', floor: 'money' },
  ));
  assert.deepEqual(r.map((a) => a.id), ['Q4', 'Q1']);
  assert.equal(r[0].question, 'new?');
});

test('openAsks: junk lines are ignored', () => {
  assert.deepEqual(openAsks(['not json', '{}', '']), []);
});
