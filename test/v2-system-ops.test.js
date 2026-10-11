// V2 System Operations (spec §12.4; T32-T38, T40, GL09, GL10): incident intake/dedup/sanitization, telemetry freshness,
// admission pause, allowlisted reversible actions under a real (file) lease authority, approval for everything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';
import { createIncidentStore, sanitizeText, INCIDENT_TYPES } from '../orchestration/incidents.js';
import { createTelemetry, readingsFromHealth } from '../orchestration/telemetry.js';
import { createSystemOps, createAdmissionController, ALLOWED_ACTIONS } from '../orchestration/system-ops.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-sysops-'));
const H = 'host-a';

// Harness: fake telemetry (mutable `m`), fake deploy registry, recording actions, real lease authority on a temp dir.
async function harness({ backend, deploy = { state: 'none' }, actions: actOverrides = {}, plans, ttl } = {}) {
  const root = await tmp();
  const c = () => c.t; c.t = 1_800_000_000_000;
  const m = { cpu_pct: 20, mem_pct: 30, disk_pct: 40, ts: null, throw: false, svc: true, svcTs: null };
  const telemetry = createTelemetry({
    now: c, maxAgeMs: 60_000,
    probe: async () => {
      if (m.throw) throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
      const ts = m.ts ?? c();
      return ['cpu_pct', 'mem_pct', 'disk_pct'].map((name) => ({ name, value: m[name], unit: '%', ts, source: 'fake-probe' }));
    },
    serviceProbe: async () => ({ healthy: m.svc, ts: m.svcTs ?? c(), source: 'fake-svc' }),
  });
  const incidents = createIncidentStore({ dir: join(root, 'inc'), now: c });
  const leases = createLeaseAuthority({ backend: backend || fileBackend({ dir: join(root, 'leases'), now: c }), now: c });
  const calls = [];
  const rec = (name, extra = {}) => ({
    execute: async (params, ctx) => { calls.push({ name, params, paused: admission.isPaused(), ctx }); return extra.execute?.(params, ctx); },
    ...(extra.undo ? { undo: async (params, ctx) => { calls.push({ name: `${name}:undo`, params }); return extra.undo(params, ctx); } } : {}),
  });
  const admission = createAdmissionController({ file: join(root, 'admission.json'), now: c });
  const deployState = { v: deploy };
  const deploys = { status: async () => { if (deployState.v instanceof Error) throw deployState.v; return deployState.v; } };
  const notes = [];
  const actions = {
    throttle_concurrency: rec('throttle_concurrency', { execute: () => { m.cpu_pct = 30; m.mem_pct = 30; } }),
    clear_v2_tmp_artifacts_older_than: rec('clear_v2_tmp_artifacts_older_than'),
    ...actOverrides,
  };
  const ops = createSystemOps({
    incidents, leases, telemetry, actions, deploys, admission, now: c, notify: (n) => notes.push(n), stateRoot: root, plans, leaseTtlMs: ttl,
  });
  return { root, c, m, telemetry, incidents, leases, calls, admission, deployState, notes, actions, ops, tmpRoot: join(root, 'v2-tmp') };
}
const rep = (o = {}) => ({ type: 'host.cpu_pressure', host_id: H, symptom: 'cpu high', reporter: { reporter: 'dev-1', task_id: 'task-1' }, ...o });
const names = (calls) => calls.map((x) => x.name);

// --- incidents -----------------------------------------------------------------------------------------------------

test('incidents: contract fields, durable replay, torn tail dropped, resolved is terminal', async () => {
  const dir = await tmp();
  let n = 0;
  const mk = () => createIncidentStore({ dir, now: () => 1000, randomId: () => `id${++n}` });
  const s = mk();
  const { incident } = await s.report({ ...rep(), measurements: [{ name: 'cpu_pct', value: 97, unit: '%', ts: 1000, source: 'probe' }], evidence_refs: ['art/1'], priority: 'high' });
  for (const k of ['incident_id', 'dedup_key', 'reporters', 'host_id', 'service_id', 'type', 'symptom', 'measurements', 'priority', 'evidence_refs', 'workload_impact', 'candidate_remediation', 'requested_owner_action', 'state']) assert.ok(k in incident, k);
  assert.equal(incident.state, 'open');
  await s.acknowledge(incident.incident_id, { by: 'ops' });
  await appendFile(join(dir, 'incidents.jsonl'), '{"torn":'); // crash mid-write
  const s2 = mk();
  assert.equal((await s2.init()).torn, true);
  assert.equal((await s2.get(incident.incident_id)).state, 'acknowledged');
  await s2.requestMitigation(incident.incident_id, { by: 'x' });                       // appends cleanly after truncation
  assert.equal((await mk().get(incident.incident_id)).state, 'mitigation_requested');
  await s2.resolve(incident.incident_id, { reason: 'ok' });
  await assert.rejects(s2.escalate(incident.incident_id, {}), { code: 'E_ILLEGAL_TRANSITION' });
  const kinds = (await s2.events()).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => !k.includes('action')), ['incident.opened', 'incident.acknowledged', 'incident.mitigation_requested', 'incident.resolved']);
  await assert.rejects(s2.report({ ...rep(), type: 'bogus' }), { code: 'E_INVALID' });
  assert.equal(INCIDENT_TYPES.length, 9);
});

