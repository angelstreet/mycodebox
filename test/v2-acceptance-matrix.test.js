// The acceptance runner's own mapping rules (scripts/v2-acceptance.js): ids from test-name prefixes, row status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { idsOf, classify, ROWS } from '../scripts/v2-acceptance.js';

test('acceptance runner: matrix ids come only from the leading prefix of a test name', () => {
  assert.deepEqual(idsOf('T07: restart'), ['T07']);
  assert.deepEqual(idsOf('GL02/T09 failing first run'), ['GL02', 'T09']);
  assert.deepEqual(idsOf('T27 (file): lease expires'), ['T27']);
  assert.deepEqual(idsOf('T12/GL06 rate limit'), ['T12', 'GL06']);
  assert.deepEqual(idsOf('GL10/T27: stale fencing'), ['GL10', 'T27']);
  for (const n of ['verify: T07 inside', 'D-007: waiting', 'T7: short', 'T070 long', 'acceptance (GL02 unit level)', 'GLX: no']) assert.deepEqual(idsOf(n), [], n);
  assert.equal(ROWS.length, 54);
});

test('acceptance runner: PASS needs an executed passing test; failures, missing tests and mapped open defects are FAIL', () => {
  const r = (name, outcome = 'pass', extra = {}) => ({ name, outcome, file: 'test/v2-x.test.js', todo: false, skip: false, ...extra });
  const rows = Object.fromEntries(classify([
    r('T01: ok'), r('T02: ok'), r('T02: broken', 'fail'), r('T03: skipped', 'pass', { skip: true }),
    r('T05: ok'), r('T05: known gap', 'fail', { todo: 'defect' }), r('T06: fixed but still todo', 'pass', { todo: 'defect' }), r('T06: ok'),
    r('legacy ok', 'pass', { file: 'test/push.test.js' }), r('T16: inert'),
  ]).map((x) => [x.id, x]));
  assert.equal(rows.T01.status, 'PASS');
  assert.equal(rows.T02.status, 'FAIL');
  assert.equal(rows.T03.status, 'FAIL', 'a skipped test is not evidence');
  assert.equal(rows.T04.status, 'FAIL', 'no test at all');
  assert.equal(rows.T05.status, 'FAIL', 'an open defect on the row');
  assert.equal(rows.T06.status, 'PASS');
  assert.equal(rows.T16.status, 'PASS');
  assert.equal(rows.T20.status, 'MANUAL', 'browser check outside node --test unless PLAYWRIGHT_CORE is set');
  const broken = Object.fromEntries(classify([r('T16: inert'), r('legacy broke', 'fail', { file: 'test/push.test.js' })]).map((x) => [x.id, x]));
  assert.equal(broken.T16.status, 'FAIL', 'T16 also needs every pre-V2 test green');
  const mapped = Object.fromEntries(classify([r('T14: ok'), { ...r('V5 cancel kills the check', 'fail', { todo: 'defect' }), file: 'test/v2-goal-loop-verify.test.js' }]).map((x) => [x.id, x]));
  assert.equal(mapped.T14.status, 'FAIL', 'an unprefixed verifier todo mapped to the row');
});
