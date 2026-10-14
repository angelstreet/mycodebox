// Deterministic router (ARCHITECTURE §8/§9), SHADOW ONLY. Not the root router.js (Jev manager router): that one is
// untouched. Pipeline: hard floors -> classify -> rank feasible candidates -> { choice, candidates, rejected,
// rationale, confidence, fallback, decision }. Pure: no I/O, no clock unless injected. Nothing here starts a runtime.
import { createHash } from 'node:crypto';
import { forbiddenMatch } from '../stall.js';
import { resolve, sep, isAbsolute } from 'node:path';
import { checkEffort, priceStatus, TIERS } from './model-registry.js';
import { WORK_TYPES } from './task-contract.js';

export { WORK_TYPES };
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
const UNKNOWN_RISK_TIER = 'strong';   // unknown risk is treated as high-stakes: strongest tier only, and approval
const MAX_FALLBACKS = 3;
// D-025: a subscription (flat plan) costs ~0 at the margin. Its routing cost is the plan's share per token when the
// registry knows the quota (quota.usd / quota.tokens), else this nominal USD per million tokens: known and near zero,
// so it is never "unknown" (worst) and never a measured $0, and token-heavy runs still cost more than light ones.
export const SUBSCRIPTION_NOMINAL_USD_PER_MTOK = 0.05;
// D-026 escalation ladder: the cheapest rung whose (fit-adjusted) quality reaches this starts; failures climb.
export const LADDER_MIN_QUALITY = 0.5;
const BILLING_RANK = { subscription: 0, per_token: 1, unknown: 2 };
const EPS = 1e-9;

// ---------- hard floors ----------
export const normRisk = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
const RISKS = ['low', 'medium', 'high', 'critical'];
const UNSERIALIZABLE = '\u0000unserializable';
const text1 = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v) ?? ''; } catch { return UNSERIALIZABLE; } };

// Floors the router always applies itself, whatever checker is injected (a lax or missing policy cannot waive them):
// non-object task, critical risk, forbidden topic. Unknown/missing risk only adds an approval requirement.
// floorGrants: floors an explicit, recorded owner approval has waived for THIS task (D-014). Only 'critical_risk' is
// waivable; the caller (goal loop) binds the grant to the task and its base/head before passing it.
export const WAIVABLE_FLOORS = Object.freeze(['critical_risk']);
export function routerFloor(task, { floorGrants = [] } = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return { allow: false, needs_approval: true, reason: 'task is not an object: nothing to route' };
  if (taskText(task).includes(UNSERIALIZABLE)) return { allow: false, needs_approval: true, reason: 'task text is not serializable: cannot check forbidden topics' };
  const risk = normRisk(task.risk_class);
  const waived = Array.isArray(floorGrants) && floorGrants.includes('critical_risk');
  if (risk === 'critical' && !waived) return { allow: false, needs_approval: true, reason: 'risk_class critical: no automatic action' };
  const hit = forbiddenMatch(taskText(task));
  if (hit) return { allow: false, needs_approval: true, reason: `forbidden topic "${hit}": owner decides` };
  if (risk === 'critical') return { allow: true, needs_approval: false, reason: 'risk_class critical: routing approved by the owner for this task (D-014)' };
  if (!RISKS.includes(risk)) return { allow: true, needs_approval: true, reason: `risk_class ${JSON.stringify(task.risk_class ?? null)} is not a known level: owner approval required` };
  return { allow: true, needs_approval: false, reason: 'no router floor hit' };
}

// High-risk approval is policy.js's job (approval_policy); this stub only mirrors it conservatively until it is injected.
// Conservative stand-in until orchestration/policy.js is injected. Frozen signature (ARCHITECTURE §4):
// checkAction(policy, task, action). Fail closed.
export function defaultCheckAction(policy, task, action) {
  void policy; void action;
  const f = routerFloor(task);
  if (!f.allow || f.needs_approval) return f;
  if (normRisk(task.risk_class) === 'high') return { allow: true, needs_approval: true, reason: 'risk_class high: owner approval required' };
  return { allow: true, needs_approval: false, reason: 'no policy block' };
}

