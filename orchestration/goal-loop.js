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
import { createHash } from 'node:crypto';
import { TERMINAL, failureSignature, ContractError } from './task-contract.js';
import { checkAction as policyCheckAction, loadPolicy as realLoadPolicy, clarificationFor } from './policy.js';
import { route as realRoute, fallbackPlan as realFallbackPlan } from './router.js';
import * as realBudget from './budget.js';
import { developerPrompt } from './roles.js';
import { isInformational } from './intake.js';
import { defaultGit } from './worktrees.js';

const ACTOR = 'goal-loop';
const MANAGER = { role: 'manager', runtime: null, model: null };
const VERIFIER_ACTOR = { role: 'tester', id: 'verifier:deterministic' };
const INFRA_CODES = { ENOSPC: 'host.disk_pressure', EDQUOT: 'host.disk_pressure', ENOMEM: 'host.memory_pressure', EMFILE: 'host.memory_pressure',
  ENFILE: 'host.memory_pressure', EAGAIN: 'runner.starved', EIO: 'health.unknown' };
const HARNESS_LIKE = /missing_artifact|unknown_exit|timeout|unavailable/;
const MAX_BACKOFF_MS = 15 * 60_000;
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
} = {}) {
  if (!store || !registry || !worktrees || !worktreeRoot || !verifier || !reviewRoot) {
    throw new Error('goal loop: store, registry, worktrees, worktreeRoot, verifier and reviewRoot are required');
  }
  const active = new Map();   // task_id -> { adapter, run } | { kill }: what cancel() must stop (agent run or acceptance check)

  // ---------- context: everything a step decides from, folded from the persisted log ----------
  async function load(id) {
    const v = await store.get(id);
    if (!v) throw coded('E_NOT_FOUND', `task ${id} not found`);
    if (v.store_error) return { id, v, broken: true };   // a partial log is not the history: never decide from it
    const events = await readEvents(id);
    const cp = { strategy: null, streak: { signature: null, count: 0 }, stale: 0, changes: 0, best: 0, best_failing: null, tried: [], exclude: [],
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
  const grantsOf = (ctx) => new Set(ctx.events.filter((e) => e.kind === 'approval.granted').flatMap((e) => e.payload.grants?.keys || []));
  const actionKey = (a, scope = '') => `${scope}${a.class}:${hashOf({ argv: a.argv ?? null, text: a.text ?? null, paths: a.paths ?? null })}`;
  function effectiveBudgetPolicy(ctx) {
    let bp = ctx.v.budget_policy;
    for (const e of ctx.events) if (e.kind === 'approval.granted' && e.payload.grants?.budget_policy) bp = { ...bp, ...e.payload.grants.budget_policy };
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
  async function routeFor(ctx, p, { exclude = ctx.cp.exclude } = {}) {
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
    return route(task, { registry: reg, policy: routerPolicy, checkAction: check, allowFake, exclude, now, realpath: (x) => fs.realpathSync(x), floorGrants });
  }
  const routeKey = (ctx) => `route:${ctx.v.base_sha}`;
  const adapterFor = (entryId) => adapters[entryId] || adapters[entryId.split(':')[0]] || null;

  // ---------- budget ----------
  function ledger(ctx) {
    const started = new Map(ctx.events.filter((e) => e.kind === 'task.started').map((e) => [e.payload.run_id, e]));
    return { entries: ctx.events.filter((e) => e.kind === 'usage.recorded').map((e) => {
      const s = started.get(e.payload.run_id);
      return { attempt_id: e.payload.run_id, kind: s?.payload.role || 'unknown', usd: e.payload.usd, input_tokens: e.payload.input_tokens,
        output_tokens: e.payload.output_tokens, duration_ms: s ? Date.parse(e.timestamp) - Date.parse(s.timestamp) : null, turns: 1 };
    }) };
  }
  function estimate(ctx, entry, role, routeHint = null) {
    if (estimateRun) return estimateRun({ task: ctx.v, entry, role, ledger: ledger(ctx) });
    // Measured performance first: the mean of this model's known spend on this task; otherwise unknown (never 0).
    const runs = ledger(ctx).entries.filter((e) => e.kind === role && ctx.events.some((s) => s.kind === 'task.started' && s.payload.run_id === e.attempt_id && s.payload.entry === entry));
    const mean = (k) => { const xs = runs.map((r) => r[k]).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    // No run of this entry yet: the router's price-based estimate when it has one (#5), else unknown.
    const usd = mean('usd') ?? routeHint?.candidates?.find((c) => c.id === entry)?.cost_est_usd ?? null;
    return { usd, input_tokens: mean('input_tokens'), output_tokens: mean('output_tokens'), duration_ms: mean('duration_ms'), turns: 1 };
  }
  // #5: an explicit owner approval of a budget stop authorizes the NEXT run even when its cost cannot be estimated
  // (bound to that request: consumed by the first run started after it). It never overrides a reached cap.
  function nextRunAuthorized(ctx) {
    const g = ctx.events.filter((e) => e.kind === 'approval.granted' && e.payload.grants?.request_kind === 'budget').at(-1);
    return !!g && !ctx.events.some((e) => e.kind === 'task.started' && e.seq > g.seq);
  }
  // T13/GL13: before every start. A cap is a hard stop -> awaiting_approval; quota -> waiting with backoff.
  async function budgetGate(ctx, entry, role, resume_to, { patch = {}, routeHint = null } = {}) {
    const b = budget.check({ ...ctx.v, budget_policy: effectiveBudgetPolicy(ctx) }, ledger(ctx), estimate(ctx, entry, role, routeHint), { quota: quota(entry) });
    if (b.allow) return null;
    const onlyUnknownEstimate = b.state_hint === 'awaiting_approval' && b.reason.split('; ').every((x) => /estimate unknown/.test(x));
    if (onlyUnknownEstimate && nextRunAuthorized(ctx)) return null;
    const evd = [`spent ${JSON.stringify(b.spent)}`, `unknown ${b.unknown_spend.join(',') || 'none'}`];
    const emit = [{ event_id: `budget-${ctx.id}-${ctx.k}`, kind: 'budget.threshold', payload: { reason: b.reason, spent: b.spent, state_hint: b.state_hint } }];
    if (b.state_hint === 'waiting') {
      const delay = Math.min(MAX_BACKOFF_MS, b.backoff_ms ?? 60_000);
      return decide(ctx, decision('budget_wait', 'Start another run now?', [alt('wait for quota reset', 'no spend while exhausted', 'delay'), alt('start anyway', 'progress', 'provider refuses / overspends quota')],
        'wait for quota reset', { evidence: evd, expected_effect: `retry after ${delay} ms`, rationale: b.reason }), {
        patch: { ...patch, wait: { reason: 'quota', until_ms: now() + delay, resume_to } }, to: 'waiting', reason: b.reason, emit });
    }
    return askOwner(ctx, { kind: 'budget', question: `Budget stop: ${b.reason}. Raise or confirm the authorization to continue.`, reason: b.reason, classes: ['budget'] },
      { resume_to, kind: 'budget_stop', extra: { spent: b.spent }, patch }).then((r) => store.append(ctx.id, { event_id: emit[0].event_id, ...emit[0] }).then(() => r));
  }

  // ---------- failure classification and the no-progress rule ----------
  const passingRequired = (ctx, results) => results.filter((r) => r.required && r.status === 'pass').length;
  function chooseStrategy(ctx, sig, routeAlt) {
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
  async function onFailure(ctx, { signature, feedback, passing, failing = null, then = 'repair', thenPatch = {}, reviewOnly = false, p }) {
    const np = ctx.v.no_progress_policy;
    const cp = ctx.cp;
    // D-012: new passing evidence = more required checks pass, or fewer tests fail inside the failing checks.
    const fewerFailing = failing != null && cp.best_failing != null && failing < cp.best_failing;
    const progress = passing > cp.best || fewerFailing;
    const bestFailing = failing == null ? cp.best_failing : cp.best_failing == null ? failing : Math.min(cp.best_failing, failing);
    const stagnation = np.iterations_without_progress ?? DEFAULT_ITERATIONS_WITHOUT_PROGRESS;
    const streak = { signature, count: signature === cp.streak.signature ? cp.streak.count + 1 : 1 };
    const stale = progress ? 0 : cp.stale + 1;
    const changes = progress ? 0 : cp.changes;
    const tried = progress ? [] : cp.tried;
    const base = { streak, stale, best: Math.max(cp.best, passing), best_failing: bestFailing, changes, tried, feedback, provider: null, verify_only: false, review_unavailable: 0 };
    const evidence = [`signature ${signature}`, `same signature ${streak.count}x in a row`, `iterations without new passing evidence: ${stale} (limit ${stagnation})`,
      `strategy changes without progress: ${changes}`, `failing tests ${failing ?? 'n/a'} (best ${cp.best_failing ?? 'n/a'})${progress ? ': progress' : ''}`];
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
    const pick = changes >= np.strategy_changes_without_progress ? null : chooseStrategy(ctx, signature, routeAlt);
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
    const nextStrategy = { ...s, ...(pick === 'replan' ? { plan_rev: s.plan_rev + 1 } : pick === 'harness' ? { harness: 'focused' } : {}) };
    const alts = {
      replan: alt('replan', 'a new approach addresses a wrong plan', 'same model may repeat the same mistake'),
      model: alt(`different model${routeAlt ? ` (${routeAlt.choice})` : ''}`, routeAlt ? `router ranks ${routeAlt.choice} next (${routeAlt.rationale.at(-1)})` : 'n/a', routeAlt ? 'unknown fit for this failure' : 'no other feasible model inside the allowlists'),
      harness: alt('harness change (focused reproduction, full failing output)', 'helps when the failure is not understood or the evidence is incomplete', 'more context per run'),
    };
    return decide(ctx, decision('strategy_change', `Same failure ${streak.count}x (or ${stale} iterations without new evidence): which strategy change?`,
      [alts[pick], ...Object.entries(alts).filter(([k2]) => k2 !== pick).map(([, a]) => a), alt('blind retry', 'cheap', 'forbidden by the no-progress rule')],
      pick, { evidence: [...evidence, `already tried: ${tried.join(', ') || 'none'}`], expected_effect: `next run uses ${pick}`,
        rationale: `No-progress rule: forced strategy change #${changes + 1}. Chose ${pick} by evidence (error class ${signature.split(' :: ')[1]}; untried options in evidence order).`, policy_ref: policyRef(p) }),
    { patch: { ...base, streak: { signature, count: 0 }, stale: 0, changes: changes + 1, tried: [...tried, pick], strategy: nextStrategy,
      exclude: pick === 'model' ? [...cp.exclude, s.entry] : cp.exclude }, to: 'replan', reason: `strategy change: ${pick}` });
  }

  // Provider/runtime errors from a developer run (T12, GL06): router fallback taxonomy, bounded and recorded.
  // A run whose usage shows it was billed (any measured amount, or an incomplete record).
  const billedRun = (ctx, run_id) => ctx.events.some((e) => e.kind === 'usage.recorded' && e.payload.run_id === run_id
    && (e.payload.incomplete === true || ['input_tokens', 'output_tokens', 'usd'].some((k) => typeof e.payload[k] === 'number' && e.payload[k] > 0)));
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
    if (['backoff', 'wait'].includes(plan.action) && billedRun(ctx, run_id) && provider.count >= ctx.v.no_progress_policy.same_signature) {
      return suspend(ctx, 'no_progress', { p, resume_to: 'repair', extraPatch: { provider },
        diagnosis: `developer runtime ${s.entry} failed with ${err.class} ${provider.count}x in a row after billing; ${plan.reason}`,
        next_action: `check ${s.entry} health or enable another compatible runtime, then resume the task`, evidence });
    }
    switch (plan.action) {
      case 'backoff': case 'wait': {
        const delay = Math.min(MAX_BACKOFF_MS, plan.delay_ms ?? 60_000);
        return decide(ctx, d('backoff and retry the same runtime', `waiting ${delay} ms, then repair`), {
          patch: { provider, wait: { reason: err.class, until_ms: now() + delay, resume_to: 'repair' } }, to: 'waiting', reason: `${err.class}: backoff ${delay} ms`, emit });
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
    const stop = async () => { if (await isCancelled(id)) throw coded('E_CANCELLED', `task ${id} is cancelled`); };
    await stop();
    await g(cwd, ['add', '-A']);
    const staged = (await g(cwd, ['diff', '--cached', '--name-only'])).trim();
    await stop();   // re-checked right before the write that names a SHA
    if (staged) await g(cwd, ['-c', `user.name=${commitIdentity.name}`, '-c', `user.email=${commitIdentity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
    return headOf(cwd);
  }
  // #1: the worktree lease is renewed at every dispatch/commit; an expired lease nobody else took is re-acquired by
  // the same owner (recorded); a lease another owner holds suspends the task until inputs change. -> null | step result
  async function ensureLease(ctx, resume_to) {
    const l = ctx.cp.worktree?.lease;
    if (!leases || !l) return null;
    let v;
    try { v = await leases.validate(l); } catch { v = { ok: false, code: 'E_UNAVAILABLE' }; }
    if (v?.ok) { try { await leases.renew(l); } catch { /* validate passed; next dispatch renews again */ } return null; }
    if (v?.code === 'E_EXPIRED' || v?.code === 'E_FENCED') {
      let a;
      try { a = await leases.acquire(l.resource, { owner: l.owner, task_id: ctx.id, ttl_ms: l.ttl_ms || 6 * 3600_000, scope: 'worktree' }); } catch { a = { ok: false, code: 'E_UNAVAILABLE' }; }
      if (a?.ok) {
        const worktree = { ...ctx.cp.worktree, lease: a.lease };
        await note(ctx, `lease-${a.lease.token}`, decision('lease_reacquired', 'The worktree lease lapsed: re-acquire it?', [
          alt('re-acquire as the same owner', 'nobody else holds it; the worktree is still ours; head is revalidated before any evidence counts', 'new fencing token'),
          alt('suspend', 'cautious', 'no reason: the resource is free and owned by this task')], 're-acquire as the same owner', {
          evidence: [`validate ${v.code}`, `new token ${a.lease.token}`], expected_effect: 'continue with a fresh lease', rationale: 'Lease expired while the task was waiting or long-running; re-acquired under the same owner (fencing token advanced).' }),
        { worktree });
        ctx.cp.worktree = worktree;
        return null;
      }
      if (a?.code === 'E_HELD') {
        const diagnosis = `worktree lease ${l.resource} is held by ${a.holder?.owner ?? 'another owner'}`;
        return decide(ctx, decision('lease_unavailable', 'Another owner holds the worktree lease: proceed?', [alt('suspend until inputs change', 'never write under someone else\'s lease', 'blocked'), alt('proceed', 'progress', 'unfenced writes')],
          'suspend until inputs change', { evidence: [diagnosis], expected_effect: 'no writes until the holder releases or the owner resumes', rationale: 'Fail closed on a foreign lease holder.' }),
        { patch: { wait: { reason: 'lease_held', until_ms: null, resume_to, diagnosis, next_action: 'release the foreign lease or resume the task', policy_hash: policyRef(readPolicy(ctx)) } }, to: 'waiting', reason: 'lease held by another owner' });
      }
    }
    // Backend unavailable: unbilled, timed retry (absence of an answer is not availability).
    return decide(ctx, decision('lease_unavailable', 'Lease backend unavailable: proceed?', [alt('wait', 'absence of a lease is not availability', 'delay'), alt('proceed', 'progress', 'unfenced writes')],
      'wait', { evidence: [`validate ${v?.code ?? 'unknown'}`], expected_effect: 'retry after backoff', rationale: 'Fail closed on the worktree lease.' }),
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
    const prev = ctx.cp.strategy || { harness: 'standard', plan_rev: 0, compact: false };
    const strategy = { ...prev, entry: r.choice, effort: ctx.cp.interpretation?.effort ?? null };
    const alts = r.candidates.slice(0, 4).map((c) => alt(c.id, `score ${c.score}`, c.cost_est_usd == null ? 'cost unknown' : `est $${c.cost_est_usd}`));
    if (alts.length < 2) alts.push(alt('wait for another compatible runtime', 'more choice', 'only one runtime passes the floors; waiting adds nothing'));
    return decide(ctx, decision('assign_developer', 'Which runtime/model runs the developer role?', alts,
      r.choice, { evidence: [`router decision ${r.decision.decision_id}`], expected_effect: `developer runs on ${r.choice}`, rationale: `Router selection used for this V2 task: ${r.rationale.at(-1)}`,
        confidence: r.confidence, policy_ref: policyRef(p) }), { patch: { strategy }, to: 'ready', reason: `assigned ${r.choice}` });
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
    return move(ctx, 'executing', ctx.cp.verify_only ? 'resume verification' : `dispatch run ${ctx.id}.run${runNumber(ctx) + 1}`);
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
      await store.append(ctx.id, { event_id: `start-${run_id}`, kind: 'task.started', payload: { run_id, role: 'developer', entry: s.entry, runtime: entry?.runtime ?? null, model: entry?.model ?? null, effort: s.effort, strategy: s } });
      let run = null, error = null;
      try {
        if (!adapter) throw Object.assign(new Error(`no adapter for ${s.entry}`), { code: 'ENOENT' });
        const summary = s.compact ? compactSummary(ctx) : null;
        run = adapter.start({ task_id: ctx.id, run_id: run_id.replace(/[^\w.-]/g, '_'), cwd: wt.path, model: entry?.model, effort: s.effort, timeout_ms: runTimeoutMs, role: 'developer',
          prompt: developerPrompt({ task: ctx.v, strategy: s, feedback: ctx.cp.feedback, summary, worktree: wt }) });
        active.set(ctx.id, { adapter, run });
        const r = await run.done;
        error = r.error;
      } catch (e) { error = adapter ? adapter.normalizeError(e) : { class: 'unavailable', retryable: true, retry_after_ms: null }; }
      finally { active.delete(ctx.id); }
      if (await isCancelled(ctx.id)) {   // T14: no writes after cancel except the truthful effect outcome
        await store.recordEffect(ctx.id, { effect_id, phase: 'failed' });
        return result(ctx, 'cancelled', 'cancelled during run', { terminal: true, transitioned: false });
      }
      const u = run ? adapter.collectUsage(run) : { input_tokens: null, output_tokens: null, usd: null };
      await store.recordUsage(ctx.id, { runtime: entry?.runtime ?? null, provider: entry?.provider ?? null, model: entry?.model ?? null, run_id, ...u }, { event_id: `usage-${run_id}` });
      if (error) await store.append(ctx.id, { event_id: `fail-${run_id}`, kind: 'tool.failed', payload: { run_id, error } });
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
      await store.recordEffect(ctx.id, { effect_id, phase: 'confirmed' });
      ctx = await load(ctx.id);
    }
    const failed = ctx.events.find((e) => e.kind === 'tool.failed' && e.payload.run_id === run_id);
    const reqs = ctx.events.filter((e) => e.kind === 'approval.requested' && e.payload.run_id === run_id);
    if (reqs.length) {
      return askOwner(ctx, { kind: 'agent_action', question: `The developer asked for restricted action(s): ${reqs.map((e) => `${e.payload.action.class}${e.payload.action.argv ? ` (${e.payload.action.argv.join(' ')})` : ''}`).join('; ')}. Not executed.`,
        reason: reqs.map((e) => e.payload.reason).join('; '), classes: [...new Set(reqs.flatMap((e) => e.payload.classes))], keys: reqs.map((e) => e.payload.key),
        actions: reqs.map((e) => e.payload.action) }, { resume_to: 'repair', kind: 'agent_action', policy_ref: policyRef(p), extra: { actions: reqs.map((e) => e.payload.action) } });
    }
    if (failed) return onRunError(ctx, failed.payload.error, p, run_id);
    // Commit what the developer produced so the evidence names an exact SHA.
    if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
    const lw = await ensureLease(ctx, 'repair');   // the run's files stay in the worktree for the next run
    if (lw) return lw;
    const head = await commitAll(ctx.id, wt.path, `v2task ${ctx.id}: ${run_id}`);
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
    if (st.head !== head) return revalidate(ctx, st.head, 'Source changed after the last commit/verification (T10): re-verify on the current SHA.');
    if (st.dirty) {
      return onFailure(ctx, { signature: failureSignature({ test: 'worktree', errorClass: 'uncommitted_changes' }), passing: 0, p,
        feedback: { kind: 'uncommitted_changes', note: 'Tracked files changed outside a recorded run; the controller will commit your next run.' } });
    }
    const vr = await verifier.runChecks({ store, task: ctx.v, cwd: wt.path, sha: head, epoch: ctx.epoch, existing: ctx.evidence, actor: VERIFIER_ACTOR, isCancelled: () => isCancelled(ctx.id),
      register: (kill) => (kill ? active.set(ctx.id, { kill }) : active.delete(ctx.id)) });   // T14: cancel kills a running check
    if (vr.cancelled) return result(ctx, 'cancelled', 'cancelled during verification', { terminal: true, transitioned: false });
    const after = await headOf(wt.path);
    if (after !== head) return revalidate(ctx, after, 'Source changed during verification (T10/GL12): rerun on the new SHA.');
    const results = vr.results;
    const passing = passingRequired(ctx, results);
    const req = results.filter((r) => r.required);
    const feedbackOf = (kind, rs) => ({ kind, sha: head, checks: rs.map((r) => ({ check_id: r.check_id, status: r.status, exits: r.exits, failures: r.failures, output_tail: r.output_tail, error: r.error })) });
    const unavailable = req.filter((r) => r.status === 'unavailable');
    if (unavailable.length) {
      // GL04: unknown result is not passing; wait (backoff) then let the developer address the harness.
      const f = unavailable[0];
      return onFailure(ctx, { signature: failureSignature({ test: f.check_id, errorClass: 'unknown_exit' }), passing, p, feedback: feedbackOf('evidence_unavailable', unavailable),
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
      return onFailure(ctx, { signature: failureSignature({ test: `${f.check_id}:${first.test ?? '?'}`, errorClass: first.error_class }), passing, failing: failingTests, p, feedback: feedbackOf('test_failure', failing) });
    }
    // Every required check passes on this exact SHA. A SHA once seen flaky is never accepted.
    if (ctx.cp.flaky.some((x) => x.endsWith(`@${head}`))) {
      return onFailure(ctx, { signature: failureSignature({ test: 'flaky-sha', errorClass: 'flaky' }), passing: passing - 1, p, feedback: { kind: 'flaky', sha: head, note: 'This SHA was flaky earlier; change the code to remove the nondeterminism.' } });
    }
    return review(ctx, p, results);
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
  function reviewBackoff(ctx, why, extraPatch = {}) {
    const n = ctx.cp.review_unavailable + 1;
    const delay = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (n - 1));
    return decide(ctx, decision('evaluator_unavailable', 'Independent evaluation unavailable: accept on tests alone?', [
      alt('wait and retry the evaluation', 'acceptance needs an independent verdict (GL04)', 'delay'), alt('accept on tests alone', 'fast', 'never: unavailable is not approval')],
    'wait and retry the evaluation', { evidence: [why], expected_effect: `re-evaluate in ${delay} ms without a developer run`, rationale: `Evaluator unavailable: ${why}` }),
    { patch: { ...extraPatch, review_unavailable: n, verify_only: true, wait: { reason: 'evaluator_unavailable', until_ms: now() + delay, resume_to: 'ready' } }, to: 'waiting', reason: 'evaluator unavailable' });
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
    try { const r = await routeFor(ctx, p, { exclude: [...devEntries, ...rf.excluded, entry] }); other = r.choice; } catch { other = null; }
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
    if (!choice) { r = await routeFor(ctx, p, { exclude: [...devEntries, ...rf.excluded] }); choice = r.choice; }
    if (!choice || devEntries.includes(choice)) return { stop: await noReviewer(ctx, `no ${role} runtime independent of ${devEntries.join(', ')}${fixedEntry ? ` (policy names ${fixedEntry})` : ''}`) };
    const stop = await budgetGate(ctx, choice, 'reviewer', 'ready', { patch: { verify_only: true }, routeHint: r });   // #6
    if (stop) return { stop };
    const adapter = adapterFor(choice);
    if (!adapter) return { stop: await reviewBackoff(ctx, `no adapter for ${choice}`) };
    // Per reviewer and role: a later, more independent reviewer on the same SHA gets its own run, usage and verdict ids.
    const run_id = `${ctx.id}.${role === 'reviewer' ? 'review' : role}-${short(head)}-e${ctx.epoch}-${choice.replace(/[^\w.-]/g, '_')}`;
    const dir = path.join(reviewRoot, `${ctx.id}-${short(head)}-e${ctx.epoch}-${role}`);
    const wt = ctx.cp.worktree;
    const entry = registry.get(choice);
    let out;
    try {
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* not there */ }
      await g(wt.path, ['worktree', 'add', '--detach', dir, head]);   // independent, read-only checkout of the exact SHA
      const diff = await g(wt.path, ['diff', ctx.v.base_sha, head]);
      await store.append(ctx.id, { event_id: `start-${run_id}`, kind: 'task.started', payload: { run_id, role: 'reviewer', review_role: role, entry: choice, runtime: entry?.runtime ?? null, model: entry?.model ?? null } });
      out = await verifier.review({ adapter, entry, task: ctx.v, sha: head, cwd: fs.realpathSync(dir), diff, evidence: ctx.evidence.length ? ctx.evidence : (await load(ctx.id)).evidence,
        run_id: run_id.replace(/[^\w.-]/g, '_'), timeout_ms: runTimeoutMs, role, strict: rf.strict, onStart: (run) => active.set(ctx.id, { adapter, run }) });
    } finally {
      active.delete(ctx.id);
      try { await g(wt.path, ['worktree', 'remove', '--force', dir]); } catch { /* best effort; the dir is outside the task worktree */ }
    }
    if (await isCancelled(ctx.id)) return { stop: result(ctx, 'cancelled', 'cancelled during review', { terminal: true, transitioned: false }) };
    const u = out.usage || {};
    await store.recordUsage(ctx.id, { runtime: entry?.runtime ?? null, provider: entry?.provider ?? null, model: entry?.model ?? null, run_id,
      input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, usd: u.usd ?? null, ...(u.incomplete ? { incomplete: true } : {}) }, { event_id: `usage-${run_id}` });
    if (out.verdict === 'unavailable') {
      const billed = !!out.run && out.error?.class !== 'unavailable';
      if (!billed) return { stop: await reviewBackoff(ctx, `${role} ${choice}: ${out.error?.class || 'no verdict'}`) };
      return { stop: await reviewerFailure(await load(ctx.id), p, choice, out, devEntries) };
    }
    const verdict = { sha: head, actor: { role, id: choice }, verdict: out.verdict, findings: out.findings };
    await store.recordVerdict(ctx.id, verdict, { event_id: `verdict-${run_id}` });
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
    // Revalidate right before acceptance: never accept on a SHA the worktree no longer has (GL12).
    const now2 = await headOf(ctx.cp.worktree.path);
    if (now2 !== head) return revalidate(fresh, now2, 'Source changed between review and acceptance.');
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
      return decide(ctx, decision('resume', 'Inputs changed after a no-progress wait: resume?', [alt('resume with a replan', 'new inputs can change the outcome', 'more spend'), alt('stay waiting', 'no spend', 'ignores the new input')],
        'resume with a replan', { evidence: [resumed ? 'owner resumed' : 'project policy changed'], expected_effect: 'replan from scratch', rationale: 'No-progress counters reset on new inputs.' }),
      { patch: { changes: 0, tried: [], stale: 0, streak: { signature: null, count: 0 }, exclude: [] }, to: w.resume_to || 'replan', reason: 'inputs changed' });
    }
    if (w.reason === 'infra' && admission?.isPaused?.()) {
      return result(ctx, null, 'waiting (infra): admission paused', { until_ms: now() + 60_000 });
    }
    return move(ctx, w.resume_to || 'ready', `${w.reason} wait elapsed`);
  }

  async function sAwaitingApproval(ctx) {
    const req = ctx.cp.approval;
    if (!req) return result(ctx, null, 'awaiting approval', { idle: true });
    const d = ctx.events.filter((e) => ['approval.granted', 'approval.denied'].includes(e.kind) && e.payload.k === req.k).at(-1);
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
      if (await isCancelled(ctx.id)) return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      await store.recordEffect(ctx.id, { effect_id, idempotency_key, kind: 'integration', phase: 'attempted' });
    }
    // The hook must be idempotent by key: after a crash or an unknown outcome it is asked again with the same key.
    const r = await integrate(ctx.v, { sha: head, worktree: ctx.cp.worktree, idempotency_key });
    const ok = ['release_verifying', 'repair', 'waiting', 'awaiting_approval'].includes(r?.next);
    if (!confirmed) await store.recordEffect(ctx.id, { effect_id, phase: ok ? 'confirmed' : 'possibly_applied' });
    if (!ok) {
      if (!confirmed) return move(ctx, 'unknown_external_effect', `integration outcome unknown: ${r?.reason || 'no result'}`);
      return askOwner(ctx, { kind: 'integration', question: `Integration was applied but the controller reports no usable state: ${r?.reason || 'no result'}`, reason: r?.reason || 'no result', classes: ['integration'] }, { resume_to: 'integrating' });
    }
    const patch = { integration: { next: r.next, reason: r.reason ?? null, release_verified: r.release_verified === true }, integration_unknown: 0 };
    if (r.next === 'waiting') patch.wait = { reason: 'integration', until_ms: now() + (r.retry_after_ms ?? 5 * 60_000), resume_to: 'integrating' };   // D-007
    if (r.next === 'awaiting_approval') patch.approval = { k: ctx.k, kind: 'integration', question: r.reason || 'integration needs owner approval', classes: r.classes || [], resume_to: 'integrating' };
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
        const r = await integrate.reconcile(ctx.v, { effect_id: e.effect_id, idempotency_key: e.idempotency_key });
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
    const ctx = await load(id);
    if (ctx.broken) return result(ctx, null, `store error: ${ctx.v.store_error}; repair the log before stepping`, { idle: true });
    if (TERMINAL.includes(ctx.v.status)) return result(ctx, null, 'terminal', { terminal: true });
    if (isInformational(ctx.v)) return result(ctx, null, 'informational task: not dispatched by the goal loop', { idle: true });
    try {
      if (ctx.pending) return await applyNext(ctx, ctx.pending);   // crash between decision and transition
      return await HANDLERS[ctx.v.status](ctx);
    } catch (e) {
      if (e.code === 'E_CANCELLED') return result(ctx, 'cancelled', 'cancelled', { terminal: true, transitioned: false });
      if (INFRA_CODES[e.code] || INFRA_CODES[e.cause?.code]) return onInfra(ctx, INFRA_CODES[e.code] ? e : e.cause);
      throw e;
    }
  }

  // Loops steps until a terminal state, an `until` state, or nothing can happen without time/owner/new inputs.
  async function run(id, { until = [] } = {}) {
    const stop = typeof until === 'function' ? until : (r) => until.includes(r.state);
    for (;;) {
      const r = await step(id);
      if (r.terminal || TERMINAL.includes(r.state) || stop(r)) return r;
      if (r.transitioned || r.again) continue;
      if (r.until_ms != null) { await sleep(Math.max(0, r.until_ms - now())); continue; }
      return r;
    }
  }

  return {
    step, run,
    // Startup: replay the store (unconfirmed effects -> unknown_external_effect); steps resume from there (T18).
    async recover() {
      const r = await store.recover();
      const open = (await store.list()).filter((t) => !TERMINAL.includes(t.status)).map((t) => t.task_id);
      return { ...r, resumable: open };
    },
    // T14: persist the cancel first, then stop whatever runs; the store rejects every later write.
    async cancel(id, { actor, reason } = {}) {
      if (!actor) throw coded('E_INVALID', 'cancel needs an actor');
      const t = await store.transition(id, 'cancelled', { reason: reason ?? 'cancelled', actor });
      const a = active.get(id);
      if (a?.kill) a.kill();
      else if (a) { try { await a.adapter.cancel(a.run); } catch { /* the run ends with the process group */ } }
      return t;
    },
    // Explicit owner decisions on a pending request. Only recorded approvals ever authorize anything.
    async approve(id, { actor, approval_ref = null, grants = {} } = {}) {
      if (!actor) throw coded('E_INVALID', 'approval needs an actor');
      const ctx = await load(id);
      if (ctx.v.status !== 'awaiting_approval' || !ctx.cp.approval) throw coded('E_ILLEGAL_TRANSITION', 'nothing awaits approval');
      const req = ctx.cp.approval;
      // #7b: a grant can only cover what was asked: the request's classes and action keys, budget only for a budget stop.
      const classes = grants.classes ?? req.classes;
      if (!Array.isArray(classes) || classes.some((c) => !req.classes.includes(c))) throw coded('E_INVALID', `grant exceeds the request (asked: ${req.classes.join(', ') || 'none'})`);
      if (grants.budget_policy !== undefined && req.kind !== 'budget') throw coded('E_INVALID', 'budget authorization only answers a budget stop');
      for (const k of Object.keys(grants)) if (!['classes', 'budget_policy'].includes(k)) throw coded('E_INVALID', `unknown grant field ${k}`);
      const payload = { k: req.k, actor, approval_ref, grants: { classes, keys: req.keys || [], request_kind: req.kind, ...(grants.budget_policy ? { budget_policy: grants.budget_policy } : {}) } };
      return store.append(id, { event_id: `appr-${id}-${req.k}`, kind: 'approval.granted', payload });
    },
    async deny(id, { actor, reason = null } = {}) {
      if (!actor) throw coded('E_INVALID', 'denial needs an actor');
      const ctx = await load(id);
      if (ctx.v.status !== 'awaiting_approval' || !ctx.cp.approval) throw coded('E_ILLEGAL_TRANSITION', 'nothing awaits approval');
      return store.append(id, { event_id: `deny-${id}-${ctx.cp.approval.k}`, kind: 'approval.denied', payload: { k: ctx.cp.approval.k, actor, reason } });
    },
    // Owner nudge for a no-progress wait (an input change the loop cannot observe itself).
    async resume(id, { actor, reason = null } = {}) {
      if (!actor) throw coded('E_INVALID', 'resume needs an actor');
      const ctx = await load(id);
      if (ctx.v.status !== 'waiting') throw coded('E_ILLEGAL_TRANSITION', 'task is not waiting');
      return store.append(id, { event_id: `resume-${id}-${ctx.k}`, kind: 'approval.granted', payload: { k: ctx.k - 1, kind: 'resume', actor, reason } });
    },
    // Read model for UI/API: state, outcome, next action, loop memory.
    async inspect(id) {
      const ctx = await load(id);
      return { task: ctx.v, loop: ctx.cp, head: ctx.head, epoch: ctx.epoch, pending: ctx.pending };
    },
  };
}
