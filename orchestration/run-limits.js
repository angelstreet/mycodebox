// Per-run limits (OWNER_DECISIONS §12.1, D-024): how long one agent run may take, how many steps, which effort and
// context mode, and after how many stalled runs a task stops for no progress. A policy, never a constant: sources,
// most specific wins, field by field: task.run_limits > .ai/project.json run_limits > registry entry run_limits >
// engine defaults. Pure: callers pass the work type and the runtime effort lists (no import of the router/registry).
//
// Keys. A project/task map is { <selector>: { <class>: limits } }; selector = "*" | runtime ("minimax") | entry id
// ("minimax:MiniMax-M3"); class = "*" | work type ("docs") | "<work type>:<risk class>" ("coding:low"). A registry
// entry's run_limits is { <class>: limits }. A task may also give one flat limits object (= "*" / "*").
// Precedence inside one source: selector first (entry > runtime > "*"), then class (type:risk > type > "*").
import { RISK_CLASSES, WORK_TYPES } from './task-contract.js';

export const RUN_LIMIT_KEYS = Object.freeze(['timeout_ms', 'max_steps', 'effort', 'context_mode', 'stall_runs_to_no_progress']);
export const CONTEXT_MODES = Object.freeze(['standard', 'lightweight']);
// Roles whose whole input is in the prompt (no file reads needed): the only ones that may run `lightweight`.
export const TEXT_ONLY_ROLES = Object.freeze(['reviewer', 'security', 'feasibility']);
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 86_400_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isFlat = (m) => isObj(m) && Object.keys(m).length > 0 && Object.keys(m).every((k) => RUN_LIMIT_KEYS.includes(k));

export function isClassKey(k) {
  if (k === '*' || WORK_TYPES.includes(k)) return true;
  const [t, r, ...rest] = String(k).split(':');
  return !rest.length && WORK_TYPES.includes(t) && RISK_CLASSES.includes(r);
}

