// worktrees.renew(): a lapsed lease is re-acquired by the same owner and the meta rewritten, so remove()/renew()
// keep working; never over a live foreign holder or after another owner held it in between. Temp repos only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wtr-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (a, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }));

let n = 0;
function setup() {
  const base = path.join(TMP, `s${++n}`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  let t = Date.parse('2026-10-11T08:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(base, 'leases') }), now: clock.now });
  const wt = createWorktrees({ root: path.join(base, 'wt'), repoAllowlist: [repo], leases, git, ttl_ms: 3600_000 });
  return { repo, sha: sh(repo, 'rev-parse', 'HEAD'), leases, wt, clock };
}

test('renew re-acquires a lapsed lease for the same owner and rewrites the meta: remove() by owner works afterwards', async () => {
  const s = setup();
  const c = await s.wt.create({ repo: s.repo, task_id: 'task-1', base_sha: s.sha, owner: 'goal-loop' });
  assert.equal((await s.wt.renew(c.path, { owner: 'goal-loop' })).reacquired, false);
  s.clock.advance(2 * 3600_000);
  const r = await s.wt.renew(c.path, { owner: 'goal-loop' });
  assert.equal(r.reacquired, true);
  assert.equal(r.lease.token, c.lease.token + 1);
  assert.deepEqual(s.wt.owner(c.path).lease, r.lease, 'meta holds the new lease');
  assert.equal((await s.wt.renew(c.path, { lease: r.lease })).reacquired, false, 'the new lease proves ownership');
  assert.equal((await s.wt.remove(c.path, { owner: 'goal-loop', retain: false })).removed, true);
});

test('renew never takes the lease over a live foreign holder, nor after another owner held it in between', async () => {
  const s = setup();
  const c = await s.wt.create({ repo: s.repo, task_id: 'task-2', base_sha: s.sha, owner: 'goal-loop' });
  s.clock.advance(2 * 3600_000);
  const other = await s.leases.acquire('worktree:task-2', { owner: 'someone-else', task_id: 'x', ttl_ms: 3600_000 });
  assert.equal(other.ok, true);
  await assert.rejects(s.wt.renew(c.path, { owner: 'goal-loop' }), (e) => ['E_HELD', 'E_FENCED'].includes(e.code));
  await s.leases.release(other.lease);   // released, but it held the tree in between
  await assert.rejects(s.wt.renew(c.path, { owner: 'goal-loop' }), { code: 'E_FENCED' });
  await assert.rejects(s.wt.renew(c.path, { owner: 'intruder' }), { code: 'E_FOREIGN' });
  // an explicit owner acknowledgement re-acquires a FREE lease after the intervening holder; meta follows
  const r = await s.wt.renew(c.path, { owner: 'goal-loop', acknowledgeFence: true });
  assert.equal(r.reacquired, true);
  assert.deepEqual(s.wt.owner(c.path).lease, r.lease);

});

test('acknowledgeFence never takes a lease a foreign owner still holds', async () => {
  const s = setup();
  const c = await s.wt.create({ repo: s.repo, task_id: 'task-3', base_sha: s.sha, owner: 'goal-loop' });
  s.clock.advance(2 * 3600_000);
  assert.equal((await s.leases.acquire('worktree:task-3', { owner: 'someone-else', task_id: 'x', ttl_ms: 3600_000 })).ok, true);
  await assert.rejects(s.wt.renew(c.path, { owner: 'goal-loop', acknowledgeFence: true }), { code: 'E_HELD' });
});

test('X6 adoptOwn returns only the live lease of exactly this owner and task; renew adopts it after a crash before writeMeta', async () => {
  const s = setup();
  const c = await s.wt.create({ repo: s.repo, task_id: 'task-4', base_sha: s.sha, owner: 'goal-loop' });
  s.clock.advance(2 * 3600_000);
  // what a crash between acquire and writeMeta leaves: a live lease of the same owner+task the meta does not know
  const lost = await s.leases.acquire('worktree:task-4', { owner: 'goal-loop', task_id: 'task-4', ttl_ms: 3600_000, scope: 'worktree' });
  assert.equal(lost.ok, true);
  assert.equal((await s.leases.adoptOwn('worktree:task-4', { owner: 'someone-else', task_id: 'task-4' })).code, 'E_FENCED');
  assert.equal((await s.leases.adoptOwn('worktree:task-4', { owner: 'goal-loop', task_id: 'other' })).code, 'E_FENCED');
  assert.equal((await s.leases.adoptOwn('worktree:task-x', { owner: 'goal-loop', task_id: 'task-x' })).code, 'E_FENCED', 'never acquires a free resource');
  const r = await s.wt.renew(c.path, { owner: 'goal-loop' });
  assert.equal(r.adopted, true);
  assert.equal(r.lease.lease_id, lost.lease.lease_id);
  assert.equal(s.wt.owner(c.path).lease.lease_id, lost.lease.lease_id, 'meta follows the adopted lease');
  s.clock.advance(2 * 3600_000);
  assert.equal((await s.leases.adoptOwn('worktree:task-4', { owner: 'goal-loop', task_id: 'task-4' })).code, 'E_EXPIRED');
});

test('X7 status() reports the checked-out branch (HEAD when detached)', async () => {
  const s = setup();
  const c = await s.wt.create({ repo: s.repo, task_id: 'task-5', base_sha: s.sha, owner: 'goal-loop' });
  assert.equal((await s.wt.status(c.path)).branch, 'v2task/task-5');
  sh(c.path, 'checkout', '-q', '--detach');
  assert.equal((await s.wt.status(c.path)).branch, 'HEAD');
});
