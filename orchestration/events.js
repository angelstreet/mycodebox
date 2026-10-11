// V2 event envelope (docs/v2/ARCHITECTURE.md §2). Events are validated and persisted before any
// side effect; `event_id` is the at-least-once dedup key.
import { SCHEMA_VERSION, ContractError } from './task-contract.js';

export const EVENT_KINDS = Object.freeze([
  'task.created', 'task.transitioned', 'task.started', 'tool.failed', 'model.rate_limited', 'budget.threshold',
  'verification.failed', 'verification.passed', 'task.blocked', 'approval.requested', 'approval.granted',
  'approval.denied', 'action.attempted', 'action.confirmed', 'action.unknown', 'task.completed', 'task.cancelled',
  'decision.recorded', 'evidence.recorded', 'usage.recorded',
  // Additive store kinds: effect failure, head change, policy snapshot, torn-tail recovery marker.
  'action.failed', 'task.head_changed', 'policy.snapshot', 'recovery.torn_tail',
]);

const FIELDS = ['event_id', 'task_id', 'run_id', 'attempt_id', 'seq', 'schema_version', 'timestamp', 'runtime', 'provider',
  'model', 'kind', 'payload', 'causation_id'];
const NULLABLE = ['run_id', 'attempt_id', 'runtime', 'provider', 'model', 'causation_id'];

export function makeEvent(fields = {}, { now = () => Date.now(), randomId } = {}) {
  const e = {};
  for (const k of NULLABLE) e[k] = fields[k] ?? null;
  e.event_id = fields.event_id ?? (randomId ? `evt-${randomId()}` : undefined);
  e.task_id = fields.task_id;
  e.seq = fields.seq ?? null;   // assigned by the store under the task lock
  e.schema_version = fields.schema_version ?? SCHEMA_VERSION;
  e.timestamp = fields.timestamp ?? new Date(now()).toISOString();
  e.kind = fields.kind;
  e.payload = fields.payload ?? {};
  for (const k of Object.keys(fields)) if (!FIELDS.includes(k)) throw new ContractError('E_INVALID_EVENT', `unknown event field ${k}`);
  return e;
}

export function validateEvent(e, { requireSeq = false } = {}) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: [{ path: '', message: 'event must be an object' }] };
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) err(k, 'unknown field');
  for (const k of ['event_id', 'task_id']) if (typeof e[k] !== 'string' || !e[k]) err(k, 'non-empty string');
  if (!EVENT_KINDS.includes(e.kind)) err('kind', 'unknown kind');
  if (e.schema_version !== SCHEMA_VERSION) err('schema_version', `must be ${SCHEMA_VERSION}`);
  if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) err('timestamp', 'ISO timestamp');
  if (!(e.seq === null && !requireSeq) && !(Number.isInteger(e.seq) && e.seq >= 1)) err('seq', 'positive integer');
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) err('payload', 'object');
  for (const k of NULLABLE) if (e[k] !== null && typeof e[k] !== 'string') err(k, 'string or null');
  return { ok: errors.length === 0, errors };
}
