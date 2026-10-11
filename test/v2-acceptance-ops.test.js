// T33 / GL10 / T38 / T40 end to end: the goal loop, the integration controller and System Operations share one lease
// authority and one admission gate over a disposable remote. Host pressure arrives while an integration holds the
// repo lane; the incident is handled by System Operations alone, with allowlisted reversible actions on its own
// resource, and paused work resumes only after a fresh healthy reading. Synthetic telemetry, fake executors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCiGates } from '../orchestration/ci-gates.js';
import { createGitRunner } from '../orchestration/integration-controller.js';
import { createIncidentStore } from '../orchestration/incidents.js';
import { createTelemetry } from '../orchestration/telemetry.js';
import { createSystemOps, createAdmissionController } from '../orchestration/system-ops.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { sandbox, world, mkOrigin, makeDelivery, fakeRemoteCi, states, loopDecisions, devRuns, GOOD, APPROVE } from './fixtures/v2-world.js';

const sb = sandbox('v2-acc-ops-');
const HOST = 'host-a';
const OWNER = { role: 'owner', id: 'owner-1' };
const DELIVER = { review_policy: { mode: 'goal_loop', independent_review: true, deliver: true }, scope: { paths: ['src', 'test'] } };

// System Operations over a fake host: telemetry readings come from `m`, executors are recorded.
function opsFor(stateRoot, leases, { throttleTo = 30, cleanupTo = 50, onCleanup = null } = {}) {
  const m = { cpu_pct: 20, mem_pct: 30, disk_pct: 40 };
  const telemetry = createTelemetry({ maxAgeMs: 60_000, probe: async () => ['cpu_pct', 'mem_pct', 'disk_pct'].map((name) => ({ name, value: m[name], unit: '%', ts: Date.now(), source: 'fake-probe' })) });
  const incidents = createIncidentStore({ dir: path.join(stateRoot, 'incidents') });
  const admission = createAdmissionController({ file: path.join(stateRoot, 'admission.json') });
  const calls = [];
  const tmpRoot = path.join(stateRoot, 'v2-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const actions = {
    throttle_concurrency: { execute: async (p) => { calls.push({ action: 'throttle_concurrency', params: p, paused: admission.isPaused() }); m.cpu_pct = throttleTo; },
      undo: async () => { calls.push({ action: 'throttle_concurrency:undo' }); } },
    // Executor contract (system-ops.js): re-check the root at run time, never follow symlinks, only old files.
    clear_v2_tmp_artifacts_older_than: { execute: async (p) => {
      const root = fs.realpathSync(p.dir ?? tmpRoot);
      assert.equal(path.relative(fs.realpathSync(tmpRoot), root).startsWith('..'), false);
      const removed = [];
      for (const f of fs.readdirSync(root)) {
        const st = fs.lstatSync(path.join(root, f));
        if (st.isFile() && Date.now() - st.mtimeMs > p.older_than_ms) { fs.unlinkSync(path.join(root, f)); removed.push(f); }
      }
      calls.push({ action: 'clear_v2_tmp_artifacts_older_than', removed, paused: admission.isPaused() });
      await onCleanup?.();
      m.disk_pct = cleanupTo;
      return { removed };
    } },
  };
  const deploys = { status: async () => ({ state: 'idle' }) };
  const notes = [];
  const ops = createSystemOps({ incidents, leases, telemetry, actions, deploys, admission, notify: (n) => notes.push(n), stateRoot, minCleanupAgeMs: 1 });
  return { m, ops, incidents, admission, calls, notes, tmpRoot };
}

