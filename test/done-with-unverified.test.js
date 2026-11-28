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

// 2026-11-28, after the first fix went live: the session re-ended on "unverified none for the task (... deferred ... not yet fired live)".
test('done-with-unverified: "none" that goes on to name deferred or unfired work is not none', () => {
  const line = 'STATUS: done — x merged · closing review: docs updated · leftovers none · unverified none for the task (live manager restart path deferred-to-manager; the two new advisories not yet fired live, they fire on a live session over threshold) · bugs: fixed — (1) int-1';
  const r = classifyStall({ plain: pane([line]), raw: null, state: 'done' });
  assert.equal(r.case, 'needs_manager');
  assert.match(r.doneWithOpen[0], /^unverified: none for the task \(live manager restart path deferred/);
});

test('done-with-unverified: "none (checked: ...)" stays none', () => {
  const r = classifyStall({ plain: pane(['STATUS: done — x · closing review: docs none needed · leftovers none · unverified none (checked: all three live) · bugs: none']), raw: null, state: 'done' });
  assert.equal(r.case, 'done');
});

// strict none (triage YES 2026-11-28): the live hedges a word list missed
for (const v of ['none (only the PDF preview inside the sign page cannot be shown)', 'none for me (the production observation is tracked by the manager)',
  'none beyond the open Power auto-match', 'none I can act on (6 hosts unreachable)', 'none new', 'none (all three checked live)']) {
  test(`done-with-unverified: strict none: "unverified ${v}" is open`, () => {
    const r = classifyStall({ plain: pane([`STATUS: done — x · closing review: docs none needed · leftovers none · unverified ${v} · bugs: none`]), raw: null, state: 'done' });
    assert.equal(r.case, 'needs_manager');
  });
}

test('done-with-unverified: bare none variants stay none', () => {
  for (const v of ['none', 'none.', 'nothing', 'n/a', '-', 'None (Checked: live proof at 10:11 UTC)']) {
    const r = classifyStall({ plain: pane([`STATUS: done — x · closing review: docs none needed · leftovers ${v} · unverified none · bugs: none`]), raw: null, state: 'done' });
    assert.equal(r.case, 'done', v);
  }
});