test('incidents: free text is capped and scrubbed of tokens, IPs, home paths, e-mails', async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir });
  const dirty = 'owner a.b@example.test at 192.0.2.7 in /home/someone/proj token=abcd1234 Bearer abc.def ghp_ABCDEFGH12345678 sk-ABCDEFGHIJKL host.tail1234.ts.net ' + 'x'.repeat(2000);
  const { incident } = await s.report({ ...rep(), symptom: dirty, workload_impact: dirty, evidence_refs: [dirty], reporter: dirty, measurements: [{ name: dirty, value: 1, unit: '%', ts: 1, source: dirty }] });
  const all = JSON.stringify(incident);
  for (const bad of ['a.b@example.test', '192.0.2.7', '/home/someone', 'abcd1234', 'abc.def', 'ghp_ABCD', 'sk-ABCD', 'tail1234']) assert.ok(!all.includes(bad), bad);
  assert.ok(incident.symptom.length <= 500);
  assert.ok(!(await readFile(join(dir, 'incidents.jsonl'), 'utf8')).includes('192.0.2.7'));
  assert.equal(sanitizeText('abc123def456abc123def456abc123def456abcd'), 'abc123def456abc123def456abc123def456abcd'); // git sha kept
});

// --- telemetry -----------------------------------------------------------------------------------------------------

test('T35: telemetry stale, unreachable, future-dated or non-numeric is unknown, never healthy', async () => {
  const h = await harness();
  assert.equal((await h.telemetry.assess(H)).status, 'healthy');
  h.m.ts = h.c() - 120_000;
  const stale = await h.telemetry.assess(H);
  assert.equal(stale.status, 'unknown'); assert.ok(stale.readings.every((r) => r.freshness === 'stale' && r.status === 'unknown'));
  h.m.ts = h.c() + 3_600_000;
  assert.equal((await h.telemetry.assess(H)).status, 'unknown');
  h.m.ts = null; h.m.throw = true;
  const down = await h.telemetry.assess(H);
  assert.equal(down.status, 'unknown'); assert.ok(down.readings.every((r) => r.value === null));
  h.m.throw = false; h.m.cpu_pct = NaN;
  assert.equal((await h.telemetry.assess(H)).status, 'unknown');
  h.m.cpu_pct = 99;
  assert.equal((await h.telemetry.assess(H)).status, 'unhealthy');       // a known pressure wins over unknown siblings
  h.m.cpu_pct = 20; h.c.t += 1000;
  assert.equal((await h.telemetry.assess(H, { since: h.c() + 1 })).status, 'unknown');   // older than `since` is not recovery
  const r = readingsFromHealth({ at: 5, cpu: { pct: 10 }, mem: { pct: 20 }, disks: [{ pct: 30 }, { pct: 70 }] });
  assert.equal(r.find((x) => x.name === 'disk_pct').value, 70);
  assert.equal(readingsFromHealth({}).every((x) => x.value === null && x.ts === null), true);
});

test('T35: stale/unreachable health at intake -> incident.unknown + escalated, admission paused, no actions', async () => {
  for (const mode of ['stale', 'throw']) {
    const h = await harness();
    if (mode === 'stale') h.m.ts = h.c() - 10 * 60_000; else h.m.throw = true;
    const r = await h.ops.handleReport(rep());
    assert.equal(r.outcome, 'unknown');
    const inc = await h.incidents.get(r.incident_id);
    assert.equal(inc.state, 'escalated');
    assert.ok((await h.incidents.events()).some((e) => e.kind === 'incident.unknown'));
    assert.equal(h.admission.isPaused(), true);
    assert.deepEqual(h.calls, []);
    h.m.ts = h.c() - 10 * 60_000; h.m.throw = false;                              // stale "healthy" is not recovery
    assert.equal((await h.ops.recheck(r.incident_id)).resumed, false);
    assert.equal(h.admission.isPaused(), true);
  }
});

