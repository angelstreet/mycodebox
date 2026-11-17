// An approval claim counts for the session the request comes from, and covers the commit that was returned for approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createIntegrationLane } from '../integration-lane.js';
import { createIntegrationRoutes } from '../integration-routes.js';
import { createPeerSession, parentOf } from '../peer-session.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const mk = (w) => {
  const stateDir = tmp('lane-claim-');
  const items = [];
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg() } }, notify: () => {}, managerItem: (it) => items.push(it), journal: () => {},
    managerSessions: () => ['manager'], pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  lane.start();
  return { lane, stateDir, items };
};
const infra = { 'scripts/update_core.sh': 'echo\n' };

test('the identified session decides an approval claim, not the session named on the request', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane } = mk(w);
  const q = lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', claimant: 'worker', approvedBy: 'manager' });
  assert.equal(q.approvalIgnored, true);
  assert.equal(q.approvalRefused.session, 'worker');
  assert.equal((await lane.wait(q.id, 30000)).outcome, 'needs_approval');
  lane.stop();
});

test('a request whose session could not be identified carries no approval', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane } = mk(w);
  const q = lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', claimant: null, approvedBy: 'manager' });
  assert.equal(q.approvalIgnored, true);
  assert.equal((await lane.wait(q.id, 30000)).state, 'returned');
  lane.stop();
});

test('an identified manager session approves, whatever name the request carries', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane } = mk(w);
  const r = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'worker', claimant: 'manager', approvedBy: 'manager' }).id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(r.approvedBy, 'manager');
  lane.stop();
});

test('an approval covers the returned commit: the same tip merges', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane } = mk(w);
  const first = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'worker' }).id, 30000);
  assert.equal(first.outcome, 'needs_approval');
  const r = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', approvedBy: 'manager' }).id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(r.branchSha, first.branchSha);
  lane.stop();
});

test('an approval covers the returned commit: a tip that moved is returned for a new approval', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane, items } = mk(w);
  const first = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'worker' }).id, 30000);
  assert.equal(first.outcome, 'needs_approval');
  const before = w.main();
  w.branch('infra', { 'scripts/update_core.sh': 'echo changed\n' });   // the branch moves after it was returned
  const r = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', approvedBy: 'manager' }).id, 30000);
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.equal(r.outcome, 'needs_approval');
  assert.notEqual(r.branchSha, first.branchSha);
  assert.equal(r.approvedBy, undefined);
  assert.equal(r.approvalStale.approvedSha, first.branchSha);
  assert.equal(w.main(), before, 'nothing merged');
  assert.match(items.filter((i) => i.kind === 'merge').at(-1).text, new RegExp(`covers commit ${r.branchSha.slice(0, 12)}`));
  // approving the new tip then merges it
  const again = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', approvedBy: 'manager' }).id, 30000);
  assert.equal(again.state, 'merged', JSON.stringify(again));
  lane.stop();
});

test('an approval given before any return still merges (nothing to compare with)', async () => {
  const w = makeWorld(); w.branch('infra', infra);
  const { lane } = mk(w);
  const r = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'manager', approvedBy: 'manager' }).id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  lane.stop();
});

test('the route passes the identified session for an approval claim on the loopback token', async () => {
  const w = makeWorld(); w.branch('infra', infra); w.branch('infra2', infra);
  const { lane, stateDir } = mk(w);
  let peer = 'worker';
  const routes = createIntegrationRoutes({ lane, stateDir, isLoopback: () => true, reporterOk: (t) => t === 'tok', peerSession: async () => peer });
  const server = http.createServer((req, res) => { routes.handle(req, res).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/integration/requests`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ghosty-reporter-token': 'tok' }, body: JSON.stringify(body) })).json();
  const refused = await post({ repo: 'env-a', branch: 'infra', session: 'manager', approvedBy: 'manager' });
  assert.equal(refused.approvalIgnored, true, JSON.stringify(refused));
  peer = 'manager';
  const ok = await post({ repo: 'env-a', branch: 'infra2', session: 'manager', approvedBy: 'manager' });
  assert.equal(ok.approvalIgnored, undefined, JSON.stringify(ok));
  assert.equal((await lane.wait(ok.id, 30000)).state, 'merged');
  const plain = await post({ repo: 'env-a', branch: 'infra', session: 'worker' });   // no claim: nobody is looked up
  assert.equal(plain.ok, true);
  server.close(); lane.stop();
});

test('peerSession: the connection owner is followed up to its tmux pane', async () => {
  const stat = { 500: '500 (curl) S 400 1 1', 400: '400 (my (odd) sh) S 300 1 1', 300: '300 (bash) S 1 1 1' };
  const read = async (p) => { const pid = /\/proc\/(\d+)\/stat/.exec(p)[1]; if (!stat[pid]) throw new Error('gone'); return stat[pid]; };
  assert.equal(await parentOf(400, read), 300);
  const mkPeer = (out, panes) => createPeerSession({ read, exec: async () => out, panes: async () => panes });
  const req = { socket: { remotePort: 40000, localPort: 7777 } };
  const line = 'ESTAB 0 0 127.0.0.1:40000 127.0.0.1:7777 users:(("curl",pid=500,fd=5))';
  assert.equal(await mkPeer(line, [{ pid: 300, name: 'manager' }])(req), 'manager');
  assert.equal(await mkPeer(line, [{ pid: 999, name: 'manager' }])(req), null, 'no pane above the process');
  assert.equal(await mkPeer('', [{ pid: 300, name: 'manager' }])(req), null, 'owner not visible');
  assert.equal(await mkPeer(line, [{ pid: 300, name: 'manager' }])({ socket: {} }), null, 'no ports');
  const two = 'users:(("a",pid=500,fd=5),("b",pid=700,fd=5))';
  assert.equal(await mkPeer(two, [{ pid: 300, name: 'manager' }])(req), null, 'holders in different places');
});
