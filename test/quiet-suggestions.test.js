// Owner 2026-11-27: open and parked suggestions are a quiet chip, never a popup; answered, built and duplicate items never come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers-tmp.js';
import { createSuggestions } from '../suggestions.js';
import { isOwnersTurn } from '../public/ask-model.js';
import { parkedRowsHtml } from '../public/parked-view.js';

test('open suggestions do not make the session the owner\'s turn', () => {
  for (const state of ['done', 'waiting-no', 'idle']) assert.equal(isOwnersTurn({ state, suggestions: { state: 'open', open: 6, items: [] } }), false, state);
});

test('chip lists open items; answering removes them for good, built and duplicates never show', () => {
  const dir = tmp('quiet-');
  let l = createSuggestions({ stateDir: dir });
  l.observe('s1', ['Leftovers: none', '', 'Suggestions:', 'Worth doing:', '1. add a unit test for two catch-ups at once (the race was only covered by hand)',
    '2. rework the whole lease view as a new product page (a big redesign, value unclear)', 'Smaller:', '3. rename journal rows to shorter words',
    'Recommendation: 1. Should I do them?', '', 'STATUS: needs-manager: improvement suggestions above, nothing built - should I do 1?'].join('\n'));
  const items = () => l.chipItems().map((i) => i.n);
  assert.deepEqual(items(), [1, 2, 3]);
  l.answer('s1', { 1: 'no' });
  assert.deepEqual(items(), [2, 3]);
  l = createSuggestions({ stateDir: dir });   // a restart brings nothing back
  assert.deepEqual(l.chipItems().map((i) => i.n), [2, 3]);
  assert.match(parkedRowsHtml(l.chipItems()), /Not triaged yet/);
  assert.doesNotMatch(parkedRowsHtml(l.chipItems()), /Opus proposes/);
});
