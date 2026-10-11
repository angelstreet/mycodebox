// Independent verification of v2 worktrees. Defects are marked { todo: 'defect: ...' } and assert the wanted behaviour.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktrees } from '../orchestration/worktrees.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wtverify-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

function setup(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.local\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  const held = new Map();
  let g = 0;
  const leases = {
    acquire(resource, o) { if (held.has(resource)) return { ok: false, code: 'E_HELD' }; const lease = { resource, lease_id: `l${++g}`, ...o }; held.set(resource, lease); return { ok: true, lease }; },
    validate(l) { return held.get(l.resource)?.lease_id === l.lease_id ? { ok: true } : { ok: false, code: 'E_FENCED' }; },
    release(l) { if (held.get(l.resource)?.lease_id === l.lease_id) held.delete(l.resource); return { ok: true }; },
  };
  const root = path.join(tmp, `${name}-wt`);
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD'), root, leases, wt: createWorktrees({ root, repoAllowlist: [dir], leases }) };
}
const commit = (cwd, f) => { fs.writeFileSync(path.join(cwd, f), f); sh(cwd, 'add', '.'); sh(cwd, 'commit', '-q', '-m', f); return sh(cwd, 'rev-parse', 'HEAD'); };

test('verify: task_id cannot inject options, refs or paths', async () => {
  const s = setup('inj');
  for (const bad of ['-b', '--force', 'a/../../x', '..', 'a\nb', 'x;rm', '.v2-meta']) {
    await assert.rejects(s.wt.create({ repo: s.dir, task_id: bad, base_sha: s.sha }), { code: 'E_INVALID' }, JSON.stringify(bad));
  }
});

test('verify: unmerged commits on the task branch survive a detached HEAD at base', async () => {
  const s = setup('detached');
  const a = await s.wt.create({ repo: s.dir, task_id: 'ta', base_sha: s.sha, owner: 'o' });
  const work = commit(a.path, 'work.txt');
  sh(a.path, 'checkout', '-q', '--detach', s.sha);
  await assert.rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }), { code: 'E_UNMERGED' });
  assert.notEqual(sh(s.dir, 'branch', '--contains', work), '');
});

test('verify: ignored files are not deleted silently', async () => {
  const s = setup('ignored');
  const a = await s.wt.create({ repo: s.dir, task_id: 'tb', base_sha: s.sha, owner: 'o' });
  fs.writeFileSync(path.join(a.path, 'notes.local'), 'precious');
  await assert.rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }));
  assert.ok(fs.existsSync(path.join(a.path, 'notes.local')));
});

test('verify: merged_into cannot be the task branch itself', async () => {
  const s = setup('selfmerge');
  const a = await s.wt.create({ repo: s.dir, task_id: 'td', base_sha: s.sha, owner: 'o' });
  commit(a.path, 'w.txt');
  await assert.rejects(s.wt.remove(a.path, { retain: false, owner: 'o', merged_into: 'v2task/td' }), { code: /^E_/ });
});

test('verify: tampered metadata cannot redirect branch deletion or file unlink', async () => {
  const s = setup('tamper');
  sh(s.dir, 'checkout', '-q', '-b', 'release');
  commit(s.dir, 'rel.txt');
  sh(s.dir, 'checkout', '-q', 'main');
  const c = await s.wt.create({ repo: s.dir, task_id: 'tc', base_sha: s.sha, owner: 'o' });
  const mf = path.join(fs.realpathSync(s.root), '.v2-meta', 'tc.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.branch = 'release';
  m.task_id = '../../victim';
  fs.writeFileSync(mf, JSON.stringify(m));
  const victim = path.join(tmp, 'victim.json');
  fs.writeFileSync(victim, '{}');
  await assert.rejects(s.wt.remove(c.path, { retain: false, owner: 'o' }));
  assert.notEqual(sh(s.dir, 'branch', '--list', 'release'), '');
  assert.ok(fs.existsSync(victim));
});

test('verify: omitting owner does not authorize removal of an owned tree', async () => {
  const s = setup('owner');
  const a = await s.wt.create({ repo: s.dir, task_id: 'te', base_sha: s.sha, owner: 'dev-a' });
  await assert.rejects(s.wt.remove(a.path, { retain: false }), { code: 'E_FOREIGN' });
  assert.ok(fs.existsSync(a.path));
});
