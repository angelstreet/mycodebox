// Independent verification of v2/10-system-ops (b5ffaac). Adversarial probes against the System Operations role:
// allowlist tricks, temp-root escapes, telemetry/admission fail-closed, role spoofing, dedup, sanitization, replay.
// A `todo: 'defect: ...'` marks a confirmed gap: the assertion states the expected behaviour and currently fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createIncidentStore, sanitizeText, INCIDENT_EVENTS } from '../orchestration/incidents.js';
import { createTelemetry } from '../orchestration/telemetry.js';
import { createSystemOps, createAdmissionController, ALLOWED_ACTIONS, SYSTEM_ROLE } from '../orchestration/system-ops.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-sysops-verify-'));
const H = 'host-a';
const SPEC_EVENTS = ['incident.opened', 'incident.acknowledged', 'incident.mitigation_requested', 'incident.approval_required', 'incident.resolved', 'incident.escalated', 'incident.unknown'];

async function harness({ actions: extra = {}, plans, incidentsDir } = {}) {
  const root = await tmp();
  const c = () => c.t; c.t = 1_800_000_000_000;
  const m = { cpu_pct: 20, mem_pct: 30, disk_pct: 40, ts: null, svc: true };
  const telemetry = createTelemetry({
    now: c, maxAgeMs: 60_000,
    probe: async () => ['cpu_pct', 'mem_pct', 'disk_pct'].map((name) => ({ name, value: m[name], unit: '%', ts: m.ts ?? c(), source: 'fake' })),
    serviceProbe: async () => ({ healthy: m.svc, ts: c(), source: 'fake-svc' }),
  });
  const incidents = createIncidentStore({ dir: incidentsDir || join(root, 'inc'), now: c });
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: join(root, 'leases'), now: c }), now: c });
  const calls = [];
  const rec = (name) => ({ execute: async (params, ctx) => { calls.push({ name, params, ctx }); } });
  const admission = createAdmissionController({ file: join(root, 'admission.json'), now: c });
  const deploys = { status: async () => ({ state: 'none' }) };
  const actions = { throttle_concurrency: rec('throttle_concurrency'), clear_v2_tmp_artifacts_older_than: rec('clear_v2_tmp_artifacts_older_than'), ...extra };
  const ops = createSystemOps({ incidents, leases, telemetry, actions, deploys, admission, now: c, stateRoot: root, plans });
  return { root, c, m, incidents, leases, calls, admission, actions, ops, tmpRoot: join(root, 'v2-tmp') };
}
const rep = (o = {}) => ({ type: 'host.cpu_pressure', host_id: H, symptom: 'cpu high', reporter: { reporter: 'dev-1', task_id: 'task-1' }, ...o });
const opsReq = (h, steps, extra = {}) => h.ops.requestOperation({ task_id: 't', role: SYSTEM_ROLE, op: { type: 'host.disk_pressure', host_id: H, dedup_key: `k-${Math.random()}`, steps, ...extra } });

// --- allowlist ----------------------------------------------------------------------------------------------------

test('verify: allowlist is exact; prototype keys, case, whitespace, arrays and objects never reach an executor', async () => {
  const h = await harness({ actions: { __proto__: null, constructor: { execute: async () => { throw new Error('ran'); } }, toString: { execute: async () => { throw new Error('ran'); } } } });
  h.m.disk_pct = 97;
  for (const action of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'Throttle_Concurrency', ' throttle_concurrency', 'throttle_concurrency\n', ['throttle_concurrency'], { toString: () => 'throttle_concurrency' }, null, 42]) {
    const r = await opsReq(h, [{ action, params: {} }]);
    assert.equal(r.outcome, 'approval_required', String(action));
    assert.equal(r.executed, false);
  }
  assert.deepEqual(h.calls, []);
  assert.ok(Object.isFrozen(ALLOWED_ACTIONS) || Array.isArray(ALLOWED_ACTIONS));
});

test('verify: a non-array `steps` from the ops role cannot execute anything', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  for (const steps of ['throttle_concurrency', 7, true]) {
    const r = await opsReq(h, steps).catch((e) => ({ outcome: 'threw', error: e }));
    assert.equal(r.executed ?? false, false, String(steps));
  }
  assert.deepEqual(h.calls, []);
});

