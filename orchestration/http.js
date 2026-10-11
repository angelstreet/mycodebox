// V2 HTTP route handlers (docs/v2/ARCHITECTURE.md §12), testable without the server. server.js only reads the body and
// writes the response; the Origin and content-type checks for non-GET requests happen before it gets here.
//
//   GET  /api/v2/tasks               list: state, outcome, goal summary, next action, updated
//   GET  /api/v2/tasks/:id           detail: goal, definition of done, checks + latest evidence per check, decisions, ...
//   POST /api/v2/tasks               create through intake.js (source 'ui', actor 'owner'); records, never executes
//   POST /api/v2/tasks/:id/cancel    {reason?}
//   POST /api/v2/tasks/:id/approve   {action_id, sha?, reason?}   owner action on the pending request
//   POST /api/v2/tasks/:id/deny      {action_id, sha?, reason?}
//
// Approve/deny are never blanket: the body must name the pending request's action_id (and the head SHA when the task has
// one), and the grant covers exactly that request's classes. Silence or a mismatch changes nothing.
import { ContractError, TERMINAL, outcomeOf } from './task-contract.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const OWNER = 'owner';
const CREATE_FIELDS = ['goal', 'title', 'repository', 'base_sha', 'project_id', 'scope', 'acceptance_checks', 'definition_of_done',
  'risk_class', 'priority', 'runtime_capabilities', 'prohibited_actions', 'runtime_allowlist', 'model_allowlist', 'budget_policy',
  'template', 'idempotency_key'];
const TEMPLATE_NAMES = ['goal', 'informational'];

const NEXT = {
  created: 'waiting for the goal loop to pick it up (the loop is an explicit opt-in and is not started by this page)',
  clarified: 'waiting for a plan', planned: 'waiting to be dispatched', ready: 'waiting to be dispatched to a developer',
  executing: 'a developer run is in progress', evaluating: 'running the acceptance checks and the independent review',
  repair: 'a repair attempt follows from the failed evidence', replan: 'a new plan follows from the failed evidence',
  integrating: 'integration is in progress', release_verifying: 'verifying the release',
  unknown_external_effect: 'reconcile the unconfirmed external effect; nothing is repeated until it is confirmed or failed',
  accepted: null, failed_unrecoverable: null, cancelled: null,
};

