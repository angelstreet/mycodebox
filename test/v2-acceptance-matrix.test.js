// The acceptance runner's own mapping rules (scripts/v2-acceptance.js): ids from test-name prefixes, row status.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { idsOf, classify, unmapped, ROWS, PRE_V2_FILES } from '../scripts/v2-acceptance.js';

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
  const L = { legacyFiles: ['test/push.test.js'] };
  const rows = Object.fromEntries(classify([
    r('T01: ok'), r('T02: ok'), r('T02: broken', 'fail'), r('T03: skipped', 'pass', { skip: true }),
    r('T05: ok'), r('T05: known gap', 'fail', { todo: 'defect' }), r('T06: fixed but still todo', 'pass', { todo: 'defect' }), r('T06: ok'),
    r('legacy ok', 'pass', { file: 'test/push.test.js' }), r('T16: inert'),
  ], L).map((x) => [x.id, x]));
  assert.equal(rows.T01.status, 'PASS');
  assert.equal(rows.T02.status, 'FAIL');
  assert.equal(rows.T03.status, 'FAIL', 'a skipped test is not evidence');
  assert.equal(rows.T04.status, 'FAIL', 'no test at all');
  assert.equal(rows.T05.status, 'FAIL', 'an open defect on the row');
  assert.equal(rows.T06.status, 'PASS');
  assert.equal(rows.T16.status, 'PASS');
  assert.equal(rows.T20.status, 'MANUAL', 'browser check outside node --test unless PLAYWRIGHT_CORE is set');
  const broken = Object.fromEntries(classify([r('T16: inert'), r('legacy broke', 'fail', { file: 'test/push.test.js' })], L).map((x) => [x.id, x]));
  assert.equal(broken.T16.status, 'FAIL', 'T16 also needs every pre-V2 test green');
  const mapped = Object.fromEntries(classify([r('T14: ok'), { ...r('V5 cancel kills the check', 'fail', { todo: 'defect' }), file: 'test/v2-goal-loop-verify.test.js' }]).map((x) => [x.id, x]));
  assert.equal(mapped.T14.status, 'FAIL', 'an unprefixed verifier todo mapped to the row');
});

test('m1 acceptance runner: T16 pre-V2 set is pinned to the origin/main manifest, not to whatever non-v2 files the tree has', () => {
  const r = (name, file, outcome = 'pass') => ({ name, outcome, file, todo: false, skip: false });
  const L = { legacyFiles: ['test/push.test.js', 'test/gone.test.js'] };
  const t16 = (res) => classify(res, L).find((x) => x.id === 'T16');
  const base = [r('T16: inert', 'test/v2-x.test.js'), r('a', 'test/push.test.js')];
  assert.equal(t16(base).status, 'FAIL', 'a pinned pre-V2 file with no results (deleted/renamed) is a regression');
  assert.equal(t16([...base, r('b', 'test/gone.test.js')]).status, 'PASS');
  assert.equal(t16([...base, r('b', 'test/gone.test.js'), r('new', 'test/added-later.test.js', 'fail')]).status, 'PASS', 'a non-v2 file absent from origin/main is not part of the pinned set');
  assert.ok(PRE_V2_FILES.length >= 60 && PRE_V2_FILES.every((f) => /^test\/[^/]+\.test\.js$/.test(f)) && !PRE_V2_FILES.some((f) => f.startsWith('test/v2-')));
  // Offline CI has no origin/main; where it exists the manifest must equal its test list.
  let main = null;
  try { main = execFileSync('git', ['ls-tree', '--name-only', 'origin/main', 'test/'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no remote ref */ }
  if (main) assert.deepEqual(main.split('\n').filter((f) => f.endsWith('.test.js')).sort(), PRE_V2_FILES);
  assert.ok(fs.existsSync(new URL('../scripts/pre-v2-tests.json', import.meta.url)));
});

test('m2 acceptance runner: a failure or open defect that maps to no matrix row is reported (and fails the run)', () => {
  const r = (name, outcome, extra = {}) => ({ name, outcome, file: 'test/v2-x.test.js', todo: false, skip: false, ...extra });
  assert.deepEqual(unmapped([r('T01: ok', 'pass'), r('T01: bad', 'fail')]), [], 'a row owns it: the row is FAIL');
  assert.equal(unmapped([r('no prefix', 'fail')]).length, 1);
  assert.equal(unmapped([r('T99: not a row', 'fail')]).length, 1, 'a prefix that names no real row');
  assert.equal(unmapped([r('Q9 stray defect', 'fail', { todo: 'defect' })]).length, 1, 'a failing todo with no row');
  assert.deepEqual(unmapped([r('T05: known gap', 'fail', { todo: 'defect' }), r('x', 'pass')]), []);
});
