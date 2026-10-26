// A manager question in the ask popup: tappable options, the recommended one highlighted in place, the answer typed to the manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askOptions, looseRecommendation, answerText, askSummary, askLine } from '../public/manager-ask.js';

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

// What the owner reads (owner, 2026-10-25): the ask id, a one-line what, why it is his, the recommendation - in
// that order. The strip, the popup, the push and the voice all read this one shape.
const ASK = {
  id: 'Q231', session: 'manager',
  question: 'Pay the invoice or let it lapse?',
  what: 'Pay the overdue hosting invoice now or let the subscription lapse.\nOption 1 pays it, option 2 loses the account.',
  options: ['1 pay the invoice now', '2 let it lapse and lose the account'],
  recommendation: '1 - pay it now, the account stays alive',
  floor: 'money',
  why: "Paying spends the owner's money: the account could be suspended and the builds stop.",
};

test('askSummary: the four fields, in the order the owner asked for', () => {
  const s = askSummary(ASK);
  assert.equal(s.id, 'Q231');
  assert.equal(s.what, 'Pay the overdue hosting invoice now or let the subscription lapse.', 'the what is one line');
  assert.equal(s.why, "Paying spends the owner's money: the account could be suspended and the builds stop.");
  assert.match(s.rec, /^1 — pay the invoice now/);
});

test('askSummary: the question stands in when there is no what, and a missing why is not shown', () => {
  const s = askSummary({ id: 'Q9', question: 'Delete the table?', options: ['1 yes', '2 no'], recommendation: '2' });
  assert.equal(s.what, 'Delete the table?');
  assert.equal(s.why, '');
  assert.match(s.rec, /^2 — no/);
});

test('askLine: id, what, why and recommendation, in that order', () => {
  const line = askLine(ASK);
  assert.ok(line.startsWith('Q231 · Pay the overdue hosting invoice now'), line);
  assert.ok(line.indexOf('why you:') > line.indexOf('Pay the overdue'), line);
  assert.ok(line.indexOf('my view:') > line.indexOf('why you:'), line);
});
