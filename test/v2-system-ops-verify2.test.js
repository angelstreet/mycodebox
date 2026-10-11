// Re-verification of v2/10-system-ops at b6c07f0: variants of every finding from the first round
// (test/v2-system-ops-verify.test.js). A `todo: 'defect: ...'` marks a gap that is still open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createIncidentStore, sanitizeText } from '../orchestration/incidents.js';
import { createTelemetry } from '../orchestration/telemetry.js';
import { createSystemOps, createAdmissionController, realpathDeepest, SYSTEM_ROLE } from '../orchestration/system-ops.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-sysops-verify2-'));
const H = 'host-a';

async function harness({ actions: extra = {}, plans, minCleanupAgeMs = 5, realpath, actionsObject } = {}) {
  const root = await tmp();
  const c = () => c.t; c.t = 1_800_000_000_000;
  const m = { cpu_pct: 20, mem_pct: 30, disk_pct: 40, ts: null, svc: true };
  const telemetry = createTelemetry({
    now: c, maxAgeMs: 60_000,
    probe: async () => ['cpu_pct', 'mem_pct', 'disk_pct'].map((name) => ({ name, value: m[name], unit: '%', ts: m.ts ?? c(), source: 'fake' })),
    serviceProbe: async () => ({ healthy: m.svc, ts: c(), source: 'fake-svc' }),
  });
  const incidents = createIncidentStore({ dir: join(root, 'inc'), now: c });
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: join(root, 'leases'), now: c }), now: c });
  const calls = [];
  const rec = (name) => ({ execute: async (params, ctx) => { calls.push({ name, params, ctx }); } });
  const admission = createAdmissionController({ file: join(root, 'admission.json'), now: c });
  const deploys = { status: async () => ({ state: 'none' }) };
  const actions = actionsObject || { throttle_concurrency: rec('throttle_concurrency'), clear_v2_tmp_artifacts_older_than: rec('clear_v2_tmp_artifacts_older_than'), ...extra };
  const ops = createSystemOps({ incidents, leases, telemetry, actions, deploys, admission, now: c, stateRoot: root, plans, ...(minCleanupAgeMs === null ? {} : { minCleanupAgeMs }), ...(realpath ? { realpath } : {}) });
  return { root, c, m, incidents, leases, calls, admission, actions, ops, tmpRoot: join(root, 'v2-tmp') };
}
const rep = (o = {}) => ({ type: 'host.cpu_pressure', host_id: H, symptom: 'cpu high', reporter: { reporter: 'dev-1', task_id: 'task-1' }, ...o });
const clean = (h, steps, extra = {}) => h.ops.execute({ type: 'host.disk_pressure', host_id: H, dedup_key: `k-${Math.random()}`, steps, ...extra });

// --- F10 allowlist / step snapshot ---------------------------------------------------------------------------------

test('F10: params are snapshotted once; a getter cannot hand the executor a different dir than the one checked', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  await mkdir(join(h.tmpRoot, 'ok'), { recursive: true });
  let reads = 0;
  const params = { older_than_ms: 10, get dir() { return ++reads === 1 ? join(h.tmpRoot, 'ok') : '/etc'; } };
  const r = await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].params.dir, join(h.tmpRoot, 'ok'));
  assert.equal(r.executed, true);
});

test('F10: executors inherited through the prototype of the actions map, or registered under non-allowlisted names, are unreachable', async () => {
  class Acts { } Acts.prototype.throttle_concurrency = { execute: async () => { throw new Error('inherited executor ran'); } };
  const h = await harness({ actionsObject: Object.assign(new Acts(), { kill_session: { execute: async () => { throw new Error('ran'); } } }) });
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling'); assert.match(r.why, /no executor/);
  assert.equal(r.actions_run, 0);
  // and nothing at all with Object.prototype pollution-style keys
  const h2 = await harness({ actions: { ['__proto__']: { execute: async () => { throw new Error('ran'); } } } });
  h2.m.disk_pct = 97;
  const r2 = await clean(h2, [{ action: '__proto__', params: {} }]);
  assert.equal(r2.outcome, 'approval_required'); assert.equal(r2.actions_run, 0);
});

