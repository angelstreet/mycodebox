// Tests for the pure answer-popup model: queue order, keep-alive across a working flicker,
// AI->button mapping for yesno/menu, no highlight on confirm/owner_needed, jev line formatting,
// and the Jev-agreement mapping the choice record signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOwnersTurn,
  stallId,
  buildQueue,
  reconcileQueue,
  markAnswered,
  mapAiToButton,
  shouldHighlight,
  jevLine,
  jevAgreesOwner,
} from '../public/ask-model.js';

// ---- isOwnersTurn / stallId ----
test('isOwnersTurn: same predicate as the NEEDS YOU strip', () => {
  assert.equal(isOwnersTurn({ state: 'waiting' }), true);
  const ask = { state: 'done', stall: { case: 'unknown', question: 'Shall I go on?' } };
  assert.equal(isOwnersTurn({ ...ask, triage: { state: 'done' } }), true);
  assert.equal(isOwnersTurn({ ...ask, triage: { state: 'pending' } }), false, 'triage still reading');
  assert.equal(isOwnersTurn(ask), false, 'no triage yet');
  assert.equal(isOwnersTurn({ state: 'done', stall: { case: 'done', question: 'all finished.' }, triage: { state: 'done' } }), false);
  assert.equal(isOwnersTurn({ state: 'working' }), false);
  assert.equal(isOwnersTurn(null), false);
});
test('stallId prefers stall.id, then triage.id', () => {
  assert.equal(stallId({ stall: { id: 's1' } }), 's1');
  assert.equal(stallId({ triage: { id: 't1' } }), 't1');
  assert.equal(stallId({ stall: { id: 's1' }, triage: { id: 't1' } }), 's1');
  assert.equal(stallId({}), null);
});

// ---- buildQueue: same set as renderAttention, P0 first ----
const W = (id, priority = 'P2', extra = {}) => ({ state: 'waiting', stall: { id }, priority, ...extra });
test('buildQueue picks waiting + triaged done-with-question sessions, P0 first, then name', () => {
  const statuses = {
    a: W('1', 'P2'), b: W('2', 'P0'), c: { state: 'working' },
    d: { state: 'done', stall: { id: '3', case: 'unknown', question: 'next?' }, priority: 'P1', triage: { state: 'done', ai: { proposed_reply: 'yes' } } },
    e: { state: 'done', stall: { case: 'done', question: 'no question here' } },
    f: W('4', 'P2'),
  };
  const sessions = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name }));
  assert.deepEqual(buildQueue(statuses, {}, sessions).map((x) => x.name), ['b', 'd', 'a', 'f']);
});
test('buildQueue: a waiting session without a stop id gets a weak id', () => {
  const q = buildQueue({ a: { state: 'waiting', waitReason: 'Allow bash?' } }, {}, [{ name: 'a' }]);
  assert.equal(q.length, 1);
  assert.equal(q[0].weak, true);
});