test('verify: a step whose `action` getter changes between check and run cannot reach a non-allowlisted executor', { todo: 'defect: steps are re-read at execute time (actions[step.action]); snapshot/freeze the plan before checkStep, or restrict `actions` to ALLOWED_ACTIONS at construction' }, async () => {
  const h = await harness({ actions: { kill_session: { execute: async () => { h.calls.push({ name: 'kill_session' }); } } } });
  h.m.disk_pct = 97;
  let reads = 0;
  const step = { params: { max: 1 }, get action() { return ++reads <= 1 ? 'throttle_concurrency' : 'kill_session'; } };
  await opsReq(h, [step]);
  assert.ok(!h.calls.some((x) => x.name === 'kill_session'), 'non-allowlisted executor reached via getter');
});

// --- V2 temp root ---------------------------------------------------------------------------------------------------

test('verify: temp cleanup rejects a NOT-YET-EXISTING leaf under a symlinked parent (realpath fallback to lexical path)', { todo: 'defect: realpath() falls back to resolve() on ENOENT, so <tmpRoot>/link/new (link -> outside) passes checkStep; realpath the deepest existing ancestor and fail closed on any realpath error' }, async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  await mkdir(h.tmpRoot, { recursive: true });
  const outside = await tmp();
  await symlink(outside, join(h.tmpRoot, 'link'));
  const r = await opsReq(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { dir: join(h.tmpRoot, 'link', 'later'), older_than_ms: 1000 } }]);
  assert.deepEqual(h.calls, [], 'executor was invoked with a dir that resolves outside the V2 temp root');
  assert.match(r.reason || '', /escapes|outside/);
});

test('verify: relative, NUL and traversal dirs are refused; a relative dir is never resolved against process.cwd()', async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  await mkdir(h.tmpRoot, { recursive: true });
  for (const dir of ['../../etc', 'v2-tmp', '.', `${h.tmpRoot}/../leases`, `${h.tmpRoot}\0`, '']) {
    const r = await opsReq(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { dir, older_than_ms: 1000 } }]);
    if (dir === `${h.tmpRoot}\0` || dir === '') continue;            // handled below
    assert.equal(r.outcome, 'approval_required', JSON.stringify(dir));
  }
  assert.ok(h.calls.every((x) => !x.params.dir || (x.params.dir.startsWith(h.tmpRoot) && !x.params.dir.includes('\0'))), JSON.stringify(h.calls.map((x) => x.params.dir)));
});

test('verify: no executor ships for clear_v2_tmp_artifacts_older_than; the injected executor contract (re-check root, no symlink walk) is not enforced by system-ops', async () => {
  // Documented gap, not a defect by itself: with no executor configured the step is refused, nothing runs.
  const h = await harness();
  delete h.actions.clear_v2_tmp_artifacts_older_than;
  h.m.disk_pct = 97;
  const r = await h.ops.handleReport(rep({ type: 'host.disk_pressure' }));
  assert.equal(r.outcome, 'reconciling');
  assert.match(r.why, /no executor/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.admission.isPaused(), true);
});

test('verify: ops role may wipe the whole V2 temp root (older_than_ms: 1) with no floor', { todo: 'defect(policy): no minimum age for temp cleanup; consider a floor (e.g. >= 1h) or owner approval below it' }, async () => {
  const h = await harness();
  h.m.disk_pct = 97;
  const r = await opsReq(h, [{ action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 1 } }]);
  assert.equal(r.outcome, 'approval_required');
  assert.deepEqual(h.calls, []);
});

// --- triage: reported type vs observed pressure --------------------------------------------------------------------

test('verify: the remediation plan follows the REPORTED type, not the observed pressure (disk cleanup on a CPU-only pressure)', { todo: 'defect: handle() ignores assessment.pressures; pick the plan from observed pressures (or require the reported type to be among them), else not_reproduced' }, async () => {
  const h = await harness();
  h.m.cpu_pct = 99; h.m.disk_pct = 10;                                 // plenty of disk
  const r = await h.ops.handleReport(rep({ type: 'host.disk_pressure', symptom: 'claims disk full' }));
  assert.ok(!h.calls.some((x) => x.name === 'clear_v2_tmp_artifacts_older_than'), `temp cleanup ran on a host with 10% disk: ${JSON.stringify(r)}`);
});

