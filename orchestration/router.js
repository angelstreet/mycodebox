// Deterministic router (ARCHITECTURE §8/§9), SHADOW ONLY. Not the root router.js (Jev manager router): that one is
// untouched. Pipeline: hard floors -> classify -> rank feasible candidates -> { choice, candidates, rejected,
// rationale, confidence, fallback, decision }. Pure: no I/O, no clock unless injected. Nothing here starts a runtime.
import { createHash } from 'node:crypto';
import { forbiddenMatch } from '../stall.js';
import { checkEffort, priceStatus, TIERS } from './model-registry.js';

export const WORK_TYPES = ['research', 'coding', 'debugging', 'ui', 'test', 'security', 'operations', 'docs', 'unknown'];
export const DEFAULT_WEIGHTS = Object.freeze({ quality: 0.5, cost: 0.2, latency: 0.1, reliability: 0.2 });
const PRIORITY_WEIGHTS = {
  cost: { quality: 0.3, cost: 0.4, latency: 0.1, reliability: 0.2 },
  balanced: DEFAULT_WEIGHTS,
  quality: { quality: 0.65, cost: 0.1, latency: 0.05, reliability: 0.2 },
  speed: { quality: 0.35, cost: 0.1, latency: 0.35, reliability: 0.2 },
};
// No-history priors (conservative, documented in the rationale): quality by tier, reliability flat.
const TIER_PRIOR = { light: 0.55, standard: 0.7, strong: 0.82 };
const PRIOR_RELIABILITY = 0.8;
const MIN_HISTORY_ATTEMPTS = 5;
const DEFAULT_ESTIMATE = { input_tokens: 30000, output_tokens: 8000 };
const MIN_TIER_BY_RISK = { low: 'light', medium: 'light', high: 'standard', critical: 'strong' };
const MAX_FALLBACKS = 3;
const EPS = 1e-9;

// ---------- hard-floor stub ----------
// Conservative stand-in until orchestration/policy.js is injected: critical risk or a forbidden topic is denied
// (no automatic route), high risk needs approval. Fail closed.
export function defaultCheckAction(task, action) {
  if (task?.risk_class === 'critical') return { allow: false, needs_approval: true, reason: 'risk_class critical: no automatic action' };
  const hit = forbiddenMatch(taskText(task));
  if (hit) return { allow: false, needs_approval: true, reason: `forbidden topic "${hit}": owner decides` };
  if (task?.risk_class === 'high') return { allow: true, needs_approval: true, reason: 'risk_class high: owner approval required' };
  void action;
  return { allow: true, needs_approval: false, reason: 'no policy block' };
}

function taskText(task) {
  const parts = [task?.goal, task?.title, task?.description];
  // prohibited_actions is excluded on purpose: it lists what the task must NOT do and would match every forbidden topic.
  for (const k of ['scope', 'definition_of_done']) if (task?.[k] != null) parts.push(typeof task[k] === 'string' ? task[k] : JSON.stringify(task[k]));
  return parts.filter((x) => typeof x === 'string' && x).join('\n');
}

// ---------- classify ----------
const CLASSIFIERS = [   // order = precedence
  ['security', /\b(security|vulnerab|cve|xss|csrf|injection|auth(?:n|z|entication|orization)?|permission|sandbox|threat)\b/i],
  ['operations', /\b(ops|operations|incident|restart|service|systemd|host|disk|infra|ci\b|pipeline|rollout|monitor|backup)\b/i],
  ['debugging', /\b(debug|bug|fix|crash|regress|flaky|failing|stack ?trace|root cause|error)\b/i],
  ['test', /\b(tests?|coverage|fixtures?|spec|e2e|assert)\b/i],
  ['ui', /\b(ui|ux|css|layout|frontend|component|page|button|responsive|accessib\w*|mobile)\b/i],
  ['docs', /\b(docs?|documentation|readme|changelog|comment|tutorial)\b/i],
  ['research', /\b(research|investigate|compare|survey|explore|analy[sz]e|audit|evaluate|find out)\b/i],
  ['coding', /\b(implement|add|build|create|refactor|write|feature|function|module|endpoint|api|code)\b/i],
];
export function classifyWork(task) {
  const text = taskText(task);
  const signals = [];
  let type = 'unknown';
  for (const [t, re] of CLASSIFIERS) { const m = text.match(re); if (m) { type = t; signals.push(`"${m[0]}" -> ${t}`); break; } }
  const scope = task?.scope;
  const files = Array.isArray(scope) ? scope.length : Array.isArray(scope?.paths) ? scope.paths.length : Array.isArray(scope?.files) ? scope.files.length : null;
  const deps = Array.isArray(task?.dependencies) ? task.dependencies.length : 0;
  const impact = { low: 0.1, medium: 0.4, high: 0.7, critical: 1 }[task?.risk_class] ?? 0.4;
  const ambiguity = type === 'unknown' ? 1 : 0.2;
  const fileScore = files == null ? 0.4 : Math.min(1, files / 10);
  const complexity = round2(0.35 * fileScore + 0.15 * Math.min(1, deps / 5) + 0.25 * ambiguity + 0.25 * impact);
  return { type, signals, needs_discovery: type === 'unknown', complexity, factors: { files, dependencies: deps, ambiguity, impact } };
}

