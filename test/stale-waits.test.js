// Owner complaint 2026-11-01 ("blocked for hours for no reason"): a session waiting on a platform run, a lease ticket or nothing at all is woken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitIds, runState, createScriptRunSource } from '../wait-ids.js';
import { createOwnJobs } from '../own-jobs.js';

const U = 'c083bd9c-1111-4222-8333-444455556666';
const T0 = Date.UTC(2026, 10, 1, 20, 40);
function harness(over = {}) {
  const sent = [], logs = [];
  let t = T0;
  const jobs = createOwnJobs({ now: () => t, send: async (s, x) => { sent.push([s, x]); }, log: (r) => logs.push(r), ...over });
  return { jobs, sent, logs, adv: (min) => { t += min * 60000; }, clock: () => t };
}

test('waitIds: uuid, cut prefix behind a run word, ticket, lease id; plain words and shas are not ids', () => {
  assert.equal(waitIds(`validation run ${U}`).script, U);
  assert.equal(waitIds('validation run c083bd9c...').script, 'c083bd9c');
  assert.equal(waitIds('execution: C083BD9C\u2026').script, 'c083bd9c');
  assert.equal(waitIds('commit c083bd9c... pushed').script, null);
  assert.equal(waitIds('lease claim ticket t-ab12cd34').ticket, 't-ab12cd34');
  assert.equal(waitIds('lease id deadbeef held').lease, 'deadbeef');
  assert.deepEqual(waitIds('waiting on the final run'), { script: null, ticket: null, lease: null });
});

test('runState: end states, running, stuck past max duration, unknown', () => {
  const now = T0;
  assert.equal(runState({ status: 'failed', completed_at: '2026-11-01T19:17:00Z', metadata: { error: 'nav failed' } }, { now }).state, 'ended');
  assert.equal(runState({ success: true, completed_at: 1793000000 }, { now }).status, 'passed');
  assert.equal(runState({ status: 'running', started_at: new Date(now - 10 * 60000).toISOString() }, { now }).state, 'running');
  const st = runState({ status: 'running', started_at: new Date(now - 200 * 60000).toISOString() }, { now, maxRunMin: 120 });
  assert.equal(st.state, 'ended'); assert.equal(st.status, 'stuck');
  assert.equal(runState(null).state, 'unknown');
});