// ---- reconcileQueue: keep-alive across a working flicker, drop after 8 s, slide-up only for new ids ----
const S = (name) => [{ name }];
test('reconcileQueue: a 3 s working flicker never removes the item and never counts as new', () => {
  const t0 = 1_000_000;
  let r = reconcileQueue({ items: [] }, { a: W('s1', 'P0') }, S('a'), t0);
  assert.equal(r.items.length, 1); assert.equal(r.added.length, 1);
  let prev = { items: r.items, answered: r.answered };
  for (const dt of [1000, 2000, 3000]) {   // the TUI repaints: state is 'working' for 3 s (same stop id still on the status)
    r = reconcileQueue(prev, { a: { state: 'working', stall: { id: 's1' }, priority: 'P0' } }, S('a'), t0 + dt);
    assert.equal(r.items.length, 1, `kept at +${dt}`); assert.equal(r.added.length, 0);
    prev = { items: r.items, answered: r.answered };
  }
  r = reconcileQueue(prev, { a: W('s1', 'P0') }, S('a'), t0 + 4000);
  assert.equal(r.items.length, 1); assert.equal(r.added.length, 0, 'same stop id: no re-animation');
  assert.equal(r.items[0].nonEligibleSince, null);
});
test('reconcileQueue: dropped once non-eligible for >= 8 s, kept at 7.9 s', () => {
  const t0 = 1_000_000;
  let r = reconcileQueue({ items: [] }, { a: W('s1') }, S('a'), t0);
  let prev = { items: r.items, answered: r.answered };
  const working = { a: { state: 'working', stall: { id: 's1' } } };
  r = reconcileQueue(prev, working, S('a'), t0 + 100); prev = { items: r.items, answered: r.answered };   // streak starts at +100
  r = reconcileQueue(prev, working, S('a'), t0 + 100 + 7900); assert.equal(r.items.length, 1); prev = { items: r.items, answered: r.answered };
  r = reconcileQueue(prev, working, S('a'), t0 + 100 + 8000); assert.equal(r.items.length, 0);
  assert.equal(r.changed, true);
});
test('reconcileQueue: a new stop id replaces the item and is reported as added', () => {
  let r = reconcileQueue({ items: [] }, { a: W('s1') }, S('a'), 0);
  r = reconcileQueue({ items: r.items, answered: r.answered }, { a: W('s2') }, S('a'), 1000);
  assert.deepEqual(r.items.map((i) => i.id), ['s2']);
  assert.deepEqual(r.added.map((i) => i.id), ['s2']);
});
test('reconcileQueue: a different stop id while working drops the old item at once', () => {
  let r = reconcileQueue({ items: [] }, { a: W('s1') }, S('a'), 0);
  r = reconcileQueue({ items: r.items, answered: r.answered }, { a: { state: 'working', stall: { id: 's2' } } }, S('a'), 500);
  assert.equal(r.items.length, 0);
});
test('reconcileQueue: an answered item leaves and stays gone while the same stop is on screen; a send to the session answers it', () => {
  let r = reconcileQueue({ items: [] }, { a: W('s1'), b: W('s9') }, [{ name: 'a' }, { name: 'b' }], 0);
  const m = markAnswered({ items: r.items, answered: r.answered }, 'a', 10);
  assert.deepEqual(m.items.map((i) => i.name), ['b']);
  r = reconcileQueue(m, { a: W('s1'), b: W('s9') }, [{ name: 'a' }, { name: 'b' }], 2000);
  assert.deepEqual(r.items.map((i) => i.name), ['b'], 'still waiting but answered: not shown again');
  r = reconcileQueue({ items: r.items, answered: r.answered }, { a: W('s2'), b: W('s9') }, [{ name: 'a' }, { name: 'b' }], 3000);
  assert.deepEqual(r.items.map((i) => i.name).sort(), ['a', 'b'], 'a new stop id is a new item');
});
test('reconcileQueue: a weak id is upgraded in place when the real id arrives (no new item)', () => {
  const st = { state: 'waiting', waitReason: 'Allow?' };
  let r = reconcileQueue({ items: [] }, { a: st }, S('a'), 0);
  r = reconcileQueue({ items: r.items, answered: r.answered }, { a: { ...st, stall: { id: 'real' } } }, S('a'), 1000);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].id, 'real'); assert.equal(r.added.length, 0);
});

