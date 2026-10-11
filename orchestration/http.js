// V2 HTTP route handlers (docs/v2/ARCHITECTURE.md §12), testable without the server. server.js only reads the body and
// writes the response; the Origin and content-type checks for non-GET requests happen before it gets here.
//
//   GET  /api/v2/tasks               list: state, outcome, goal summary, next action, updated
//   GET  /api/v2/tasks/:id           detail: goal, definition of done, checks + latest evidence per check, decisions, ...
//   POST /api/v2/tasks               create through intake.js (source 'ui', actor 'owner'); records, never executes
//   POST /api/v2/tasks/:id/cancel    {reason?}
//   POST /api/v2/tasks/:id/approve   {action_id, sha?, reason?}   owner action on the pending request
//   POST /api/v2/tasks/:id/deny      {action_id, sha?, reason?}
//   GET  /api/v2/scorecard           read-only scorecard over the store (orchestration/scorecard.js); per-run rows omitted
//
// Approve/deny are never blanket: the body must name the pending request's action_id (and the head SHA when the task has
// one), and the grant covers exactly that request's classes. Silence or a mismatch changes nothing.
import { ContractError, TERMINAL, outcomeOf } from './task-contract.js';
import { buildScorecard } from './scorecard.js';

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

function answeredEvent(req, events) {
  return events.find((e) => (e.kind === 'approval.granted' || e.kind === 'approval.denied') && e.payload?.k === req.k);
}

export function pendingApproval(task, events) {
  if (task.status !== 'awaiting_approval' || task.store_error) return null;
  const req = loopMemory(task.decisions).approval;
  if (!req || !Number.isInteger(req.k) || answeredEvent(req, events)) return null;
  // Prefer the SHA the request was raised on; fall back to the task head.
  const sha = typeof req.sha === 'string' && SHA_RE.test(req.sha) ? req.sha : task.head_sha;
  return { action_id: `appr-${task.task_id}-${req.k}`, k: req.k, kind: req.kind ?? null, question: clip(req.question, 1000),
    classes: Array.isArray(req.classes) ? req.classes : [], keys: Array.isArray(req.keys) ? req.keys : [], sha, resume_to: req.resume_to ?? null };
}

// The owner already answered the current request: the loop has not applied it yet.
export function answeredApproval(task, events) {
  if (task.status !== 'awaiting_approval' || task.store_error) return null;
  const req = loopMemory(task.decisions).approval;
  const e = req && Number.isInteger(req.k) ? answeredEvent(req, events) : null;
  return e ? e.kind === 'approval.granted' ? 'granted' : 'denied' : null;
}

const ANSWER_NEXT = 'answer recorded; applied when the goal loop runs';
export function nextAction(task, pending, answered = null) {
  if (task.store_error) return 'the task log could not be replayed: state is unknown; inspect the store before doing anything else';
  if (answered) return ANSWER_NEXT;
  if (pending) return `owner decision needed: ${pending.question}`;
  if (task.status === 'awaiting_approval') return 'awaiting an owner decision (the request itself is not readable)';
  if (task.status === 'waiting') {
    const w = loopMemory(task.decisions).wait;
    return clip(w?.next_action || (w?.reason ? `waiting: ${w.reason}` : 'waiting for an input to change'), 500);
  }
  return NEXT[task.status] ?? null;
}

// Delivery: an accepted task is verified in its worktree; it is integrated only after the integrating states ran.
export function deliveryOf(t) {
  const requested = t.review_policy?.deliver === true || (t.resources || []).some((r) => typeof r === 'string' && /^repo:.+:integration$/.test(r));
  // Integrated only when acceptance came through release verification; an integration that went back to repair is not.
  const integrated = t.history.some((h) => h.from === 'release_verifying' && h.to === 'accepted');
  const label = integrated ? 'integrated' : t.status === 'accepted' ? 'verified in worktree, not integrated' : requested ? 'integration requested, not yet integrated' : 'no integration requested';
  return { requested, integrated, label };
}

const usageValue = (v) => (v === undefined ? null : v);   // unknown stays null; never 0

// store_error can carry a raw filesystem message (absolute paths): clients get a coarse text, the server log the detail.
const COARSE_ERROR = 'task log unreadable; see server log';

function summary(t, { pending = null, answered = null } = {}) {
  return { task_id: t.task_id, title: t.title ?? null, goal: clip(t.goal, 200), state: t.status, outcome: t.outcome,
    next_action: nextAction(t, pending, answered), updated_at: t.updated_at, created_at: t.created_at, project_id: t.project_id,
    risk_class: t.risk_class, source: t.created_by?.kind ?? null, parent_task_id: t.parent_task_id ?? null,
    store_error: t.store_error ? COARSE_ERROR : null, delivery: deliveryOf(t) };
}

