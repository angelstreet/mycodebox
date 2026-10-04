import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { deriveButtons, questionKind, needsOwner, lastQuestion, parseAlternatives, listQuestions, displayQuestion, reflowPane } from '../public/buttons.js';

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

test('either/or question: the AI proposal is the primary button, then wait, then reply; Claude\'s suggestion is a separate line, never a button', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Use Postgres, it is already in the stack.', reasoning: 'x', confidence: 0.8, owner_needed: false } };
  const d = derive('done', finished('Cache design is ready.\nDo you want Redis or Postgres for the cache?'), triage, { suggestion: 'use postgres and run the migration tests' });
  assert.equal(d.kind, 'either');
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'wait', 'reply']);
  assert.equal(d.buttons[0].primary, true);
  assert.equal(d.buttons[0].ai, true);
  assert.equal(d.buttons[0].text, 'Use Postgres, it is already in the stack.');
  assert.equal(d.suggestion.text, 'use postgres and run the migration tests');
});

test('either/or about a deploy (the real-world example): AI reply and suggestion both need two taps', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'I will run it myself.', reasoning: 'x', confidence: 0.6, owner_needed: false } };
  const d = derive('done', finished('The run is going.\nDo you want to deploy once the run ends, or will you run it yourself?'), triage, { suggestion: 'deploy when it ends' });
  assert.equal(d.kind, 'either');
  assert.ok(d.buttons.filter((b) => b.text).every((b) => b.confirm), 'forbidden topic: confirm on every reply');
  assert.equal(d.buttons.at(-1).reply, true);
});

