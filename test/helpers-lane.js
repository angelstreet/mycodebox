// Fixtures for the integration lane tests: a bare "remote", a developer clone and the lane's own clone, all in temp dirs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, commit } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

export function makeWorld({ name = 'demo-repo', base = { 'src.js': 'export const a = 0;\n', 'VERSION.txt': '1\n' } } = {}) {
  const root = tmp('lane-');
  const remote = join(root, `${name}.git`), dev = join(root, 'dev'), lane = join(root, 'lane');
  mkdirSync(remote);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', remote, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  commit(dev, base, 'base');
  git(dev, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', remote, lane);
  const w = {
    root, remote, dev, lane, name,
    // a pushed branch cut from the current main of the dev clone
    branch(b, files, msg = `work on ${b}`) {
      git(dev, 'checkout', '-q', '-B', b, 'origin/main');
      commit(dev, files, msg);
      git(dev, 'push', '-q', '-f', 'origin', b);
      git(dev, 'checkout', '-q', 'main');
    },
    // main moves on (someone else pushed)
    moveMain(files, msg = 'main moves') {
      git(dev, 'checkout', '-q', 'main'); git(dev, 'pull', '-q', 'origin', 'main');
      commit(dev, files, msg);
      git(dev, 'push', '-q', 'origin', 'main');
    },
    main: () => git(remote, 'rev-parse', 'main').trim(),
    show: (ref, file) => git(remote, 'show', `${ref}:${file}`),
    count: () => Number(git(remote, 'rev-list', '--count', 'main').trim()),
    cfg: (extra = {}) => ({ clone: lane, remote: 'origin', target: 'main', test: null, ci: null, deploy: null, conventions: ['VERSION.txt'], ...extra }),
  };
  return w;
}
export const writeFile = (p, c) => writeFileSync(p, c);
