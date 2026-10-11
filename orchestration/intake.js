// One task intake for every source (GL01): UI, API, schedule and agent-delegated tasks all pass through
// buildTaskSpec -> store.createTask and therefore get the same goal contract and the same goal loop.
//
// Templates. `goal` (default) is the full goal contract. `informational` is the only documented opt-out: a
// non-executable task (a question, a report) that the goal loop never dispatches to a developer. It still needs a
// truthful outcome: it keeps its acceptance checks and stays not_yet_done until evidence and an independent verdict
// exist; nothing marks it done by default.
import { execFileSync } from 'node:child_process';
import { CREATED_BY_KINDS, ContractError } from './task-contract.js';
import { loadPolicy as realLoadPolicy } from './policy.js';

const fail = (code, message, details) => { throw new ContractError(code, message, details); };

// Documented defaults. None of them is a cap, deadline or permission: those are never invented.
export const TEMPLATES = Object.freeze({
  goal: Object.freeze({
    risk_class: 'medium',                 // unknown risk is not "low": medium keeps reviewer + approval classes
    runtime_capabilities: ['code'],
    privacy_policy: 'project',
    prohibited_actions: [],
    resources: [],
    dependencies: [],
    scope: 'the repository, within the project policy path allowlist',
    review_policy: { mode: 'goal_loop', independent_review: true },
  }),
  informational: Object.freeze({
    risk_class: 'low',
    runtime_capabilities: ['text'],
    privacy_policy: 'project',
    prohibited_actions: ['edit'],
    resources: [],
    dependencies: [],
    scope: 'read-only answer; no repository changes',
    review_policy: { mode: 'informational', goal_loop: false },
  }),
});

export const isInformational = (task) => task?.review_policy?.mode === 'informational';

const defaultResolveSha = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8',
  env: { PATH: process.env.PATH, LANG: 'C', GIT_TERMINAL_PROMPT: '0' } }).trim();

// input: the caller's fields (goal required). source: 'ui'|'api'|'schedule'|'agent'. -> { spec, defaults_applied[] }
export function buildTaskSpec(input, { source, actor_id, template = 'goal', policy = null, resolveSha = defaultResolveSha } = {}) {
  if (!CREATED_BY_KINDS.includes(source)) fail('E_INTAKE', `source must be one of ${CREATED_BY_KINDS.join(', ')}`);
  if (typeof actor_id !== 'string' || !actor_id) fail('E_INTAKE', 'actor_id required: every task records who created it');
  const tpl = TEMPLATES[template] || fail('E_INTAKE', `unknown template ${template}`);
  if (!input || typeof input !== 'object' || typeof input.goal !== 'string' || !input.goal.trim()) fail('E_INTAKE', 'goal (an outcome) is required');
  if (input.created_by !== undefined || input.status !== undefined) fail('E_INTAKE', 'created_by and status are set by intake, not the caller');
  const spec = structuredClone(input);
  const applied = [];
  for (const [k, v] of Object.entries(tpl)) {
    if (spec[k] === undefined) { spec[k] = structuredClone(v); applied.push(k); }
  }
  // Checks default to the project's own test command: measurable and owner-configured, never invented.
  if (spec.acceptance_checks === undefined) {
    if (!policy?.test_command) fail('E_INTAKE_NEEDS_CHECKS', 'acceptance_checks missing and the project policy has no test_command to default to');
    spec.acceptance_checks = [{ id: 'project-tests', command: [...policy.test_command], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }];
    applied.push('acceptance_checks');
  }
  if (spec.definition_of_done === undefined) {
    spec.definition_of_done = [...spec.acceptance_checks.filter((c) => c.required).map((c) => `${c.id} passes on the candidate SHA`),
      'an independent reviewer approves the change against the goal'];
    applied.push('definition_of_done');
  }
  if (spec.base_sha === undefined) {
    if (!spec.repository) fail('E_INTAKE', 'base_sha or repository required');
    try { spec.base_sha = resolveSha(spec.repository); } catch (e) { fail('E_INTAKE_EVIDENCE', `cannot read the repository HEAD: ${e.message}`); }
    applied.push('base_sha');
  }
  if (spec.project_id === undefined && policy?.project_id) { spec.project_id = policy.project_id; applied.push('project_id'); }
  spec.created_by = { kind: source, id: actor_id };
  spec.status = 'created';
  return { spec, defaults_applied: applied };
}

export function createIntake({ store, loadPolicy = (repo) => realLoadPolicy(repo), resolveSha = defaultResolveSha, admission = null } = {}) {
  if (!store) throw new Error('intake: store required');
  return {
    // The single creation path. Same input + same idempotencyKey -> same task, no second event.
    async createTask(input, { source, actor_id, idempotencyKey, template = 'goal' } = {}) {
      // Admission pause (System Operations) stops new work from starting, not from being recorded: tasks are still
      // created and the goal loop waits before dispatching.
      const p = input?.repository ? loadPolicy(input.repository) : { ok: false };
      const { spec, defaults_applied } = buildTaskSpec(input, { source, actor_id, template, policy: p.ok ? p.policy : null, resolveSha });
      const task = await store.createTask(spec, { idempotencyKey });
      return { task, defaults_applied, admission_paused: admission?.isPaused?.() ?? null };
    },
  };
}
