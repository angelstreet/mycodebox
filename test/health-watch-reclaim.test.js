// The reclaim the owner turned on freed 0 KB on every run (E37, 2026-10-24): two classes of reclaimable space
// were never even considered. 1) A merged+clean+dead worktree whose only content is build output was blocked by
// the ignored-files guard. 2) A plain `git clone` was invisible, because the candidate set came from
// `git worktree list --porcelain`, which only knows registered worktrees.
// This file covers both additions AND the protections that must keep blocking: a live session, a dirty tree, an
// unmerged branch, recent activity and the main checkout of a configured repo.
import test from 'node:test';
import assert from 'node:assert/strict';
// Namespace import on purpose: a missing export must fail the TEST, not the module load, so a run against a
// pristine origin/main names the missing behaviour instead of a syntax error.
import * as hw from '../scripts/health-watch.js';
import { mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';

const HOUR = 3600e3;

// A fake git: one entry per path, so the tests drive the scan without a real repository.
function fakeGit(spec) {
  const run = (cmd, args) => {
    const i = args.indexOf('-C');
    if (i < 0) return null;
    const e = spec[args[i + 1]];
    if (!e) return null;
    const rest = args.slice(i + 2);
    if (rest[0] === 'rev-parse') {
      if (rest[1] === '--git-common-dir') return e.common;
      if (rest[1] === '--verify') return e.refs?.has(rest[3]) ? (e.target || 'sha') : null;
      if (rest[1] === '--abbrev-ref') return e.branch || 'HEAD';
      if (rest[1] === 'HEAD') return e.head || null;
      if (rest[1] && e.refs?.has(rest[1])) return e.target || null;
    }
    if (rest[0] === 'remote' && rest[1] === 'get-url') return e.origin ?? null;
    if (rest[0] === 'worktree' && rest[1] === 'list') return e.list;
    if (rest[0] === 'status') return e.status;
    if (rest[0] === 'merge-base') return e.mergedRefs?.has(rest[3]) ? '' : null;
    if (rest[0] === 'reflog') return e.reflog || null;
    if (rest[0] === 'log') return e.log || null;
    return null;
  };
  return run;
}

// A repo with a main worktree (a .git DIRECTORY) and linked worktrees (a .git FILE).
function makeRepo(root, name, worktrees = [], opts = {}) {
  const main = join(root, name), common = join(root, '.git', name);
  const refs = new Set(opts.refs || ['refs/remotes/origin/main']);
  const mergedRefs = new Set(opts.mergedRefs || ['refs/remotes/origin/main']);
  mkdirSync(join(main, '.git'), { recursive: true });
  const list = [`worktree ${main}\nHEAD aaa\nbranch refs/heads/main`];
  const spec = { [main]: { common, list: '', refs, mergedRefs, status: '', branch: 'main', head: 'aaa', target: 'aaa',
    origin: opts.origin || main } };
  for (const w of worktrees) {
    const p = join(main, w.name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, '.git'), `gitdir: ${common}/worktrees/${w.name}\n`);
    const branch = w.branch || 'feature';
    list.push(`worktree ${p}\nHEAD bbb\nbranch refs/heads/${branch}`);
    spec[p] = { common: `${common}/worktrees/${w.name}`, status: w.status ?? '', branch,
      head: w.head || 'bbb', target: w.target || 'aaa', reflog: w.reflog || null,
      refs, mergedRefs: new Set(w.mergedRefs ?? mergedRefs) };
  }
  spec[main].list = list.join('\n\n') + '\n';
  return { main, common, spec };
}

