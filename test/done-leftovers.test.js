import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftoversOf, pushableItems, createLeftovers, IDLE_MS } from '../done-leftovers.js';

const REVISE = `Shipped the reviser to main and deployed.

Left to do:
- wire the retry counter into the status page
- add the doc line to REFERENCE.md
- owner: buy the extra seat for the account

STATUS: done — ft-revise merged; open: retry counter; docs line`;

test('leftoversOf: ft-revise style closing text yields the list, split into actionable and owner-only', () => {
  const r = leftoversOf(REVISE);
  assert.ok(r.items.includes('wire the retry counter into the status page'));
  assert.ok(r.items.includes('retry counter'));
  assert.deepEqual(r.ownerOnly, ['owner: buy the extra seat for the account']);
  assert.equal(r.actionable.length, r.items.length - 1);
});

test('leftoversOf: a clean STATUS: done and non-done statuses are not leftovers', () => {
  assert.equal(leftoversOf('all merged\nSTATUS: done — branch x merged and deployed'), null);
  assert.equal(leftoversOf('Left to do:\n- a thing\nSTATUS: blocked — x'), null);
  assert.equal(leftoversOf('STATUS: done — open: none'), null);
  assert.equal(leftoversOf('The remaining time is short.\nSTATUS: done'), null);
  assert.equal(leftoversOf(''), null);
});

test('pushableItems: a done whose open items are all owner-only is not pushed', () => {
  assert.equal(pushableItems('STATUS: done — open: owner: replug the capture card; owner: pay the invoice'), null);
  assert.equal(pushableItems('STATUS: done — open: credentials for the vendor account'), null);
  assert.deepEqual(pushableItems('STATUS: done — open: write the test; owner: press the reset button'), ['write the test']);
});

test('leftoversOf: Remaining header with inline text', () => {
  assert.deepEqual(leftoversOf('Remaining: add a test; update docs\nSTATUS: done').items, ['add a test', 'update docs']);
});

function harness(rows, over = {}) {
  let t = 1e9; const events = [];
  const w = createLeftovers({ listIdle: async () => rows, record: async (e) => { events.push(e); }, now: () => t, log: { error() {} }, ...over });
  return { w, events, advance: (ms) => { t += ms; } };
}
const row = (o = {}) => ({ name: 's1', text: REVISE, idleMs: IDLE_MS + 1, ...o });

test('tick: emits one leftovers event per turn, with items, for an idle done session', async () => {
  const h = harness([row()]);
  await h.w.tick(); await h.w.tick();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].key, 's1:leftovers');
  assert.ok(h.events[0].items.length >= 2);
});

test('tick: gates (idle < 10 min, draft, paused, held, manager, working) send nothing', async () => {
  const h = harness([row({ idleMs: 1000 }), row({ name: 'd', draft: true }), row({ name: 'p', paused: true }), row({ name: 'h', held: true }), row({ name: 'm', manager: true }), row({ name: 'w', working: true })]);
  await h.w.tick();
  assert.equal(h.events.length, 0);
});

test('tick: a new turn re-fires, capped at 4 events per hour per session', async () => {
  const rows = [row()];
  const h = harness(rows);
  for (let i = 0; i < 6; i++) { rows[0] = row({ turnAt: i }); await h.w.tick(); }
  assert.equal(h.events.length, 4);
  h.advance(3600 * 1000 + 1);
  rows[0] = row({ turnAt: 99 }); await h.w.tick();
  assert.equal(h.events.length, 5);
});

test('tick: mode off sends nothing', async () => {
  const h = harness([row()], { mode: () => 'off' });
  await h.w.tick();
  assert.equal(h.events.length, 0);
});
