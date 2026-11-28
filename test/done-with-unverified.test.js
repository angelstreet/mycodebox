// A STATUS done whose closing review lists unverified items or leftovers is "not fully confirmed": the session shows as needs-manager
// (the manager sends it back or accepts it as final), never as done / ready to close. 2026-11-28: token-audit-followup-20261128 said done
// with five unverified items and the manager acted on it as finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { displayState } from '../public/state.js';

const RULE = '─'.repeat(60);
const pane = (status) => ['● Verification:', '  1. pass — table merged', '', ...status, '', '✻ Worked for 4s · done 9:50 AM', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];

// The pane as tmux showed it, wrapped at 110 columns.
const WRAPPED = [
  '  STATUS: done — token audit follow-up: before/after table, subagent and manager-restart advisories, Waste and',
  '  Trending phone overflow fixed, next-3 list, owner rule text in ~/handovers · closing review: docs updated',
  '  REFERENCE (advisories section), RELEASE-NOTES, token-audit doc · leftovers none · unverified manager restart',
  '  advisory not yet fired live and manager-fresh.sh run path not exercised, coc-daily prompt generator not',
  '  reachable so nightly rule copy unconfirmed, before/after covers 5.1 h only and uses context tokens instead of',
  '  cost, manager-calls label match crude · bugs: none',
];

test('done-with-unverified: the 2026-11-28 done line is a manager item, not done', () => {
  const r = classifyStall({ plain: pane(WRAPPED), raw: null, state: 'done' });
  assert.equal(r.case, 'needs_manager');
  assert.equal(r.status, 'needs-manager');
  assert.match(r.doneWithOpen.join(' '), /^unverified: manager restart advisory not yet fired live/);
  assert.match(r.managerAsk, /^said done, not fully confirmed: unverified: manager restart/);
  assert.equal(displayState({ state: 'done', stall: r }), 'manager');
});

test('done-with-unverified: filed leftovers hold the line the same way', () => {
  const r = classifyStall({ plain: pane(['STATUS: done — x merged · goal: achieved · evidence: int-1 · closing review: docs none needed · leftovers bug-1a2b3c4d · unverified none · bugs: none']), raw: null, state: 'done' });
  assert.equal(r.case, 'needs_manager');
  assert.match(r.doneWithOpen[0], /^leftovers: bug-1a2b3c4d/);
});

test('done-with-unverified: leftovers none and unverified none stay a plain done', () => {
  const r = classifyStall({ plain: pane(['STATUS: done — x merged · goal: achieved · evidence: int-1 · closing review: docs none needed · leftovers none · unverified none · bugs: none']), raw: null, state: 'done' });
  assert.equal(r.case, 'done');
  assert.equal(r.status, 'done');
  assert.equal(r.doneWithOpen, undefined);
});

test('done-with-unverified: a done line without a closing review is left to the closing-review push', () => {
  const r = classifyStall({ plain: pane(['STATUS: done — x merged']), raw: null, state: 'done' });
  assert.equal(r.case, 'done');
});
