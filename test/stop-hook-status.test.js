// bug-19f86c8c: the rules-watch notice asks an idle session for `STATUS: acknowledged`; the Stop hook must accept it (and every
// STATUS value AGENTS.md defines), or the session is sent back for following the notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasStatusLine } from '../claude-plugin/ghosty-reporter/hooks/report.ts';
import { message as rulesMessage } from '../rules-watch.js';

test('Stop hook accepts the line the rules-watch notice asks for, and needs-manager', () => {
  assert.match(rulesMessage({ hash: 'a'.repeat(40), at: 1e12, subject: 's' }), /`STATUS: acknowledged`/);
  for (const l of ['STATUS: acknowledged', 'STATUS: needs-manager: merge? [1 yes]', 'STATUS: done — x · bugs: none'])
    assert.equal(hasStatusLine(`text\n${l}\n`), true, l);
  assert.equal(hasStatusLine('STATUS: maybe'), false);
  assert.equal(hasStatusLine('we acknowledged the status'), false);
});
