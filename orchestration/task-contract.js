// V2 task contract (docs/v2/ARCHITECTURE.md §1, §9): states, transitions, schema, defaults and the
// invariants every other orchestration module builds on. Pure: no I/O, time and ids are injected.
import { stripAnsi } from '../stall.js';

export const SCHEMA_VERSION = 1;

export const STATES = Object.freeze(['created', 'clarified', 'planned', 'ready', 'executing', 'evaluating', 'repair',
  'replan', 'waiting', 'awaiting_approval', 'integrating', 'release_verifying', 'accepted', 'failed_unrecoverable',
  'cancelled', 'unknown_external_effect']);
export const TERMINAL = Object.freeze(['accepted', 'failed_unrecoverable', 'cancelled']);

const T = {
  created: ['clarified', 'awaiting_approval', 'waiting'],
  clarified: ['planned', 'awaiting_approval', 'waiting'],
  planned: ['ready', 'replan', 'awaiting_approval', 'waiting'],
  ready: ['executing', 'waiting', 'awaiting_approval'],
  executing: ['evaluating', 'repair', 'replan', 'waiting', 'awaiting_approval', 'unknown_external_effect', 'failed_unrecoverable'],
  evaluating: ['accepted', 'repair', 'replan', 'waiting', 'awaiting_approval', 'integrating', 'failed_unrecoverable'],
  repair: ['executing', 'replan', 'waiting', 'awaiting_approval'],
  replan: ['planned', 'waiting', 'awaiting_approval', 'failed_unrecoverable'],
  // waiting -> integrating: D-007, a retryable integration block parks in waiting and resumes integration.
  waiting: ['ready', 'clarified', 'planned', 'repair', 'replan', 'awaiting_approval', 'integrating', 'failed_unrecoverable'],
  awaiting_approval: ['ready', 'clarified', 'planned', 'repair', 'integrating', 'waiting', 'failed_unrecoverable'],
  integrating: ['release_verifying', 'repair', 'waiting', 'awaiting_approval', 'unknown_external_effect'],
  release_verifying: ['accepted', 'repair', 'waiting', 'awaiting_approval'],
  unknown_external_effect: ['executing', 'integrating', 'repair', 'waiting', 'awaiting_approval', 'failed_unrecoverable'],
};
// `cancelled` is reachable from every non-terminal state.
export const TRANSITIONS = Object.freeze(Object.fromEntries(STATES.map((s) =>
  [s, Object.freeze(TERMINAL.includes(s) ? [] : [...T[s], 'cancelled'])])));

export const RISK_CLASSES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const PRIORITIES = Object.freeze(['cost', 'balanced', 'quality', 'speed']);
export const CREATED_BY_KINDS = Object.freeze(['ui', 'api', 'schedule', 'agent']);
// Action classes that always need owner approval; a task or policy may add classes, never remove these.
export const MANDATORY_APPROVAL = Object.freeze(['merge_protected', 'push_shared', 'deploy', 'credentials', 'destructive',
  'host_maintenance', 'money', 'customer']);
export const BUDGET_CAPS = Object.freeze(['max_usd', 'max_input_tokens', 'max_output_tokens', 'max_duration_ms']);
export const DEFAULT_NO_PROGRESS = Object.freeze({ same_signature: 3, strategy_changes_without_progress: 3 });

export class ContractError extends Error {
  constructor(code, message, details) { super(message); this.code = code; if (details) this.details = details; }
}

export const canTransition = (from, to) => !!TRANSITIONS[from]?.includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new ContractError('E_ILLEGAL_TRANSITION', `illegal transition ${from} -> ${to}`);
}

// User-facing outcome is derived from state, never stored (OWNER_DECISIONS §5).
export function outcomeOf(state) {
  if (!STATES.includes(state)) throw new ContractError('E_INVALID', `unknown state ${state}`);
  return { accepted: 'done', waiting: 'waiting', awaiting_approval: 'needs_owner', failed_unrecoverable: 'unrecoverable',
    cancelled: 'cancelled' }[state] || 'not_yet_done';
}

