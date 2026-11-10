// Worktree cleanup after a merge (owner/harness fix 2026-11-10: disk kept returning to 85% because merged request worktrees stayed).
// Called by the integration lane once a request is merged/deployed. Removes the requesting worktree and its local branch ONLY when
// every guard passes; any doubt (or an error) leaves it in place and the reason is returned for the journal. Never forces: no
// `--force`, no deleting a dirty tree, never the live checkout, never while a session or lease still uses it.
import fs from 'node:fs';
import path from 'node:path';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
// Ignored entries that are always regenerable; anything else ignored (keystores, notes) may be real content: leave the tree.
const SAFE_IGNORED = /^(node_modules\/|\.cache\/|coverage\/)/;

// -> { removed: boolean, reason: string, branchDeleted?: boolean }
export async function cleanupWorktree({ worktree, branch, session = null, target, remote, laneClone, git,
  liveCheckouts = [], liveCwds = async () => [], leaseHeld = async () => false } = {}) {
  const no = (reason) => ({ removed: false, reason });
  try {
    if (!worktree || !path.isAbsolute(worktree) || !branch) return no('no worktree recorded');
    if (!fs.existsSync(worktree)) return no('worktree already gone');
    const wt = real(worktree);
    const G = (cwd, args) => git(args, { cwd, timeoutMs: 60_000 });
    for (const l of liveCheckouts.filter(Boolean)) if (inside(real(l), wt)) return no('is the live checkout');
    if (laneClone && real(laneClone) === wt) return no('is the lane clone');
    // the primary worktree of its repository is never removable; a linked one lists the primary first
    const list = await G(wt, ['worktree', 'list', '--porcelain']);
    if (list.code !== 0) return no(`not a git worktree: ${(list.err || '').slice(0, 120)}`);
    const entries = list.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)));
    if (!entries.includes(wt)) return no('not listed as a worktree of its repository');
    if (entries[0] === wt) return no('is the primary checkout of its repository (not a linked worktree)');
    for (const l of liveCheckouts.filter(Boolean)) if (real(l) === entries[0] || real(l) === wt) return no('is the live checkout');
    const primary = entries[0];
    const head = await G(wt, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (head.code !== 0 || head.out.trim() !== branch) return no(`checked out ${head.code === 0 ? head.out.trim() : 'a detached HEAD'}, not ${branch}`);
    if (branch === target) return no('the branch is the target');
    const st = await G(wt, ['status', '--porcelain', '--ignored', '--untracked-files=all']);
    if (st.code !== 0) return no('git status failed');
    for (const line of st.out.split('\n').filter(Boolean)) {
      if (line.startsWith('!! ') && SAFE_IGNORED.test(line.slice(3))) continue;
      return no(line.startsWith('!! ') ? `ignored file present: ${line.slice(3, 80)}` : 'dirty (uncommitted or untracked changes)');
    }
    // Merged and nothing unpushed: HEAD must be an ancestor of the target the lane just pushed (checked in the lane clone).
    const sha = (await G(wt, ['rev-parse', 'HEAD'])).out.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return no('cannot read HEAD');
    if ((await G(laneClone, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0) return no('has commits the target has not seen (unpushed or unmerged)');
    const anc = await G(laneClone, ['merge-base', '--is-ancestor', sha, `${remote}/${target}`]);
    if (anc.code !== 0) return no('has unpushed or unmerged commits (HEAD is not in the target)');
    const cwds = (await liveCwds()).filter(Boolean).map(real);
    if (cwds.some((c) => inside(c, wt))) return no('a live tmux session uses it as its working directory');
    if (!session) return no('requesting session unknown: cannot check its leases');
    if (await leaseHeld(session, wt)) return no('the requesting session holds a lease');
    const rm = await G(primary, ['worktree', 'remove', wt]);   // no --force: git itself refuses a dirty or locked tree
    if (rm.code !== 0) return no(`git worktree remove refused: ${(rm.err || rm.out || '').trim().slice(0, 160)}`);
    // The tip is verified merged above, so the local branch is safe to drop; the remote branch is left alone.
    const bd = await G(primary, ['branch', '-D', branch]);
    return { removed: true, reason: 'merged, clean, no session or lease', branchDeleted: bd.code === 0, ...(bd.code === 0 ? {} : { branchNote: (bd.err || '').trim().slice(0, 120) }) };
  } catch (e) { return no(`error: ${String(e?.message || e).slice(0, 160)}`); }
}