test('verify: a service restart request for a HEALTHY service is raised to the owner when only an unrelated host metric is under pressure', { todo: 'defect: same root cause as above; a service.unhealthy report with service_ready ok should resolve as not_reproduced' }, async () => {
  const h = await harness();
  h.m.cpu_pct = 99; h.m.svc = true;
  const r = await h.ops.handleReport(rep({ type: 'service.unhealthy', service_id: 'api' }));
  assert.equal(r.outcome, 'not_reproduced', JSON.stringify(r));
});

// --- telemetry / admission --------------------------------------------------------------------------------------------

test('verify: telemetry never reports healthy with any required metric unknown, with probe lying about names, or with prototype names', async () => {
  const c = () => 1_800_000_000_000;
  const mk = (out) => createTelemetry({ now: c, probe: async () => out });
  const ok = (n, v) => ({ name: n, value: v, unit: '%', ts: c(), source: 'p' });
  assert.equal((await mk([ok('cpu_pct', 1), ok('mem_pct', 1)]).assess(H)).status, 'unknown');                     // disk missing
  assert.equal((await mk([ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', '5')]).assess(H)).status, 'unknown'); // string value
  assert.equal((await mk([ok('cpu_pct', 1), ok('mem_pct', 1), { ...ok('disk_pct', 5), ts: '1' }]).assess(H)).status, 'unknown');
  assert.equal((await mk({ cpu_pct: 1 }).assess(H)).status, 'unknown');                                             // not an array
  assert.equal((await mk(null).assess(H)).status, 'unknown');
  const a = await mk([ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1), ok('junk', 1), ok('__proto__', null)]).assess(H);
  assert.equal(a.status, 'unknown');                     // a null-valued prototype-named reading degrades to unknown: conservative, see next test
  assert.equal((await mk([ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1), ok('junk', 1)]).assess(H)).status, 'healthy');   // unknown names ignored
  // service with non-boolean / missing ts -> unknown
  const t = createTelemetry({ now: c, probe: async () => [ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1)], serviceProbe: async () => ({ healthy: 'yes', ts: c() }) });
  assert.equal((await t.assess(H, { service_id: 'api' })).status, 'unknown');
  const t2 = createTelemetry({ now: c, probe: async () => [ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1)], serviceProbe: async () => ({ healthy: true }) });
  assert.equal((await t2.assess(H, { service_id: 'api' })).status, 'unknown');
});

test('verify: prototype-named probe readings (constructor, __proto__) are not treated as configured metrics', { todo: 'defect(low): `r.name in limits` is true for inherited keys; use Object.hasOwn(limits, name)' }, async () => {
  const c = () => 1_800_000_000_000;
  const ok = (n, v) => ({ name: n, value: v, unit: '%', ts: c(), source: 'p' });
  const t = createTelemetry({ now: c, probe: async () => [ok('cpu_pct', 1), ok('mem_pct', 1), ok('disk_pct', 1), ok('constructor', 1), ok('hasOwnProperty', 1)] });
  const a = await t.assess(H);
  assert.ok(!a.readings.some((r) => ['constructor', 'hasOwnProperty'].includes(r.name)), JSON.stringify(a.readings.map((r) => r.name)));
});

test('verify: admission pause with a prototype-key reason silently does not pause', { todo: 'defect: createAdmissionController stores reasons in a plain object; pause("__proto__"|"constructor"|"toString") is a no-op (isPaused() stays false); use Object.create(null) or a Map' }, async () => {
  const a = createAdmissionController({});
  for (const reason of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    a.pause(reason);
    assert.equal(a.isPaused(), true, reason);
    a.resume();
  }
});

test('verify: admission state file with reasons as an array or non-object is treated as paused (fail closed)', { todo: 'defect: {"reasons":[]} and {"reasons":"x"} load as not paused; only a plain object with string keys should be accepted' }, async () => {
  const dir = await tmp();
  for (const body of ['{"reasons":[]}', '{"reasons":"x"}', '{"reasons":null}', '[]', '"str"']) {
    const file = join(dir, 'a.json');
    await writeFile(file, body);
    assert.equal(createAdmissionController({ file }).isPaused(), true, body);
  }
});

