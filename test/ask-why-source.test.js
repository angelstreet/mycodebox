// The ask popup's "Why" section says what really happened to the AI reviewer and Jev (owner 2026-11-28: "AI not run yet / Jev not asked"
// was shown while the MiniMax fallback had run and failed), and names who made a suggestion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whyModel, shortReason, sourceLabel } from '../public/ask-model.js';
import { tmp } from './helpers-tmp.js';

test('whyModel: a suggestion carries its source', () => {
  const w = whyModel({ triage: { state: 'done', source: 'minimax-fallback', ai: { proposed_reply: 'Yes, continue.', confidence: 0.8, owner_needed: false, reasoning: 'planned' } }, stall: { jevNote: { status: 'not-needed' } } });
  assert.equal(w.ai.present, true); assert.equal(w.ai.source, 'MiniMax, free fallback'); assert.equal(w.ai.label, 'Yes, continue.');
  assert.equal(w.jev.missing, 'not needed: the rules decided');
  assert.equal(whyModel({ triage: { state: 'done', source: 'openrouter', ai: { proposed_reply: 'x', owner_needed: false } } }).ai.source, 'OpenRouter');
});

test('whyModel: a call that ran and failed says failed + a short reason, never "not run yet"', () => {
  const w = whyModel({ triage: { state: 'error', source: 'minimax-fallback', error: 'answer is not JSON' }, stall: { jevNote: { status: 'skipped', why: 'OpenRouter credit used up (402), retrying later' } } });
  assert.equal(w.ai.present, false); assert.equal(w.ai.missing, 'failed: answer was not readable (MiniMax, free fallback)');
  assert.equal(w.jev.missing, 'not asked: no OpenRouter credit');
  assert.equal(whyModel({ triage: { state: 'error', source: 'openrouter', error: 'http 402: insufficient credits' } }).ai.missing, 'failed: no OpenRouter credit (OpenRouter)');
  assert.equal(whyModel({ triage: { state: 'skipped', skipped: 'MiniMax fallback daily cap reached (300)' } }).ai.missing, 'skipped: daily cap reached');
  assert.equal(whyModel({ triage: { state: 'pending' } }).ai.missing, 'reading the stop...');
  assert.equal(whyModel({}).ai.missing, 'not run for this ask');
  assert.equal(whyModel({ stall: { jevNote: { status: 'failed', why: 'timeout after 40s' } } }).jev.missing, 'failed: timeout after 40s');
  assert.equal(whyModel({ stall: {} }).jev.missing, 'not asked', 'an older server without jevNote');
});

test('shortReason / sourceLabel', () => {
  assert.equal(shortReason(''), ''); assert.equal(sourceLabel(null), '');
  assert.equal(shortReason('fallback busy'), 'busy with another ask');
  assert.ok(shortReason('x'.repeat(100)).length <= 60);
});

test('jevNoteOf: not needed, ok with its source, skipped, failed', async () => {
  process.env.GHOSTY_STATE_DIR = tmp('why-src-');
  const { jevNoteOf } = await import('../manager.js');
  assert.deepEqual(jevNoteOf({ source: 'rule' }, null), { status: 'not-needed' });
  assert.deepEqual(jevNoteOf({ source: 'ambiguous' }, { choice: 'continue', source: 'minimax-fallback' }), { status: 'ok', source: 'minimax-fallback' });
  assert.equal(jevNoteOf({ source: 'ambiguous' }, { skipped: 'daily budget reached' }).status, 'skipped');
  assert.deepEqual(jevNoteOf({ source: 'ambiguous' }, { error: 'http 500' }), { status: 'failed', why: 'http 500' });
});
