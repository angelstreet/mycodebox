import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'checkout-sync.sh');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cosync-'));
  const origin = join(root, 'origin'), work = join(root, 'work'), clone = join(root, 'clone');
  git(root, 'init', '-q', '-b', 'main', origin);
  writeFileSync(join(origin, 'a.txt'), '1\n'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'c1');
  git(root, 'clone', '-q', origin, clone);
  writeFileSync(join(origin, 'a.txt'), '2\n'); git(origin, 'commit', '-qam', 'c2');
  return { root, origin, clone };
}
const run = (root, clone) => spawnSync('bash', [SCRIPT, clone], { encoding: 'utf8', env: { ...process.env, GHOSTY_STATE_DIR: join(root, 'state') } });

test('a clean checkout on main is fast-forwarded', () => {
  const { root, origin, clone } = setup();
  const r = run(root, clone);
  assert.equal(r.status, 0); assert.match(r.stdout, /synced: .* \(1 commits\)/);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
  assert.match(run(root, clone).stdout, /current/);
});
test('a dirty tree, an untracked file, another branch and local commits are skipped and left untouched', () => {
  let s = setup(); writeFileSync(join(s.clone, 'a.txt'), 'mine\n');
  assert.match(run(s.root, s.clone).stdout, /skipped: working tree is not clean/);
  assert.equal(readFileSync(join(s.clone, 'a.txt'), 'utf8'), 'mine
');
  s = setup(); writeFileSync(join(s.clone, 'new.txt'), 'x\n');
  assert.match(run(s.root, s.clone).stdout, /not clean/);
  s = setup(); git(s.clone, 'checkout', '-qb', 'feature');
  assert.match(run(s.root, s.clone).stdout, /skipped: on 'feature'/);
  s = setup(); writeFileSync(join(s.clone, 'b.txt'), 'l\n'); git(s.clone, 'add', '.'); git(s.clone, 'commit', '-qm', 'local');
  const r = run(s.root, s.clone); assert.match(r.stdout, /not fast-forward/);
  assert.equal(git(s.clone, 'log', '-1', '--format=%s'), 'local');
});
test('a missing checkout is skipped with exit 0', () => {
  const r = spawnSync('bash', [SCRIPT, '/nonexistent/x'], { encoding: 'utf8', env: { ...process.env, GHOSTY_STATE_DIR: mkdtempSync(join(tmpdir(), 'cs-')) } });
  assert.equal(r.status, 0); assert.match(r.stdout, /not a git checkout/);
});
