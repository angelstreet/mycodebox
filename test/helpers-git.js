// Real throwaway git repos for the merge-policy tests (temp dirs, fake identities, no network).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp } from './helpers-tmp.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'pack.threads', GIT_CONFIG_VALUE_0: '1' };   // one pack thread: a loaded box refuses to fork many
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Writes { path: content } into the repo and commits it.
export function commit(repo, files, msg = 'change') {
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), c); }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

// A repo on main with a base commit; branch `feat` (checked out unless opts.stay) carries `files`; main moves on with `mainFiles`.
export function makeRepo({ files = { 'src.js': 'export const a = 1;\n' }, mainFiles = null, base = { 'src.js': 'export const a = 0;\n', 'VERSION.txt': '1\n' }, branch = 'feat', name = 'proj' } = {}) {
  const repo = join(tmp('merge-pol-'), name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, base, 'base');
  git(repo, 'checkout', '-q', '-b', branch);
  commit(repo, files, 'feature');
  if (mainFiles) { git(repo, 'checkout', '-q', 'main'); commit(repo, mainFiles, 'main moves'); git(repo, 'checkout', '-q', branch); }
  return repo;
}
