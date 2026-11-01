// Wake on result (2026-11-01): the session that ends a turn on `STATUS: waiting: integration <id>` / a lease ticket is woken with the
// RESULT in the message, once per state change; integrate status shows the per-request timestamps and the time between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationLane } from '../integration-lane.js';
import { createIntegrationNotify, integrationText, timeline, fmtMs } from '../integration-notify.js';
import { summary } from '../integration-routes.js';
import { isNoteEvent, eventNote, noteKey } from '../lease-source.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('wake text carries id, branch, merge sha, deploy scope and the return reason', () => {
  const base = { id: 'int-1', branch: 'feat/x', target: 'main', sha: 'abcdef1234567890' };
  const dep = integrationText({ ...base, state: 'deployed', deployed: { version: 'v9', env: 'prod', scope: 'frontend' } });
  assert.match(dep, /int-1/); assert.match(dep, /feat\/x/); assert.match(dep, /abcdef123456/); assert.match(dep, /\(scope frontend\)/);
  const ret = integrationText({ ...base, state: 'returned', reason: 'tests failed', tail: 'boom' });
  assert.match(ret, /int-1 \(feat\/x\) returned: tests failed/);
  assert.match(integrationText({ ...base, state: 'deploy_failed', deployScope: 'server', reason: 'timeout' }), /server deploy failed \(timeout\)/);
});

test('notify sends the wake once per (request, state), even when the lane reports the state again', async () => {
  const sent = [];
  const notify = createIntegrationNotify({ status: () => ({ state: 'done' }), canSend: () => true, send: async (s, t) => { sent.push([s, t]); } });
  const r = { id: 'int-2', session: 'w1', branch: 'b', target: 'main', state: 'merged', sha: 'a'.repeat(40) };
  assert.equal((await notify(r)).sent, true);
  assert.equal((await notify({ ...r })).dup, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /int-2: merged b into main at a{12}/);
  await notify({ ...r, state: 'deployed', deployed: { version: 'v1', env: 'e', scope: 'server' } });   // a different state is a new wake
  assert.equal(sent.length, 2);
});

test('timeline: milestones in order and the durations between them', () => {
  const t = timeline({ createdAt: '2026-11-01T10:00:00.000Z', startedAt: '2026-11-01T10:01:00.000Z', endedAt: '2026-11-01T10:08:00.000Z',
    times: { mergedAt: '2026-11-01T10:02:00.000Z', ciDoneAt: '2026-11-01T10:05:00.000Z', deployRequestedAt: '2026-11-01T10:05:01.000Z', deployDoneAt: '2026-11-01T10:07:59.000Z', deployedAt: '2026-11-01T10:08:00.000Z' } });
  assert.deepEqual(t.events.map((e) => e.key), ['queued', 'started', 'merged', 'ci', 'deploy_requested', 'deployed']);
  const d = Object.fromEntries(t.durations.map((x) => [x.label, x.ms]));
  assert.equal(d['queue wait'], 60000); assert.equal(d.merge, 60000); assert.equal(d.CI, 180000); assert.equal(d.deploy, 178000); assert.equal(d.total, 480000);
  assert.match(t.text, /queued 10:00:00 > started 10:01:00 > merged 10:02:00 > CI done 10:05:00/);
  assert.equal(fmtMs(125000), '2m05s');
  assert.equal(timeline({}).text, '');
});

test('the lane stamps merged, CI done, deploy requested / done and deployed; a return stamps returnedAt; status exposes the timeline', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' }); w.branch('bad', { 'b.js': '2\n' });
  const deploys = { request: async () => ({ id: 'd1' }), wait: async () => ({ ok: true, version: 'v1' }) };
  const ci = { status: async () => 'success' };
  const lane = createIntegrationLane({ stateDir: tmp('lane-wake-'), config: { repos: { 'env-a': w.cfg({ ci: 'github', deploy: { env: 'env-a', defaultScope: 'server' } }) } }, deploys, ci, pollMs: 2, sleep: () => tick(1) });
  lane.start();
  const q = lane.enqueue({ repo: 'env-a', branch: 'feat', deploy: 'server' });
  const r = await lane.wait(q.id, 20000);
  assert.equal(r.state, 'deployed');
  for (const k of ['mergedAt', 'ciDoneAt', 'deployRequestedAt', 'deployDoneAt', 'deployedAt']) assert.ok(r.times[k], `times.${k}`);
  const s = summary(r);
  assert.match(s.timeline, /queued .* merged .* CI done .* deployed /);
  assert.ok(s.times.mergedAt && s.times.createdAt);
  const q2 = lane.enqueue({ repo: 'env-a', branch: 'nope-not-pushed' });
  const r2 = await lane.wait(q2.id, 20000);
  assert.equal(r2.state, 'returned'); assert.ok(r2.times.returnedAt);
  assert.ok(!r2.times.mergedAt);
  await lane.idle(); lane.stop();
});

test('a lease ticket grant wakes the waiter with the result, once; a plain grant is not a note', () => {
  const ev = { kind: 'granted', id: 'L7', ticket: 't-9', env: 'env-a', resources: ['host:h1'], agent: 'codebox:w1', session: 'w1' };
  assert.equal(isNoteEvent(ev), true);
  assert.match(eventNote(ev), /ticket t-9 was granted: lease L7 on env-a\/host:h1.*vpt-lease ticket t-9 --wait/);
  assert.equal(isNoteEvent({ ...ev, ticket: undefined }), false);
  assert.equal(eventNote({ ...ev, ticket: undefined }), null);
  assert.equal(noteKey(ev), noteKey({ ...ev }));
});