// --- T32 -----------------------------------------------------------------------------------------------------------

test('T32: disk pressure -> incident, admission paused, only V2-temp cleanup runs, remaining pressure needs approval', async () => {
  const h = await harness();
  h.m.disk_pct = 96;
  const r = await h.ops.handleReport(rep({ type: 'host.disk_pressure', symptom: 'disk full' }));
  assert.deepEqual(names(h.calls), ['clear_v2_tmp_artifacts_older_than']);
  assert.equal(h.calls[0].paused, true);                                      // admission was already paused
  assert.equal(h.calls[0].params.dir, undefined);                             // defaults to the V2 temp root, nothing broader
  assert.equal(r.outcome, 'approval_required');
  assert.equal((await h.incidents.get(r.incident_id)).state, 'approval_required');
  assert.equal(h.admission.isPaused(), true);
  assert.equal((await h.leases.acquire(`host:${H}:maintenance`, { owner: 'other', ttl_ms: 1000 })).ok, true);   // lease released
});

test('T32: deletion outside the V2 temp root, symlink escapes and non-allowlisted actions need approval and never run', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  await mkdir(h.tmpRoot, { recursive: true });
  const outside = await tmp();
  await symlink(outside, join(h.tmpRoot, 'link'));
  const attempts = [
    { action: 'clear_v2_tmp_artifacts_older_than', params: { dir: '/var/lib', older_than_ms: 1000 } },
    { action: 'clear_v2_tmp_artifacts_older_than', params: { dir: join(h.tmpRoot, '..', 'tasks'), older_than_ms: 1000 } },
    { action: 'clear_v2_tmp_artifacts_older_than', params: { dir: join(h.tmpRoot, 'link'), older_than_ms: 1000 } },
    { action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 0 } },
    { action: 'delete_path', params: { path: '/data' } },
    { action: 'kill_process', params: { pid: 1 } },
    { action: 'chmod', params: {} },
  ];
  let i = 0;
  for (const step of attempts) {
    const r = await h.ops.requestOperation({ task_id: 't', role: 'system-operations', op: { type: 'host.disk_pressure', host_id: H, dedup_key: `k${i++}`, steps: [step] } });
    assert.equal(r.outcome, 'approval_required', JSON.stringify(step));
    assert.equal(r.executed, false);
  }
  assert.deepEqual(h.calls, []);
  assert.ok(!ALLOWED_ACTIONS.some((a) => /delete|kill|chmod/.test(a)));
  // inside the root is fine
  await mkdir(join(h.tmpRoot, 'artifacts'), { recursive: true });
  h.m.disk_pct = 97;
  const ok = await h.ops.requestOperation({ task_id: 't', role: 'system-operations', op: { type: 'host.disk_pressure', host_id: H, dedup_key: 'in', steps: [{ action: 'clear_v2_tmp_artifacts_older_than', params: { dir: join(h.tmpRoot, 'artifacts'), older_than_ms: 1000 } }] } });
  assert.equal(names(h.calls).length, 1);
  assert.equal(ok.outcome, 'approval_required');                              // pressure persisted -> still owner's call
});

test('T32: worktree storage / tmux exhaustion have no allowlisted remediation -> approval_required', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  for (const type of ['worktree.storage_exceeded', 'tmux.resource_exhaustion']) {
    const r = await h.ops.handleReport(rep({ type }));
    assert.equal(r.outcome, 'approval_required');
  }
  assert.deepEqual(h.calls, []);
});

// --- T33 -----------------------------------------------------------------------------------------------------------

