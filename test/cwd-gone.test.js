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