// ---- schema ---------------------------------------------------------------------------------------

const REQUIRED = ['task_id', 'project_id', 'goal', 'scope', 'prohibited_actions', 'definition_of_done', 'acceptance_checks',
  'risk_class', 'runtime_capabilities', 'privacy_policy', 'resources', 'dependencies', 'base_sha', 'approval_policy',
  'created_by', 'status'];
// Section 3 / optional fields; anything else is rejected so a typo never silently drops a constraint.
const OPTIONAL = ['schema_version', 'title', 'repository', 'excluded_paths', 'runtime_allowlist', 'model_allowlist',
  'priority', 'budget_policy', ...BUDGET_CAPS, 'retry_strategy', 'no_progress_policy', 'deadline', 'preferred_models',
  'review_policy', 'schedule', 'worktree_id', 'branch', 'parent_task_id', 'handoff_refs', 'context_summary',
  'allocations', 'created_at', 'updated_at', 'task_class'];
const KNOWN = new Set([...REQUIRED, ...OPTIONAL]);
const SHA_RE = /^[0-9a-f]{7,64}$/;
const TASK_CLASS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isCap = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);

export function validateTask(spec) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(spec)) return { ok: false, errors: [{ path: '', message: 'task must be an object' }] };
  for (const k of REQUIRED) if (spec[k] === undefined) err(k, 'required');
  for (const k of Object.keys(spec)) if (!KNOWN.has(k)) err(k, 'unknown field');
  const has = (k) => spec[k] !== undefined;

  for (const k of ['task_id', 'project_id', 'goal']) if (has(k) && !isStr(spec[k])) err(k, 'non-empty string');
  if (has('scope') && !isStr(spec.scope) && !isObj(spec.scope)) err('scope', 'string or object');
  if (has('privacy_policy') && !isStr(spec.privacy_policy) && !isObj(spec.privacy_policy)) err('privacy_policy', 'string or object');
  for (const k of ['prohibited_actions', 'runtime_capabilities', 'dependencies']) if (has(k) && !isStrArr(spec[k])) err(k, 'array of strings');
  if (has('resources') && !Array.isArray(spec.resources)) err('resources', 'array');
  if (has('definition_of_done') && !(isStrArr(spec.definition_of_done) && spec.definition_of_done.length)) err('definition_of_done', 'non-empty array of strings');
  if (has('acceptance_checks')) {
    const a = spec.acceptance_checks;
    if (!Array.isArray(a)) err('acceptance_checks', 'array');
    else {
      const ids = new Set();
      a.forEach((c, i) => {
        const p = `acceptance_checks[${i}]`;
        if (!isObj(c)) return err(p, 'object');
        if (!isStr(c.id)) err(`${p}.id`, 'non-empty string');
        else if (ids.has(c.id)) err(`${p}.id`, 'duplicate check id'); else ids.add(c.id);
        if (!(isStrArr(c.command) && c.command.length)) err(`${p}.command`, 'argv array of strings');
        if (!isObj(c.expect) || !Number.isInteger(c.expect.exit)) err(`${p}.expect.exit`, 'integer');
        if (!isStr(c.evidence_type)) err(`${p}.evidence_type`, 'non-empty string');
        if (typeof c.required !== 'boolean') err(`${p}.required`, 'boolean');
      });
      // Without a required check, "done" could only rest on a model's say-so.
      if (!a.some((c) => c?.required === true)) err('acceptance_checks', 'at least one required check');
    }
  }
  if (has('risk_class') && !RISK_CLASSES.includes(spec.risk_class)) err('risk_class', `one of ${RISK_CLASSES.join(', ')}`);
  if (has('base_sha') && !(typeof spec.base_sha === 'string' && SHA_RE.test(spec.base_sha))) err('base_sha', 'hex commit sha');
  if (has('approval_policy')) {
    const ap = spec.approval_policy;
    if (!isObj(ap) || !isStrArr(ap.requires)) err('approval_policy.requires', 'array of action classes');
    else for (const c of MANDATORY_APPROVAL) if (!ap.requires.includes(c)) err('approval_policy.requires', `cannot drop mandatory class ${c}`);
  }
  if (has('created_by') && !(isObj(spec.created_by) && CREATED_BY_KINDS.includes(spec.created_by.kind) && isStr(spec.created_by.id))) {
    err('created_by', `{ kind: ${CREATED_BY_KINDS.join('|')}, id }`);
  }
  if (has('status') && !STATES.includes(spec.status)) err('status', 'canonical state');
  if (has('schema_version') && spec.schema_version !== SCHEMA_VERSION) err('schema_version', `must be ${SCHEMA_VERSION}`);

  if (has('priority') && !PRIORITIES.includes(spec.priority)) err('priority', `one of ${PRIORITIES.join(', ')}`);
  if (has('budget_policy')) {
    const b = spec.budget_policy;
    if (!isObj(b) || !['track', 'cap'].includes(b.mode)) err('budget_policy.mode', "'track' or 'cap'");
    else {
      for (const k of BUDGET_CAPS) if (b[k] !== undefined && !isCap(b[k])) err(`budget_policy.${k}`, 'positive number or null');
      if (b.mode === 'cap' && !BUDGET_CAPS.some((k) => typeof b[k] === 'number')) err('budget_policy', "mode 'cap' needs a cap");
    }
  }
  for (const k of BUDGET_CAPS) {
    if (has(k) && !isCap(spec[k])) err(k, 'positive number or null');
    if (has(k) && spec[k] !== null && isObj(spec.budget_policy) && spec.budget_policy[k] != null && spec.budget_policy[k] !== spec[k]) {
      err(k, `conflicts with budget_policy.${k}`);
    }
  }
  if (has('retry_strategy') && !isStr(spec.retry_strategy)) err('retry_strategy', 'non-empty string');
  if (has('no_progress_policy')) {
    const n = spec.no_progress_policy;
    if (!isObj(n) || !['same_signature', 'strategy_changes_without_progress'].every((k) => Number.isInteger(n[k]) && n[k] >= 1)) {
      err('no_progress_policy', '{ same_signature, strategy_changes_without_progress } positive integers');
    }
  }
  for (const k of ['excluded_paths', 'runtime_allowlist', 'model_allowlist', 'preferred_models', 'handoff_refs']) {
    if (has(k) && spec[k] !== null && !isStrArr(spec[k])) err(k, 'array of strings or null');
  }
  for (const k of ['repository', 'worktree_id', 'branch', 'parent_task_id', 'title', 'context_summary']) {
    if (has(k) && spec[k] !== null && typeof spec[k] !== 'string') err(k, 'string or null');
  }
  // task_class: a short label for scoring (docs/v2/SCORING.md), never a permission.
  if (has('task_class') && spec.task_class !== null && !(typeof spec.task_class === 'string' && TASK_CLASS_RE.test(spec.task_class))) err('task_class', 'null or [a-z0-9][a-z0-9._-]{0,63}');
  for (const k of ['deadline', 'created_at', 'updated_at']) if (has(k) && spec[k] !== null && !isIso(spec[k])) err(k, 'ISO timestamp or null');
  return { ok: errors.length === 0, errors };
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