test('T33: CPU pressure during integration -> throttle + admission pause; task state and integration lease untouched', async () => {
  const h = await harness();
  const integ = await h.leases.acquire('repo:demo:integration', { owner: 'integration-agent', task_id: 'task-int', ttl_ms: 600_000 });
  assert.ok(integ.ok);
  h.m.cpu_pct = 98;
  const r = await h.ops.handleReport(rep({ reporter: { reporter: 'integration-agent', task_id: 'task-int' } }));
  assert.equal(r.outcome, 'mitigated');
  assert.deepEqual(names(h.calls), ['throttle_concurrency']);
  assert.equal(h.calls[0].paused, true);
  assert.deepEqual(await h.leases.validate(integ.lease), { ok: true });             // untouched
  assert.ok(h.notes.some((n) => n.kind === 'admission_paused' && n.task_ids.includes('task-int')));
  assert.ok(!h.notes.some((n) => /cancel|abort/.test(n.kind)));
  assert.equal(h.admission.isPaused(), false);                                       // fresh healthy + lease free
  const inc = await h.incidents.get(r.incident_id);
  assert.equal(inc.state, 'resolved');
  const rc = inc.actions.find((a) => a.action === 'recheck');
  assert.equal(rc.before.find((x) => x.name === 'cpu_pct').value, 98);               // before/after recorded
  assert.equal(rc.after.find((x) => x.name === 'cpu_pct').value, 30);
});

test('T33: throttling does not help -> stays paused and escalates to the owner', async () => {
  const h = await harness({ actions: { throttle_concurrency: { execute: async () => {} } } });
  h.m.cpu_pct = 98;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'approval_required');
  assert.equal(h.admission.isPaused(), true);
});

// --- T34 -----------------------------------------------------------------------------------------------------------

test('T34: recovery while a deployment is active or unknown -> approval_required, no restart/actions, lease released', async () => {
  for (const [deploy, why] of [[{ state: 'active' }, 'deploy_active'], [{ state: 'weird' }, 'deploy_state_unknown'], [new Error('registry down'), 'deploy_state_unknown'], [null, 'deploy_state_unknown']]) {
    const h = await harness({ deploy });
    h.m.svc = false;
    const restart = { execute: async () => { throw new Error('must not run'); } };
    h.actions.request_safe_restart = restart;
    const r = await h.ops.handleReport(rep({ type: 'service.unhealthy', service_id: 'api' }));
    assert.equal(r.outcome, 'approval_required');
    assert.match(r.reason, new RegExp(why));
    assert.deepEqual(h.calls, []);
    assert.equal(h.admission.isPaused(), true);
    assert.equal((await h.leases.acquire(`service:${H}:api`, { owner: 'x', ttl_ms: 1000 })).ok, true);
  }
  // even a "safe" throttle is blocked while deploy state is unknown
  const h = await harness({ deploy: new Error('down') });
  h.m.cpu_pct = 99;
  assert.equal((await h.ops.handleReport(rep())).outcome, 'approval_required');
  assert.deepEqual(h.calls, []);
});

test('T34: a service restart is only ever requested (approval_required), never executed, even with no deploy', async () => {
  const h = await harness();
  h.m.svc = false;
  h.actions.request_safe_restart = { execute: async () => { throw new Error('must not run'); } };
  const r = await h.ops.handleReport(rep({ type: 'service.crash_loop', service_id: 'api' }));
  assert.equal(r.outcome, 'approval_required');
  const inc = await h.incidents.get(r.incident_id);
  assert.equal(inc.approvals[0].action, 'request_safe_restart');
  assert.deepEqual(h.calls, []);
});

// --- T36 -----------------------------------------------------------------------------------------------------------

test('T36: two developers report the same host issue -> one incident, linked reports, one remediation', async () => {
  const h = await harness({ actions: { throttle_concurrency: { execute: async () => { h.calls.push({ name: 'throttle_concurrency' }); } } } });
  h.m.cpu_pct = 98;
  const [a, b] = await Promise.all([
    h.ops.handleReport(rep({ reporter: { reporter: 'dev-1', task_id: 'task-1' } })),
    h.ops.handleReport(rep({ reporter: { reporter: 'dev-2', task_id: 'task-2' }, symptom: 'machine is slow' })),
  ]);
  assert.equal(a.incident_id, b.incident_id);
  assert.equal([a, b].filter((x) => x.deduped).length, 1);
  assert.equal(names(h.calls).length, 1);
  const all = await h.incidents.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].reporters.map((x) => x.task_id).sort(), ['task-1', 'task-2']);
  // while it is still open (approval pending) a third report links too
  const h2 = await harness({ actions: { throttle_concurrency: { execute: async () => {} } } });
  h2.m.cpu_pct = 98;
  const first = await h2.ops.handleReport(rep());
  const third = await h2.ops.handleReport(rep({ reporter: { reporter: 'dev-3', task_id: 'task-3' } }));
  assert.equal(third.incident_id, first.incident_id); assert.equal(third.deduped, true);
  assert.equal((await h2.incidents.get(first.incident_id)).reporters.length, 2);
});