test('verify: recheck never resumes on a reading older than the incident repair or on a lease probe that cannot be released', async () => {
  const h = await harness({ actions: { throttle_concurrency: { execute: async () => {} } } });
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'approval_required');
  h.m.cpu_pct = 20; h.m.ts = h.c() - 60_001;                           // one ms past the freshness window
  assert.equal((await h.ops.recheck(r.incident_id)).resumed, false);
  assert.equal(h.admission.isPaused(), true);
  h.m.ts = h.c() - 60_000;                                             // exactly at the window: fresh
  assert.equal((await h.ops.recheck(r.incident_id)).resumed, true);
});

test('verify: recheck auto-resolves a RECONCILING incident (rollback failed) on a fresh healthy reading, hiding the failed rollback', { todo: 'defect(judgement): a reconciling incident whose rollback_failed should need owner acknowledgement before auto-resolve; recheck() currently resolves it as "recovered"' }, async () => {
  const h = await harness({ plans: { 'host.cpu_pressure': [{ action: 'throttle_concurrency', params: { max: 1 } }] } });
  h.actions.throttle_concurrency = { execute: async () => { throw new Error('half applied'); }, undo: async () => { throw new Error('undo failed too'); } };
  h.m.cpu_pct = 99;
  const r = await h.ops.handleReport(rep());
  assert.equal(r.outcome, 'reconciling');
  assert.ok((await h.incidents.get(r.incident_id)).actions.some((a) => a.status === 'rollback_failed'));
  h.m.cpu_pct = 20;
  const rc = await h.ops.recheck(r.incident_id);
  assert.equal(rc.resumed, false, 'reconciling incident with a failed rollback was auto-resolved');
  assert.notEqual((await h.incidents.get(r.incident_id)).state, 'resolved');
});

// --- role / principal -------------------------------------------------------------------------------------------------