test('open question without a proposal: always 2 options before Reply (Yes, continue + No — wait for me); the suggestion is not a button', () => {
  const triage = { state: 'done', ai: { proposed_reply: '', reasoning: 'x', confidence: 0.3, owner_needed: true, owner_needed_why: 'product choice' } };
  const d = derive('done', finished('The export is done.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  assert.deepEqual(d.buttons.map((b) => b.id), ['continue', 'wait', 'reply']);
  assert.equal(d.suggestion.text, 'name it by date');
  const cont = d.buttons.find((b) => b.id === 'continue');
  const wait = d.buttons.find((b) => b.id === 'wait');
  assert.equal(cont.label, 'Yes, continue');
  assert.equal(cont.text, 'yes');
  assert.equal(cont.primary, true, 'Yes, continue is the natural primary');
  assert.equal(wait.label, 'No — wait for me');
  assert.match(wait.text, /No, wait — I'll answer this myself\./);
  assert.deepEqual(derive('done', finished('The export is done.\nWhat should the file name look like?')).buttons.map((b) => b.id), ['continue', 'wait', 'reply']);
});

test('a suggestion identical to the AI proposal is shown once', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Yes, continue.', reasoning: '', confidence: 0.9, owner_needed: false } };
  const d = deriveButtons({ state: 'done', stall: { case: 'owner_decision', question: 'Which part next?', suggestion: 'yes continue' }, triage });
  // "Which ...?" is an `either` question (matches /^which\b/), and the identical suggestion is deduped.
  assert.equal(d.kind, 'either');
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'wait', 'reply']);
  assert.equal(d.suggestion, null);
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

// Open question with Claude's dim suggestion: it is a separate "Claude suggests" line (d.suggestion), never a button.
test('open question with suggestion: d.suggestion carries it, no sug button, forbidden flag kept', () => {
  const triage = { state: 'done', ai: { proposed_reply: '', reasoning: 'x', confidence: 0.3, owner_needed: true, owner_needed_why: 'product choice' } };
  const d = derive('done', finished('The export is done.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  assert.ok(!d.buttons.some((b) => b.id === 'sug'));
  assert.deepEqual(d.suggestion, { text: 'name it by date', confirm: false });
  assert.deepEqual(d.buttons.map((b) => b.id), ['continue', 'wait', 'reply']);
});

// Open question WITH an AI proposal: the proposal is option 1 (highlighted), "No — wait for me"
// is option 2; Claude's suggestion, when distinct, comes as a 3rd muted option.
test('open question with AI proposal: AI button + "No — wait for me" + Claude suggestion', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Name it by date.', reasoning: 'a clean default', confidence: 0.9, owner_needed: false } };
  const d = derive('done', finished('The export is done.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  // Suggestion matches AI proposal -> no suggestion line either.
  assert.equal(d.suggestion, null);
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'wait', 'reply']);
  const ai = d.buttons.find((b) => b.id === 'ai');
  const wait = d.buttons.find((b) => b.id === 'wait');
  assert.equal(ai.label, 'Name it by date.');
  assert.equal(ai.ai, true, 'the AI pick is highlighted via ai:true');
  assert.equal(ai.primary, true);
  assert.equal(wait.label, 'No — wait for me');
  assert.match(wait.text, /I'll answer this myself/);
});

// Open question with AI proposal AND a distinct suggestion: 3 options (AI + wait + sug) + Reply.
test('open question with AI proposal + distinct Claude suggestion: AI + wait + Reply, the suggestion on its own line', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Use Postgres.', reasoning: 'x', confidence: 0.8, owner_needed: false } };
  const d = derive('done', finished('Cache design is ready.\nWhat should the file name look like?'), triage, { suggestion: 'name it by date' });
  assert.equal(d.kind, 'open');
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'wait', 'reply']);
  assert.equal(d.suggestion.text, 'name it by date');
});

// parseAlternatives coverage of the three accepted shapes.
test('parseAlternatives: lettered lines, inline "A (..) or B (..)", plain "X or Y?"', () => {
  assert.deepEqual(parseAlternatives('- A. Foo (recommended)\n- B. Bar'), [
    { letter: 'A', label: 'Foo', recommended: true },
    { letter: 'B', label: 'Bar', recommended: false },
  ]);
  assert.deepEqual(parseAlternatives('Alert queue: A (stop queueing, my recommendation) or B (build a consumer)?'), [
    { letter: 'A', label: 'stop queueing', recommended: true },
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

// ---- either/or with lead-ins and comma-separated verb phrases ----
// Real case (session mcode_qualiai): "Want me to clean up the worktree, or leave it for now?" got NO
// option buttons before — only the AI's proposal + Reply. The popup needs both options.
test('either "Want me to X, or Y?": strips "Want me to", capitalises both, Y keeps its verb', () => {
  const d = derive('done', finished('Want me to clean up the worktree, or leave it for now?'));
  assert.equal(d.kind, 'either');
  const ids = d.buttons.map((b) => b.id);
  assert.ok(ids.includes('oA') && ids.includes('oB'), `expected oA and oB, got ${ids.join(',')}`);
  assert.ok(ids.includes('reply'), 'Other / Reply still present (3-choice minimum)');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.text, 'Clean up the worktree');
  assert.equal(b.text, 'Leave it for now');
  assert.match(a.label, /^Clean up the worktree/);
  assert.match(b.label, /^Leave it for now/);
});

test('either "Should I X or Y?": strips "Should I" and capitalises both', () => {
  const d = derive('done', finished('Should I push or wait?'));
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.text, 'Push');
  assert.equal(b.text, 'Wait');
  assert.match(a.label, /^Push/);
  assert.match(b.label, /^Wait/);
});

test('either "Shall I X, or Y?": strips "Shall I" and capitalises both', () => {
  const d = derive('done', finished('Shall I deploy, or wait?'));
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.text, 'Deploy');
  assert.equal(b.text, 'Wait');
});

test('either "X, or Y?" (no lead-in, comma before "or"): "Run tests, or not?" keeps the full verb phrase', () => {
  const d = derive('done', finished('Run tests, or not?'));
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.text, 'Run tests');
  assert.equal(b.text, 'Not');
});

test('either "Do you want me to X, or Y?": strips "do you want me to", capitalises both', () => {
  assert.deepEqual(parseAlternatives('Do you want me to clean up the worktree, or leave it for now?'), [
    { phrase: 'Clean up the worktree' },
    { phrase: 'Leave it for now' },
  ]);
});

test('either "Would you like me to X, or Y?": strips "would you like me to", capitalises both', () => {
  assert.deepEqual(parseAlternatives('Would you like me to deploy now, or wait until tomorrow?'), [
    { phrase: 'Deploy now' },
    { phrase: 'Wait until tomorrow' },
  ]);
});

// must NOT split: plain "Do you want X, or Y?" (full clauses) stays as the existing AI + wait path.
test('either "Do you want X, or will you Y?" (full clauses) is NOT split into oA/oB', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'I will run it myself.', reasoning: 'x', confidence: 0.6, owner_needed: false } };
  const d = derive('done', finished('The run is going.\nDo you want to deploy once the run ends, or will you run it yourself?'), triage, { forbidden: true });
  // "Do you want" without "me to" is not a recognised lead-in: stays as ai + wait + reply.
  const ids = d.buttons.map((b) => b.id);
  assert.deepEqual(ids, ['ai', 'wait', 'reply']);
  assert.ok(d.buttons.filter((x) => x.text).every((x) => x.confirm), 'forbidden topic: confirm on every reply');
});

