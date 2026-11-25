// Live truth of a deploy (deploy-live.js, owner 2026-11-25): "deployed" is not "live" while a leased host's restart waits for its catch-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSkipped, readSkipped, liveTruth, pendingText, claimsLive, claimMessage, createDeployLive, GRACE_MS } from '../deploy-live.js';
import { createIntegrationNotify, integrationText, integrationNotice } from '../integration-notify.js';
import { createOwnJobs } from '../own-jobs.js';
import { createDoneCheck } from '../done-check.js';
import { createIntegrationRoutes } from '../integration-routes.js';

const NOW = 1_800_000_000_000;
const catchUp = (over = {}) => ({ id: 'cu1', env: 'node1-vpt', purpose: 'catch-up for d1: skipped vpt-pi1', state: 'queued', hosts: ['vpt-pi1'],
  blocking: [{ agent: 'codebox:TASK-9', expires_at: new Date(NOW + 40 * 60000).toISOString() }], ...over });
const rec = (over = {}) => ({ env: 'node1-vpt', hosts: ['vpt-pi1'], at: NOW - 10 * 60000, ...over });
const tmpDir = (t) => { const d = mkdtempSync(join(tmpdir(), 'deploy-live-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('a deploy that skipped nothing is live; a skipped host with an active catch-up is pending with its holder and end time', () => {
  assert.equal(liveTruth({ records: [], deploys: [], now: NOW }).state, 'live');
  const t = liveTruth({ records: [rec()], deploys: [catchUp()], now: NOW });
  assert.equal(t.state, 'pending');
  assert.deepEqual(t.hosts.map((h) => [h.host, h.holder, h.catchUp]), [['vpt-pi1', 'codebox:TASK-9', 'cu1']]);
  assert.equal(pendingText(t), 'NOT live yet on vpt-pi1: restart deferred (lease codebox:TASK-9, until ~' + new Date(NOW + 40 * 60000).toISOString().slice(11, 16) + ' UTC)');
});

test('the holder falls back to the lease view; a running catch-up says so; two hosts are both named', () => {
  const t = liveTruth({ records: [rec({ hosts: ['vpt-pi1', 'vpt-mf1'] })], deploys: [catchUp({ blocking: [], hosts: ['vpt-pi1', 'vpt-mf1'] })],
    leases: [{ agent: 'deployment:nightly', resources: ['vpt-pi1/device4'], ttlLeftMin: 9, mode: 'exclusive' }, { agent: 'integration:int-x', resources: ['vpt-mf1'], mode: 'exclusive' }], now: NOW });
  assert.equal(t.hosts.find((h) => h.host === 'vpt-pi1').holder, 'deployment:nightly');
  assert.equal(t.hosts.find((h) => h.host === 'vpt-mf1').holder, null, 'the deploy lanes own agents are not a holder');
  assert.match(pendingText(t), /^NOT live yet on vpt-pi1, vpt-mf1: restart deferred \(vpt-pi1: lease deployment:nightly, until ~\d\d:\d\d UTC; vpt-mf1: waiting for its catch-up deploy cu1\)$/);
  assert.match(pendingText(liveTruth({ records: [rec()], deploys: [catchUp({ state: 'running', blocking: [] })], now: NOW })), /catch-up deploy running/);
});

test('it flips to live when the catch-up is gone; a fresh record has a grace while the catch-up is being queued; no registry = unknown', () => {
  assert.equal(liveTruth({ records: [rec()], deploys: [], now: NOW }).state, 'live');
  assert.equal(liveTruth({ records: [rec({ at: NOW - 5000 })], deploys: [], now: NOW }).state, 'pending');
  assert.equal(liveTruth({ records: [rec({ at: NOW - GRACE_MS - 1 })], deploys: [], now: NOW }).state, 'live');
  assert.equal(liveTruth({ records: [rec()], deploys: null, now: NOW }).state, 'unknown');
  assert.equal(liveTruth({ records: [rec()], deploys: [catchUp({ env: 'other-env' })], now: NOW }).state, 'live', 'another env catch-up does not hold this host');
});

test('recordSkipped / readSkipped round-trip for the deploy and the requests it closed; bad ids are refused', (t) => {
  const dir = tmpDir(t);
  assert.equal(recordSkipped(dir, ['d1', 'd2', '../x'], { env: 'e', ref: 'abc', hosts: ['vpt-pi1'], at: 5 }), true);
  assert.deepEqual(readSkipped(dir, 'd2'), { id: 'd2', env: 'e', ref: 'abc', hosts: ['vpt-pi1'], at: 5 });
  assert.equal(readSkipped(dir, '../x'), null);
  assert.equal(readSkipped(dir, 'nope'), null);
  assert.equal(recordSkipped(dir, ['d3'], { hosts: [] }), false);
});

// ---- B: the notify message ------------------------------------------------------------------------------------------------------
const REQ = { id: 'int-7', session: 'w1', branch: 'feat/x', target: 'main', state: 'deployed', sha: 'a'.repeat(40), deployId: 'd1', deployed: { id: 'd1', version: 'v9', env: 'node1-vpt', scope: 'host' } };

test('B: integrationText says NOT live yet on the host with the lease holder, and plain deployed when live', () => {
  const pending = integrationText({ ...REQ, liveTruth: liveTruth({ records: [rec()], deploys: [catchUp()], now: NOW }) });
  assert.match(pending, /NOT live yet on vpt-pi1: restart deferred \(lease codebox:TASK-9, until ~\d\d:\d\d UTC\)/);
  assert.match(pending, /STATUS: waiting: integration int-7/);
  assert.match(integrationNotice({ ...REQ, liveTruth: { state: 'pending', hosts: [] } }).title, /deployed, NOT live yet/);
  const plain = integrationText({ ...REQ, liveTruth: { state: 'live', hosts: [], skipped: [] } });
  assert.doesNotMatch(plain, /NOT live/);
  assert.match(integrationText({ ...REQ, liveTruth: { state: 'live', hosts: [], skipped: ['vpt-pi1'] } }), /now live on every host: the deferred restart of vpt-pi1 ran/);
});

test('B: notify attaches the truth, a failing truth falls back to the plain text, and a pending afterSend request carries it', async () => {
  const sent = [], after = [];
  const truth = liveTruth({ records: [rec()], deploys: [catchUp()], now: NOW });
  const notify = createIntegrationNotify({ liveTruth: async () => truth, status: () => ({ state: 'done' }), canSend: () => true, send: async (s, tx) => { sent.push(tx); }, afterSend: (s, r) => after.push(r) });
  await notify(REQ);
  assert.match(sent[0], /NOT live yet on vpt-pi1/);
  assert.equal(after[0].liveTruth.state, 'pending');
  const sent2 = [];
  const n2 = createIntegrationNotify({ liveTruth: async () => { throw new Error('registry down'); }, status: () => ({ state: 'done' }), canSend: () => true, send: async (s, tx) => { sent2.push(tx); } });
  await n2({ ...REQ, id: 'int-8' });
  assert.match(sent2[0], /int-8: merged feat\/x into main .*deployed v9 to node1-vpt/);
  assert.doesNotMatch(sent2[0], /NOT live/);
});

test('B: createDeployLive reads the record the runner wrote; GET /live and GET /requests/:id show it', async (t) => {
  const dir = tmpDir(t);
  recordSkipped(dir, ['d1'], { env: 'node1-vpt', ref: 'abc', hosts: ['vpt-pi1'], at: NOW - 10 * 60000 });
  let deploys = [catchUp()];
  const dl = createDeployLive({ dir, deploys: () => deploys, now: () => NOW });
  assert.equal((await dl.forRequest(REQ)).state, 'pending');
  assert.equal(await dl.forRequest({ ...REQ, state: 'merged' }), null);
  assert.equal(await dl.forRequest({ ...REQ, deployed: { scope: 'self' } }), null, 'ghosty self-deploy has no host');
  assert.equal((await dl.pendingOf([REQ, { ...REQ, id: 'int-9', deployId: 'dZ', deployed: { id: 'dZ' } }])).length, 1);
  const lane = { list: () => [REQ], get: () => REQ, repoKeys: () => [] };
  const routes = createIntegrationRoutes({ deployLive: dl, lane, stateDir: dir, isLoopback: () => true, reporterOk: () => true });
  const call = async (method, url) => {
    let out = null; const res = { writeHead(c) { this.code = c; }, setHeader() {}, end(b) { out = JSON.parse(b || 'null'); } };
    await routes.handle({ method, url, headers: { 'x-ghosty-reporter-token': 'x' }, socket: { remoteAddress: '127.0.0.1' }, on() {} }, res, new URL(`http://x${url}`));
    return out;
  };
  const live = await call('GET', '/api/integration/live');
  assert.equal(live?.pending?.[0]?.id, 'int-7');
  assert.match(live.pending[0].text, /NOT live yet on vpt-pi1/);
  deploys = [];   // the catch-up ran
  assert.equal((await call('GET', '/api/integration/live')).pending.length, 0);
  assert.equal((await dl.forRequest(REQ)).state, 'live');
});

// ---- C: waiting sessions are woken when it turns live; a "deployed" claim gets one push -----------------------------------------
function ownJobsHarness(truth) {
  const sent = []; let t = 1_700_000_000_000;
  const jobs = createOwnJobs({ now: () => t, procRoot: tmpdir(), table: async () => ({ children: new Map(), args: new Map() }), agentPid: async () => 10,
    integrationState: async () => REQ, liveTruth: async () => truth.v, deployState: (id) => (id === 'abcd1234' ? { state: 'done', finished: t } : null),
    stillWaiting: () => true, canSend: () => true, send: async (s, text) => { sent.push(text); }, record: async () => {}, log: () => {} });
  return { jobs, sent };
}

test('C: STATUS waiting on integration <id> is NOT woken while pending, and is woken with the live line when it flips', async () => {
  const truth = { v: { state: 'pending', hosts: [{ host: 'vpt-pi1', holder: 'codebox:TASK-9', until: NOW }], skipped: ['vpt-pi1'] } };
  const h = ownJobsHarness(truth);
  const w = await h.jobs.watch('s1', { text: 'integration int-7', stopAt: 'x' });
  assert.equal(w.kind, 'integration');
  assert.deepEqual(await h.jobs.tick(), []); assert.equal(h.sent.length, 0);
  assert.match(await h.jobs.progressOf('s1'), /deployed, NOT live yet on vpt-pi1/);
  truth.v = { state: 'live', hosts: [], skipped: ['vpt-pi1'] };
  const woke = await h.jobs.tick();
  assert.equal(woke.length, 1);
  assert.match(h.sent[0], /int-7: merged .*deployed v9.*now live on every host: the deferred restart of vpt-pi1 ran/);
  assert.deepEqual(await h.jobs.tick(), []); assert.equal(h.sent.length, 1, 'once');
});

test('C: STATUS waiting on deploy <id> follows the same truth', async () => {
  const truth = { v: { state: 'pending', hosts: [{ host: 'vpt-pi1' }], skipped: ['vpt-pi1'] } };
  const h = ownJobsHarness(truth);
  await h.jobs.watch('s2', { text: 'deploy abcd1234', stopAt: 'x' });
  assert.deepEqual(await h.jobs.tick(), []);
  truth.v = { state: 'live', hosts: [], skipped: ['vpt-pi1'] };
  assert.equal((await h.jobs.tick()).length, 1);
  assert.match(h.sent[0], /deploy abcd1234 is now live on every host/);
});

test('C: claimsLive reads "deployed / live / in prod", not a negation and not a waiting line', () => {
  assert.equal(claimsLive('Done. The fix is deployed and live in prod.\nSTATUS: done — shipped'), true);
  assert.equal(claimsLive('merged, deployed to node1-vpt\nSTATUS: done'), true);
  assert.equal(claimsLive('It is not live yet on vpt-pi1.\nSTATUS: waiting: deploy d1'), false);
  assert.equal(claimsLive('deployed (v9), restart deferred\nSTATUS: waiting: integration int-7'), false);
  assert.equal(claimsLive('merged and tested\nSTATUS: done — merged'), false);
});

function doneHarness(t, { text, pending }) {
  const dir = tmpDir(t); const sent = [], notes = [];
  const git = async (cwd, args) => { if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? '/r/.git\n' : '/r/.git\n'; if (args[0] === 'rev-parse' && args[1] === '-q') return 'abc\n'; if (args[0] === 'rev-parse') return 'main\n'; return ''; };
  const w = createDoneCheck({ stateDir: dir, git, listDone: async () => [{ name: 'w1', cwd: '/w/x', text, doneAt: Date.now() }], mode: () => 'live', log: { error() {} },
    pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 60 }), send: async (n, tx) => { sent.push([n, tx]); }, record: async () => {}, pendingLiveOf: async () => pending.v });
  return { w, sent, dir };
}