// A delivery world (loop + controller + System Ops) sharing one lease authority. `beforeGates` runs inside the
// controller's gate step, i.e. while it holds repo:demo:integration and repo:demo:main.
function deliveryWorld({ beforeGates = null, opsOpts = {}, leaseNow = null, leaseTtlMs } = {}) {
  const o = mkOrigin(sb);
  const ci = fakeRemoteCi(o);
  const box = {};
  const integrate = (...a) => box.hook(...a);
  const stateRoot = sb.dir('state');
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(stateRoot, 'leases'), ...(leaseNow ? { now: leaseNow } : {}) }), ...(leaseNow ? { now: leaseNow } : {}) });
  const sys = opsFor(stateRoot, leases, opsOpts);
  const env = world(sb, { repo: { dir: o.repo, sha: o.sha }, dev: [GOOD], rev: [APPROVE],
    loopOpts: { integrate, admission: sys.admission, systemOps: { requestOperation: (r) => sys.ops.requester.request(r) }, hostId: HOST } });
  const real = createCiGates({ git: createGitRunner({ env: sb.GIT_ENV }), artifactsDir: path.join(o.dir, 'gate-artifacts'), actor: { role: 'integration', id: 'integrator-a' } });
  const gateCalls = [];
  const gates = { run: async (x) => { gateCalls.push(x.sha); if (beforeGates) await beforeGates(x, gateCalls.length); return real.run(x); } };
  const c = makeDelivery(sb, o, { store: env.store, ci, leases, gates, ...(leaseNow ? { now: leaseNow } : {}), ...(leaseTtlMs ? { leaseTtlMs } : {}) });
  box.hook = c.integrate;
  box.hook.runs = c.runs;
  return { o, ci, env, c, hook: box.hook, sys, leases, gateCalls, stateRoot };
}
const approveRequired = async (env, id, req) => env.loop.approve(id, { actor: OWNER, approval_ref: `owner-${req.action}-${req.sha.slice(0, 8)}`,
  grants: { classes: [req.class] } });
async function deliverToAccepted(w, id) {
  for (let i = 0; i < 6; i++) {
    const r = await w.env.loop.run(id);
    if (r.state !== 'awaiting_approval') return r;
    await approveRequired(w.env, id, w.hook.runs.filter((x) => x.outcome === 'awaiting_approval').at(-1).required);
  }
  return w.env.loop.run(id);
}
const holds = async (leases, resource) => {
  const r = await leases.acquire(resource, { owner: 'probe', ttl_ms: 1000, scope: 'probe' });
  if (r.ok) { await leases.release(r.lease); return false; }
  assert.equal(r.code, 'E_HELD', `probe of ${resource}: ${r.code}`);
  return true;
};

test('T33: CPU pressure during integration -> System Ops throttles under its own host lease and pauses admission; the integration keeps its leases and state and still merges; queued work resumes on a fresh healthy reading', async () => {
  let seen = null;
  const w = deliveryWorld({
    opsOpts: { throttleTo: 95 },      // throttling helps a little, not enough: admission stays paused
    beforeGates: async (_x, n) => {
      if (n !== 1) return;
      w.sys.m.cpu_pct = 98;
      const inc = await w.sys.ops.handleReport({ type: 'host.cpu_pressure', host_id: HOST, symptom: 'cpu high during integration gates',
        reporter: { reporter: 'integration-agent', task_id: w.taskA } });
      seen = { inc, integrationHeld: await holds(w.leases, 'repo:demo:integration'), mainHeld: await holds(w.leases, 'repo:demo:main'),
        hostHeld: await holds(w.leases, `host:${HOST}:maintenance`), taskState: (await w.env.view(w.taskA)).status, paused: w.sys.admission.isPaused() };
    },
  });
  w.taskA = (await w.env.submit(DELIVER)).task_id;
  const r1 = await w.env.loop.run(w.taskA);
  assert.equal(r1.state, 'awaiting_approval', 'the integration went on to its normal approval gate');
  // During the pressure: ops acted on its own resource only; the integration lane stayed with the integrator.
  assert.equal(seen.inc.outcome, 'approval_required', 'throttle insufficient -> owner, nothing else executed');
  assert.deepEqual(w.sys.calls.map((x) => x.action), ['throttle_concurrency']);
  assert.equal(w.sys.calls[0].paused, true, 'admission paused before acting');
  assert.deepEqual([seen.integrationHeld, seen.mainHeld, seen.hostHeld], [true, true, false], 'repo leases held by the integration; host lease released by ops');
  assert.equal(seen.taskState, 'integrating', 'System Ops never touches task state');
  assert.equal(seen.paused, true);
  assert.ok(w.sys.notes.some((n) => n.kind === 'admission_paused' && n.task_ids.includes(w.taskA)), 'the affected task was notified');
  assert.equal(await holds(w.leases, 'repo:demo:integration'), false, 'integration released its leases after the run');

  // New work is admitted to the store but not dispatched while paused.
  const b = (await w.env.submit({})).task_id;
  const rb = await w.env.loop.run(b, { until: ['waiting'] });
  assert.equal(rb.state, 'waiting');
  assert.equal(loopDecisions(await w.env.view(b), 'admission_paused').length, 1);
  assert.equal(devRuns(w.env, b).length, 0);
  // Stale or still-high readings never resume; a fresh healthy one with the maintenance lease free does.
  assert.equal((await w.sys.ops.recheck(seen.inc.incident_id)).resumed, false);
  w.sys.m.cpu_pct = 25;
  const rc = await w.sys.ops.recheck(seen.inc.incident_id);
  assert.equal(rc.resumed, true);
  assert.equal(w.sys.admission.isPaused(), false);
  assert.equal((await w.sys.incidents.get(seen.inc.incident_id)).state, 'resolved');
  assert.equal((await w.env.loop.run(b)).state, 'accepted', 'queued task resumed after recovery');
  assert.equal((await deliverToAccepted(w, w.taskA)).state, 'accepted');
  assert.equal(w.o.head(), w.hook.runs.find((x) => x.outcome === 'merged').integration_sha);
  // The integration's task history has no ops-made transition; ops' incident log has no task mutation.
  assert.deepEqual([...new Set((await w.env.view(w.taskA)).history.map((h) => h.actor))], ['goal-loop'], 'every transition made by the loop itself');
  assert.ok(!(await w.sys.incidents.events()).some((e) => /task\./.test(e.kind)));
});

