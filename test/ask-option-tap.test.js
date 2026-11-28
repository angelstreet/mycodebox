// The options in the strip's question list are buttons (owner, 2026-11-28). A tiny fake DOM: no browser, synthetic wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askOptionButtonsHtml, wireAskOptions, answerTarget } from '../public/manager-ask.js';
import { ownerAnswerOf } from '../owner-asks.js';

const Q = (n, o = {}) => ({ id: `Q${n}`, session: 'worker', options: ['1 Done', '2 Not now'], recommendation: '1', ...o });
const el = (extra = {}) => ({ dataset: {}, disabled: false, textContent: '', className: '', attrs: {}, classes: new Set(),
  classList: null, setAttribute(k, v) { this.attrs[k] = v; }, ...extra });
const button = (i) => { const b = el({ dataset: { opt: String(i) } }); b.classList = { add: (c) => b.classes.add(c), remove: (c) => b.classes.delete(c) }; return b; };
const page = (asks) => {
  const rows = asks.map((a) => { const buttons = [button(0), button(1)], note = el(); return { dataset: { ask: a.id }, buttons, note, querySelectorAll: () => buttons, querySelector: () => note }; });
  return { rows, querySelectorAll: () => rows };
};
const tap = (b) => b.onclick({ stopPropagation() {} });

test('options render as buttons; the recommended and the sent one are marked, and a sent row is disabled', () => {
  const h = askOptionButtonsHtml(Q(1, { options: ['1 <b>', '2 no'] }));
  assert.equal(h.match(/<button type="button"/g).length, 2);
  assert.match(h, /class="qopt rec"[^>]*>1\. &lt;b&gt;</);
  assert.doesNotMatch(h, /disabled/);
  const sent = askOptionButtonsHtml(Q(1), '2');
  assert.match(sent, /class="qopt picked"[^>]*aria-pressed="true" disabled>2\. Not now/);
  assert.match(sent, /Sent: option 2/);
  assert.equal(askOptionButtonsHtml({ id: 'Q2' }), '');
});

test('answerTarget: the ask\'s running session, else the manager, else nobody', () => {
  assert.equal(answerTarget(Q(1), { worker: {}, manager: {} }), 'worker');
  assert.equal(answerTarget(Q(1), { manager: {} }), 'manager');
  assert.equal(answerTarget(Q(1), {}), null);
});

test('each row sends its own answer once, in the wording that closes the ask', async () => {
  const asks = [Q(1), Q(2)], root = page(asks), calls = [], sent = new Map();
  wireAskOptions(root, asks, { statuses: () => ({ manager: {} }), sent, send: async (n, t) => { calls.push([n, t]); } });
  await tap(root.rows[1].buttons[1]);
  await tap(root.rows[1].buttons[0]);   // the row already has its answer
  await tap(root.rows[0].buttons[0]);
  assert.deepEqual(calls.map(([n, t]) => [n, ownerAnswerOf(t)]), [['manager', { id: 'Q2', option: '2', label: 'Not now' }], ['manager', { id: 'Q1', option: '1', label: 'Done' }]]);
  assert.equal(root.rows[1].note.textContent, 'Sent: option 2');
  assert.ok(root.rows[1].buttons[1].classes.has('picked'));
  assert.ok(root.rows[1].buttons.every((b) => b.disabled));
  assert.deepEqual([...sent], [['Q2', '2'], ['Q1', '1']]);
});

test('a failed send says so and takes another tap; no running manager sends nothing', async () => {
  const asks = [Q(1)], root = page(asks), sent = new Map(); let fail = true, calls = 0, statuses = { manager: {} };
  wireAskOptions(root, asks, { statuses: () => statuses, sent, send: async () => { calls++; if (fail) throw new Error('HTTP 500'); } });
  const [row] = root.rows;
  await tap(row.buttons[0]);
  assert.match(row.note.textContent, /^Not sent: HTTP 500/);
  assert.ok(row.buttons.every((b) => !b.disabled) && !row.buttons[0].classes.has('picked') && !sent.size);
  statuses = {};
  await tap(row.buttons[0]);
  assert.match(row.note.textContent, /manager session is not running/);
  assert.equal(calls, 1);
  statuses = { manager: {} }; fail = false;
  await tap(row.buttons[0]);
  assert.equal(row.note.textContent, 'Sent: option 1');
});

test('static: the strip list uses the buttons and has its own popup id', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /askOptionButtonsHtml\(q, /);
  assert.match(app, /wireAskOptions\(pop, qs, /);
  assert.match(app, /pop\.id = 'askListPop'/);
});
