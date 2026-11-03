// cbsession: own git worktree before the first prompt (-d on a main checkout), idempotent, -N / no-worktree list skip it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cbsession');
const home = tmp('cbs-wt-');
const repo = path.join(home, 'myrepo');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
git(home, 'init', '-q', '-b', 'main', repo);
git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
// Fake tmux (no session exists, everything else succeeds) and a no-op sleep, so a real (non -x) run starts nothing.
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = has-session ] && exit 1\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state') } });
const launch = (name) => fs.readFileSync(path.join(home, 'handovers', `${name}.launch.sh`), 'utf8');

test('dry run prints the worktree step, creates nothing, launches in the worktree', () => {
  const r = run('-x', '-n', 'TASK9-x', '-d', repo, '-p', 'codex', '-t', 'go');
  assert.equal(r.status, 0, r.stderr);
  const wt = path.join(home, 'myrepo-TASK9-x');
  assert.match(r.stdout, new RegExp(`worktree: git -C ${repo} worktree add ${wt} -b feat/task9-x main`));
  assert.ok(!fs.existsSync(wt), 'dry run creates no worktree');
  assert.match(launch('TASK9-x'), new RegExp(`cd ${wt}\n`));
});

test('real run creates the worktree on <type>/<name>, keeps the subdir, and is idempotent', () => {
  let r = run('-n', 'BUG12-y', '-d', path.join(repo, 'sub'), '-p', 'codex', '-t', 'go');
  assert.equal(r.status, 0, r.stderr);
  const wt = path.join(home, 'myrepo-BUG12-y');
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/bug12-y');
  assert.match(launch('BUG12-y'), new RegExp(`cd ${path.join(wt, 'sub')}\n`));
  assert.match(fs.readFileSync(path.join(home, 'handovers', 'BUG12-y.prompt.md'), 'utf8'), /Your worktree is ready: .*myrepo-BUG12-y\/sub \(branch fix\/bug12-y/);
  r = run('-x', '-n', 'BUG12-y', '-d', repo, '-p', 'codex', '-t', 'go');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`worktree: reuse ${wt}`));
  // branch exists but the directory was removed: the branch is checked out again, not recreated
  git(repo, 'worktree', 'remove', wt);
  r = run('-x', '-n', 'BUG12-y', '-d', repo, '-p', 'codex', '-t', 'go');
  assert.match(r.stdout, new RegExp(`worktree: git -C ${repo} worktree add ${wt} fix/bug12-y\n`));
});

test('no worktree for -N, a linked worktree, a non-git dir, or a listed live checkout; -w names the branch', () => {
  let r = run('-x', '-n', 'n1', '-d', repo, '-N', '-p', 'codex', '-t', 'go');
  assert.doesNotMatch(r.stdout, /worktree:/); assert.match(launch('n1'), new RegExp(`cd ${repo}\n`));
  const linked = path.join(home, 'linked'); git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat/l');
  r = run('-x', '-n', 'n2', '-d', linked, '-p', 'codex', '-t', 'go');
  assert.doesNotMatch(r.stdout, /worktree:/); assert.match(launch('n2'), new RegExp(`cd ${linked}\n`));
  const plain = path.join(home, 'plain'); fs.mkdirSync(plain);
  r = run('-x', '-n', 'n3', '-d', plain, '-p', 'codex', '-t', 'go');
  assert.doesNotMatch(r.stdout, /worktree:/);
  r = run('-x', '-n', 'n4', '-d', repo, '-w', 'docs/my-name', '-p', 'codex', '-t', 'go');
  assert.match(r.stdout, /-b docs\/my-name main/);
  fs.mkdirSync(path.join(home, '.config', 'cbsession'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'cbsession', 'no-worktree'), `${repo}\n`);
  r = run('-x', '-n', 'n5', '-d', repo, '-p', 'codex', '-t', 'go');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /worktree:/); assert.match(launch('n5'), new RegExp(`cd ${repo}\n`));
});
