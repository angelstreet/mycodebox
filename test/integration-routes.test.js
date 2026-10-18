// The lane's HTTP API (auth, routes, long-poll, kv format) and the scripts/integrate CLI against a real server on a real lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createIntegrationLane } from '../integration-lane.js';
import { createIntegrationRoutes, describe } from '../integration-routes.js';
import { hashToken } from '../lease-routes.js';
import { isLoopback } from '../reporter.js';
import { makeWorld } from './helpers-lane.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const REPORTER = 'rep-token-0123456789abcdef', CLIENT = 'integ-token-0123456789abcdef', PLAIN = 'plain-token-0123456789abcdef';

async function boot(w, { laneOpts = {}, cfg = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'lane-api-'));
  mkdirSync(join(stateDir, 'leases'));
  const mk = (name, token, extra) => ({ name, sha256: hashToken(token), exemptAgents: [], ...extra });
  writeFileSync(join(stateDir, 'leases', 'clients.json'), JSON.stringify({ clients: [mk('mac', CLIENT, { integrate: true }), mk('plain', PLAIN, {})] }));
  const events = [];
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg(cfg) } }, notify: (r, e) => events.push({ ...e, id: r.id }), pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)), ...laneOpts }).start();
  const routes = createIntegrationRoutes({ lane, stateDir, isLoopback, reporterOk: (t) => t === REPORTER, sessionCwd: async (n) => (n === 'sess-in-dev' ? w.dev : null), remoteResolve: (n, c) => (c === 'mac' && n === 'mac:known-abc123' ? n : null) });
  const server = http.createServer((req, res) => { routes.handle(req, res).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, headers = { 'x-ghosty-reporter-token': REPORTER } } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* kv */ }
    return { status: r.status, json, text };
  };
  return { stateDir, lane, base, call, events, server, close: () => server.close() };
}
const P = '/api/integration';

test('auth: reporter token on loopback, or a bearer client flagged integrate; nothing else', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const b = await boot(w);
  try {
    assert.equal((await b.call('GET', `${P}/requests`, { headers: {} })).status, 401);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: { 'x-ghosty-reporter-token': 'wrong' } })).status, 401);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status, 401);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: { authorization: `Bearer ${PLAIN}` } })).status, 403);   // a lease client without the flag
    assert.equal((await b.call('GET', `${P}/requests`, { headers: { authorization: `Bearer ${CLIENT}` } })).status, 200);
    assert.equal((await b.call('GET', `${P}/requests`)).status, 200);
    // a peer outside loopback / tailnet is refused before the token is looked at
    const req = Object.assign(new EventEmitter(), { url: `${P}/requests`, method: 'GET', headers: { 'x-ghosty-reporter-token': REPORTER, authorization: `Bearer ${CLIENT}` }, socket: { remoteAddress: '8.8.8.8' } });
    let code = 0; const res = { writeHead: (c) => { code = c; }, end: () => {} };
    const routes = createIntegrationRoutes({ lane: b.lane, stateDir: b.stateDir, isLoopback, reporterOk: () => true });
    await routes.handle(req, res); assert.equal(code, 403);
    const req2 = Object.assign(new EventEmitter(), { url: `${P}/requests`, method: 'GET', headers: { 'x-ghosty-reporter-token': REPORTER }, socket: { remoteAddress: '100.64.1.2' } });
    await routes.handle(req2, res); assert.equal(code, 403);   // the reporter token alone never works off loopback
    // other paths are not ours
    assert.equal(await routes.handle(Object.assign(new EventEmitter(), { url: '/api/other', method: 'GET', headers: {}, socket: {} }), res), false);
  } finally { b.close(); }
});

