// Goal loop -> Integration Agent bridge (GOAL_LOOP_CONTRACT delivery, spec §12.3, ARCHITECTURE §11 "Delivery").
// Implements the loop's injected hook `integrate(task, { sha, worktree, idempotency_key, store })` and
// `integrate.reconcile(task, { effect_id, idempotency_key, store })` on top of the integration controller.
//
// One writer (D-016/D-017). The goal loop is the only writer of task state. The controller is built over
// `controllerStore`, a handle that (a) sends every non-transition write (events, effects, evidence, decisions) to the
// loop's fenced store handle passed in the hook call, so each write re-validates the loop's controller lease, and is
// refused (E_NO_WRITER) outside a hook call; (b) turns `transition()` into a proposal that is recorded, never applied.
// The bridge maps the controller's outcome (read back from the durable queue item, not from memory) to the loop's
// next state; the loop applies it with its own decision record.
//
// Handoff facts come from the store and git, never from task text: the developer is the actor the store recorded as
// producing the head SHA (`store.independence`), the diff scope is `git diff --name-only base..sha` in the task
// worktree, and the source is the task branch in the task repository.
//
// Approvals. Every controller approval (candidate push, merge) is answered from the task log: an owner grant counts
// only when its action keys contain `integration:<action>:<repo>:<target>:<sha>` for exactly the request the
// controller is checking. The bridge returns those keys with `awaiting_approval`, the loop stores them on its request
// and `approve()` copies them into the grant, so an approval for one SHA, action, target or repo never covers another.
import { remoteStatus, ciPasses } from './ci-gates.js';

const coded = (code, message) => Object.assign(new Error(message), { code });
const WRITES = ['createTask', 'append', 'setHead', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'snapshotPolicy'];
const OPEN = ['attempted', 'possibly_applied'];
const CONTROLLER_KEY = /^(?:push|merge):/;

export const approvalKey = ({ action, repo, target, sha }) => `integration:${action}:${repo}:${target}:${sha}`;

