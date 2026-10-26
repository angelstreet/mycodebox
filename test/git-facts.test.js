// Git facts for the worker auto-close (git-facts.js): the session's tree must be clean before a worker session may be closed.
// Fakes only: a fake exec that returns a promise, exactly like promisify(execFile) does.
import test from 'node:test';
import assert from 'node:assert/strict';

import { gitCleanOf } from '../git-facts.js';

// A fake exec: it resolves { stdout } like promisify(execFile). The old code read `await exec(...).stdout`,
// which is the property of the PROMISE (undefined) and threw 'Cannot read properties of undefined (reading trim)'.
const fakeExec = (answers) => async (cmd, args) => {
  const key = args.slice(1).join(' ');
  const out = Object.entries(answers).find(([k]) => key.includes(k));
  if (out?.[1] instanceof Error) throw out[1];
  return { stdout: out?.[1] ?? '', stderr: '' };
};

test('a promise has no stdout: the helper awaits the call, not the property (2026-10-26 regression)', async () => {
  const exec = fakeExec({ 'status --porcelain': '', 'rev-parse --abbrev-ref': 'main', 'rev-parse -q --verify': 'abc123', 'log --format': '' });
  assert.equal(await gitCleanOf('/tmp/wt', { exec }), true);
  // the old pattern would have thrown here, and the crash killed the whole auto-close scan
  assert.equal(exec('git', ['-C', '/tmp/wt', 'status']).stdout, undefined);   // the PROMISE has no stdout
});

test('uncommitted work in the worktree blocks the close', async () => {
  const exec = fakeExec({ 'status --porcelain': ' M server.js\n', 'rev-parse --abbrev-ref': 'main', 'rev-parse -q --verify': 'abc123' });
  assert.equal(await gitCleanOf('/tmp/wt', { exec }), false);
});

test('commits that are not on origin/main yet block the close', async () => {
  const exec = fakeExec({ 'status --porcelain': '', 'rev-parse --abbrev-ref': 'feature/x', 'rev-parse -q --verify': 'abc123', 'log --format': 'abc1234\n' });
  assert.equal(await gitCleanOf('/tmp/wt', { exec }), false);
});

test('a clean tree on main is clean; a detached HEAD and a missing origin/main never block', async () => {
  assert.equal(await gitCleanOf('/tmp/wt', { exec: fakeExec({ 'status --porcelain': '', 'rev-parse --abbrev-ref': 'main', 'rev-parse -q --verify': 'abc123', 'log --format': '' }) }), true);
  assert.equal(await gitCleanOf('/tmp/wt', { exec: fakeExec({ 'status --porcelain': '', 'rev-parse --abbrev-ref': 'HEAD' }) }), true);
  assert.equal(await gitCleanOf('/tmp/wt', { exec: fakeExec({ 'status --porcelain': '', 'rev-parse --abbrev-ref': 'main', 'rev-parse -q --verify': '' }) }), true);
});

test('a fact we cannot read never blocks a close, and no directory means clean', async () => {
  const boom = async () => { throw new Error('not a git repo'); };
  assert.equal(await gitCleanOf('/tmp/wt', { exec: boom }), true);
  assert.equal(await gitCleanOf('', { exec: boom }), true);
  assert.equal(await gitCleanOf('/tmp/wt', {}), true);
});