// --- F4 temp root --------------------------------------------------------------------------------------------------

test('F4: realpathDeepest judges a not-yet-existing tail by its deepest existing ancestor and fails closed on other errors', async () => {
  const root = await tmp();
  const outside = await tmp();
  await mkdir(join(root, 'v2-tmp'), { recursive: true });
  await symlink(outside, join(root, 'v2-tmp', 'link'));
  await writeFile(join(root, 'v2-tmp', 'file'), 'x');
  await symlink(join(root, 'v2-tmp', 'loop2'), join(root, 'v2-tmp', 'loop1'));
  await symlink(join(root, 'v2-tmp', 'loop1'), join(root, 'v2-tmp', 'loop2'));
  assert.equal(realpathDeepest(join(root, 'v2-tmp', 'link', 'a', 'b', 'c')), join(await import('node:fs').then((f) => f.realpathSync(outside)), 'a', 'b', 'c'));
  assert.equal(realpathDeepest(join(root, 'v2-tmp', 'file', 'sub')), join(await import('node:fs').then((f) => f.realpathSync(root)), 'v2-tmp', 'file', 'sub'));   // ENOTDIR: lexical tail, executor fails later
  assert.throws(() => realpathDeepest(join(root, 'v2-tmp', 'loop1', 'x')), /ELOOP/);
  assert.throws(() => realpathDeepest('/nonexistent-root-xyz/a', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }), /EACCES/);
});

test('F4: every escape variant is refused and nothing runs; only a real inside path (even a deep new one) executes', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  await mkdir(join(h.tmpRoot, 'real'), { recursive: true });
  const outside = await tmp();
  await symlink(outside, join(h.tmpRoot, 'link'));
  await symlink(join(h.tmpRoot, 'loop2'), join(h.tmpRoot, 'loop1'));
  await symlink(join(h.tmpRoot, 'loop1'), join(h.tmpRoot, 'loop2'));
  const bad = [
    join(h.tmpRoot, 'link', 'a', 'b', 'c'), join(h.tmpRoot, 'real', '..', 'link', 'x'), join(h.tmpRoot, 'loop1', 'x'),
    `${h.tmpRoot}-evil`, `${h.tmpRoot}/`.slice(0, -1) + '/../v2-tmp-evil/x', 'v2-tmp/real', './real', '', `${h.tmpRoot}/real\0`,
    ['/etc'], { toString: () => h.tmpRoot }, 42, `${h.tmpRoot}/real/`.repeat(1) + '../../../../../../../../etc',
  ];
  for (const dir of bad) {
    const r = await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { dir, older_than_ms: 10 } }]);
    assert.equal(r.actions_run, 0, JSON.stringify(dir));
    assert.equal(r.outcome, 'approval_required', JSON.stringify(dir));
  }
  assert.deepEqual(h.calls, []);
  const ok = await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { dir: join(h.tmpRoot, 'real', 'new', 'deeper'), older_than_ms: 10 } }]);
  assert.equal(ok.actions_run, 1);
});

test('F4: a realpath that throws anything (EACCES, EIO) fails closed', async () => {
  const h = await harness({ realpath: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
  h.m.disk_pct = 97;
  const r = await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 10 } }]);
  assert.equal(r.outcome, 'approval_required'); assert.match(r.reason, /could not be verified/);
  assert.deepEqual(h.calls, []);
});

// --- F13 cleanup floor ----------------------------------------------------------------------------------------------

test('F13: default cleanup floor is one hour; below it needs approval, at it and the 24h default plan run', async () => {
  const h = await harness({ minCleanupAgeMs: null });                 // null = do not pass: module default
  h.m.disk_pct = 97;
  for (const ms of [1, 3_599_999, 3600_000.5, -3600_000, '3600000']) {
    const r = await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: ms } }]);
    assert.equal(r.actions_run, 0, String(ms)); assert.equal(r.outcome, 'approval_required');
  }
  assert.equal((await clean(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 3600_000 } }])).actions_run, 1);
  const h2 = await harness({ minCleanupAgeMs: null });               // fresh: the disk incident above is still open (dedup)
  h2.m.disk_pct = 97;
  await h2.ops.handleReport(rep({ type: 'host.disk_pressure' }));
  assert.equal(h2.calls[0].params.older_than_ms, 24 * 3600_000);
});