// Runs from the log: task.started (who, effort), the run's effect (start/end), usage by run_id, tool.failed (error class).
function runsOf(t, events) {
  const runs = new Map();
  const at = (e) => e.timestamp ?? null;
  for (const e of events) {
    const p = e.payload || {};
    if (e.kind === 'task.started' && p.run_id) runs.set(p.run_id, { run_id: p.run_id, role: p.role ?? 'developer', runtime: p.runtime ?? null, model: p.model ?? null,
      effort: p.effort ?? null, started_at: at(e), ended_at: null, outcome: 'running', usage: null });
  }
  const verdictRuns = new Set(events.filter((e) => /^verdict-/.test(e.event_id || '')).map((e) => e.event_id.slice('verdict-'.length)));
  for (const u of t.usage) {
    if (!u.run_id) continue;
    const r = runs.get(u.run_id) || runs.set(u.run_id, { run_id: u.run_id, role: verdictRuns.has(u.run_id) ? 'reviewer' : 'unknown', runtime: u.runtime ?? null,
      model: u.model ?? null, effort: null, started_at: null, ended_at: u.ts ?? null, outcome: 'finished', usage: null }).get(u.run_id);
    r.usage = { input_tokens: usageValue(u.input_tokens), output_tokens: usageValue(u.output_tokens), usd: usageValue(u.usd), incomplete: u.incomplete === true };
  }
  for (const eff of t.effects) {
    const id = /^devrun-(.+)$/.exec(eff.effect_id)?.[1];
    const r = id && runs.get(id);
    if (!r) continue;
    const last = eff.history?.at(-1);
    r.outcome = eff.phase === 'confirmed' ? 'finished' : eff.phase === 'attempted' ? 'running' : eff.phase === 'possibly_applied' ? 'unknown' : 'failed';
    if (eff.phase !== 'attempted') r.ended_at = last?.ts ?? null;
  }
  for (const e of events) if (e.kind === 'tool.failed' && runs.has(e.payload?.run_id)) runs.get(e.payload.run_id).outcome = `failed: ${clip(e.payload.error?.class ?? 'error', 60)}`;
  return [...runs.values()];
}

function rolesOf(t, events) {
  const devs = new Set();
  for (const e of events) if (e.kind === 'task.head_changed') { const id = typeof e.payload.actor === 'string' ? e.payload.actor : e.payload.actor?.id; if (id) devs.add(id); }
  const revs = new Set(t.verdicts.map((v) => (typeof v.actor === 'string' ? v.actor : v.actor?.id)).filter(Boolean));
  return { developers: [...devs], reviewers: [...revs] };
}

function allowedActions(t) {
  const pol = t.policy_snapshot?.policy;
  return { source: pol ? 'policy snapshot of the latest run' : 'task contract only (no policy snapshot yet)',
    approval_required: t.approval_policy?.requires ?? [], prohibited_actions: [...new Set([...(t.prohibited_actions || []), ...(pol?.prohibited_actions || [])])],
    allowed_commands: Array.isArray(pol?.allowlists?.commands) ? pol.allowlists.commands.map((c) => (Array.isArray(c) ? c.join(' ') : String(c))) : null,
    allowed_paths: pol?.allowlists?.paths ?? null,
    protected_branches: pol?.protected_branches ?? null };
}

