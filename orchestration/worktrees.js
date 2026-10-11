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

export function createWorktrees({ git = defaultGit, fs = nodeFs, root, repoAllowlist = [], leases, ttl_ms = 6 * 3600_000 }) {
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
  function writeMeta(m) {
    fs.mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    const f = metaFile(m.task_id);
    const tmp = `${f}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(m)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
  }
  // Resolve an existing worktree path; symlinks and `..` that land outside root are rejected.
  function resolveExisting(p) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw coded('E_PATH', 'invalid path');
    let real;
    try { real = fs.realpathSync(p); } catch { throw coded('E_PATH', 'path does not exist'); }
    if (!within(realRoot, real)) throw coded('E_PATH', 'path resolves outside the worktree root');
    return real;
  }
  const taskOf = (real) => path.basename(real);

  async function status(p) {
    const real = resolveExisting(p);
    const out = await git(['status', '--porcelain=v1', '-uall'], { cwd: real });
    const lines = out.split('\n').filter(Boolean);
    const head = (await git(['rev-parse', 'HEAD'], { cwd: real })).trim();
    return { dirty: lines.some((l) => !l.startsWith('??')), untracked: lines.some((l) => l.startsWith('??')), head };
  }

  function owner(p) {
    const real = resolveExisting(p);
    const m = readMeta(taskOf(real));
    if (!m || m.path !== real) return null;
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

    const acq = await leases.acquire(`worktree:${task_id}`, { owner: who2, task_id, ttl_ms, scope: 'worktree' });
    if (!acq?.ok) throw coded(acq?.code || 'E_UNAVAILABLE', `worktree lease not acquired (${acq?.code || 'unavailable'})`);
    const lease = acq.lease;
    let added = false;
    try {
      if (fs.existsSync(target) || readMeta(task_id)) throw coded('E_EXISTS', 'worktree already exists');
      await git(['cat-file', '-e', `${base_sha}^{commit}`], { cwd: realRepo });
      await git(['worktree', 'add', '-b', want, target, base_sha], { cwd: realRepo });
      added = true;
      const real = fs.realpathSync(target);
      const head = (await git(['rev-parse', 'HEAD'], { cwd: real })).trim();
      writeMeta({ task_id, owner: who2, repo: realRepo, branch: want, base_sha, path: real, lease, created_head: head });
      return { path: real, branch: want, head, lease };
    } catch (e) {
      if (added) { try { await git(['worktree', 'remove', '--force', target], { cwd: realRepo }); await git(['branch', '-D', want], { cwd: realRepo }); } catch { /* rollback best effort */ } }
      try { await leases.release(lease); } catch { /* lease expires by ttl */ }
      throw e;
    }
  }

  // retain defaults to true: only an explicit retain:false on a clean, merged, owned tree deletes anything.
  async function remove(p, { retain = true, owner: who, merged_into } = {}) {
    const real = resolveExisting(p);
    const m = readMeta(taskOf(real));
    if (!m || m.path !== real) throw coded('E_FOREIGN', 'not a managed worktree');
    if ((who || m.task_id) !== m.owner) throw coded('E_FOREIGN', 'worktree is owned by another owner');
    const v = await leases.validate(m.lease);
    if (!v?.ok) throw coded(v?.code || 'E_FENCED', 'worktree lease is not valid');
    const st = await status(real);
    if (st.dirty) throw coded('E_DIRTY', 'worktree has uncommitted changes');
    if (st.untracked) throw coded('E_UNTRACKED', 'worktree has untracked files');
    if (retain !== false) return { removed: false, retained: true };
    if (st.head !== m.base_sha) {
      let merged = false;
      if (merged_into && REF.test(merged_into)) {
        try { await git(['merge-base', '--is-ancestor', st.head, merged_into], { cwd: m.repo }); merged = true; } catch { merged = false; }
      }
      if (!merged) throw coded('E_UNMERGED', 'branch has commits not merged into the target');
    }
    await git(['worktree', 'remove', real], { cwd: m.repo }); // no --force: git re-checks cleanliness
    try { await git(['branch', '-D', m.branch], { cwd: m.repo }); } catch { /* branch already gone */ }
    try { fs.unlinkSync(metaFile(m.task_id)); } catch { /* ignore */ }
    try { await leases.release(m.lease); } catch { /* ttl covers it */ }
    return { removed: true, retained: false };
  }

  return { create, owner, status, remove };
}
