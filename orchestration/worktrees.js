// Guarded git worktree lifecycle: one lease-owned worktree per task, never deleted when it holds work.
import nodeFs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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

export function createWorktrees({ git = defaultGit, fs = nodeFs, root, repoAllowlist = [], leases, ttl_ms = 6 * 3600_000, mergeTargets = null, admission = null }) {
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
    if (m.task_id !== id || m.branch !== `v2/task/${id}` || typeof m.repo !== 'string' || !allow.includes(m.repo)
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
  // D-015 write-ahead: the intended { resource, lease_id, owner, task_id } is persisted (atomic, fsync) BEFORE acquire,
  // so a crash between acquire and persisting the granted lease is recovered with leases.adopt() and that private id.
  // A twin whose lease_id differs from the persisted one stays fenced.
  const intentFile = (task_id) => path.join(metaDir, `${task_id}.intent.json`);
  function writeIntent(task_id, intent) {
    fs.mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    const f = intentFile(task_id);
    const tmp = `${f}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    fsyncDir(metaDir);
  }
  function readIntent(task_id) { try { return JSON.parse(fs.readFileSync(intentFile(task_id), 'utf8')); } catch { return null; } }
  function dropIntent(task_id) { try { fs.unlinkSync(intentFile(task_id)); fsyncDir(metaDir); } catch { /* none */ } }
  const newIntent = (task_id, owner) => ({ resource: `worktree:${task_id}`, lease_id: `wt-${task_id}-${randomUUID()}`.slice(0, 128), owner, task_id });
  const validIntent = (x, task_id, owner) => !!x && x.resource === `worktree:${task_id}` && x.owner === owner && x.task_id === task_id && typeof x.lease_id === 'string';

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
    // 'HEAD' when detached: callers compare it with the task branch before committing or accepting (X7).
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: real })).trim();
    return {
      branch,
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
    const want = `v2/task/${task_id}`;
    if (branch !== undefined && branch !== want) throw coded('E_INVALID', `branch must be ${want}`);
    if (typeof base_sha !== 'string' || !SHA.test(base_sha)) throw coded('E_INVALID', 'base_sha must be a full commit sha');
    let realRepo;
    try { realRepo = fs.realpathSync(repo); } catch { throw coded('E_REPO', 'repo not found'); }
    if (!allow.includes(realRepo)) throw coded('E_REPO', 'repo is not in the allowlist');
    const target = path.join(realRoot, task_id);
    if (!within(realRoot, target)) throw coded('E_PATH', 'path escapes root');
    const who2 = who || task_id;

    // Disk-space policy (disk-guard.js): a worktree is new work on the disk. Checked before any lease or git state
    // is written, so a refusal leaves nothing behind.
    if (admission) {
      const verdict = await admission({ task_id, repo: realRepo });
      if (verdict && verdict.ok === false) throw coded(verdict.code || 'E_DISK_LOW', verdict.message || 'new work is refused');
    }

    // A crash after a previous create's acquire (before its meta) left our own intent: adopt that lease if still live.
    const prev = readIntent(task_id);
    let acq = validIntent(prev, task_id, who2) && typeof leases.adopt === 'function' ? await leases.adopt(prev) : null;
    if (!acq?.ok) {
      const intent = newIntent(task_id, who2);
      writeIntent(task_id, intent);
      acq = await leases.acquire(`worktree:${task_id}`, { owner: who2, task_id, ttl_ms, scope: 'worktree', lease_id: intent.lease_id });
      // The backend may have committed despite reporting E_UNAVAILABLE: adopt exactly that attempt or fail closed.
      if (!acq?.ok && acq?.code === 'E_UNAVAILABLE' && acq.attempted && typeof leases.adopt === 'function') acq = await leases.adopt(acq.attempted);
      if (!acq?.ok) { if (acq?.code !== 'E_UNAVAILABLE') dropIntent(task_id); throw coded(acq?.code || 'E_UNAVAILABLE', `worktree lease not acquired (${acq?.code || 'unavailable'})`); }
    }
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
      dropIntent(task_id);
      return { path: real, branch: want, head, lease };
    } catch (e) {
      if (added) {
        try { await guard(lease); await git(['worktree', 'remove', '--force', target], { cwd: realRepo }); await git(['branch', '-D', want], { cwd: realRepo }); } catch { /* rollback best effort */ }
      }
      try { await leases.release(lease); } catch { /* lease expires by ttl */ }
      dropIntent(task_id);
      throw e;
    }
  }

  // Ownership is proven by the lease (id + token) or, weaker, by the owner name; one of them is required.
  function assertOwner(m, { owner: who, lease }) {
    if (lease) {
      if (lease.lease_id !== m.lease?.lease_id || lease.token !== m.lease?.token || lease.owner !== m.owner) throw coded('E_FOREIGN', 'lease does not match this worktree');
    } else if (!who || who !== m.owner) throw coded('E_FOREIGN', 'worktree is owned by another owner');
  }

  // A lapsed lease (E_EXPIRED: nobody took it since) is re-acquired by the same owner and the meta rewritten
  // atomically, so remove()/renew() keep working. Never over a live holder (E_HELD). After another owner held it in
  // between (E_FENCED) only with opts.acknowledgeFence (an explicit owner decision after inspecting the tree), and
  // still only when the lease is free. -> { lease, reacquired }
  async function renew(p, opts = {}) {
    const real = resolveExisting(p);
    const m = trustedMeta(real);
    if (!m) throw coded('E_FOREIGN', 'not a managed worktree');
    assertOwner(m, opts);
    const r = await leases.renew(m.lease);
    if (r?.ok) { writeMeta({ ...m, lease: r.lease, pending_lease: null }); return { lease: r.lease, reacquired: false }; }
    // X6/D-015: a crash between a previous re-acquire and its meta rewrite left a granted lease under the persisted
    // write-ahead id: adopt exactly that one (a twin with another id stays fenced).
    if ((r?.code === 'E_FENCED' || r?.code === 'E_EXPIRED') && validIntent(m.pending_lease, m.task_id, m.owner) && typeof leases.adopt === 'function') {
      const own = await leases.adopt(m.pending_lease);
      if (own?.ok) { writeMeta({ ...m, lease: own.lease, pending_lease: null }); return { lease: own.lease, reacquired: true, adopted: true }; }
    }
    const fenced = r?.code === 'E_FENCED' && opts.acknowledgeFence === true;
    if (r?.code !== 'E_EXPIRED' && !fenced) throw coded(r?.code || 'E_FENCED', 'lease renew failed');
    const intent = newIntent(m.task_id, m.owner);
    writeMeta({ ...m, pending_lease: intent });   // write-ahead before acquire
    const a = await leases.acquire(m.lease.resource, { owner: m.owner, task_id: m.task_id, ttl_ms, scope: 'worktree', lease_id: intent.lease_id });
    if (!a?.ok) throw Object.assign(coded(a?.code || 'E_UNAVAILABLE', `lease re-acquire failed (${a?.code || 'unavailable'})`), a?.holder ? { holder: a.holder } : {});
    // The generation advanced past ours by exactly this acquire: anything else means another holder came in between.
    if (!fenced && a.lease.token !== m.lease.token + 1) {
      try { await leases.release(a.lease); } catch { /* ttl covers it */ }
      writeMeta({ ...m, pending_lease: null });
      throw coded('E_FENCED', 'another owner held this worktree lease since it lapsed');
    }
    writeMeta({ ...m, lease: a.lease, pending_lease: null });
    return { lease: a.lease, reacquired: true };
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
      if (typeof merged_into !== 'string' || !REF.test(merged_into) || merged_into.startsWith('v2/task/') || merged_into === m.branch) throw coded('E_INVALID', 'merged_into must be a target branch, not a task branch');
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