test('dashboard: same-origin list/get/cancel need no token, cross-origin is 403, creating a request stays token-gated', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const b = await boot(w);
  try {
    const host = new URL(b.base).host;
    const same = { 'sec-fetch-site': 'same-origin' }, sameO = { origin: `http://${host}` }, cross = { origin: 'http://evil.example' };
    assert.equal((await b.call('GET', `${P}/requests`, { headers: same })).status, 200);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: sameO })).status, 200);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: cross })).status, 403);
    assert.equal((await b.call('GET', `${P}/requests`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const q = await b.call('POST', `${P}/requests`, { body: { repo: 'env-a', branch: 'feat' } });
    const id = q.json.id;
    assert.equal((await b.call('GET', `${P}/requests/${id}`, { headers: same })).status, 200);
    assert.equal((await b.call('POST', `${P}/requests`, { body: { repo: 'env-a', branch: 'feat' }, headers: sameO })).status, 401);
    assert.equal((await b.call('POST', `${P}/requests/${id}/cancel`, { body: {}, headers: cross })).status, 403);
    const c = await b.call('POST', `${P}/requests/${id}/cancel`, { body: {}, headers: sameO });
    assert.ok([200, 409].includes(c.status), String(c.status));   // 409 when the worker already took it
  } finally { b.close(); }
});

test('request -> id + position, status, long-poll wait, list filters, cancel only while queued', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' }); w.branch('feat2', { 'two.js': 'y\n' });
  let release; const gate = new Promise((r) => { release = r; });
  const b = await boot(w, { cfg: { test: 'fake' }, laneOpts: { run: async () => { await gate; return { code: 0, out: 'ok' }; } } });
  try {
    const bad = await b.call('POST', `${P}/requests`, { body: { branch: 'main' } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /is the target/);
    const a = await b.call('POST', `${P}/requests`, { body: { branch: 'feat', session: 's1', note: 'n' } });
    assert.equal(a.status, 200); assert.equal(a.json.position, 1); assert.equal(a.json.repo, 'env-a');   // the one configured repo
    const c = await b.call('POST', `${P}/requests`, { body: { branch: 'feat2', cwd: w.dev } });          // matched from the checkout's origin
    assert.equal(c.json.position, 2);
    const g = await b.call('GET', `${P}/requests/${c.json.id}`);
    assert.equal(g.json.request.state, 'queued'); assert.equal(g.json.request.position, 2);
    const pending = await b.call('GET', `${P}/requests/${a.json.id}/wait?timeout=0`);
    assert.equal(pending.json.final, false);
    assert.equal((await b.call('POST', `${P}/requests/${a.json.id}/cancel`, { body: {} })).status, 409);
    const waiting = b.call('GET', `${P}/requests/${a.json.id}/wait?timeout=30`);
    release();
    const done = (await waiting).json;
    assert.equal(done.final, true); assert.equal(done.state, 'merged'); assert.equal(done.exit, 0); assert.match(done.text, /merged feat into main at [0-9a-f]{12}/);
    const list = await b.call('GET', `${P}/requests?repo=env-a&state=merged,queued&limit=5`);
    assert.ok(list.json.requests.length >= 1);
    assert.equal((await b.call('GET', `${P}/requests?state=returned`)).json.requests.length, 0);
    assert.equal((await b.call('GET', `${P}/requests/int-nope`)).status, 404);
    assert.equal((await b.call('GET', `${P}/repos`)).json.repos[0].key, 'env-a');
  } finally { b.close(); }
});

test('cancel a queued request; repo from the session cwd; unknown repo is refused', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' }); w.branch('feat2', { 'two.js': 'y\n' });
  const b = await boot(w, { cfg: { test: 'fake' }, laneOpts: { run: () => new Promise(() => {}) } });
  try {
    await b.call('POST', `${P}/requests`, { body: { branch: 'feat' } });
    const q = await b.call('POST', `${P}/requests`, { body: { branch: 'feat2', session: 'sess-in-dev' } });
    const x = await b.call('POST', `${P}/requests/${q.json.id}/cancel`, { body: {} });
    assert.equal(x.status, 200); assert.equal(x.json.request.state, 'cancelled'); assert.equal(x.json.exit, 3);
    assert.equal((await b.call('POST', `${P}/requests`, { body: { branch: 'feat', repo: 'zzz' } })).status, 404);
    const viaClient = await b.call('POST', `${P}/requests`, { body: { branch: 'feat2', cwd: '/etc' }, headers: { authorization: `Bearer ${CLIENT}` } });
    assert.equal(viaClient.status, 200);   // a remote cwd is ignored; the single configured repo is used
    assert.equal(b.lane.get(viaClient.json.id).by, 'client:mac');
  } finally { b.close(); }
});