// A plain clone: a .git DIRECTORY (a linked worktree has a .git FILE). Old by default: a clone that was made
// minutes ago is recent activity, not scratch.
function makeClone(root, name, { origin, status = '', branch = 'main', head = 'aaa', merged = true,
  remoteRef = true, ageH = 3 } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(dir, '.git', 'index'), '');
  const old = new Date(Date.now() - ageH * HOUR);
  utimesSync(join(dir, '.git', 'HEAD'), old, old);
  utimesSync(join(dir, '.git', 'index'), old, old);
  utimesSync(dir, old, old);
  const refs = new Set(remoteRef ? ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'] : []);
  const mergedRefs = new Set(merged ? ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'] : []);
  return { dir, spec: { [dir]: { common: join(dir, '.git'), status, branch, head, target: 'aaa', origin, refs, mergedRefs } } };
}

const cfgOf = (repo, roots) => ({ worktreeRepos: { [repo.key]: repo.main }, worktreeRoots: roots });
const scanOf = (repos, cfg, extra = {}) => {
  const spec = Object.assign({}, ...repos.map((r) => r.spec));
  return hw.scanWorktrees({ cfg, run: fakeGit(spec), ...extra });
};
// The whole chain: the registered worktrees of the configured repos, then the plain clones under the same roots.
const scanBoth = (repos, clones, cfg, extra = {}) => {
  const spec = Object.assign({}, ...repos.map((r) => r.spec), ...clones.map((c) => c.spec));
  const run = fakeGit(spec);
  const wt = hw.scanWorktrees({ cfg, run });
  return { wt, cs: hw.scanClones({ cfg, repos: wt.repos, run, ...extra }) };
};

test('E37-0 the reclaim knows about build artifacts and about plain clones', () => {
  assert.equal(typeof hw.isBuildArtifactPath, 'function', 'origin/main has no build-artifact allowlist');
  assert.equal(typeof hw.scanClones, 'function', 'origin/main never looks at a plain clone');
  assert.equal(typeof hw.cloneReport, 'function', 'origin/main has no clone report');
});

test('E37-1 a merged+clean+dead worktree whose only ignored file is build output is removable', () => {
  const root = tmp('hw-reclaim-');
  const cases = ['!! node_modules/\n', '!! build/\n', '!! src/__pycache__/\n', '!! app.egg-info/\n', '!! mod.pyc\n'];
  cases.forEach((status, i) => {
    const a = makeRepo(root, `alpha${i}`, [{ name: 'wt-build', status }]);
    const w = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] }).candidates[0];
    assert.equal(w.clean, true, 'nothing tracked or untracked is modified');
    assert.equal(w.ignoredFiles, 1, status.trim());
    assert.equal(w.ignoredOnlyBuildArtifacts, true, status.trim());
    assert.equal(w.kind, 'removable', `build output alone must not keep a merged, dead worktree alive (${status.trim()})`);
  });
});

test('E37-1b the same worktree with an ignored file that is not build output is not removable', () => {
  const root = tmp('hw-reclaim-');
  const cases = ['!! notes.md\n', '!! .env\n', '!! node_modules/\n!! .env\n', '!! data/set.csv\n'];
  cases.forEach((status, i) => {
    const a = makeRepo(root, `alpha${i}`, [{ name: 'wt-keep', status }]);
    const w = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] }).candidates[0];
    assert.equal(w.ignoredOnlyBuildArtifacts, false, status.trim());
    assert.equal(w.kind, 'ignored-files', `an unknown ignored file keeps the worktree (${status.trim()})`);
    assert.notEqual(w.kind, 'removable');
  });
});

test('E37-2 a clean plain clone of a configured repo with no commits of its own is a candidate', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha');
  const c = makeClone(root, 'scratch-clone', { origin: a.main });
  const { cs } = scanBoth([a], [c], cfgOf({ key: 'alpha', main: a.main }, [root]));
  assert.equal(cs.candidates.length, 1, 'the clone is seen at all');
  const w = cs.candidates[0];
  assert.equal(w.dir, c.dir);
  assert.equal(w.repo, 'alpha', 'the origin points at a repo this product manages');
  assert.equal(w.isClone, true);
  assert.equal(w.clean, true);
  assert.equal(w.merged, true, 'no unique local commits');
  assert.equal(w.liveSession, false);
  assert.equal(w.kind, 'removable');
});

test('E37-3 a dirty clone, a clone with a local commit, a live clone and a clone of an unmanaged repo are not removable', () => {
  // one root per case: the scan walks the whole root, so a shared root would mix the cases up
  const a0 = tmp('hw-reclaim-');
  const a = makeRepo(a0, 'alpha');
  const cfg = cfgOf({ key: 'alpha', main: a.main }, [a0]);
  // dirty: a modified tracked file
  const dirty = makeClone(a0, 'clone-dirty', { origin: a.main, status: ' M src/app.js\n' });
  // a commit of its own: HEAD is not an ancestor of the remote default branch
  const ahead = makeClone(a0, 'clone-ahead', { origin: a.main, merged: false });
  // a repo this product does not manage
  const other = makeClone(a0, 'clone-other', { origin: '/somewhere/else' });
  const { cs } = scanBoth([a], [dirty, ahead, other], cfg);
  const by = Object.fromEntries(cs.candidates.map((c) => [c.name, c]));
  assert.equal(by['clone-dirty'].kind, 'clone-dirty');
  assert.equal(by['clone-ahead'].kind, 'clone-unmerged', 'a clone with work of its own is not scratch');
  assert.equal(by['clone-other'].kind, 'clone-unknown-repo', 'somebody else\'s data is never a candidate');
  for (const k of ['clone-dirty', 'clone-ahead', 'clone-other']) assert.notEqual(by[k].kind, 'removable', k);
  // a live session holds it
  const r1 = tmp('hw-reclaim-');
  const b1 = makeRepo(r1, 'alpha');
  const live = makeClone(r1, 'clone-live', { origin: b1.main });
  const { cs: cs2 } = scanBoth([b1], [live], cfgOf({ key: 'alpha', main: b1.main }, [r1]),
    { panes: [{ name: 'sess', pid: 1, path: live.dir }] });
  assert.equal(cs2.candidates[0].kind, 'clone-live-session');
  assert.equal(cs2.candidates[0].liveSession, true);
  // a process that works in it from another directory
  const r2 = tmp('hw-reclaim-');
  const b2 = makeRepo(r2, 'alpha');
  const held = makeClone(r2, 'clone-held', { origin: b2.main });
  const { cs: cs3 } = scanBoth([b2], [held], cfgOf({ key: 'alpha', main: b2.main }, [r2]),
    { procArgs: [{ pid: 9, args: 'git -C ' + held.dir + ' status' }] });
  assert.equal(cs3.candidates[0].kind, 'clone-live-session');
  // a clone that was just made is recent activity, not scratch
  const r3 = tmp('hw-reclaim-');
  const b3 = makeRepo(r3, 'alpha');
  const fresh = makeClone(r3, 'clone-fresh', { origin: b3.main, ageH: 0 });
  const { cs: cs4 } = scanBoth([b3], [fresh], cfgOf({ key: 'alpha', main: b3.main }, [r3]));
  assert.equal(cs4.candidates[0].kind, 'clone-recent-activity');
  assert.equal(cs4.candidates[0].recentActivity, true);
});

