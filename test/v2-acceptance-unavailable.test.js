// T08: a source, provider or status feed that cannot be read is reported as unavailable/blocked (waiting), never as
// "nothing to do", an empty result or success. Goal-loop level with fake runtimes and a real adapter pointed at a
// missing binary; plus the status sources the release gates depend on (remote CI, telemetry, lease authority).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAdapter as claudeAdapter } from '../orchestration/adapters/claude.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { remoteStatus, ciPasses } from '../orchestration/ci-gates.js';
import { createTelemetry } from '../orchestration/telemetry.js';
import { createLeaseAuthority, fakeBackend } from '../orchestration/lease-authority.js';
import { sandbox, world, states, loopDecisions, devRuns, fail, APPROVE } from './fixtures/v2-world.js';

const sb = sandbox('v2-acc-unavail-');
const neverDone = (v) => { assert.ok(!states(v).includes('accepted')); assert.notEqual(v.outcome, 'done'); assert.equal(v.verdicts.length, 0); };

test('T08: every runtime unavailable (a real adapter whose CLI is missing, a fake whose probe says down) -> waiting(no_route), not an empty success', async () => {
  const REG = { version: 1, as_of: '2026-10-11', models: [
    { runtime: 'claude', provider: 'anthropic', model: 'stub-claude', tier: 'strong', capabilities: ['text', 'code'], efforts: ['low'], context_tokens: 100000, latency_ms: 1 },
    { runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'standard', capabilities: ['text', 'code'], efforts: ['low'], context_tokens: 100000, latency_ms: 1, test_only: true },
  ] };
  const missing = claudeAdapter({ bin: path.join(sb.TMP, 'no-such-dir', 'claude'), env: { PATH: '/nonexistent', HOME: sb.HOME } });
  assert.equal((await missing.probeCapabilities()).available, false, 'missing binary probes as unavailable');
  const down = fakeAdapter({ allowedRoots: [sb.TMP] });
  const env = world(sb, { registry: REG, adapters: () => ({ claude: missing, fake: { ...down, probeCapabilities: async () => ({ available: false }) } }) });
  const task = await env.submit();
  const r = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(v.outcome, 'waiting');
  const d = loopDecisions(v, 'no_route')[0];
  assert.equal(d.loop.patch.wait.reason, 'no_route');
  assert.ok(d.evidence.some((e) => /unavailable/.test(e)), 'the reason names the unavailable runtimes');
  assert.equal(devRuns(env, task.task_id).length, 0);
  assert.deepEqual(v.evidence, []);
  assert.equal(v.usage_totals.usd, null, 'no usage recorded is unknown, not $0');
  neverDone(v);
  // Time alone changes nothing (no blind retry); an input change (owner resume) re-checks and still reports waiting.
  env.advance(24 * 3600_000);
  for (let i = 0; i < 3; i++) assert.equal((await env.loop.step(task.task_id)).transitioned, false);
  assert.equal(loopDecisions(await env.view(task.task_id), 'no_route').length, 1);
  await env.loop.resume(task.task_id, { actor: { role: 'owner', id: 'owner-1' }, reason: 'retry after installing a runtime' });
  assert.equal((await env.loop.run(task.task_id, { until: ['waiting'] })).state, 'waiting');
  for (let i = 0; i < 4 && loopDecisions(await env.view(task.task_id), 'no_route').length < 2; i++) await env.loop.step(task.task_id);
  assert.equal(loopDecisions(await env.view(task.task_id), 'no_route').length, 2, 're-checked on the new input, still unavailable');
  neverDone(await env.view(task.task_id));
});

test('T08: the only allowed provider disappears mid-task -> waiting with backoff, the failure recorded, no fallback outside the allowlist, never success', async () => {
  const env = world(sb, { dev: [fail('mcode: command not found', 127)], rev: [APPROVE] });
  const task = await env.submit({ model_allowlist: ['dev-a'] });
  const r = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  assert.equal(v.outcome, 'waiting');
  const evs = env.events(task.task_id);
  assert.equal(evs.find((e) => e.kind === 'tool.failed').payload.error.class, 'unavailable');
  const fb = loopDecisions(v, 'provider_fallback')[0];
  assert.equal(fb.chosen, 'backoff and retry the same runtime');
  assert.ok(devRuns(env, task.task_id).every((x) => x.entry === 'fake:dev-a'), 'never routed outside the allowlist');
  assert.deepEqual(v.evidence, []);
  neverDone(v);
});

test('T08: the source repository or its base commit cannot be read -> waiting(evidence_unavailable), not "nothing changed"', async () => {
  const env = world(sb);
  const task = await env.submit({ base_sha: 'f'.repeat(40) });
  const r = await env.loop.run(task.task_id, { until: ['waiting'] });
  assert.equal(r.state, 'waiting');
  const v = await env.view(task.task_id);
  const d = loopDecisions(v, 'inspect_failed')[0];
  assert.equal(d.loop.patch.wait.reason, 'evidence_unavailable');
  assert.equal(devRuns(env, task.task_id).length, 0);
  neverDone(v);
  // The repository vanishes entirely under a second task: same answer.
  const t2 = await env.submit();
  fs.rmSync(path.join(env.repo.dir, '.git'), { recursive: true, force: true });
  assert.equal((await env.loop.run(t2.task_id, { until: ['waiting'] })).state, 'waiting');
  assert.equal(loopDecisions(await env.view(t2.task_id), 'inspect_failed').length, 1);
  neverDone(await env.view(t2.task_id));
});

test('T08: status sources behind the gates fail closed: unreachable CI is unknown (never success), unreachable telemetry is unknown (never healthy), an unavailable lease authority grants nothing', async () => {
  for (const ci of [{ status: () => { throw new Error('ECONNREFUSED'); } }, { status: () => new Promise(() => {}) }, { status: () => undefined }, { status: () => ({}) }]) {
    const s = await remoteStatus(ci, 'a'.repeat(40), { timeoutMs: 50 });
    assert.ok(['unknown', 'missing'].includes(s.status), JSON.stringify(s));
    assert.equal(ciPasses(s.status), false);
  }
  assert.equal((await remoteStatus(null, 'a'.repeat(40))).status, 'missing');
  const tel = createTelemetry({ probe: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } });
  const a = await tel.assess('host-a');
  assert.equal(a.status, 'unknown');
  assert.ok(a.readings.every((x) => x.value === null && x.status === 'unknown'));
  const empty = createTelemetry({ probe: async () => [] });
  assert.equal((await empty.assess('host-a')).status, 'unknown', 'an empty sample is not "no pressure"');
  const auth = createLeaseAuthority({ backend: fakeBackend({ fail: 'unavailable' }), opTimeoutMs: 50, alert: () => {} });
  const l = await auth.acquire('repo:demo:integration', { owner: 'x', ttl_ms: 1000, scope: 't' });
  assert.deepEqual([l.ok, l.code], [false, 'E_UNAVAILABLE']);
});
