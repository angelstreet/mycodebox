import test from 'node:test';
import assert from 'node:assert/strict';
import { paneLinesOk, PANE_MIN_LINES, PANE_MAX_LINES } from '../pane-lines.js';

test('paneLinesOk: the dashboard asks for 1000 lines first, whatever depth the server keeps', () => {
  // bug-4f9afc93: the server runs with PANE_LINES=2000 and refused the dashboard's first request (lines=1000)
  assert.equal(PANE_MIN_LINES, 1000);
  assert.equal(PANE_MAX_LINES, 10000);
  assert.ok(paneLinesOk(1000), 'the first request of the dashboard');
  assert.ok(paneLinesOk(2000), 'the "load older" request');
  assert.ok(paneLinesOk(10000), 'the largest request');
  assert.ok(!paneLinesOk(999), 'under the floor');
  assert.ok(!paneLinesOk(10001), 'over the ceiling');
  assert.ok(!paneLinesOk(1000.5), 'not an integer');
  assert.ok(!paneLinesOk('1000'), 'a string is not a number');
  assert.ok(!paneLinesOk(NaN), 'NaN');
});
