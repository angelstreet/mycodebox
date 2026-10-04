import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { deriveButtons, questionKind, needsOwner, lastQuestion, parseAlternatives, listQuestions } from '../public/buttons.js';

const RULE = '─'.repeat(60);
const finished = (body) => [...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)), '', '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
// What the server puts in status[n].stall for the UI.
const stallOf = (cls) => ({ case: cls.case, question: cls.question, excerpt: cls.excerpt, options: cls.options || null, suggestion: cls.suggestion, forbidden: cls.forbidden, source: cls.source });
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

// Real case (task31-switch): two decisions, the second one lettered A (recommended) vs B. The
// popup must show A/B buttons (A primary), hide Claude's dim suggestion (it isn't an answer to
// the question), and listQuestions must surface both numbered decisions so the popup can render
// them all and prefix the button text with the last decision's number ("2: A").
test('real either question (task31-switch): A/B buttons, A primary (recommended), suggestion hidden', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'A', reasoning: 'matches my recommendation', confidence: 0.8, owner_needed: false } };
  const body = [
    'Open decisions:',
    '1. run_ffmpeg.sh on the other hosts: I can copy the file everywhere now without restarting anything, so every future restart is safe. Do it?',
    '2. Alert queue: A (stop queueing, my recommendation) or B (build a consumer)? I will ship it together with the lease change.',
  ];
  const d = derive('done', finished(body.join('\n')), triage, { suggestion: 'disable transcript on all hosts' });
  assert.equal(d.kind, 'either');
  const ids = d.buttons.map((b) => b.id);
  assert.ok(ids.includes('oA'), `expected an oA button, got ${ids.join(',')}`);
  assert.ok(ids.includes('oB'), `expected an oB button, got ${ids.join(',')}`);
  assert.ok(!ids.includes('sug'), `Claude's dim suggestion must NOT be an answer button here, got ${ids.join(',')}`);
  assert.ok(ids.includes('reply'));
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.primary, true, 'A is the recommended option');
  assert.equal(b.primary, undefined, 'B is not primary');
  assert.equal(a.text, 'A');
  assert.equal(b.text, 'B');
  assert.match(a.label, /^A · /);
  assert.match(b.label, /^B · /);
  assert.equal(a.ai, true, 'the AI pick is highlighted via ai:true');
  assert.equal(b.ai, undefined);
  // listQuestions on the full text surfaces both decisions.
  const qs = listQuestions(body.join('\n'));
  assert.equal(qs.length, 2);
  assert.match(qs[0], /run_ffmpeg/);
  assert.match(qs[1], /Alert queue/);
});

// Plain "X or Y?" — two phrase buttons, no primary, no suggestion.
test('plain "Shall I use X or Y?": two phrases, no primary, no suggestion', () => {
  const d = derive('done', finished('Cache design is ready.\nShall I use X or Y?'));
  assert.equal(d.kind, 'either');
  const alts = d.buttons.filter((b) => !b.reply);
  assert.equal(alts.length, 2);
  const ids = alts.map((b) => b.id);
  assert.deepEqual(ids, ['oA', 'oB']);
  assert.equal(alts[0].text, 'X');
  assert.equal(alts[1].text, 'Y');
  assert.equal(alts[0].primary, undefined);
  assert.equal(alts[1].primary, undefined);
  assert.ok(!ids.includes('sug'), 'no Claude suggestion when alts are parsed');
  assert.equal(d.buttons.at(-1).reply, true);
});

// Lettered option lines ("- A. ...", "- B. ...") in the closing text.
test('lettered option lines "- A. ... - B. ... Which?": A/B buttons, A primary when recommended', () => {
  const body = [
    'Cache design is ready.',
    '- A. Use Redis for the cache (recommended)',
    '- B. Use Postgres',
    'Which one should I pick?',
  ];
  const d = derive('done', finished(body.join('\n')));
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.ok(a && b, `expected oA and oB, got ${d.buttons.map((x) => x.id).join(',')}`);
  assert.equal(a.primary, true);
  assert.equal(b.primary, undefined);
  assert.match(a.label, /Redis/);
  assert.match(b.label, /Postgres/);
  assert.equal(a.text, 'A');
  assert.equal(b.text, 'B');
});

// Open question with Claude's dim suggestion: the suggestion button is labelled
// "Claude suggests: ...", is muted, never primary, never highlighted, and never counted as the AI pick.
test('open question with suggestion: "Claude suggests:" button, muted, non-primary', () => {
  const triage = { state: 'done', ai: { proposed_reply: '', reasoning: 'x', confidence: 0.3, owner_needed: true, owner_needed_why: 'product choice' } };
  const d = derive('done', finished('The export is done.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  const sug = d.buttons.find((b) => b.id === 'sug');
  assert.ok(sug, 'suggestion button is present for an unstructured open question');
  assert.match(sug.label, /^Claude suggests: /);
  assert.match(sug.label, /name it by date/);
  assert.equal(sug.primary, undefined, 'Claude\'s suggestion is never primary');
  assert.equal(sug.muted, true, 'Claude\'s suggestion renders muted in the popup');
  assert.equal(sug.text, 'name it by date');
  assert.equal(d.buttons.at(-1).reply, true);
});

// parseAlternatives coverage of the three accepted shapes.
test('parseAlternatives: lettered lines, inline "A (..) or B (..)", plain "X or Y?"', () => {
  assert.deepEqual(parseAlternatives('- A. Foo (recommended)\n- B. Bar'), [
    { letter: 'A', label: 'Foo (recommended)', recommended: true },
    { letter: 'B', label: 'Bar', recommended: false },
  ]);
  assert.deepEqual(parseAlternatives('Alert queue: A (stop queueing, my recommendation) or B (build a consumer)?'), [
    { letter: 'A', label: 'stop queueing, my recommendation', recommended: true },
    { letter: 'B', label: 'build a consumer', recommended: false },
  ]);
  assert.deepEqual(parseAlternatives('Shall I use X or Y?'), [
    { phrase: 'X' },
    { phrase: 'Y' },
  ]);
  assert.deepEqual(parseAlternatives('Do you want Redis or Postgres for the cache?'), [], 'trailing words on the second alt block plain parsing');
  assert.deepEqual(parseAlternatives(''), []);
  assert.deepEqual(parseAlternatives(null), []);
});

// listQuestions pulls out the numbered decisions, max 3, each ≤ 160 chars, in source order.
test('listQuestions: numbered decision lines, max 3, ≤ 160 chars, in order', () => {
  const text = [
    'Open decisions:',
    '1. run_ffmpeg on the other hosts. Do it?',
    '2. Alert queue: A or B?',
    '3. Should I switch the lease strategy?',
    '4. One more (ignored: cap is 3)',
  ].join('\n');
  const qs = listQuestions(text);
  assert.equal(qs.length, 3);
  assert.match(qs[0], /run_ffmpeg/);
  assert.match(qs[1], /Alert queue/);
  assert.match(qs[2], /lease strategy/);
  const long = listQuestions(`1. ${'x'.repeat(200)}?`);
  assert.ok(long[0].length <= 160 && long[0].endsWith('…'), 'long questions are truncated');
  assert.deepEqual(listQuestions('No numbered decisions here, just prose.'), []);
  assert.deepEqual(listQuestions(''), []);
});