test('client:* requests keep a session only when it is a registered mac: one; a bare local name is dropped', async () => {
  const w = makeWorld(); w.branch('f1', { 'a.js': 'x\n' }); w.branch('f2', { 'b.js': 'x\n' }); w.branch('f3', { 'c.js': 'x\n' });
  const b = await boot(w, { cfg: { test: 'fake' }, laneOpts: { run: () => new Promise(() => {}) } });
  const hdr = { authorization: `Bearer ${CLIENT}` };
  try {
    const sess = async (branch, session) => b.lane.get((await b.call('POST', `${P}/requests`, { body: { branch, session }, headers: hdr })).json.id).session;
    assert.equal(await sess('f1', 'sess-in-dev'), null);            // a Mac tmux name must not hit a local codebox session
    assert.equal(await sess('f2', 'mac:unknown'), null);           // not registered
    assert.equal(await sess('f3', 'mac:known-abc123'), 'mac:known-abc123');
    // and a local caller keeps its session as before
    const l = await b.call('POST', `${P}/requests`, { body: { branch: 'f1', session: 'local-s', deploy: undefined } });
    assert.equal(b.lane.get(l.json.id).session, 'local-s');
  } finally { b.close(); }
});

test('describe: the one-line texts', () => {
  const r = { id: 'int-1', branch: 'feat', target: 'main', sha: 'abcdef0123456789', state: 'merged' };
  assert.equal(describe(r), 'Integration int-1: merged feat into main at abcdef012345.');
  assert.match(describe({ ...r, state: 'deployed', deployed: { version: 'v3', env: 'env-a' } }), /deployed v3 to env-a\.$/);
  assert.equal(describe({ ...r, state: 'returned', reason: 'tests red (exit 1)' }), 'Integration int-1 returned: tests red (exit 1). Fix it on your branch and run integrate request again.');
});

// ---- the CLI ----
const cli = (args, { cwd, env }) => new Promise((res) => {
  execFile('sh', [join(ROOT, 'scripts/integrate'), ...args], { cwd, env: { PATH: process.env.PATH, HOME: env.HOME, ...env }, timeout: 60000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr }));
});
async function cliWorld(w, boot_) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lane-cli-'));
  const b = boot_;
  writeFileSync(join(cfgDir, 'config'), `url = ${b.base}\n`);
  writeFileSync(join(cfgDir, 'token'), `${CLIENT}\n`); chmodSync(join(cfgDir, 'token'), 0o600);
  return { env: { HOME: cfgDir, MYCODEBOX_CONFIG_DIR: cfgDir }, cwd: w.dev };
}

test('CLI: request --wait -> merged exits 0; status and cancel work', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const b = await boot(w);
  try {
    const c = await cliWorld(w, b);
    const r = await cli(['request', 'feat', '--wait', '--note', 'with "quotes"'], c);
    assert.equal(r.code, 0, r.stdout + r.stderr); assert.match(r.stdout, /Integration int-\w+ queued for env-a \(position 1\)/); assert.match(r.stdout, /merged feat into main at/);
    const id = /Integration (int-\w+) queued/.exec(r.stdout)[1];
    assert.equal(b.lane.get(id).note, 'with "quotes"');
    assert.equal(b.lane.get(id).by, 'client:mac');
    const s = await cli(['status', id], c); assert.equal(s.code, 0); assert.match(s.stdout, /merged feat/);
    const all = await cli(['status'], c); assert.match(all.stdout, new RegExp(`${id} merged env-a feat`));
    const wt = await cli(['wait', id], c); assert.equal(wt.code, 0);
    assert.notEqual((await cli(['cancel', id], c)).code, 0);
    assert.match((await cli(['cancel', id], c)).stderr, /only a queued/);
  } finally { b.close(); }
});

