// 2026-11-28: 43 entries had piled up above "## Unreleased" in docs/RELEASE-NOTES.md, splitting an intro sentence. The lane
// only checks placement when a merge conflicts. npm test picks this file for a change to the note because it names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('docs/RELEASE-NOTES.md has no entry above "## Unreleased"', () => {
  const lines = readFileSync(new URL('../docs/RELEASE-NOTES.md', import.meta.url), 'utf8').split('\n');
  const at = lines.indexOf('## Unreleased');
  assert.ok(at >= 0, 'the "## Unreleased" heading is missing');
  const above = lines.slice(0, at).filter((l) => /^\s*[-*+]\s/.test(l)).map((l) => l.slice(0, 90));
  assert.deepEqual(above, [], 'move these entries under "## Unreleased"');
});