test('C: done-check pushes ONCE when the closing text claims deployed for a pending integration, then stays quiet; nothing when it is live', async (t) => {
  const truth = liveTruth({ records: [rec()], deploys: [catchUp()], now: Date.now() });
  const pending = { v: [{ id: 'int-7', deployId: 'd1', truth }] };
  const h = doneHarness(t, { text: 'Shipped: deployed to node1-vpt and live.\nSTATUS: done — int-7 deployed · closing review: docs none needed · leftovers none · unverified none · bugs: none', pending });
  await h.w.tick();
  const live = h.sent.filter((x) => /not live on vpt-pi1/.test(x[1]));
  assert.equal(live.length, 1);
  assert.match(live[0][1], /end on STATUS: waiting: deploy d1/);
  await h.w.tick();
  assert.equal(h.sent.filter((x) => /not live on vpt-pi1/.test(x[1])).length, 1, 'one push, not one per tick');
  const h2 = doneHarness(t, { text: 'deployed and live.\nSTATUS: done — x · closing review: docs none needed · leftovers none · unverified none · bugs: none', pending: { v: [] } });
  await h2.w.tick();
  assert.equal(h2.sent.filter((x) => /not live on/.test(x[1])).length, 0);
  assert.match(claimMessage([{ id: 'int-7', deployId: null, truth }]), /waiting: integration int-7/);
});