// Fills documented defaults only. Caps, deadlines and allowlists are never invented: absent caps stay absent
// (budget mode 'track'), absent allowlists stay null = "the project policy applies".
export function normalizeTask(spec, { now = () => Date.now(), randomId } = {}) {
  const t = clone(spec) || {};
  const ts = new Date(now()).toISOString();
  if (t.task_id === undefined) {
    if (!randomId) throw new ContractError('E_INVALID', 'task_id missing and no randomId injected');
    t.task_id = `task-${randomId()}`;
  }
  t.schema_version ??= SCHEMA_VERSION;
  t.status ??= 'created';
  t.priority ??= 'balanced';
  t.budget_policy ??= { mode: 'track' };
  // Section 3 top-level caps fold into budget_policy so there is one place to read a cap from.
  for (const k of BUDGET_CAPS) {
    if (t[k] === undefined || t[k] === null) { delete t[k]; continue; }
    if (isObj(t.budget_policy)) {
      if (t.budget_policy[k] != null && t.budget_policy[k] !== t[k]) throw new ContractError('E_INVALID_TASK', `${k} conflicts with budget_policy.${k}`);
      t.budget_policy = { ...t.budget_policy, mode: 'cap', [k]: t[k] };
    }
    delete t[k];
  }
  t.retry_strategy ??= 'evidence';
  t.no_progress_policy ??= { ...DEFAULT_NO_PROGRESS };
  t.runtime_allowlist ??= null;
  t.model_allowlist ??= null;
  t.excluded_paths ??= [];
  t.parent_task_id ??= null;
  t.handoff_refs ??= [];
  // Only ever strengthens: mandatory classes are always present.
  if (isObj(t.approval_policy) && Array.isArray(t.approval_policy.requires)) {
    t.approval_policy.requires = [...new Set([...MANDATORY_APPROVAL, ...t.approval_policy.requires])];
  } else if (t.approval_policy === undefined) {
    t.approval_policy = { requires: [...MANDATORY_APPROVAL] };
  }
  t.created_at ??= ts;
  t.updated_at ??= ts;
  return t;
}