// --- F2 observed pressure drives the plan ---------------------------------------------------------------------------

test('F2: plan only when the reported type is observed; variants per type', async () => {
  const h = await harness();
  // service type without a service id can never be confirmed (no service reading) -> not_reproduced, no restart request
  h.m.cpu_pct = 99;
  let r = await h.ops.handleReport(rep({ type: 'service.unhealthy' }));
  assert.equal(r.outcome, 'not_reproduced'); assert.equal((await h.incidents.get(r.incident_id)).approvals.length, 0);
  // reported mem, observed cpu only -> not_reproduced; reported cpu+observed cpu -> throttle
  r = await h.ops.handleReport(rep({ type: 'host.memory_pressure' }));
  assert.equal(r.outcome, 'not_reproduced'); assert.deepEqual(h.calls, []);
  r = await h.ops.handleReport(rep({ type: 'host.cpu_pressure' }));
  assert.equal(r.actions_run, 1);
  // tmux/worktree/runner types need some observed pressure: with a healthy host they are not_reproduced
  const h2 = await harness();
  for (const type of ['tmux.resource_exhaustion', 'worktree.storage_exceeded', 'runner.starved', 'health.unknown']) {
    assert.equal((await h2.ops.handleReport(rep({ type }))).outcome, 'not_reproduced', type);
  }
  assert.equal(h2.admission.isPaused(), false);
  // explicit ops steps for an unconfirmed type do not run either
  const h3 = await harness();
  h3.m.cpu_pct = 99;
  const x = await h3.ops.execute({ type: 'host.disk_pressure', host_id: H, steps: [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 10 } }] });
  assert.equal(x.outcome, 'not_reproduced'); assert.deepEqual(h3.calls, []);
});

test('F2 (info): the ops controller may still run a confirmed incident with a cross-type allowlisted step (cpu pressure -> temp cleanup)', async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  const x = await h.ops.execute({ type: 'host.cpu_pressure', host_id: H, steps: [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 10 } }] });
  assert.equal(x.actions_run, 1);          // explicit instruction from the capability holder; allowlisted + floored + leased
});

// --- F11 reconciling gate / execute() dedup choices -------------------------------------------------------------------

async function reconciling(h) {
  h.actions.throttle_concurrency = { execute: async () => { throw new Error('half applied'); }, undo: async () => { throw new Error('undo failed'); } };
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling');
  return r.incident_id;
}

