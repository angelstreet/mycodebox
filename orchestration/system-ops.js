// V2 System Operations (spec §12.4, docs/v2/ARCHITECTURE.md §11). Deterministic executor: verify telemetry
// independently -> triage -> pause admission -> notify linked tasks -> lease -> deploy check -> allowlisted reversible
// actions only (fence.check() right before each) -> recheck -> record before/after -> release lease in finally ->
// resume admission only after a FRESH healthy reading AND a free maintenance lease. Everything else becomes
// incident.approval_required and is never executed. Developers/testers/integration can only *request* (requestOperation).
import * as nodeFs from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeText, INCIDENT_TYPES } from './incidents.js';

export const SYSTEM_ROLE = 'system-operations';
// The whole list of things this role may execute on its own. Reversible or self-contained only.
export const ALLOWED_ACTIONS = ['pause_admission', 'throttle_concurrency', 'clear_v2_tmp_artifacts_older_than', 'request_safe_restart'];
const TYPE_SET = new Set(INCIDENT_TYPES);
const SERVICE_TYPES = ['service.unhealthy', 'service.crash_loop'];
const DEFAULT_PLANS = {
  'host.cpu_pressure': [{ action: 'throttle_concurrency', params: { max: 1 } }],
  'host.memory_pressure': [{ action: 'throttle_concurrency', params: { max: 1 } }],
  'runner.starved': [{ action: 'throttle_concurrency', params: { max: 1 } }],
  'host.disk_pressure': [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 24 * 3600 * 1000 } }],
  'service.unhealthy': [{ action: 'request_safe_restart', params: {} }],
  'service.crash_loop': [{ action: 'request_safe_restart', params: {} }],
  'tmux.resource_exhaustion': [],      // killing sessions is outside this role's scope: approval
  'worktree.storage_exceeded': [],     // deleting worktrees is data deletion: approval
  'health.unknown': [],
};

// Admission gate for new tasks. Reasons are tracked individually so one incident cannot resume another's pause.
// Persisted atomically; an unreadable state file means paused (fail closed).
export function createAdmissionController({ file, fs = nodeFs, now = Date.now } = {}) {
  let reasons = new Map();                      // Map: a reason like "__proto__" must still pause
  const corrupt = () => new Map([['state_corrupt', { at: now() }]]);
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const r = j?.reasons;
      const plain = r && typeof r === 'object' && !Array.isArray(r) && Object.values(r).every((v) => v && typeof v === 'object');
      reasons = plain ? new Map(Object.entries(r)) : corrupt();      // any other shape fails closed (paused)
    } catch (e) { if (e.code !== 'ENOENT') reasons = corrupt(); }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ reasons: Object.fromEntries(reasons) })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dfd = fs.openSync(dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  return {
    pause(reason = 'unspecified') { const k = String(reason); if (!reasons.has(k)) reasons.set(k, { at: now() }); save(); },
    // resume(reason) lifts that reason only; resume() lifts all (owner override).
    resume(reason) { if (reason == null) reasons = new Map(); else reasons.delete(String(reason)); save(); },
    isPaused: () => reasons.size > 0,
    reasons: () => [...reasons.keys()],
  };
}

// realpath of the deepest EXISTING ancestor plus the not-yet-existing tail, so <root>/link/new is judged by where
// `link` really points. Any error other than ENOENT throws (caller fails closed).
export function realpathDeepest(path, rp = nodeFs.realpathSync) {
  const tail = [];
  let cur = resolve(path);
  for (;;) {
    try { return join(rp(cur), ...tail.reverse()); }
    catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
      const up = dirname(cur);
      if (up === cur) throw e;
      tail.push(basename(cur)); cur = up;
    }
  }
}

