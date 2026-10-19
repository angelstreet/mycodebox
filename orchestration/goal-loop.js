// Universal goal loop (GOAL_LOOP_CONTRACT "actual decision procedure", ARCHITECTURE §10, OWNER_DECISIONS §4-§7).
// A deterministic controller over the task store: step(task_id) performs at most ONE persisted transition, run() loops
// steps. LLM roles are adapters it calls; their output is never proof. There is no attempt counter: a loop is bounded
// by policy stops only (cancel, explicit budget, quota, missing authorization, unrecoverable) and the no-progress rule.
//
// Checkpointing. The store log is the only state. Loop memory (strategy, failure streak, feedback, wait, pending
// approval) is folded from the `loop` field of the loop's own decision records (an additive field on the §9 record).
// A decision that leads to a transition carries `loop.next` and the id `gl-<task>-<k>` where k = transitions so far;
// if the process dies between the decision and the transition, the next step replays exactly that transition instead
// of deciding again (GL06/T18). Runs are effects (attempted -> confirmed) so a crash mid-run surfaces as
// unknown_external_effect and is reconciled, never blindly repeated. All event ids are deterministic: a replayed step
// writes nothing new.
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TERMINAL, failureSignature, ContractError, ownerAnswerOf, effectiveGrants } from './task-contract.js';
import { checkAction as policyCheckAction, loadPolicy as realLoadPolicy, clarificationFor } from './policy.js';
import { route as realRoute, fallbackPlan as realFallbackPlan, classifyWork, nextRung } from './router.js';
import * as realBudget from './budget.js';
import { developerPrompt, parseImpossibleClaim } from './roles.js';
import { resolveRunLimits, engineLimits, runOptions } from './run-limits.js';
import { isInformational } from './intake.js';
import { defaultGit } from './worktrees.js';

const ACTOR = 'goal-loop';
const MANAGER = { role: 'manager', runtime: null, model: null };
const VERIFIER_ACTOR = { role: 'tester', id: 'verifier:deterministic' };
const INFRA_CODES = { ENOSPC: 'host.disk_pressure', EDQUOT: 'host.disk_pressure', ENOMEM: 'host.memory_pressure', EMFILE: 'host.memory_pressure',
  ENFILE: 'host.memory_pressure', EAGAIN: 'runner.starved', EIO: 'health.unknown' };
const HARNESS_LIKE = /missing_artifact|unknown_exit|timeout|unavailable/;
const MAX_BACKOFF_MS = 15 * 60_000;
// Errors a provider returns before doing (and charging for) any work.
const UNBILLED_CLASSES = ['rate_limit', 'unavailable', 'auth'];
// D-012: iterations without new passing evidence (any signatures) that force a strategy change; no_progress_policy
// .iterations_without_progress overrides it per task.
export const DEFAULT_ITERATIONS_WITHOUT_PROGRESS = 6;

const hashOf = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
const coded = (code, message) => new ContractError(code, message);
const short = (sha) => String(sha || '').slice(0, 12);