// ---- subtasks may only narrow ---------------------------------------------------------------------

// Unnormalized specs may carry a cap twice; the looser one is what a child could spend.
const capsOf = (t) => Object.fromEntries(BUDGET_CAPS.map((k) => {
  const v = [t?.budget_policy?.[k], t?.[k]].filter((x) => typeof x === 'number');
  return [k, v.length ? Math.max(...v) : null];
}));
const missingFrom = (sub, sup) => (sub || []).filter((x) => !(sup || []).includes(x));

export function narrowsParent(parent, child) {
  const v = [];
  const add = (field, message) => v.push({ field, message });
  for (const k of ['runtime_allowlist', 'model_allowlist']) {
    const p = parent?.[k] ?? null, c = child?.[k] ?? null;
    if (p === null) continue;   // parent defers to project policy; any child list narrows that
    if (c === null) add(k, 'child drops the parent allowlist');
    else for (const x of missingFrom(c, p)) add(k, `child allows ${x}, parent does not`);
  }
  for (const k of ['prohibited_actions', 'excluded_paths']) {
    for (const x of missingFrom(parent?.[k], child?.[k])) add(k, `child drops ${x}`);
  }
  for (const x of missingFrom(child?.runtime_capabilities, parent?.runtime_capabilities)) add('runtime_capabilities', `child adds ${x}`);
  for (const k of BUDGET_CAPS) {
    const a = child?.budget_policy?.[k], b = child?.[k];
    if (typeof a === 'number' && typeof b === 'number' && a !== b) add(`budget.${k}`, `child has conflicting caps ${a} and ${b}`);
  }
  for (const x of missingFrom(parent?.approval_policy?.requires, child?.approval_policy?.requires)) {
    add('approval_policy.requires', `child drops ${x}`);
  }
  const pc = capsOf(parent), cc = capsOf(child);
  for (const k of BUDGET_CAPS) {
    if (pc[k] === null) continue;
    if (cc[k] === null) add(`budget.${k}`, 'child removes the parent cap');
    else if (cc[k] > pc[k]) add(`budget.${k}`, `child cap ${cc[k]} exceeds parent ${pc[k]}`);
  }
  const pr = RISK_CLASSES.indexOf(parent?.risk_class), cr = RISK_CLASSES.indexOf(child?.risk_class);
  if (pr >= 0 && cr < pr) add('risk_class', `child ${child?.risk_class} is below parent ${parent.risk_class}`);
  if (parent?.deadline && !(child?.deadline && Date.parse(child.deadline) <= Date.parse(parent.deadline))) {
    add('deadline', 'child deadline missing or later than parent');
  }
  for (const k of ['project_id', 'repository']) {
    if (parent?.[k] != null && child?.[k] !== parent[k]) add(k, 'child must keep the parent value');
  }
  // Data and review policies are inherited as is: there is no order on free-form policies to narrow by.
  for (const k of ['privacy_policy', 'review_policy']) {
    if (parent?.[k] != null && JSON.stringify(child?.[k]) !== JSON.stringify(parent[k])) add(k, `child must inherit the parent ${k}`);
  }
  return { ok: v.length === 0, violations: v };
}

