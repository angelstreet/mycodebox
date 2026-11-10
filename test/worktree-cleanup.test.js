// Worktree cleanup after a merge (worktree-cleanup.js + the lane hook). Real throwaway git repos; fake sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupWorktree } from '../worktree-cleanup.js';
import { createIntegrationLane, createDefaultGit } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { git, commit } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

const dg = createDefaultGit();
// A world whose branch `feat` is pushed AND merged into the remote main, with a linked worktree of the dev clone on it.
function merged(extra = {}) {
  const w = makeWorld();
  const wt = path.join(tmp('wt-'), 'feat-wt');
  git(w.dev, 'checkout', '-q', '-B', 'feat', 'origin/main');
  commit(w.dev, { 'a.js': '1\n' }, 'work');
  git(w.dev, 'push', '-q', '-f', 'origin', 'feat');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'worktree', 'add', '-q', wt, 'feat');
  git(w.dev, 'merge', '-q', '--ff-only', 'feat'); git(w.dev, 'push', '-q', 'origin', 'main');
  git(w.lane, 'fetch', '-q', 'origin');
  const args = { worktree: wt, branch: 'feat', session: 's1', target: 'main', remote: 'origin', laneClone: w.lane, git: dg, ...extra };
  return { w, wt, args };
}

test('a merged, clean, unused worktree is removed with its local branch', async () => {
  const { w, wt, args } = merged();
  const r = await cleanupWorktree(args);
  assert.equal(r.removed, true, r.reason); assert.equal(r.branchDeleted, true);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(w.dev, 'branch', '--list', 'feat').trim(), '');
});

test('node_modules (ignored) does not block the removal', async () => {
  const { w, wt, args } = merged();
  fs.writeFileSync(path.join(w.dev, '.gitignore'), 'node_modules/\n'); // untracked in dev, not in wt: use info/exclude instead
  fs.rmSync(path.join(w.dev, '.gitignore'));
  const ex = path.join(git(wt, 'rev-parse', '--git-common-dir').trim(), 'info'); fs.mkdirSync(ex, { recursive: true });
  fs.appendFileSync(path.join(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir').trim()), 'info', 'exclude'), 'node_modules/\n');
  fs.mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(wt, 'node_modules', 'x', 'i.js'), '1');
  assert.equal((await cleanupWorktree(args)).removed, true);
});

test('python and tool caches (ignored, any depth) do not block the removal', async () => {
  const { wt, args } = merged();
  const ex = path.join(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir').trim()), 'info', 'exclude');
  fs.appendFileSync(ex, '__pycache__/\n.pytest_cache/\n');
  fs.mkdirSync(path.join(wt, 'pkg', '__pycache__'), { recursive: true }); fs.writeFileSync(path.join(wt, 'pkg', '__pycache__', 'm.pyc'), '1');
  fs.mkdirSync(path.join(wt, '.pytest_cache')); fs.writeFileSync(path.join(wt, '.pytest_cache', '.gitignore'), '*');
  assert.equal((await cleanupWorktree(args)).removed, true);
});

test('guard: a dirty worktree is left', async () => {
  const { wt, args } = merged(); fs.writeFileSync(path.join(wt, 'wip.txt'), 'x');
  const r = await cleanupWorktree(args);
  assert.equal(r.removed, false); assert.match(r.reason, /dirty/); assert.ok(fs.existsSync(wt));
});

test('guard: an ignored file that is not node_modules is left', async () => {
  const { w, wt, args } = merged();
  fs.appendFileSync(path.join(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir').trim()), 'info', 'exclude'), 'keystore.jks\n');
  fs.writeFileSync(path.join(wt, 'keystore.jks'), 'k');
  const r = await cleanupWorktree(args); assert.equal(r.removed, false); assert.match(r.reason, /ignored file/);
});

test('guard: a live tmux session with the worktree (or a subdirectory) as cwd leaves it', async () => {
  const { wt, args } = merged(); fs.mkdirSync(path.join(wt, 'sub'));
  const r = await cleanupWorktree({ ...args, liveCwds: async () => ['/elsewhere', path.join(wt, 'sub')] });
  assert.equal(r.removed, false); assert.match(r.reason, /tmux/); assert.ok(fs.existsSync(wt));
});

test('guard: a lease held by the requesting session leaves it', async () => {
  const { wt, args } = merged();
  const r = await cleanupWorktree({ ...args, leaseHeld: async (s) => s === 's1' });
  assert.equal(r.removed, false); assert.match(r.reason, /lease/); assert.ok(fs.existsSync(wt));
});

test('guard: an unknown session (leases cannot be checked) leaves it', async () => {
  const { args } = merged(); const r = await cleanupWorktree({ ...args, session: null });
  assert.equal(r.removed, false); assert.match(r.reason, /session unknown/);
});

test('guard: the live checkout is never removed (given path, primary checkout, or a parent of it)', async () => {
  const { w, wt, args } = merged();
  assert.match((await cleanupWorktree({ ...args, liveCheckouts: [wt] })).reason, /live checkout/);
  assert.match((await cleanupWorktree({ ...args, liveCheckouts: [path.join(wt, 'inner')] })).reason, /live checkout/);
  git(w.dev, 'worktree', 'remove', '--force', wt);
  git(w.dev, 'branch', '-D', 'feat');
  // the primary checkout of a repo (not a linked worktree) is refused even when it was not listed as live
  git(w.dev, 'checkout', '-q', '-b', 'feat');   // (worktree removed first so the name is free)
  const p = await cleanupWorktree({ ...args, worktree: w.dev });
  assert.equal(p.removed, false); assert.match(p.reason, /primary checkout/); assert.ok(fs.existsSync(w.dev));
  git(w.dev, 'checkout', '-q', 'main');
});

test('guard: unpushed / unmerged commits leave it', async () => {
  const { wt, args } = merged();
  commit(wt, { 'late.js': '1\n' }, 'late local commit');              // not pushed, not merged
  const r = await cleanupWorktree(args);
  assert.equal(r.removed, false); assert.match(r.reason, /unpushed or unmerged|not seen/); assert.ok(fs.existsSync(wt));
  // pushed to the branch but never merged into the target
  git(wt, 'push', '-q', 'origin', 'feat'); git(args.laneClone, 'fetch', '-q', 'origin');
  const r2 = await cleanupWorktree(args);
  assert.equal(r2.removed, false); assert.match(r2.reason, /unmerged/);
});

test('guard: a different branch checked out, or a detached HEAD, leaves it', async () => {
  const { wt, args } = merged(); git(wt, 'checkout', '-q', '--detach');
  assert.match((await cleanupWorktree(args)).reason, /detached HEAD/);
});

test('a missing worktree path is a no-op', async () => {
  const { args } = merged(); assert.match((await cleanupWorktree({ ...args, worktree: '/nonexistent/x' })).reason, /gone/);
});

// ---- the lane hook ----
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function laneRun(w, wt, o = {}) {
  const stateDir = tmp('lane-wtc-');
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg() } }, pollMs: 5, sleep: () => tick(1), ...o });
  lane.start();
  const { id } = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', worktree: wt });
  const end = Date.now() + 8000;
  while (Date.now() < end && !['merged', 'deployed'].includes(lane.get(id).state)) await tick(5);
  await lane.idle();
  const r = lane.get(id); lane.stop();
  return { r, stateDir };
}
function unmergedWorld() {
  const w = makeWorld(); const wt = path.join(tmp('wt-'), 'feat-wt');
  w.branch('feat', { 'a.js': '1\n' });
  git(w.dev, 'worktree', 'add', '-q', wt, 'feat');
  return { w, wt };
}