test('T38/T40/T32: host pressure under a running task -> the loop only requests an operation -> System Ops runs a scoped, reversible cleanup under its lease -> fresh healthy reading -> admission resumes -> the task completes', async () => {
  const stateRoot = sb.dir('state');
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(stateRoot, 'leases') }) });
  let env;
  let during = null;
  const sys = opsFor(stateRoot, leases, { onCleanup: async () => {
    // While maintenance runs, the waiting task is not let back in, however much time passes.
    env.advance(10 * 60_000);
    during = { step: await env.loop.step(task.task_id), paused: sys.admission.isPaused(), hostHeld: await holds(leases, `host:${HOST}:maintenance`) };
  } });
  let enospc = 1;
  const failingGit = (args, o) => (args.includes('commit') && enospc-- > 0 ? Promise.reject(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })) : sb.git(args, o));
  env = world(sb, { dev: [GOOD], rev: [APPROVE], loopOpts: { git: failingGit, admission: sys.admission, systemOps: { requestOperation: (r) => sys.ops.requester.request(r) }, hostId: HOST } });
  const task = await env.submit();
  // Synthetic temp artifacts: one old (removable), one fresh (kept); a symlink inside pointing outside; a file outside.
  const outside = path.join(stateRoot, 'outside-keep.txt');
  fs.writeFileSync(outside, 'not ours');
  const old = path.join(sys.tmpRoot, 'old-artifact.log');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date(Date.now() - 48 * 3600_000), new Date(Date.now() - 48 * 3600_000));
  fs.writeFileSync(path.join(sys.tmpRoot, 'fresh-artifact.log'), 'y');
  fs.symlinkSync(outside, path.join(sys.tmpRoot, 'link-out'));

  const r1 = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(r1.state, 'waiting');
  const v1 = await env.view(task.task_id);
  const wait = loopDecisions(v1, 'infra_incident')[0];
  assert.ok(wait, 'infrastructure failure became an incident wait');
  const incId = wait.loop.patch.wait.incident_id;
  const inc0 = await sys.incidents.get(incId);
  assert.equal(inc0.state, 'mitigation_requested', 'the loop requested; nothing executed');
  assert.equal(sys.calls.length, 0);
  assert.ok(inc0.reporters.some((x) => x.task_id === task.task_id));

  // System Operations (the only executing role) handles it with an explicit, allowlisted operation.
  sys.m.disk_pct = 96;
  const op = await sys.ops.execute({ type: 'host.disk_pressure', host_id: HOST, action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 24 * 3600_000 }, dedup_key: 'ops-disk-sweep-1' });
  assert.equal(op.incident_id, incId, 'same incident, linked, not a duplicate');
  assert.equal(op.outcome, 'mitigated');
  assert.equal(op.resumed, true);
  assert.deepEqual(sys.calls.map((x) => [x.action, x.removed, x.paused]), [['clear_v2_tmp_artifacts_older_than', ['old-artifact.log'], true]]);
  // Scoped: only the old file inside the V2 temp root went; the symlink target and everything outside are intact.
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(sys.tmpRoot, 'fresh-artifact.log')), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not ours');
  assert.equal(fs.lstatSync(path.join(sys.tmpRoot, 'link-out')).isSymbolicLink(), true);
  // During maintenance: admission paused, host lease held by ops, the task stayed waiting.
  assert.deepEqual([during.paused, during.hostHeld, during.step.transitioned], [true, true, false]);
  assert.match(during.step.note, /admission paused/);
  const inc = await sys.incidents.get(incId);
  assert.equal(inc.state, 'resolved');
  const rc = inc.actions.find((a) => a.action === 'recheck');
  assert.deepEqual([rc.before.find((x) => x.name === 'disk_pct').value, rc.after.find((x) => x.name === 'disk_pct').value], [96, 50]);
  assert.equal(await holds(leases, `host:${HOST}:maintenance`), false, 'maintenance lease released');
  assert.equal(sys.admission.isPaused(), false);
  // The task resumes from its persisted state and completes; no developer rerun was needed for the infra failure.
  env.advance(10 * 60_000);
  const r2 = await env.loop.run(task.task_id);
  assert.equal(r2.state, 'accepted');
  const v = await env.view(task.task_id);
  assert.ok(states(v).includes('waiting'));
  assert.equal(v.outcome, 'done');
});

