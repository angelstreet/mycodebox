import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktrees } from '../orchestration/worktrees.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wt-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

function mkRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

// Minimal stand-in with the ARCHITECTURE section 5 shape (acquire/validate/release).
function fakeLeases() {
  const held = new Map();
  let gen = 0;
  return {
    acquire(resource, { owner, task_id }) {
      if (held.has(resource)) return { ok: false, code: 'E_HELD' };
      const lease = { resource, lease_id: `l${++gen}`, owner, task_id, token: gen };
      held.set(resource, lease);
      return { ok: true, lease };
    },
    validate(lease) { return held.get(lease.resource)?.lease_id === lease.lease_id ? { ok: true } : { ok: false, code: 'E_FENCED' }; },
    release(lease) { if (held.get(lease.resource)?.lease_id === lease.lease_id) held.delete(lease.resource); return { ok: true }; },
    held,
  };
}
function setup(name) {
  const repo = mkRepo(name);
  const leases = fakeLeases();
  const root = path.join(tmp, `${name}-wt`);
  const wt = createWorktrees({ root, repoAllowlist: [repo.dir], leases });
  return { ...repo, leases, root, wt };
}
const rejects = (p, code) => assert.rejects(p, { code });

test('T05 two tasks get two disjoint worktrees on one repo, each on its own branch', async () => {
  const s = setup('r1');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'dev-a' });
  const b = await s.wt.create({ repo: s.dir, task_id: 'task-b', base_sha: s.sha, owner: 'dev-b' });
  assert.notEqual(a.path, b.path);
  assert.ok(!b.path.startsWith(a.path + path.sep) && !a.path.startsWith(b.path + path.sep));
  assert.equal(sh(a.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'v2task/task-a');
  assert.equal(sh(b.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'v2task/task-b');
  assert.equal(a.head, s.sha);
  fs.writeFileSync(path.join(a.path, 'only-a.txt'), 'x');
  assert.ok(!fs.existsSync(path.join(b.path, 'only-a.txt')));
  assert.equal(s.wt.owner(a.path).owner, 'dev-a');
  assert.equal(s.wt.owner(b.path).owner, 'dev-b');
  assert.ok(s.leases.held.has('worktree:task-a') && s.leases.held.has('worktree:task-b'));
});

test('T05 a second owner cannot claim or remove the first owner\'s worktree', async () => {
  const s = setup('r2');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'dev-a' });
  await rejects(s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'dev-b' }), 'E_HELD');
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'dev-b' }), 'E_FOREIGN');
  assert.ok(fs.existsSync(a.path));
  const other = createWorktrees({ root: s.root, repoAllowlist: [s.dir], leases: s.leases }); // another process, same state
  await rejects(other.remove(a.path, { retain: false, owner: 'dev-b' }), 'E_FOREIGN');
  assert.ok(fs.existsSync(a.path));
  // lost lease (fenced) also blocks removal even for the right owner
  s.leases.held.clear();
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'dev-a' }), 'E_FENCED');
});

test('T05 dirty or untracked trees are never removed; retain is the default', async () => {
  const s = setup('r3');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'o' });
  assert.deepEqual(await s.wt.status(a.path), { dirty: false, untracked: false, head: s.sha });
  fs.writeFileSync(path.join(a.path, 'a.txt'), 'changed\n');
  assert.equal((await s.wt.status(a.path)).dirty, true);
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }), 'E_DIRTY');
  sh(a.path, 'checkout', '--', 'a.txt');
  fs.mkdirSync(path.join(a.path, 'sub'));
  fs.writeFileSync(path.join(a.path, 'sub', 'new.txt'), 'n');
  const st = await s.wt.status(a.path);
  assert.equal(st.untracked, true);
  assert.equal(st.dirty, false);
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }), 'E_UNTRACKED');
  assert.ok(fs.existsSync(path.join(a.path, 'sub', 'new.txt')));
  fs.rmSync(path.join(a.path, 'sub'), { recursive: true });
  assert.deepEqual(await s.wt.remove(a.path, { owner: 'o' }), { removed: false, retained: true }); // default retain
  assert.ok(fs.existsSync(a.path));
});