test('E37-4 the main checkout of a configured repo and its registered worktrees are never clone candidates', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-linked' }]);
  const c = makeClone(root, 'scratch-clone', { origin: a.main });
  const { cs } = scanBoth([a], [c], cfgOf({ key: 'alpha', main: a.main }, [root]));
  assert.ok(!cs.candidates.some((x) => x.dir === a.main), 'the main checkout is not a candidate');
  assert.ok(!cs.candidates.some((x) => x.dir === join(a.main, 'wt-linked')), 'a registered worktree is not a candidate');
  assert.equal(cs.candidates.length, 1);
  assert.equal(cs.candidates[0].dir, c.dir);
  // no configured repo: no clone is a candidate at all
  const none = hw.scanClones({ cfg: { worktreeRepos: {}, worktreeRoots: [root] }, repos: [], run: fakeGit({}) });
  assert.equal(none.candidates.length, 0, 'no repo, no candidate');
});

test('E37-5 the removal of a clone is visible in the log with its size and its reason', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha');
  const c = makeClone(root, 'scratch-clone', { origin: a.main });
  const { cs } = scanBoth([a], [c], cfgOf({ key: 'alpha', main: a.main }, [root]));
  const log = [];
  const freed = hw.runOptionalFixes({ cfg: { fixLevel: 'cleanup+worktrees' }, dryRun: false, wts: cs.candidates, log }, []);
  assert.ok(freed > 0, 'the freed bytes are counted');
  assert.ok(!existsSync(c.dir), 'the scratch clone is gone');
  const line = log.join('\n');
  assert.match(line, /deleted clone/, 'the report says what was deleted');
  assert.match(line, new RegExp(c.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the report names the directory');
  assert.match(line, /scratch copy of alpha/, 'the report says why it was removable');
});

test('E37-6 a dry run deletes nothing and says what it would delete', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha');
  const c = makeClone(root, 'scratch-clone', { origin: a.main });
  const { cs } = scanBoth([a], [c], cfgOf({ key: 'alpha', main: a.main }, [root]));
  const log = [];
  hw.runOptionalFixes({ cfg: { fixLevel: 'cleanup+worktrees' }, dryRun: true, wts: cs.candidates, log }, []);
  assert.ok(existsSync(c.dir), 'the dry run removed nothing');
  assert.match(log.join('\n'), /WOULD delete clone/);
});

test('E37-7 the report shows every clone, its size and the criterion that kept it', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha');
  const dirty = makeClone(root, 'clone-dirty', { origin: a.main, status: ' M src/app.js\n' });
  const good = makeClone(root, 'clone-good', { origin: a.main });
  const { cs } = scanBoth([a], [dirty, good], cfgOf({ key: 'alpha', main: a.main }, [root]));
  const report = hw.cloneReport(cs, { du: () => 2048 });
  assert.match(report, /## Plain clones/);
  assert.match(report, /clone-dirty/);
  assert.match(report, /clone-good/);
  assert.match(report, /clone-dirty \| alpha \|/, 'the repo is named');
  assert.match(report, /clone-dirty \| tracked or untracked changes/, 'the criterion that kept it is named');
  assert.match(report, /scratch clone: clean, no commits of its own/, 'and why the other one is removable');
});

test('E37-8 a clone whose origin is the configured repo\'s own upstream is a candidate too', () => {
  const root = tmp('hw-reclaim-');
  const a = makeRepo(root, 'alpha', [], { origin: 'https://example.invalid/team/alpha.git' });
  const c = makeClone(root, 'scratch-clone', { origin: 'https://example.invalid/team/alpha' });
  const { cs } = scanBoth([a], [c], cfgOf({ key: 'alpha', main: a.main }, [root]));
  assert.equal(cs.candidates.length, 1);
  assert.equal(cs.candidates[0].repo, 'alpha', 'the clone came from the same upstream');
  assert.equal(cs.candidates[0].kind, 'removable');
});
