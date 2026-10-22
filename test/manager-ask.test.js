// A manager question in the ask popup: tappable options, the recommended one highlighted in place, the answer typed to the manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askOptions, looseRecommendation, answerText } from '../public/manager-ask.js';

// the real ledger shape (Q206, 2026-10-22): options carry their number, the recommendation is a bare number
const Q206 = { id: 'Q206', session: 'manager', question: 'Add a systemd unit?', options: ['1 yes, add it', '2 no'], recommendation: '1' };

test('askOptions: the ledger\'s "1 yes, add it" becomes number 1 and label "yes, add it"; the recommended one is marked', () => {
  assert.deepEqual(askOptions(Q206), [{ n: '1', label: 'yes, add it', rec: true, why: '' }, { n: '2', label: 'no', rec: false, why: '' }]);
});

test('askOptions: "1 — why" recommends option 1 and keeps the reason for a tooltip', () => {
  const o = askOptions({ ...Q206, recommendation: '1 — cheap and reversible' });
  assert.equal(o[0].rec, true); assert.equal(o[0].why, 'cheap and reversible'); assert.equal(o[1].rec, false);
});

test('askOptions: numbered by position when the options carry no number; "2." / "2)" forms parse; no options -> none', () => {
  assert.deepEqual(askOptions({ options: ['yes', 'no'], recommendation: '2' }).map((o) => [o.n, o.label, o.rec]), [['1', 'yes', false], ['2', 'no', true]]);
  assert.deepEqual(askOptions({ options: ['1. keep', '2) drop'] }).map((o) => [o.n, o.label]), [['1', 'keep'], ['2', 'drop']]);
  assert.deepEqual(askOptions({ question: 'q' }), []);
});

test('looseRecommendation: only free text that points at no option stays a note (the "Recommends" box is gone otherwise)', () => {
  assert.equal(looseRecommendation(Q206), '');
  assert.equal(looseRecommendation({ ...Q206, recommendation: '1 — why' }), '');
  assert.equal(looseRecommendation({ ...Q206, recommendation: 'wait for the quota reset' }), 'wait for the quota reset');
  assert.equal(looseRecommendation({ ...Q206, recommendation: '3' }), '3', 'a number with no such option is shown as text');
  assert.equal(looseRecommendation({ id: 'Q' }), '');
});

test('answerText: names the question and the chosen option', () => {
  assert.equal(answerText(Q206, askOptions(Q206)[0]), 'Owner answer to Q206 — option 1: yes, add it');
  assert.equal(answerText({}, { n: '2', label: 'no' }), 'Owner answer to your question — option 2: no');
});