const reply = (status, body) => ({ status, body });
const err = (status, code, message, details) => reply(status, { ok: false, error: message, code, ...(details ? { details } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const STATUS_OF = { E_NOT_FOUND: 404, E_EXISTS: 409, E_TERMINAL: 409, E_CANCELLED: 409, E_ILLEGAL_TRANSITION: 409,
  E_STORE_FAILED: 503, E_EFFECT_UNRECONCILED: 409, E_ACCEPTANCE_UNMET: 409 };
function mapError(e) {
  if (e instanceof ContractError) {
    const status = STATUS_OF[e.code] || (/^E_(INVALID|INTAKE|NARROWING)/.test(e.code) ? 400 : 500);
    return err(status, e.code, clip(e.message, 500), e.details);
  }
  // Anything else is a bug or an I/O fault: do not echo internals to the browser.
  return err(500, 'E_INTERNAL', 'internal error');
}

// ---- read model -----------------------------------------------------------------------------------

// Loop memory is folded from the goal loop's own decision records (same rule as goal-loop.js load()).
function loopMemory(decisions) {
  const cp = { wait: null, approval: null };
  for (const d of decisions) if (d.loop?.patch) Object.assign(cp, structuredClone(d.loop.patch));
  return cp;
}

export function pendingApproval(task, events) {
  if (task.status !== 'awaiting_approval' || task.store_error) return null;
  const req = loopMemory(task.decisions).approval;
  if (!req || !Number.isInteger(req.k)) return null;
  const answered = events.some((e) => (e.kind === 'approval.granted' || e.kind === 'approval.denied') && e.payload?.k === req.k);
  if (answered) return null;
  return { action_id: `appr-${task.task_id}-${req.k}`, k: req.k, kind: req.kind ?? null, question: clip(req.question, 1000),
    classes: Array.isArray(req.classes) ? req.classes : [], sha: task.head_sha, resume_to: req.resume_to ?? null };
}

export function nextAction(task, pending) {
  if (task.store_error) return 'the task log could not be replayed: state is unknown; inspect the store before doing anything else';
  if (pending) return `owner decision needed: ${pending.question}`;
  if (task.status === 'awaiting_approval') return 'awaiting an owner decision (the request itself is not readable)';
  if (task.status === 'waiting') {
    const w = loopMemory(task.decisions).wait;
    return clip(w?.next_action || (w?.reason ? `waiting: ${w.reason}` : 'waiting for an input to change'), 500);
  }
  return NEXT[task.status] ?? null;
}

const usageValue = (v) => (v === undefined ? null : v);   // unknown stays null; never 0

function summary(t) {
  return { task_id: t.task_id, title: t.title ?? null, goal: clip(t.goal, 200), state: t.status, outcome: t.outcome,
    next_action: nextAction(t, t.status === 'awaiting_approval' ? loopMemory(t.decisions).approval : null), updated_at: t.updated_at, created_at: t.created_at, project_id: t.project_id,
    risk_class: t.risk_class, source: t.created_by?.kind ?? null, store_error: t.store_error ?? null };
}

function detail(t, events) {
  const pending = pendingApproval(t, events);
  const checks = t.acceptance_checks.map((c) => {
    const all = t.evidence.filter((e) => e.check_id === c.id);
    const onHead = all.filter((e) => t.head_sha && e.sha === t.head_sha);
    const latest = (onHead.length ? onHead : all).at(-1) || null;
    const passes = !!latest && onHead.includes(latest) && latest.exit === c.expect.exit;
    return { id: c.id, command: c.command, expect: c.expect, required: c.required, evidence_type: c.evidence_type,
      latest_evidence: latest && { sha: latest.sha, exit: latest.exit, duration_ms: latest.duration_ms, artifact: latest.artifact,
        actor: latest.actor, ts: latest.ts, on_head: onHead.includes(latest) },
      status: passes ? 'passing_on_head' : latest ? (onHead.includes(latest) ? 'failing_on_head' : 'stale_sha') : 'no_evidence' };
  });
  const totals = t.usage_totals;
  const incidents = [...new Set(events.map((e) => e.payload?.incident_id).filter((x) => typeof x === 'string'))];
  return {
    ...summary(t),
    next_action: nextAction(t, pending),
    goal: t.goal, scope: t.scope, definition_of_done: t.definition_of_done, base_sha: t.base_sha, head_sha: t.head_sha,
    branch: t.branch ?? null, worktree_id: t.worktree_id ?? null, repository: t.repository ?? null,
    priority: t.priority, budget_policy: t.budget_policy,
    acceptance_checks: checks,
    verdicts: t.verdicts.map((v) => ({ sha: v.sha, actor: v.actor, verdict: v.verdict, findings: v.findings, ts: v.ts, current: v.sha === t.head_sha })),
    decisions: t.decisions.map((d) => ({ decision_id: d.decision_id, kind: d.kind, question: d.question, chosen: d.chosen,
      rationale: d.rationale, evidence: d.evidence, expected_effect: d.expected_effect, actor: d.actor, ts: d.ts ?? null,
      alternatives: Array.isArray(d.alternatives) ? d.alternatives.map((a) => a?.option ?? a) : [] })),
    usage: { input_tokens: usageValue(totals.input_tokens), output_tokens: usageValue(totals.output_tokens), usd: usageValue(totals.usd),
      unknown: totals.unknown, records: t.usage.map((u) => ({ runtime: u.runtime, model: u.model, input_tokens: usageValue(u.input_tokens),
        output_tokens: usageValue(u.output_tokens), usd: usageValue(u.usd), unknown: u.unknown, ts: u.ts ?? null })) },
    leases: { resources: t.resources, effects: t.effects.map((e) => ({ effect_id: e.effect_id, kind: e.kind, phase: e.phase })) },
    incidents,
    history: t.history,
    pending_approval: pending,
  };
}

// ---- body validation ------------------------------------------------------------------------------

function parseBody(raw) {
  if (!isObj(raw)) return { error: err(400, 'E_INVALID', 'body must be a JSON object') };
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BODY_BYTES) return { error: err(413, 'E_TOO_LARGE', 'body too large') };
  return { body: raw };
}

function checkCreate(b) {
  for (const k of Object.keys(b)) if (!CREATE_FIELDS.includes(k)) return `unknown field ${clip(k, 40)}`;
  if (typeof b.goal !== 'string' || !b.goal.trim() || b.goal.length > 4000) return 'goal: non-empty string, max 4000 characters';
  for (const k of ['title', 'project_id']) if (b[k] !== undefined && (typeof b[k] !== 'string' || !b[k].trim() || b[k].length > 200)) return `${k}: non-empty string, max 200`;
  if (b.repository !== undefined && (typeof b.repository !== 'string' || !b.repository.startsWith('/') || b.repository.length > 1024 || b.repository.includes('\0'))) return 'repository: absolute path';
  if (b.base_sha !== undefined && !(typeof b.base_sha === 'string' && SHA_RE.test(b.base_sha))) return 'base_sha: hex commit sha';
  if (b.template !== undefined && !TEMPLATE_NAMES.includes(b.template)) return `template: one of ${TEMPLATE_NAMES.join(', ')}`;
  if (b.idempotency_key !== undefined && !(typeof b.idempotency_key === 'string' && /^[\w.:-]{1,128}$/.test(b.idempotency_key))) return 'idempotency_key: 1-128 of [A-Za-z0-9_.:-]';
  if (b.acceptance_checks !== undefined && (!Array.isArray(b.acceptance_checks) || b.acceptance_checks.length > 50)) return 'acceptance_checks: array, max 50';
  if (b.definition_of_done !== undefined && (!Array.isArray(b.definition_of_done) || b.definition_of_done.length > 50)) return 'definition_of_done: array, max 50';
  return null;
}

function checkDecisionBody(b) {
  for (const k of Object.keys(b)) if (!['action_id', 'sha', 'reason'].includes(k)) return `unknown field ${clip(k, 40)}`;
  if (typeof b.action_id !== 'string' || !b.action_id) return 'action_id is required: name the exact request you are answering';
  if (b.action_id.length > 300) return 'action_id too long';
  if (b.sha !== undefined && !(typeof b.sha === 'string' && SHA_RE.test(b.sha))) return 'sha: hex commit sha';
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 1000)) return 'reason: string, max 1000';
  return null;
}