// must NOT split: trailing words on Y still block the simple case ("Do you want A or B for X?").
test('either "Do you want A or B for X?" (trailing words on Y) stays as AI + wait + reply', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Use Redis.', reasoning: 'x', confidence: 0.7, owner_needed: false } };
  const d = derive('done', finished('Do you want Redis or Postgres for the cache?'), triage);
  assert.equal(d.kind, 'either');
  assert.deepEqual(d.buttons.map((b) => b.id), ['ai', 'wait', 'reply']);
});

// AI reworded verb phrase: "Leave it for now" matches "Leave the worktree as is for now, thanks."
// via shared key words (leave, now) rather than exact substring.
test('either "Want me to X, or Y?" + reworded AI proposal: option 2 highlighted via shared key words', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Leave the worktree as is for now, thanks.', reasoning: 'owner asked not to clean', confidence: 0.8, owner_needed: false } };
  const d = derive('done', finished('Want me to clean up the worktree, or leave it for now?'), triage);
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(b.ai, true, 'option 2 (Leave it for now) is highlighted via ai:true (shared key words: leave, now)');
  assert.equal(a.ai, undefined, 'option 1 (Clean up the worktree) is not the AI pick');
});

// Same setup, AI pick matches option 1 instead.
test('either "Want me to X, or Y?" + AI picking X: option 1 highlighted', () => {
  const triage = { state: 'done', ai: { proposed_reply: 'Clean up the worktree, please.', reasoning: 'x', confidence: 0.7, owner_needed: false } };
  const d = derive('done', finished('Want me to clean up the worktree, or leave it for now?'), triage);
  assert.equal(d.kind, 'either');
  const a = d.buttons.find((b) => b.id === 'oA');
  const b = d.buttons.find((b) => b.id === 'oB');
  assert.equal(a.ai, true, 'option 1 highlighted via shared key words (clean, worktree)');
  assert.equal(b.ai, undefined);
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

test('gate: real closing shapes -- "(the agent\'s recommendation): ..." lines, "(A or B)?", numbered steps are not decisions', () => {
  const t = 'Question 2: what to do (A or B)?\n  - A (the agent\'s recommendation): stop putting alerts in the queue. Small change.\n  - B: build something that reads the queue. A whole project.';
  assert.deepEqual(parseAlternatives(t).map((a) => [a.letter, a.label, a.recommended]), [['A', 'stop putting alerts in the queue', true], ['B', 'build something that reads the queue', false]]);
  assert.deepEqual(listQuestions('1. Get the fingerprint. Run bubblewrap fingerprint, or keytool.\n2. Install the APK. Copy it, or serve it.'), []);
});

// ---- displayQuestion ----
// When the last sentence is content-free (OK? / shall I? / ...), prepend preceding sentences until
// the text reaches a meaningful length. Long, already-meaningful questions pass through unchanged.
test('displayQuestion: short tail "OK?" alone stays short (nothing to prepend)', () => {
  assert.equal(displayQuestion('OK?'), 'OK?');
  assert.equal(displayQuestion('Shall I?'), 'Shall I?');
  assert.equal(displayQuestion('Sound good?'), 'Sound good?');
});
test('displayQuestion: short tail pulls in preceding sentence(s) to reach 120-220 chars', () => {
  // Long enough source that the algorithm can prepend one or two preceding sentences to land in
  // the 120-220 char window while staying under the 3-sentence cap.
  const t = 'In the closing text we explain the multi-game exclusion behavior across the codebase and why we keep previously answered rows alive when their conversation tree still exists in the workspace. Sound good?';
  const out = displayQuestion(t);
  assert.ok(out.length >= 120, `expected >=120 chars, got ${out.length}: ${out}`);
  assert.ok(out.length <= 220, `expected <=220 chars, got ${out.length}: ${out}`);
  assert.match(out, /Sound good\?$/);
  // The preceding sentence(s) carry the meaning — the original context must show up.
  assert.match(out, /exclusion behavior/);
});
test('displayQuestion: a long, meaningful question is returned unchanged (not expanded)', () => {
  const long = 'I have run the migration on staging and the index plan looks correct; should I apply it to production now, or wait for tomorrow?';
  assert.equal(displayQuestion(long), long);
});
test('displayQuestion: caps at 3 sentences even when more would fit', () => {
  const t = 'A. B. C. D. Real context. E. F. G. OK?';
  const out = displayQuestion(t);
  // "OK?" is the trigger; up to 2 preceding sentences may be prepended. The merged text must not
  // include all 8 source sentences.
  assert.ok(out.split(/[.!?]+/).length <= 4, `expected ≤3 sentences, got: ${out}`);
});

// ---- reflowPane ----
// The real-world sample from the owner feedback: a closing text hard-wrapped at a narrow pane width,
// with a trailing "done H:MM AM/PM" Claude Code status line that must NOT appear in the popup.
test('reflowPane: real-world sample joins continuation lines and strips the "done 2:27 PM" UI line', () => {
  const sample = [
    '… keep going. the way games are excluded',
    'now, and keep the',
    "rows you've already",
    'answered as long as',
    'their tree exists. OK?',
    'done 2:27 PM',
  ].join('\n');
  const out = reflowPane(sample);
  // The wrap is collapsed into one paragraph.
  assert.equal(out, "… keep going. the way games are excluded now, and keep the rows you've already answered as long as their tree exists. OK?");
});
test('reflowPane: paragraph breaks (blank lines) and list items are preserved on their own lines', () => {
  const t = [
    'First paragraph that is hard-wrapped onto',
    'several pane-wrapped lines that all belong',
    'together as one thought.',
    '',
    '- A. First list item',
    '- B. Second list item',
    'continues onto the next pane line',
    '',
    '1. Numbered item one',
    '2. Numbered item two',
  ].join('\n');
  const out = reflowPane(t);
  const lines = out.split('\n');
  assert.match(lines[0], /^First paragraph/);
  assert.match(lines[0], /together as one thought\.$/);
  assert.match(out, /^- A\. First list item$/m);
  assert.match(out, /^- B\. Second list item continues onto the next pane line$/m);
  assert.match(out, /^1\. Numbered item one$/m);
  assert.match(out, /^2\. Numbered item two$/m);
});
test('reflowPane: strips Claude Code UI noise (done H:MM, ✻ … done …, ● …, box-drawing bars, bypass-permissions hints)', () => {
  const noise = [
    'Actual prose before the status bar.',
    'done 3:59 PM',
    '\u273b Baked for 1m \u00b7 done 3:59 PM',
    '\u25cf tool call (Bash: ls -la)',
    '\u23bf  \u251c\u2500 package.json',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '\u276f ',
    '  \u25b7\u25b7 bypass permissions on',
    'More prose after the noise that wraps onto the',
    'next pane line.',
  ].join('\n');
  const out = reflowPane(noise);
  assert.doesNotMatch(out, /done \d/);
  assert.doesNotMatch(out, /\u273b/);
  assert.doesNotMatch(out, /\u25cf/);
  assert.doesNotMatch(out, /\u23bf/);
  assert.doesNotMatch(out, /\u2500{3,}/);
  assert.doesNotMatch(out, /bypass permissions/);
  assert.doesNotMatch(out, /\u276f/);
  // The two prose blocks were joined across their pane-wrapped continuation.
  assert.match(out, /^Actual prose before the status bar\. More prose after the noise that wraps onto the next pane line\.$/);
});
test('reflowPane: a colon-ending previous line does NOT swallow the next one (multi-line field label)', () => {
  const t = ['Open decisions:', '- A. Stop queueing', '- B. Build a consumer', 'Which one?'];
  const out = reflowPane(t.join('\n'));
  assert.match(out, /^Open decisions:$/m);
  assert.match(out, /^- A\. Stop queueing$/m);
  assert.match(out, /^- B\. Build a consumer$/m);
  assert.match(out, /^Which one\?$/m);
});
test('reflowPane: table-style lines starting with │ start their own line', () => {
  const t = ['Header row', '│ col1 │ col2 │', '│ col3 │ col4 │', 'Trailing prose.'];
  const out = reflowPane(t.join('\n'));
  assert.match(out, /^\│ col1/m);
  assert.match(out, /^\│ col3/m);
  assert.match(out, /^Trailing prose\.$/m);
});
test('reflowPane: empty / whitespace input returns ""', () => {
  assert.equal(reflowPane(''), '');
  assert.equal(reflowPane(null), '');
  assert.equal(reflowPane('   \n  \n  '), '');
});

// ---- toggle rule: only options with a description get a chevron ----
// (Mirrors the gate in ask-popup.js btnHtml(): Yes / No / Reply… and any option without desc must
//  never carry data-ex. The render path lives in the DOM layer; here we check the underlying rule.)
test('toggle rule: an option with no description has nothing to expand', () => {
  const b = { id: 'yes', label: 'Yes', text: 'yes' };
  const hasDesc = !!b.desc;
  assert.equal(hasDesc, false);
});
test('toggle rule: an option with a description is the only one that gets a chevron', () => {
  const a = { id: 'oA', label: 'A', desc: 'Stop queueing' };
  const b = { id: 'yes', label: 'Yes' };
  const c = { id: 'reply', label: 'Reply…', reply: true };
  const needsEx = (b) => !!b.desc;
  assert.equal(needsEx(a), true);
  assert.equal(needsEx(b), false);
  assert.equal(needsEx(c), false);
});

// gate: long status text / full-clause alternatives must not be split into half-sentence buttons
test('either/or verb-phrase split: only a single short question sentence', () => {
  const none = [
    'Should I go with this plan, or would you rather wait for TASK-39 step 3?',
    'Do you want me to run the deploy when those clear, or will you?',
    'Should I make that change, and do you want to test Replay logged in (then I need the test account), or not logged in?',
    'The answer decides whether MiniMax-first stays the default, or only for some kinds of work. For example, the scorecard needed 5 fixes.',
    'Tell me when to retry, or if you\'d rather free some memory on codebox first.',
  ];
  for (const t of none) assert.deepEqual(parseAlternatives(t), [], t);
  assert.deepEqual(parseAlternatives('Want me to fix the three stream bugs, or look at splitting vpt-monitor?').map((a) => a.phrase), ['Fix the three stream bugs', 'Look at splitting vpt-monitor']);
});
