// V2 System Operations (spec §12.4, docs/v2/ARCHITECTURE.md §11). Deterministic executor: verify telemetry
// independently -> triage -> pause admission -> notify linked tasks -> lease -> deploy check -> allowlisted reversible
// actions only (fence.check() right before each) -> recheck -> record before/after -> release lease in finally ->
// resume admission only after a FRESH healthy reading AND a free maintenance lease. Everything else becomes
// incident.approval_required and is never executed. Developers/testers/integration can only *request* (requestOperation).
import * as nodeFs from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
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
  let reasons = {};
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      reasons = j && typeof j.reasons === 'object' && j.reasons ? j.reasons : { state_corrupt: { at: now() } };
    } catch (e) { if (e.code !== 'ENOENT') reasons = { state_corrupt: { at: now() } }; }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ reasons })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dfd = fs.openSync(dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  return {
    pause(reason = 'unspecified') { reasons[String(reason)] ||= { at: now() }; save(); },
    // resume(reason) lifts that reason only; resume() lifts all (owner override).
    resume(reason) { if (reason == null) reasons = {}; else delete reasons[String(reason)]; save(); },
    isPaused: () => Object.keys(reasons).length > 0,
    reasons: () => Object.keys(reasons),
  };
}

export function createSystemOps({
  incidents, leases, telemetry, actions = {}, deploys, admission, now = Date.now,
  notify = () => {}, stateRoot, tmpRoot = stateRoot ? resolve(stateRoot, 'v2-tmp') : null, plans = {},
  owner = 'system-ops', leaseTtlMs = 5 * 60_000,
  realpath = (p) => { try { return nodeFs.realpathSync(p); } catch { return resolve(p); } },
} = {}) {
  for (const [k, v] of Object.entries({ incidents, leases, telemetry, deploys, admission })) if (!v) throw new Error(`system-ops: ${k} required`);
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

  // null = executable; otherwise the reason it needs the owner.
  function checkStep(step) {
    const a = step?.action;
    if (!ALLOWED_ACTIONS.includes(a)) return `action ${sanitizeText(a, 60)} is not on the reversible allowlist`;
    const prm = step.params || {};
    if (a === 'clear_v2_tmp_artifacts_older_than') {
      if (!tmpRoot) return 'no V2 temp root configured';
      if (!Number.isInteger(prm.older_than_ms) || prm.older_than_ms <= 0) return 'older_than_ms must be a positive integer';
      const dir = prm.dir == null ? tmpRoot : String(prm.dir);
      const inside = (r) => r === '' || (!r.startsWith('..') && !isAbsolute(r));
      if (!inside(relative(resolve(tmpRoot), resolve(dir)))) return 'path is outside the V2 temp root';
      if (!inside(relative(realpath(tmpRoot), realpath(dir)))) return 'path escapes the V2 temp root (symlink)';
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

  async function runSteps(inc, steps, lease, f) {
    const done = [];
    const undoDone = async () => {
      for (const d of [...done].reverse()) {
        const impl = actions[d.step.action];
        if (typeof impl?.undo !== 'function') continue;
        try {
          await f.check();
          await impl.undo(d.step.params || {}, { checkpoint: d.checkpoint, result: d.result, incident_id: inc.incident_id });
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
      const impl = actions[step.action];
      if (typeof impl?.execute !== 'function') return { ok: false, why: `no executor for ${step.action}` };
      try { await f.check(); }                                                                   // fence immediately before each action
      catch (e) { return { ok: false, why: `lease ${e.code || 'E_FENCED'}` }; }
      let checkpoint = null;
      try { if (typeof impl.checkpoint === 'function') checkpoint = await impl.checkpoint(step.params || {}); } catch { checkpoint = null; }
      const entry = { step, checkpoint, result: null };
      try {
        entry.result = await impl.execute(step.params || {}, { incident_id: inc.incident_id, lease_token: lease.token, checkpoint });
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

  async function handle(incident_id, { steps: given = null } = {}) {
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
    admission.pause(pauseReason(inc));
    emit(inc, 'admission_paused', `${inc.type}: new admission paused; running tasks and leases untouched`);

    const steps = given || plans[inc.type] || DEFAULT_PLANS[inc.type] || [];
    if (!steps.length) return approval(inc, 'remediation', `${inc.type} has no allowlisted remediation`);
    for (const s of steps) {
      const bad = checkStep(s);
      if (bad) return approval(inc, sanitizeText(s?.action, 100) || 'unknown', bad);          // T32/T37: nothing executes
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
        const r = await runSteps(inc, steps, lease, leases.fence([lease]));
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

  return {
    ALLOWED_ACTIONS,
    // Monitors/agents report; dedup means a second report only links (T36).
    handleReport(report) {
      return serial(async () => {
        const { incident, deduped } = await incidents.report(report);
        if (deduped) return { incident_id: incident.incident_id, deduped: true, outcome: 'linked' };
        return { incident_id: incident.incident_id, deduped: false, ...(await handle(incident.incident_id)) };
      });
    },
    // Re-evaluate an open incident (owner fixed it, a task asks "can we resume?"). Stale readings never count (T38).
    recheck(incident_id) {
      return serial(async () => {
        const inc = await incidents.get(incident_id);
        if (!inc) return { resumed: false, why: 'not found' };
        if (inc.state === 'resolved') return { resumed: false, why: 'already resolved' };
        const r = await tryResume(inc, now() - telemetry.maxAgeMs);
        if (!r.resumed && r.assessment?.status === 'unknown') await incidents.markUnknown(incident_id, { reason: 'recheck: telemetry unknown', readings: r.assessment.readings });
        return r;
      });
    },
    // Developer/tester/integration never execute (T40, GL09); only the system-operations role runs an operation.
    requestOperation({ task_id, role, op = {} } = {}) {
      return serial(async () => {
        const rep = {
          type: TYPE_SET.has(op.type) ? op.type : 'health.unknown', host_id: op.host_id, service_id: op.service_id,
          symptom: op.symptom || `operation requested: ${op.action || 'unspecified'}`, reporter: { reporter: String(role), task_id },
          dedup_key: op.dedup_key, workload_impact: op.workload_impact, candidate_remediation: sanitizeText(op.action || ''),
          requested_owner_action: op.requested_owner_action,
        };
        const { incident, deduped } = await incidents.report(rep);
        if (role !== SYSTEM_ROLE) {
          await incidents.requestMitigation(incident.incident_id, {
            by: `${role}:${task_id}`, action: sanitizeText(op.action || 'unspecified', 100), reason: 'requested by a non-operations role; routed to System Operations',
          });
          return { executed: false, incident_id: incident.incident_id, state: 'mitigation_requested', deduped };
        }
        if (deduped) return { executed: false, incident_id: incident.incident_id, deduped: true, outcome: 'linked' };
        const steps = op.steps || (op.action ? [{ action: op.action, params: op.params || {} }] : null);
        const r = await handle(incident.incident_id, { steps });
        return { executed: r.outcome === 'mitigated', incident_id: incident.incident_id, deduped: false, ...r };
      });
    },
  };
}