function taskText(task) {
  const parts = [task?.goal, task?.title, task?.description];
  // prohibited_actions is excluded on purpose: it lists what the task must NOT do and would match every forbidden topic.
  for (const k of ['scope', 'definition_of_done']) parts.push(task?.[k]);
  return parts.map(text1).filter(Boolean).join('\n');
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
  // Round 5: a declared task_class naming a work type wins over keywords (a docs task whose definition of done names
  // its checks, "...-tests passes", is still docs work and gets the docs run limits).
  if (typeof task?.task_class === 'string' && CLASSIFIERS.some(([t]) => t === task.task_class)) { type = task.task_class; signals.push(`task_class ${type}`); }
  else for (const [t, re] of CLASSIFIERS) { const m = text.match(re); if (m) { type = t; signals.push(`"${m[0]}" -> ${t}`); break; } }
  const scope = task?.scope;
  const files = Array.isArray(scope) ? scope.length : Array.isArray(scope?.paths) ? scope.paths.length : Array.isArray(scope?.files) ? scope.files.length : null;
  const deps = Array.isArray(task?.dependencies) ? task.dependencies.length : 0;
  const impact = { low: 0.1, medium: 0.4, high: 0.7, critical: 1 }[normRisk(task?.risk_class)] ?? 1;
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
// Allowlist semantics: absent (null/undefined) = no restriction; present = exactly that list. A present-but-empty or
// malformed list matches nothing (fail closed). A bare string is a one-element list.
const MATCH_NOTHING = [];
function list(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v ? [v] : MATCH_NOTHING;
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string' && x) ? v : v.filter((x) => typeof x === 'string' && x);
  return MATCH_NOTHING;
}

function allowlists(task, policy) {
  const first = (...vs) => vs.map(list).reduce((acc, v) => inter(acc, v), null);
  const t = task || {};
  const pol = policy && typeof policy === 'object' ? policy : {};
  const ppBad = t.privacy_policy != null && (typeof t.privacy_policy !== 'object' || Array.isArray(t.privacy_policy));   // malformed privacy policy matches nothing
  const pp = !ppBad && t.privacy_policy ? t.privacy_policy : {};
  let classProviders = null;
  if (t.privacy_class != null) {   // a privacy class the policy does not map must not widen to every provider
    const m = pol.privacy_class_providers;
    classProviders = m && typeof m === 'object' && typeof t.privacy_class === 'string' && Object.hasOwn(m, t.privacy_class) ? m[t.privacy_class] : MATCH_NOTHING;
  }
  return {
    runtimes: first(t.runtime_allowlist, pol.runtime_allowlist),
    models: first(t.model_allowlist, pol.model_allowlist),
    providers: first(ppBad ? MATCH_NOTHING : pp.allowed_providers, pol.provider_allowlist, classProviders),
  };
}

// Working-directory floor. Root config: `policy.allowed_roots` (absolute paths; the goal loop must pass the V2 worktree
// root there or every worktree route is denied). Paths are resolved with the injected `realpath` (e.g. fs.realpathSync)
// when given, so symlinks cannot escape a root; otherwise lexically.
export const WORKDIR_ROOTS_KEY = 'allowed_roots';
export function workdirFloor(task, policy, realpath = null) {
  const rp = (p) => { if (!realpath) return resolve(p); try { return resolve(realpath(p)); } catch { return null; } };
  for (const k of ['cwd', 'worktree', 'worktree_path']) {
    if (task[k] == null) continue;
    const roots = policy && Array.isArray(policy[WORKDIR_ROOTS_KEY]) ? policy[WORKDIR_ROOTS_KEY].filter((r) => typeof r === 'string' && isAbsolute(r)) : [];
    if (typeof task[k] !== 'string' || !isAbsolute(task[k])) return `${k} must be an absolute path`;
    if (!roots.length) return `${k} given but no allowed working-directory roots are configured (policy.${WORKDIR_ROOTS_KEY})`;
    const p = rp(task[k]);
    if (p == null) return `${k} cannot be resolved`;
    if (!roots.some((r) => { const rr = rp(r); return rr != null && (p === rr || p.startsWith(rr.endsWith(sep) ? rr : rr + sep)); })) return `${k} ${p} is outside the allowed roots`;
  }
  return null;
}

// Task-shape floors that apply to every candidate. Returns a reason or null.
function shapeFloor(task, policy, realpath) {
  for (const k of ['required_capabilities', 'runtime_capabilities']) {
    const v = task[k];
    if (v != null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return `malformed ${k}: expected an array of strings`;
  }
  const c = task.context_tokens_estimate;
  if (c != null && !(known(ctxNum(c)) && ctxNum(c) >= 0)) return 'malformed context_tokens_estimate: expected a non-negative number';
  const e = task.estimate;
  if (e != null && (typeof e !== 'object' || Object.values(e).some((v) => v != null && !(known(v) && v >= 0)))) return 'malformed estimate: amounts must be non-negative numbers';
  return workdirFloor(task, policy, realpath);
}
const ctxNum = (c) => (typeof c === 'number' ? c : typeof c === 'string' && c.trim() !== '' ? Number(c) : NaN);

function floors(task, entry, ctx) {
  const { al, caps, effort, ctxTokens, minTier, exclude, allowFake, now, maxAgeDays, limitsFor } = ctx;
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
  if (TIERS.indexOf(entry.tier) < TIERS.indexOf(minTier)) return `tier ${entry.tier} below the ${minTier} floor for risk_class ${JSON.stringify(task?.risk_class ?? null)}`;
  // D-024: run limits this entry cannot honour (an effort it does not support) reject it; never translated.
  if (limitsFor) {
    let lim;
    try { lim = limitsFor(entry); } catch (e) { return `run_limits: ${e.message}`; }
    if (lim?.error) return lim.error;
  }
  return null;
}

// ---------- score ----------
function metrics(entry, hist, estimate, workType, ctx) {
  const typed = hist?.by_type?.[workType];
  const h = typed && validHistory(typed) && typed.attempts >= MIN_HISTORY_ATTEMPTS ? typed : hist;
  const history_invalid = !!(h && !validHistory(h));   // corrupt counts are ignored, never trusted
  const meaningful = !!(h && !history_invalid && h.attempts >= MIN_HISTORY_ATTEMPTS);
  // Rework costs time and tokens: a known first-pass rate scales the verified-rate quality by 0.85..1 (D-025).
  const fp = meaningful && known(h.first_pass_rate) && h.first_pass_rate >= 0 && h.first_pass_rate <= 1 ? 0.85 + 0.15 * h.first_pass_rate : 1;
  const quality = meaningful ? ((h.verified + 1) / (h.attempts + 2)) * fp : TIER_PRIOR[entry.tier];
  const reliability = meaningful && known(h.errors) ? (h.attempts - h.errors + 1) / (h.attempts + 2) : PRIOR_RELIABILITY;
  const latency = known(h?.latency_ms) && meaningful ? h.latency_ms : entry.latency_ms;
  // Tokens fold into cost (D-025): a model's measured mean tokens per attempt replace the task estimate, so token-heavy
  // models cost more on every billing basis.
  const tok = meaningful && Number.isInteger(h.token_attempts) && h.token_attempts > 0 && known(h.input_tokens) && known(h.output_tokens)
    ? { input_tokens: h.input_tokens / h.token_attempts, output_tokens: h.output_tokens / h.token_attempts, basis: 'history' } : { ...estimate, basis: 'estimate' };
  const priced = (p) => ((tok.input_tokens * p.input + tok.output_tokens * p.output) / 1e6) / quality;
  // cost per verified completion: observed spend when known, else price x tokens / quality. Stale/unknown price = unknown.
  let cost = null; let cost_basis = 'unknown';
  if (entry.billing === 'subscription') {
    const q = entry.quota;
    const share = q && known(q.usd) && known(q.tokens) && q.tokens > 0 ? (q.usd / q.tokens) * 1e6 : null;
    const per = share ?? SUBSCRIPTION_NOMINAL_USD_PER_MTOK;
    cost = priced({ input: per, output: per }); cost_basis = share != null ? 'subscription_quota' : 'subscription_nominal';
  }
  // a $0 history is not a verified $0 cost
  else if (meaningful && known(h.total_usd) && h.total_usd > 0 && h.verified > 0) { cost = h.total_usd / h.verified; cost_basis = 'history'; }
  else if (priceStatus(entry, ctx) === 'fresh') { cost = priced(entry.price); cost_basis = 'price_estimate'; }
  else if (priceStatus(entry, ctx) === 'stale') cost_basis = 'stale_price';
  return { quality, reliability, latency: known(latency) ? latency : null, cost, cost_basis, tokens: tok, history: meaningful, history_invalid };
}

// Counts must be coherent: integers, 0 <= verified <= attempts, 0 <= errors <= attempts, total_usd (if given) >= 0.
function validHistory(h) {
  if (!h || typeof h !== 'object') return false;
  const int = (v) => Number.isInteger(v) && v >= 0;
  if (!int(h.attempts) || !int(h.verified) || h.verified > h.attempts) return false;
  if (h.errors != null && (!int(h.errors) || h.errors > h.attempts)) return false;
  if (h.total_usd != null && !(known(h.total_usd) && h.total_usd >= 0)) return false;
  if (h.latency_ms != null && !(known(h.latency_ms) && h.latency_ms >= 0)) return false;
  for (const k of ['input_tokens', 'output_tokens']) if (h[k] != null && !(known(h[k]) && h[k] >= 0)) return false;
  if (h.token_attempts != null && !int(h.token_attempts)) return false;   // runs with known tokens (may exceed task attempts)
  return true;
}

function norm(values, invert) {   // min-max over known values; unknown -> null
  const ks = values.filter(known);
  if (!ks.length) return values.map(() => null);
  const lo = Math.min(...ks); const hi = Math.max(...ks);
  return values.map((v) => (!known(v) ? null : hi - lo < EPS ? 1 : invert ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)));
}

// light models are penalised on complex work (conservative prior, only without history).
const fitOf = (c, complexity) => (!c.history && c.tier === 'light' ? Math.max(0, 1 - complexity) * 0.2 + 0.8 : 1);

function rank(cands, weights, complexity) {
  const costS = norm(cands.map((c) => c.cost_est_usd), true);
  const latS = norm(cands.map((c) => c.latency_ms), true);
  cands.forEach((c, i) => {
    const q = c.quality * fitOf(c, complexity);
    // unknown cost scores 0 (worst), unknown latency 0.5 (neutral): unknown is never the cheapest.
    c.score = round6(weights.quality * q + weights.cost * (costS[i] ?? 0) + weights.latency * (latS[i] ?? 0.5) + weights.reliability * c.reliability);
  });
  return cands.sort((a, b) => (b.score - a.score)
    || ((known(a.cost_est_usd) ? 0 : 1) - (known(b.cost_est_usd) ? 0 : 1))     // tie: known cost before unknown
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- route ----------
// ---------- escalation ladder (D-026) ----------
// Rungs: tier (light < standard < strong), then billing (subscription < per_token < unknown), then estimated cost
// (unknown last), then id. Only floored candidates are rungs, so the ladder can never go below a floor.
const rungKey = (c) => [TIERS.indexOf(c.tier), BILLING_RANK[c.billing] ?? 2, known(c.cost_est_usd) ? c.cost_est_usd : Infinity];
const cmpKey = (a, b) => { const x = rungKey(a), y = rungKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
// Equal rungs: the better score first (e.g. the faster of two equally priced subscription models).
const cmpRung = (a, b) => cmpKey(a, b) || (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const ladderOf = (result) => [...(result?.candidates || [])].sort(cmpRung);
// Who may climb: not security work, not high/critical risk, not a quality/speed priority (those rank by score).
export function escalationEligible(task, work = classifyWork(task)) {
  const risk = normRisk(task?.risk_class);
  if (work.type === 'security') return { eligible: false, reason: 'security work keeps its floors and ranking' };
  if (!['low', 'medium'].includes(risk)) return { eligible: false, reason: `risk_class ${JSON.stringify(task?.risk_class ?? null)} keeps its floors` };
  if (['quality', 'speed'].includes(task?.priority)) return { eligible: false, reason: `priority ${task.priority} ranks by score` };
  return { eligible: true, reason: 'low/medium-risk non-security work: start on the cheapest good-enough rung' };
}
// Next rung strictly above `current` (higher tier, dearer billing or higher estimated cost; an equal rung is a sideways
// step, not an escalation) among the floored candidates of `result`, never one in `tried`. -> candidate | null
export function nextRung(result, current, { tried = [] } = {}) {
  const lad = ladderOf(result);
  const cur = lad.find((c) => c.id === current);
  if (!cur) return null;
  return lad.find((c) => c.id !== current && !tried.includes(c.id) && cmpKey(c, cur) > 0) || null;
}

export function route(task, { registry, policy = null, history = {}, weights = null, mode = 'shadow', checkAction = defaultCheckAction,
  now = Date.now, exclude = [], allowFake = false, maxPriceAgeDays = 90, realpath = null, floorGrants = [], limitsFor = null, escalation = false } = {}) {
  if (mode !== 'shadow') { const e = new Error(`router mode "${mode}" not supported: shadow only`); e.code = 'E_NOT_LIVE'; throw e; }
  if (!registry) throw new TypeError('route: registry required');
  const entries = registry.entries();
  const priceCtx = { now: now(), maxAgeDays: maxPriceAgeDays };
  const work = classifyWork(task);
  const rejected = [];
  const rationale = [];

  // Floor 0: router floors (always) then the policy checker (frozen signature checkAction(policy, task, action)).
  // Fail closed: a throwing/async/empty checker denies, and only allow === true passes.
  const own = routerFloor(task, { floorGrants });
  let act;
  if (!own.allow) act = own;
  else {
    try { act = checkAction(policy, task, { kind: 'route', work_type: work.type }); } catch (e) { act = { allow: false, needs_approval: true, reason: `checkAction failed: ${e.message}` }; }
    if (!act || typeof act !== 'object' || act.allow !== true) act = { allow: false, needs_approval: true, reason: (act && typeof act === 'object' && act.reason) || 'checkAction did not return allow:true' };
    else if (own.needs_approval) act = { ...act, needs_approval: true, reason: own.reason };
  }
  const policyRef = policy?.version != null ? `policy@${policy.version}` : (policy?.id || 'policy:default-stub');
  if (!act.allow) {
    for (const e of entries) rejected.push({ id: e.id, reason: `policy: ${act.reason}` });
    rationale.push(`Denied by policy floor: ${act.reason}. No automatic route; owner decision required.`);
    return finish(task, { choice: null, candidates: [], rejected, rationale, confidence: 1, fallback: [], work, mode, auto_allowed: false, requires_approval: true, state_hint: 'awaiting_approval', policyRef, now });
  }
  const requires_approval = !!act.needs_approval;
  if (requires_approval) rationale.push(`Policy: ${act.reason}. A choice is proposed but must be approved before it runs.`);

  const shape = !Array.isArray(exclude) ? 'malformed exclude: expected an array of ids' : shapeFloor(task, policy, realpath);
  if (shape) {
    for (const e of entries) rejected.push({ id: e.id, reason: `task: ${shape}` });
    rationale.push(`Task rejected before ranking: ${shape}.`);
    return finish(task, { choice: null, candidates: [], rejected, rationale, confidence: 1, fallback: [], work, mode, auto_allowed: false, requires_approval: true, state_hint: 'awaiting_approval', policyRef, now });
  }

  const caps = [...new Set([...(task.required_capabilities || []), ...(task.runtime_capabilities || [])])].sort();
  const minTier = MIN_TIER_BY_RISK[normRisk(task.risk_class)] || UNKNOWN_RISK_TIER;
  const ctx = { al: allowlists(task, policy), caps, effort: task?.effort ?? null, ctxTokens: task.context_tokens_estimate != null ? ctxNum(task.context_tokens_estimate) : null, minTier, exclude, allowFake, limitsFor, ...priceCtx };
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

  const estimate = { ...DEFAULT_ESTIMATE, ...Object.fromEntries(Object.entries(task.estimate || {}).filter(([, v]) => known(v))) };
  const w = { ...(weights || PRIORITY_WEIGHTS[task?.priority] || DEFAULT_WEIGHTS) };
  const cands = feasible.map((e) => {
    const m = metrics(e, history?.[e.id], estimate, work.type, priceCtx);
    return { id: e.id, runtime: e.runtime, provider: e.provider, model: e.model, tier: e.tier, billing: e.billing ?? 'unknown', context_tokens: e.context_tokens,
      availability: e.availability, quality: round6(m.quality), reliability: round6(m.reliability), latency_ms: m.latency,
      cost_est_usd: m.cost == null ? null : round6(m.cost), cost_basis: m.cost_basis, tokens_basis: m.tokens.basis, history: m.history, history_invalid: m.history_invalid, score: 0 };
  });
  rank(cands, w, work.complexity);
  // D-026: an eligible task starts on the cheapest good-enough rung. Needs two known-cost candidates: "cheapest" is
  // meaningless among unknown costs, and unknown is never the cheapest.
  const elig = escalation ? escalationEligible(task, work) : { eligible: false, reason: 'escalation ladder off' };
  let ladderStart = null;
  if (elig.eligible && cands.filter((c) => known(c.cost_est_usd)).length >= 2) {
    ladderStart = [...cands].sort(cmpRung).find((c) => known(c.cost_est_usd) && c.quality * fitOf(c, work.complexity) >= LADDER_MIN_QUALITY) || null;
    if (ladderStart && ladderStart !== cands[0]) { cands.splice(cands.indexOf(ladderStart), 1); cands.unshift(ladderStart); }
  }
  const choice = cands[0];

  // Rationale: say what drove it, and every conservative default used.
  rationale.push(`Work type "${work.type}" (complexity ${work.complexity}); ${feasible.length} of ${entries.length} candidates pass the hard floors.`);
  if (work.needs_discovery) rationale.push('Work type unknown: needs a discovery step first; confidence is capped, not high.');
  if (cands.some((c) => !c.history)) rationale.push(`No meaningful history (< ${MIN_HISTORY_ATTEMPTS} attempts) for ${cands.filter((c) => !c.history).length} candidate(s): conservative tier priors used (light ${TIER_PRIOR.light}, standard ${TIER_PRIOR.standard}, strong ${TIER_PRIOR.strong}), reliability ${PRIOR_RELIABILITY}.`);
  const badHist = cands.filter((c) => c.history_invalid).map((c) => c.id);
  if (badHist.length) rationale.push(`History for ${badHist.join(', ')} is inconsistent (counts out of range) and was ignored: priors used.`);
  const unk = cands.filter((c) => c.cost_est_usd == null);
  if (unk.length) rationale.push(`Unknown/stale cost for ${unk.map((c) => c.id).join(', ')}: ranked after known-cost candidates at equal quality, never treated as cheapest or $0.`);
  const subs = cands.filter((c) => c.billing === 'subscription').map((c) => `${c.id} (${c.cost_basis})`);
  if (subs.length) rationale.push(`Subscription billing for ${subs.join(', ')}: near-zero marginal cost from the quota share or the nominal ${SUBSCRIPTION_NOMINAL_USD_PER_MTOK} USD/Mtok (D-025), scaled by tokens.`);
  if (ladderStart) rationale.push(`Escalation ladder (D-026): starts on the cheapest good-enough rung ${ladderStart.id} (tier ${ladderStart.tier}, ${ladderStart.billing}, est $${ladderStart.cost_est_usd}); failing checks or a reviewer rejection climb to the next rung.`);
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
  if (ladderStart && second && second.score > choice.score) confidence = Math.min(confidence, 0.6);
  confidence = round2(Math.max(0.05, confidence));

  return finish(task, { choice: choice.id, candidates: cands, rejected, rationale, confidence, fallback, work, mode, auto_allowed: !requires_approval, requires_approval, state_hint: requires_approval ? 'awaiting_approval' : null, policyRef, now,
    escalation: { eligible: elig.eligible, reason: elig.reason, ladder: elig.eligible ? ladderOf({ candidates: cands }).map((c) => c.id) : [], started_on_ladder: !!ladderStart } });
}

// A decision always shows what else was possible (store requires non-empty; §9 asks for real alternatives): a route
// with fewer than two feasible candidates still names the non-runtime options (D3).
function withFloorAlternatives(alts) {
  const extra = [
    { option: 'needs_owner', pros: ['owner can widen allowlists, approve the floor or change the task'], cons: ['blocks until the owner acts'] },
    { option: 'wait for a compatible runtime', pros: ['no policy is relaxed'], cons: ['no progress until a runtime passes the floors'] },
  ];
  const out = [...alts];
  for (const e of extra) if (out.length < 2 || !alts.length) { if (!out.some((a) => a.option === e.option)) out.push(e); }
  return out;
}

function finish(task, r) {
  const { now, policyRef, ...rest } = r;
  const out = { escalation: { eligible: false, reason: 'no routable candidate', ladder: [], started_on_ladder: false }, ...rest };
  const chosen = out.choice ?? 'needs_owner';
  const evidence = [`work_type=${out.work.type}`, `rejected=${out.rejected.length}`, `candidates=${out.candidates.length}`];
  const id = createHash('sha256').update(JSON.stringify([task?.task_id ?? null, chosen, out.candidates.map((c) => [c.id, c.score]), out.rejected, out.mode])).digest('hex').slice(0, 16);
  const decision = {
    decision_id: `rt-${id}`, task_id: task?.task_id ?? null, ts: new Date(now()).toISOString(), kind: 'route',
    question: `Which runtime/model should handle task ${task?.task_id ?? '(unnamed)'}?`,
    alternatives: withFloorAlternatives(out.candidates.map((c) => ({ option: c.id, pros: [`score ${c.score}`, `quality ${c.quality}`], cons: [c.cost_est_usd == null ? 'cost unknown' : `est. $${c.cost_est_usd} per verified completion`, ...(c.history ? [] : ['no history'])] }))),
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
// Error classes are lower-cased and prefix-matched: anything that smells like permission/credentials/deploy/policy never
// falls back automatically, and a class we do not recognise is treated the same way (owner decides), not switched.
const NO_FALLBACK_PREFIXES = ['permission', 'auth', 'credential', 'secret', 'deploy', 'policy', 'forbidden', 'approval', 'unknown'];
const KNOWN_CLASSES = new Set(['rate_limit', 'timeout', 'context_overflow', 'unavailable', 'crash', 'quota_exhausted', 'quota']);
export function fallbackPlan(result, opts = {}) {
  // A fallback inherits the approval requirement of the original route: failure never relaxes policy.
  return { ...planFallback(result, opts), requires_approval: !!result?.requires_approval };
}
function planFallback(result, { error_class, failed = result?.choice, attempt = 0, retry_after_ms = null, max_backoffs = 2 } = {}) {
  const stop = (reason, state_hint = 'awaiting_approval') => ({ action: 'approval', next: null, delay_ms: null, state_hint, reason });
  if (!result || result.auto_allowed === false && result.choice == null) return stop('no authorised route to fall back from');
  const ec = typeof error_class === 'string' ? error_class.trim().toLowerCase() : '';
  if (NO_FALLBACK_PREFIXES.some((p) => ec.startsWith(p)) || !KNOWN_CLASSES.has(ec)) return stop(`${ec || 'missing'} error class: no automatic fallback, owner approval required`);
  // `failed` is caller-supplied: it must be one of the floored candidates, or it could be echoed back as `next`.
  if (failed != null && !(result.candidates || []).some((c) => c.id === failed)) return stop('failed runtime is not in the floored candidate set');
  const pool = (result.candidates || []).filter((c) => c.id !== failed);
  const cur = (result.candidates || []).find((c) => c.id === failed);
  const otherProvider = pool.filter((c) => !cur || c.provider !== cur.provider);
  const wait = (reason) => ({ action: 'wait', next: null, delay_ms: Math.min(900000, 30000 * 2 ** Math.min(attempt, 5)), state_hint: 'waiting', reason });
  switch (ec) {
    case 'quota':
    case 'quota_exhausted': return wait('provider quota exhausted: wait for reset, no spend meanwhile');
    case 'rate_limit':
    case 'timeout': {
      if (attempt < max_backoffs) return { action: 'backoff', next: failed, delay_ms: known(retry_after_ms) && retry_after_ms > 0 ? Math.min(900000, retry_after_ms) : Math.min(900000, 30000 * 2 ** attempt), state_hint: 'waiting', reason: `${error_class}: backoff ${attempt + 1}/${max_backoffs} before switching` };
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