test('CLI: returned exits 3 with the reason and the tail; CI red exits 4; unreachable exits 5; bad token exits 1', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const b = await boot(w, { cfg: { test: 'echo RED-OUTPUT; exit 1' } });
  try {
    const c = await cliWorld(w, b);
    const r = await cli(['request', 'feat', '--wait'], c);
    assert.equal(r.code, 3, r.stdout + r.stderr); assert.match(r.stdout, /returned: tests red \(exit 1\)/); assert.match(r.stdout, /RED-OUTPUT/); assert.match(r.stdout, /run integrate request again/);
    const noBranch = await cli(['request', 'nope', '--wait'], c); assert.equal(noBranch.code, 3); assert.match(noBranch.stdout, /does not exist/);
    const bad = await cli(['request', 'feat', '--repo', 'zzz'], c); assert.equal(bad.code, 1); assert.match(bad.stderr, /not configured/);
    writeFileSync(join(c.env.MYCODEBOX_CONFIG_DIR, 'token'), 'wrong-token-0123456789\n');
    const unauth = await cli(['status'], c); assert.equal(unauth.code, 1); assert.match(unauth.stderr, /invalid bearer/);
  } finally { b.close(); }
  const w2 = makeWorld(); w2.branch('feat', { 'new.js': 'x\n' });
  const b2 = await boot(w2, { cfg: { ci: 'github' }, laneOpts: { ci: { status: async () => 'failure' } } });
  try {
    const c = await cliWorld(w2, b2);
    const r = await cli(['request', 'feat', '--wait'], c);
    assert.equal(r.code, 4, r.stdout + r.stderr); assert.match(r.stdout, /CI red/); assert.match(r.stdout, /manager decides/);
    b2.close();
    const gone = await cli(['status'], { ...c, env: { ...c.env } });
    assert.equal(gone.code, 5); assert.match(gone.stderr, /unreachable/);
  } finally { b2.close(); }
});

test('CLI on the codebox: no config, loopback url + the reporter token file', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const b = await boot(w);
  try {
    const home = mkdtempSync(join(tmpdir(), 'lane-home-'));
    const state = join(home, 'state'); mkdirSync(state); writeFileSync(join(state, 'reporter.token'), `${REPORTER}\n`);
    const r = await cli(['request', 'feat', '--wait'], { cwd: w.dev, env: { HOME: home, MYCODEBOX_URL: b.base, GHOSTY_STATE_DIR: state, MYCODEBOX_SESSION: 'my-session' } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const id = /Integration (int-\w+)/.exec(r.stdout)[1];
    assert.equal(b.lane.get(id).session, 'my-session'); assert.equal(b.lane.get(id).by, 'loopback');
    const none = await cli(['status'], { cwd: w.dev, env: { HOME: home, MYCODEBOX_URL: b.base, GHOSTY_STATE_DIR: join(home, 'empty') } });
    assert.equal(none.code, 1); assert.match(none.stderr, /no token/);
  } finally { b.close(); }
});

test('--approved-by: the loopback reporter token or a manager client; an integrate client gets 403', async () => {
  const w = makeWorld(); w.branch('infra', { 'scripts/deploy.sh': 'echo\n' });
  const b = await boot(w, { laneOpts: { mergeEval: undefined } });
  try {
    const mgr = 'mgr-token-0123456789abcdef';
    const { writeFileSync: wf } = await import('node:fs');
    const mk = (name, token, extra) => ({ name, sha256: hashToken(token), exemptAgents: [], ...extra });
    wf(join(b.stateDir, 'leases', 'clients.json'), JSON.stringify({ clients: [mk('mac', CLIENT, { integrate: true }), mk('boss', mgr, { integrate: true, manager: true })] }));
    const body = { repo: 'env-a', branch: 'infra', approvedBy: 'manager' };
    assert.equal((await b.call('POST', `${P}/requests`, { body, headers: { authorization: `Bearer ${CLIENT}` } })).status, 403);
    const ok = await b.call('POST', `${P}/requests`, { body: { ...body, branch: 'infra' }, headers: { authorization: `Bearer ${mgr}` } });
    assert.equal(ok.status, 200);
    const lp = await b.call('POST', `${P}/requests`, { body: { repo: 'env-a', branch: 'infra', approvedBy: 'manager', note: 'again' } });
    assert.equal(lp.status, 200);
    assert.equal(b.lane.get(lp.json.id).approvedBy, 'manager');
    assert.match(b.lane.get(ok.json.id).approvedBy, /^manager \(client:boss\)$/);
    // without approvedBy an integrate client still works
    assert.equal((await b.call('POST', `${P}/requests`, { body: { repo: 'env-a', branch: 'infra' }, headers: { authorization: `Bearer ${CLIENT}` } })).status, 200);
  } finally { b.close(); }
});