// ---- handler --------------------------------------------------------------------------------------

// deps: { store, intake, loop? }. `loop` is optional and only used to stop a live run on cancel; this module never starts it.
export function createV2Http({ store, intake, loop = null } = {}) {
  if (!store || !intake) throw new Error('v2 http: store and intake required');
  const chains = new Map();   // per-task: owner actions are read-check-write, so they are serialized
  const serial = (id, fn) => {
    const run = (chains.get(id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return run;
  };

  async function decide(id, kind, raw) {
    const p = parseBody(raw);
    if (p.error) return p.error;
    const bad = checkDecisionBody(p.body);
    if (bad) return err(400, 'E_INVALID', bad);
    return serial(id, async () => {
      const t = await store.get(id);
      if (!t) return err(404, 'E_NOT_FOUND', 'task not found');
      const events = await store.events(id);
      const pending = pendingApproval(t, events);
      if (!pending) return err(409, 'E_NO_PENDING_APPROVAL', 'nothing awaits an owner decision on this task');
      if (p.body.action_id !== pending.action_id) return err(409, 'E_STALE_ACTION', 'action_id does not match the pending request; reload and decide again');
      if (pending.sha && p.body.sha !== pending.sha) return err(409, 'E_SHA_MISMATCH', 'sha must be the task head the request was raised on');
      const action = { kind: pending.kind, question: pending.question, classes: pending.classes };
      const base = { k: pending.k, actor: OWNER, action_id: pending.action_id, action, sha: pending.sha };
      const granted = kind === 'approve';
      // Same event ids and payload shape as goal-loop approve()/deny(): the loop reads this record, nothing else.
      await store.append(id, granted
        ? { event_id: `appr-${id}-${pending.k}`, kind: 'approval.granted', payload: { ...base, approval_ref: pending.action_id, grants: { classes: pending.classes }, reason: p.body.reason ?? null } }
        : { event_id: `deny-${id}-${pending.k}`, kind: 'approval.denied', payload: { ...base, reason: p.body.reason ?? null } });
      return reply(200, { ok: true, recorded: granted ? 'approval.granted' : 'approval.denied', action_id: pending.action_id, actor: OWNER, sha: pending.sha,
        note: 'recorded only; the task moves when the goal loop runs, which is an explicit opt-in' });
    });
  }

  // -> { status, body } or null when the path is not a V2 route (server.js falls through).
  async function handle({ method, pathname, readBody }) {
    const m = /^\/api\/v2\/tasks(?:\/([^/]+)(?:\/(cancel|approve|deny))?)?$/.exec(pathname || '');
    if (!m) return null;
    const [, id, verb] = m;
    if (id !== undefined && !ID_RE.test(id)) return err(400, 'E_INVALID', 'invalid task id');
    try {
      if (method === 'GET' && !verb) {
        if (!id) return reply(200, { ok: true, tasks: (await store.list()).map(summary).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) });
        const t = await store.get(id);
        if (!t) return err(404, 'E_NOT_FOUND', 'task not found');
        return reply(200, { ok: true, task: detail(t, await store.events(id)) });
      }
      if (method !== 'POST' || (id && !verb)) return err(405, 'E_METHOD', 'method not allowed');
      let raw;
      try { raw = await readBody(); } catch (e) { return err(e?.status === 413 ? 413 : 400, e?.status === 413 ? 'E_TOO_LARGE' : 'E_INVALID', e?.status === 413 ? 'body too large' : 'body must be JSON'); }
      if (!id) {
        const p = parseBody(raw);
        if (p.error) return p.error;
        const bad = checkCreate(p.body);
        if (bad) return err(400, 'E_INVALID', bad);
        const { template, idempotency_key, ...input } = p.body;
        // The UI is the owner at the keyboard: actor 'owner'. Created is a record, not a start.
        const r = await intake.createTask(input, { source: 'ui', actor_id: OWNER, idempotencyKey: idempotency_key, template });
        return reply(201, { ok: true, task: summary(r.task), defaults_applied: r.defaults_applied, admission_paused: r.admission_paused,
          note: 'recorded; execution needs the goal loop, which is an explicit opt-in' });
      }
      if (verb === 'cancel') {
        const p = parseBody(raw);
        if (p.error) return p.error;
        for (const k of Object.keys(p.body)) if (k !== 'reason') return err(400, 'E_INVALID', `unknown field ${clip(k, 40)}`);
        if (p.body.reason !== undefined && (typeof p.body.reason !== 'string' || p.body.reason.length > 1000)) return err(400, 'E_INVALID', 'reason: string, max 1000');
        const t = await store.get(id);
        if (!t) return err(404, 'E_NOT_FOUND', 'task not found');
        if (TERMINAL.includes(t.status)) return err(409, t.status === 'cancelled' ? 'E_CANCELLED' : 'E_TERMINAL', `task is ${t.status}`);
        const reason = p.body.reason || 'cancelled by owner';
        if (loop?.cancel) await loop.cancel(id, { actor: OWNER, reason }); else await store.transition(id, 'cancelled', { reason, actor: OWNER });
        const after = await store.get(id);
        return reply(200, { ok: true, state: after.status, outcome: outcomeOf(after.status) });
      }
      return await decide(id, verb, raw);
    } catch (e) { return mapError(e); }
  }

  return { handle, detail, summary };
}
