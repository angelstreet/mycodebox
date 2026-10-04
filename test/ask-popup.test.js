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
  mapAiToButton,
  shouldHighlight,
  jevLine,
  jevAgreesOwner,
} from '../public/ask-model.js';

// ---- isOwnersTurn / stallId ----
test('isOwnersTurn: waiting + done-with-question', () => {
  assert.equal(isOwnersTurn({ state: 'waiting' }), true);
  assert.equal(isOwnersTurn({ state: 'done', question: 'ok?' }), true);
  assert.equal(isOwnersTurn({ state: 'done', question: 'I will start X' }), false);
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
test('buildQueue picks waiting/done-question sessions, P0 first, then P1/P2', () => {
  const statuses = {
    a: { state: 'waiting', stall: { id: '1' }, priority: 'P2' },
    b: { state: 'waiting', stall: { id: '2' }, priority: 'P0' },
    c: { state: 'working' },
    d: { state: 'done', question: 'next?', stall: { id: '3' }, priority: 'P1', triage: { state: 'ok', ai: { proposed_reply: 'yes' } } },
    e: { state: 'done', question: 'no question here' },
  };
  const sessions = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }];
  const q = buildQueue(statuses, {}, sessions, 1000);
  assert.deepEqual(q.map((x) => x.name), ['b', 'd', 'a']);
});

// ---- reconcileQueue: keep-alive across a working flicker, drop after 8s, slide-up on new id ----
test('reconcileQueue keeps an item across a 3 s working flicker', () => {
  const t0 = 1_000_000;
  const prev = { items: [{ name: 'a', id: 's1', key: 'a\x1fs1', priority: 'P0', lastEligibleAt: t0 }] };
  // 3 s later the session is back to waiting — same stall id
  const r = reconcileQueue(prev, { a: { state: 'waiting', stall: { id: 's1' }, priority: 'P0' } }, [{ name: 'a' }], t0 + 3000);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'a');
  assert.equal(r.changed, false);   // no re-render for the flicker
});
test('reconcileQueue drops an item whose non-eligible streak hits 8 s', () => {
  const t0 = 1_000_000;
  const prev = { items: [{ name: 'a', id: 's1', key: 'a\x1fs1', priority: 'P0', lastEligibleAt: t0, nonEligibleSince: t0 }] };
  // 7.9 s: still kept
  let r = reconcileQueue(prev, { a: { state: 'working' } }, [{ name: 'a' }], t0 + 7900);
  assert.equal(r.items.length, 1);
  assert.equal(r.changed, false);
  // 8.0 s: dropped
  r = reconcileQueue(prev, { a: { state: 'working' } }, [{ name: 'a' }], t0 + 8000);
  assert.equal(r.items.length, 0);
  assert.equal(r.changed, true);
});
test('reconcileQueue animates when a brand-new stall id appears', () => {
  const prev = { items: [{ name: 'a', id: 's1', key: 'a\x1fs1', priority: 'P0', lastEligibleAt: 0 }] };
  const r = reconcileQueue(prev, {
    a: { state: 'waiting', stall: { id: 's2' }, priority: 'P0' },
  }, [{ name: 'a' }], 1000);
  // the new id replaces the old one (different key)
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 's2');
  assert.equal(r.animate, true);
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
  // unknown / null choices -> null
  assert.equal(jevAgreesOwner(null, 'yes', 'yes'), null);
  assert.equal(jevAgreesOwner('mystery', 'yes', 'yes'), null);
});