test('verify: role is a bare string compared with ===; non-string lookalikes never execute', async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  for (const role of [['system-operations'], { toString: () => 'system-operations' }, 'System-Operations', 'system-operations ', undefined, null, Symbol.for('system-operations')]) {
    const r = await h.ops.requestOperation({ task_id: 't', role, op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency', dedup_key: `r-${Math.random()}` } }).catch((e) => ({ executed: false, threw: e.message }));
    assert.equal(r.executed, false, String(role));
  }
  assert.deepEqual(h.calls, []);
});

test('verify: anyone who can call requestOperation can pass role="system-operations" (no principal/capability object)', async () => {
  // Not a defect inside this module by itself; it is a hard requirement on the wiring: the role must never come from
  // a request body. Recorded here so the API package cannot miss it.
  const h = await harness();
  h.m.cpu_pct = 99;
  const r = await h.ops.requestOperation({ task_id: 'dev-task', role: 'system-operations', op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency' } });
  assert.equal(h.calls.length, 1, 'allowlisted action ran for a caller that merely claimed the role');
  assert.equal(r.outcome, 'approval_required');                      // throttle did not relieve the fake pressure
});

test('verify: `executed` is false even though an allowlisted action really ran (it means "mitigated", not "executed")', { todo: 'defect(low, audit): requestOperation returns executed:false after an action executed but was insufficient; report executed_actions/actions_ran separately from the outcome' }, async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  const r = await h.ops.requestOperation({ task_id: 'ops', role: SYSTEM_ROLE, op: { type: 'host.cpu_pressure', host_id: H, action: 'throttle_concurrency' } });
  assert.equal(h.calls.length, 1);
  assert.equal(r.executed, true, 'an action ran but the result says executed:false');
});

// --- dedup -------------------------------------------------------------------------------------------------------------

test('verify: a caller-chosen dedup_key defeats dedup; the same host issue remediates once per distinct key', { todo: 'defect: dedup_key is caller-controlled; derive the canonical key server-side (type:host:service) and keep the caller key only as a link/correlation field' }, async () => {
  const h = await harness();
  h.m.cpu_pct = 99;
  h.actions.throttle_concurrency = { execute: async () => { h.calls.push({ name: 'throttle_concurrency' }); } };   // pressure persists
  await h.ops.handleReport(rep({ reporter: { reporter: 'dev-1', task_id: 'task-1' }, dedup_key: 'dev1-sees-cpu' }));
  await h.ops.handleReport(rep({ reporter: { reporter: 'dev-2', task_id: 'task-2' }, dedup_key: 'dev2-sees-cpu' }));
  await h.ops.handleReport(rep({ reporter: { reporter: 'dev-3', task_id: 'task-3' } }));
  assert.equal((await h.incidents.list({ open: true })).length, 1, 'same host/type produced several open incidents');
  assert.equal(h.calls.length, 1, 'remediation ran more than once for one host issue');
});

test('verify: dedup_key collisions through sanitization link unrelated reports (conservative, but surprising)', async () => {
  const h = await harness();
  const a = await h.incidents.report(rep({ dedup_key: 'net:192.0.2.1' }));
  const b = await h.incidents.report(rep({ dedup_key: 'net:192.0.2.2', type: 'host.memory_pressure' }));
  assert.equal(b.deduped, true);                                       // both become 'net:[ip]'
  assert.equal(a.incident.incident_id, b.incident.incident_id);
});

test('verify: two store instances on the same directory do not see each other (duplicate incidents, seq collisions)', { todo: 'defect(documentation/single-instance): no cross-process dedup; document that exactly one System Operations instance may own an incident dir, or lock/re-read the log before report()' }, async () => {
  const dir = join(await tmp(), 'inc');
  const s1 = createIncidentStore({ dir, now: () => 1 });
  const s2 = createIncidentStore({ dir, now: () => 1 });
  await s1.init(); await s2.init();                                   // both running (restart overlap, two workers)
  await s1.report(rep());
  const r2 = await s2.report(rep());
  assert.equal(r2.deduped, true, 'second process opened a duplicate incident for the same dedup key');
});

// --- sanitization --------------------------------------------------------------------------------------------------------

test('verify: sanitizer gaps: bare 64-hex secrets, JSON-quoted keys, Basic auth, CLI --token, ANSI/control characters', { todo: 'defect: sanitizeText keeps 64-hex strings (openssl rand -hex 32 secrets) as "git SHAs", misses "token":"v", Basic <b64>, --token v, and leaves ESC/C0 control chars that a terminal UI would interpret' }, async () => {
  const hex64 = 'deadbeef'.repeat(8);
  assert.ok(!sanitizeText(`x-api-token ${hex64}`).includes(hex64), 'bare 64-hex kept');
  assert.ok(!sanitizeText('{"api_key":"short12secret"}').includes('short12secret'), 'JSON-quoted key value kept');
  assert.ok(!sanitizeText('Authorization: Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'), 'Basic auth kept');
  assert.ok(!sanitizeText('--token shortsecret').includes('shortsecret'), 'CLI --token kept');
  const out = sanitizeText('ANSI \u001b[31mred\u001b[0m \u0007 \u0000 end');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out), 'control characters kept');
});

test('verify: sanitizeText is superlinear on long alphanumeric runs (reporter can stall the ops process)', { todo: 'defect: the e-mail/token regexes backtrack O(n^2) on a long word and the 500-char cap is applied AFTER them; 30k chars ~ 0.8 s, 80k ~ 6 s, 1 MB ~ minutes; slice the input (e.g. 4*max) before the regex pass' }, () => {
  const t = performance.now();
  sanitizeText('z'.repeat(30_000));
  assert.ok(performance.now() - t < 200, `took ${(performance.now() - t).toFixed(0)} ms`);
});

test('verify: sanitizer handles what it claims (regression guard for the strings the author covered)', async () => {
  const s = sanitizeText('a.b@example.test 192.0.2.7 /home/someone/x ~/y token=abcd1234 Bearer abc.def ghp_ABCDEFGH12345678 sk-ABCDEFGHIJKL host.tail1234.ts.net 2001:db8::1 ' + 'Z'.repeat(40));
  for (const bad of ['example.test', '192.0.2.7', 'someone', '~/y', 'abcd1234', 'abc.def', 'ghp_', 'sk-ABC', 'tail1234', '2001:db8', 'Z'.repeat(40)]) assert.ok(!s.includes(bad), bad);
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText('word '.repeat(2000)).length, 500);                 // cap (a bare 10k-char run is one token -> [redacted])
  assert.equal(sanitizeText(12345), '12345');
});