// One limits object. efforts: the efforts allowed here (null = not checked here; checked per entry at route time).
// -> [{ path, message }]
export function validateLimits(l, { path = '', efforts = null } = {}) {
  const errors = [];
  const err = (k, message) => errors.push({ path: `${path}.${k}`, message });
  if (!isObj(l)) return [{ path, message: 'limits must be an object' }];
  for (const k of Object.keys(l)) if (!RUN_LIMIT_KEYS.includes(k)) err(k, `unknown run limit (allowed: ${RUN_LIMIT_KEYS.join(', ')})`);
  if ('timeout_ms' in l && !intIn(l.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) err('timeout_ms', `integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`);
  if ('max_steps' in l && l.max_steps !== null && !intIn(l.max_steps, 1, 100_000)) err('max_steps', 'integer 1..100000 or null (no limit)');
  if ('effort' in l && l.effort !== null) {
    if (typeof l.effort !== 'string' || !l.effort) err('effort', 'non-empty string or null (runtime default)');
    else if (efforts && !efforts.includes(l.effort)) err('effort', `effort "${l.effort}" is not supported here (supports: ${efforts.join('|') || 'none'}); never translated`);
  }
  if ('context_mode' in l && !CONTEXT_MODES.includes(l.context_mode)) err('context_mode', CONTEXT_MODES.join('|'));
  if ('stall_runs_to_no_progress' in l && l.stall_runs_to_no_progress !== null && !intIn(l.stall_runs_to_no_progress, 1, 100)) {
    err('stall_runs_to_no_progress', 'integer 1..100 or null (the OWNER_DECISIONS §4 rule only)');
  }
  return errors;
}

// Registry entry: { <class>: limits }, efforts = the entry's own list.
export function validateEntryRunLimits(m, { efforts = [] } = {}) {
  if (!isObj(m)) return [{ path: '', message: 'run_limits must be an object { <class>: limits }' }];
  const errors = [];
  for (const [k, l] of Object.entries(m)) {
    if (!isClassKey(k)) { errors.push({ path: `.${k}`, message: 'class must be "*", a work type or "<work type>:<risk class>"' }); continue; }
    errors.push(...validateLimits(l, { path: `.${k}`, efforts }));
  }
  return errors;
}

// Project or task map. runtimeEfforts: { runtime: [efforts] } (model-registry RUNTIME_EFFORTS). A "*" selector may name
// any effort some runtime knows; an entry that does not support it is rejected at route time, never translated.
export function validateRunLimits(m, { path = 'run_limits', runtimeEfforts = {}, allowFlat = true } = {}) {
  if (!isObj(m)) return [{ path, message: 'run_limits must be an object' }];
  const all = [...new Set(Object.values(runtimeEfforts).flat())];
  if (isFlat(m)) return allowFlat ? validateLimits(m, { path, efforts: all }) : [{ path, message: 'expected { <selector>: { <class>: limits } }' }];
  const errors = [];
  for (const [sel, byClass] of Object.entries(m)) {
    const rt = sel === '*' ? null : sel.includes(':') ? sel.slice(0, sel.indexOf(':')) : sel;
    if (rt !== null && !Object.hasOwn(runtimeEfforts, rt)) { errors.push({ path: `${path}.${sel}`, message: 'selector must be "*", a runtime or a "runtime:model" entry id' }); continue; }
    if (sel.includes(':') && sel.length === rt.length + 1) { errors.push({ path: `${path}.${sel}`, message: 'entry id needs a model' }); continue; }
    if (!isObj(byClass)) { errors.push({ path: `${path}.${sel}`, message: 'expected { <class>: limits }' }); continue; }
    for (const [cls, l] of Object.entries(byClass)) {
      if (!isClassKey(cls)) { errors.push({ path: `${path}.${sel}.${cls}`, message: 'class must be "*", a work type or "<work type>:<risk class>"' }); continue; }
      errors.push(...validateLimits(l, { path: `${path}.${sel}.${cls}`, efforts: rt ? runtimeEfforts[rt] : all }));
    }
  }
  return errors;
}

export const engineLimits = (timeout_ms) => ({ timeout_ms, max_steps: null, effort: null, context_mode: 'standard', stall_runs_to_no_progress: null });

const classChain = (workType, risk) => ['*', ...(WORK_TYPES.includes(workType) ? [workType] : []), ...(WORK_TYPES.includes(workType) && RISK_CLASSES.includes(risk) ? [`${workType}:${risk}`] : [])];

// -> { limits, source: { key: 'engine'|'registry'|'project'|'task' }, error } for one entry and task. error (string) means
// this entry cannot run the task under these limits (an effort it does not support): the router rejects the candidate.
export function resolveRunLimits({ entry, workType, risk = null, task = null, project = null, engine }) {
  const limits = { ...engine };
  const source = Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, 'engine']));
  const put = (l, src) => { if (!isObj(l)) return; for (const k of RUN_LIMIT_KEYS) if (k in l) { limits[k] = l[k]; source[k] = src; } };
  const classes = classChain(workType, risk);
  for (const c of classes) put(entry?.run_limits?.[c], 'registry');
  const fromMap = (m, src) => {
    if (!isObj(m)) return;
    if (isFlat(m)) { put(m, src); return; }
    for (const sel of ['*', entry?.runtime, entry?.id]) for (const c of classes) if (sel) put(m[sel]?.[c], src);
  };
  fromMap(project, 'project');
  fromMap(task, 'task');
  let error = null;
  if (limits.effort != null && entry && !(entry.efforts || []).includes(limits.effort)) {
    error = `run_limits effort "${limits.effort}" (from ${source.effort}) unsupported by ${entry.id} (supports: ${(entry.efforts || []).join('|') || 'none'})`;
  }
  return { limits, source, error };
}

// What a run actually gets for a role and adapter: lightweight only for text-only roles on fresh runs (never developers,
// never resumes), and limits the adapter cannot apply are dropped with a note instead of failing the run.
// support: adapter.limitSupport ({ max_steps, effort, context_mode } booleans; missing = unsupported).
// -> { timeout_ms, max_steps, effort, context_mode, notes[] }
export function runOptions(limits, { role = 'developer', resume = false, support = {}, adapter = 'adapter' } = {}) {
  const notes = [];
  const out = { timeout_ms: limits.timeout_ms, max_steps: limits.max_steps ?? null, effort: limits.effort ?? null, context_mode: 'standard' };
  if (limits.context_mode === 'lightweight') {
    if (!TEXT_ONLY_ROLES.includes(role)) notes.push(`context_mode lightweight ignored: role ${role} reads and edits files (lightweight sends no tool schemas)`);
    else if (resume) notes.push('context_mode lightweight ignored: a resumed session cannot change its context mode');
    else if (!support.context_mode) notes.push(`context_mode lightweight ignored: ${adapter} has no lightweight mode`);
    else out.context_mode = 'lightweight';
  }
  if (out.max_steps != null && !support.max_steps) { notes.push(`max_steps ${out.max_steps} ignored: ${adapter} has no step limit flag`); out.max_steps = null; }
  if (out.effort != null && support.effort === false) { notes.push(`effort ${out.effort} ignored: ${adapter} takes no effort`); out.effort = null; }
  return { ...out, notes };
}
