// Guarded git worktree lifecycle: one lease-owned worktree per task, never deleted when it holds work.
import nodeFs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF = /^[A-Za-z0-9][\w./-]{0,200}$/;

const coded = (code, msg) => Object.assign(new Error(msg || code), { code });
const within = (root, p) => { const r = path.relative(root, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

export function defaultGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 << 20 }, (e, stdout, stderr) => {
      if (e) reject(Object.assign(e, { stderr })); else resolve(stdout);
    });
  });
}

export function createWorktrees({ git = defaultGit, fs = nodeFs, root, repoAllowlist = [], leases, ttl_ms = 6 * 3600_000, mergeTargets = null }) {
  if (!root) throw coded('E_CONFIG', 'root required');
  if (!leases) throw coded('E_CONFIG', 'lease authority required');
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const metaDir = path.join(realRoot, '.v2-meta');
  const allow = repoAllowlist.flatMap((r) => { try { return [fs.realpathSync(r)]; } catch { return []; } });

  const metaFile = (task_id) => path.join(metaDir, `${task_id}.json`);
  function readMeta(task_id) {
    try { return JSON.parse(fs.readFileSync(metaFile(task_id), 'utf8')); } catch { return null; }
  }
  // Metadata is untrusted input (it lives on disk): re-derive everything that reaches git or unlink.
  function trustedMeta(real) {
    const id = path.basename(real);
    const m = TASK_ID.test(id) ? readMeta(id) : null;
    if (!m || m.path !== real) return null;
    if (m.task_id !== id || m.branch !== `v2task/${id}` || typeof m.repo !== 'string' || !allow.includes(m.repo)
      || m.lease?.resource !== `worktree:${id}` || (m.lease?.task_id != null && m.lease.task_id !== id)) {
      throw coded('E_FOREIGN', 'worktree metadata is invalid');
    }
    return m;
  }
  function fsyncDir(d) {
    try { const fd = fs.openSync(d, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not supported everywhere */ }
  }
  function writeMeta(m) {
    fs.mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    const f = metaFile(m.task_id);
    const tmp = `${f}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(m)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    fsyncDir(metaDir);
  }
  // Called immediately before every git mutation: a fenced or expired lease means someone else may own this now.
  async function guard(lease) {
    const v = await leases.validate(lease);
    if (!v?.ok) throw coded(v?.code || 'E_FENCED', 'worktree lease is not valid');
  }
  // Resolve an existing worktree path; symlinks and `..` that land outside root are rejected.
  function resolveExisting(p) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw coded('E_PATH', 'invalid path');
    let real;
    try { real = fs.realpathSync(p); } catch { throw coded('E_PATH', 'path does not exist'); }
    if (!within(realRoot, real)) throw coded('E_PATH', 'path resolves outside the worktree root');
    return real;
  }

  async function status(p) {
    const real = resolveExisting(p);
    const out = await git(['status', '--porcelain=v1', '-uall', '--ignored'], { cwd: real });
    const lines = out.split('\n').filter(Boolean);
    const head = (await git(['rev-parse', 'HEAD'], { cwd: real })).trim();
    return {
      dirty: lines.some((l) => !l.startsWith('??') && !l.startsWith('!!')),
      untracked: lines.some((l) => l.startsWith('??')),
      ignored: lines.some((l) => l.startsWith('!!')),
      head,
    };
  }

  function owner(p) {
    const real = resolveExisting(p);
    const m = trustedMeta(real);
    if (!m) return null;
    return { task_id: m.task_id, owner: m.owner, repo: m.repo, branch: m.branch, base_sha: m.base_sha, lease: m.lease };
  }

  async function create({ repo, task_id, base_sha, branch, owner: who }) {
    if (typeof task_id !== 'string' || !TASK_ID.test(task_id)) throw coded('E_INVALID', 'task_id must match [A-Za-z0-9._-]{1,64}');
    const want = `v2task/${task_id}`;
    if (branch !== undefined && branch !== want) throw coded('E_INVALID', `branch must be ${want}`);
    if (typeof base_sha !== 'string' || !SHA.test(base_sha)) throw coded('E_INVALID', 'base_sha must be a full commit sha');
    let realRepo;
    try { realRepo = fs.realpathSync(repo); } catch { throw coded('E_REPO', 'repo not found'); }
    if (!allow.includes(realRepo)) throw coded('E_REPO', 'repo is not in the allowlist');
    const target = path.join(realRoot, task_id);
    if (!within(realRoot, target)) throw coded('E_PATH', 'path escapes root');
    const who2 = who || task_id;

    let acq = await leases.acquire(`worktree:${task_id}`, { owner: who2, task_id, ttl_ms, scope: 'worktree' });
    // The backend may have committed despite reporting E_UNAVAILABLE: adopt exactly that attempt or fail closed.
    if (!acq?.ok && acq?.code === 'E_UNAVAILABLE' && acq.attempted && typeof leases.adopt === 'function') acq = await leases.adopt(acq.attempted);
    if (!acq?.ok) throw coded(acq?.code || 'E_UNAVAILABLE', `worktree lease not acquired (${acq?.code || 'unavailable'})`);
    const lease = acq.lease;
    let added = false;
    try {
      if (fs.existsSync(target) || readMeta(task_id)) throw coded('E_EXISTS', 'worktree already exists');
      const branchExists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${want}`], { cwd: realRepo }).then(() => true, () => false);
      if (branchExists) throw coded('E_EXISTS', `branch ${want} already exists`);
      await git(['cat-file', '-e', `${base_sha}^{commit}`], { cwd: realRepo });
      await guard(lease);
      await git(['worktree', 'add', '-b', want, target, base_sha], { cwd: realRepo });
      added = true;
      const real = fs.realpathSync(target);
      const head = (await git(['rev-parse', 'HEAD'], { cwd: real })).trim();
      writeMeta({ task_id, owner: who2, repo: realRepo, branch: want, base_sha, path: real, lease, created_head: head });
      return { path: real, branch: want, head, lease };
    } catch (e) {
      if (added) {
        try { await guard(lease); await git(['worktree', 'remove', '--force', target], { cwd: realRepo }); await git(['branch', '-D', want], { cwd: realRepo }); } catch { /* rollback best effort */ }
      }
      try { await leases.release(lease); } catch { /* lease expires by ttl */ }
      throw e;
    }
  }

  // Ownership is proven by the lease (id + token) or, weaker, by the owner name; one of them is required.
  function assertOwner(m, { owner: who, lease }) {
    if (lease) {
      if (lease.lease_id !== m.lease?.lease_id || lease.token !== m.lease?.token || lease.owner !== m.owner) throw coded('E_FOREIGN', 'lease does not match this worktree');
    } else if (!who || who !== m.owner) throw coded('E_FOREIGN', 'worktree is owned by another owner');
  }

  async function renew(p, opts = {}) {
    const real = resolveExisting(p);
    const m = trustedMeta(real);
    if (!m) throw coded('E_FOREIGN', 'not a managed worktree');
    assertOwner(m, opts);
    const r = await leases.renew(m.lease);
    if (!r?.ok) throw coded(r?.code || 'E_FENCED', 'lease renew failed');
    writeMeta({ ...m, lease: r.lease });
    return { lease: r.lease };
  }

  // retain defaults to true: only an explicit retain:false on a clean, merged, owned tree deletes anything.
  async function remove(p, { retain = true, owner: who, lease, merged_into } = {}) {
    const real = resolveExisting(p);
    const m = trustedMeta(real);
    if (!m) throw coded('E_FOREIGN', 'not a managed worktree');
    assertOwner(m, { owner: who, lease });
    await guard(m.lease);
    const st = await status(real);
    if (st.dirty) throw coded('E_DIRTY', 'worktree has uncommitted changes');
    if (st.untracked) throw coded('E_UNTRACKED', 'worktree has untracked files');
    if (st.ignored) throw coded('E_IGNORED', 'worktree has ignored files that removal would delete');
    if (retain !== false) return { removed: false, retained: true };

    // Both the checked-out HEAD and the branch tip must be at base or reachable from the merge target.
    const tip = (await git(['rev-parse', '--verify', `refs/heads/${m.branch}`], { cwd: m.repo }).catch(() => '')).trim();
    if (!SHA.test(tip)) throw coded('E_UNMERGED', 'cannot resolve the task branch tip');
    let target = null;
    if (merged_into !== undefined) {
      if (typeof merged_into !== 'string' || !REF.test(merged_into) || merged_into.startsWith('v2task/') || merged_into === m.branch) throw coded('E_INVALID', 'merged_into must be a target branch, not a task branch');
      if (mergeTargets && !mergeTargets.includes(merged_into)) throw coded('E_INVALID', 'merged_into is not a configured target branch');
      target = merged_into;
    }
    for (const sha of new Set([st.head, tip])) {
      if (sha === m.base_sha) continue;
      let merged = false;
      if (target) {
        try { await git(['merge-base', '--is-ancestor', sha, `refs/heads/${target}`], { cwd: m.repo }); merged = true; } catch { merged = false; }
      }
      if (!merged) throw coded('E_UNMERGED', 'branch has commits not merged into the target');
    }
    await guard(m.lease);
    await git(['worktree', 'remove', real], { cwd: m.repo }); // no --force: git re-checks cleanliness
    // Merge was verified above for this exact tip: delete by compare-and-swap so a tip that moved since is kept.
    try { await guard(m.lease); await git(['update-ref', '-d', `refs/heads/${m.branch}`, tip], { cwd: m.repo }); } catch { /* kept */ }
    try { fs.unlinkSync(metaFile(m.task_id)); fsyncDir(metaDir); } catch { /* ignore */ }
    try { await leases.release(m.lease); } catch { /* ttl covers it */ }
    return { removed: true, retained: false };
  }

  return { create, owner, status, remove, renew };
}