function detail(t, events, children = []) {
  const { pending, answered } = { pending: pendingApproval(t, events), answered: answeredApproval(t, events) };
  // Current means this SHA in this head epoch: a reverted head (A, B, A) starts evidence over, as in the store.
  const current = (e) => !!t.head_sha && e.sha === t.head_sha && e.epoch === t.head_epoch;
  const checks = t.acceptance_checks.map((c) => {
    const all = t.evidence.filter((e) => e.check_id === c.id);
    const onHead = all.filter(current);
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
    ...summary(t, { pending, answered }),
    goal: t.goal, scope: t.scope, definition_of_done: t.definition_of_done, base_sha: t.base_sha, head_sha: t.head_sha,
    branch: t.branch ?? null, worktree_id: t.worktree_id ?? null, repository: t.repository ?? null,
    priority: t.priority, budget_policy: t.budget_policy,
    acceptance_checks: checks,
    verdicts: t.verdicts.map((v) => ({ sha: v.sha, actor: v.actor, verdict: v.verdict, findings: v.findings, ts: v.ts, current: current(v) })),
    decisions: t.decisions.map((d) => ({ decision_id: d.decision_id, kind: d.kind, question: d.question, chosen: d.chosen,
      rationale: d.rationale, evidence: d.evidence, expected_effect: d.expected_effect, actor: d.actor, ts: d.ts ?? null,
      alternatives: Array.isArray(d.alternatives) ? d.alternatives.map((a) => a?.option ?? a) : [] })),
    usage: { input_tokens: usageValue(totals.input_tokens), output_tokens: usageValue(totals.output_tokens), usd: usageValue(totals.usd),
      unknown: totals.unknown, incomplete: totals.incomplete === true, records: t.usage.map((u) => ({ runtime: u.runtime, model: u.model, input_tokens: usageValue(u.input_tokens),
        output_tokens: usageValue(u.output_tokens), usd: usageValue(u.usd), unknown: u.unknown, incomplete: u.incomplete === true, ts: u.ts ?? null })) },
    runs: runsOf(t, events), roles: rolesOf(t, events), allowed_actions: allowedActions(t),
    parent_task_id: t.parent_task_id ?? null, children: children.map((c) => ({ task_id: c.task_id, state: c.status, outcome: c.outcome, goal: clip(c.goal, 120) })),
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
export function createV2Http({ store, intake, loop = null, log = (m) => console.error(m) } = {}) {
  if (!store || !intake) throw new Error('v2 http: store and intake required');
  const logged = new Set();
  const noteStoreError = (t) => { if (t.store_error && !logged.has(`${t.task_id}:${t.store_error}`)) { logged.add(`${t.task_id}:${t.store_error}`); log(`[v2] task ${t.task_id}: ${t.store_error}`); } };
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
      // Same event ids and payload shape as goal-loop approve()/deny() (grants carry the request's action keys and kind,
      // so a keyed request -- a gate, an integration push/merge of one SHA -- is answered exactly): the loop reads this record.
      await store.append(id, granted
        ? { event_id: `appr-${id}-${pending.k}`, kind: 'approval.granted', payload: { ...base, approval_ref: pending.action_id, grants: { classes: pending.classes, keys: pending.keys, request_kind: pending.kind }, reason: p.body.reason ?? null } }
        : { event_id: `deny-${id}-${pending.k}`, kind: 'approval.denied', payload: { ...base, reason: p.body.reason ?? null } });
      return reply(200, { ok: true, recorded: granted ? 'approval.granted' : 'approval.denied', action_id: pending.action_id, actor: OWNER, sha: pending.sha,
        note: 'recorded only; the task moves when the goal loop runs, which is an explicit opt-in' });
    });
  }

  // -> { status, body } or null when the path is not a V2 route (server.js falls through).
  // Read-only: list + events, the same reads as GET /api/v2/tasks. Never writes, recovers or proposes anything.
  async function scorecard() {
    const logs = [], unreadable = [];
    for (const t of await store.list()) {
      if (t.store_error) { noteStoreError(t); unreadable.push({ task_id: t.task_id }); continue; }
      logs.push({ task_id: t.task_id, events: await store.events(t.task_id) });
    }
    const { runs, ...sc } = buildScorecard(logs, { unreadable });
    return { ...sc, runs_count: runs.length };
  }

  async function handle({ method, pathname, readBody }) {
    if (pathname === '/api/v2/scorecard') {
      if (method !== 'GET') return err(405, 'E_METHOD', 'method not allowed: the scorecard is read-only');
      try { return reply(200, { ok: true, scorecard: await scorecard() }); } catch (e) {
        if (e?.code === 'E_STORE_FAILED') { log(`[v2] ${e.message}`); return err(503, 'E_STORE_FAILED', COARSE_ERROR); }
        return mapError(e);
      }
    }
    const m = /^\/api\/v2\/tasks(?:\/([^/]+)(?:\/(cancel|approve|deny))?)?$/.exec(pathname || '');
    if (!m) return null;
    const [, id, verb] = m;
    if (id !== undefined && !ID_RE.test(id)) return err(400, 'E_INVALID', 'invalid task id');
    try {
      if (method === 'GET' && !verb) {
        if (!id) {
          const all = await store.list();
          const approvals = [];
          const tasks = [];
          for (const t of all) {
            let st = {};
            if (t.status === 'awaiting_approval' && !t.store_error) {
              const events = await store.events(t.task_id);
              st = { pending: pendingApproval(t, events), answered: answeredApproval(t, events) };
              if (st.pending) approvals.push({ task_id: t.task_id, goal: clip(t.goal, 200), ...st.pending });
            }
            noteStoreError(t);
            tasks.push(summary(t, st));
          }
          const newest = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));
          return reply(200, { ok: true, tasks: tasks.sort(newest), approvals });
        }
        const t = await store.get(id);
        if (!t) return err(404, 'E_NOT_FOUND', 'task not found');
        noteStoreError(t);
        // an unreadable log has no trustworthy events: show what the snapshot says (outcome unknown) and nothing derived from the log
        return reply(200, { ok: true, task: detail(t, t.store_error ? [] : await store.events(id), await store.list({ parent_task_id: id })) });
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
    } catch (e) {
      if (e?.code === 'E_STORE_FAILED') { log(`[v2] ${e.message}`); return err(503, 'E_STORE_FAILED', COARSE_ERROR); }
      return mapError(e);
    }
  }

  return { handle, detail, summary };
}
