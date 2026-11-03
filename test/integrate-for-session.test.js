// integrate request --for <session>: the result (wake, pending-wake queue) goes to the named session; the requester is told too; an unknown name falls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createIntegrationNotify } from '../integration-notify.js';
import { createIntegrationRoutes } from '../integration-routes.js';
import { createIntegrationLane } from '../integration-lane.js';
import { createPendingWakes } from '../pending-wakes.js';
import { isLoopback } from '../reporter.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const REPORTER = 'rep-token-0123456789abcdef';

test('notify: the named session is woken, the requester is told too; no --for = the requester only', async () => {
  const sent = [];
  const notify = createIntegrationNotify({ status: () => ({ state: 'done' }), canSend: () => true, send: async (s, t) => { sent.push(s); } });
  const r = { id: 'int-1', session: 'manager', forSession: 'worker-a', branch: 'feat/x', target: 'main', state: 'merged', sha: 'a'.repeat(40) };
  const out = await notify(r);
  assert.deepEqual(sent, ['worker-a', 'manager'], 'named session first, then the requester');
  assert.equal(out.sent, true); assert.equal(out.also.length, 1);
  sent.length = 0;
  await notify({ ...r, id: 'int-2', forSession: undefined });
  assert.deepEqual(sent, ['manager']);
  sent.length = 0;
  await notify({ ...r, id: 'int-3', forSession: 'manager' });   // naming yourself is the same as not naming
  assert.deepEqual(sent, ['manager']);
});

test('a busy named session keeps its own pending wake (key per session), the requester is typed at once', async () => {
  const w = { t: 1000, sent: [], busy: new Set(['worker-a']) };
  const pw = createPendingWakes({ now: () => w.t, setTimer: () => ({ unref() {} }), clearTimer() {}, canSend: (s) => !w.busy.has(s), exists: () => true, send: async (s, t) => { w.sent.push(s); } });
  const notify = createIntegrationNotify({ status: () => ({ state: 'done' }), canSend: () => true, send: async (s) => { w.sent.push(`now:${s}`); },
    defer: () => false });
  // worker busy -> the real wiring defers; here canSend is per session
  const notify2 = createIntegrationNotify({ status: (s) => ({ state: w.busy.has(s) ? 'working' : 'done' }), canSend: (st) => st.state === 'done', send: async (s) => { w.sent.push(`now:${s}`); },
    defer: (s, r, text) => !!pw.add({ session: s, key: `integration:${r.id}:${r.state}:${s}`, text }).queued });
  await notify2({ id: 'int-5', session: 'manager', forSession: 'worker-a', branch: 'b', target: 'main', state: 'merged' });
  assert.deepEqual(w.sent, ['now:manager']);
  w.busy.clear(); await pw.onStop('worker-a');
  assert.deepEqual(w.sent, ['now:manager', 'worker-a']);
  void notify;
});

async function bootRoutes() {
  const seen = [];
  const lane = { repoKeys: () => ['env-a'], repoForCwd: async () => 'env-a', repoForUrl: async () => 'env-a', enqueue: (i) => { seen.push(i); return { id: 'int-x', position: 1, repo: i.repo }; } };
  const routes = createIntegrationRoutes({ lane, stateDir: tmp('for-state-'), isLoopback, reporterOk: (t) => t === REPORTER, sessionKnown: async (n) => n === 'worker-a' });
  const server = http.createServer((req, res) => { routes.handle(req, res).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/integration/requests?format=kv`, { method: 'POST', headers: { 'x-ghosty-reporter-token': REPORTER, 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'env-a', branch: 'feat', session: 'manager', ...body }) }); return r.text(); };
  return { seen, post, close: () => server.close() };
}

test('route: --for a live session is passed to the lane; an unknown or malformed name falls back and says so', async () => {
  const b = await bootRoutes();
  try {
    let out = await b.post({ forSession: 'worker-a' });
    assert.equal(b.seen.at(-1).forSession, 'worker-a'); assert.match(out, /forSession=worker-a/);
    out = await b.post({ forSession: 'ghost' });
    assert.equal(b.seen.at(-1).forSession, null); assert.match(out, /forNote=--for ghost: no such session, the result goes to the requester/);
    out = await b.post({ forSession: 'a b; rm' });
    assert.equal(b.seen.at(-1).forSession, null); assert.match(out, /forNote=/);
    out = await b.post({});
    assert.equal(b.seen.at(-1).forSession, null); assert.doesNotMatch(out, /forNote/);
  } finally { b.close(); }
});

test('lane: forSession is stored on the request, a re-request coalesces to the newest --for', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  const lane = createIntegrationLane({ stateDir: tmp('lane-for-'), config: { repos: { 'env-a': w.cfg({ settleMs: 5000 }) } }, settleQuietMs: 0, pollMs: 2, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  lane.start();
  const q = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'manager', forSession: 'worker-a' });
  assert.equal(lane.get(q.id).forSession, 'worker-a'); assert.equal(lane.get(q.id).session, 'manager');
  lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'manager', forSession: 'worker-b' });
  assert.equal(lane.get(q.id).forSession, 'worker-b');
  const q2 = lane.enqueue({ repo: 'env-a', branch: 'other-branch-missing', session: 'manager', forSession: 'bad name!' });
  assert.equal(lane.get(q2.id).forSession, null, 'a malformed name never reaches the record');
  lane.stop();
});
