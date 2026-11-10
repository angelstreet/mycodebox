import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prune } from '../scripts/prune-daily-worktrees.js';

const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
test('keeps the newest 3 daily worktrees per game; skips dirty, unmerged and in-use; other games untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-daily-')), repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  const add = (name) => { const wt = path.join(tmp, `repo-${name}`); g(repo, 'worktree', 'add', '-q', wt, '-b', `feat/${name}`, 'main'); return wt; };
  const days = ['20261101', '20261102', '20261103', '20261104', '20261105', '20261106'].map((d) => add(`coc-daily-${d}`));
  const other = add('pokemon-daily-20261101');
  fs.writeFileSync(path.join(days[1], 'wip.txt'), 'x');   // 11-02 dirty: git refuses
  const r = prune(repo, 'coc-daily-20261106', { cwds: [days[0]] });   // 11-01 in use, 11-02 dirty, 11-03 removed
  const by = Object.fromEntries(r.map((x) => [path.basename(x.worktree), x]));
  assert.equal(r.length, 3);
  assert.equal(by['repo-coc-daily-20261101'].removed, false);
  assert.equal(by['repo-coc-daily-20261102'].removed, false);
  assert.equal(by['repo-coc-daily-20261103'].removed, true);
  assert.ok(!fs.existsSync(days[2]));
  for (const keep of [days[3], days[4], days[5], other]) assert.ok(fs.existsSync(keep));
  fs.rmSync(tmp, { recursive: true, force: true });
});