test('clean owned tree is removed with retain:false; lease released; branch deleted', async () => {
  const s = setup('r4');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'o' });
  assert.deepEqual(await s.wt.remove(a.path, { retain: false, owner: 'o' }), { removed: true, retained: false });
  assert.ok(!fs.existsSync(a.path));
  assert.ok(!s.leases.held.has('worktree:task-a'));
  assert.equal(sh(s.dir, 'branch', '--list', 'v2task/task-a'), '');
  const again = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'o2' }); // reusable after removal
  assert.ok(fs.existsSync(again.path));
});

test('unmerged commits block removal until merged into the target', async () => {
  const s = setup('r5');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'o' });
  fs.writeFileSync(path.join(a.path, 'feature.txt'), 'f');
  sh(a.path, 'add', '.');
  sh(a.path, 'commit', '-q', '-m', 'feature');
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }), 'E_UNMERGED');
  await rejects(s.wt.remove(a.path, { retain: false, owner: 'o', merged_into: 'main' }), 'E_UNMERGED');
  sh(s.dir, 'merge', '-q', '--ff-only', 'v2task/task-a');
  assert.equal((await s.wt.remove(a.path, { retain: false, owner: 'o', merged_into: 'main' })).removed, true);
});

test('repo allowlist, task_id, branch, sha validated', async () => {
  const s = setup('r6');
  const other = mkRepo('r6-other');
  await rejects(s.wt.create({ repo: other.dir, task_id: 't1', base_sha: other.sha }), 'E_REPO');
  await rejects(s.wt.create({ repo: path.join(tmp, 'missing'), task_id: 't1', base_sha: s.sha }), 'E_REPO');
  for (const bad of ['../x', 'a/b', '.hidden', '', 'a'.repeat(65), 'a b']) await rejects(s.wt.create({ repo: s.dir, task_id: bad, base_sha: s.sha }), 'E_INVALID');
  await rejects(s.wt.create({ repo: s.dir, task_id: 't1', base_sha: 'HEAD' }), 'E_INVALID');
  await rejects(s.wt.create({ repo: s.dir, task_id: 't1', base_sha: s.sha, branch: 'main' }), 'E_INVALID');
  await assert.rejects(s.wt.create({ repo: s.dir, task_id: 't1', base_sha: 'f'.repeat(40) })); // unknown commit
  assert.ok(!s.leases.held.has('worktree:t1'), 'lease released after failed create');
  assert.equal(fs.readdirSync(s.root).filter((x) => !x.startsWith('.')).length, 0);
});

test('paths must resolve inside root: .. and symlink escape rejected', async () => {
  const s = setup('r7');
  const a = await s.wt.create({ repo: s.dir, task_id: 'task-a', base_sha: s.sha, owner: 'o' });
  const outside = path.join(tmp, 'r7-outside');
  fs.mkdirSync(outside);
  const link = path.join(s.root, 'link');
  fs.symlinkSync(outside, link);
  for (const p of [link, path.join(a.path, '..', '..'), path.join(s.root, '..'), s.root, path.join(a.path, '..', '..', 'r7-outside'), '', path.join(s.root, 'missing')]) {
    await rejects(s.wt.status(p), 'E_PATH');
    await rejects(s.wt.remove(p, { retain: false }), 'E_PATH');
    assert.throws(() => s.wt.owner(p), { code: 'E_PATH' });
  }
  await rejects(s.wt.remove(outside, { retain: false }), 'E_PATH');
  assert.ok(fs.existsSync(outside));
  // a plain directory inside root that is not managed is foreign
  const stray = path.join(s.root, 'stray');
  fs.mkdirSync(stray);
  assert.equal(s.wt.owner(stray), null);
  await rejects(s.wt.remove(stray, { retain: false }), 'E_FOREIGN');
});
