import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveButtons, parseAlternatives, reviewerOptions } from '../public/buttons.js';
import { detailsText } from '../public/ask-model.js';
import { parseReviewerAnswer, buildReviewerPrompt, REVIEWER_SYSTEM } from '../triage.js';

const TASK31 = [
  'Open decisions:',
  '- A. Stop queueing alerts (my recommendation). Remove the dead push to Redis in the monitor so nothing piles up. Needs a vpt-monitor restart everywhere.',
  '- B. Build a real consumer. A small worker reads the alert queue and sends the alerts on. More work, but alerts arrive.',
  '1. run_ffmpeg.sh on the other hosts: I can copy the file everywhere now without restarting anything. Do it?',
  '2. Alert queue: A (stop queueing, my recommendation) or B (build an AI consumer)?',
].join('\n');
const stall = { case: 'owner_decision', question: TASK31, excerpt: TASK31, options: null, forbidden: 'restart' };
const triageYours = { ai: { proposed_reply: '', owner_needed: true, confidence: 0.4, reasoning: 'x' } };

test('task31: A tagged agent-recommends, B not, neither is the AI pick, descriptions come from the agent text', () => {
  const d = deriveButtons({ state: 'waiting', stall, triage: triageYours });
  const [a, b] = d.buttons.filter((x) => /^o[AB]$/.test(x.id));
  assert.equal(a.rec, true); assert.equal(b.rec, undefined);
  assert.ok(!d.buttons.some((x) => x.ai), 'no AI pick');
  assert.match(a.desc, /^Remove the dead push to Redis/);
  assert.match(a.desc, /vpt-monitor restart everywhere\.$/);
  assert.match(b.desc, /^A small worker reads/);
  assert.ok(a.desc.length <= 200 && b.desc.length <= 200);
  assert.equal(a.label, 'A · Stop queueing alerts');
});

test('desc is capped at 200 chars and absent without a remainder', () => {
  const alts = parseAlternatives(`- A. Do the thing. ${'word '.repeat(80)}\n- B. Other`);
  assert.ok(alts[0].desc.length <= 200 && alts[0].desc.endsWith('…'));
  assert.equal(alts[1].desc, undefined);
});

test('AI option summaries fill options without an agent description; the agent text wins', () => {
  const t = '- A. Stop it. Remove the push.\n- B. Build it\nDo you want A or B?';
  const tri = { ai: { proposed_reply: '', owner_needed: true, options: [{ id: 'A', summary: 'AI says A' }, { id: 'B', summary: 'AI says B' }] } };
  const d = deriveButtons({ state: 'done', stall: { question: t }, triage: tri });
  assert.equal(d.buttons.find((x) => x.id === 'oA').desc, 'Remove the push.');
  assert.equal(d.buttons.find((x) => x.id === 'oB').desc, 'AI says B');
});

test('yes/no and menu options get AI summaries by id', () => {
  const tri = { ai: { proposed_reply: 'yes', owner_needed: false, options: [{ id: 'yes', summary: 'Carries on.' }, { id: 'no', summary: 'Stops.' }] } };
  const d = deriveButtons({ state: 'done', stall: { question: 'Shall I continue?' }, triage: tri });
  assert.equal(d.buttons.find((x) => x.id === 'yes').desc, 'Carries on.');
  assert.equal(d.buttons.find((x) => x.id === 'no').desc, 'Stops.');
  const m = deriveButtons({ state: 'waiting', stall: { question: 'Pick', options: [{ n: 1, text: 'Debug' }, { n: 2, text: 'Release', recommended: true }] }, triage: { ai: { options: [{ id: '2', summary: 'Builds release.' }] } } });
  assert.equal(m.buttons.find((x) => x.id === 'o2').desc, 'Builds release.');
  assert.equal(m.buttons.find((x) => x.id === 'o2').rec, true);
  assert.equal(m.buttons.find((x) => x.id === 'o1').desc, undefined);
});

test('reviewerOptions: ids match the buttons', () => {
  assert.deepEqual(reviewerOptions({ state: 'done', stall: { question: TASK31 } }).map((o) => o.id), ['A', 'B']);
  assert.deepEqual(reviewerOptions({ state: 'done', stall: { question: 'Shall I continue?' } }).map((o) => o.id), ['yes', 'no']);
  assert.deepEqual(reviewerOptions({ state: 'done', stall: { question: 'What next?' } }), []);
});

test('reviewer JSON: options parsed, capped, invalid dropped, absent -> no options key', () => {
  const base = { proposed_reply: '', reasoning: 'r', confidence: 0.5, owner_needed: true, owner_needed_why: 'w' };
  const ok = parseReviewerAnswer(JSON.stringify({ ...base, options: [{ id: 'A', summary: 'x'.repeat(300) }, { id: 'B', summary: 'Deploys it to prod.' }, { id: '', summary: 'no id' }, { id: 'C' }, 'junk', { id: 'A', summary: 'dup' }] })).ai;
  assert.deepEqual(ok.options.map((o) => o.id), ['A', 'B']);
  assert.equal(ok.options[0].summary.length, 160);
  assert.equal(ok.options[1].summary, 'Deploys it to prod.', 'summaries may describe deploys');
  assert.equal('options' in parseReviewerAnswer(JSON.stringify(base)).ai, false);
  assert.equal('options' in parseReviewerAnswer(JSON.stringify({ ...base, options: 'nope' })).ai, false);
  assert.equal('options' in parseReviewerAnswer(JSON.stringify({ ...base, options: [] })).ai, false);
});

test('reviewer prompt lists the options; the system prompt asks for them', () => {
  const p = buildReviewerPrompt({ session: 's', case: 'done', text: 't', options: [{ id: 'A', label: 'Stop queueing' }, { id: 'B', label: 'Build' }] });
  assert.match(p, /Options the owner can pick.*A = Stop queueing \| B = Build/);
  assert.doesNotMatch(buildReviewerPrompt({ session: 's', case: 'done', text: 't' }), /Options the owner/);
  assert.match(REVIEWER_SYSTEM, /"options"/);
});

test('details text: excerpt preferred, last 300 chars, short text whole, empty -> ""', () => {
  const long = `HEAD${'x'.repeat(400)}TAIL`;
  const t = detailsText({ excerpt: long, question: 'q' });
  assert.ok(t.startsWith('…') && t.endsWith('TAIL') && t.length <= 301);
  assert.equal(detailsText({ question: 'short one' }), 'short one');
  assert.equal(detailsText({ excerpt: 'from excerpt', question: 'q' }), 'from excerpt');
  assert.equal(detailsText(null), '');
});