test('T40: a developer run that asks for host maintenance gets an owner approval request; nothing reaches a System Ops executor', async () => {
  const stateRoot = sb.dir('state');
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(stateRoot, 'leases') }) });
  const sys = opsFor(stateRoot, leases);
  sys.m.cpu_pct = 99;                                   // real pressure: an executor would run if anything reached it
  const ask = [{ op: 'emit', event: { type: 'action_request', class: 'read', argv: ['systemctl', 'restart', 'ghosty-sessions'] } },
    { op: 'emit', event: { type: 'action_request', text: 'please free disk: rm -rf the old worktrees' } }, ...GOOD];
  const env = world(sb, { dev: [ask, GOOD], rev: [APPROVE], loopOpts: { admission: sys.admission, systemOps: { requestOperation: (r) => sys.ops.requester.request(r) }, hostId: HOST } });
  const task = await env.submit();
  assert.equal((await env.loop.run(task.task_id)).state, 'awaiting_approval');
  const reqs = env.events(task.task_id).filter((e) => e.kind === 'approval.requested' && e.payload.run_id);
  assert.equal(reqs.length, 2);
  assert.ok(reqs[0].payload.classes.includes('host_maintenance'), JSON.stringify(reqs[0].payload.classes));
  assert.ok(reqs[1].payload.classes.includes('destructive'), JSON.stringify(reqs[1].payload.classes));
  assert.deepEqual(sys.calls, [], 'no executor ran');
  assert.equal(sys.admission.isPaused(), false, 'a developer request does not even pause admission');
  assert.deepEqual(await sys.incidents.list(), [], 'and opens no incident: the owner decides first');
});

test('GL10: maintenance that needs the repo lane waits for the running integration: canonical-order, all-or-nothing acquisition; nothing half-held; it proceeds once the integration releases', async () => {
  let probe = null;
  const w = deliveryWorld({
    beforeGates: async (_x, n) => {
      if (n !== 1) return;
      // A System Ops maintenance window that must also own the repo lane (e.g. pruning integration worktrees).
      const r = await w.leases.acquireAll([`repo:demo:integration`, `host:${HOST}:maintenance`], { owner: 'system-ops', ttl_ms: 60_000, scope: 'maintenance' });
      probe = { ok: r.ok, code: r.code, hostHeld: await holds(w.leases, `host:${HOST}:maintenance`) };
    },
  });
  const id = (await w.env.submit(DELIVER)).task_id;
  assert.equal((await w.env.loop.run(id)).state, 'awaiting_approval');
  assert.deepEqual(probe, { ok: false, code: 'E_HELD', hostHeld: false }, 'refused while held; the host lease it reached first was rolled back');
  const after = await w.leases.acquireAll([`host:${HOST}:maintenance`, 'repo:demo:integration'], { owner: 'system-ops', ttl_ms: 60_000, scope: 'maintenance' });
  assert.equal(after.ok, true, 'free once the integration run released its leases');
  assert.deepEqual(after.leases.map((l) => l.resource), ['host:host-a:maintenance', 'repo:demo:integration'], 'canonical order whatever the request order');
  // ...and while System Ops holds the lane, the integration waits instead of mutating.
  await approveRequired(w.env, id, w.hook.runs.at(-1).required);
  const r = await w.env.loop.run(id, { until: ['waiting'] });
  assert.equal(r.state, 'waiting');
  assert.equal(w.hook.runs.at(-1).outcome, 'busy');
  assert.equal(w.o.head('v2int/main'), null, 'no candidate push while the lane is held');
  for (const l of after.leases) assert.equal((await w.leases.release(l)).ok, true);
  assert.equal((await deliverToAccepted(w, id)).state, 'accepted');
});

