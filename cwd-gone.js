// A session whose folder was removed (a merged worktree cleaned up under it) reports its cwd as "<path> (deleted)". Git cannot
// read it any more, so the session would lose its project. These are the folders to ask instead, nearest first: the parents of
// the path, then the main checkout the worktree was named after (~/repo-topic -> ~/repo, worktree naming in cbsession).
export const DELETED_SUFFIX = ' (deleted)';

export function goneCwd(cwd) {
  const s = String(cwd || '');
  return s.endsWith(DELETED_SUFFIX) ? s.slice(0, -DELETED_SUFFIX.length) : null;
}

export function projectCandidates(path, home) {
  const out = [];
  const segs = String(path || '').split('/');
  for (let i = segs.length; i > 1; i--) {
    const dir = segs.slice(0, i).join('/');
    if (!dir || dir === home || (home && !dir.startsWith(home + '/'))) break;
    const parent = segs.slice(0, i - 1).join('/');
    const parts = segs[i - 1].split('-');
    if (i < segs.length) out.push(dir);   // a parent folder (the path itself is gone)
    for (let k = parts.length - 1; k >= 1; k--) out.push(`${parent}/${parts.slice(0, k).join('-')}`);
  }
  return [...new Set(out)];
}

// Resume of a parked session whose folder was removed (merged worktree cleaned up while it was parked). Claude keys its transcript
// by the folder path, so the session must come back at the SAME path: recreate it as a detached worktree of the main checkout the
// worktree was named after, else as an empty folder. Only paths strictly under $HOME are touched. Returns the path or null.
export async function restoreGoneCwd(path, home, { exists, run, mkdir }) {
  const p = goneCwd(path) ?? String(path || '');
  if (!home || !p.startsWith(home + '/') || p.includes('/../') || exists(p)) return exists(p) ? p : null;
  for (const c of projectCandidates(p, home)) {
    if (c === p || !exists(`${c}/.git`)) continue;
    try { await run('git', ['-C', c, 'worktree', 'prune']); await run('git', ['-C', c, 'worktree', 'add', '--detach', p]); if (exists(p)) return p; } catch { /* try the next candidate */ }
  }
  try { await mkdir(p, { recursive: true }); return exists(p) ? p : null; } catch { return null; }
}
