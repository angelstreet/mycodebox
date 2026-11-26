import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReleaseNote } from '../release-note-merge.js';

const note = (unBug, shipped = '') => `# Release Notes

## Unreleased

### Features

- **feat a** ([TASK-1](x))

### Bug fixes
${unBug}
${shipped}## build 100 — 2026-11-01

### Bug fixes
- **old** ([BUG-1](x))
`;

test('branch additions land at the top of their section; main\'s shipped sections stay byte for byte', () => {
  const base = note('- **b0** ([BUG-2](x))');
  const ours = note('- **m1** ([BUG-3](x))\n- **b0** ([BUG-2](x))');
  const theirs = note('- **mine** ([BUG-9](x))\n- **b0** ([BUG-2](x))');
  const r = mergeReleaseNote(base, ours, theirs);
  assert.equal(r.ok, true); assert.equal(r.added, 1);
  assert.match(r.text, /### Bug fixes\n- \*\*mine\*\*[^\n]*\n- \*\*m1\*\*/);
  assert.equal(r.text.slice(r.text.indexOf('## build 100')), ours.slice(ours.indexOf('## build 100')));
});

test('an entry main already promoted into a shipped build is not added again; same-id entry is not duplicated', () => {
  const base = note('- **b0** ([BUG-2](x))');
  const ours = note('', '').replace('- **old**', '- **b0** ([BUG-2](x))\n- **old**');   // main shipped BUG-2 under build 100
  const theirs = note('- **b0** ([BUG-2](x))\n- **edited** ([BUG-2](x)) and more\n- **new** ([BUG-7](x))');
  const r = mergeReleaseNote(base, ours, theirs);
  assert.equal(r.ok, true); assert.equal(r.added, 1);
  assert.match(r.text, /BUG-7/); assert.equal((r.text.match(/BUG-2/g) || []).length, 1);
});

test('a branch that edits a shipped section is returned naming the line', () => {
  const base = note('- **b0** ([BUG-2](x))');
  const theirs = base.replace('**old**', '**changed old**');
  const r = mergeReleaseNote(base, base, theirs);
  assert.equal(r.ok, false); assert.match(r.error, /shipped release-note section.*changed old/);
});

test('a new section and a notes file without Unreleased', () => {
  const base = note('- **b0** ([BUG-2](x))');
  const theirs = base.replace('### Bug fixes', '### Upgrade\n\n- **do x**\n\n### Bug fixes');
  const r = mergeReleaseNote(base, base, theirs);
  assert.equal(r.ok, true); assert.match(r.text, /### Upgrade\n\n- \*\*do x\*\*/);
  assert.equal(mergeReleaseNote('# R\n- a\n', '# R\n- b\n', '# R\n- c\n'), null);   // no Unreleased: caller falls back to the union
});

// mycodebox docs/RELEASE-NOTES.md: one flat list (2026-11-26: three returns in a row on two branches adding at the top)
const flat = (...e) => `# notes\n\nEntry form: one line.\n\n## Unreleased\n\n${e.join('\n\n')}\n`;
const merge = (b, o, t) => mergeReleaseNote(b, o, t, { flat: true });

test('flat: both new entries are kept once, the branch\'s on top, also when they cite the same TASK id', () => {
  const old = '- **old** (TASK-44)\n  continued · area: x';
  const r = merge(flat(old), flat('- **main** (TASK-44)', old), flat('- **mine** (TASK-44)\n  second line', old));
  assert.deepEqual([r.ok, r.added], [true, 1]);
  assert.equal(r.text, flat('- **mine** (TASK-44)\n  second line', '- **main** (TASK-44)', old));
});

test('flat: an entry main already has is not repeated, and an empty list takes both', () => {
  assert.equal(merge(flat('- o'), flat('- same', '- o'), flat('- same', '- o')).text, flat('- same', '- o'));
  assert.equal(merge(flat(), flat('- main'), flat('- mine')).text, flat('- mine', '- main'));
});

test('flat: anything but new whole entries is returned', () => {
  const base = flat('- one\n  more', '- two'), ours = flat('- main', '- one\n  more', '- two');
  for (const [what, theirs] of [
    ['edit', flat('- mine', '- one\n  more', '- two, edited')], ['removal', flat('- mine', '- two')], ['reorder', flat('- two', '- one\n  more')],
    ['continuation of an old entry', flat('- one\n  more\n  even more', '- two')], ['stray line', flat('loose text', '- one\n  more', '- two')],
    ['new heading', flat('### Fixes', '- one\n  more', '- two')], ['text above Unreleased', base.replace('one line.', 'two lines.')], ['heading gone', base.replace('## Unreleased', '## Next')],
  ]) {
    const r = merge(base, ours, theirs);
    assert.equal(r.ok, false, what); assert.match(r.error, /merge the target yourself/, what);
  }
});
