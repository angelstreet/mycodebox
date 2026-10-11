import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';

export async function sessionDirectory(cwd, home) {
  let dir, root;
  try {
    if (typeof cwd !== 'string' || !cwd) throw new Error();
    dir = await realpath(cwd);
    root = await realpath(home);
    if (!(await stat(dir)).isDirectory()) throw new Error();
  } catch {
    throw Object.assign(new Error('cwd must be an existing directory'), { status: 400 });
  }
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw Object.assign(new Error('cwd must be under $HOME'), { status: 400 });
  }
  return dir;
}
