// Server integration hook (OWNER_DECISIONS §11.1, D-021). The goal loop calls it in `integrating` for a task that asked
// for delivery (review_policy.deliver). What it may do on its own is exactly one thing: publish the task's OWN branch
// (`v2task/<task_id>`, created by worktrees.js for this task) at the verified SHA to a configured remote, with a
// compare-and-swap push, and only that refspec. Everything that touches a shared branch -- the merge into the target --
// is an owner decision bound to the exact SHA (integration:merge:<project>:<target>:<sha>, delivery.js approvalKey).
// This server has no integration lane (no remote CI or deploy-state source for the integration controller), so even an
// approved merge is NOT executed here: the task waits until the target contains the SHA (the owner merged it), then
// the release is verified by reading git. Nothing here merges, deploys or force-pushes a branch it does not own.
import { effectiveGrants } from './task-contract.js';
import { approvalKey } from './delivery.js';
import { loadPolicy as realLoadPolicy } from './policy.js';

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PART = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'repo';
const short = (s) => String(s).slice(0, 12);

// git(args, { cwd, timeout_ms }) -> stdout (integration-controller createGitRunner); pushRemote: remote NAME or null.
export function createServerIntegrate({ git, pushRemote = null, target = 'main', retryMs = 10 * 60_000, loadPolicy = (repo) => realLoadPolicy(repo) } = {}) {
  if (typeof git !== 'function') throw new Error('server integrate: git required');
  if (pushRemote != null && !REMOTE_RE.test(pushRemote)) throw new Error('server integrate: invalid remote name');

  async function remoteSha(repo, ref) {
    const out = await git(['ls-remote', pushRemote, `refs/heads/${ref}`], { cwd: repo });
    const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${ref}`));
    return line ? line.split('\t')[0] : null;
  }

  const pushKey = (task_id, sha) => `push:task-branch:${task_id}:${sha}`;
  const OPEN = ['attempted', 'possibly_applied'];

  // -> note for the decision rationale. The push is a recorded effect (attempted -> confirmed | failed |
  // possibly_applied) through the loop's fenced store handle: a displaced loop fails the fence before the push.
  async function pushOwnBranch(task, sha, branch, store) {
    if (!pushRemote) return 'task branch not pushed: no push remote configured (GHOSTY_V2_PUSH_REMOTE)';
    const repo = task.repository;
    const remotes = (await git(['remote'], { cwd: repo })).split('\n').map((s) => s.trim());
    if (!remotes.includes(pushRemote)) return `task branch not pushed: the repository has no remote ${pushRemote}`;
    const key = pushKey(task.task_id, sha);
    const ref = `refs/heads/${branch}`;
    let effs = ((await store.get(task.task_id))?.effects || []).filter((e) => e.idempotency_key === key);
    if (effs.some((e) => e.phase === 'confirmed')) return `task branch ${branch} already pushed at ${short(sha)}`;
    // An earlier attempt with an unknown outcome is resolved by reading the remote, never by pushing blindly again.
    for (const e of effs.filter((x) => OPEN.includes(x.phase))) {
      const at = await remoteSha(repo, branch).catch(() => undefined);
      if (at === undefined) return `task branch push ${e.effect_id} still unknown (remote unreadable): not repeated`;
      await store.recordEffect(task.task_id, { effect_id: e.effect_id, phase: at === sha ? 'confirmed' : 'failed' });
      if (at === sha) return `task branch ${branch} at ${short(sha)} on ${pushRemote} (reconciled)`;
    }
    effs = ((await store.get(task.task_id))?.effects || []).filter((e) => e.idempotency_key === key);
    const effect_id = `taskpush-${short(sha)}-${effs.length}`;
    const expected = await remoteSha(repo, branch);
    await store.recordEffect(task.task_id, { effect_id, idempotency_key: key, kind: 'push_task_branch', phase: 'attempted' });
    let err = null;
    if (expected !== sha) {
      try {
        await git(['push', '--porcelain', `--force-with-lease=${ref}:${expected ?? ''}`, pushRemote, `${sha}:${ref}`], { cwd: repo, timeout_ms: 60_000 });
      } catch (e) { err = e; }
    }
    // The remote is the truth, whatever the push said.
    const at = await remoteSha(repo, branch).catch(() => undefined);
    const phase = at === sha ? 'confirmed' : at === undefined ? 'possibly_applied' : 'failed';
    await store.recordEffect(task.task_id, { effect_id, phase });
    if (phase === 'confirmed') return `task branch ${branch} pushed to ${pushRemote} at ${short(sha)}`;
    return `task branch push to ${pushRemote} ${phase === 'failed' ? 'failed' : 'outcome unknown'} (${err?.code || 'remote not at sha'}); nothing else was pushed`;
  }

  async function integrate(task, { sha, worktree, store } = {}) {
    if (!store || typeof store.append !== 'function') return { next: 'awaiting_approval', block: 'policy', reason: 'integration hook called without the loop store handle' };
    const branch = `v2task/${task.task_id}`;
    if (!SHA_RE.test(sha || '') || worktree?.branch !== branch || typeof task.repository !== 'string') {
      return { next: 'awaiting_approval', block: 'policy', reason: `integration refused: only the task's own branch ${branch} at a full SHA is handed off` };
    }
    const pol = loadPolicy(task.repository);
    if (!pol.ok) return { next: 'awaiting_approval', block: 'policy', reason: `project policy ${pol.code}: no integration` };
    const pushNote = await pushOwnBranch(task, sha, branch, store);

    const repoKey = KEY_PART(pol.policy.project_id);
    const cls = (pol.policy.protected_branches || []).includes(target) ? 'merge_protected' : 'push_shared';
    const key = approvalKey({ action: 'merge', repo: repoKey, target, sha });
    const granted = effectiveGrants(await store.events(task.task_id))
      .some((e) => e.payload.grants?.request_kind === 'integration' && (e.payload.grants.keys || []).includes(key));
    if (!granted) {
      return { next: 'awaiting_approval', classes: [cls], keys: [key], sha,
        reason: `Approve merging ${branch} at ${sha} into ${target} (${cls}); the grant covers exactly this SHA. ${pushNote}.` };
    }
    // Approved: this server does not merge (no integration lane). Verified once the target contains the SHA.
    let contained = false;
    try { await git(['merge-base', '--is-ancestor', sha, `refs/heads/${target}`], { cwd: task.repository }); contained = true; } catch { contained = false; }
    if (contained) return { next: 'release_verifying', release_verified: true, reason: `${target} contains ${sha} (merged by the owner). ${pushNote}.` };
    return { next: 'waiting', retry_after_ms: retryMs,
      reason: `merge of ${short(sha)} into ${target} approved; this server has no integration lane and does not merge: merge ${branch} yourself, the task closes once ${target} contains it. ${pushNote}.` };
  }
  // Reconcile an open effect after a crash: a task-branch push by reading the remote; the loop's own integration
  // effect is applied once no push of this hook is still open.
  integrate.reconcile = async (task, { idempotency_key, store } = {}) => {
    const key = String(idempotency_key || '');
    if (key.startsWith('push:task-branch:')) {
      const sha = key.split(':').at(-1);
      if (!pushRemote) return {};
      try { return { applied: (await remoteSha(task.repository, `v2task/${task.task_id}`)) === sha }; } catch { return {}; }
    }
    const open = ((await store.get(task.task_id))?.effects || []).filter((e) => e.kind === 'push_task_branch' && OPEN.includes(e.phase));
    return open.length ? {} : { applied: true };
  };
  return integrate;
}
