import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goneCwd, projectCandidates } from '../cwd-gone.js';

test('a deleted cwd is recognised', () => {
  assert.equal(goneCwd('/home/u/ghosty-sessions-bug-drain (deleted)'), '/home/u/ghosty-sessions-bug-drain');
  assert.equal(goneCwd('/home/u/ghosty-sessions'), null);
});

test('candidates: the main checkout a worktree was named after, nearest first', () => {
  assert.deepEqual(projectCandidates('/home/u/ghosty-sessions-bug-drain', '/home/u'), ['/home/u/ghosty-sessions-bug', '/home/u/ghosty-sessions', '/home/u/ghosty']);
  assert.deepEqual(projectCandidates('/home/u/virtualpytest-tennis-analytics', '/home/u'), ['/home/u/virtualpytest-tennis', '/home/u/virtualpytest']);
  assert.deepEqual(projectCandidates('/home/u/src/app/sub', '/home/u'), ['/home/u/src/app', '/home/u/src']);
  assert.deepEqual(projectCandidates('/tmp/x-y', '/home/u'), []);
});

import { restoreGoneCwd } from '../cwd-gone.js';
test('restoreGoneCwd recreates a removed worktree at the same path from its main checkout', async () => {
  const have = new Set(['/h/repo/.git']); const calls = [];
  const out = await restoreGoneCwd('/h/repo-topic (deleted)', '/h', { exists: (p) => have.has(p), run: async (c, a) => { calls.push(a.join(' ')); if (a.includes('add')) have.add('/h/repo-topic'); }, mkdir: async () => {} });
  assert.equal(out, '/h/repo-topic');
  assert.ok(calls.some((c) => c.includes('worktree add --detach /h/repo-topic')));
});
test('restoreGoneCwd falls back to an empty folder, and never leaves $HOME', async () => {
  const have = new Set();
  assert.equal(await restoreGoneCwd('/h/solo', '/h', { exists: (p) => have.has(p), run: async () => {}, mkdir: async (p) => have.add(p) }), '/h/solo');
  assert.equal(await restoreGoneCwd('/etc/x', '/h', { exists: () => false, run: async () => {}, mkdir: async () => { throw new Error('no'); } }), null);
});
