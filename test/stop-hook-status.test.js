// bug-19f86c8c: older notices asked an idle session for `STATUS: acknowledged`; the Stop hook must accept it (and every
// STATUS value AGENTS.md defines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasStatusLine } from '../claude-plugin/ghosty-reporter/hooks/report.ts';

test('Stop hook accepts acknowledged and needs-manager', () => {
  for (const l of ['STATUS: acknowledged', 'STATUS: needs-manager: merge? [1 yes]', 'STATUS: done — x · bugs: none'])
    assert.equal(hasStatusLine(`text\n${l}\n`), true, l);
  assert.equal(hasStatusLine('STATUS: maybe'), false);
  assert.equal(hasStatusLine('we acknowledged the status'), false);
});
