// Mac stops get stop-state facts (remote-stops.js + stop-state.js): journalled always, answered through the hook only in live, never twice per line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { hashToken } from '../lease-routes.js';
import { tmp } from './helpers-tmp.js';

const stateDir = tmp('ghosty-ss-remote-');
Object.assign(process.env, { GHOSTY_STATE_DIR: stateDir, JEV_URL: '', JEV_API_KEY: '' });
const manager = await import('../manager.js');
const { createRemoteStops, PREFIX } = await import('../remote-stops.js');
const REMOTE = 'tok-remote-0123456789abcdef';   // leak-scan: allow (fake test token)
const leasesDir = path.join(stateDir, 'leases');
fs.mkdirSync(leasesDir, { recursive: true });
fs.writeFileSync(path.join(leasesDir, 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-a', sha256: hashToken(REMOTE), remote: true }] }));
let mode = 'dry';
const remote = createRemoteStops({ manager, dir: leasesDir, stateDir, graceMs: 1500, pollWaitMs: 600, stateMode: () => mode,
  stopFacts: async (n, { text }) => ({ bgJobs: 0, integrations: /int-1a1cc7e0de12c0e88/.test(text) ? ['int-1a1cc7e0de12c0e88'] : [], tickets: [], workers: [], timeMs: null }) });
await manager.initManager({ onOwnerNeeded: () => {}, sendKey: async (n, k) => (remote.owns(n) ? remote.deliverKey(n, k) : null), sendKeys: async (n, t) => (remote.owns(n) ? remote.deliver(n, t) : null) });
await manager.setManagerConfig({ delayMs: 250, maxPerSessionPerHour: 50 });
fs.writeFileSync(path.join(stateDir, 'remote.json'), JSON.stringify({ waitS: 10 }));
const server = http.createServer((req, res) => { remote.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${REMOTE}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
test.after(() => new Promise((r) => server.close(r)));
const DONE = 'STATUS: done — merged via int-1a1cc7e0de12c0e88 · goal: achieved · evidence: int-1a1cc7e0de12c0e88 · closing review: docs none needed · leftovers none · unverified none · bugs: none';
const post = (sid, text, extra = {}) => call('POST', '/stops', { machine: 'mac-test', project: 'demo', session_id: sid, session_name: 'ss', text, ...extra });
const journal = () => fs.readFileSync(path.join(stateDir, 'stop-state.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('dry: the Mac stop is journalled said done / computed waiting and not answered', async () => {
  const r = await post('sid-ss-1aaaa', DONE);
  assert.equal(r.status, 200);
  const j = journal().at(-1);
  assert.equal(j.said, 'done'); assert.equal(j.computed, 'waiting'); assert.equal(j.mode, 'dry');
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=1`);
  assert.notEqual(a.body.state === 'answered' && /harness sees/.test(a.body.answer || ''), true);
});
test('live: the done line is answered once through the hook with the restate message; the loop guard still holds', async () => {
  mode = 'live';
  const r = await post('sid-ss-2bbbb', DONE);
  const a = await call('GET', `/stops/${r.body.id}/answer?wait=2`);
  assert.equal(a.body.state, 'answered');
  assert.match(a.body.answer, /your STATUS says done, but the harness sees integration int-1a1cc7e0de12c0e88: that is waiting, not done/);
  const again = await post('sid-ss-2bbbb', DONE, { stop_hook_active: true });
  assert.equal(again.body.answerable, false);
});
