import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { parseInlineOptions, parseQuestionForm, formatMultiAnswer, parseMultiReply, deriveButtons, reflowPane, displayQuestion } from '../public/buttons.js';
import { multiFormModel, multiSendText, multiComplete, detailsText } from '../public/ask-model.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard } from '../scorecard.js';

process.env.GHOSTY_STATE_DIR = mkdtempSync(join(tmpdir(), 'ghosty-form-'));
const { logOwnerChoice } = await import('../manager.js');

// The real TASK-49 closing text (6 numbered questions, "(1) ... *(recommended)*, (2) ..., or (3) ...?").
const INTRO = 'The TASK-49 plan is written and pushed to main as `95378b1b4`. Nothing is built yet: it is waiting on your answers to 6 questions.';
const QS = [
  '1. Where are links served from: (1) each deployment\'s own server and storage *(recommended)*, (2) a central VPT service on R2, or (3) option 1 now and option 2 later?',
  '2. Expiry: (1) 7 days by default, choices from 1 hour to 30 days, no "never" *(recommended)*, (2) 30 days by default, up to 90, or (3) like option 1 plus "never" for admins?',
  '3. Password: (1) optional and off by default *(recommended)*, (2) optional and on by default, or (3) always required?',
  '4. Customer deployments: (1) allowed but off by default *(recommended)*, (2) on everywhere, or (3) never?',
  '5. Who can create a link: (1) tester and above *(recommended)*, (2) managers and admins, or (3) admins only?',
  '6. Logs and script source: (1) never included in v1 *(recommended)*, or (2) an opt-in checkbox?',
];
const TASK49 = [INTRO, '', 'Questions for you (answer with the option number):', ...QS].join('\n');
// What a 44-column tmux pane shows: hard-wrapped, continuation lines indented, the closing bullet on the first line.
const wrap = (line, w = 44) => { const out = []; let cur = ''; for (const word of line.split(' ')) { if ((cur + ' ' + word).trim().length > w) { out.push(cur); cur = word; } else cur = (cur + ' ' + word).trim(); } out.push(cur); return out; };
const pane = () => {
  const lines = [];
  for (const l of TASK49.split('\n')) { if (!l) { lines.push(''); continue; } wrap(l).forEach((x, i) => lines.push((i === 0 ? '' : '   ') + x)); }
  return ['⏺ ' + lines[0], ...lines.slice(1).map((l) => (l ? '  ' + l : l)), '', '✻ Baked for 1m · done 3:59 PM', '─'.repeat(60), '❯ 1 1 1 1 1 1 1, go ahead', '─'.repeat(60), '  ⏵⏵ bypass permissions on'];
};

test('parseInlineOptions: (1) a, (2) b or (3) c with *(recommended)* / (recommended) / my recommendation', () => {
  const r = parseInlineOptions('Where from: (1) each server *(recommended)*, (2) central, or (3) both later?');
  assert.equal(r.label, 'Where from');
  assert.deepEqual(r.options, [{ n: 1, text: 'each server', recommended: true }, { n: 2, text: 'central', recommended: false }, { n: 3, text: 'both later', recommended: false }]);
  assert.equal(parseInlineOptions('Pick: (1) a (recommended), (2) b?').options[0].recommended, true);
  assert.equal(parseInlineOptions('Pick: (1) a, (2) b, my recommendation?').options[1].recommended, true);
  assert.equal(parseInlineOptions('Do it (see (2) below)?'), null, 'numbers must run 1, 2, ...');
  assert.equal(parseInlineOptions('Only (1) one option'), null);
});

test('task49: 6 questions x options, recommended = (1) each, every option kept whole', () => {
  const form = parseQuestionForm(TASK49);
  assert.equal(form.length, 6);
  assert.deepEqual(form.map((q) => q.options.length), [3, 3, 3, 3, 3, 2]);
  for (const q of form) { assert.equal(q.options.filter((o) => o.recommended).length, 1); assert.equal(q.options.find((o) => o.recommended).n, 1); }
  assert.equal(form[0].label, 'Where are links served from');
  assert.equal(form[0].options[0].text, "each deployment's own server and storage");
  assert.equal(form[0].options[2].text, 'option 1 now and option 2 later');
  assert.equal(form[1].options[0].text, '7 days by default, choices from 1 hour to 30 days, no "never"');
  assert.equal(form[5].options[1].text, 'an opt-in checkbox');
});