// ---------- helpers ----------
const round2 = (x) => Math.round(x * 100) / 100;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const known = (v) => typeof v === 'number' && Number.isFinite(v);
const inter = (a, b) => (a && b ? a.filter((x) => b.includes(x)) : (a || b || null));
const list = (v) => (Array.isArray(v) && v.length ? v : null);

function allowlists(task, policy) {
  const first = (...vs) => vs.map(list).reduce((acc, v) => inter(acc, v), null);
  const privClass = task?.privacy_class;
  return {
    runtimes: first(task?.runtime_allowlist, policy?.runtime_allowlist),
    models: first(task?.model_allowlist, policy?.model_allowlist),
    providers: first(task?.privacy_policy?.allowed_providers, policy?.provider_allowlist, privClass ? policy?.privacy_class_providers?.[privClass] : null),
  };
}

function floors(task, entry, ctx) {
  const { al, caps, effort, ctxTokens, minTier, exclude, allowFake, now, maxAgeDays } = ctx;
  void now; void maxAgeDays;
  if (exclude.includes(entry.id)) return 'excluded by caller (e.g. independent verifier must differ)';
  if (entry.test_only && !allowFake) return 'test-only runtime is not routable outside tests';
  if (!entry.routable) return entry.unroutable_reason || 'runtime not routable';
  if (al.runtimes && !al.runtimes.includes(entry.runtime)) return `runtime ${entry.runtime} not in runtime allowlist`;
  if (al.providers && !al.providers.includes(entry.provider)) return `provider ${entry.provider} not in provider/privacy allowlist`;
  if (al.models && !al.models.includes(entry.model)) return `model ${entry.model} not in model allowlist`;
  const missing = caps.filter((c) => !entry.capabilities.includes(c));
  if (missing.length) return `missing capability: ${missing.join(', ')}`;
  const ef = checkEffort(entry, effort);
  if (!ef.ok) return ef.reason;
  if (ctxTokens != null) {
    if (entry.context_tokens == null) return `context size unknown, cannot satisfy ${ctxTokens} tokens`;
    if (entry.context_tokens < ctxTokens) return `context ${entry.context_tokens} < required ${ctxTokens}`;
  }
  if (TIERS.indexOf(entry.tier) < TIERS.indexOf(minTier)) return `tier ${entry.tier} below the ${minTier} floor for risk_class ${task?.risk_class}`;
  return null;
}

// ---------- score ----------
function metrics(entry, hist, estimate, workType, ctx) {
  const h = hist?.by_type?.[workType] && hist.by_type[workType].attempts >= MIN_HISTORY_ATTEMPTS ? hist.by_type[workType] : hist;
  const meaningful = !!(h && known(h.attempts) && h.attempts >= MIN_HISTORY_ATTEMPTS && known(h.verified));
  const quality = meaningful ? (h.verified + 1) / (h.attempts + 2) : TIER_PRIOR[entry.tier];
  const reliability = meaningful && known(h.errors) ? (h.attempts - h.errors + 1) / (h.attempts + 2) : PRIOR_RELIABILITY;
  const latency = known(h?.latency_ms) && meaningful ? h.latency_ms : entry.latency_ms;
  // cost per verified completion: observed spend when known, else price x estimate / quality. Stale/unknown price = unknown.
  let cost = null; let cost_basis = 'unknown';
  if (meaningful && known(h.total_usd) && h.verified > 0) { cost = h.total_usd / h.verified; cost_basis = 'history'; }
  else if (priceStatus(entry, ctx) === 'fresh') {
    cost = ((estimate.input_tokens * entry.price.input + estimate.output_tokens * entry.price.output) / 1e6) / quality;
    cost_basis = 'price_estimate';
  } else if (priceStatus(entry, ctx) === 'stale') cost_basis = 'stale_price';
  return { quality, reliability, latency: known(latency) ? latency : null, cost, cost_basis, history: meaningful };
}