// --- T37 -----------------------------------------------------------------------------------------------------------

test('T37: action fails mid-execution -> checkpoint, undo, incident stays open (reconciling), lease released, admission paused', async () => {
  const h = await harness({
    plans: { 'host.cpu_pressure': [{ action: 'throttle_concurrency', params: { max: 1 } }, { action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 5 } }] },
  });
  h.actions.throttle_concurrency = {
    checkpoint: async () => ({ previous_max: 4 }),
    execute: async () => {},
    undo: async (params, ctx) => { h.calls.push({ name: 'throttle:undo', checkpoint: ctx.checkpoint }); },
  };
  h.actions.clear_v2_tmp_artifacts_older_than = { execute: async () => { throw new Error('disk io error at /home/someone/x'); } };
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling');
  assert.deepEqual(names(h.calls), ['throttle:undo']);
  assert.deepEqual(h.calls[0].checkpoint, { previous_max: 4 });
  const inc = await h.incidents.get(r.incident_id);
  assert.equal(inc.state, 'reconciling');
  assert.deepEqual(inc.actions.map((a) => a.status), ['done', 'failed', 'rolled_back']);
  assert.ok(!JSON.stringify(inc).includes('/home/someone'));
  assert.equal(h.admission.isPaused(), true);
  assert.equal((await h.leases.acquire(`host:${H}:maintenance`, { owner: 'x', ttl_ms: 1000 })).ok, true);
  assert.equal((await h.incidents.list({ open: true })).length, 1);
});

test('T37: lease lost between actions -> next action fenced and not executed, no undo under a dead lease, reconciling', async () => {
  const h = await harness({ ttl: 1000, plans: { 'host.cpu_pressure': [{ action: 'throttle_concurrency', params: { max: 1 } }, { action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 5 } }] } });
  h.actions.throttle_concurrency = {
    execute: async () => { h.c.t += 5000; await h.leases.acquire(`host:${H}:maintenance`, { owner: 'usurper', ttl_ms: 60_000 }); },   // TTL expires, someone else takes over
    undo: async () => { h.calls.push({ name: 'undo-called' }); },
  };
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling');
  assert.deepEqual(h.calls, []);                                                      // second action never ran
  assert.equal((await h.incidents.get(r.incident_id)).state, 'reconciling');
});

// --- T38 -----------------------------------------------------------------------------------------------------------

test('T38: queued tasks resume only after a FRESH healthy reading and a released maintenance lease', async () => {
  const h = await harness();
  h.m.svc = false;
  const r = await h.ops.handleReport(rep({ type: 'service.unhealthy', service_id: 'api' }));
  assert.equal(r.outcome, 'approval_required');
  assert.equal(h.admission.isPaused(), true);
  // service "recovered" but the only healthy reading is stale: no resume
  h.m.svc = true; h.m.ts = h.c() - 300_000; h.m.svcTs = h.c() - 300_000;
  assert.equal((await h.ops.recheck(r.incident_id)).resumed, false);
  assert.equal(h.admission.isPaused(), true);
  // fresh and healthy, but somebody still holds the service maintenance lease
  h.m.ts = null; h.m.svcTs = null;
  const held = await h.leases.acquire(`service:${H}:api`, { owner: 'owner-maint', ttl_ms: 60_000 });
  assert.ok(held.ok);
  const blocked = await h.ops.recheck(r.incident_id);
  assert.equal(blocked.resumed, false); assert.match(blocked.why, /E_HELD/);
  assert.equal(h.admission.isPaused(), true);
  // lease released -> resume and resolve
  await h.leases.release(held.lease);
  const ok = await h.ops.recheck(r.incident_id);
  assert.equal(ok.resumed, true);
  assert.equal(h.admission.isPaused(), false);
  assert.equal((await h.incidents.get(r.incident_id)).state, 'resolved');
});