test('verify: transition details with keys outside {reason, action, by} bypass sanitization and land in the public record', { todo: 'defect: cleanDetail spreads ...d first; whitelist the persisted detail fields (or sanitize every string value recursively)' }, async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir });
  const { incident } = await s.report(rep());
  await s.acknowledge(incident.incident_id, { by: 'ops', note: 'owner a.b@example.test token=SECRET123 at 192.0.2.9' });
  await s.recordAction(incident.incident_id, { action: 'x', status: 'done', stdout: 'Bearer SECRET.TOKEN /home/someone/private' });
  const raw = await readFile(join(dir, 'incidents.jsonl'), 'utf8');
  for (const bad of ['example.test', 'SECRET123', '192.0.2.9', 'SECRET.TOKEN', '/home/someone']) assert.ok(!raw.includes(bad), bad);
});

test('verify: reporter/task_id/evidence/action names from a hostile reporter are scrubbed and bounded', async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir });
  const dirty = 'Bearer SECRET.TOKEN ' + 'z'.repeat(600) + ' /home/someone';
  const { incident } = await s.report(rep({ reporter: { reporter: dirty, task_id: dirty }, evidence_refs: new Array(500).fill(dirty), measurements: new Array(500).fill({ name: dirty, value: 1, unit: dirty, ts: 1, source: dirty }) }));
  const raw = JSON.stringify(incident);
  assert.ok(!raw.includes('SECRET.TOKEN') && !raw.includes('/home/someone'));
  assert.equal(incident.evidence_refs.length, 50);
  assert.equal(incident.measurements.length, 50);
  assert.ok(incident.reporters[0].reporter.length <= 100 && incident.reporters[0].task_id.length <= 100);
});

// --- incident store: crash consistency and replay -------------------------------------------------------------------------

test('verify: event vocabulary contains exactly the seven spec kinds; internal kinds are marked as such', () => {
  for (const k of SPEC_EVENTS) assert.ok(INCIDENT_EVENTS.includes(k), k);
  const internal = INCIDENT_EVENTS.filter((k) => !SPEC_EVENTS.includes(k));
  assert.deepEqual(internal, ['incident.report_linked', 'incident.action_recorded', 'incident.reconciling']);
});

test('verify: a corrupt line in the MIDDLE of the log truncates all later valid history', { todo: 'defect: init() treats any unparsable/unknown-kind line as the torn tail and truncates from there, destroying later valid events; only a final line without newline (or final unparsable line) is a torn tail; anything else must fail init (E_UNAVAILABLE), never truncate' }, async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir, now: () => 1, randomId: () => 'r' });
  const { incident } = await s.report(rep());
  await s.acknowledge(incident.incident_id, { by: 'ops' });
  const file = join(dir, 'incidents.jsonl');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  await writeFile(file, `${lines[0]}\n{"garbage":\n${lines[1]}\n`);
  const s2 = createIncidentStore({ dir, now: () => 1 });
  const init = await s2.init().catch((e) => ({ error: e.code }));
  const after = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.ok(init.error || after.length === 3, `valid acknowledged event was truncated: ${after.length} lines left`);
});

test('verify: an unknown (future) event kind in the log is not silently destroyed', { todo: 'defect: same truncation path as above; forward-compatible kinds should be kept (or init should fail), not deleted' }, async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir, now: () => 1 });
  const { incident } = await s.report(rep());
  const file = join(dir, 'incidents.jsonl');
  const before = await readFile(file, 'utf8');
  await appendFile(file, `${JSON.stringify({ event_id: 'x', incident_id: incident.incident_id, seq: 2, ts: 1, kind: 'incident.future_kind', payload: {} })}\n`);
  await createIncidentStore({ dir, now: () => 1 }).init().catch(() => {});
  assert.notEqual(await readFile(file, 'utf8'), before, 'future event kind was truncated away');
});

test('verify: torn tail recovery is not recorded as an event (ARCHITECTURE ground rule: record recovered_torn_tail)', { todo: 'defect(contract): init() returns {torn:true} but persists nothing; the ground rules ask for a recovered_torn_tail record' }, async () => {
  const dir = await tmp();
  const s = createIncidentStore({ dir, now: () => 1 });
  await s.report(rep());
  await appendFile(join(dir, 'incidents.jsonl'), '{"torn":');
  const s2 = createIncidentStore({ dir, now: () => 1 });
  assert.equal((await s2.init()).torn, true);
  assert.ok((await readFile(join(dir, 'incidents.jsonl'), 'utf8')).includes('recovered_torn_tail'));
});