test('lane: after the merge the requesting worktree and branch are removed and journaled', async () => {
  const { w, wt } = unmergedWorld();
  const { r, stateDir } = await laneRun(w, wt);
  assert.equal(r.state, 'merged');
  assert.equal(r.worktreeCleanup.removed, true, JSON.stringify(r.worktreeCleanup));
  assert.equal(fs.existsSync(wt), false);
  const j = fs.readFileSync(path.join(stateDir, 'integration', 'worktree-cleanup.jsonl'), 'utf8');
  assert.match(j, /"removed":true/);
});

test('lane: worktreeCleanup() false (the switch) leaves everything alone', async () => {
  const { w, wt } = unmergedWorld();
  const { r } = await laneRun(w, wt, { worktreeCleanup: () => false });
  assert.equal(r.worktreeCleanup, undefined); assert.ok(fs.existsSync(wt));
});

test('lane: a dirty worktree, a live session and a lease each leave it and say why', async () => {
  for (const [extra, mk, re] of [
    [{}, (wt) => fs.writeFileSync(path.join(wt, 'wip'), 'x'), /dirty/],
    [{ liveCwds: async (wt) => [wt] }, () => {}, /tmux/],
    [{ leaseHeld: async () => true }, () => {}, /lease/],
  ]) {
    const { w, wt } = unmergedWorld(); mk(wt);
    const o = { ...extra }; if (o.liveCwds) o.liveCwds = async () => [wt];
    const { r } = await laneRun(w, wt, o);
    assert.equal(r.state, 'merged'); assert.equal(r.worktreeCleanup.removed, false); assert.match(r.worktreeCleanup.reason, re); assert.ok(fs.existsSync(wt));
  }
});

test('lane: the live checkout is left', async () => {
  const { w, wt } = unmergedWorld();
  const { r } = await laneRun(w, wt, { liveCheckouts: [wt] });
  assert.equal(r.worktreeCleanup.removed, false); assert.match(r.worktreeCleanup.reason, /live checkout/);
});

test('lane: a returned (unmerged) request never cleans', async () => {
  const w = makeWorld(); const wt = path.join(tmp('wt-'), 'w');
  w.branch('feat', { 'a.js': '1\n' }); git(w.dev, 'worktree', 'add', '-q', wt, 'feat');
  const stateDir = tmp('lane-wtc-');
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg({ test: 'false' }) } }, pollMs: 5, sleep: () => tick(1) });
  lane.start(); const { id } = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', worktree: wt });
  const end = Date.now() + 8000; while (Date.now() < end && lane.get(id).state !== 'returned') await tick(5);
  await lane.idle(); const r = lane.get(id); lane.stop();
  assert.equal(r.state, 'returned'); assert.equal(r.worktreeCleanup, undefined); assert.ok(fs.existsSync(wt));
});