// Default reader of the frozen store layout (ARCHITECTURE §3); a torn tail is ignored (the store truncates it).
export function readTaskEvents(storeDir, task_id, fs = nodeFs) {
  let text;
  try { text = fs.readFileSync(path.join(storeDir, 'tasks', task_id, 'events.jsonl'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { break; } }
  return out;
}

// Store methods that write: each is fenced by the controller lease (D-016).
const STORE_WRITES = ['createTask', 'append', 'transition', 'setHead', 'recordEvidence', 'recordVerdict', 'recordDecision', 'recordUsage', 'recordEffect', 'snapshotPolicy'];
// Same rule as the lease backend's lock files: EPERM means the process exists.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Z1: controller intents a successor may take over -- the process is gone on this host, or its heartbeat is older than
// two heartbeat intervals. Anything else is a live controller (E_CONTROLLER_HELD; let its TTL run out). Pure.
export function deadControllerIntents(intents, { hostname, isAlive = pidAlive, now, heartbeatMs }) {
  return (intents || []).filter((x) => (x.host === hostname && !isAlive(x.pid))
    || (Number.isFinite(x.heartbeat_at) && now - x.heartbeat_at > 2 * heartbeatMs));
}

export const wantsDelivery = (task) => task?.review_policy?.deliver === true
  || (task?.resources || []).some((r) => typeof r === 'string' && /^repo:.+:integration$/.test(r));

const decision = (kind, question, alternatives, chosen, { evidence = [], expected_effect, rationale, policy_ref = null, reversible = true, rollback, confidence = null } = {}) => ({
  kind, question, alternatives, chosen: String(chosen), evidence: evidence.map(String), expected_effect, rationale, actor: MANAGER, confidence, policy_ref,
  reversible, rollback: reversible ? (rollback || 'the next step re-evaluates from persisted state; cancel the task to stop') : (rollback ?? null),
});
const alt = (option, pros, cons) => ({ option, pros: [].concat(pros), cons: [].concat(cons) });

export function createGoalLoop({
  store, registry, adapters = {}, worktrees, worktreeRoot, verifier, integrate = null,
  loadPolicy = (task) => realLoadPolicy(task.repository), checkAction = policyCheckAction,
  route = realRoute, fallbackPlan = realFallbackPlan, budget = realBudget,
  admission = null, systemOps = null, opsRequester = null, incidents = null, leases = null,
  git = defaultGit, fs = nodeFs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readEvents = (id) => (typeof store.events === 'function' ? store.events(id) : readTaskEvents(store.dir, id, fs)), reviewRoot, allowFake = false, hostId = 'local',
  runTimeoutMs = 30 * 60_000, estimateRun = null, quota = () => null,
  commitIdentity = { name: 'mycodebox goal loop', email: 'goal-loop@localhost.invalid' },
  controller = {}, shadow = null,
} = {}) {
  if (!store || !registry || !worktrees || !worktreeRoot || !verifier || !reviewRoot) {
    throw new Error('goal loop: store, registry, worktrees, worktreeRoot, verifier and reviewRoot are required');
  }
  // ---------- D-016: one controller per store ----------
  // A controller lease `service:<host>:goal-loop` (short TTL, renewed by step()/run() and by a heartbeat while a step
  // runs). A second live instance gets E_HELD and fails closed (no step, no write). The instance id is audit data (the
  // lease scope), never identity. Takeover (recover(), cancel()) is liveness-gated (Z1): only an instance that is dead
  // -- its pid gone on this host, or no heartbeat for 2 heartbeat intervals -- is taken over, through its write-ahead
  // lease_id (adopt -> release -> acquire: its handle is fenced). Every store write and every commit re-validates the
  // controller lease first (fence per §5), so a displaced instance writes nothing even between heartbeats.
  const hbMs = Math.max(1000, Math.floor((controller.ttl_ms ?? 60_000) / 3));
  const ctlCfg = { resource: `service:${hostId}:goal-loop`, ttl_ms: 60_000, instance: randomUUID(), hostname: os.hostname(), pid: process.pid,
    isAlive: pidAlive, ...controller };
  const ctl = { lease: null, recovered: false, lost: false, intent: null };
  const ctlIntentPath = (inst) => path.join(store.dir, `controller.${inst}.intent.json`);
  function writeCtlIntent(intent) {
    fs.mkdirSync(store.dir, { recursive: true });
    const f = ctlIntentPath(intent.instance);
    const tmp = `${f}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    try { const d = fs.openSync(store.dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* best effort */ }
  }
  const dropCtlIntent = (inst) => { try { fs.unlinkSync(ctlIntentPath(inst)); } catch { /* none */ } };
  function otherCtlIntents() {
    let names = [];
    try { names = fs.readdirSync(store.dir).filter((f) => /^controller\..+\.intent\.json$/.test(f)); } catch { return []; }
    return names.flatMap((f) => { try { const x = JSON.parse(fs.readFileSync(path.join(store.dir, f), 'utf8')); return x?.instance !== ctlCfg.instance && x?.resource === ctlCfg.resource ? [x] : []; } catch { return []; } });
  }
  const beat = () => { if (ctl.intent) { ctl.intent = { ...ctl.intent, heartbeat_at: now() }; try { writeCtlIntent(ctl.intent); } catch { /* next beat */ } } };
  // Liveness-gated takeover: dead by pid now; otherwise watch the heartbeat for 2 intervals (injected sleep).
  // watch: false (owner actions, inside an HTTP request): no waiting; an unsure intent counts as alive (client retries).
  async function deadIntents({ watch = true } = {}) {
    const snap = otherCtlIntents();
    const opts = { hostname: ctlCfg.hostname, isAlive: ctlCfg.isAlive, now: now(), heartbeatMs: hbMs };
    const dead = deadControllerIntents(snap, opts);
    const unsure = snap.filter((x) => !dead.includes(x));
    if (!unsure.length || !watch) return dead;
    await sleep(2 * hbMs);
    const later = new Map(otherCtlIntents().map((x) => [x.instance, x]));
    for (const x of unsure) {
      const y = later.get(x.instance);
      if (y && y.heartbeat_at === x.heartbeat_at) dead.push(y);   // no heartbeat for 2 intervals: dead
    }
    return dead;
  }
  // -> { ok } | { ok:false, code, diagnosis }
  async function holdController({ takeover = false, reconcile = true, watch = true } = {}) {
    if (!leases) return { ok: true };
    if (ctl.lease) {
      let v;
      try { v = await leases.validate(ctl.lease); } catch { v = { ok: false, code: 'E_UNAVAILABLE' }; }
      if (v?.ok) { try { const r = await leases.renew(ctl.lease); if (r?.ok) ctl.lease = r.lease; } catch { /* validated */ } beat(); ctl.lost = false; return { ok: true }; }
      if (v?.code === 'E_UNAVAILABLE') return { ok: false, code: 'E_UNAVAILABLE', diagnosis: 'controller lease backend unavailable: not stepping (fail closed)' };
      // Expired or fenced: someone may have written since; reconcile the store again once control is regained.
      ctl.lease = null;
      ctl.recovered = false;
    }
    const intent = { resource: ctlCfg.resource, lease_id: `ctl-${randomUUID()}`, owner: ACTOR, task_id: null, instance: ctlCfg.instance,
      pid: ctlCfg.pid, host: ctlCfg.hostname, started_at: now(), heartbeat_at: now() };
    writeCtlIntent(intent);   // D-015 write-ahead
    const opts = { owner: ACTOR, ttl_ms: ctlCfg.ttl_ms, scope: `controller ${ctlCfg.instance}`, lease_id: intent.lease_id };
    let a;
    try { a = await leases.acquire(ctlCfg.resource, opts); } catch { a = { ok: false, code: 'E_UNAVAILABLE' }; }
    if (!a?.ok && a?.code === 'E_HELD' && takeover) {
      for (const pi of await deadIntents({ watch })) {
        const ad = await leases.adopt({ resource: pi.resource, lease_id: pi.lease_id, owner: pi.owner, task_id: null }).catch(() => null);
        dropCtlIntent(pi.instance);   // dead either way: its lease is adopted now or already gone
        if (ad?.ok) { await leases.release(ad.lease).catch(() => null); break; }
      }
      try { a = await leases.acquire(ctlCfg.resource, opts); } catch { a = { ok: false, code: 'E_UNAVAILABLE' }; }
    }
    if (!a?.ok) {
      if (a?.code !== 'E_UNAVAILABLE') dropCtlIntent(ctlCfg.instance);
      return { ok: false, code: a?.code === 'E_HELD' ? 'E_HELD' : a?.code || 'E_UNAVAILABLE',
        diagnosis: a?.code === 'E_HELD' ? `another goal-loop controller holds ${ctlCfg.resource} (until ${new Date(a.holder?.expires_at ?? 0).toISOString()}) and is alive: this instance does not step (D-016)` : `controller lease not acquired (${a?.code ?? 'unavailable'})` };
    }
    ctl.lease = a.lease;
    ctl.intent = intent;
    ctl.lost = false;
    if (reconcile && !ctl.recovered) { await rawStore.recover(); ctl.recovered = true; }
    return { ok: true };
  }
  // Acquire/renew/release one at a time: concurrent owner actions and steps share this instance's single lease.
  let ctlQueue = Promise.resolve();
  const ctlSerial = (fn) => { const r = ctlQueue.then(fn); ctlQueue = r.catch(() => {}); return r; };
  const hold = (opts) => ctlSerial(() => holdController(opts));
  // D-020: an owner action from an instance that is not stepping does not keep the controller lease (the process
  // that runs the loop must not wait out our TTL). In use by a step/run or another owner action: kept.
  const usage = { busy: 0, owners: 0 };
  const releaseIdle = () => ctlSerial(async () => {
    if (!leases || !ctl.lease || usage.busy || usage.owners) return;
    await leases.release(ctl.lease).catch(() => null);
    dropCtlIntent(ctlCfg.instance);
    ctl.lease = null; ctl.intent = null; ctl.recovered = false;   // whoever writes next under the lease reconciles first
  });
  function heartbeat() {
    if (!leases || !ctl.lease) return () => {};
    const t = setInterval(async () => {
      if (!ctl.lease) return;
      try { const r = await leases.renew(ctl.lease); if (r?.ok) { ctl.lease = r.lease; beat(); } else ctl.lost = true; } catch { ctl.lost = true; }
    }, hbMs);
    t.unref?.();
    return () => clearInterval(t);
  }
  // Fence per §5: validate the controller lease immediately before a write. -> throws E_CONTROLLER_LOST
  async function fence() {
    if (!leases) return;
    let v;
    try { v = ctl.lease ? await leases.validate(ctl.lease) : { ok: false, code: 'E_NO_LEASE' }; } catch { v = { ok: false, code: 'E_UNAVAILABLE' }; }
    if (!v?.ok) { ctl.lost = true; throw coded('E_CONTROLLER_LOST', `controller lease ${v?.code ?? 'invalid'}: no write`); }
  }
  // Every store write of this loop goes through the fence; reads and recover() do not.
  const rawStore = store;
  store = Object.freeze({ ...rawStore, ...Object.fromEntries(STORE_WRITES.filter((k) => typeof rawStore[k] === 'function')
    .map((k) => [k, async (...a) => { await fence(); return rawStore[k](...a); }])) });

  // Owner actions write too: they act under the controller lease (taking over a dead controller if needed).
  // No liveness watch here (item: owner actions answer at once): a controller that is not provably dead is held.
  async function asOwner(fn) {
    usage.owners += 1;
    try {
      const h = await hold({ takeover: true, watch: false });
      // A live holder is a conflict (409, retry); a lease backend that cannot answer is not (503).
      if (!h.ok) throw h.code === 'E_HELD' ? coded('E_CONTROLLER_HELD', h.diagnosis) : coded('E_LEASE_UNAVAILABLE', h.diagnosis);
      return await fn();
    } finally { usage.owners -= 1; await releaseIdle(); }
  }

  // D-020: owner answers (dashboard routes included) are written here only, one at a time per task, and a request is
  // answered once: read-check-write under the controller lease, so a second writer can neither race nor double-answer.
  const answering = new Map();
  const answerSerial = (id, fn) => {
    const run = (answering.get(id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    answering.set(id, tail);
    tail.then(() => { if (answering.get(id) === tail) answering.delete(id); });
    return run;
  };
  const SHA_RE = /^[0-9a-f]{7,64}$/;
  // -> { req, repeat }: the pending request, and its earlier identical answer (a retried delivery is a no-op, T06); the
  // opposite answer is refused. `binding` ({ k, sha? }) is what the caller showed the owner, re-checked under the lease.
  function openRequest(ctx, kind, binding) {
    if (ctx.broken) throw coded('E_STORE_FAILED', `task ${ctx.id}: log unreadable, no owner answer recorded`);
    const req = ctx.cp.approval;
    if (ctx.v.status !== 'awaiting_approval' || !req) throw coded('E_ILLEGAL_TRANSITION', 'nothing awaits approval');
    const prior = ownerAnswerOf(ctx.events, req.k);
    if (prior && prior.kind !== kind) throw coded('E_ALREADY_ANSWERED', `this request is already answered (${prior.kind})`);
    if (binding) {
      if (binding.k !== req.k) throw coded('E_STALE_ACTION', 'the pending request changed; reload and decide again');
      const sha = typeof req.sha === 'string' && SHA_RE.test(req.sha) ? req.sha : ctx.v.head_sha ?? null;
      if (sha && binding.sha !== sha) throw coded('E_SHA_MISMATCH', 'sha must be the task head the request was raised on');
    }
    return { req, repeat: prior ? { applied: false, event_id: prior.event_id } : null };
  }
  // Audit fields a dashboard answer carries (action id, the request as shown, SHA, reason); never authority.
  const answerMeta = (m) => (m ? { action_id: m.action_id ?? null, action: m.action ?? null, sha: m.sha ?? null, reason: m.reason ?? null } : {});

  const active = new Map();   // task_id -> { adapter, run } | { kill }: what cancel() must stop (agent run or acceptance check)

  // ---------- context: everything a step decides from, folded from the persisted log ----------
  async function load(id) {
    const v = await store.get(id);
    if (!v) throw coded('E_NOT_FOUND', `task ${id} not found`);
    if (v.store_error) return { id, v, broken: true };   // a partial log is not the history: never decide from it
    const events = await readEvents(id);
    const cp = { strategy: null, streak: { signature: null, count: 0 }, stale: 0, changes: 0, best: 0, best_failing: null, tried: [], exclude: [], stalls: 0, stall_run: null, stall_pending: null, claim: null,
      feedback: null, wait: null, approval: null, provider: null, worktree: null, flaky: [], interpretation: null, plan: null,
      verify_only: false, integration: null, integration_unknown: 0, review_unavailable: 0,
      review_fail: { signature: null, count: 0, changes: 0, excluded: [], strict: false } };
    let pending = null;
    const k = v.history.length;
    for (const d of v.decisions) {
      if (!d.loop) continue;
      Object.assign(cp, structuredClone(d.loop.patch || {}));
      if (d.loop.next && d.loop.k === k) pending = d.loop.next;
    }
    // Head epoch: evidence/verdicts only count for the head as it was set last (a reverted SHA starts over).
    let head = null, epoch = 0, since = 0;
    for (const e of events) if (e.kind === 'task.head_changed' && e.payload.sha !== head) { head = e.payload.sha; epoch += 1; since = e.seq; }
    const current = (e) => e.seq > since && e.payload.sha === head;
    const evidence = events.filter((e) => e.kind === 'evidence.recorded' && current(e)).map((e) => e.payload);
    const verdicts = events.filter((e) => ['verification.passed', 'verification.failed'].includes(e.kind) && e.payload.verdict && current(e)).map((e) => e.payload);
    return { id, v, events, cp, k, pending, head, epoch, evidence, verdicts };
  }

  const isCancelled = async (id) => (await store.get(id))?.status === 'cancelled';
  // Stop before a write when the task was cancelled or this instance lost the controller lease mid-step.
  const halted = async (id) => ctl.lost || (await isCancelled(id));
  const result = (ctx, transitioned, note, extra = {}) => ({ task_id: ctx.id, from: ctx.v.status, state: transitioned ? transitioned : ctx.v.status,
    transitioned: !!transitioned, note, ...extra });

  // One decision + its transition. Replay-safe: same k -> same ids -> deduplicated.
  async function decide(ctx, d, { patch = {}, to, reason, emit = [] }) {
    const next = { to, reason, emit };
    await store.recordDecision(ctx.id, { decision_id: `gl-${ctx.id}-${ctx.k}`, ...d, loop: { k: ctx.k, next, patch } });
    return applyNext(ctx, next);
  }
  async function applyNext(ctx, next) {
    for (const e of next.emit || []) await store.append(ctx.id, { event_id: e.event_id, kind: e.kind, payload: e.payload });
    await store.transition(ctx.id, next.to, { reason: next.reason, actor: ACTOR, event_id: `gl-${ctx.id}-${ctx.k}-to-${next.to}` });
    return result(ctx, next.to, next.reason);
  }
  // Mechanical transitions that follow an earlier recorded decision (no new choice).
  async function move(ctx, to, reason) {
    await store.transition(ctx.id, to, { reason, actor: ACTOR, event_id: `gl-${ctx.id}-${ctx.k}-to-${to}` });
    return result(ctx, to, reason);
  }
  // A decision that does not move the task (revalidation, flaky marking).
  const note = (ctx, tag, d, patch = {}) => store.recordDecision(ctx.id, { decision_id: `gl-${ctx.id}-${ctx.k}-${tag}`, ...d, loop: { k: ctx.k, patch } });

  // ---------- policy, grants, gates ----------
  // A grant covers exactly the action keys of the request it answers (#7): the same gate question keeps its key across
  // steps, an agent's request is keyed by its run, so a later identical request is asked again.
  // Only a grant that is the recorded answer to its request counts (a grant + denial on one k authorizes nothing).
  const grantsOf = (ctx) => new Set(effectiveGrants(ctx.events).flatMap((e) => e.payload.grants?.keys || []));
  const actionKey = (a, scope = '') => `${scope}${a.class}:${hashOf({ argv: a.argv ?? null, text: a.text ?? null, paths: a.paths ?? null })}`;
  function effectiveBudgetPolicy(ctx) {
    let bp = ctx.v.budget_policy;
    for (const e of effectiveGrants(ctx.events)) if (e.payload.grants?.budget_policy) bp = { ...bp, ...e.payload.grants.budget_policy };
    return bp;
  }
  function readPolicy(ctx) {
    let r;
    try { r = loadPolicy(ctx.v); } catch (e) { r = { ok: false, code: 'E_POLICY_INVALID', errors: [{ path: '', message: e.message }] }; }
    return r && typeof r === 'object' ? r : { ok: false, code: 'E_POLICY_INVALID', errors: [{ path: '', message: 'loader returned nothing' }] };
  }
  const policyRef = (p) => (p?.ok ? `policy@${hashOf(p.policy)}` : null);
  function allowed(policy, task, action, grants, key = actionKey(action)) {
    const r = checkAction(policy, task, action);
    if (r.allow) return { ok: true, key };
    // An owner grant only covers an approval-class request with this exact key; a prohibition or a missing policy is
    // never grantable.
    if (r.needs_approval && grants.has(key)) return { ok: true, granted: r.classes, key };
    return { ok: false, ...r, key };
  }
  // T01 + T02/GL09: the policy is re-read and every action class checked before work; text cannot authorize.
  function gate(ctx, p) {
    if (!p.ok) return { kind: 'clarification', ...clarificationFor(p), classes: [] };
    const grants = grantsOf(ctx);
    const acts = [{ class: 'execute' }, ...ctx.v.acceptance_checks.map((c) => ({ class: 'test', argv: c.command }))];
    for (const a of acts) {
      const r = allowed(p.policy, ctx.v, a, grants);
      if (!r.ok) return { kind: r.needs_approval ? 'approval' : 'prohibited', question: `Policy blocks ${a.class}${a.argv ? ` ${a.argv.join(' ')}` : ''}: ${r.reason}`, reason: r.reason, classes: r.classes || [], keys: r.needs_approval ? [r.key] : [] };
    }
    return null;
  }
  function askOwner(ctx, g, { resume_to, kind = 'policy_gate', policy_ref = null, extra = {}, patch = {} }) {
    const req = { k: ctx.k, kind: g.kind, question: g.question, classes: g.classes || [], keys: g.keys || [], resume_to, ...extra };
    return decide(ctx, decision(kind, 'Can the task proceed without the owner?', [
      alt('ask the owner and wait', 'policy and approval classes win over goal text and model output', 'the task pauses'),
      alt('proceed automatically', 'faster', 'not authorized: silence or a recommendation is not approval')],
    'ask the owner and wait', { evidence: [g.reason || g.question], expected_effect: 'awaiting_approval until an explicit owner decision',
      rationale: `Mandatory owner decision (${g.kind}): ${g.question}`, policy_ref }), {
      patch: { ...patch, approval: req }, to: 'awaiting_approval', reason: g.question,
      emit: [{ event_id: `appr-req-${ctx.id}-${ctx.k}`, kind: 'approval.requested', payload: req }],
    });
  }

  // ---------- routing ----------
  async function probes() {
    const out = {};
    for (const [rt, a] of Object.entries(adapters)) {
      if (rt.includes(':')) continue;
      try { out[rt] = await a.probeCapabilities(); } catch { out[rt] = { available: 'unknown' }; }
    }
    return out;
  }
  // role: 'developer' | 'reviewer' | 'security', passed to the router for wrappers that narrow per role (v2-runtime pins).
  async function routeFor(ctx, p, { exclude = ctx.cp.exclude, role = 'developer' } = {}) {
    const pol = p.policy;
    const grants = grantsOf(ctx);
    const reg = registry.withProbes(await probes());
    const routerPolicy = { runtime_allowlist: pol.allowlists.runtimes ?? null, model_allowlist: pol.allowlists.models ?? null,
      allowed_roots: [worktreeRoot], version: hashOf(pol) };
    const task = { ...ctx.v, worktree_path: ctx.cp.worktree?.path ?? null };
    // The documented template default 'project' means "the project's provider allowlist" (#11). Any other string is
    // left to the router, which matches nothing for it: an unknown privacy policy fails closed (no route).
    if (task.privacy_policy === 'project') task.privacy_policy = { allowed_providers: pol.provider_allowlist ?? null };
    if (pol.provider_allowlist) routerPolicy.provider_allowlist = pol.provider_allowlist;
    const key = routeKey(ctx);
    const check = (_p, t) => { const r = allowed(pol, t, { class: 'route' }, grants, key); return r.ok ? { allow: true, needs_approval: false, reason: 'policy allows' } : { allow: false, needs_approval: r.needs_approval, reason: r.reason }; };
    // D-014: an owner approval of this task's routing question (bound to task + base) waives the critical-risk floor.
    const floorGrants = grants.has(key) ? ['critical_risk'] : [];
    // D-024: candidates whose run limits they cannot honour are floored out; D-026: the escalation ladder picks the
    // developer's starting rung (reviewers rank by score).
    return route(task, { registry: reg, policy: routerPolicy, checkAction: check, allowFake, exclude, now, realpath: (x) => fs.realpathSync(x), floorGrants, role,
      limitsFor: (entry) => limitsOf(ctx, p, entry), escalation: role === 'developer' && pol.routing?.escalation !== false });
  }
  // Run limits for one entry on this task (D-024): task > project > registry > engine defaults.
  const workOf = (ctx) => classifyWork(ctx.v).type;
  function limitsOf(ctx, p, entry) {
    return resolveRunLimits({ entry, workType: workOf(ctx), risk: ctx.v.risk_class, task: ctx.v.run_limits ?? null, project: p?.policy?.run_limits ?? null, engine: engineLimits(runTimeoutMs) });
  }
  // What the adapter gets, plus the limits it could not apply (recorded, never a crash).
  function runLimitsFor(ctx, p, entry, adapter, role) {
    const lim = entry ? limitsOf(ctx, p, entry) : { limits: engineLimits(runTimeoutMs), source: {}, error: null };
    const opts = runOptions(lim.limits, { role, support: adapter?.limitSupport || {}, adapter: entry?.runtime || 'adapter' });
    return { ...opts, stall_runs_to_no_progress: lim.limits.stall_runs_to_no_progress ?? null, source: lim.source, error: lim.error };
  }
  // Round 15: shadow scoring note next to the live choice. Observe only: never awaited, never throws, result ignored.
  function shadowNote(ctx, role, choice, key) {
    if (!shadow) return;
    try {
      const v = ctx.v || {};
      Promise.resolve(shadow.note({ task_id: ctx.id, role, text: `${v.title || ''} ${v.goal || ''}`, workType: classifyWork(v).type, entry: registry.get(choice) || { id: choice }, key })).catch(() => {});
    } catch { /* shadow must never break routing */ }
  }
  const routeKey = (ctx) => `route:${ctx.v.base_sha}`;
  const adapterFor = (entryId) => adapters[entryId] || adapters[entryId.split(':')[0]] || null;

  // ---------- budget ----------
  function ledger(ctx) {
    const started = new Map(ctx.events.filter((e) => e.kind === 'task.started').map((e) => [e.payload.run_id, e]));
    const used = ctx.events.filter((e) => e.kind === 'usage.recorded');
    const entries = used.map((e) => {
      const s = started.get(e.payload.run_id);
      // D-025: a subscription run's marginal USD is ~0 for the owner's USD caps; its record keeps usd null + billing.
      const usd = e.payload.usd ?? (e.payload.billing === 'subscription' ? 0 : null);
      return { attempt_id: e.payload.run_id, kind: s?.payload.role || 'unknown', usd, input_tokens: e.payload.input_tokens,
        output_tokens: e.payload.output_tokens, duration_ms: s ? Date.parse(e.timestamp) - Date.parse(s.timestamp) : null, turns: 1 };
    });
    // X1/X2 (GL13): a run that started but has no usage record is unknown spend, never free.
    const seen = new Set(used.map((e) => e.payload.run_id));
    for (const [run_id, s] of started) {
      if (!seen.has(run_id)) entries.push({ attempt_id: run_id, kind: s.payload.role, usd: null, input_tokens: null, output_tokens: null, duration_ms: null, turns: 1 });
    }
    return { entries };
  }
  // Runs this process is not running that started and never recorded usage (crash between start and usage): record
  // them as unknown so the ledger and usage totals say "unknown", not a lower number. Deterministic ids: replay-safe.
  async function recordInterruptedUsage(ctx) {
    if (active.has(ctx.id)) return false;
    const used = new Set(ctx.events.filter((e) => e.kind === 'usage.recorded').map((e) => e.payload.run_id));
    const missing = ctx.events.filter((e) => e.kind === 'task.started' && !used.has(e.payload.run_id));
    for (const e of missing) {
      const entry = registry.get(e.payload.entry) || {};
      await store.recordUsage(ctx.id, { runtime: entry.runtime ?? e.payload.runtime ?? null, provider: entry.provider ?? null, model: entry.model ?? e.payload.model ?? null, ...billingOf(entry),
        run_id: e.payload.run_id, input_tokens: null, output_tokens: null, usd: null, source: 'interrupted: no usage recorded before a controller restart' }, { event_id: `usage-${e.payload.run_id}` });
    }
    return missing.length > 0;
  }
  // D-025: usage records say how the run is paid for (registry entry billing).
  const billingOf = (entry) => (entry?.billing ? { billing: entry.billing } : {});
  // estimateRun may answer null (the default below), or an object whose present keys win; absent keys (e.g. a usd-only
  // answer) come from the default, so token/duration caps keep using the measured mean. An explicit null stays unknown.
  function estimate(ctx, entry, role, routeHint = null) {
    const d = defaultEstimate(ctx, entry, role, routeHint);
    const r = estimateRun ? estimateRun({ task: ctx.v, entry, role, ledger: ledger(ctx) }) : null;
    return r ? { ...d, ...r } : d;
  }
  function defaultEstimate(ctx, entry, role, routeHint) {
    // Measured performance first: the mean of this model's known spend on this task; otherwise unknown (never 0).
    const runs = ledger(ctx).entries.filter((e) => e.kind === role && ctx.events.some((s) => s.kind === 'task.started' && s.payload.run_id === e.attempt_id && s.payload.entry === entry));
    const mean = (k) => { const xs = runs.map((r) => r[k]).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    // No run of this entry yet: the router's price-based estimate when it has one (#5), else unknown.
    const usd = (registry.get(entry)?.billing === 'subscription' ? 0 : null) ?? mean('usd') ?? routeHint?.candidates?.find((c) => c.id === entry)?.cost_est_usd
      ?? (role === 'developer' && ctx.cp.strategy?.entry === entry ? ctx.cp.strategy.cost_est_usd : null) ?? null;
    return { usd, input_tokens: mean('input_tokens'), output_tokens: mean('output_tokens'), duration_ms: mean('duration_ms'), turns: 1 };
  }
  // #5: an explicit owner approval of a budget stop authorizes the NEXT run even when its cost cannot be estimated
  // (bound to that request: consumed by the first run started after it). It never overrides a reached cap.
  function nextRunAuthorized(ctx) {
    const g = effectiveGrants(ctx.events).filter((e) => e.payload.grants?.request_kind === 'budget').at(-1);
    return !!g && !ctx.events.some((e) => e.kind === 'task.started' && e.seq > g.seq);
  }
  // T13/GL13: before every start. A cap is a hard stop -> awaiting_approval; quota -> waiting with backoff.
  async function budgetGate(ctx, entry, role, resume_to, { patch = {}, routeHint = null } = {}) {
    const b = budget.check({ ...ctx.v, budget_policy: effectiveBudgetPolicy(ctx) }, ledger(ctx), estimate(ctx, entry, role, routeHint), { quota: quota(entry) });
    if (b.allow) return null;
    // #5/W3: stops that exist only because a cost is unknown (estimate, or a provider that reports no USD) are
    // waived for one run by an owner confirmation; a reached cap never is.
    const reasons = b.reason.split('; ');
    const onlyUnknown = b.state_hint === 'awaiting_approval' && reasons.every((x) => /estimate unknown|spend unknown/.test(x));
    if (onlyUnknown && nextRunAuthorized(ctx)) return null;
    const spendUnknown = reasons.some((x) => /spend unknown/.test(x));
    const evd = [`spent ${JSON.stringify(b.spent)}`, `unknown ${b.unknown_spend.join(',') || 'none'}`];
    const emit = [{ event_id: `budget-${ctx.id}-${ctx.k}`, kind: 'budget.threshold', payload: { reason: b.reason, spent: b.spent, state_hint: b.state_hint, entry, role } }];
    if (b.state_hint === 'waiting') {
      const delay = Math.min(MAX_BACKOFF_MS, b.backoff_ms ?? 60_000);
      return decide(ctx, decision('budget_wait', 'Start another run now?', [alt('wait for quota reset', 'no spend while exhausted', 'delay'), alt('start anyway', 'progress', 'provider refuses / overspends quota')],
        'wait for quota reset', { evidence: evd, expected_effect: `retry after ${delay} ms`, rationale: b.reason }), {
        patch: { ...patch, wait: { reason: 'quota', until_ms: now() + delay, resume_to, entry, role } }, to: 'waiting', reason: b.reason, emit });
    }
    const question = onlyUnknown
      ? (spendUnknown
        ? `Budget stop: the cap cannot be enforced for this provider because it reports no USD (${b.reason}). Confirm to authorize one more run, or raise/remove the cap.`
        : `Budget stop: ${b.reason}. Confirm to authorize one run of unknown cost, or raise/remove the cap.`)
      : `Budget cap reached: ${b.reason}. Raise the cap (approve with a higher budget_policy) or cancel the task.`;
    return askOwner(ctx, { kind: 'budget', question, reason: b.reason, classes: ['budget'] },
      { resume_to, kind: 'budget_stop', extra: { spent: b.spent, cap_reached: !onlyUnknown, entry, role }, patch }).then((r) => store.append(ctx.id, { event_id: emit[0].event_id, ...emit[0] }).then(() => r));
  }

  // ---------- failure classification and the no-progress rule ----------
  const passingRequired = (ctx, results) => results.filter((r) => r.required && r.status === 'pass').length;
  // Round 5: what the recorded evidence says about the current head: 'unevaluated' (a required check has no exit code on
  // it yet), 'pass' (every required check passed every run, never flaky, and no reviewer rejected it) or 'fail'.
  function headState(ctx) {
    if (ctx.verdicts.some((x) => x.verdict === 'reject')) return 'fail';
    if (ctx.cp.flaky.some((x) => x.endsWith(`@${ctx.head}`))) return 'fail';
    let state = 'pass';
    for (const c of ctx.v.acceptance_checks.filter((x) => x.required)) {
      const ev = ctx.evidence.filter((e) => e.check_id === c.id && e.exit !== null);
      if (!ev.length) return 'unevaluated';
      if (!ev.every((e) => e.exit === c.expect.exit)) state = 'fail';
    }
    return state;
  }
  // rung: the next escalation-ladder rung (D-026) when the task climbs; it goes first (a cheap model failing repeatedly is
  // the commonest no-progress cause), otherwise the evidence order below.
  function chooseStrategy(ctx, sig, routeAlt, rung = null) {
    if (rung) return 'escalate_model';
    const errorClass = sig.split(' :: ')[1] || '';
    const order = HARNESS_LIKE.test(errorClass) ? ['harness', 'replan', 'model'] : ['replan', 'model', 'harness'];
    for (const o of order) {
      if (ctx.cp.tried.includes(o)) continue;
      if (o === 'model' && !routeAlt) continue;
      if (o === 'harness' && ctx.cp.strategy?.harness === 'focused') continue;
      return o;
    }
    return null;
  }
  const lastDevStart = (ctx) => ctx.events.findLast((e) => e.kind === 'task.started' && e.payload.role === 'developer') || null;
  // The timeout signature of a stalled run (counted on its own, D-024); the §4 streak keeps the checks' signature so
  // that stalls and failing no-op runs on the same checks still converge (round 3).
  const stallSignature = (entry) => failureSignature({ test: `run_timeout:${entry ?? 'unknown'}`, errorClass: 'timeout' });
  async function onFailure(ctx, { signature, feedback, passing, failing = null, then = 'repair', thenPatch = {}, reviewOnly = false, p, extraEvidence = [], settleStall = true }) {
    const np = ctx.v.no_progress_policy;
    const cp = ctx.cp;
    // The developer is told its last run was stopped at the time limit (the run's changes were still checked).
    const stall = lastDevTimeout(ctx);
    const devStart = lastDevStart(ctx);
    const runLimit = devStart?.payload.limits ?? null;
    const stallMs = runLimit?.timeout_ms ?? runTimeoutMs;
    if (stall && feedback) feedback = { ...feedback, run_timeout: { run_id: stall, timeout_ms: stallMs, note: 'Your previous run was stopped at the time limit; its changes were kept and checked. Work in smaller steps. If the goal cannot be met as stated, stop early and explain why.' } };
    // D-012: new passing evidence = more required checks pass, or fewer tests fail inside the failing checks.
    const fewerFailing = failing != null && cp.best_failing != null && failing < cp.best_failing;
    const progress = passing > cp.best || fewerFailing;
    const bestFailing = failing == null ? cp.best_failing : cp.best_failing == null ? failing : Math.min(cp.best_failing, failing);
    const stagnation = np.iterations_without_progress ?? DEFAULT_ITERATIONS_WITHOUT_PROGRESS;
    const streak = { signature, count: signature === cp.streak.signature ? cp.streak.count + 1 : 1 };
    const stale = progress ? 0 : cp.stale + 1;
    const changes = progress ? 0 : cp.changes;
    const tried = progress ? [] : cp.tried;
    // The first measurement is not "new" evidence (best starts at 0): it never resets the stalled-run count.
    const measured = cp.best > 0 || cp.best_failing != null;
    // Round 5: a run sent to evaluation instead of a stall (timed out after committing, or no change on an unmeasured
    // head) counts as one now if its required checks fail without new passing evidence; a reviewer rejection of
    // passing checks does not make it one.
    const settle = !!devStart && cp.stall_pending === devStart.payload.run_id && cp.stall_run !== cp.stall_pending && settleStall && !reviewOnly && !(progress && measured);
    const stalls = progress && measured ? 0 : cp.stalls + (settle ? 1 : 0);
    const stall_run = settle ? cp.stall_pending : cp.stall_run;
    const stalledRun = !!devStart && stall_run === devStart.payload.run_id;
    const base = { streak, stale, best: Math.max(cp.best, passing), best_failing: bestFailing, changes, tried, stalls, stall_run, stall_pending: settleStall ? null : cp.stall_pending, claim: null, feedback, provider: null, verify_only: false, review_unavailable: 0 };
    const evidence = [`signature ${signature}`, `same signature ${streak.count}x in a row`, `iterations without new passing evidence: ${stale} (limit ${stagnation})`,
      `strategy changes without progress: ${changes}`, `failing tests ${failing ?? 'n/a'} (best ${cp.best_failing ?? 'n/a'})${progress ? ': progress' : ''}`,
      ...(stall ? [`developer run ${stall} hit the run timeout (${stallMs} ms): stall signature ${stallSignature(devStart?.payload.entry)}, stalled runs without progress ${stalls}`] : []),
      ...extraEvidence];
    // D-024: a model whose run limits set stall_runs_to_no_progress (cheap models on easy classes) stops after that many
    // stalled runs without new passing evidence, instead of the §4 strategy-change rounds. Not an attempt cap: a run
    // that makes progress resets it, and only runs killed by their own time limit count.
    const stallLimit = runLimit?.stall_runs_to_no_progress ?? null;
    if (stalledRun && !(progress && measured) && stallLimit && stalls >= stallLimit) {
      const entry = devStart.payload.entry;
      let rung = null;
      try { const r = await routeFor(ctx, p, { exclude: cp.exclude }); rung = r.escalation?.eligible ? nextRung(r, entry, { tried: cp.exclude }) : null; } catch { rung = null; }
      const diagnosis = `${stalls} stalled developer run(s) on ${entry} (stopped at the run time limit of ${stallMs} ms, changed nothing, or claimed the requirements impossible) without new passing evidence (stall_runs_to_no_progress ${stallLimit} for ${entry}, class ${workOf(ctx)}); last failure ${signature}.`;
      const next_action = `check whether the goal is achievable as stated; then resume${rung ? ` (the next rung is ${rung.id})` : ''}, pin a stronger model, split the task or raise its run_limits`;
      return decide(ctx, decision('no_progress', 'Stalled runs on this model: keep iterating?', [
        alt('suspend in waiting with a diagnosis', 'a cheap model that keeps running into its time limit is not converging; no further spend', 'goal not reached yet'),
        alt('another run on the same model', 'might converge', `${stalls} stalled run(s) already produced no new passing evidence`),
        alt(rung ? `escalate to ${rung.id}` : 'escalate', 'stronger model', 'stalls are not failing-check evidence that a stronger model helps; the owner decides on resume')],
      'suspend in waiting with a diagnosis', { evidence, expected_effect: 'no further runs until inputs change or the owner resumes', rationale: `Run limits (D-024): ${diagnosis}`, policy_ref: policyRef(p) }),
      { patch: { ...base, wait: { reason: 'no_progress', until_ms: null, resume_to: 'replan', diagnosis, next_action, policy_hash: policyRef(p) } }, to: 'waiting', reason: 'no_progress',
        emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'no_progress', diagnosis, next_action } }] });
    }
    const needChange = streak.count >= np.same_signature || stale >= stagnation;
    if (!needChange) {
      return decide(ctx, decision('repair', 'How to respond to this failure?', [
        alt('targeted repair with structured feedback', 'the failure is specific and new or below the no-progress threshold', 'another run'),
        alt('change strategy now', 'fresh approach', `premature: only ${streak.count} identical failure(s)`),
        alt('stop and ask the owner', 'no spend', 'a routine technical iteration is not an owner question')],
      'targeted repair with structured feedback', { evidence, expected_effect: then === 'repair' ? 'developer fixes the cause on the next run' : `${then} first, then repair`,
        rationale: `Failure ${signature}: repair with the failing tests and messages as feedback (no attempt counter; no-progress rule not triggered).`, policy_ref: policyRef(p) }),
      { patch: { ...base, ...thenPatch }, to: then, reason: `failure ${signature}` });
    }
    const routeAlt = await (async () => {
      try { const r = await routeFor(ctx, p, { exclude: [...cp.exclude, cp.strategy.entry] }); return r.choice ? r : null; } catch { return null; }
    })();
    // D-026: failing checks or a reviewer rejection climb the ladder (never off a pin, never below a floor: rungs are the
    // router's floored candidates, and a pinned task's only candidates are its pins).
    let rung = null;
    if (changes < np.strategy_changes_without_progress && cp.strategy?.entry) {
      try { const r = await routeFor(ctx, p, { exclude: cp.exclude }); rung = r.escalation?.eligible ? nextRung(r, cp.strategy.entry, { tried: cp.exclude }) : null; } catch { rung = null; }
    }
    const pick = changes >= np.strategy_changes_without_progress ? null : chooseStrategy(ctx, signature, routeAlt, rung);
    if (!pick) {
      const diagnosis = `${changes} strategy change(s) (${tried.join(', ') || 'none'}) produced no new passing evidence; last failure ${signature} seen ${streak.count}x.`;
      if (reviewOnly) {
        // T15: tests pass but the independent reviewer keeps rejecting: evidence alone cannot settle it.
        return askOwner(ctx, { kind: 'review_disagreement', question: `Deterministic checks pass but the independent reviewer keeps rejecting (${signature}). Owner review needed.`, reason: diagnosis, classes: ['review_disagreement'] },
          { resume_to: 'repair', kind: 'review_disagreement', policy_ref: policyRef(p) });
      }
      const next_action = 'inspect the diagnosis, then refine the goal/acceptance checks, adjust the project policy, or resume the task explicitly';
      return decide(ctx, decision('no_progress', 'Keep iterating?', [
        alt('suspend in waiting with a diagnosis', 'no runaway spend; revisited when inputs change', 'goal not reached yet'),
        alt('another strategy change', 'might converge', 'three strategy changes already produced no new passing evidence'),
        alt('declare failure', 'final', 'the goal may still be reachable with new inputs')],
      'suspend in waiting with a diagnosis', { evidence, expected_effect: 'no further runs until inputs change or the owner resumes', rationale: `No-progress rule (OWNER_DECISIONS §4): ${diagnosis}`, policy_ref: policyRef(p) }),
      { patch: { ...base, wait: { reason: 'no_progress', until_ms: null, resume_to: 'replan', diagnosis, next_action, policy_hash: policyRef(p) } }, to: 'waiting', reason: 'no_progress',
        emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'no_progress', diagnosis, next_action } }] });
    }
    const s = cp.strategy;
    const nextStrategy = { ...s, ...(pick === 'replan' ? { plan_rev: s.plan_rev + 1 } : pick === 'harness' ? { harness: 'focused' } : pick === 'escalate_model' ? { escalate_to: rung.id } : {}) };
    const alts = {
      ...(rung ? { escalate_model: alt(`escalate_model (${s.entry} -> ${rung.id})`, `next rung of the escalation ladder (tier ${rung.tier}, ${rung.billing}, est $${rung.cost_est_usd ?? 'unknown'})`, 'costs more per run') } : {}),
      replan: alt('replan', 'a new approach addresses a wrong plan', 'same model may repeat the same mistake'),
      model: alt(`different model${routeAlt ? ` (${routeAlt.choice})` : ''}`, routeAlt ? `router ranks ${routeAlt.choice} next (${routeAlt.rationale.at(-1)})` : 'n/a', routeAlt ? 'unknown fit for this failure' : 'no other feasible model inside the allowlists'),
      harness: alt('harness change (focused reproduction, full failing output)', 'helps when the failure is not understood or the evidence is incomplete', 'more context per run'),
    };
    return decide(ctx, decision('strategy_change', `Same failure ${streak.count}x (or ${stale} iterations without new evidence): which strategy change?`,
      [alts[pick], ...Object.entries(alts).filter(([k2]) => k2 !== pick).map(([, a]) => a), alt('blind retry', 'cheap', 'forbidden by the no-progress rule')],
      pick, { evidence: [...evidence, `already tried: ${tried.join(', ') || 'none'}`, ...(rung ? [`escalation ${s.entry} -> ${rung.id}`] : [])], expected_effect: pick === 'escalate_model' ? `next run on ${rung.id}` : `next run uses ${pick}`,
        rationale: pick === 'escalate_model'
          ? `No-progress rule: forced strategy change #${changes + 1}. Escalation ladder (D-026): ${s.entry} failed ${streak.count}x; the next rung is ${rung.id}.`
          : `No-progress rule: forced strategy change #${changes + 1}. Chose ${pick} by evidence (error class ${signature.split(' :: ')[1]}; untried options in evidence order).`, policy_ref: policyRef(p) }),
    { patch: { ...base, streak: { signature, count: 0 }, stale: 0, changes: changes + 1, tried: [...tried, pick], strategy: nextStrategy,
      exclude: ['model', 'escalate_model'].includes(pick) ? [...cp.exclude, s.entry] : cp.exclude }, to: 'replan', reason: `strategy change: ${pick}` });
  }

  // Provider/runtime errors from a developer run (T12, GL06): router fallback taxonomy, bounded and recorded.
  // One classifier for developer and reviewer runs (W4b/W5). Billed = measured spend, an incomplete record, or a run
  // that started and then failed with unknown usage (unknown is not zero). Unbilled = refused at the door: rate limit,
  // runtime unavailable, auth. -> boolean
  function isBilled({ started, errorClass, usage }) {
    const u = usage || {};
    if (u.incomplete === true || ['input_tokens', 'output_tokens', 'usd'].some((k) => typeof u[k] === 'number' && u[k] > 0)) return true;
    if (!started) return false;
    return !UNBILLED_CLASSES.includes(errorClass);
  }
  // run_id of the latest developer run when it ended at the run timeout and this is the first failure answered since
  // (its run_timeout note is newer than any repair/strategy decision), else null: the notice is given once per stall.
  const ANSWERED = ['repair', 'strategy_change', 'no_progress'];
  const lastDevTimeout = (ctx) => {
    const run_id = ctx.events.findLast((e) => e.kind === 'task.started' && e.payload.role === 'developer')?.payload.run_id;
    if (!run_id || !ctx.events.some((e) => e.kind === 'tool.failed' && e.payload.run_id === run_id && e.payload.error?.class === 'timeout')) return null;
    const ds = ctx.v.decisions.filter((d) => d.loop);
    const at = ds.findLastIndex((d) => d.kind === 'run_timeout' && d.decision_id.endsWith(`-stall-${run_id}`));
    return at >= 0 && !ds.slice(at + 1).some((d) => ANSWERED.includes(d.kind)) ? run_id : null;
  };
  const billedRun = (ctx, run_id, errorClass) => {
    const u = ctx.events.find((e) => e.kind === 'usage.recorded' && e.payload.run_id === run_id)?.payload;
    const started = ctx.events.some((e) => e.kind === 'action.confirmed' && e.payload.effect_id === `devrun-${run_id}`) && !ctx.events.some((e) => e.kind === 'tool.failed' && e.payload.run_id === run_id && e.payload.not_started);
    return isBilled({ started, errorClass, usage: u });
  };
  // OWNER_DECISIONS §4 as clarified: unbilled waits may back off on a timer; billed identical retries count toward the
  // no-progress rule and suspend (waiting, until_ms:null, diagnosis, next action). -> step result
  function suspend(ctx, kind, { diagnosis, next_action, evidence, resume_to, p, extraPatch = {} }) {
    return decide(ctx, decision(kind, 'Keep retrying?', [
      alt('suspend in waiting with a diagnosis', 'no runaway spend; revisited when inputs change', 'goal not reached yet'),
      alt('retry again', 'might clear', 'billed identical retries already failed; nothing has changed between tries'),
      alt('declare failure', 'final', 'new inputs (runtime fixed, owner resume) can still succeed')],
    'suspend in waiting with a diagnosis', { evidence, expected_effect: 'no further runs until inputs change or the owner resumes', rationale: `No-progress rule (OWNER_DECISIONS §4): ${diagnosis}`, policy_ref: policyRef(p) }),
    { patch: { ...extraPatch, wait: { reason: 'no_progress', until_ms: null, resume_to, diagnosis, next_action, policy_hash: policyRef(p) } }, to: 'waiting', reason: 'no_progress',
      emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'no_progress', diagnosis, next_action } }] });
  }

  async function onRunError(ctx, err, p, run_id) {
    const s = ctx.cp.strategy;
    const prev = ctx.cp.provider;
    const attempt = prev && prev.class === err.class && prev.entry === s.entry ? prev.count : 0;
    let r;
    try { r = await routeFor(ctx, p, { exclude: ctx.cp.exclude.filter((x) => x !== s.entry) }); } catch { r = null; }
    const plan = r?.candidates?.some((c) => c.id === s.entry)
      ? fallbackPlan(r, { error_class: err.class, failed: s.entry, attempt, retry_after_ms: err.retry_after_ms })
      : { action: ['rate_limit', 'timeout', 'crash', 'unavailable'].includes(err.class) ? 'wait' : 'approval', next: null, delay_ms: 60_000, reason: `${err.class}: current runtime no longer routable` };
    const provider = { class: err.class, entry: s.entry, count: attempt + 1 };
    const evidence = [`error class ${err.class}`, `retry_after_ms ${err.retry_after_ms ?? 'unknown'}`, `consecutive ${attempt + 1} on ${s.entry}`];
    const d = (chosen, effect) => decision('provider_fallback', `Developer run failed with ${err.class}: what next?`, [
      alt('backoff and retry the same runtime', 'transient errors clear', 'delay'), alt('switch to a compatible runtime', 'keeps progress', 'different model behaviour'),
      alt('compact context / larger model', 'fixes context exhaustion', 'loses detail'), alt('ask the owner', 'safe for auth/permission', 'routine provider errors are not owner questions')],
    chosen, { evidence, expected_effect: effect, rationale: plan.reason, policy_ref: policyRef(p) });
    const emit = err.class === 'rate_limit' ? [{ event_id: `ratelimited-${ctx.id}-${ctx.k}`, kind: 'model.rate_limited', payload: { entry: s.entry, retry_after_ms: err.retry_after_ms ?? null } }] : [];
    // #4: a billed failure repeated on the same runtime with no switch left is a blind retry loop: suspend.
    if (['backoff', 'wait'].includes(plan.action) && billedRun(ctx, run_id, err.class) && provider.count >= ctx.v.no_progress_policy.same_signature) {
      return suspend(ctx, 'no_progress', { p, resume_to: 'repair', extraPatch: { provider },
        diagnosis: `developer runtime ${s.entry} failed with ${err.class} ${provider.count}x in a row after billing; ${plan.reason}`,
        next_action: `check ${s.entry} health or enable another compatible runtime, then resume the task`, evidence });
    }
    switch (plan.action) {
      case 'backoff': case 'wait': {
        const delay = Math.min(MAX_BACKOFF_MS, plan.delay_ms ?? 60_000);
        return decide(ctx, d('backoff and retry the same runtime', `waiting ${delay} ms, then repair`), {
          patch: { provider, wait: { reason: err.class, until_ms: now() + delay, resume_to: 'repair', entry: s.entry, role: 'developer' } }, to: 'waiting', reason: `${err.class}: backoff ${delay} ms`, emit });
      }
      case 'switch':
        return decide(ctx, d('switch to a compatible runtime', `next run on ${plan.next}`), {
          patch: { provider: { class: err.class, entry: plan.next, count: 0 }, strategy: { ...s, entry: plan.next, compact: true }, exclude: [...new Set([...ctx.cp.exclude, s.entry])] },
          to: 'repair', reason: `${err.class}: fallback to ${plan.next}`, emit });
      case 'compact':
        return decide(ctx, d('compact context / larger model', 'fresh run with a summarized context'), {
          patch: { provider, strategy: { ...s, compact: true } }, to: 'repair', reason: 'context overflow: compaction' });
      case 'replan':
        return decide(ctx, d('compact context / larger model', 'replan with a smaller scope'), {
          patch: { provider, strategy: { ...s, compact: true, plan_rev: s.plan_rev + 1 } }, to: 'replan', reason: plan.reason });
      default:
        return askOwner(ctx, { kind: 'runtime_error', question: `Developer runtime error ${err.class}: ${plan.reason}`, reason: plan.reason, classes: [err.class] },
          { resume_to: 'repair', kind: 'provider_fallback', policy_ref: policyRef(p) });
    }
  }

  // ---------- infrastructure (GL06 / spec §12.4) ----------
  const resumeTargetFor = (state) => ({ created: 'clarified', clarified: 'clarified', planned: 'planned', ready: 'ready', repair: 'repair', replan: 'replan',
    executing: 'repair', evaluating: 'ready', integrating: 'repair', release_verifying: 'repair', unknown_external_effect: 'repair' }[state] || 'ready');
  async function onInfra(ctx, e) {
    const type = INFRA_CODES[e.code] || 'health.unknown';
    let incident_id = null;
    try {
      const op = { type, host_id: hostId, symptom: `goal loop ${ctx.v.status}: ${e.code}`, action: 'investigate', dedup_key: `${type}:${hostId}:goal-loop` };
      // Request-only handle (System Operations' `requester`): the loop can never execute an operation itself.
      const req = opsRequester || systemOps?.requester;
      if (req?.request) incident_id = (await req.request({ task_id: ctx.id, role: ACTOR, op })).incident_id;
      else if (systemOps?.requestOperation) incident_id = (await systemOps.requestOperation({ task_id: ctx.id, role: ACTOR, op })).incident_id;
      else if (incidents?.report) {
        incident_id = (await incidents.report({ type, host_id: hostId, symptom: `goal loop ${ctx.v.status}: ${e.code}`, reporter: { reporter: ACTOR, task_id: ctx.id } })).incident.incident_id;
      }
    } catch { incident_id = null; }
    const resume_to = resumeTargetFor(ctx.v.status);
    return decide(ctx, decision('infra_incident', 'Infrastructure failed under the task: what next?', [
      alt('open an incident and wait', 'System Operations owns host/service recovery', 'delay'), alt('retry immediately', 'fast', 'repeats against a broken host'),
      alt('repair on the host', 'fixes it', 'developers may only request operations')], 'open an incident and wait', {
      evidence: [`${e.code}: ${String(e.message).slice(0, 200)}`, `incident ${incident_id ?? 'not recorded (no system ops wired)'}`], expected_effect: 'resume after backoff once admission is open',
      rationale: 'Infrastructure failure is routed to System Operations; the task keeps its state.' }), {
      patch: { wait: { reason: 'infra', until_ms: now() + 5 * 60_000, resume_to, incident_id }, verify_only: ctx.v.status === 'evaluating' }, to: 'waiting', reason: `infra ${e.code}` });
  }

  // ---------- git helpers (task worktree only) ----------
  const g = (cwd, args) => git(args, { cwd });
  const headOf = async (cwd) => (await g(cwd, ['rev-parse', 'HEAD'])).trim();
  async function commitAll(id, cwd, msg) {
    const stop = async () => { if (await isCancelled(id)) throw coded('E_CANCELLED', `task ${id} is cancelled`); await fence(); };   // T14 + fence before the commit
    await stop();
    await g(cwd, ['add', '-A']);
    const staged = (await g(cwd, ['diff', '--cached', '--name-only'])).trim();
    await stop();   // re-checked right before the write that names a SHA
    if (staged) await g(cwd, ['-c', `user.name=${commitIdentity.name}`, '-c', `user.email=${commitIdentity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
    return headOf(cwd);
  }
  // #1/W1: the worktree lease is renewed at every dispatch/commit through worktrees.renew(), which also re-acquires a
  // lapsed lease for the same owner and rewrites the worktree meta (remove()/renew() keep working). A live or
  // intervening foreign holder suspends the task until inputs change. -> null | step result
  async function ensureLease(ctx, resume_to) {
    const wt = ctx.cp.worktree;
    if (!leases || !wt?.lease) return null;
    let r;
    // After the owner resumed a lease_held wait, an intervening (now released) holder is acknowledged; head and
    // evidence are revalidated before anything counts.
    try { r = await worktrees.renew(wt.path, { owner: ACTOR, acknowledgeFence: ctx.cp.lease_ack === true }); } catch (e) { r = { error: e }; }
    if (r.lease) {
      if (!r.reacquired) return null;
      const worktree = { ...wt, lease: r.lease };
      await note(ctx, `lease-${r.lease.token}`, decision('lease_reacquired', 'The worktree lease lapsed: re-acquire it?', [
        alt('re-acquire as the same owner', 'nobody held it since; the worktree is still ours; head is revalidated before any evidence counts', 'new fencing token'),
        alt('suspend', 'cautious', 'no reason: the resource is free and owned by this task')], 're-acquire as the same owner', {
        evidence: ['renew E_EXPIRED', `new token ${r.lease.token}`], expected_effect: 'continue with a fresh lease (worktree meta updated)', rationale: 'Lease expired while the task was waiting or long-running; re-acquired under the same owner.' }),
      { worktree, lease_ack: false });
      ctx.cp.worktree = worktree;
      return null;
    }
    const code = r.error?.code;
    if (['E_HELD', 'E_FENCED', 'E_FOREIGN'].includes(code)) {
      const diagnosis = `worktree lease ${wt.lease.resource}: ${code}${r.error.holder?.owner ? ` (held by ${r.error.holder.owner})` : ''}`;
      return decide(ctx, decision('lease_unavailable', 'Another owner holds or held the worktree lease: proceed?', [alt('suspend until inputs change', 'never write under someone else\'s lease', 'blocked'), alt('proceed', 'progress', 'unfenced writes')],
        'suspend until inputs change', { evidence: [diagnosis], expected_effect: 'no writes until the holder releases or the owner resumes', rationale: 'Fail closed on a foreign lease holder.' }),
      { patch: { wait: { reason: 'lease_held', until_ms: null, resume_to, diagnosis, next_action: 'check who holds the worktree lease, release it, then resume the task', policy_hash: policyRef(readPolicy(ctx)) } }, to: 'waiting', reason: 'lease held by another owner' });
    }
    // Backend unavailable: unbilled, timed retry (absence of an answer is not availability).
    return decide(ctx, decision('lease_unavailable', 'Lease backend unavailable: proceed?', [alt('wait', 'absence of a lease is not availability', 'delay'), alt('proceed', 'progress', 'unfenced writes')],
      'wait', { evidence: [`renew ${code ?? 'unknown'}: ${String(r.error?.message ?? '').slice(0, 200)}`], expected_effect: 'retry after backoff', rationale: 'Fail closed on the worktree lease.' }),
    { patch: { wait: { reason: 'lease_unavailable', until_ms: now() + 60_000, resume_to } }, to: 'waiting', reason: 'lease unavailable' });
  }

  // ---------- states ----------
  async function sCreated(ctx) {
    const p = readPolicy(ctx);
    const g0 = gate(ctx, p);
    if (g0) return askOwner(ctx, g0, { resume_to: 'clarified', policy_ref: policyRef(p) });
    const interpretation = { effort: null, independent_review: true, delivery: wantsDelivery(ctx.v), checks: ctx.v.acceptance_checks.map((c) => c.id) };
    return decide(ctx, decision('interpret', 'How to interpret the goal where it is silent?', [
      alt('documented safe defaults', 'reversible; no owner question for routine choices', 'may not match an unstated preference'),
      alt('ask the owner', 'exact intent', 'routine choice; the contract says decide and record')],
    'documented safe defaults', { evidence: [`policy ${policyRef(p)}`, `${interpretation.checks.length} acceptance check(s)`, `delivery requested: ${interpretation.delivery}`],
      expected_effect: 'plan with runtime-default effort, mandatory independent review, delivery only when requested',
      rationale: 'Ambiguities resolved by reversible defaults: effort = runtime default; an independent reviewer is always required; integration only if the task asks for delivery (review_policy.deliver or an integration resource).',
      policy_ref: policyRef(p) }), { patch: { interpretation }, to: 'clarified', reason: 'goal interpreted' });
  }

  async function sClarified(ctx) {
    const p = readPolicy(ctx);
    const g0 = gate(ctx, p);
    if (g0) return askOwner(ctx, g0, { resume_to: 'clarified', policy_ref: policyRef(p) });
    // Inspect reality: the base commit must exist; unavailable evidence fails loudly (waiting with the error).
    let base;
    try { base = (await g(ctx.v.repository, ['rev-parse', '--verify', `${ctx.v.base_sha}^{commit}`])).trim(); } catch (e) {
      return decide(ctx, decision('inspect_failed', 'Base commit unreadable: what next?', [alt('wait and re-inspect', 'never treats unknown as fine', 'delay'), alt('continue on HEAD', 'progress', 'unverified base')],
        'wait and re-inspect', { evidence: [String(e.stderr || e.message).slice(0, 300)], expected_effect: 're-inspect after backoff', rationale: 'Evidence unavailable: base_sha cannot be resolved in the repository.' }),
      { patch: { wait: { reason: 'evidence_unavailable', until_ms: now() + 5 * 60_000, resume_to: 'clarified' } }, to: 'waiting', reason: 'base_sha unavailable' });
    }
    let wt = ctx.cp.worktree;
    if (!wt) {
      if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      // #2: a worktree created before a crash (meta written) is ours: reuse it before trying to acquire again.
      const target = path.join(worktreeRoot, ctx.id);
      const mine = () => { try { const o = worktrees.owner(target); return o && o.task_id === ctx.id && o.owner === ACTOR ? o : null; } catch { return null; } };
      const reuse = (o) => ({ path: fs.realpathSync(target), branch: o.branch, lease: o.lease });
      const o0 = mine();
      if (o0) wt = reuse(o0);
      else {
        try {
          const c = await worktrees.create({ repo: ctx.v.repository, task_id: ctx.id, base_sha: base, owner: ACTOR });
          wt = { path: c.path, branch: c.branch, lease: c.lease };
        } catch (e) {
          const o = mine();
          if (o) wt = reuse(o);
          else if (e.code === 'E_HELD') {
            // Held but no worktree recorded: a crash inside create (ours) or a foreign holder. Wait for the lease to lapse.
            const until = Math.max(now() + 60_000, Number(e.holder?.expires_at) || 0);
            return decide(ctx, decision('lease_unavailable', 'Worktree lease held with no worktree recorded: proceed?', [alt('wait for the lease to lapse', 'never two holders', 'delay'), alt('steal it', 'progress', 'unfenced')],
              'wait for the lease to lapse', { evidence: [`holder ${e.holder?.owner ?? 'unknown'}`], expected_effect: 'retry create after expiry', rationale: 'Fail closed on an existing lease.' }),
            { patch: { wait: { reason: 'lease_held', until_ms: until, resume_to: 'clarified' } }, to: 'waiting', reason: 'worktree lease held' });
          } else throw e;
        }
      }
    }
    const plan = { rev: 0, dag: [{ id: 'develop', role: 'developer' }, { id: 'verify', role: 'tester', after: ['develop'] }, { id: 'review', role: 'tester', after: ['verify'] },
      ...(ctx.cp.interpretation?.delivery ? [{ id: 'integrate', role: 'integration', after: ['review'] }] : [])] };
    return decide(ctx, decision('plan', 'How to staff and sequence the work?', [
      alt('one developer + deterministic checks + independent reviewer', 'single scope; cheapest verified path', 'no parallelism'),
      alt('planner + parallel developers', 'parallelism', 'no independent subtasks in this scope; more merge risk'),
      alt('developer only', 'cheapest', 'violates the independent-evaluation contract')],
    'one developer + deterministic checks + independent reviewer', { evidence: [`base ${base}`, `worktree ${wt.branch}`], expected_effect: 'route a developer runtime next',
      rationale: 'A single-scope task gets one developer in an isolated worktree, deterministic verification on the exact SHA, then an independent reviewer (different model).', policy_ref: policyRef(p) }),
    { patch: { worktree: wt, plan }, to: 'planned', reason: 'planned' });
  }

  async function sPlanned(ctx) {
    const p = readPolicy(ctx);
    const g0 = gate(ctx, p);
    if (g0) return askOwner(ctx, g0, { resume_to: 'planned', policy_ref: policyRef(p) });
    const r = await routeFor(ctx, p);
    await store.recordDecision(ctx.id, r.decision);   // the router's own §9 record (deterministic id, >= 2 alternatives)
    if (!r.choice || r.requires_approval) {
      const granted = grantsOf(ctx).has(routeKey(ctx));
      // #15: no feasible runtime is not fixed by time; #8: a granted routing question the router still refuses is
      // never asked again. Both wait for new inputs (policy, registry, owner resume) with a diagnosis.
      if (r.state_hint === 'waiting' || granted) {
        const diagnosis = granted ? `routing refused even with the owner's approval: ${r.rationale.join(' ')}` : `no runtime passes the floors: ${r.rejected.slice(0, 5).map((x) => `${x.id}: ${x.reason}`).join('; ')}`;
        return decide(ctx, decision('no_route', 'No runtime can be routed: what next?', [alt('wait until inputs change', 'never routes around the floors; no blind retries', 'blocked until policy, runtimes or the task change'), alt('relax the floors', 'progress', 'not permitted')],
          'wait until inputs change', { evidence: [`route ${r.decision.decision_id}`, ...r.rejected.slice(0, 5).map((x) => `${x.id}: ${x.reason}`)], expected_effect: 're-route when inputs change', rationale: r.rationale.join(' ') }),
        { patch: { wait: { reason: 'no_route', until_ms: null, resume_to: 'planned', diagnosis, next_action: 'install/enable a compatible runtime, widen the allowlists or change the task; then resume', policy_hash: policyRef(p) } },
          to: 'waiting', reason: 'no compatible runtime' });
      }
      return askOwner(ctx, { kind: 'route', question: `Routing needs the owner: ${r.rationale.join(' ')}`, reason: r.rationale.join(' '), classes: ['route'], keys: [routeKey(ctx)] }, { resume_to: 'planned', policy_ref: policyRef(p) });
    }
    const { escalate_to: up = null, ...prev } = ctx.cp.strategy || { harness: 'standard', plan_rev: 0, compact: false };
    // D-026: a recorded escalation names its rung; it is used while the router still has it among the floored candidates.
    const climbed = up && r.candidates.some((c) => c.id === up) ? up : null;
    const choice = climbed || r.choice;
    shadowNote(ctx, 'developer', choice, ctx.v.base_sha);
    const strategy = { ...prev, entry: choice, effort: ctx.cp.interpretation?.effort ?? null,
      cost_est_usd: r.candidates.find((c) => c.id === choice)?.cost_est_usd ?? null };   // W2b: the developer gate's first estimate
    const alts = r.candidates.slice(0, 4).map((c) => alt(c.id, `score ${c.score}`, c.cost_est_usd == null ? 'cost unknown' : `est $${c.cost_est_usd}`));
    if (climbed && !alts.some((a) => a.option === climbed)) alts.unshift(alt(climbed, 'next escalation rung', 'costs more per run'));
    if (alts.length < 2) alts.push(alt('wait for another compatible runtime', 'more choice', 'only one runtime passes the floors; waiting adds nothing'));
    const why = climbed ? `Escalation ladder (D-026): the strategy change escalated to ${climbed}.${up !== r.choice ? ` (router's own pick: ${r.choice})` : ''}`
      : up ? `Escalation to ${up} no longer passes the floors; router selection used: ${r.rationale.at(-1)}` : `Router selection used for this V2 task: ${r.rationale.at(-1)}`;
    return decide(ctx, decision('assign_developer', 'Which runtime/model runs the developer role?', alts,
      choice, { evidence: [`router decision ${r.decision.decision_id}`, ...(up ? [`escalate_to ${up}`] : [])], expected_effect: `developer runs on ${choice}`, rationale: why,
        confidence: r.confidence, policy_ref: policyRef(p) }), { patch: { strategy }, to: 'ready', reason: `assigned ${choice}` });
  }

  // ready/repair -> executing: preflight before every start (cancel, admission, policy, budget, lease).
  async function sDispatch(ctx) {
    if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
    const p = readPolicy(ctx);
    const g0 = gate(ctx, p);
    if (g0) return askOwner(ctx, g0, { resume_to: ctx.v.status === 'repair' ? 'repair' : 'ready', policy_ref: policyRef(p) });
    if (admission?.isPaused?.()) {
      return decide(ctx, decision('admission_paused', 'Start a run while admission is paused?', [alt('wait', 'System Operations paused new work', 'delay'), alt('start anyway', 'progress', 'adds load during an incident')],
        'wait', { evidence: [`reasons ${admission.reasons?.().join(',')}`], expected_effect: 'retry after backoff', rationale: 'Admission is paused by System Operations.' }),
      { patch: { wait: { reason: 'admission_paused', until_ms: now() + 60_000, resume_to: ctx.v.status } }, to: 'waiting', reason: 'admission paused' });
    }
    if (!ctx.cp.verify_only) {
      const stop = await budgetGate(ctx, ctx.cp.strategy.entry, 'developer', ctx.v.status === 'repair' ? 'repair' : 'ready');
      if (stop) return stop;
    }
    const lw = await ensureLease(ctx, ctx.v.status);
    if (lw) return lw;
    const bw = await branchGate(ctx, ctx.v.status);
    if (bw) return bw;
    return move(ctx, 'executing', ctx.cp.verify_only ? 'resume verification' : `dispatch run ${ctx.id}.run${runNumber(ctx) + 1}`);
  }
  // X7: work is only committed and accepted on the task branch; anything else (another branch, detached HEAD) suspends
  // the task with a diagnosis. -> null | step result
  async function branchGate(ctx, resume_to, st = null) {
    const wt = ctx.cp.worktree;
    if (!wt?.branch) return null;
    const cur = st || await worktrees.status(wt.path);
    if (cur.branch === wt.branch) return null;
    const diagnosis = `worktree is on ${cur.branch === 'HEAD' ? 'a detached HEAD' : `branch ${cur.branch}`} at ${short(cur.head)}, not on the task branch ${wt.branch}`;
    return decide(ctx, decision('off_task_branch', 'The worktree left the task branch: continue?', [
      alt('suspend until the owner restores the task branch', 'a SHA the task branch does not contain must never be accepted or delivered', 'blocked'),
      alt('commit/verify where it is', 'progress', 'evidence and delivery would name the wrong branch'),
      alt('switch back automatically', 'progress', 'could discard someone else\'s work in the worktree')], 'suspend until the owner restores the task branch', {
      evidence: [diagnosis], expected_effect: 'no commit or acceptance until the worktree is back on its branch', rationale: 'Out-of-band checkout detected.' }),
    { patch: { wait: { reason: 'off_task_branch', until_ms: null, resume_to, diagnosis, next_action: `check out ${wt.branch} in the task worktree (keep or discard the foreign commits deliberately), then resume`, policy_hash: policyRef(readPolicy(ctx)) } },
      to: 'waiting', reason: 'worktree off the task branch' });
  }
  const runNumber = (ctx) => ctx.v.history.filter((h) => h.to === 'executing').length;

  async function sExecuting(ctx) {
    const p = readPolicy(ctx);
    if (ctx.cp.verify_only) return move(ctx, 'evaluating', 'verification only (no developer change pending)');
    const s = ctx.cp.strategy;
    const run_id = `${ctx.id}.run${runNumber(ctx)}`;
    const effect_id = `devrun-${run_id}`;
    const wt = ctx.cp.worktree;
    if (!ctx.v.effects.some((e) => e.effect_id === effect_id)) {
      if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      if (!p.ok) return askOwner(ctx, { kind: 'clarification', ...clarificationFor(p), classes: [] }, { resume_to: 'repair' });
      await store.snapshotPolicy(ctx.id, p.policy, { run_id });   // re-read at the start of every run, immutable within it
      const adapter = adapterFor(s.entry);
      const entry = registry.get(s.entry);
      await store.recordEffect(ctx.id, { effect_id, idempotency_key: `devrun:${run_id}`, kind: 'developer_run', phase: 'attempted' });
      // D-024: this run's limits (task > project > registry > engine), recorded with the start; the stall rule reads them back.
      const lim = runLimitsFor(ctx, p, entry, adapter, 'developer');
      const effort = s.effort ?? lim.effort;
      const limits = { timeout_ms: lim.timeout_ms, max_steps: lim.max_steps, effort, context_mode: lim.context_mode, stall_runs_to_no_progress: lim.stall_runs_to_no_progress };
      await store.append(ctx.id, { event_id: `start-${run_id}`, kind: 'task.started', payload: { run_id, role: 'developer', entry: s.entry, runtime: entry?.runtime ?? null, model: entry?.model ?? null, effort, strategy: s,
        limits, limit_sources: lim.source, ...(lim.notes.length ? { limits_ignored: lim.notes } : {}) } });
      let run = null, error = null;
      try {
        if (!adapter) throw Object.assign(new Error(`no adapter for ${s.entry}`), { code: 'ENOENT' });
        // The policy changed since routing and this entry can no longer honour it: not started, rerouted like an outage.
        if (lim.error) throw Object.assign(new Error(lim.error), { code: 'ENOENT' });
        const summary = s.compact ? compactSummary(ctx) : null;
        run = adapter.start({ task_id: ctx.id, run_id: run_id.replace(/[^\w.-]/g, '_'), cwd: wt.path, model: entry?.model, effort: effort ?? undefined, timeout_ms: lim.timeout_ms, role: 'developer',
          ...(lim.max_steps ? { max_steps: lim.max_steps } : {}), prompt: developerPrompt({ task: ctx.v, strategy: s, feedback: ctx.cp.feedback, summary, worktree: wt }) });
        active.set(ctx.id, { adapter, run });
        const r = await run.done;
        error = r.error;
      } catch (e) { error = adapter ? adapter.normalizeError(e) : { class: 'unavailable', retryable: true, retry_after_ms: null }; }
      finally { active.delete(ctx.id); }
      if (ctl.lost) return result(ctx, null, 'controller lease lost during the run: no writes (the new controller reconciles it)', { idle: true });
      if (await isCancelled(ctx.id)) {   // T14: no writes after cancel except the truthful effect outcome
        await store.recordEffect(ctx.id, { effect_id, phase: 'failed' });
        return result(ctx, 'cancelled', 'cancelled during run', { terminal: true, transitioned: false });
      }
      const u = run ? adapter.collectUsage(run) : { input_tokens: null, output_tokens: null, usd: null };
      await store.recordUsage(ctx.id, { runtime: entry?.runtime ?? null, provider: entry?.provider ?? null, model: entry?.model ?? null, ...billingOf(entry), run_id, ...u }, { event_id: `usage-${run_id}` });
      if (error) await store.append(ctx.id, { event_id: `fail-${run_id}`, kind: 'tool.failed', payload: { run_id, error, ...(run ? {} : { not_started: true }) } });
      // Actions the agent asked for are checked against policy, never executed by the loop (GL09).
      const grants = grantsOf(ctx);
      const reqs = (run?.events || []).filter((e) => e.type === 'action_request').slice(0, 20);
      let n = 0;
      for (const a of reqs) {
        // The class comes from the operation itself (argv/text), never from the model's own label for it.
        const argv = Array.isArray(a.argv) && a.argv.length ? a.argv.map(String) : undefined;
        const action = { class: argv ? 'command' : 'request', argv, text: [a.text, a.class].filter(Boolean).map(String).join(' ') || undefined };
        const r = allowed(p.policy, ctx.v, action, grants, actionKey(action, `agent:${run_id}:`));
        if (!r.ok) await store.append(ctx.id, { event_id: `actreq-${run_id}-${n++}`, kind: 'approval.requested', payload: { run_id, action, reason: r.reason, classes: r.classes || [], key: r.key, prohibited: !r.needs_approval } });
      }
      // The developer's own impossibility claim (never proof): an independent feasibility review judges it on failing checks.
      const claim = run ? parseImpossibleClaim(run.events) : null;
      if (claim) {
        await note(ctx, `claim-${run_id}`, decision('impossible_claim', `Developer run ${run_id} says the requirements are impossible: what counts?`, [
          alt('check the run as usual; on failing checks ask an independent reviewer whether the requirements can be met', 'a model\'s claim is not evidence', 'one reviewer run'),
          alt('stop now', 'fast', 'a developer could give up on any hard task')],
        'check the run as usual; on failing checks ask an independent reviewer whether the requirements can be met', { evidence: [`run ${run_id}`, `claim: ${claim.diagnosis.slice(0, 300)}`],
          expected_effect: 'feasibility review if the required checks fail', rationale: 'OWNER_DECISIONS §12.2: stop fast on impossible requirements, but only on independent judgement and failing checks.' }),
        { claim: { run_id, diagnosis: claim.diagnosis }, ...(limits.stall_runs_to_no_progress ? { stalls: ctx.cp.stalls + 1, stall_run: run_id } : {}) });
      }
      await store.recordEffect(ctx.id, { effect_id, phase: 'confirmed' });
      ctx = await load(ctx.id);
    }
    const failed = ctx.events.find((e) => e.kind === 'tool.failed' && e.payload.run_id === run_id);
    // T14: a replayed step after a confirmed run writes nothing (no decision, no commit) once the task is cancelled.
    if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
    const reqs = ctx.events.filter((e) => e.kind === 'approval.requested' && e.payload.run_id === run_id);
    if (reqs.length) {
      return askOwner(ctx, { kind: 'agent_action', question: `The developer asked for restricted action(s): ${reqs.map((e) => `${e.payload.action.class}${e.payload.action.argv ? ` (${e.payload.action.argv.join(' ')})` : ''}`).join('; ')}. Not executed.`,
        reason: reqs.map((e) => e.payload.reason).join('; '), classes: [...new Set(reqs.flatMap((e) => e.payload.classes))], keys: reqs.map((e) => e.payload.key),
        actions: reqs.map((e) => e.payload.action) }, { resume_to: 'repair', kind: 'agent_action', policy_ref: policyRef(p), extra: { actions: reqs.map((e) => e.payload.action) } });
    }
    // A run that used up its own clock (our run timer, class `timeout`) was billed work that produced no verdict, not a
    // transient provider error: its changes are committed and checked like any other run, so repeated stalls feed the
    // no-progress rule (same signature, no new passing evidence) instead of a timed backoff (OWNER_DECISIONS §4).
    const stalled = failed?.payload.error?.class === 'timeout' && billedRun(ctx, run_id, 'timeout');
    if (failed && !stalled) return onRunError(ctx, failed.payload.error, p, run_id);
    // One stall per run at most (D-024): a timeout, an impossibility claim or a run that changed nothing.
    const counted = ctx.cp.stall_run === run_id;
    // Commit what the developer produced so the evidence names an exact SHA.
    const lw = await ensureLease(ctx, 'repair');   // the run's files stay in the worktree for the next run
    if (lw) return lw;
    const bw = await branchGate(ctx, 'repair');
    if (bw) return bw;
    const prev = ctx.head ?? ctx.v.base_sha;
    const head = await commitAll(ctx.id, wt.path, `v2task ${ctx.id}: ${run_id}`);
    const runLimits = lastDevStart(ctx)?.payload.run_id === run_id ? lastDevStart(ctx).payload.limits : null;
    // Round 5: a run that committed a change, or that left a head holding a change no check has measured yet or one
    // that passes, goes to evaluation on that commit. It becomes a stall only if the checks then fail without progress
    // (stall_pending, settled in onFailure); the clock alone is not a verdict.
    const unchanged = head === prev;
    const pending = unchanged && head !== ctx.v.base_sha ? headState(ctx) : null;
    const evaluate = !unchanged || pending === 'unevaluated' || pending === 'pass';
    const why = unchanged ? `head ${short(head)} unchanged, ${pending ? `its checks: ${pending}` : 'still the base'}` : `committed ${short(head)}`;
    if (stalled) {
      await note(ctx, `stall-${run_id}`, decision('run_timeout', `Developer run ${run_id} hit the run timeout: what counts?`, evaluate ? [
        alt('evaluate the committed change', 'the run left work the checks have not judged: the checks decide, not the clock', 'a change cut off mid-way may fail; then it counts as a stall'),
        alt('count it as a stalled run now', 'fast stop for a cheap model that keeps hitting its limit', 'treats committed, possibly finished work as a failure')] : [
        alt('check what the run left, as an attempt', 'a stall without new passing evidence counts toward the no-progress rule', 'partial work is checked'),
        alt('back off and retry', 'transient errors clear', 'a run that used its whole time limit is not transient: the loop would spend the clock without a no-progress verdict')],
      evaluate ? 'evaluate the committed change' : 'check what the run left, as an attempt', {
        evidence: [`run ${run_id}: timeout after ${lastDevStart(ctx)?.payload.limits?.timeout_ms ?? runTimeoutMs} ms`, `entry ${s.entry}`, why, `stall signature ${stallSignature(s.entry)}`],
        expected_effect: evaluate ? 'checks run on the head; failing them without progress counts the stall' : 'checks run on the committed SHA; no new passing evidence counts as no progress',
        rationale: evaluate ? 'A run that times out after committing is evaluated on its commit, not treated as a failed run (round 5).'
          : 'A billed run timeout is an attempt, not a provider outage (quota and unavailability still back off). It counts at once as a stall (D-024).', policy_ref: policyRef(p) }),
      counted ? {} : evaluate ? { stall_pending: run_id } : { stalls: ctx.cp.stalls + 1, stall_run: run_id });
    } else if (!counted && runLimits?.stall_runs_to_no_progress && unchanged) {
      // Short leash (stall_runs_to_no_progress): a run that left the head where it was produced nothing to check: a stall,
      // unless the head still holds an unmeasured or passing change (round 5: evaluate it first).
      await note(ctx, `nochange-${run_id}`, decision('run_no_change', `Developer run ${run_id} changed nothing: what counts?`, evaluate ? [
        alt('evaluate the head', 'the head holds a change the checks have not judged, or one that passes: the work may be done', 'one more check run'),
        alt('count it as a stalled run', 'cheap models can loop on no-op runs', 'stops a task whose work is already done (round 5 live defect)')] : [
        alt('count it as a stalled run', 'the checks see the same SHA: no new evidence is possible', 'the model may have been investigating'),
        alt('ignore it', 'no penalty', 'a cheap model can loop on no-op runs without a verdict')], evaluate ? 'evaluate the head' : 'count it as a stalled run', {
        evidence: [`run ${run_id}`, why, `entry ${s.entry}`, `stall_runs_to_no_progress ${runLimits.stall_runs_to_no_progress}`],
        expected_effect: evaluate ? 'checks run on the head; failing them without progress counts the stall' : 'checks run on the same SHA; the stalled-run limit applies',
        rationale: evaluate ? 'A no-change run on a head with an unmeasured or passing change goes to evaluation, not to a stall (round 5).'
          : 'Run limits (D-024): a run that changes nothing on a short leash is a stall.', policy_ref: policyRef(p) }),
      evaluate ? { stall_pending: run_id } : { stalls: ctx.cp.stalls + 1, stall_run: run_id });
    }
    const changed = (await g(wt.path, ['diff', '--name-only', `${ctx.v.base_sha}`, head])).split('\n').filter(Boolean);
    if (changed.length) {
      const r = allowed(p.policy, ctx.v, { class: 'edit', paths: changed }, grantsOf(ctx), actionKey({ class: 'edit', paths: changed }, `edit:${head}:`));
      if (!r.ok) {
        await store.setHead(ctx.id, head, { actor: { role: 'developer', id: s.entry }, event_id: `head-${run_id}` });
        return askOwner(ctx, { kind: 'paths', question: `The change touches paths outside policy: ${r.reason}`, reason: r.reason, classes: r.classes || [], keys: r.needs_approval ? [r.key] : [] }, { resume_to: 'repair', kind: 'scope_gate', policy_ref: policyRef(p) });
      }
    }
    await store.setHead(ctx.id, head, { actor: { role: 'developer', id: s.entry }, event_id: `head-${run_id}` });
    return move(ctx, 'evaluating', `run ${run_id} committed ${short(head)}`);
  }

  function compactSummary(ctx) {
    const recent = ctx.v.decisions.filter((d) => d.loop).slice(-6).map((d) => `- ${d.kind}: ${d.rationale}`);
    return [`Goal: ${ctx.v.goal}`, `Head: ${ctx.head ?? ctx.v.base_sha}`, 'Recent decisions:', ...recent].join('\n');
  }

  async function revalidate(ctx, wtHead, why) {
    await note(ctx, `reval-${short(wtHead)}`, decision('revalidate_sha', 'The worktree head differs from the verified head: which SHA counts?', [
      alt('the current worktree SHA, re-verified', 'evidence must match the exact current SHA', 'checks rerun'),
      alt('keep the old evidence', 'cheap', 'stale evidence never counts (T10/GL12)')], 'the current worktree SHA, re-verified', {
      evidence: [`recorded head ${ctx.head}`, `worktree head ${wtHead}`], expected_effect: 'old evidence no longer counts; checks rerun on the new SHA', rationale: why }));
    await store.setHead(ctx.id, wtHead, { actor: { role: 'developer', id: 'external:worktree' }, event_id: `head-reval-${ctx.k}-${wtHead}` });
    return result(ctx, null, `revalidated: head moved to ${short(wtHead)}`, { again: true });
  }

  async function sEvaluating(ctx) {
    const p = readPolicy(ctx);
    const wt = ctx.cp.worktree;
    const head = ctx.head;
    const st = await worktrees.status(wt.path);
    const bw = await branchGate(ctx, 'ready', st);
    if (bw) return bw;
    if (st.head !== head) return revalidate(ctx, st.head, 'Source changed after the last commit/verification (T10): re-verify on the current SHA.');
    if (st.dirty) {
      return onFailure(ctx, { signature: failureSignature({ test: 'worktree', errorClass: 'uncommitted_changes' }), passing: 0, p,
        feedback: { kind: 'uncommitted_changes', note: 'Tracked files changed outside a recorded run; the controller will commit your next run.' } });
    }
    const checkLimit = p.ok ? p.policy.checks?.timeout_ms ?? null : null;   // round 5: fits the real suite (.ai/project.json)
    const vr = await verifier.runChecks({ store, task: ctx.v, cwd: wt.path, sha: head, epoch: ctx.epoch, existing: ctx.evidence, actor: VERIFIER_ACTOR, isCancelled: () => halted(ctx.id), timeoutMs: checkLimit,
      register: (kill) => (kill ? active.set(ctx.id, { kill }) : active.delete(ctx.id)) });   // T14: cancel kills a running check
    if (vr.cancelled) return result(ctx, 'cancelled', 'cancelled during verification', { terminal: true, transitioned: false });
    const after = await headOf(wt.path);
    if (after !== head) return revalidate(ctx, after, 'Source changed during verification (T10/GL12): rerun on the new SHA.');
    const results = vr.results;
    const passing = passingRequired(ctx, results);
    const req = results.filter((r) => r.required);
    const feedbackOf = (kind, rs) => ({ kind, sha: head, checks: rs.map((r) => ({ check_id: r.check_id, status: r.status, exits: r.exits, failures: r.failures, output_tail: r.output_tail, error: r.error })) });
    const unavailable = req.filter((r) => r.status === 'unavailable');
    const timedOut = unavailable.filter((r) => r.timed_out);
    if (timedOut.length) {
      // Round 5: a check stopped at its time limit measured nothing about the change. Never a code failure, a developer
      // run or a stall: suspend, and verify the same SHA again once the limit (policy) changes or the owner resumes.
      const limitOf = (id) => ctx.v.acceptance_checks.find((c) => c.id === id)?.timeout_ms ?? checkLimit;
      const ids = timedOut.map((r) => `${r.check_id} (${limitOf(r.check_id) ? `${limitOf(r.check_id)} ms` : 'verifier default'})`).join(', ');
      const diagnosis = `check(s) ${ids} ran out of time on ${short(head)}: no result, which is not a failure of the change`;
      const next_action = 'raise checks.timeout_ms in .ai/project.json (or the task check\'s timeout_ms), or look for a hanging test; then resume: the same SHA is verified again, no developer run';
      return decide(ctx, decision('check_timeout', 'A required check ran out of time: what now?', [
        alt('suspend; verify the same SHA again when the limit changes or the owner resumes', 'a timeout says nothing about the change; no developer run or stall is spent on it', 'waits for the owner or a policy change'),
        alt('send it back to the developer', 'the change might hang a test', 'treats missing evidence as a code failure (live defect 2026-10-14)'),
        alt('retry at once with the same limit', 'load may have been transient', 'likely runs out of time again')],
      'suspend; verify the same SHA again when the limit changes or the owner resumes', {
        evidence: [`sha ${head}`, ...timedOut.map((r) => `${r.check_id}: no exit code (${r.error})`)], expected_effect: 'no runs until the check limit changes or the owner resumes; then checks only',
        rationale: 'Round 5: an evidence timeout must never look like a code failure.', policy_ref: policyRef(p) }),
      { patch: { verify_only: true, wait: { reason: 'check_timeout', until_ms: null, resume_to: 'ready', diagnosis, next_action, policy_hash: policyRef(p) } }, to: 'waiting', reason: 'check_timeout',
        emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'check_timeout', diagnosis, next_action } }] });
    }
    if (unavailable.length) {
      // GL04: unknown result is not passing; wait (backoff) then let the developer address the harness.
      const f = unavailable[0];
      return onFailure(ctx, { signature: failureSignature({ test: f.check_id, errorClass: 'unknown_exit' }), passing, p, feedback: feedbackOf('evidence_unavailable', unavailable), settleStall: false,
        then: 'waiting', thenPatch: { wait: { reason: 'evidence_unavailable', until_ms: now() + 60_000, resume_to: 'repair', diagnosis: `check ${f.check_id} produced no exit code (${f.error})` } } });
    }
    const flaky = req.filter((r) => r.status === 'flaky');
    if (flaky.length) {
      const f = flaky[0];
      await note(ctx, `flaky-${short(head)}-${f.check_id}`, decision('flaky', `Check ${f.check_id} both passed and failed on ${short(head)}: accept?`, [
        alt('mark flaky, isolate, do not accept', 'a flaky pass is not evidence', 'more iterations'), alt('accept on the passing run', 'fast', 'false success')],
      'mark flaky, isolate, do not accept', { evidence: [`exits ${f.exits.join(',')}`], expected_effect: 'developer resolves the nondeterminism', rationale: 'Pass/fail on the same SHA.' }),
      { flaky: [...new Set([...ctx.cp.flaky, `${f.check_id}@${head}`])] });
      return onFailure(ctx, { signature: failureSignature({ test: f.check_id, errorClass: 'flaky' }), passing, p, feedback: feedbackOf('flaky', flaky) });
    }
    const failing = req.filter((r) => r.status !== 'pass');
    if (failing.length) {
      const f = failing[0];
      const first = f.failures[0] || {};
      const failingTests = failing.reduce((n, r) => n + Math.max(1, r.failures.length), 0);
      const signature = failureSignature({ test: `${f.check_id}:${first.test ?? '?'}`, errorClass: first.error_class });
      // OWNER_DECISIONS §12.2: impossible requirements end fast, on an independent reviewer's judgement of failing checks.
      const feas = await maybeFeasibility(ctx, p, failing);
      if (feas?.stop) return feas.stop;
      if (feas) ctx = await load(ctx.id);
      if (feas?.impossible) {
        const diagnosis = `independent reviewer ${feas.reviewer} judged the requirements contradictory or impossible: ${feas.diagnosis}`;
        const next_action = 'fix the goal, the definition of done or the acceptance checks so they can all be met, then resume';
        return decide(ctx, decision('no_progress', 'Requirements judged impossible: keep iterating?', [
          alt('suspend in waiting with the reviewer\'s diagnosis', 'no run can satisfy contradictory requirements; no further spend', 'goal not reached'),
          alt('another developer run', 'the reviewer may be wrong', 'the required checks still fail and an independent reviewer says they cannot all pass')],
        'suspend in waiting with the reviewer\'s diagnosis', { evidence: [`sha ${ctx.head}`, `failing ${failing.map((r) => r.check_id).join(', ')}`, `feasibility reviewer ${feas.reviewer}: impossible`, ...feas.evidence],
          expected_effect: 'no further runs until the requirements change or the owner resumes', rationale: `OWNER_DECISIONS §12.2: ${diagnosis}`, policy_ref: policyRef(p) }),
        { patch: { claim: null, wait: { reason: 'no_progress', until_ms: null, resume_to: 'replan', diagnosis, next_action, policy_hash: policyRef(p) } }, to: 'waiting', reason: 'no_progress',
          emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'no_progress', diagnosis, next_action } }] });
      }
      const fb = feedbackOf('test_failure', failing);
      return onFailure(ctx, { signature, passing, failing: failingTests, p, extraEvidence: feas?.evidence || [],
        feedback: feas?.findings?.length ? { ...fb, feasibility: { reviewer: feas.reviewer, findings: feas.findings } } : fb });
    }
    // Every required check passes on this exact SHA. A SHA once seen flaky is never accepted.
    if (ctx.cp.flaky.some((x) => x.endsWith(`@${head}`))) {
      return onFailure(ctx, { signature: failureSignature({ test: 'flaky-sha', errorClass: 'flaky' }), passing: passing - 1, p, feedback: { kind: 'flaky', sha: head, note: 'This SHA was flaky earlier; change the code to remove the nondeterminism.' } });
    }
    return review(ctx, p, results);
  }

  // ---------- feasibility review (OWNER_DECISIONS §12.2) ----------
  // On failing required checks, once per head after a developer's impossibility claim, and once per task after the first
  // stall of a run governed by stall_runs_to_no_progress (a cheap model on an easy class). The reviewer is independent
  // of every developer, read-only, budget-checked; its "possible" answer only adds feedback. -> null | { stop } |
  // { reviewer, impossible, diagnosis, findings, evidence[] }
  async function maybeFeasibility(ctx, p, failing) {
    const head = ctx.head;
    const dev = lastDevStart(ctx);
    if (!dev || !head) return null;
    const feasDone = ctx.v.decisions.filter((d) => d.loop && d.kind === 'feasibility_review');
    if (feasDone.some((d) => d.evidence.includes(`sha ${head}`))) return null;
    const claimed = ctx.cp.claim?.run_id === dev.payload.run_id;
    const stalled = ctx.cp.stall_run === dev.payload.run_id && !!dev.payload.limits?.stall_runs_to_no_progress && !feasDone.length;
    if (!claimed && !stalled) return null;
    const why = claimed ? `developer run ${dev.payload.run_id} claims the requirements are impossible` : `developer run ${dev.payload.run_id} stalled (time limit or no change)`;
    const devEntries = devEntriesOf(ctx);
    const skip = async (reason) => {
      await note(ctx, `feas-${short(head)}`, decision('feasibility_review', 'Ask an independent reviewer whether the requirements can be met?', [
        alt('skip', reason, 'the no-progress rule decides alone'), alt('review', 'stops impossible tasks fast', reason)], 'skip', {
        evidence: [`sha ${head}`, why, reason], expected_effect: 'the failure is handled by the no-progress rule', rationale: `Feasibility review skipped: ${reason}` }), { claim: null });
      return null;
    };
    let r = null;
    try { r = await routeFor(ctx, p, { exclude: devEntries, role: 'reviewer' }); } catch { r = null; }
    const choice = r?.choice;
    if (!choice || r.requires_approval || devEntries.includes(choice)) return skip('no independent reviewer can be routed');
    const b = budget.check({ ...ctx.v, budget_policy: effectiveBudgetPolicy(ctx) }, ledger(ctx), estimate(ctx, choice, 'reviewer', r), { quota: quota(choice) });
    if (!b.allow) return skip(`budget: ${b.reason}`);
    const adapter = adapterFor(choice);
    if (!adapter) return skip(`no adapter for ${choice}`);
    const entry = registry.get(choice);
    const lim = runLimitsFor(ctx, p, entry, adapter, 'feasibility');
    const runBase = `${ctx.id}.feasibility-${short(head)}-e${ctx.epoch}-${choice.replace(/[^\w.-]/g, '_')}`;
    const run_id = `${runBase}-a${ctx.events.filter((e) => e.kind === 'task.started' && String(e.payload.run_id).startsWith(`${runBase}-a`)).length}`;
    const dir = path.join(reviewRoot, `${ctx.id}-${short(head)}-e${ctx.epoch}-feasibility`);
    const wt = ctx.cp.worktree;
    let out;
    try {
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* not there */ }
      await g(wt.path, ['worktree', 'add', '--detach', dir, head]);
      const diff = await g(wt.path, ['diff', ctx.v.base_sha, head]);
      await store.append(ctx.id, { event_id: `start-${run_id}`, kind: 'task.started', payload: { run_id, role: 'reviewer', review_role: 'feasibility', entry: choice, runtime: entry?.runtime ?? null, model: entry?.model ?? null,
        limits: { timeout_ms: lim.timeout_ms, max_steps: lim.max_steps, effort: lim.effort, context_mode: lim.context_mode }, ...(lim.notes.length ? { limits_ignored: lim.notes } : {}) } });
      out = await verifier.review({ adapter, entry, task: ctx.v, sha: head, cwd: fs.realpathSync(dir), diff, evidence: ctx.evidence, run_id: run_id.replace(/[^\w.-]/g, '_'),
        timeout_ms: lim.timeout_ms, effort: lim.effort, max_steps: lim.max_steps, context_mode: lim.context_mode, role: 'feasibility', claim: claimed ? ctx.cp.claim.diagnosis : null,
        failing: failing.map((x) => ({ check_id: x.check_id, status: x.status, exits: x.exits, failures: x.failures, output_tail: String(x.output_tail || '').slice(-1500) })),
        onStart: (run) => active.set(ctx.id, { adapter, run }) });
    } finally {
      active.delete(ctx.id);
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* best effort */ }
    }
    if (ctl.lost) return { stop: result(ctx, null, 'controller lease lost during the feasibility review: no writes', { idle: true }) };
    if (await isCancelled(ctx.id)) return { stop: result(ctx, 'cancelled', 'cancelled during review', { terminal: true, transitioned: false }) };
    const u = out.usage || {};
    await store.recordUsage(ctx.id, { runtime: entry?.runtime ?? null, provider: entry?.provider ?? null, model: entry?.model ?? null, ...billingOf(entry), run_id,
      input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, usd: u.usd ?? null, ...(u.incomplete ? { incomplete: true } : {}) }, { event_id: `usage-${run_id}` });
    const answer = out.verdict === 'unavailable' ? `unavailable (${out.error?.class || 'no verdict'})` : out.impossible ? 'impossible' : 'achievable';
    const evidence = [`sha ${head}`, why, `reviewer ${choice}: ${answer}`, ...(out.diagnosis ? [`diagnosis: ${out.diagnosis.slice(0, 300)}`] : [])];
    await note(ctx, `feas-${short(head)}`, decision('feasibility_review', 'Can the requirements be met as stated?', [
      alt('requirements impossible: stop', 'no run can pass contradictory checks', 'the reviewer may be wrong; the owner can resume'),
      alt('requirements achievable: keep iterating', 'normal no-progress rule', 'more runs')], out.impossible ? 'requirements impossible: stop' : 'requirements achievable: keep iterating', {
      evidence, expected_effect: out.impossible ? 'waiting/no_progress with the diagnosis' : 'the failure goes through the no-progress rule', rationale: `Independent feasibility review on failing checks (${why}).` }), { claim: null });
    if (out.verdict === 'unavailable') return { reviewer: choice, impossible: false, diagnosis: null, findings: [], evidence };
    return { reviewer: choice, impossible: out.impossible === true, diagnosis: out.diagnosis, findings: out.findings || [], evidence };
  }

  // ---------- independent evaluation ----------
  const devEntriesOf = (ctx) => [...new Set(ctx.events.filter((e) => e.kind === 'task.started' && e.payload.role === 'developer').map((e) => e.payload.entry))];

  // #15: no runtime independent of the developers: time does not fix that, new inputs do.
  const noReviewer = (ctx, why) => decide(ctx, decision('evaluator_unavailable', 'No independent evaluator can be routed: accept on tests alone?', [
    alt('wait until inputs change', 'acceptance needs an independent verdict (GL04); retrying the same floors changes nothing', 'blocked'),
    alt('accept on tests alone', 'fast', 'never: unavailable is not approval')], 'wait until inputs change', {
    evidence: [why], expected_effect: 'resume when a reviewer runtime becomes available, the policy changes or the owner resumes', rationale: `Evaluator unavailable: ${why}` }),
  { patch: { verify_only: true, wait: { reason: 'evaluator_unavailable', until_ms: null, resume_to: 'ready', diagnosis: why, next_action: 'enable a reviewer runtime different from the developer(s), then resume', policy_hash: policyRef(readPolicy(ctx)) } },
    to: 'waiting', reason: 'no independent evaluator' });

  // Unbilled transient unavailability (nothing ran, or the runtime reported itself unavailable): timed backoff.
  function reviewBackoff(ctx, why, extraPatch = {}, entry = null) {
    const n = ctx.cp.review_unavailable + 1;
    const delay = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (n - 1));
    return decide(ctx, decision('evaluator_unavailable', 'Independent evaluation unavailable: accept on tests alone?', [
      alt('wait and retry the evaluation', 'acceptance needs an independent verdict (GL04)', 'delay'), alt('accept on tests alone', 'fast', 'never: unavailable is not approval')],
    'wait and retry the evaluation', { evidence: [why], expected_effect: `re-evaluate in ${delay} ms without a developer run`, rationale: `Evaluator unavailable: ${why}` }),
    { patch: { ...extraPatch, review_unavailable: n, verify_only: true, wait: { reason: 'evaluator_unavailable', until_ms: now() + delay, resume_to: 'ready', ...(entry ? { entry, role: 'reviewer' } : {}) } }, to: 'waiting', reason: 'evaluator unavailable' });
  }

  // #3: a billed review that produced no usable verdict is a failure signature under the no-progress rule: identical
  // failures 3x -> another reviewer, else a stricter answer format; strategy changes exhausted -> suspend.
  async function reviewerFailure(ctx, p, entry, out, devEntries) {
    const np = ctx.v.no_progress_policy;
    const rf = ctx.cp.review_fail;
    const signature = `review:${entry} :: ${out.error?.class || 'no_verdict'}`;
    const count = rf.signature === signature ? rf.count + 1 : 1;
    const evidence = [`signature ${signature}`, `same failure ${count}x`, `reviewer strategy changes ${rf.changes}`];
    if (count < np.same_signature) return reviewBackoff(ctx, `reviewer ${entry}: ${out.error?.class || 'no verdict'} (${count}x)`, { review_fail: { ...rf, signature, count } });
    let other = null;
    try { const r = await routeFor(ctx, p, { exclude: [...devEntries, ...rf.excluded, entry], role: 'reviewer' }); other = r.choice; } catch { other = null; }
    const pick = rf.changes >= np.strategy_changes_without_progress ? null : other ? 'other_reviewer' : !rf.strict ? 'strict_format' : null;
    if (!pick) {
      return suspend(ctx, 'no_progress', { p, resume_to: 'ready', extraPatch: { verify_only: true, review_fail: { ...rf, signature, count } }, evidence,
        diagnosis: `independent evaluation produced no usable verdict: ${signature} ${count}x after ${rf.changes} reviewer change(s)`,
        next_action: 'check the reviewer runtimes (output format, health), enable another reviewer, then resume' });
    }
    const review_fail = { signature: null, count: 0, changes: rf.changes + 1, excluded: pick === 'other_reviewer' ? [...rf.excluded, entry] : rf.excluded, strict: rf.strict || pick === 'strict_format' };
    return decide(ctx, decision('reviewer_strategy_change', `Reviewer failed identically ${count}x: what changes?`, [
      alt('other_reviewer', other ? `router ranks ${other} next` : 'n/a', other ? 'different reviewer behaviour' : 'no other independent reviewer'),
      alt('strict_format', 'states the required answer format explicitly', 'same reviewer'), alt('blind retry', 'cheap', 'billed identical retries are forbidden')],
    pick, { evidence, expected_effect: pick === 'other_reviewer' ? `next review by ${other}` : 'next review demands the JSON verdict only', rationale: 'No-progress rule applied to billed reviews.' }),
    { patch: { review_fail, verify_only: true, wait: { reason: 'reviewer_change', until_ms: now(), resume_to: 'ready' } }, to: 'waiting', reason: `reviewer strategy change: ${pick}` });
  }

  // One evaluation by `role` on the exact head SHA. -> { verdict } | { stop: step result }
  async function obtainVerdict(ctx, p, { role, devEntries, fixedEntry = null }) {
    const head = ctx.head;
    const existing = ctx.verdicts.filter((x) => !devEntries.includes(x.actor?.id) && (x.actor?.role || 'reviewer') === role).at(-1);
    if (existing) return { verdict: existing };
    if (await isCancelled(ctx.id)) return { stop: result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false }) };
    const rf = ctx.cp.review_fail;
    let r = null;
    let choice = fixedEntry;
    if (!choice) { r = await routeFor(ctx, p, { exclude: [...devEntries, ...rf.excluded], role }); choice = r.choice; }
    if (choice && !devEntries.includes(choice)) shadowNote(ctx, role, choice, head);
    if (!choice || devEntries.includes(choice)) return { stop: await noReviewer(ctx, `no ${role} runtime independent of ${devEntries.join(', ')}${fixedEntry ? ` (policy names ${fixedEntry})` : ''}`) };
    const stop = await budgetGate(ctx, choice, 'reviewer', 'ready', { patch: { verify_only: true }, routeHint: r });   // #6
    if (stop) return { stop };
    const adapter = adapterFor(choice);
    if (!adapter) return { stop: await reviewBackoff(ctx, `no adapter for ${choice}`) };
    // Per reviewer and role: a later, more independent reviewer on the same SHA gets its own run, usage and verdict ids.
    // N1: every attempt gets its own run id (attempt index), so retried reviews are never deduplicated out of the ledger.
    const runBase = `${ctx.id}.${role === 'reviewer' ? 'review' : role}-${short(head)}-e${ctx.epoch}-${choice.replace(/[^\w.-]/g, '_')}`;
    const attempt = ctx.events.filter((e) => e.kind === 'task.started' && String(e.payload.run_id).startsWith(`${runBase}-a`)).length;
    const run_id = `${runBase}-a${attempt}`;
    const dir = path.join(reviewRoot, `${ctx.id}-${short(head)}-e${ctx.epoch}-${role}`);
    const wt = ctx.cp.worktree;
    const entry = registry.get(choice);
    let out;
    try {
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* not there */ }
      await g(wt.path, ['worktree', 'add', '--detach', dir, head]);   // independent, read-only checkout of the exact SHA
      const diff = await g(wt.path, ['diff', ctx.v.base_sha, head]);
      const lim = runLimitsFor(ctx, p, entry, adapter, role);   // D-024: reviewers run under their entry's limits too
      await store.append(ctx.id, { event_id: `start-${run_id}`, kind: 'task.started', payload: { run_id, role: 'reviewer', review_role: role, entry: choice, runtime: entry?.runtime ?? null, model: entry?.model ?? null,
        limits: { timeout_ms: lim.timeout_ms, max_steps: lim.max_steps, effort: lim.effort, context_mode: lim.context_mode }, ...(lim.notes.length ? { limits_ignored: lim.notes } : {}) } });
      out = await verifier.review({ adapter, entry, task: ctx.v, sha: head, cwd: fs.realpathSync(dir), diff, evidence: ctx.evidence.length ? ctx.evidence : (await load(ctx.id)).evidence,
        run_id: run_id.replace(/[^\w.-]/g, '_'), timeout_ms: lim.timeout_ms, effort: lim.effort, max_steps: lim.max_steps, context_mode: lim.context_mode,
        role, strict: rf.strict, onStart: (run) => active.set(ctx.id, { adapter, run }) });
    } finally {
      active.delete(ctx.id);
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* best effort; the dir is outside the task worktree */ }
    }
    if (ctl.lost) return { stop: result(ctx, null, 'controller lease lost during the review: no writes', { idle: true }) };
    if (await isCancelled(ctx.id)) return { stop: result(ctx, 'cancelled', 'cancelled during review', { terminal: true, transitioned: false }) };
    const u = out.usage || {};
    await store.recordUsage(ctx.id, { runtime: entry?.runtime ?? null, provider: entry?.provider ?? null, model: entry?.model ?? null, ...billingOf(entry), run_id,
      input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, usd: u.usd ?? null, ...(u.incomplete ? { incomplete: true } : {}) }, { event_id: `usage-${run_id}` });
    if (out.verdict === 'unavailable') {
      const billed = isBilled({ started: !!out.run, errorClass: out.error?.class, usage: out.usage });
      if (!billed) return { stop: await reviewBackoff(ctx, `${role} ${choice}: ${out.error?.class || 'no verdict'}`, {}, choice) };
      return { stop: await reviewerFailure(await load(ctx.id), p, choice, out, devEntries) };
    }
    const verdict = { sha: head, actor: { role, id: choice }, verdict: out.verdict, findings: out.findings };
    await store.recordVerdict(ctx.id, verdict, { event_id: `verdict-${run_id}` });
    // An "impossible" claim on green checks is not believed (the checks pass): journaled, the verdict counts as usual.
    if (out.impossible) {
      await note(ctx, `impossible-ignored-${short(head)}-${role}`, decision('impossible_ignored', `Reviewer ${choice} calls the requirements impossible while every required check passes: stop?`, [
        alt('ignore the claim; handle the verdict as usual', 'the deterministic checks pass on this SHA: the requirements were met as tested', 'the reviewer may see a real conflict'),
        alt('stop as no_progress', 'fast', 'contradicted by passing evidence')], 'ignore the claim; handle the verdict as usual', {
        evidence: [`sha ${head}`, `reviewer ${choice}`, `diagnosis: ${String(out.diagnosis).slice(0, 300)}`], expected_effect: 'the reject goes through the no-progress rule like any review finding',
        rationale: 'OWNER_DECISIONS §12.2: an impossible verdict ends a task only while the deterministic checks still fail.' }));
    }
    return { verdict };
  }

  async function review(ctx, p, results) {
    const head = ctx.head;
    const devEntries = devEntriesOf(ctx);
    const roles = ['reviewer'];
    const risky = ['high', 'critical'].includes(ctx.v.risk_class);
    // D-013: elevated risk adds the policy's security reviewer (when named) and an owner approval bound to this SHA.
    const securityEntry = risky && typeof p.policy?.security_reviewer === 'string' ? p.policy.security_reviewer : null;
    if (securityEntry) roles.push('security');
    const verdicts = [];
    for (const role of roles) {
      const cur = role === 'reviewer' ? ctx : await load(ctx.id);   // fresh ledger/verdicts after the first review
      const got = await obtainVerdict(cur, p, { role, devEntries, fixedEntry: role === 'security' ? securityEntry : null });
      if (got.stop) return got.stop;
      if (got.verdict.verdict === 'reject') {
        const f = got.verdict.findings[0] || { id: 'unspecified' };
        return onFailure(await load(ctx.id), { signature: failureSignature({ test: `${role === 'reviewer' ? 'review' : `review:${role}`}:${f.id}`, errorClass: 'review_reject' }),
          passing: passingRequired(ctx, results), p, reviewOnly: true,
          feedback: { kind: 'review_reject', sha: head, reviewer: got.verdict.actor.id, role, findings: got.verdict.findings,
            note: `Deterministic checks pass, but the independent ${role} rejected the change. Address every blocker finding.` } });
      }
      verdicts.push(got.verdict);
    }
    const fresh = await load(ctx.id);
    // Revalidate right before acceptance: never accept on a SHA the worktree no longer has (GL12), nor while the
    // worktree is off the task branch at the same SHA (Y3b).
    const st2 = await worktrees.status(ctx.cp.worktree.path);
    const bw = await branchGate(fresh, 'ready', st2);
    if (bw) return bw;
    if (st2.head !== head) return revalidate(fresh, st2.head, 'Source changed between review and acceptance.');
    if (risky && !grantsOf(fresh).has(`accept:${head}`)) {
      return askOwner(fresh, { kind: 'risk_acceptance', question: `risk_class ${ctx.v.risk_class}: accept ${short(head)}? Checks pass and ${verdicts.map((x) => `${x.actor.role} ${x.actor.id}`).join(', ')} approved.`,
        reason: `risk_class ${ctx.v.risk_class} requires an owner approval bound to the exact head SHA (D-013)`, classes: ['risk_acceptance'], keys: [`accept:${head}`] },
      { resume_to: 'ready', kind: 'risk_gate', policy_ref: policyRef(p), patch: { verify_only: true }, extra: { sha: head } });
    }
    // Delivery requested -> integrating even without a wired hook: the task then waits there, it never skips delivery.
    const deliver = !!ctx.cp.interpretation?.delivery;
    return decide(fresh, decision('accept', 'All criteria met: what next?', [
      alt(deliver ? 'hand off to integration' : 'accept', 'every required check passes on the exact SHA and an independent reviewer approved', 'none known'),
      alt('more review', 'extra assurance', 'no open finding justifies it')], deliver ? 'hand off to integration' : 'accept', {
      evidence: [`sha ${head}`, ...results.map((r) => `${r.check_id}: ${r.status}`), ...verdicts.map((x) => `${x.actor.role} ${x.actor.id}: approve`)],
      expected_effect: deliver ? 'integration controller takes over (authorized gates only)' : 'task accepted (verified in the task worktree, not integrated)',
      rationale: 'Definition of done verified on the exact SHA with independent approval.',
      reversible: false, rollback: 'reopen as a new task; accepted is terminal' }),
    { patch: { feedback: null, verify_only: false }, to: deliver ? 'integrating' : 'accepted', reason: `verified ${short(head)}` });
  }

  async function sReplan(ctx) { return move(ctx, 'planned', 'replanned with the recorded strategy change'); }

  async function sWaiting(ctx) {
    const w = ctx.cp.wait || { until_ms: 0, resume_to: 'ready' };
    if (w.until_ms != null && now() < w.until_ms) return result(ctx, null, `waiting (${w.reason}) until ${new Date(w.until_ms).toISOString()}`, { until_ms: w.until_ms });
    if (w.until_ms == null) {
      // No-progress waits are revisited only when inputs change: the policy, or an explicit owner resume.
      const resumed = ctx.events.some((e) => e.kind === 'approval.granted' && e.payload.kind === 'resume' && e.payload.k === ctx.k - 1);
      const changed = policyRef(readPolicy(ctx)) !== w.policy_hash;
      if (!resumed && !changed) return result(ctx, null, `waiting (${w.reason}): ${w.next_action || 'until inputs change'}`, { idle: true });
      return decide(ctx, decision('resume', 'Inputs changed after a wait: resume?', [alt('resume with a replan', 'new inputs can change the outcome', 'more spend'), alt('stay waiting', 'no spend', 'ignores the new input')],
        'resume with a replan', { evidence: [resumed ? 'owner resumed' : 'project policy changed'], expected_effect: 'replan from scratch', rationale: 'Counters reset on new inputs (owner resume or policy change).' }),
      { patch: { changes: 0, tried: [], stale: 0, stalls: 0, stall_run: null, claim: null, streak: { signature: null, count: 0 }, exclude: [], ...(w.reason === 'lease_held' && resumed ? { lease_ack: true } : {}) },
        to: w.resume_to || 'replan', reason: 'inputs changed' });
    }
    if (w.reason === 'infra' && admission?.isPaused?.()) {
      return result(ctx, null, 'waiting (infra): admission paused', { until_ms: now() + 60_000 });
    }
    return move(ctx, w.resume_to || 'ready', `${w.reason} wait elapsed`);
  }

  async function sAwaitingApproval(ctx) {
    const req = ctx.cp.approval;
    if (!req) return result(ctx, null, 'awaiting approval', { idle: true });
    const d = ownerAnswerOf(ctx.events, req.k);
    if (!d) return result(ctx, null, `awaiting approval: ${req.question}`, { idle: true });   // silence is never approval (GL09)
    if (d.kind === 'approval.denied') {
      // #13: refusing an action the developer asked for (never executed anyway) continues the task without it;
      // only gates the goal cannot proceed without end it.
      if (req.kind === 'agent_action') {
        return decide(ctx, decision('action_refused', 'The owner refused the requested action: continue?', [
          alt('continue without the action', 'the goal may not need it; the developer is told it was refused', 'another run'),
          alt('end the task', 'final', 'the refusal was about one action, not the goal')], 'continue without the action', {
          evidence: [`denied by ${d.payload.actor?.id ?? 'owner'}: ${d.payload.reason ?? 'no reason given'}`], expected_effect: 'repair run without the refused action',
          rationale: 'Owner denial of an agent-requested action is feedback, not a task failure.' }),
        { patch: { feedback: { kind: 'action_refused', actions: req.actions || [], note: `The owner denied/refused: ${(req.actions || []).map((a) => (a.argv || [a.class]).join(' ')).join('; ')}. Reason: ${d.payload.reason ?? 'none given'}. Reach the goal without it.` } },
          to: 'repair', reason: 'action refused by the owner' });
      }
      return move(ctx, 'failed_unrecoverable', `owner denied: ${d.payload.reason || 'no reason given'}`);
    }
    return move(ctx, req.resume_to, `owner approved (${d.payload.approval_ref || 'no ref'})`);
  }

  async function sIntegrating(ctx) {
    if (!integrate) return result(ctx, null, 'integrating: no integration hook wired', { idle: true });
    const head = ctx.head;
    const idempotency_key = `integrate:${ctx.id}:${head}`;
    // One effect per attempt, one key per SHA: the store refuses a new attempt once the key is confirmed (T06).
    const effs = ctx.v.effects.filter((e) => e.idempotency_key === idempotency_key);
    const confirmed = effs.some((e) => e.phase === 'confirmed');
    const effect_id = `integrate-${short(head)}-${effs.length}`;
    if (!confirmed) {
      // Y3b: hand off only the task branch at the verified SHA.
      const st = await worktrees.status(ctx.cp.worktree.path);
      const bw = await branchGate(ctx, 'integrating', st);
      if (bw) return bw;
      if (st.head !== head) return revalidate(ctx, st.head, 'Source changed before the integration handoff.');
      if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      await store.recordEffect(ctx.id, { effect_id, idempotency_key, kind: 'integration', phase: 'attempted' });
    }
    // The hook must be idempotent by key: after a crash or an unknown outcome it is asked again with the same key.
    // `store` is this loop's fenced handle: an integration bridge writes through it (one writer, D-016), never its own.
    const r = await integrate(ctx.v, { sha: head, worktree: ctx.cp.worktree, idempotency_key, store });
    const ok = ['release_verifying', 'repair', 'waiting', 'awaiting_approval'].includes(r?.next);
    if (!confirmed) await store.recordEffect(ctx.id, { effect_id, phase: ok ? 'confirmed' : 'possibly_applied' });
    if (!ok) {
      if (!confirmed) return move(ctx, 'unknown_external_effect', `integration outcome unknown: ${r?.reason || 'no result'}`);
      return askOwner(ctx, { kind: 'integration', question: `Integration was applied but the controller reports no usable state: ${r?.reason || 'no result'}`, reason: r?.reason || 'no result', classes: ['integration'] }, { resume_to: 'integrating' });
    }
    const patch = { integration: { next: r.next, reason: r.reason ?? null, release_verified: r.release_verified === true }, integration_unknown: 0 };
    // A policy block the bridge marks (queue item awaiting approval with no controller request: protected path, path not
    // allowlisted, target policy) has no key an owner grant could cover: waiting with a diagnosis, not a dead end. Other
    // keyless results (post-merge CI red, rejected, no developer...) stay owner decisions with their deny path.
    // The owner ends a policy block with cancel.
    if (r.next === 'awaiting_approval' && r.block === 'policy') {
      const diagnosis = r.reason || 'integration blocked by policy';
      const next_action = 'fix the cause (project policy, protected/allowlisted paths or the integration target), then resume the task';
      return decide(ctx, decision('integration_policy_block', 'Integration blocked with no approval request: what now?', [
        alt('wait with a diagnosis', 'there is nothing the owner could approve; revisited when the policy changes or the owner resumes', 'task stays open'),
        alt('ask the owner', 'a request with no action key can never be granted', 'dead end: the approval covers nothing')],
      'wait with a diagnosis', { evidence: [`sha ${head}`, `key ${idempotency_key}`], expected_effect: 'waiting until inputs change', rationale: `Policy block without an approval request: ${diagnosis}` }),
      { patch: { ...patch, wait: { reason: 'policy_block', until_ms: null, resume_to: 'integrating', diagnosis, next_action, policy_hash: policyRef(readPolicy(ctx)) } }, to: 'waiting', reason: 'policy_block',
        emit: [{ event_id: `blocked-${ctx.id}-${ctx.k}`, kind: 'task.blocked', payload: { reason: 'policy_block', diagnosis, next_action } }] });
    }
    if (r.next === 'waiting') patch.wait = { reason: 'integration', until_ms: now() + (r.retry_after_ms ?? 5 * 60_000), resume_to: 'integrating' };   // D-007
    // The grant is bound to the hook's action keys (e.g. integration:merge:<repo>:<target>:<sha>), never to the class alone.
    if (r.next === 'awaiting_approval') patch.approval = { k: ctx.k, kind: 'integration', question: r.reason || 'integration needs owner approval', classes: r.classes || [],
      keys: Array.isArray(r.keys) ? r.keys.map(String) : [], ...(typeof r.sha === 'string' ? { sha: r.sha } : {}), resume_to: 'integrating' };
    if (r.next === 'repair' && r.feedback && typeof r.feedback === 'object') patch.feedback = r.feedback;   // e.g. merge conflict files
    return decide(ctx, decision('integration_result', 'Integration controller result: next state?', [alt(r.next, r.reason || 'reported by the integration controller', 'n/a'), alt('accept now', 'fast', 'skips integration gates')],
      r.next, { evidence: [`sha ${head}`, `key ${idempotency_key}`], expected_effect: r.next, rationale: `Integration hook returned ${r.next}.` }), { patch, to: r.next, reason: r.reason || r.next });
  }

  async function sReleaseVerifying(ctx) {
    if (!ctx.cp.integration?.release_verified) return result(ctx, null, 'release not verified by the integration controller', { idle: true });
    return decide(ctx, decision('accept', 'Release verified: accept?', [alt('accept', 'integration verified the release on the exact SHA', 'none'), alt('wait', 'n/a', 'nothing pending')],
      'accept', { evidence: [`sha ${ctx.head}`], expected_effect: 'task accepted', rationale: 'Integration controller reported release verification.', reversible: false, rollback: 'reopen as a new task' }),
    { patch: {}, to: 'accepted', reason: 'release verified' });
  }

  // GL06/T07: a run attempted before a crash is a local effect in our own worktree: mark it failed (interrupted),
  // keep whatever it left in the worktree, and repair with a fresh run told about the partial state.
  async function sUnknownEffect(ctx) {
    const open = ctx.v.effects.filter((e) => ['attempted', 'possibly_applied'].includes(e.phase));
    const foreign = open.filter((e) => e.kind !== 'developer_run');
    if (foreign.length) {
      // Reconcile with the outside world first (integration hook); unknown stays blocked, never repeated blindly.
      if (!integrate?.reconcile) return result(ctx, null, `unknown external effect ${foreign.map((e) => e.effect_id).join(', ')}: reconcile required`, { idle: true });
      const seen = [];
      for (const e of foreign) {
        const r = await integrate.reconcile(ctx.v, { effect_id: e.effect_id, idempotency_key: e.idempotency_key, store });
        if (r?.applied === true) await store.recordEffect(ctx.id, { effect_id: e.effect_id, phase: 'confirmed' });
        else if (r?.applied === false) await store.recordEffect(ctx.id, { effect_id: e.effect_id, phase: 'failed' });
        else return result(ctx, null, `effect ${e.effect_id} still unknown`, { idle: true });
        seen.push(`${e.effect_id}: ${r.applied ? 'applied' : 'not applied'}`);
      }
      const n = ctx.cp.integration_unknown + 1;
      const fresh = await load(ctx.id);
      // Repeated unknown outcomes are the integration form of "no progress": the owner decides, no endless retries.
      if (n >= ctx.v.no_progress_policy.same_signature) {
        return askOwner(fresh, { kind: 'integration_unknown', question: `Integration outcome was unknown ${n} times in a row; reconcile showed: ${seen.join('; ')}.`, reason: seen.join('; '), classes: ['integration'] },
          { resume_to: 'integrating', kind: 'reconcile' });
      }
      return decide(fresh, decision('reconcile', 'Integration effect reconciled: retry integration?', [
        alt('ask the integration controller again with the same key', 'the reconciled state is known; the key prevents a duplicate', 'one more call'),
        alt('ask the owner', 'cautious', 'a reconciled, idempotent retry is routine')], 'ask the integration controller again with the same key', {
        evidence: seen, expected_effect: 'integrating with the same idempotency key', rationale: 'Unknown outcome reconciled with the remote before any retry (T07).' }),
      { patch: { integration_unknown: n }, to: 'integrating', reason: 'integration effect reconciled' });
    }
    if (!open.length) {
      return askOwner(ctx, { kind: 'unknown_state', question: 'Task is in unknown_external_effect with no open effect to reconcile.', reason: 'no open effect', classes: ['reconcile'] }, { resume_to: 'repair', kind: 'reconcile' });
    }
    for (const e of open) await store.recordEffect(ctx.id, { effect_id: e.effect_id, phase: 'failed' });
    let status = 'unknown';
    try { const s = await worktrees.status(ctx.cp.worktree.path); status = `head ${short(s.head)}, ${s.dirty ? 'modified files' : 'no modified files'}, ${s.untracked ? 'untracked files' : 'no untracked files'}`; } catch { /* reported as unknown */ }
    const fresh = await load(ctx.id);
    return decide(fresh, decision('crash_recovery', 'A run was interrupted by a controller restart: how to resume?', [
      alt('fresh run with a summarized context over the existing worktree', 'nothing confirmed is redone; partial work is kept', 'the interrupted run is not resumed verbatim'),
      alt('resume the provider session', 'continuity', 'session state is not durable across controller crashes'),
      alt('discard the worktree and restart', 'clean slate', 'loses work; destructive')],
    'fresh run with a summarized context over the existing worktree', { evidence: [`effects ${open.map((e) => e.effect_id).join(', ')}`, `worktree ${status}`],
      expected_effect: 'repair run continues from the persisted checkpoint', rationale: 'Unconfirmed local run reconciled as interrupted (no external effect outside the task worktree).' }),
    { patch: { feedback: { kind: 'interrupted', note: `The previous run was interrupted. Worktree: ${status}. Continue from the files present.` }, strategy: { ...fresh.cp.strategy, compact: true } }, to: 'repair', reason: 'interrupted run reconciled' });
  }

  const HANDLERS = { created: sCreated, clarified: sClarified, planned: sPlanned, ready: sDispatch, repair: sDispatch, executing: sExecuting,
    evaluating: sEvaluating, replan: sReplan, waiting: sWaiting, awaiting_approval: sAwaitingApproval, integrating: sIntegrating,
    release_verifying: sReleaseVerifying, unknown_external_effect: sUnknownEffect };

  async function step(id) {
    usage.busy += 1;
    try {
      const h = await hold();
      if (!h.ok) return { task_id: id, from: null, state: null, transitioned: false, idle: true, controller: h.code, note: h.diagnosis };
      const stop = heartbeat();
      try { return await stepUnderLease(id); } finally { stop(); }
    } finally { usage.busy -= 1; }
  }

  async function stepUnderLease(id) {
    const ctx = await load(id);
    if (ctx.broken) return result(ctx, null, `store error: ${ctx.v.store_error}; repair the log before stepping`, { idle: true });
    if (ctx.v.recovery_pending) { await store.recover(); return stepUnderLease(id); }   // we hold the controller lease
    if (TERMINAL.includes(ctx.v.status)) return result(ctx, null, 'terminal', { terminal: true });
    if (isInformational(ctx.v)) return result(ctx, null, 'informational task: not dispatched by the goal loop', { idle: true });
    if (await recordInterruptedUsage(ctx)) return stepUnderLease(id);
    try {
      if (ctx.pending) return await applyNext(ctx, ctx.pending);   // crash between decision and transition
      return await HANDLERS[ctx.v.status](ctx);
    } catch (e) {
      if (e.code === 'E_CANCELLED') return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      if (e.code === 'E_CONTROLLER_LOST') return result(ctx, null, `controller lease lost: no writes (${e.message})`, { idle: true });
      if (INFRA_CODES[e.code] || INFRA_CODES[e.cause?.code]) return onInfra(ctx, INFRA_CODES[e.code] ? e : e.cause);
      throw e;
    }
  }

  // Loops steps until a terminal state, an `until` state, or nothing can happen without time/owner/new inputs.
  // The heartbeat lives as long as run(): a controller idle in a timed wait is alive, never taken over as dead. Another
  // live controller (E_HELD) is waited out for one lease TTL and asked again, not silently given up on.
  async function run(id, { until = [] } = {}) {
    const stop = typeof until === 'function' ? until : (r) => until.includes(r.state);
    usage.busy += 1;
    let hb = null;
    try {
      for (;;) {
        const r = await step(id);
        if (!hb && ctl.lease) hb = heartbeat();
        if (r.controller === 'E_HELD') { await sleep(ctlCfg.ttl_ms); continue; }
        if (r.terminal || TERMINAL.includes(r.state) || stop(r)) return r;
        if (r.transitioned || r.again) continue;
        if (r.until_ms != null) { await sleep(Math.max(0, r.until_ms - now())); continue; }
        return r;
      }
    } finally { hb?.(); usage.busy -= 1; }
  }

  // Long-lived controller (server wiring, orchestration/v2-runtime.js): the lease is held, with a heartbeat, between
  // steps too, so an owner action's releaseIdle() never drops it while this instance is the scheduler.
  let pinned = null;
  async function acquire({ watch = false } = {}) {
    if (pinned) return { ok: true };
    usage.busy += 1;
    const h = await hold({ takeover: true, reconcile: false, watch });
    if (!h.ok) { usage.busy -= 1; return h; }
    pinned = heartbeat();
    return h;
  }
  // Clean shutdown: release the controller lease now, even with a step in flight. That step's next write fails the
  // fence (E_CONTROLLER_LOST): nothing is written behind the next controller's back; an unconfirmed run is reconciled
  // by whoever recovers next (GL06).
  async function release() {
    if (pinned) { pinned(); pinned = null; usage.busy -= 1; }
    return ctlSerial(async () => {
      if (!leases || !ctl.lease) return { released: false };
      const l = ctl.lease;
      ctl.lease = null; ctl.intent = null; ctl.recovered = false; ctl.lost = true;
      const r = await leases.release(l).catch(() => null);
      dropCtlIntent(ctlCfg.instance);
      return { released: r?.ok === true };
    });
  }

  // Any other owner-initiated write of the process that runs this loop (task creation from the dashboard, an ops
  // request): under the controller lease like approve/deny/cancel, and through the fenced store handle, so a
  // displaced instance (its lease expired, another controller took over) writes nothing (E_CONTROLLER_HELD).
  const ownerWrite = (fn) => asOwner(() => fn(store));

  return {
    step, run, acquire, release, ownerWrite,
    // Startup: replay the store (unconfirmed effects -> unknown_external_effect); steps resume from there (T18).
    async recover() {
      usage.busy += 1;   // a concurrent owner action's releaseIdle() must not drop the lease mid-recover
      try {
        const h = await hold({ takeover: true, reconcile: false });
        if (!h.ok) throw coded('E_CONTROLLER_HELD', h.diagnosis);
        const r = await store.recover();
        ctl.recovered = true;
        const open = (await store.list()).filter((t) => !TERMINAL.includes(t.status)).map((t) => t.task_id);
        return { ...r, resumable: open };
      } finally { usage.busy -= 1; }
    },
    // T14 / D-018: cancellation always goes through. The canceller takes the controller lease (liveness-gated
    // takeover of a dead controller), reconciles a recovery_pending task first (never appending over a torn tail),
    // persists the cancel, then stops whatever runs; the store rejects every later write.
    async cancel(id, { actor, reason } = {}) {
      if (!actor) throw coded('E_INVALID', 'cancel needs an actor');
      return asOwner(async () => {
        if ((await store.get(id))?.recovery_pending) await rawStore.recover();
        const t = await store.transition(id, 'cancelled', { reason: reason ?? 'cancelled', actor });
        const a = active.get(id);
        if (a?.kill) a.kill();
        else if (a) { try { await a.adapter.cancel(a.run); } catch { /* the run ends with the process group */ } }
        return t;
      });
    },
    // Explicit owner decisions on a pending request. Only recorded approvals ever authorize anything.
    // `binding`/`meta` come from the dashboard route (D-020): the request it showed and the audit fields it records.
    async approve(id, { actor, approval_ref = null, grants = {}, binding = null, meta = null } = {}) {
      if (!actor) throw coded('E_INVALID', 'approval needs an actor');
      return answerSerial(id, () => asOwner(async () => {
        const ctx = await load(id);
        const { req, repeat } = openRequest(ctx, 'approval.granted', binding);
        if (repeat) return repeat;
        // #7b: a grant can only cover what was asked: the request's classes and action keys, budget only for a budget stop.
        const classes = grants.classes ?? req.classes;
        if (!Array.isArray(classes) || classes.some((c) => !req.classes.includes(c))) throw coded('E_INVALID', `grant exceeds the request (asked: ${req.classes.join(', ') || 'none'})`);
        if (grants.budget_policy !== undefined && req.kind !== 'budget') throw coded('E_INVALID', 'budget authorization only answers a budget stop');
        // X8: a reached cap is not waivable by a bare confirmation: the owner raises it (or cancels).
        if (req.kind === 'budget' && req.cap_reached && !grants.budget_policy) throw coded('E_INVALID', 'cap reached: raise it (grants.budget_policy) or cancel the task');
        if (req.kind === 'budget' && req.cap_reached) {
          // Y7: the raise must clear what is spent plus the next run's estimate, or the same stop would come straight back.
          const raised = { ...effectiveBudgetPolicy(ctx), ...grants.budget_policy };
          const b2 = budget.check({ ...ctx.v, budget_policy: raised }, ledger(ctx), estimate(ctx, req.entry, req.role), { quota: null });
          const capLeft = !b2.allow && b2.state_hint === 'awaiting_approval' && !b2.reason.split('; ').every((x) => /estimate unknown|spend unknown/.test(x));
          if (capLeft) throw coded('E_INVALID', `the raise does not clear spend + estimate: ${b2.reason}`);
        }
        for (const k of Object.keys(grants)) if (!['classes', 'budget_policy'].includes(k)) throw coded('E_INVALID', `unknown grant field ${k}`);
        const payload = { k: req.k, actor, ...answerMeta(meta), approval_ref,
          grants: { classes, keys: req.keys || [], request_kind: req.kind, ...(grants.budget_policy ? { budget_policy: grants.budget_policy } : {}) } };
        return store.append(id, { event_id: `appr-${id}-${req.k}`, kind: 'approval.granted', payload });
      }));
    },
    async deny(id, { actor, reason = null, binding = null, meta = null } = {}) {
      if (!actor) throw coded('E_INVALID', 'denial needs an actor');
      return answerSerial(id, () => asOwner(async () => {
        const ctx = await load(id);
        const { req, repeat } = openRequest(ctx, 'approval.denied', binding);
        if (repeat) return repeat;
        return store.append(id, { event_id: `deny-${id}-${req.k}`, kind: 'approval.denied', payload: { k: req.k, actor, ...answerMeta(meta), reason } });
      }));
    },
    // Owner nudge for a no-progress wait (an input change the loop cannot observe itself).
    async resume(id, { actor, reason = null } = {}) {
      if (!actor) throw coded('E_INVALID', 'resume needs an actor');
      return asOwner(async () => {
        const ctx = await load(id);
        if (ctx.v.status !== 'waiting') throw coded('E_ILLEGAL_TRANSITION', 'task is not waiting');
        return store.append(id, { event_id: `resume-${id}-${ctx.k}`, kind: 'approval.granted', payload: { k: ctx.k - 1, kind: 'resume', actor, reason } });
      });
    },
    // Read model for UI/API: state, outcome, next action, loop memory.
    async inspect(id) {
      const ctx = await load(id);
      return { task: ctx.v, loop: ctx.cp, head: ctx.head, epoch: ctx.epoch, pending: ctx.pending };
    },
  };
}