export function createSystemOps({
  incidents, leases, telemetry, actions = {}, deploys, admission, now = Date.now,
  notify = () => {}, stateRoot, tmpRoot = stateRoot ? resolve(stateRoot, 'v2-tmp') : null, plans = {},
  owner = 'system-ops', leaseTtlMs = 5 * 60_000, minCleanupAgeMs = 3600_000, realpath = realpathDeepest,
} = {}) {
  for (const [k, v] of Object.entries({ incidents, leases, telemetry, deploys, admission })) if (!v) throw new Error(`system-ops: ${k} required`);
  // Only allowlisted executors are ever reachable, whatever else the caller put in the map.
  // Executor contract for clear_v2_tmp_artifacts_older_than: it MUST re-check that its root is still inside the V2 temp
  // root at run time and MUST NOT follow symlinks (lstat/unlink only); this module only validates the request.
  // Looked up at call time (the map may be filled after construction) but only for allowlisted own keys.
  const acts = new Proxy({}, { get: (_, a) => (ALLOWED_ACTIONS.includes(a) && actions && Object.hasOwn(actions, a) ? actions[a] : undefined) });
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
  const pauseReason = (inc) => `incident:${inc.incident_id}`;
  const taskIds = (inc) => [...new Set(inc.reporters.map((r) => r.task_id).filter(Boolean))];
  const emit = (inc, kind, message) => {
    try { notify({ incident_id: inc.incident_id, kind, host_id: inc.host_id, service_id: inc.service_id, task_ids: taskIds(inc), message }); } catch {}
  };
  const isSvc = (inc) => SERVICE_TYPES.includes(inc.type) && inc.service_id;
  const resourceOf = (inc) => (isSvc(inc) ? `service:${inc.host_id}:${inc.service_id}` : `host:${inc.host_id}:maintenance`);
  const assess = (inc, since = null) => telemetry.assess(inc.host_id, { service_id: isSvc(inc) ? inc.service_id : null, since });

  // Steps are snapshotted to plain data once; every later read uses the snapshot (no getter/TOCTOU tricks).
  const snapshot = (step) => {
    const action = step?.action;
    const params = step?.params && typeof step.params === 'object' && !Array.isArray(step.params) ? { ...step.params } : {};
    return Object.freeze({ action: typeof action === 'string' ? action : null, params: Object.freeze(params) });
  };

  // null = executable; otherwise the reason it needs the owner.
  function checkStep(step) {
    const a = step.action;
    if (a == null || !ALLOWED_ACTIONS.includes(a)) return `action ${sanitizeText(a, 60)} is not on the reversible allowlist`;
    const prm = step.params;
    if (a === 'clear_v2_tmp_artifacts_older_than') {
      if (!tmpRoot) return 'no V2 temp root configured';
      if (!Number.isInteger(prm.older_than_ms) || prm.older_than_ms <= 0) return 'older_than_ms must be a positive integer';
      if (prm.older_than_ms < minCleanupAgeMs) return `older_than_ms is below the cleanup floor (${minCleanupAgeMs} ms)`;
      let dir = tmpRoot;
      if (prm.dir != null) {
        if (typeof prm.dir !== 'string' || !prm.dir || prm.dir.includes('\0') || !isAbsolute(prm.dir)) return 'dir must be a non-empty absolute path';
        dir = prm.dir;
      }
      const inside = (r) => r === '' || (!r.startsWith('..') && !isAbsolute(r));
      if (!inside(relative(resolve(tmpRoot), resolve(dir)))) return 'path is outside the V2 temp root';
      try {
        if (!inside(relative(realpath(tmpRoot), realpath(dir)))) return 'path escapes the V2 temp root (symlink)';
      } catch { return 'path could not be verified inside the V2 temp root'; }
    }
    if (a === 'throttle_concurrency' && prm.max != null && !(Number.isInteger(prm.max) && prm.max >= 0)) return 'max must be a non-negative integer';
    return null;
  }

  const approval = async (inc, action, reason) => {
    await incidents.approvalRequired(inc.incident_id, { action, reason });
    emit(inc, 'approval_required', `${action}: ${reason}`);
    return { outcome: 'approval_required', reason };
  };

  async function deployBlock(inc) {
    let s;
    try { s = await deploys.status({ host_id: inc.host_id, service_id: inc.service_id }); } catch { s = null; }
    const st = s && typeof s === 'object' ? s.state : null;
    if (st === 'none' || st === 'idle') return null;
    return st === 'active' ? 'deploy_active' : 'deploy_state_unknown';     // unknown is a block, never idle
  }

  async function runSteps(inc, steps, lease, f, ctx) {
    const done = [];
    const undoDone = async () => {
      for (const d of [...done].reverse()) {
        const impl = acts[d.step.action];
        if (typeof impl?.undo !== 'function') continue;
        try {
          await f.check();
          await impl.undo({ ...d.step.params }, { checkpoint: d.checkpoint, result: d.result, incident_id: inc.incident_id });
          await incidents.recordAction(inc.incident_id, { action: d.step.action, status: 'rolled_back' });
        } catch (e) {
          await incidents.recordAction(inc.incident_id, { action: d.step.action, status: 'rollback_failed', error: String(e?.message || e) });
          return false;
        }
      }
      return true;
    };
    for (const step of steps) {
      if (step.action === 'pause_admission') { admission.pause(pauseReason(inc)); continue; }      // already the state; idempotent
      const impl = acts[step.action];
      if (typeof impl?.execute !== 'function') return { ok: false, why: `no executor for ${step.action}` };
      try { await f.check(); }                                                                   // fence immediately before each action
      catch (e) { return { ok: false, why: `lease ${e.code || 'E_FENCED'}` }; }
      let checkpoint = null;
      try { if (typeof impl.checkpoint === 'function') checkpoint = await impl.checkpoint({ ...step.params }); } catch { checkpoint = null; }
      const entry = { step, checkpoint, result: null };
      ctx.ran++;
      try {
        entry.result = await impl.execute({ ...step.params }, { incident_id: inc.incident_id, lease_token: lease.token, checkpoint });
        done.push(entry);
        await incidents.recordAction(inc.incident_id, { action: step.action, status: 'done', checkpoint: checkpoint == null ? undefined : sanitizeText(JSON.stringify(checkpoint), 200) });
      } catch (e) {
        done.push(entry);                                      // the failed step is included: undo must cope with a half-applied action
        await incidents.recordAction(inc.incident_id, { action: step.action, status: 'failed', error: String(e?.message || e) });
        const rolled = await undoDone();
        return { ok: false, why: `action ${step.action} failed`, rolled_back: rolled };
      }
    }
    return { ok: true };
  }

  // Resume path (T38): only on a fresh healthy reading AND a maintenance resource that is actually free.
  async function tryResume(inc, since) {
    const a = await assess(inc, since);
    if (a.status !== 'healthy') return { resumed: false, why: `telemetry ${a.status}`, assessment: a };
    const probe = await leases.acquire(resourceOf(inc), { owner: `${owner}-resume-probe`, ttl_ms: 5000, scope: 'resume-probe' });
    if (!probe.ok) return { resumed: false, why: `lease ${probe.code}`, assessment: a };
    const rel = await leases.release(probe.lease);
    if (!rel.ok) return { resumed: false, why: 'lease release unconfirmed', assessment: a };
    admission.resume(pauseReason(inc));
    await incidents.resolve(inc.incident_id, { reason: 'recovered', measurements: a.readings });
    emit(inc, 'resolved', 'incident resolved; admission resumed unless another incident holds it');
    return { resumed: true, assessment: a };
  }

  async function core(incident_id, { steps: given = null } = {}, ctx) {
    const inc = await incidents.get(incident_id);
    if (!inc || inc.state === 'resolved') return { outcome: 'closed' };
    const first = await assess(inc);
    if (first.status === 'unknown') {                        // T35: cannot observe -> unknown, admission stays closed
      admission.pause(pauseReason(inc));
      await incidents.markUnknown(inc.incident_id, { reason: `telemetry unknown: ${first.unknown.join(',')}`, readings: first.readings });
      await incidents.escalate(inc.incident_id, { reason: 'telemetry unknown or stale; owner attention' });
      emit(inc, 'unknown', 'health is unknown, not healthy; new admission paused');
      return { outcome: 'unknown', assessment: first };
    }
    await incidents.acknowledge(inc.incident_id, { by: owner });
    if (first.status === 'healthy') {
      await incidents.resolve(inc.incident_id, { reason: 'not_reproduced', measurements: first.readings });
      return { outcome: 'not_reproduced', assessment: first };
    }
    // The plan follows what was OBSERVED: a reported metric type must be among the observed pressures (service.* needs the
    // service reading); types telemetry cannot confirm (tmux, worktree, runner) just need some observed pressure.
    const METRIC = ['host.cpu_pressure', 'host.memory_pressure', 'host.disk_pressure'];
    const confirmed = METRIC.includes(inc.type) ? first.pressures.includes(inc.type)
      : SERVICE_TYPES.includes(inc.type) ? first.pressures.includes('service.unhealthy') : true;
    if (!confirmed) {
      await incidents.resolve(inc.incident_id, { reason: 'not_reproduced', measurements: first.readings });
      return { outcome: 'not_reproduced', assessment: first };
    }
    admission.pause(pauseReason(inc));
    emit(inc, 'admission_paused', `${inc.type}: new admission paused; running tasks and leases untouched`);

    if (given != null && !Array.isArray(given)) return approval(inc, 'remediation', 'steps must be an array');
    const steps = (given || plans[inc.type] || DEFAULT_PLANS[inc.type] || []).map(snapshot);
    if (!steps.length) return approval(inc, 'remediation', `${inc.type} has no allowlisted remediation`);
    for (const s of steps) {
      const bad = checkStep(s);
      if (bad) return approval(inc, sanitizeText(s.action, 100) || 'unknown', bad);          // T32/T37: nothing executes
    }

    const got = await leases.acquire(resourceOf(inc), { owner, task_id: inc.incident_id, ttl_ms: leaseTtlMs, scope: 'system-ops' });
    if (!got.ok) {
      await incidents.escalate(inc.incident_id, { reason: `maintenance lease ${got.code}; no action taken` });
      emit(inc, 'escalated', `lease ${got.code}`);
      return { outcome: 'blocked', code: got.code };
    }
    const lease = got.lease;
    let out;
    let released = false;
    try {
      const block = await deployBlock(inc);                  // T34: unknown/active deploy = no mutation, ask the owner
      if (block) {
        out = await approval(inc, steps[0].action, `${block}: not acting while a deployment may be running; owner override needed`);
      } else if (steps.some((s) => s.action === 'request_safe_restart')) {
        // only requests: the restart itself is run by the owner through scripts/safe-restart.sh
        out = await approval(inc, 'request_safe_restart', 'service restart requires owner approval');
      } else {
        const r = await runSteps(inc, steps, lease, leases.fence([lease]), ctx);
        if (!r.ok) {
          await incidents.reconciling(incident_id, { reason: r.why, rolled_back: r.rolled_back ?? false });
          emit(inc, 'reconciling', r.why);
          out = { outcome: 'reconciling', why: r.why, rolled_back: r.rolled_back ?? false };
        } else {
          const after = await assess(inc, now());
          await incidents.recordAction(inc.incident_id, { action: 'recheck', status: after.status, before: first.readings, after: after.readings });
          out = { outcome: after.status === 'healthy' ? 'mitigated' : 'insufficient', assessment: after };
        }
      }
    } catch (e) {
      await incidents.reconciling(incident_id, { reason: sanitizeText(e?.message || e) }).catch(() => {});
      out = { outcome: 'reconciling', why: String(e?.message || e) };
    } finally {
      const rel = await leases.release(lease);
      released = rel.ok;
      if (!rel.ok) emit(inc, 'lease_release_failed', `maintenance lease release ${rel.code}`);
    }
    if (out.outcome === 'mitigated') {
      if (!released) {
        await incidents.escalate(inc.incident_id, { reason: 'lease release unconfirmed; admission stays paused' });
        return { ...out, outcome: 'blocked' };
      }
      const rr = await tryResume(inc, now());
      return { ...out, resumed: rr.resumed, resume_blocked: rr.resumed ? undefined : rr.why };
    }
    if (out.outcome === 'insufficient') {
      return { ...(await approval(inc, steps.at(-1).action, 'mitigation insufficient; further action requires owner approval')), assessment: out.assessment };
    }
    return out;
  }

  async function handle(incident_id, o) {
    const ctx = { ran: 0 };
    const r = await core(incident_id, o, ctx);
    return { ...r, actions_run: ctx.ran };       // separate from the outcome: an action can run and still be insufficient
  }

  async function execute(op) {
    const rep = reportOf(op);
    const { incident, deduped, replay } = await incidents.report(rep);
    // Retrying the same logical operation (same correlation key) or a keyless duplicate only links; a new explicit
    // operation on an open incident is a fresh instruction and still goes through lease, deploy check and allowlist.
    if (deduped && (replay || !op.dedup_key)) return { executed: false, actions_run: 0, incident_id: incident.incident_id, deduped: true, outcome: 'linked' };
    const steps = op.steps !== undefined ? op.steps : (op.action ? [{ action: op.action, params: op.params || {} }] : null);
    const r = await handle(incident.incident_id, { steps });
    return { executed: r.actions_run > 0, mitigated: r.outcome === 'mitigated', incident_id: incident.incident_id, deduped, ...r };
  }

  const reportOf = (op, role, task_id) => ({
    type: TYPE_SET.has(op.type) ? op.type : 'health.unknown', host_id: op.host_id, service_id: op.service_id,
    symptom: op.symptom || `operation requested: ${op.action || 'unspecified'}`, reporter: { reporter: String(role ?? SYSTEM_ROLE), task_id },
    dedup_key: op.dedup_key, workload_impact: op.workload_impact, candidate_remediation: sanitizeText(op.action || ''),
    requested_owner_action: op.requested_owner_action,
  });

  // Request-only handle for developers/testers/integration/manager: no code path from here reaches an executor, so a
  // role string can never authorize anything. The wiring must hand out `requester` and keep the controller private.
  const requester = Object.freeze({
    request: ({ task_id, role, op = {} } = {}) => serial(async () => {
      const { incident, deduped } = await incidents.report(reportOf(op, role, task_id));
      await incidents.requestMitigation(incident.incident_id, {
        by: `${role}:${task_id}`, action: sanitizeText(op.action || 'unspecified', 100), reason: 'requested; routed to System Operations',
      });
      return { executed: false, incident_id: incident.incident_id, state: 'mitigation_requested', deduped };
    }),
  });

  return {
    ALLOWED_ACTIONS, requester,
    // Monitors/agents report; dedup means a second report only links (T36).
    handleReport(report) {
      return serial(async () => {
        const { incident, deduped } = await incidents.report(report);
        if (deduped) return { incident_id: incident.incident_id, deduped: true, outcome: 'linked' };
        return { incident_id: incident.incident_id, deduped: false, ...(await handle(incident.incident_id)) };
      });
    },
    // Re-evaluate an open incident (owner fixed it, a task asks "can we resume?"). Stale readings never count (T38).
    // A reconciling incident (failed/rolled-back action) is never auto-resolved: ownerAcknowledge() first.
    recheck(incident_id) {
      return serial(async () => {
        const inc = await incidents.get(incident_id);
        if (!inc) return { resumed: false, why: 'not found' };
        if (inc.state === 'resolved') return { resumed: false, why: 'already resolved' };
        if (inc.state === 'reconciling') return { resumed: false, why: 'reconciling: owner acknowledgement required' };
        const r = await tryResume(inc, now() - telemetry.maxAgeMs);
        if (!r.resumed && r.assessment?.status === 'unknown') await incidents.markUnknown(incident_id, { reason: 'recheck: telemetry unknown', readings: r.assessment.readings });
        return r;
      });
    },
    ownerAcknowledge(incident_id, { by } = {}) {
      return serial(() => incidents.acknowledge(incident_id, { by: by || 'owner', owner: true }));
    },
    // Explicit execution: holding THIS controller is the capability (not a role string in the payload).
    execute: (op) => serial(() => execute(op || {})),
    // Kept for callers that own the controller: only the exact system-operations role executes; anything else is a request.
    requestOperation({ task_id, role, op = {} } = {}) {
      if (role !== SYSTEM_ROLE) return requester.request({ task_id, role, op });
      return serial(() => execute(op));
    },
  };
}
