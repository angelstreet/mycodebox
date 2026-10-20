// Round 11 decision (a): 'central-through-ssh' is the legacy path under a truthful name, and the in-process lease service is never
// mistaken for the authority (it refuses writes and reads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes, hashToken, PREFIX } from '../lease-routes.js';
import { createLeaseSource, normAuthority } from '../lease-source.js';
import { viewHtml } from '../public/leases-view.js';
import { tmp } from './helpers-tmp.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const rows = [{ id: 'a1', env: 'env-a', resource: 'frontend', agent: 'codebox:dev1', purpose: 'ui', kind: 'host', ttlLeftMin: 50 }];
const store = () => { const s = { calls: 0, get: async () => { s.calls++; return { ok: true, leases: rows, waiters: [] }; }, peek: () => ({ ok: true, leases: rows, waiters: [] }) }; return s; };
const mk = (authority, st) => createLeaseSource({ authority, legacy: { store: st, registry: 'REG' }, getService: () => { throw new Error('the in-process service must not be read'); }, now: () => NOW });
const tmpdir = () => tmp('lease-cssh-');

test('normAuthority: three labels, anything else is legacy', () => {
  assert.deepEqual(['legacy', 'central-through-ssh', 'central', 'x', undefined].map(normAuthority), ['legacy', 'central-through-ssh', 'central', 'legacy', 'legacy']);
});

test('source: central-through-ssh reads and acts exactly like legacy (same registry store and deploy registry), only the label differs', async () => {
  const sl = store(), sc = store();
  const L = mk('legacy', sl), C = mk('central-through-ssh', sc);
  assert.equal(C.authority(), 'legacy'); assert.equal(C.label(), 'central-through-ssh'); assert.equal(L.label(), 'legacy');
  assert.deepEqual(await C.get(true), await L.get(true));
  assert.deepEqual(C.peek(), L.peek());
  assert.equal(C.deployRegistry(), 'REG'); assert.equal(C.acts(), true);
  const lv = await L.view(), cv = await C.view();
  const { authority: la, inProcessService: li, ...lrest } = lv, { authority: ca, inProcessService: ci, ...crest } = cv;
  assert.deepEqual(crest, lrest); assert.equal(la, 'legacy'); assert.equal(ca, 'central-through-ssh');
  assert.equal(ci.authority, false); assert.match(ci.note, /not the authority/);
  assert.equal(C.peekView().authority, 'central-through-ssh');
  assert.equal(sc.calls, sl.calls);
  for (const f of [() => C.ownerRelease('x'), () => C.ownerMode('x', 'pin')]) assert.deepEqual(await f(), await { legacy: L }.legacy[f.toString().includes('Release') ? 'ownerRelease' : 'ownerMode']('x', 'pin'));
  assert.equal(await C.sessionStatus('s', 'working'), false);   // nothing goes to the service
  const bad = mk('central-through-ssh', { get: async () => ({ ok: false, error: 'ssh down' }), peek: () => null });
  assert.deepEqual(await bad.view(), { ok: false, error: 'ssh down', authority: 'central-through-ssh' });
});

test('view: reports central-through-ssh and says the in-process service is not the authority; legacy keeps its label', async () => {
  const v = await mk('central-through-ssh', store()).view();
  const h = viewHtml(v, { now: NOW });
  assert.match(h, /central-through-ssh/); assert.match(h, /not the authority/); assert.doesNotMatch(h, /legacy registry/); assert.doesNotMatch(h, /data-lv-act/);
  assert.match(h, /read-only: release a lease on the registry host/);
  const hl = viewHtml(await mk('legacy', store()).view(), { now: NOW });
  assert.match(hl, /legacy registry/);
  assert.match(viewHtml({ ok: false, error: 'ssh down', authority: 'central-through-ssh' }), /central-through-ssh authority; treated as busy/);
});