// store: the task store (reads, `dir`); queue: the controller's integration queue (read only here); controller:
// ({ store, approvals }) -> integration controller, built over the bridge's handle; git(argv, { cwd }) -> stdout;
// ci: the same remote CI status source the controller uses. repo/target name the configured integration lane.
export function createDelivery({ store, queue, controller: makeController, git, ci, repo, target = 'main', retryMs = 60_000 } = {}) {
  for (const [k, v] of Object.entries({ store, queue, makeController, git, repo })) if (!v) throw coded('E_CONFIG', `delivery: ${k} required`);
  let writer = null;
  const proposals = [];
  const controllerStore = new Proxy(Object.create(null), {
    get(_, k) {
      if (k === 'dir') return store.dir;
      if (k === 'transition') {
        return async (task_id, to, o = {}) => { proposals.push({ task_id, to, reason: o.reason ?? null }); return (writer || store).get(task_id); };
      }
      if (WRITES.includes(k)) {
        return async (...a) => {
          if (!writer) throw coded('E_NO_WRITER', `delivery: ${String(k)} outside a goal-loop hook call (the loop is the only writer)`);
          return writer[k](...a);
        };
      }
      const src = writer || store;
      const v = src[k];
      return typeof v === 'function' ? v.bind(src) : v;
    },
  });

  // Owner grants from the task log, bound by action key (see header).
  const approvals = {
    async check(req) {
      const key = approvalKey(req);
      for (const id of req.task_ids || []) {
        const evs = await (writer || store).events(id);
        const g = evs.filter((e) => e.kind === 'approval.granted' && e.payload.grants?.request_kind === 'integration'
          && (e.payload.grants.keys || []).includes(key)).at(-1);
        if (g) return { ok: true, approval_ref: g.payload.approval_ref ?? `grant-${g.event_id}`, repo: req.repo, sha: req.sha, action: req.action, target: req.target, approved_by: g.payload.actor?.id ?? null };
      }
      return { ok: false, reason: `no owner approval for ${key}` };
    },
  };
  const ctl = makeController({ store: controllerStore, approvals });

  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
  async function withWriter(handle, fn) {
    if (!handle || typeof handle.append !== 'function') throw coded('E_NO_WRITER', 'delivery: the goal loop must pass its store handle');
    writer = handle;
    try { return await fn(); } finally { writer = null; }
  }

  const lastRequired = (evs) => evs.filter((e) => e.kind === 'approval.requested' && e.payload?.required).at(-1)?.payload.required ?? null;
  const openControllerEffects = (t) => (t?.effects || []).filter((e) => OPEN.includes(e.phase) && CONTROLLER_KEY.test(e.idempotency_key || ''));

  // Merged: release verified when the remote target contains the integration SHA and remote CI is green on it.
  async function released(task_id, item) {
    const t = await writer.get(task_id);
    const merge = (t.effects || []).filter((e) => e.kind === 'merge' && e.phase === 'confirmed').at(-1);
    const sha = item.detail?.sha ?? (merge ? String(merge.idempotency_key).split(':').at(-1) : null);
    if (!sha) return { next: 'release_verifying', release_verified: false, reason: 'merged; integration SHA unknown' };
    const contained = await ctl.effectState(`merge:${repo}:refs/heads/${target}:${sha}`, `${task_id}-release`);
    const cs = await remoteStatus(ci, sha);
    const ok = contained === 'confirmed' && ciPasses(cs.status);
    return { next: 'release_verifying', release_verified: ok, integration_sha: sha, reason: `merged ${sha} into ${repo}/${target}; remote contains it: ${contained ?? 'unknown'}; CI ${cs.status}` };
  }

  async function mapItem(task, item, run) {
    const reason = item.reason ?? run?.reason ?? item.state;
    switch (item.state) {
      case 'merged': return released(task.task_id, item);
      case 'awaiting_approval': {
        const req = lastRequired(await writer.events(task.task_id));
        if (!req) return { next: 'awaiting_approval', reason: `integration needs the owner: ${reason}`, classes: ['integration'], keys: [] };
        const key = approvalKey({ ...req, repo });
        return { next: 'awaiting_approval', classes: [req.class], keys: [key], required: { ...req, repo },
          reason: `Approve ${req.action} of ${req.sha} to ${repo}/${req.target} (${req.class}); the grant covers exactly this SHA, action and target.` };
      }
      case 'returned': return { next: 'repair', reason: `integration returned the work: ${reason}`, feedback: { kind: 'integration_returned', reason, detail: item.detail ?? null } };
      case 'unknown': return { next: 'unknown', reason: `integration effect unknown: ${reason}` };
      case 'rejected': case 'cancelled': return { next: 'awaiting_approval', reason: `integration ${item.state}: ${reason}`, classes: ['integration'], keys: [] };
      default: return { next: 'waiting', retry_after_ms: retryMs, reason: `integration ${item.state}${run?.outcome ? ` (${run.outcome})` : ''}: ${reason}` };
    }
  }

  async function integrateOnce(task, { sha, worktree }) {
    const ind = await writer.independence(task.task_id, sha);
    const developer = ind?.developers?.[0];
    if (!developer) return { next: 'awaiting_approval', reason: `no developer recorded for ${sha}: cannot hand off`, classes: ['integration'], keys: [] };
    const diff_scope = String(await git(['diff', '--name-only', task.base_sha, sha], { cwd: worktree.path })).split('\n').filter(Boolean);
    const handoff = { task_id: task.task_id, repo, target, source_branch: worktree.branch, source_sha: sha, base_sha: task.base_sha,
      developer: { role: 'developer', id: developer }, diff_scope, source_repo: task.repository };
    const sub = await ctl.submit(handoff);   // idempotent by task:sha:target
    if (!sub.ok) return { next: 'awaiting_approval', reason: `handoff rejected: ${(sub.errors || []).join('; ')}`, classes: ['integration'], keys: [] };
    let run = null;
    let item = await queue.get(sub.item.item_id);
    if (!['merged', 'returned', 'rejected', 'cancelled'].includes(item.state)) {
      run = await ctl.runNext(repo, target);
      item = await queue.get(sub.item.item_id);
    }
    const out = await mapItem(task, item, run);
    return { ...out, item_id: item.item_id, item_state: item.state, run_outcome: run?.outcome ?? null, manifest_path: run?.manifest_path ?? null,
      proposals: proposals.splice(0).filter((p) => p.task_id === task.task_id) };
  }

  const integrate = (task, ctx = {}) => serial(() => withWriter(ctx.store, async () => {
    proposals.length = 0;
    try { return await integrateOnce(task, ctx); }
    catch (e) {
      // An exception after a remote effect was attempted is an unknown outcome; before that it is a retryable wait.
      const open = openControllerEffects(await writer.get(task.task_id).catch(() => null));
      return open.length ? { next: 'unknown', reason: `integration error: ${e.message}` } : { next: 'waiting', retry_after_ms: retryMs, reason: `integration error: ${e.message}` };
    }
  }));
  // Read-only: the loop records the reconciled phase itself.
  integrate.reconcile = (task, ctx = {}) => serial(() => withWriter(ctx.store, async () => {
    const key = String(ctx.idempotency_key || '');
    if (CONTROLLER_KEY.test(key)) {
      const st = await ctl.effectState(key, task.task_id);
      return st === 'confirmed' ? { applied: true } : st === 'failed' ? { applied: false } : {};
    }
    // The loop's own hook effect: its outcome is known once every remote effect it may have caused can be read.
    const open = openControllerEffects(await writer.get(task.task_id));
    for (const e of open) if (!(await ctl.effectState(e.idempotency_key, task.task_id))) return {};
    return { applied: true };
  }));

  return { integrate, controllerStore, approvals, controller: ctl };
}