test('task49 through a 44-col pane: stall.closing holds all 6 questions and the form parses them (the 16-line excerpt does not)', () => {
  const c = classifyStall({ plain: pane(), state: 'done' });
  assert.ok(c.closing.includes('6. Logs and script source') && c.closing.includes('1. Where are links'));
  assert.ok(!c.excerpt.includes('1. Where are links'), 'the 16-line excerpt only has the tail: that was the owner-reported bug');
  const m = multiFormModel({ closing: c.closing, excerpt: c.excerpt }, null);
  assert.equal(m.questions.length, 6);
  assert.deepEqual(m.questions.map((q) => q.n), ['1', '2', '3', '4', '5', '6']);
  assert.ok(m.questions.every((q) => q.label.length <= 80 && q.options.every((o) => o.short.length <= 24)));
  assert.deepEqual(Object.keys(m.aiPicks), [], 'no AI picks -> nothing highlighted');
});

test('send string "1: 1, 2: 1, ..., 6: 1"; partial form leaves unpicked out', () => {
  const m = multiFormModel({ closing: TASK49 }, null);
  const all = Object.fromEntries(m.questions.map((q) => [q.n, '1']));
  assert.equal(multiSendText(all, m), '1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1');
  assert.equal(multiComplete(all, m), true);
  const part = { 3: '2', 1: '1' };
  assert.equal(multiSendText(part, m), '1: 1, 3: 2');
  assert.equal(multiComplete(part, m), false);
  assert.equal(formatMultiAnswer({ 2: '3', 1: '1' }), '1: 1, 2: 3');
});

test('AI per-question picks: picks object or "1: 2, 2: 1" reply; invalid / owner_needed -> none', () => {
  const a = multiFormModel({ closing: TASK49 }, { ai: { picks: { 1: '1', 2: '2', 6: '9' }, confidence: 0.7 } });
  assert.deepEqual(a.aiPicks, { 1: '1', 2: '2' }, 'pick 9 is not an option of question 6');
  assert.equal(a.questions[1].options[1].ai, true);
  const b = multiFormModel({ closing: TASK49 }, { ai: { proposed_reply: '1: 1, 2: 3, 3: 1', confidence: 0.6 } });
  assert.deepEqual(b.aiPicks, { 1: '1', 2: '3', 3: '1' });
  assert.deepEqual(multiFormModel({ closing: TASK49 }, { ai: { proposed_reply: '1: 1', owner_needed: true } }).aiPicks, {});
  assert.deepEqual(parseMultiReply('1: 1, 2: 3'), { 1: '1', 2: '3' });
});

test('a single numbered question or unparsed questions are not a form', () => {
  assert.equal(multiFormModel({ closing: '1. Only one: (1) a, (2) b?' }, null), null);
  assert.equal(multiFormModel({ closing: '1. Do it?\n2. Do that?' }, null), null);
});

test('Claude\'s suggestion is never a numbered option; an answer-set suggestion is ignored', () => {
  const stall = { case: 'owner_decision', question: QS[5], excerpt: QS[5], closing: TASK49, suggestion: '1 1 1 1 1 1 1, go ahead' };
  const d = deriveButtons({ state: 'done', stall, triage: null });
  assert.equal(d.suggestion, null, 'the digits-only guess repeats an answer set');
  assert.ok(!d.buttons.some((b) => b.id === 'sug'));
  const d2 = deriveButtons({ state: 'done', stall: { ...stall, suggestion: 'run the tests first' }, triage: null });
  assert.deepEqual(d2.suggestion, { text: 'run the tests first', confirm: false });
  assert.ok(d2.buttons.every((b) => b.id !== 'sug'));
  const d3 = deriveButtons({ state: 'done', stall: { case: 'done', question: 'Shall I continue?', excerpt: 'Shall I continue?', suggestion: 'yes' }, triage: null });
  assert.equal(d3.suggestion, null, 'matches the Yes answer');
});

