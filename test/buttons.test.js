import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { deriveButtons, questionKind, needsOwner, lastQuestion } from '../public/buttons.js';

const RULE = '─'.repeat(60);
const finished = (body) => [...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)), '', '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
// What the server puts in status[n].stall for the UI.
const stallOf = (cls) => ({ case: cls.case, question: cls.question, options: cls.options || null, suggestion: cls.suggestion, forbidden: cls.forbidden, source: cls.source });
const derive = (state, plain, triage = null, extra = {}) => { const c = classifyStall({ plain, state }); return deriveButtons({ state, stall: { ...stallOf(c), ...extra }, triage }); };

test('live numbered menu: one button per option with its label, its number as the key, esc secondary', () => {
  const d = derive('waiting', ['Which approach should I take?', '❯ 1. Use Redis for the cache (recommended)', '  2. Use Postgres', '  3. Skip the cache entirely and keep the current in-memory implementation', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  assert.equal(d.kind, 'menu');
  assert.deepEqual(d.buttons.map((b) => b.key), ['1', '2', '3']);
  assert.match(d.buttons[0].label, /^1 · Use Redis/);
  assert.equal(d.buttons[0].primary, true);
  assert.equal(d.buttons[1].primary, false);
  assert.ok(d.buttons[2].label.length <= 36 && d.buttons[2].label.endsWith('…'), 'long labels are truncated');
  assert.equal(d.esc, true);
  assert.ok(d.keys.some((k) => k.key === 'Escape'), 'raw keys stay available');
  assert.ok(d.buttons.every((b) => !b.confirm));
});

test('permission prompt is a menu too; a forbidden topic makes every key need a confirm', () => {
  const d = derive('waiting', ['Run this command? deploy the frontend to production', '❯ 1. Yes', "  2. Yes, and don't ask again", '  3. No', 'Esc to cancel']);
  assert.equal(d.kind, 'menu');
  assert.deepEqual(d.buttons.map((b) => b.key), ['1', '2', '3']);
  assert.ok(d.buttons.every((b) => b.confirm), 'deploy topic: two taps');
});

test('yes/no question: Yes / No send text replies', () => {
  const d = derive('done', finished('Both fixes are in.\nDo you want me to add a regression test for the second one?'));
  assert.equal(d.kind, 'yesno');
  assert.deepEqual(d.buttons.slice(0, 2).map((b) => [b.label, b.text]), [['Yes', 'yes'], ['No', 'no']]);
  assert.equal(d.buttons[0].confirm, false);
  assert.equal(d.buttons.at(-1).reply, true);
  assert.equal(d.esc, false);
});

test('yes/no on a forbidden topic: Yes needs a confirm, No does not', () => {
  const d = derive('done', finished('Branch is ready.\nShould I push it to main now?'));
  assert.equal(d.kind, 'yesno');
  assert.equal(d.buttons[0].confirm, true);
  assert.equal(d.buttons[1].confirm, undefined);
});

test('either/or question: the AI proposal is the primary button, then Claude\'s suggestion, then reply', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Use Postgres, it is already in the stack.', reasoning: 'x', confidence: 0.8, owner_needed: false } };
  const d = derive('done', finished('Cache design is ready.\nDo you want Redis or Postgres for the cache?'), triage, { suggestion: 'use postgres and run the migration tests' });
  assert.equal(d.kind, 'either');
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'sug', 'reply']);
  assert.equal(d.buttons[0].primary, true);
  assert.equal(d.buttons[0].ai, true);
  assert.equal(d.buttons[0].text, 'Use Postgres, it is already in the stack.');
  assert.equal(d.buttons[1].text, 'use postgres and run the migration tests');
});

test('either/or about a deploy (the real-world example): AI reply and suggestion both need two taps', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'I will run it myself.', reasoning: 'x', confidence: 0.6, owner_needed: false } };
  const d = derive('done', finished('The run is going.\nDo you want to deploy once the run ends, or will you run it yourself?'), triage, { suggestion: 'deploy when it ends' });
  assert.equal(d.kind, 'either');
  assert.ok(d.buttons.filter((b) => b.text).every((b) => b.confirm), 'forbidden topic: confirm on every reply');
  assert.equal(d.buttons.at(-1).reply, true);
});

test('open question without a proposal: suggestion and reply only; the AI button is absent when it needs the owner', () => {
  const triage = { state: 'done', ai: { proposed_reply: '', reasoning: 'x', confidence: 0.3, owner_needed: true, owner_needed_why: 'product choice' } };
  const d = derive('done', finished('The export is done.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  assert.deepEqual(d.buttons.map((b) => b.id), ['sug', 'reply']);
  assert.deepEqual(derive('done', finished('The export is done.\nWhat should the file name look like?')).buttons.map((b) => b.id), ['reply']);
});

test('a suggestion identical to the AI proposal is shown once', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Yes, continue.', reasoning: '', confidence: 0.9, owner_needed: false } };
  const d = deriveButtons({ state: 'done', stall: { case: 'owner_decision', question: 'Which part next?', suggestion: 'yes continue' }, triage });
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'reply']);
});

test('questionKind / lastQuestion / needsOwner', () => {
  assert.equal(lastQuestion('All green. Ready to go? Tell me which.'), 'Ready to go?');
  assert.equal(questionKind({ state: 'done', stall: { question: 'Should I continue?' } }), 'yesno');
  assert.equal(questionKind({ state: 'done', stall: { question: 'Should I continue or stop here?' } }), 'either');
  assert.equal(questionKind({ state: 'waiting', stall: { question: 'Pick', options: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }] } }), 'menu');
  assert.equal(needsOwner({ stall: { case: 'done', question: 'finished.' } }), false);
  assert.equal(needsOwner({ stall: { case: 'done', question: 'what next?' } }), true);
  assert.equal(needsOwner({ stall: { case: 'background_wait', question: 'x?' } }), false);
  assert.equal(needsOwner({ stall: { case: 'owner_decision', question: 'x' }, auto: { sendAt: 1 } }), false, 'a pending auto answer is not an owner stop');
  assert.equal(needsOwner({ stall: null }), false);
});
