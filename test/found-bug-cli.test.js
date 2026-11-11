// scripts/found-bug (POSIX sh + curl) against a stub /api/bugs on the real store: GHOSTY_URL, bearer token, offline queue + flush; bugClient auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createFoundBugs } from '../found-bugs.js';
import { createIntegrationRoutes } from '../integration-routes.js';
import { hashToken } from '../lease-routes.js';
import { tmp } from './helpers-tmp.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const BIN = join(ROOT, 'scripts', 'found-bug');
const TOKEN = 'bug-token-0123456789abcdef';

function run(args, env) {
  return new Promise((res) => execFile('sh', [BIN, ...args], { env: { PATH: process.env.PATH, HOME: env.HOME, ...env }, timeout: 30000 }, (e, stdout, stderr) => res({ code: e ? e.code : 0, stdout, stderr })));
}
async function stub(state, { requireToken = false } = {}) {
  const bugs = createFoundBugs({ stateDir: state }), seen = [];
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (requireToken && req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { ok: false, error: 'no' });
    if (req.method === 'POST' && req.url === '/api/bugs') { const r = await bugs.add(JSON.parse(body)); return send(r.ok ? 200 : 400, r); }
    if (req.method === 'GET' && req.url.startsWith('/api/bugs')) { res.writeHead(200); return res.end((await bugs.list()).map((b) => `${b.id}  ${b.session}: ${b.title}\n`).join('')); }
    send(404, { ok: false });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, bugs, seen, close: () => new Promise((r) => srv.close(r)) };
}

test('found-bug files over GHOSTY_URL with the bearer token and escapes quotes/newlines', async () => {
  const state = tmp('fb-state-'), home = tmp('fb-home-'), cfg = join(home, 'cfg');
  mkdirSync(cfg); writeFileSync(join(cfg, 'token'), TOKEN, { mode: 0o600 });
  const s = await stub(tmp('fb-srv-'), { requireToken: true });
  try {
    const env = { HOME: home, GHOSTY_URL: s.url, GHOSTY_STATE_DIR: state, MYCODEBOX_CONFIG_DIR: cfg, FOUND_BUG_SESSION: 'mac-test' };
    const r = await run(['--why-not-fixed', 'large', '--reason', 'r', '--title', 'A "quoted" title', '--error', 'line1\nline2 \\ back', '--blocking', 'yes', '--test'], env);
    assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /^filed bug-[0-9a-f]{8} \(blocking\)/);
    const [b] = await s.bugs.list(); assert.equal(b.title, 'A "quoted" title'); assert.equal(b.error, 'line1\nline2 \\ back'); assert.equal(b.session, 'mac-test'); assert.equal(b.test, true);
    const d = await run(['--why-not-fixed', 'large', '--reason', 'r', '--title', 'A "quoted" title'], env); assert.match(d.stdout, /already filed/);
    assert.match((await run(['list'], env)).stdout, /mac-test: A "quoted" title/);
    assert.equal((await run(['--help'], env)).code, 0);
    assert.equal(existsSync(join(state, 'found-bug-queue.jsonl')), false);
  } finally { await s.close(); }
});

test('found-bug unreachable: saves the record, prints the fallback, exits 5; the next call posts it', async () => {
  const state = tmp('fb-state-'), home = tmp('fb-home-');
  const env = { HOME: home, GHOSTY_URL: 'http://127.0.0.1:1', GHOSTY_STATE_DIR: state, MYCODEBOX_CONFIG_DIR: join(home, 'none'), FOUND_BUG_SESSION: 'mac-q' };
  const r = await run(['--why-not-fixed', 'large', '--reason', 'r', '--title', 'offline bug', '--error', 'boom'], env);
  assert.equal(r.code, 5); assert.match(r.stderr, /SAVED in .*found-bug-queue\.jsonl/); assert.match(r.stderr, /curl -sS -X POST/);
  assert.match(readFileSync(join(state, 'found-bug-queue.jsonl'), 'utf8'), /offline bug/);
  const r2 = await run(['--why-not-fixed', 'large', '--reason', 'r', '--title', 'second offline'], env); assert.equal(r2.code, 5);
  assert.equal(readFileSync(join(state, 'found-bug-queue.jsonl'), 'utf8').trim().split('\n').length, 2);
  const s = await stub(tmp('fb-srv-'));
  try {
    const f = await run(['--flush'], { ...env, GHOSTY_URL: s.url });
    assert.equal(f.code, 0, f.stderr); assert.match(f.stdout, /flushed 2 queued/);
    assert.deepEqual((await s.bugs.list()).map((b) => b.title).sort(), ['offline bug', 'second offline']);
    assert.equal(existsSync(join(state, 'found-bug-queue.jsonl')), false);
  } finally { await s.close(); }
});

test('bugClient: only an integrate client bearer token passes', () => {
  const stateDir = tmp('fb-routes-'); mkdirSync(join(stateDir, 'leases'));
  const mk = (name, t, extra) => ({ name, sha256: hashToken(t), exemptAgents: [], ...extra });
  writeFileSync(join(stateDir, 'leases', 'clients.json'), JSON.stringify({ clients: [mk('mac', TOKEN, { integrate: true }), mk('plain', 'plain-token-0123456789abcdef', {})] }));
  const r = createIntegrationRoutes({ lane: {}, stateDir, isLoopback: () => false, reporterOk: () => false });
  const req = (auth, addr = '100.64.0.5') => ({ headers: { authorization: auth }, socket: { remoteAddress: addr } });
  assert.equal(r.bugClient(req(`Bearer ${TOKEN}`)), 'mac');
  assert.equal(r.bugClient(req('Bearer plain-token-0123456789abcdef')), null);
  assert.equal(r.bugClient(req('Bearer nope-nope-nope-nope')), null);
  assert.equal(r.bugClient(req(`Bearer ${TOKEN}`, '8.8.8.8')), null);
  assert.equal(r.bugClient({ headers: {}, socket: { remoteAddress: '100.64.0.5' } }), null);
});

test('found-bug without --why-not-fixed exits 2 with the fix-it-yourself message and files nothing; --reason is required too', async () => {
  const home = tmp('fb-home-'), env = { HOME: home, GHOSTY_URL: 'http://127.0.0.1:1', GHOSTY_STATE_DIR: tmp('fb-state-'), FOUND_BUG_SESSION: 's' };
  const a = await run(['--title', 'x'], env);
  assert.equal(a.code, 2); assert.match(a.stderr, /Fix it yourself now \(small \+ you have the repro\)\. If you really cannot, re-run with --why-not-fixed/);
  const b = await run(['--title', 'x', '--why-not-fixed', 'bogus', '--reason', 'r'], env); assert.equal(b.code, 2);
  const c = await run(['--title', 'x', '--why-not-fixed', 'large'], env); assert.equal(c.code, 2); assert.match(c.stderr, /--reason/);
  const h = await run(['--help'], env); assert.match(h.stdout, /LAST RESORT/);
});