test('single question: always >= 3 choices (answers + Other/Reply)', () => {
  const mk = (q, extra = {}) => deriveButtons({ state: 'done', stall: { case: 'done', question: q, excerpt: q, ...extra }, triage: null });
  for (const q of ['Should I push it?', 'Redis or Postgres for the cache?', 'What should the file be called?', 'Pick: (1) fast, (2) safe, or (3) both?']) {
    const d = mk(q);
    assert.ok(d.buttons.length >= 3, `${q}: ${d.buttons.map((b) => b.id)}`);
    assert.equal(d.buttons.at(-1).reply, true);
  }
  assert.deepEqual(mk('Should I go on?').buttons.map((b) => b.id), ['yes', 'no', 'reply']);
  const num = mk('Pick: (1) fast *(recommended)*, (2) safe, or (3) both?');
  assert.equal(num.kind, 'either');
  assert.deepEqual(num.buttons.map((b) => [b.id, b.text, b.rec]), [['o1', '1', true], ['o2', '2', undefined], ['o3', '3', undefined], ['reply', undefined, undefined]]);
});

test('Details: the task49 text renders items 1-6 each on its own line, wrapped to the popup width', () => {
  const c = classifyStall({ plain: pane(), state: 'done' });
  const out = reflowPane(detailsText({ closing: c.closing }, 1800));
  const lines = out.split('\n');
  for (let i = 1; i <= 6; i++) assert.equal(lines.filter((l) => l.startsWith(`${i}. `)).length, 1, `item ${i}`);
  assert.ok(lines.filter((l) => /^\d\. /.test(l)).every((l) => l.length > 80), 'items are joined into full-width lines, not 44-col fragments');
  assert.ok(!/done 3:59/.test(out));
});

test('displayQuestion: a bare "OK?" gets its context (TASK27)', () => {
  const t = 'I will skip the games that are excluded now, and keep the rows you have already answered as long as their tree exists. OK?';
  const q = displayQuestion(reflowPane(t));
  assert.match(q, /as long as their tree exists\. OK\?$/);
  assert.ok(q.length >= 60);
});

// choice record: kind 'multi'
test('logOwnerChoice multi: per-question owner/ai picks, agreeAi all-covered, agreeAiQ per question, aiQs/agreeQs', async () => {
  const rec = await logOwnerChoice({ id: 'x1', session: 's', kind: 'multi', owner: { 1: '1', 2: '1', 3: '2' }, ai: { 1: '1', 2: '2', 3: '2' } });
  assert.equal(rec.kind, 'multi');
  assert.deepEqual(rec.owner, { 1: '1', 2: '1', 3: '2' });
  assert.deepEqual(rec.ai, { 1: '1', 2: '2', 3: '2' });
  assert.deepEqual(rec.agreeAiQ, { 1: true, 2: false, 3: true });
  assert.equal(rec.aiQs, 3); assert.equal(rec.agreeQs, 2); assert.equal(rec.agreeAi, false);
  const noAi = await logOwnerChoice({ id: 'x2', session: 's', kind: 'multi', owner: { 1: '1' }, ai: null });
  assert.equal(noAi.ai, null); assert.equal(noAi.agreeAi, null); assert.equal(noAi.aiQs, undefined);
  await assert.rejects(() => logOwnerChoice({ id: 'x3', session: 's', kind: 'multi', owner: {} }), /owner required/);
});

test('scorecard: a multi choice counts one AI vote per covered question', () => {
  const at = new Date().toISOString();
  const recs = [
    { type: 'choice', id: 'm1', at, kind: 'multi', owner: { 1: '1', 2: '1' }, ai: { 1: '1', 2: '2' }, agreeAi: false, aiQs: 2, agreeQs: 1 },
    { type: 'choice', id: 'm2', at, kind: 'multi', owner: { 1: '1' }, ai: null, agreeAi: null },
    { type: 'choice', id: 'm3', at, kind: 'yesno', owner: 'yes', ai: 'yes', agreeAi: true },
  ];
  const sc = buildScorecard({ stallRecs: recs, from: Date.now() - 86400000, to: Date.now() + 86400000 });
  assert.equal(sc.perf.agreeAiN, 3);
  assert.equal(sc.perf.agreeAi, Math.round((2 / 3) * 1000) / 1000);
});