test('GL10: Integration and System Ops race for overlapping resources in opposite orders: never a deadlock, never split holdings, at most one holder per round', async () => {
  const dir = sb.dir('race');
  const a = createLeaseAuthority({ backend: fileBackend({ dir }) });
  const b = createLeaseAuthority({ backend: fileBackend({ dir }) });   // a second process view of the same authority
  let won = 0;
  for (let round = 0; round < 20; round++) {
    const [ri, ro] = await Promise.all([
      a.acquireAll(['repo:demo:integration', 'repo:demo:main', `host:${HOST}:maintenance`], { owner: 'integrator', ttl_ms: 5000, scope: 'integration' }),
      b.acquireAll([`host:${HOST}:maintenance`, 'repo:demo:main'], { owner: 'system-ops', ttl_ms: 5000, scope: 'maintenance' }),
    ]);
    assert.equal([ri.ok, ro.ok].filter(Boolean).length <= 1, true, `round ${round}: at most one holder`);
    const winner = ri.ok ? ri : ro.ok ? ro : null;
    if (winner) won++;
    // The loser holds nothing: every resource it asked for is either free or the winner's.
    for (const res of ['repo:demo:integration', 'repo:demo:main', `host:${HOST}:maintenance`]) {
      const mine = winner?.leases.some((l) => l.resource === res);
      assert.equal(await holds(a, res), !!mine, `round ${round}: ${res}`);
    }
    if (winner) for (const l of winner.leases) assert.equal((await (ri.ok ? a : b).release(l)).ok, true);
  }
  assert.ok(won >= 10, `contention resolved to a single holder in most rounds (${won}/20), not a livelock`);
});

test('GL10/T27: stale fencing across roles: the integrator\'s lease expires mid-gate and System Ops takes the lane; the stale integrator pushes nothing and the task waits', async () => {
  let t = Date.now();
  const clock = () => t;
  let takeover = null;
  const w = deliveryWorld({
    leaseNow: clock, leaseTtlMs: 60_000,
    beforeGates: async (_x, n) => {
      if (n !== 2) return;                                 // run 1 stops at the push approval; run 2 is approved
      t += 10 * 60_000;                                    // the gate step outlives the integrator's lease
      takeover = await w.leases.acquireAll(['repo:demo:integration', 'repo:demo:main'], { owner: 'system-ops', ttl_ms: 600_000, scope: 'maintenance' });
    },
  });
  const id = (await w.env.submit(DELIVER)).task_id;
  const before = w.o.head();
  assert.equal((await w.env.loop.run(id)).state, 'awaiting_approval');
  await approveRequired(w.env, id, w.hook.runs.at(-1).required);
  const r = await w.env.loop.run(id, { until: ['waiting'] });
  assert.equal(takeover.ok, true, 'expired lease is free for the next holder');
  assert.equal(r.state, 'waiting');
  assert.equal(w.hook.runs[1].outcome, 'lease_lost');
  assert.equal(w.o.head('v2int/main'), null, 'no candidate push');
  assert.equal(w.o.head(), before, 'no merge');
  assert.ok(w.c.alerts.some((x) => x.kind === 'lease_lost'));
  assert.ok(w.env.events(id).some((e) => e.kind === 'task.blocked' && e.payload.reason === 'lease_lost'));
  assert.deepEqual((await w.env.view(id)).effects.filter((e) => ['push', 'merge'].includes(e.kind)).map((e) => e.phase).filter((p) => p !== 'failed'), [], 'no confirmed or pending remote effect');
  // The takeover holder is untouched by the stale integrator's finally-release.
  for (const l of takeover.leases) assert.deepEqual(await w.leases.validate(l), { ok: true });
});