test('verify: a failed append leaves memory and disk consistent (no half-applied event, next writer recovers)', async () => {
  const dir = await tmp();
  let failWrites = false;
  const fs = {
    promises: new Proxy(await import('node:fs/promises'), {
      get: (t, k) => (k === 'open' ? async (...a) => {
        const fh = await t.open(...a);
        if (!failWrites) return fh;
        return new Proxy(fh, { get: (f, kk) => (kk === 'writeFile' ? async (s) => { await f.writeFile(s.slice(0, 10)); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } : typeof f[kk] === 'function' ? f[kk].bind(f) : f[kk]) });
      } : t[k]),
    }),
  };
  const s = createIncidentStore({ dir, fs, now: () => 1 });
  const { incident } = await s.report(rep());
  failWrites = true;
  await assert.rejects(s.acknowledge(incident.incident_id, { by: 'ops' }), /ENOSPC/);
  assert.equal((await s.get(incident.incident_id)).state, 'open');                 // memory not advanced
  failWrites = false;
  const s2 = createIncidentStore({ dir, now: () => 1 });
  assert.equal((await s2.init()).torn, true);
  assert.equal((await s2.get(incident.incident_id)).state, 'open');
  await s2.acknowledge(incident.incident_id, { by: 'ops' });
  assert.equal((await createIncidentStore({ dir, now: () => 1 }).get(incident.incident_id)).state, 'acknowledged');
});

test('verify: fence.check runs immediately before every action and every undo; a fenced lease stops both', async () => {
  const order = [];
  const h = await harness({ plans: { 'host.cpu_pressure': [{ action: 'throttle_concurrency', params: {} }, { action: 'clear_v2_tmp_artifacts_older_than', params: { older_than_ms: 5 } }] } });
  const realValidate = h.leases.validate;
  h.leases.validate = async (l) => { order.push('check'); return realValidate(l); };
  h.leases.fence = (ls) => ({ check: async () => { for (const l of ls) { const r = await h.leases.validate(l); if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code }); } } });
  h.actions.throttle_concurrency = { execute: async () => { order.push('exec:throttle'); }, undo: async () => { order.push('undo:throttle'); } };
  h.actions.clear_v2_tmp_artifacts_older_than = { execute: async () => { order.push('exec:clear'); throw new Error('fail'); }, undo: async () => { order.push('undo:clear'); } };
  h.m.cpu_pct = 99;
  await h.ops.handleReport(rep());
  assert.deepEqual(order, ['check', 'exec:throttle', 'check', 'exec:clear', 'check', 'undo:clear', 'check', 'undo:throttle']);
});

test('verify: deploy status is re-read per handle() but NOT before each action (deploy may start mid-plan)', async () => {
  // Observation, not a defect in this package: the deploy window is expected to be protected by the deploy lease
  // (environment:<env>:deploy) once deploy-runner adopts the lease authority. Record the current behaviour.
  let state = 'none';
  const root = await tmp();
  const c = () => 1_800_000_000_000;
  const telemetry = createTelemetry({ now: c, probe: async () => ['cpu_pct', 'mem_pct', 'disk_pct'].map((name) => ({ name, value: name === 'cpu_pct' ? 99 : 5, ts: c(), source: 'f' })) });
  const incidents = createIncidentStore({ dir: join(root, 'inc'), now: c });
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: join(root, 'l'), now: c }), now: c });
  const admission = createAdmissionController({});
  const calls = [];
  const ops = createSystemOps({
    incidents, leases, telemetry, admission, now: c, stateRoot: root, deploys: { status: async () => ({ state }) },
    plans: { 'host.cpu_pressure': [{ action: 'throttle_concurrency', params: {} }, { action: 'throttle_concurrency', params: {} }] },
    actions: { throttle_concurrency: { execute: async () => { calls.push(state); state = 'active'; } } },
  });
  await ops.handleReport(rep());
  assert.deepEqual(calls, ['none', 'active']);
});