test('F11: recheck, handleReport and a keyless/replayed execute never resume or re-run a reconciling incident', async () => {
  const h = await harness();
  const id = await reconciling(h);
  h.m.cpu_pct = 20;
  assert.match((await h.ops.recheck(id)).why, /acknowledgement/);
  h.m.cpu_pct = 99;
  h.actions.throttle_concurrency = { execute: async () => { h.calls.push({ name: 'again' }); } };
  assert.equal((await h.ops.handleReport(rep())).outcome, 'linked');
  assert.equal((await h.ops.execute({ type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency' })).outcome, 'linked');
  // a new instruction on a reconciling incident waits for the owner (see the next test)
  assert.equal((await h.ops.execute({ type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', dedup_key: 'same' })).outcome, 'needs_owner_ack');
  assert.equal((await h.ops.execute({ type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', dedup_key: 'same' })).outcome, 'linked');   // replay
  assert.equal(h.admission.isPaused(), true);
});

test('F11: execute() with a NEW correlation key does not re-run actions on a reconciling incident before owner acknowledgement', async () => {
  const h = await harness();
  const id = await reconciling(h);
  h.actions.throttle_concurrency = { execute: async () => { h.calls.push({ name: 'again' }); } };
  const r = await h.ops.execute({ type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', dedup_key: 'fresh-instruction' });
  assert.equal(r.incident_id, id);
  assert.equal(r.actions_run, 0, 'action re-ran on a reconciling incident before owner acknowledgement');
});

test('F11: owner acknowledgement is the only way out of reconciling; the system-ops ack is not an owner ack', async () => {
  const h = await harness();
  const id = await reconciling(h);
  await h.incidents.acknowledge(id, { by: 'system-ops' });
  await h.incidents.acknowledge(id, { by: 'anyone', owner: 'yes' });
  await h.incidents.acknowledge(id, { by: 'anyone', owner: 1 });
  assert.equal((await h.incidents.get(id)).state, 'reconciling');
  await h.ops.ownerAcknowledge(id, { by: 'owner' });
  assert.equal((await h.incidents.get(id)).state, 'acknowledged');
  h.m.cpu_pct = 20;
  assert.equal((await h.ops.recheck(id)).resumed, true);
});

test('F11/F12: a missing executor ends reconciling (fail closed: paused, lease released, owner ack needed) and reports actions_run 0', async () => {
  const h = await harness({ actionsObject: {} });
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling'); assert.equal(r.actions_run, 0);
  assert.equal(h.admission.isPaused(), true);
  assert.equal((await h.leases.acquire(`host:${H}:maintenance`, { owner: 'x', ttl_ms: 1000 })).ok, true);
  h.m.cpu_pct = 20;
  assert.equal((await h.ops.recheck(r.incident_id)).resumed, false);
});

// --- F7 principal ---------------------------------------------------------------------------------------------------

test('F7: the requester facade is frozen and request-only; the role string on requestOperation only ever selects the facade for non-ops', async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  assert.throws(() => { h.ops.requester.execute = () => {}; }, TypeError);
  for (const role of [SYSTEM_ROLE, 'owner', { toString: () => SYSTEM_ROLE }, undefined]) {
    const r = await h.ops.requester.request({ task_id: 't', role, op: { type: 'host.cpu_pressure', host_id: H, steps: [{ action: 'throttle_concurrency', params: {} }] } });
    assert.equal(r.executed, false); assert.equal(r.state, 'mitigation_requested');
  }
  for (const role of [['system-operations'], 'System-Operations', `${SYSTEM_ROLE} `, null]) {
    const r = await h.ops.requestOperation({ task_id: 't', role, op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency' } });
    assert.equal(r.executed, false, String(role));
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.admission.isPaused(), false);
});

// --- F3 dedup --------------------------------------------------------------------------------------------------------

test('F3: canonical key ignores caller keys; distinct host/service/type stay distinct; caller key is a correlation field only', async () => {
  const h = await harness();
  h.actions.throttle_concurrency = { execute: async () => { h.calls.push({ name: 't' }); } };
  h.m.cpu_pct = 99;
  const a = await h.ops.handleReport(rep({ dedup_key: 'k1' }));
  const b = await h.ops.handleReport(rep({ dedup_key: 'k2', reporter: { reporter: 'dev-2', task_id: 'task-2' } }));
  const c = await h.ops.handleReport(rep());
  assert.equal(a.incident_id, b.incident_id); assert.equal(b.incident_id, c.incident_id);
  assert.equal(h.calls.length, 1);
  const inc = await h.incidents.get(a.incident_id);
  assert.equal(inc.dedup_key, `host.cpu_pressure:${H}:-`);
  assert.deepEqual(inc.reporters.map((x) => x.correlation_key), ['k1', 'k2', null]);
  assert.equal(inc.reporter_count, 3);
  // other host / other type / service-scoped are separate incidents
  const d = await h.ops.handleReport(rep({ host_id: 'host-b' }));
  const e = await h.ops.handleReport(rep({ type: 'host.memory_pressure' }));
  assert.equal(new Set([a.incident_id, d.incident_id, e.incident_id]).size, 3);
  // a caller key cannot be used to forge the canonical key
  const f = await h.incidents.report(rep({ host_id: 'host-c', dedup_key: `host.cpu_pressure:${H}:-` }));
  assert.equal(f.deduped, false);
});

test('F3: host ids differing only by case open separate incidents for the same host', async () => {
  const h = await harness();
  const a = await h.incidents.report(rep({ host_id: 'Host-A' }));
  const b = await h.incidents.report(rep({ host_id: 'host-a' }));
  assert.equal(b.deduped, true, 'same host, different case, two incidents');
  assert.equal(a.incident.incident_id, b.incident.incident_id);
});

test('F14: two instances on one directory now see each other through refresh(); seq stays strictly increasing', async () => {
  const dir = join(await tmp(), 'inc');
  const s1 = createIncidentStore({ dir, now: () => 1 });
  const s2 = createIncidentStore({ dir, now: () => 1 });
  await s1.init(); await s2.init();
  const a = await s1.report(rep());
  assert.equal((await s2.report(rep())).deduped, true);
  await s1.acknowledge(a.incident.incident_id, { by: 'x' });
  await s2.requestMitigation(a.incident.incident_id, { by: 'y' });
  await s1.escalate(a.incident.incident_id, { reason: 'z' });
  const seqs = (await readFile(join(dir, 'incidents.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal((await s2.get(a.incident.incident_id)).state, 'escalated');
});

// --- F5 sanitizer ----------------------------------------------------------------------------------------------------

test('F5/F1: fixed patterns hold and the scrub is linear (1 MB well under 100 ms)', () => {
  const hex64 = 'deadbeef'.repeat(8);
  const sha1 = '0123456789abcdef'.repeat(2) + '01234567';
  const s = sanitizeText(`${hex64} ${sha1} {"api_key":"short12"} Authorization: Basic dXNlcjpwYXNz --token shortsecret --api-key=k9 token = v7 bearer b8 \u001b[31m\u0007\u0000`);
  for (const bad of [hex64, 'short12', 'dXNlcjpwYXNz', 'shortsecret', 'k9', 'v7', 'b8']) assert.ok(!s.includes(bad), bad);
  assert.ok(s.includes(sha1));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s));
  const t = performance.now(); sanitizeText('z'.repeat(1_000_000)); assert.ok(performance.now() - t < 100);
  const t2 = performance.now(); sanitizeText('a@b.'.repeat(250_000)); assert.ok(performance.now() - t2 < 100);
  assert.equal(sanitizeText('word '.repeat(2000)).length, 500);
});

test('F5: this repo\'s own secret names (REPORTER_TOKEN, *_TOKEN, VAPID_PRIVATE_KEY, NTFY_TOPIC, secret_key) with short values', () => {
  const cases = ['REPORTER_TOKEN=tk_short', 'access_token=short1', 'GITHUB_TOKEN: short2', 'VAPID_PRIVATE_KEY=short3', '{"refresh_token":"short4"}', 'NTFY_TOPIC=mytopic7', 'secret_key=short11', 'PASSWORD short10'];
  for (const c of cases) {
    const v = c.match(/[=:\s"]+"?([A-Za-z0-9_]+)"?\}?$/)[1];
    assert.ok(!sanitizeText(c).includes(v), `${c} -> ${sanitizeText(c)}`);
  }
});

test('F5: C1 control characters (U+0080-U+009F, e.g. 8-bit CSI) and bidi overrides pass through', () => {
  const s = sanitizeText('x \u009b31m y ‮ z');
  assert.ok(!/[\u0080-\u009f‪-‮⁦-⁩]/.test(s));
});

test('F8: persisted details are a whitelist; nested/odd values cannot smuggle text', async () => {
  const s = createIncidentStore({ dir: await tmp() });
  const { incident } = await s.report(rep());
  await s.recordAction(incident.incident_id, { action: 'x', status: 'done', stdout: 'Bearer SECRET.T', note: { deep: 'token=SECRET2' }, reason: { toString: () => 'token=SECRET3' }, before: 'token=SECRET4', after: [{ name: 'token=SECRET5 /home/someone', value: '1', source: { a: 1 } }] });
  await s.escalate(incident.incident_id, { reason: 'ok', extra: 'token=SECRET6', owner: true });
  const raw = await readFile(s.file, 'utf8');
  for (const bad of ['SECRET.T', 'SECRET2', 'SECRET3', 'SECRET4', 'SECRET5', 'SECRET6', '/home/someone', 'stdout', 'note', 'extra']) assert.ok(!raw.includes(bad), bad);
  const inc = await s.get(incident.incident_id);
  assert.deepEqual(inc.actions[0].before, []);
  assert.equal(inc.actions[0].after[0].value, null);
  assert.equal(inc.escalation.owner, true);     // owner flag is kept (only === true)
});

// --- F6 store replay -------------------------------------------------------------------------------------------------

test('F6: corruption before the final line fails init closed (E_UNAVAILABLE), file untouched, every op rejects, retry re-reads', async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir, now: () => 1 });
  const { incident } = await s.report(rep());
  await s.acknowledge(incident.incident_id, { by: 'ops' });
  const file = join(dir, 'incidents.jsonl');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  for (const middle of ['{"garbage":', 'null', '{"kind":5,"payload":{}}', '{"kind":"incident.x","payload":"s"}', '{"kind":"incident.x","payload":{},"incident_id":7}']) {
    const body = `${lines[0]}\n${middle}\n${lines[1]}\n`;
    await writeFile(file, body);
    const s2 = createIncidentStore({ dir, now: () => 1 });
    await assert.rejects(s2.init(), { code: 'E_UNAVAILABLE' });
    await assert.rejects(s2.get(incident.incident_id), { code: 'E_UNAVAILABLE' });
    await assert.rejects(s2.report(rep({ host_id: 'host-b' })), { code: 'E_UNAVAILABLE' });
    assert.equal(await readFile(file, 'utf8'), body, middle);
  }
  await writeFile(file, `${lines[0]}\n${lines[1]}\n`);
  const s3 = createIncidentStore({ dir, now: () => 1 });
  assert.equal((await s3.get(incident.incident_id)).state, 'acknowledged');
});

test('F6: only a true tail is torn: last line without newline, or a bad final line followed by whitespace', async () => {
  for (const tail of ['{"torn":', '{"torn":1}\n', 'garbage\n\n  \n', '\n']) {
    const dir = await tmp();
    const s = createIncidentStore({ dir, now: () => 1 });
    const { incident } = await s.report(rep());
    const file = join(dir, 'incidents.jsonl');
    const good = await readFile(file, 'utf8');
    await appendFile(file, tail);
    const s2 = createIncidentStore({ dir, now: () => 1 });
    const init = await s2.init();
    assert.equal(init.torn, tail !== '\n' ? true : init.torn, JSON.stringify(tail));
    assert.equal((await s2.get(incident.incident_id)).state, 'open');
    const after = await readFile(file, 'utf8');
    assert.ok(after.startsWith(good), JSON.stringify(tail));
    const rest = after.slice(good.length).split('\n').filter(Boolean);
    assert.ok(rest.every((l) => JSON.parse(l).kind === 'recovered_torn_tail' || l === ''), JSON.stringify(rest));
    // the meta record replays harmlessly and is not an incident
    const s3 = createIncidentStore({ dir, now: () => 1 });
    assert.equal((await s3.init()).torn, false);
    assert.equal((await s3.list()).length, 1);
    assert.ok((await s3.events()).every((e) => e.kind !== 'recovered_torn_tail' || e.incident_id === null));
  }
});

test('F6: a future event kind is kept, replayed as a no-op, and survives rewrites', async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir, now: () => 1 });
  const { incident } = await s.report(rep());
  const file = join(dir, 'incidents.jsonl');
  await appendFile(file, `${JSON.stringify({ event_id: 'x', incident_id: incident.incident_id, seq: 2, ts: 1, kind: 'incident.future_kind', payload: { n: 1 } })}\n`);
  const s2 = createIncidentStore({ dir, now: () => 1 });
  await s2.acknowledge(incident.incident_id, { by: 'ops' });
  const kinds = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ['incident.opened', 'incident.future_kind', 'incident.acknowledged']);
  assert.equal((await s2.events()).find((e) => e.kind === 'incident.acknowledged').seq, 3);
});

test('F6: a shaped but semantically broken opened event fails init closed rather than half-applying', async () => {
  const dir = await tmp();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'incidents.jsonl'), `${JSON.stringify({ event_id: 'x', incident_id: 'inc-1', seq: 1, ts: 1, kind: 'incident.opened', payload: {} })}\n`);
  const s = createIncidentStore({ dir, now: () => 1 });
  await assert.rejects(s.init());
  await assert.rejects(s.list());
});

test('F6: after a failed append the torn bytes are cut before the next append; the log never carries our own garbage', async () => {
  const dir = await tmp();
  let fail = false;
  const real = await import('node:fs/promises');
  const fs = { promises: new Proxy(real, { get: (t, k) => (k === 'open' ? async (...a) => {
    const fh = await t.open(...a);
    return !fail ? fh : new Proxy(fh, { get: (f, kk) => (kk === 'writeFile' ? async (str) => { await f.writeFile(str.slice(0, 15)); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } : typeof f[kk] === 'function' ? f[kk].bind(f) : f[kk]) });
  } : t[k]) }) };
  const s = createIncidentStore({ dir, fs, now: () => 1 });
  const { incident } = await s.report(rep());
  fail = true;
  await assert.rejects(s.acknowledge(incident.incident_id, { by: 'ops' }), /ENOSPC/);
  await assert.rejects(s.escalate(incident.incident_id, { reason: 'r' }), /ENOSPC/);
  fail = false;
  await s.acknowledge(incident.incident_id, { by: 'ops' });
  const lines = (await readFile(join(dir, 'incidents.jsonl'), 'utf8')).split('\n');
  assert.equal(lines.at(-1), '');
  assert.doesNotThrow(() => lines.filter(Boolean).map((l) => JSON.parse(l)));
  assert.deepEqual(lines.filter(Boolean).map((l) => JSON.parse(l).seq), [1, 2]);
});

// --- F9 admission, F15 telemetry ---------------------------------------------------------------------------------------

test('F9: admission reasons survive prototype keys and only a plain object of objects loads as not-corrupt', async () => {
  const dir = await tmp();
  const file = join(dir, 'a.json');
  const a = createAdmissionController({ file });
  for (const r of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) { a.pause(r); assert.equal(a.isPaused(), true, r); a.resume(r); assert.equal(a.isPaused(), false, r); }
  a.pause('__proto__');
  assert.deepEqual(createAdmissionController({ file }).reasons(), ['__proto__']);
  for (const [body, paused] of [['{"reasons":{}}', false], ['{"reasons":{"x":{"at":1}}}', true], ['{"reasons":{"x":1}}', true], ['{"reasons":{"x":null}}', true], ['{"reasons":[]}', true], ['{"reasons":[{"at":1}]}', true], ['{}', true], ['null', true], ['{"reasons":{"__proto__":{"at":1}}}', true]]) {
    await writeFile(file, body);
    assert.equal(createAdmissionController({ file }).isPaused(), paused, body);
  }
});

test('F15: a probe that emits inherited-property or non-string names is a lying probe: unknown, never healthy', async () => {
  const c = () => 1_800_000_000_000;
  const ok = (n, v) => ({ name: n, value: v, unit: '%', ts: c(), source: 'p' });
  const good = [ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1)];
  const mk = (extra) => createTelemetry({ now: c, probe: async () => [...good, ...extra] });
  for (const extra of [[ok('constructor', 1)], [ok('__proto__', 1)], [ok('hasOwnProperty', 1)], [ok(5, 1)], [null], [{}]]) {
    const a = await mk(extra).assess(H);
    assert.equal(a.status, 'unknown', JSON.stringify(extra));
    assert.ok(a.unknown.includes('malformed_reading'));
    assert.ok(!a.readings.some((r) => ['constructor', '__proto__', 'hasOwnProperty'].includes(r.name)));
  }
  assert.equal((await mk([ok('junk', 1)]).assess(H)).status, 'healthy');
  assert.equal((await mk([ok('cpu_pct', 99)]).assess(H)).status, 'unhealthy');         // duplicate name: last wins, still pressure
});