function norm(values, invert) {   // min-max over known values; unknown -> null
  const ks = values.filter(known);
  if (!ks.length) return values.map(() => null);
  const lo = Math.min(...ks); const hi = Math.max(...ks);
  return values.map((v) => (!known(v) ? null : hi - lo < EPS ? 1 : invert ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)));
}

function rank(cands, weights, complexity) {
  const costS = norm(cands.map((c) => c.cost_est_usd), true);
  const latS = norm(cands.map((c) => c.latency_ms), true);
  cands.forEach((c, i) => {
    // light models are penalised on complex work (conservative prior, only without history).
    const fit = !c.history && c.tier === 'light' ? Math.max(0, 1 - complexity) * 0.2 + 0.8 : 1;
    const q = c.quality * fit;
    // unknown cost scores 0 (worst), unknown latency 0.5 (neutral): unknown is never the cheapest.
    c.score = round6(weights.quality * q + weights.cost * (costS[i] ?? 0) + weights.latency * (latS[i] ?? 0.5) + weights.reliability * c.reliability);
  });
  return cands.sort((a, b) => (b.score - a.score)
    || ((known(a.cost_est_usd) ? 0 : 1) - (known(b.cost_est_usd) ? 0 : 1))     // tie: known cost before unknown
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- route ----------
export function route(task, { registry, policy = null, history = {}, weights = null, mode = 'shadow', checkAction = defaultCheckAction,
  now = Date.now, exclude = [], allowFake = false, maxPriceAgeDays = 90 } = {}) {
  if (mode !== 'shadow') { const e = new Error(`router mode "${mode}" not supported: shadow only`); e.code = 'E_NOT_LIVE'; throw e; }
  if (!registry) throw new TypeError('route: registry required');
  const entries = registry.entries();
  const priceCtx = { now: now(), maxAgeDays: maxPriceAgeDays };
  const work = classifyWork(task);
  const rejected = [];
  const rationale = [];

  // Floor 0: policy / forbidden topic / risk. Fail closed (a throwing checker denies). Nothing is ranked on denial.
  let act;
  try { act = checkAction(task, { kind: 'route', work_type: work.type }) || { allow: false, reason: 'checkAction returned nothing' }; }
  catch (e) { act = { allow: false, needs_approval: true, reason: `checkAction failed: ${e.message}` }; }
  const policyRef = policy?.version != null ? `policy@${policy.version}` : (policy?.id || 'policy:default-stub');
  if (!act.allow) {
    for (const e of entries) rejected.push({ id: e.id, reason: `policy: ${act.reason}` });
    rationale.push(`Denied by policy floor: ${act.reason}. No automatic route; owner decision required.`);
    return finish(task, { choice: null, candidates: [], rejected, rationale, confidence: 1, fallback: [], work, mode, auto_allowed: false, requires_approval: true, state_hint: 'awaiting_approval', policyRef, now });
  }
  const requires_approval = !!act.needs_approval;
  if (requires_approval) rationale.push(`Policy: ${act.reason}. A choice is proposed but must be approved before it runs.`);

  const caps = [...new Set([...(task?.required_capabilities || []), ...(task?.runtime_capabilities || [])])].sort();
  const minTier = MIN_TIER_BY_RISK[task?.risk_class] || 'standard';
  const ctx = { al: allowlists(task, policy), caps, effort: task?.effort ?? null, ctxTokens: known(task?.context_tokens_estimate) ? task.context_tokens_estimate : null, minTier, exclude, allowFake, ...priceCtx };
  const feasible = [];
  for (const e of entries) {
    const why = floors(task, e, ctx);
    if (why) rejected.push({ id: e.id, reason: why }); else feasible.push(e);
  }
  rejected.sort((a, b) => (a.id < b.id ? -1 : 1));

  if (!feasible.length) {
    rationale.push('No candidate passes the hard floors; nothing is routable. Needs owner input or a compatible runtime.');
    return finish(task, { choice: null, candidates: [], rejected, rationale, confidence: 1, fallback: [], work, mode, auto_allowed: false, requires_approval: true, state_hint: 'waiting', policyRef, now });
  }

  const estimate = { ...DEFAULT_ESTIMATE, ...(task?.estimate || {}) };
  const w = { ...(weights || PRIORITY_WEIGHTS[task?.priority] || DEFAULT_WEIGHTS) };
  const cands = feasible.map((e) => {
    const m = metrics(e, history?.[e.id], estimate, work.type, priceCtx);
    return { id: e.id, runtime: e.runtime, provider: e.provider, model: e.model, tier: e.tier, context_tokens: e.context_tokens,
      availability: e.availability, quality: round6(m.quality), reliability: round6(m.reliability), latency_ms: m.latency,
      cost_est_usd: m.cost == null ? null : round6(m.cost), cost_basis: m.cost_basis, history: m.history, score: 0 };
  });
  rank(cands, w, work.complexity);
  const choice = cands[0];

  // Rationale: say what drove it, and every conservative default used.
  rationale.push(`Work type "${work.type}" (complexity ${work.complexity}); ${feasible.length} of ${entries.length} candidates pass the hard floors.`);
  if (work.needs_discovery) rationale.push('Work type unknown: needs a discovery step first; confidence is capped, not high.');
  if (cands.some((c) => !c.history)) rationale.push(`No meaningful history (< ${MIN_HISTORY_ATTEMPTS} attempts) for ${cands.filter((c) => !c.history).length} candidate(s): conservative tier priors used (light ${TIER_PRIOR.light}, standard ${TIER_PRIOR.standard}, strong ${TIER_PRIOR.strong}), reliability ${PRIOR_RELIABILITY}.`);
  const unk = cands.filter((c) => c.cost_est_usd == null);
  if (unk.length) rationale.push(`Unknown/stale cost for ${unk.map((c) => c.id).join(', ')}: ranked after known-cost candidates at equal quality, never treated as cheapest or $0.`);
  rationale.push(`Chose ${choice.id} (score ${choice.score}) with weights q=${w.quality} c=${w.cost} l=${w.latency} r=${w.reliability}.`);

  const fallback = cands.slice(1, 1 + MAX_FALLBACKS).map((c) => ({ id: c.id, provider: c.provider, context_tokens: c.context_tokens }));
  let confidence = 0.9;
  const second = cands[1];
  const margin = second ? choice.score - second.score : 0.3;
  confidence = Math.min(confidence, 0.45 + Math.min(0.45, margin * 3));
  if (!choice.history) confidence = Math.min(confidence, 0.6);
  if (work.needs_discovery) confidence = Math.min(confidence, 0.3);
  if (choice.availability === 'unknown') confidence -= 0.1;
  if (choice.cost_est_usd == null) confidence -= 0.1;
  if (!second) confidence = Math.min(confidence, 0.5);
  confidence = round2(Math.max(0.05, confidence));

  return finish(task, { choice: choice.id, candidates: cands, rejected, rationale, confidence, fallback, work, mode, auto_allowed: !requires_approval, requires_approval, state_hint: requires_approval ? 'awaiting_approval' : null, policyRef, now });
}

function finish(task, r) {
  const { now, policyRef, ...out } = r;
  const chosen = out.choice ?? 'needs_owner';
  const evidence = [`work_type=${out.work.type}`, `rejected=${out.rejected.length}`, `candidates=${out.candidates.length}`];
  const id = createHash('sha256').update(JSON.stringify([task?.task_id ?? null, chosen, out.candidates.map((c) => [c.id, c.score]), out.rejected, out.mode])).digest('hex').slice(0, 16);
  const decision = {
    decision_id: `rt-${id}`, task_id: task?.task_id ?? null, ts: new Date(now()).toISOString(), kind: 'route',
    question: `Which runtime/model should handle task ${task?.task_id ?? '(unnamed)'}?`,
    alternatives: out.candidates.map((c) => ({ option: c.id, pros: [`score ${c.score}`, `quality ${c.quality}`], cons: [c.cost_est_usd == null ? 'cost unknown' : `est. $${c.cost_est_usd} per verified completion`, ...(c.history ? [] : ['no history'])] })),
    chosen, evidence, expected_effect: out.mode === 'shadow' ? 'shadow: recorded only, no runtime is started and live behaviour is unchanged' : 'runtime assignment',
    rationale: out.rationale.join(' '), actor: { role: 'router', runtime: null, model: null },
    confidence: out.choice == null ? null : out.confidence, policy_ref: policyRef, reversible: true, rollback: 'discard the shadow record; nothing was executed',
  };
  return { ...out, decision };
}

// ---------- fallback by error class ----------
// plan = fallbackPlan(result, { error_class, failed, attempt, retry_after_ms }) -> { action, next, delay_ms, state_hint, reason }
// Only candidates that already passed the floors (result.candidates/fallback) can be picked, so a provider failure can
// never route outside the allowlists or around the risk policy. permission/auth/deploy never fall back.
const NO_FALLBACK = new Set(['permission', 'auth', 'credentials', 'deploy']);
export function fallbackPlan(result, opts = {}) {
  // A fallback inherits the approval requirement of the original route: failure never relaxes policy.
  return { ...planFallback(result, opts), requires_approval: !!result?.requires_approval };
}
function planFallback(result, { error_class, failed = result?.choice, attempt = 0, retry_after_ms = null, max_backoffs = 2 } = {}) {
  const stop = (reason, state_hint = 'awaiting_approval') => ({ action: 'approval', next: null, delay_ms: null, state_hint, reason });
  if (!result || result.auto_allowed === false && result.choice == null) return stop('no authorised route to fall back from');
  if (NO_FALLBACK.has(error_class)) return stop(`${error_class}: no automatic fallback, owner approval required`);
  const pool = (result.candidates || []).filter((c) => c.id !== failed);
  const cur = (result.candidates || []).find((c) => c.id === failed);
  const otherProvider = pool.filter((c) => !cur || c.provider !== cur.provider);
  const wait = (reason) => ({ action: 'wait', next: null, delay_ms: Math.min(900000, 30000 * 2 ** Math.min(attempt, 5)), state_hint: 'waiting', reason });
  switch (error_class) {
    case 'rate_limit':
    case 'timeout': {
      if (attempt < max_backoffs) return { action: 'backoff', next: failed, delay_ms: known(retry_after_ms) ? retry_after_ms : Math.min(900000, 30000 * 2 ** attempt), state_hint: 'waiting', reason: `${error_class}: backoff ${attempt + 1}/${max_backoffs} before switching` };
      const nx = otherProvider[0] || pool[0];
      return nx ? { action: 'switch', next: nx.id, delay_ms: 0, state_hint: null, reason: `${error_class} persists after ${max_backoffs} backoffs: compatible ${nx.provider} candidate` } : wait(`${error_class}: no compatible alternative inside the allowlist`);
    }
    case 'context_overflow': {
      if (attempt === 0) return { action: 'compact', next: failed, delay_ms: 0, state_hint: null, reason: 'context overflow: compact context and retry' };
      const bigger = pool.filter((c) => known(c.context_tokens) && (!cur || !known(cur.context_tokens) || c.context_tokens > cur.context_tokens)).sort((a, b) => b.context_tokens - a.context_tokens || (a.id < b.id ? -1 : 1))[0];
      return bigger ? { action: 'switch', next: bigger.id, delay_ms: 0, state_hint: null, reason: 'context overflow persists: larger-context candidate' } : { action: 'replan', next: null, delay_ms: null, state_hint: 'replan', reason: 'context overflow and no larger-context candidate: replan with a smaller scope' };
    }
    case 'unavailable': {
      const nx = otherProvider[0] || pool[0];
      return nx ? { action: 'switch', next: nx.id, delay_ms: 0, state_hint: null, reason: 'runtime unavailable: compatible alternative' } : wait('runtime unavailable and no alternative inside the allowlist');
    }
    default: {   // crash / unknown: one retry, then a compatible alternative; never unbounded
      if (attempt === 0) return { action: 'backoff', next: failed, delay_ms: 5000, state_hint: 'waiting', reason: `${error_class || 'unknown'} error: one retry first` };
      const nx = pool[0];
      return nx ? { action: 'switch', next: nx.id, delay_ms: 0, state_hint: null, reason: `${error_class || 'unknown'} error repeated: alternative` } : wait('no alternative inside the allowlist');
    }
  }
}