// ---- failure signature (no-progress rule, OWNER_DECISIONS §4) -------------------------------------

function normalizeNoise(s) {
  return stripAnsi(String(s ?? ''))
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var\/folders|[A-Za-z]:\\[^\s]*\\Temp)[^\s'"`)]*/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\(?\b\d+(?:\.\d+)?\s*(?:ms|µs|us|ns|s|sec|secs|seconds?|m|min|minutes?)\b\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function failureSignature({ test, errorClass } = {}) {
  return `${normalizeNoise(test) || '<unknown test>'} :: ${normalizeNoise(errorClass) || '<unknown error>'}`;
}

// ---- decision journal record (§9) -----------------------------------------------------------------

export function normalizeDecision(d, { task_id, now = () => Date.now(), randomId } = {}) {
  const out = clone(d) || {};
  if (out.decision_id === undefined && randomId) out.decision_id = `dec-${randomId()}`;
  out.task_id ??= task_id;
  out.ts ??= new Date(now()).toISOString();
  out.confidence ??= null;
  out.policy_ref ??= null;
  out.rollback ??= null;
  out.evidence ??= [];
  return out;
}

export function validateDecision(d) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(d)) return { ok: false, errors: [{ path: '', message: 'decision must be an object' }] };
  for (const k of ['decision_id', 'task_id', 'kind', 'question', 'chosen', 'expected_effect', 'rationale']) if (!isStr(d[k])) err(k, 'non-empty string');
  if (!isIso(d.ts)) err('ts', 'ISO timestamp');
  if (!Array.isArray(d.alternatives) || !d.alternatives.length) err('alternatives', 'non-empty array');
  else d.alternatives.forEach((a, i) => {
    if (!isObj(a) || !isStr(a.option)) err(`alternatives[${i}].option`, 'non-empty string');
    for (const k of ['pros', 'cons']) if (a && !(isStrArr(a[k]) || typeof a[k] === 'string')) err(`alternatives[${i}].${k}`, 'string or array of strings');
  });
  if (!Array.isArray(d.evidence) || !d.evidence.length) err('evidence', 'non-empty array: a decision cites what it rests on');
  if (!isObj(d.actor) || !isStr(d.actor.role)) err('actor.role', 'non-empty string');
  else for (const k of ['runtime', 'model']) if (d.actor[k] !== null && typeof d.actor[k] !== 'string') err(`actor.${k}`, 'string or null');
  if (!(d.confidence === null || (typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1))) err('confidence', 'number in [0,1] or null');
  if (d.policy_ref !== null && typeof d.policy_ref !== 'string') err('policy_ref', 'string or null');
  if (typeof d.reversible !== 'boolean') err('reversible', 'boolean');
  if (d.rollback !== null && typeof d.rollback !== 'string') err('rollback', 'string or null');
  if (d.reversible === true && !isStr(d.rollback)) err('rollback', 'a reversible decision says how to undo it');
  return { ok: errors.length === 0, errors };
}