// ---- mapAiToButton: yesno / menu / either ----
test('mapAiToButton yesno: yes/ok/continue -> yes, no/stop/cancel -> no, anything else -> null', () => {
  const buttons = [{ id: 'yes' }, { id: 'no' }];
  assert.equal(mapAiToButton(buttons, 'yesno', 'Yes'), 'yes');
  assert.equal(mapAiToButton(buttons, 'yesno', 'yes, do it'), 'yes');
  assert.equal(mapAiToButton(buttons, 'yesno', 'continue'), 'yes');
  assert.equal(mapAiToButton(buttons, 'yesno', 'ok'), 'yes');
  assert.equal(mapAiToButton(buttons, 'yesno', 'No, stop'), 'no');
  assert.equal(mapAiToButton(buttons, 'yesno', 'skip'), 'no');
  assert.equal(mapAiToButton(buttons, 'yesno', 'maybe later'), null);
  assert.equal(mapAiToButton(buttons, 'yesno', ''), null);
});
test('mapAiToButton menu: matches by number prefix first, then by label text', () => {
  const buttons = [
    { id: 'o1', label: '1 · Debug APK' },
    { id: 'o2', label: '2 · Release APK' },
    { id: 'o3', label: '3 · Both' },
  ];
  assert.equal(mapAiToButton(buttons, 'menu', '2'), 'o2');
  assert.equal(mapAiToButton(buttons, 'menu', 'option 2'), 'o2');
  assert.equal(mapAiToButton(buttons, 'menu', 'Release APK'), 'o2');
  assert.equal(mapAiToButton(buttons, 'menu', 'Both'), 'o3');
  assert.equal(mapAiToButton(buttons, 'menu', 'something else'), null);
});
test('mapAiToButton either/open: matches against the AI/suggestion button text', () => {
  const buttons = [
    { id: 'ai', text: 'Yes, continue with the API change' },
    { id: 'sug', text: 'Update the API then rerun tests' },
    { id: 'reply' },
  ];
  assert.equal(mapAiToButton(buttons, 'either', 'Yes, continue with the API change'), 'ai');
  assert.equal(mapAiToButton(buttons, 'either', 'Update the API then rerun tests'), 'sug');
  assert.equal(mapAiToButton(buttons, 'either', 'some other reply'), null);
});

// ---- shouldHighlight ----
test('shouldHighlight: no highlight when the AI button has confirm or owner_needed=true', () => {
  const b = { id: 'o2', label: '2 · Deploy', confirm: false };
  assert.equal(shouldHighlight(b, null), true);
  assert.equal(shouldHighlight(b, { ai: { proposed_reply: '2', owner_needed: false } }), true);
  assert.equal(shouldHighlight({ ...b, confirm: true }, { ai: { proposed_reply: '2', owner_needed: false } }), false);
  assert.equal(shouldHighlight(b, { ai: { proposed_reply: '2', owner_needed: true } }), false);
  assert.equal(shouldHighlight({ ...b }, { ai: { proposed_reply: 'yes', forbidden: 'deploy' } }), false);
  assert.equal(shouldHighlight(null, null), false);
});

// ---- jevLine ----
test('jevLine: only options with probability > 0; renamed; empty when nothing useful', () => {
  assert.equal(jevLine(null), '');
  assert.equal(jevLine({ probabilities: {} }), '');
  assert.equal(jevLine({ probabilities: { continue: 0.6, take_recommended: 0.0 } }), 'Jev: continue 60%');
  assert.equal(jevLine({ probabilities: { continue: 0.1, take_recommended: 0.7, ask_owner: 0.2 } }),
    'Jev: continue 10% \u00b7 recommended 70% \u00b7 ask you 20%');
});

// ---- jevAgreesOwner: same mapping the choice record signs ----
test('jevAgreesOwner: continue/take_recommended agree when owner picked the highlighted/positive; ask_owner agrees when owner did NOT rubber-stamp', () => {
  // AI highlighted "yes"; owner picked "yes" -> both jev paths agree (positive answer)
  assert.equal(jevAgreesOwner('continue', 'yes', 'yes'), true);
  assert.equal(jevAgreesOwner('take_recommended', 'yes', 'yes'), true);
  // AI highlighted "o2"; owner picked the recommended option
  assert.equal(jevAgreesOwner('continue', 'o2', 'o2'), true);
  // Jev said continue but the owner picked something else -> no
  assert.equal(jevAgreesOwner('continue', 'no', 'yes'), false);
  assert.equal(jevAgreesOwner('continue', 'o1', 'o2'), false);
  // Jev said ask_owner; owner replied (not rubber-stamping) -> agree
  assert.equal(jevAgreesOwner('ask_owner', 'reply', 'yes'), true);
  // Jev said ask_owner; owner went along with the AI -> no
  assert.equal(jevAgreesOwner('ask_owner', 'yes', 'yes'), false);
  // ask_owner with no AI highlight: anything the owner picked agrees
  assert.equal(jevAgreesOwner('ask_owner', 'yes', null), true);
  // unknown / null choices -> null
  assert.equal(jevAgreesOwner(null, 'yes', 'yes'), null);
  assert.equal(jevAgreesOwner('mystery', 'yes', 'yes'), null);
});