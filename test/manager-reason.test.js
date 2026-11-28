// The board shows why a session is needs-manager (triage YES 2026-11-28: the state frame dropped managerAsk, so the card only said "manager").
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { managerReasonOf } from '../public/state.js';

const RULE = '─'.repeat(60);
const pane = (s) => ['● Verification:', '  1. pass — x', '', s, '', '✻ Worked for 4s', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];

test('managerReasonOf: a needs-manager stall shows its ask', () => {
  const st = classifyStall({ plain: pane('STATUS: done — x · closing review: docs none needed · leftovers none · unverified live path not run · bugs: none'), raw: null, state: 'done' });
  assert.equal(st.case, 'needs_manager');
  const r = managerReasonOf({ state: 'done', stall: { case: st.case, status: st.status, managerAsk: st.managerAsk } });
  assert.match(r, /^needs the manager: said done, not fully confirmed: unverified: live path not run/);
});

test('managerReasonOf: no manager state or no ask -> empty', () => {
  assert.equal(managerReasonOf(null), '');
  assert.equal(managerReasonOf({ state: 'working' }), '');
  assert.equal(managerReasonOf({ state: 'done', stall: { case: 'done', status: 'done', managerAsk: 'x' } }), '');
  assert.equal(managerReasonOf({ state: 'done', stall: { case: 'needs_manager', status: 'needs-manager', managerAsk: '' } }), '');
});
