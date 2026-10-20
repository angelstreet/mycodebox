import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/full-suite-check.js';

test('green suite: no findings', () => {
  const r = summarize('ℹ tests 10\nℹ pass 10\nℹ fail 0\n', 0, 'abc12345');
  assert.deepEqual(r.findings, []);
  assert.match(r.summary, /10 of 10 passed/);
});

test('red suite: one high finding naming the failing tests once', () => {
  const out = '✖ a breaks (1.2ms)\n✖ test/x.test.js (300001ms)\nℹ tests 10\nℹ pass 8\nℹ fail 2\n✖ failing tests:\n✖ a breaks (1.2ms)\n';
  const r = summarize(out, 1, 'abc12345');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].key, 'full-suite:red');
  assert.match(r.findings[0].title, /2 failing/);
  assert.match(r.report, /- a breaks\n- test\/x\.test\.js/);
  assert.doesNotMatch(r.report, /failing tests:/);
});