test('in-process service with notAuthority refuses every write with E_NOT_AUTHORITY naming the real authority; reads are refused too, status and shadow stay open', async () => {
  const dir = tmpdir();
  const svc = createLeaseService({ dir, config: { envs: ['env-a'], notAuthority: { authority: 'the registry host service' } } });
  const refused = (r) => r.ok === false && r.code === 'E_NOT_AUTHORITY' && /not the authority; the registry host service is/.test(r.error);
  assert.ok(refused(await svc.claim({ env: 'env-a', resources: ['frontend'], agent: 'a' })));
  for (const [name, f] of [['ticket', () => svc.ticket('T1')], ['cancelTicket', () => svc.cancelTicket('T1')], ['release', () => svc.release({ id: 'x' })], ['renew', () => svc.renew({ id: 'x' })],
    ['heartbeat', () => svc.heartbeat({ id: 'x' })], ['narrow', () => svc.narrow({ id: 'x' })], ['setMode', () => svc.setMode({ id: 'x', mode: 'pin' })], ['ownerRelease', () => svc.ownerRelease({ id: 'x' })],
    ['importLegacy', () => svc.importLegacy({})], ['deploy.request', () => svc.deploy.request({ env: 'env-a' })], ['deploy.approve', () => svc.deploy.approve({ id: 'x' })],
    ['deploy.start', () => svc.deploy.start({ id: 'x' })], ['deploy.finish', () => svc.deploy.finish({ id: 'x' })], ['deploy.cancel', () => svc.deploy.cancel({ id: 'x' })]]) assert.ok(refused(await f()), name);
  // reads too: an empty store would answer "free" while the registry holds leases
  for (const [name, f] of [['list', () => svc.list({})], ['check', () => svc.check({ env: 'env-a', resources: ['frontend'] })], ['get', () => svc.get('x')], ['events', () => svc.events({})],
    ['deploy.list', () => svc.deploy.list({})], ['deploy.wait', () => svc.deploy.wait({})], ['deploy.last', () => svc.deploy.last({})]]) assert.ok(refused(await f()), name);
  const st = await svc.status(); assert.equal(st.authority, false); assert.match(st.authorityNote, /not the authority/);
  // the shadow store is a separate store and keeps working (clients in shadow mode report to it)
  assert.equal((await svc.shadow.op('claim', { env: 'env-a', resources: ['frontend'], agent: 'a' })).ok, true);
  assert.equal((await svc.shadow.report({ machine: 'host-1', command: 'claim', legacy: { code: 0 }, central: { code: 0 } })).ok, true);
  assert.equal((await svc.shadow.list()).ok, true);
  // default (no config): still the authority, as before
  const on = createLeaseService({ dir: tmpdir(), config: { envs: ['env-a'] } });
  assert.equal((await on.claim({ env: 'env-a', resources: ['frontend'], agent: 'a' })).ok, true);
  assert.equal((await on.status()).authority, true);
});

test('HTTP: a claim or read against the non-authority in-process service answers 409 E_NOT_AUTHORITY', async () => {
  const dir = tmpdir(); const TOKEN = 'tok-box-0123456789abcdef';   // leak-scan: allow (fake test token)
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify({ clients: [{ name: 'box', sha256: hashToken(TOKEN) }] }));
  const service = createLeaseService({ dir, config: { envs: ['env-a'], notAuthority: { authority: 'the registry host service' } } });
  const routes = createLeaseRoutes({ service, dir });
  const server = http.createServer((req, res) => { routes.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  try {
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const r = await post('/claim', { env: 'env-a', resources: ['frontend'], agent: 'codebox:x' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'E_NOT_AUTHORITY'); assert.match(r.body.error, /registry host service/);
    const rd = await fetch(base + '/check?env=env-a&resources=frontend', { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(rd.status, 409); assert.equal((await rd.json()).code, 'E_NOT_AUTHORITY');
    const s = await (await fetch(base + '/status', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(s.authority, false);
    const sh = await post('/claim', { env: 'env-a', resources: ['frontend'], agent: 'codebox:x', shadow: true });
    assert.equal(sh.status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});
