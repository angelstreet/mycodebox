// Done-check (O) (owner, 2026-11-13): a done line after a code fix integration needs release-note evidence and a bug id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers-tmp.js';
import { evidenceGapOf, evidenceGapMessage, createDoneCheck } from '../done-check.js';

const RN = 'docs/release_note/README.md';
const fixInt = (over = {}) => ({ id: 'int-1', repo: 'virtualpytest', branch: 'fix/token-cap', files: ['backend/a.py'], subjects: ['fix(ai): token cap'], ...over });
const line = (docs, bugs) => `STATUS: done — merged · closing review: docs ${docs} · leftovers none · unverified none · bugs: ${bugs}`;

test('evidenceGapOf: a code fix without release-note diff or bug id is a gap; both present passes', () => {
  const g = evidenceGapOf(line('REFERENCE.md updated', 'none'), [fixInt()]);
  assert.deepEqual(g.releaseNote, ['virtualpytest']);
  assert.deepEqual(g.bug, { ids: ['int-1'] });
  assert.equal(evidenceGapOf(line('release note updated', 'fixed bug-1a2b3c4d'), [fixInt({ files: ['backend/a.py', RN] })]), null);
  assert.equal(evidenceGapOf(line('REFERENCE.md', 'none — a feature, nothing was broken'), [fixInt({ files: ['backend/a.py', RN], branch: 'feat/x', subjects: ['feat: x'] })]), null);
});

test('evidenceGapOf: words alone do not count as a release note; "none needed: <reason>" does; docs-only and non-fix pass', () => {
  assert.deepEqual(evidenceGapOf(line('release note updated', 'fixed bug-1a2b3c4d'), [fixInt()]).releaseNote, ['virtualpytest']);
  assert.equal(evidenceGapOf(line('release note none needed: internal harness change, no user-visible effect', 'fixed bug-1a2b3c4d'), [fixInt()]), null);
  assert.equal(evidenceGapOf(line('REFERENCE.md', 'none'), [fixInt({ files: ['docs/REFERENCE.md'] })]), null, 'docs-only');
  const feat = evidenceGapOf(line('REFERENCE.md', 'none'), [fixInt({ branch: 'feat/x', subjects: ['feat: x'], repo: 'mycodebox', files: ['server.js'] })]);
  assert.deepEqual(feat.releaseNote, ['mycodebox']); assert.equal(feat.bug, null, 'not a fix: bugs: none is fine');
  assert.equal(evidenceGapOf(line('x', 'none'), []), null);
  assert.equal(evidenceGapOf('STATUS: waiting: integration int-1', [fixInt()]), null);
  assert.equal(evidenceGapOf(line('release note none needed: nothing user-visible here', 'none: no bug existed, a refactor'), [fixInt({ subjects: ['fix typo'] })]), null);
});

test('evidenceGapMessage names both asks and the resolve command', () => {
  const m = evidenceGapMessage(evidenceGapOf(line('REFERENCE.md', 'none'), [fixInt()]));
  for (const re of [/release note/i, /docs\/RELEASE-NOTES\.md/, /found-bug --title/, /--resolve <id> --commit <integration id>/, /bugs: fixed <id>/]) assert.match(m, re);
});

function harness(text, ints, over = {}) {
  const dir = tmp('ghosty-evidence-'); const sent = []; const sessions = [{ name: 'a', cwd: '/w/a', text }];
  const git = async (cwd, args) => { if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); } if (args[0] === 'rev-parse' && args[2] === '--git-dir') return `/r/.git/worktrees${cwd}\n`; if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/r/.git\n'; if (args[0] === 'rev-parse') return 'main\n'; return ''; };
  const w = createDoneCheck({ stateDir: dir, git, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); }, integrationsOf: async () => ints, now: () => Date.parse('2026-11-13T08:00:00Z'), log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), ...over });
  return { w, sent, sessions };
}

test('done-check: pushed back once after a fix integration without evidence; none with both; not for non-merged work', async () => {
  const h = harness(line('REFERENCE.md updated', 'none'), [fixInt()]);
  await h.w.tick(); await h.w.tick();
  assert.equal(h.sent.length, 1); assert.match(h.sent[0][1], /release note/i); assert.match(h.sent[0][1], /bug id/);
  h.sessions[0].text = line('REFERENCE.md updated, rewritten', 'none');   // same gap, new line: not pushed again
  await h.w.tick(); assert.equal(h.sent.length, 1);
  const ok = harness(line('release note updated', 'fixed bug-1a2b3c4d'), [fixInt({ files: ['backend/a.py', RN] })]);
  await ok.w.tick(); assert.equal(ok.sent.length, 0);
  const none = harness(line('REFERENCE.md', 'none'), []);
  await none.w.tick(); assert.equal(none.sent.length, 0);
  const dry = harness(line('REFERENCE.md', 'none'), [fixInt()], { mode: () => 'dry' });
  await dry.w.tick(); assert.equal(dry.sent.length, 0);
});