test('T38: one incident cannot resume admission paused for another; lease backend failure never resumes', async () => {
  const h = await harness();
  h.m.cpu_pct = 99; h.actions.throttle_concurrency = { execute: async () => {} };
  const a = await h.ops.handleReport(rep());
  h.m.svc = false;
  const b = await h.ops.handleReport(rep({ type: 'service.unhealthy', service_id: 'api', dedup_key: 'svc' }));
  assert.deepEqual(h.admission.reasons().sort(), [`incident:${a.incident_id}`, `incident:${b.incident_id}`].sort());
  h.m.cpu_pct = 20; h.m.svc = true;
  assert.equal((await h.ops.recheck(a.incident_id)).resumed, true);
  assert.equal(h.admission.isPaused(), true);                                         // b still holds it
  const fb = fakeBackend({ now: h.c });
  const h2 = await harness({ backend: fb });
  h2.m.svc = false;
  const c = await h2.ops.handleReport(rep({ type: 'service.unhealthy', service_id: 'api' }));
  fb.setFail('unavailable');
  h2.m.svc = true;
  assert.equal((await h2.ops.recheck(c.incident_id)).resumed, false);
  assert.equal(h2.admission.isPaused(), true);
});

test('admission controller persists across restarts and a corrupt file fails closed', async () => {
  const dir = await tmp();
  const file = join(dir, 'a.json');
  const a = createAdmissionController({ file });
  assert.equal(a.isPaused(), false);
  a.pause('x'); a.pause('y');
  assert.equal(createAdmissionController({ file }).isPaused(), true);
  a.resume('x');
  assert.deepEqual(createAdmissionController({ file }).reasons(), ['y']);
  a.resume();
  assert.equal(createAdmissionController({ file }).isPaused(), false);
  await appendFile(file, 'garbage');
  assert.equal(createAdmissionController({ file }).isPaused(), true);
});

// --- GL10: lease fail-closed ---------------------------------------------------------------------------------------

test('GL10: lease unavailable or held by someone else -> no action, escalated, admission stays paused', async () => {
  const fb = fakeBackend({ fail: 'unavailable' });
  const h = await harness({ backend: fb });
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'blocked'); assert.equal(r.code, 'E_UNAVAILABLE');
  assert.deepEqual(h.calls, []);
  assert.equal((await h.incidents.get(r.incident_id)).state, 'escalated');
  assert.equal(h.admission.isPaused(), true);

  const h2 = await harness();
  await h2.leases.acquire(`host:${H}:maintenance`, { owner: 'someone', ttl_ms: 60_000 });
  h2.m.cpu_pct = 99;
  const r2 = await h2.ops.handleReport(rep());
  assert.equal(r2.code, 'E_HELD'); assert.deepEqual(h2.calls, []);
});

// --- T40 / GL09 ----------------------------------------------------------------------------------------------------

test('T40: developer/tester/integration requests become mitigation_requested incidents and are never executed', async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  let i = 0;
  for (const role of ['developer', 'tester', 'integration', 'manager', 'system-operations-impostor']) {
    for (const action of ['throttle_concurrency', 'request_safe_restart', 'delete_path']) {
      const r = await h.ops.requestOperation({ task_id: `t-${i}`, role, op: { type: 'host.cpu_pressure', host_id: H, action, params: { path: '/x' }, dedup_key: `k-${i++}` } });
      assert.equal(r.executed, false, `${role}/${action}`);
      assert.equal(r.state, 'mitigation_requested');
      assert.equal((await h.incidents.get(r.incident_id)).state, 'mitigation_requested');
    }
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.admission.isPaused(), false);               // a request alone changes nothing
  assert.ok((await h.incidents.events()).some((e) => e.kind === 'incident.mitigation_requested'));
});

test('GL09: only the system-operations role executes; its non-allowlisted or destructive ops still need approval', async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  const ok = await h.ops.requestOperation({ task_id: 'ops-1', role: 'system-operations', op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', params: { max: 2 } } });
  assert.equal(ok.executed, true);
  assert.deepEqual(names(h.calls), ['throttle_concurrency']);
  h.m.cpu_pct = 99;
  const bad = await h.ops.requestOperation({ task_id: 'ops-2', role: 'system-operations', op: { type: 'host.cpu_pressure', host_id: H, action: 'kill_process', params: { pid: 1 }, dedup_key: 'k2' } });
  assert.equal(bad.executed, false); assert.equal(bad.outcome, 'approval_required');
  assert.equal(h.calls.length, 1);
  // a request that dedups onto an open incident is linked, not run twice
  const dup = await h.ops.requestOperation({ task_id: 'ops-3', role: 'system-operations', op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', dedup_key: 'k2' } });
  assert.equal(dup.deduped, true); assert.equal(h.calls.length, 1);
});