test('script run source: GET only with the key header; full uuid -> summary route, prefix -> recent results; failures -> null', async () => {
  const calls = [];
  const fetchFn = async (url, o) => { calls.push([url, o.method, o.headers['X-API-Key']]); return { ok: true, json: async () => (url.includes('summary') ? { status: 'failed' } : { script_results: [{ id: U, status: 'failed' }] }) }; };
  const src = createScriptRunSource({ jevUrl: 'http://fake.invalid:1/server/ai/decide', apiKey: 'k', teamId: 'team', fetchFn });
  assert.equal((await src(U)).status, 'failed');
  assert.equal((await src('c083bd9c')).id, U);
  assert.ok(calls.every((c) => c[1] === 'GET' && c[2] === 'k'));
  assert.match(calls[0][0], /^http:\/\/fake\.invalid:1\/server\/run-management\/summary\/script\//);
  assert.equal(await createScriptRunSource({ fetchFn })(U), null);
  assert.equal(await createScriptRunSource({ jevUrl: 'http://x.invalid', apiKey: 'k', teamId: 't', fetchFn: async () => { throw new Error('down'); } })(U), null);
});

test('a waiting session is woken when its script run ended FAILED (the TASK195 case), with the state, time and message', async () => {
  let row = { status: 'running', started_at: new Date(T0 - 30 * 60000).toISOString() };
  const h = harness({ scriptRun: async () => row });
  const r = await h.jobs.watch('mi', { text: `validation run ${U}`, stopAt: 's' });
  assert.equal(r.kind, 'script');
  assert.deepEqual(await h.jobs.tick(), []);
  row = { status: 'failed', completed_at: '2026-11-01T19:17:00Z', metadata: { error: 'edge home failed' } };
  const w = await h.jobs.tick();
  assert.equal(w.length, 1);
  assert.equal(h.sent[0][1], `your run ${U} ended failed at 19:17 UTC (edge home failed), continue`);
  assert.equal(h.logs.find((l) => l.type === 'own_job_wake').kind, 'script');
  assert.deepEqual(await h.jobs.tick(), [], 'woken once');
});

test('a run stuck "running" past the max duration wakes the session as stuck', async () => {
  const h = harness({ maxRunMin: 60, scriptRun: async () => ({ status: 'running', started_at: new Date(T0 - 90 * 60000).toISOString() }) });
  await h.jobs.watch('mi', { text: `run ${U}`, stopAt: 's' });
  await h.jobs.tick();
  assert.match(h.sent[0][1], /ended stuck/);
});

test('lease ticket: waiting stays quiet; granted / dropped wakes with what happened', async () => {
  let st = { state: 'waiting' };
  const h = harness({ leaseState: async () => st });
  assert.equal((await h.jobs.watch('a', { text: 'lease claim ticket t-ab12cd34', stopAt: 's' })).kind, 'lease');
  assert.deepEqual(await h.jobs.tick(), []);
  st = { state: 'granted', leaseId: 'cafe0123' };
  await h.jobs.tick();
  assert.match(h.sent[0][1], /ticket t-ab12cd34 was granted at \d\d:\d\d UTC \(lease cafe0123\), continue/);
  const h2 = harness({ leaseState: async () => ({ state: 'gone' }) });
  await h2.jobs.watch('b', { text: 'ticket t-ab12cd34', stopAt: 's' }); await h2.jobs.tick();
  assert.match(h2.sent[0][1], /no longer queued/);
});

test('a returned or cancelled integration wakes the session (lane outcome text), a running one does not', async () => {
  let r = { id: 'int-abc1', state: 'running', step: 'tests' };
  const h = harness({ integrationState: async () => r });
  await h.jobs.watch('i', { text: 'integration int-abc1', stopAt: 's' });
  assert.deepEqual(await h.jobs.tick(), []);
  r = { id: 'int-abc1', state: 'returned', reason: 'tests failed', finishedAt: T0 };
  assert.equal((await h.jobs.tick()).length, 1);
  const h2 = harness({ integrationState: async () => ({ id: 'int-abc2', state: 'cancelled', finishedAt: T0 }) });
  await h2.jobs.watch('j', { text: 'integration int-abc2', stopAt: 's' });
  assert.equal((await h2.jobs.tick()).length, 1);
  assert.match(h2.sent[0][1], /int-abc2/);
});

test('staleness sweep: quiet 20+ min, nothing alive, nothing pending -> one nudge, then at most one per 30 min; never when a job is alive, idle too short or a draft', async () => {
  let idle = 5 * 60000, draft = false, kids = false;
  const h = harness({ idleMs: () => idle, canSend: () => !draft, agentPid: async () => (kids ? 10 : null),
    table: async () => ({ children: new Map([[10, [11]]]), args: new Map([[11, 'python score_matrix.py']]) }) });
  await h.jobs.watch('s1', { text: 'waiting on the final score_matrix run', stopAt: 's' });
  h.adv(25); idle = 5 * 60000;
  assert.deepEqual(await h.jobs.tick(), [], 'pane produced output 5 min ago');
  idle = 25 * 60000; draft = true;
  assert.deepEqual(await h.jobs.tick(), [], 'draft in the input box');
  draft = false; kids = true;
  assert.deepEqual(await h.jobs.tick(), [], 'a child process is alive');
  kids = false;
  assert.equal((await h.jobs.tick()).length, 1);
  assert.equal(h.sent[0][1], 'nothing you wait on is still running: check the result and continue');
  assert.equal(h.logs.filter((l) => l.type === 'own_job_stale_nudge').length, 1);
  h.adv(10); assert.deepEqual(await h.jobs.tick(), [], 'within 30 min');
  h.adv(25); assert.equal((await h.jobs.tick()).length, 1, 'after 30 min');
});

test('staleness sweep: skips sessions that moved on, never while the awaited id is still pending, covers a run the platform cannot find', async () => {
  let waiting = true;
  const h = harness({ idleMs: () => 60 * 60000, stillWaiting: () => waiting, scriptRun: async () => ({ status: 'running', started_at: new Date(T0).toISOString() }) });
  await h.jobs.watch('p', { text: `run ${U}`, stopAt: 's' });
  h.adv(30);
  assert.deepEqual(await h.jobs.tick(), [], 'the run is still pending');
  const h2 = harness({ idleMs: () => 60 * 60000, stillWaiting: () => waiting, scriptRun: async () => null });
  await h2.jobs.watch('q', { text: `run ${U}`, stopAt: 's' });
  h2.adv(30); waiting = false;
  assert.deepEqual(await h2.jobs.tick(), [], 'acknowledged / moved on');
  const h3 = harness({ idleMs: () => 60 * 60000, scriptRun: async () => null });
  await h3.jobs.watch('r', { text: `run ${U}`, stopAt: 's' });
  h3.adv(30);
  assert.equal((await h3.jobs.tick()).length, 1, 'status unreadable and the pane is quiet: nudge');
});
