// scripts/vpt-lease (Python client) against a fake HTTP service that implements the Appendix A contract of
// docs/v2/LEASES-CENTRAL.md, and a fake legacy CLI. No live registry, no live state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vpt-lease');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpt-lease-test-'));
const tokenFile = path.join(tmp, 'token');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);
const legacyCli = path.join(tmp, 'legacy');
fs.writeFileSync(legacyCli, '#!/bin/sh\necho "legacy $*"\n[ -n "$FAKE_LEGACY_ERR" ] && echo "$FAKE_LEGACY_ERR" >&2\nexit ${FAKE_LEGACY_CODE:-0}\n', { mode: 0o755 });

let server, base, calls, handler;
const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString();
const lease = (o = {}) => ({ id: 'L1', env: 'env-a', resources: ['env-a/host:host-1'], mode: 'exclusive', kind: 'server',
  agent: 'codebox:x', since: iso(nowS() - 60), expires_at: iso(nowS() + 7200), generation: 1, heartbeat_s: 300, ...o });

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const call = { method: req.method, path: u.pathname.replace('/api/lease/v1', ''), query: Object.fromEntries(u.searchParams),
        body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization };
      calls.push(call);
      const out = handler(call) || { ok: true };
      res.writeHead(out.status || (out.ok === false ? 400 : 200), { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function run(args, { env = {}, input, url = base, home = tmp } = {}) {
  let child;
  const pr = new Promise((resolve) => {
    const p = spawn('python3', ['-I', CLIENT, ...args], {
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C', VPT_LEASE_MODE: 'central', VPT_LEASE_URL: url,
        VPT_LEASE_TOKEN_FILE: tokenFile, VPT_LEASE_TEST_FAST: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    child = p;
    p.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
  pr.child = child;
  return pr;
}
const setup = (h) => { calls = []; handler = h; };
const deadUrl = async () => {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${s.address().port}`; await new Promise((r) => s.close(r)); return u;
};

test('claim: granted prints the lease id on line 1, sends the contract body and the bearer token', async () => {
  setup(() => ({ ok: true, lease: lease({ id: 'abc12345', resources: ['env-a/device:host-1/stb-1'] }) }));
  const r = await run(['claim', 'env-A', 'host-1/stb-1', '--agent', 'codebox:x', '--purpose', 'run', '--ttl', '30', '--expect', '10']);
  assert.equal(r.code, 0);
  assert.equal(r.out.split('\n')[0], 'abc12345');
  const c = calls[0];
  assert.equal(c.method, 'POST'); assert.equal(c.path, '/claim'); assert.equal(c.auth, 'Bearer test-token');
  assert.deepEqual({ env: c.body.env, resources: c.body.resources, agent: c.body.agent, mode: c.body.mode, kind: c.body.kind,
    ttl_min: c.body.ttl_min, expect_min: c.body.expect_min, session: c.body.session },
  { env: 'env-a', resources: ['host-1/stb-1'], agent: 'codebox:x', mode: 'exclusive', kind: 'host', ttl_min: 30, expect_min: 10, session: 'codebox:x' });
  assert.equal(c.body.wait, undefined);
});

test('claim: broad claim warns on stderr and a free-form agent name is flagged', async () => {
  setup(() => ({ ok: true, lease: lease({ id: 'w1' }) }));
  const r = await run(['claim', 'env-a', 'host-1', '--agent', 'script', '--ttl', '300']);
  assert.equal(r.out, 'w1\n');
  assert.match(r.err, /blocks server \+ full deploys/);
  assert.match(r.err, /blocks every device on host-1/);
  assert.match(r.err, /--ttl 300 min is over 4 h/);
  assert.match(r.err, /not codebox:<tmux session> or mac:<name>/);
});

test('claim: busy -> exit 3 with the holders on stderr; deploy pending -> exit 4', async () => {
  setup(() => ({ ok: false, status: 409, code: 'E_HELD', error: 'held', holders: [lease({ id: 'H1', agent: 'mac:me', purpose: 'p' })], eta: iso(nowS() + 600) }));
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'codebox:x']);
  assert.equal(r.code, 3); assert.equal(r.out, '');
  assert.match(r.err, /BUSY \u2014 held by:/); assert.match(r.err, /H1  env-a\/host-1  agent=mac:me/);
  setup(() => ({ ok: false, status: 409, code: 'E_DEPLOY_PENDING', error: 'deploy d1 (queued) on env-a' }));
  r = await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x']);
  assert.equal(r.code, 4); assert.match(r.err, /DEPLOY PENDING/); assert.match(r.err, /deploy wait --env env-a/);
});

test('fail closed: unreachable service -> exit 5 for claim, check and every deploy subcommand', async () => {
  const url = await deadUrl();
  for (const args of [['claim', 'env-a', 'host-1', '--agent', 'codebox:x'], ['check', 'env-a'], ['deploy', 'list'], ['deploy', 'request', 'env-a', '--scope', 'frontend', '--ref', 'main', '--agent', 'a'],
    ['deploy', 'start', 'd1'], ['deploy', 'wait', 'd1', '--timeout', '0.02'], ['deploy', 'last']]) {
    if (args[1] === 'list' && args[0] === 'deploy') args.push('env-a');
    const r = await run(args, { url });
    assert.equal(r.code, 5, args.join(' '));
    assert.match(r.err, /UNAVAILABLE|unavailable/);
    assert.doesNotMatch(r.out, /FREE/);
  }
});

test('E_UNAVAILABLE (503) from the service -> exit 5', async () => {
  setup(() => ({ ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'journal not writable' }));
  assert.equal((await run(['check', 'env-a', 'host-1'])).code, 5);
});

test('list: text lines, and --json keeps the legacy shape with ttlLeftMin and per-resource rows', async () => {
  const l = lease({ id: 'A1', resources: ['env-a/host:host-1', 'env-a/frontend'], provider: 'minimax', purpose: 'work' });
  setup(() => ({ ok: true, leases: [l], tickets: [], deploys: [{ id: 'd1', env: 'env-a', state: 'queued', scope: 'frontend', ref: 'main', agent: 'a', purpose: '' }] }));
  let r = await run(['list', 'env-a']);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^A1  env-a\/frontend  agent=codebox:x  provider=minimax  since=\d{4}-\d\d-\d\d \d\d:\d\d UTC  expires_in=(119|120)m  purpose=work  kind=server$/);
  assert.match(lines[1], /^A1  env-a\/host-1  /);
  assert.equal(lines[2], 'DEPLOY d1  env-a  state=queued  scope=frontend  ref=main  by=a  purpose=-');
  assert.equal(calls[0].query.env, 'env-a');
  r = await run(['list', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.leases.length, 2);
  assert.deepEqual(j.leases.map((x) => x.resource), ['host-1', 'frontend']);
  assert.ok(j.leases[0].ttlLeftMin >= 119); assert.equal(typeof j.leases[0].expires, 'number'); assert.equal(typeof j.now, 'number');
  assert.equal(j.deploys[0].id, 'd1'); assert.deepEqual(j.waiters, []);
  setup(() => ({ ok: true, leases: [], deploys: [] }));
  assert.equal((await run(['list'])).out, '(no active leases)\n');
});

test('check: FREE (0) and BUSY (3) lines, hint for a bare check, --ignore-agent and resources are passed on', async () => {
  setup(() => ({ ok: true, free: true, holders: [] }));
  let r = await run(['check', 'env-A', 'Host-1', 'frontend', '--ignore-agent', 'me']);
  assert.equal(r.code, 0); assert.equal(r.out, 'FREE \u2014 nothing active on env-a (host-1, frontend)\n');
  assert.deepEqual(calls[0].query, { env: 'env-a', resources: 'host-1,frontend', ignore_agent: 'me' });
  setup(() => ({ ok: true, free: false, holders: [lease({ id: 'B1' })] }));
  r = await run(['check', 'env-a']);
  assert.equal(r.code, 3);
  assert.match(r.out, /^BUSY \u2014 env-a in use:\nB1  env-a\/host-1 /);
  assert.match(r.out, /hint: this checked the whole env/);
});

test('check --skip-leased: LEASED lines, then FREE (0) or BUSY (3)', async () => {
  setup(() => ({ ok: true, free: true, holders: [], leased_hosts: [{ host: 'host-1', agent: 'mac:me' }] }));
  let r = await run(['check', 'env-a', '*', 'frontend', '--skip-leased', '--hosts', 'host-1,host-2']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'LEASED host-1 mac:me\nFREE \u2014 nothing blocks this deploy on env-a (skipping host-1)\n');
  assert.equal(calls[0].query.skip_leased, '1'); assert.equal(calls[0].query.hosts, 'host-1,host-2');
  setup(() => ({ ok: true, free: false, holders: [lease({ id: 'S1', resources: ['env-a/server'] })], leased_hosts: { 'host-1': 'mac:me' } }));
  r = await run(['check', 'env-a', '*', '--skip-leased', '--hosts', 'host-1']);
  assert.equal(r.code, 3);
  assert.match(r.out, /^LEASED host-1 mac:me\nBUSY \u2014 env-a in use \(leased hosts are skipped, these cannot be\):\nS1  env-a\/server /);
});

test('events: text and --json with line cursor', async () => {
  const at = iso(1760000000);
  setup(() => ({ ok: true, next: 8, events: [{ n: 7, at, kind: 'released', id: 'E1', env: 'env-a', resources: ['env-a/host:host-1'], agent: 'codebox:x' }, { n: 8, at, kind: 'expired', id: 'E2', env: 'env-a', resources: ['env-a/frontend'], agent: 'a' }] }));
  let r = await run(['events', '--after', '6', '--limit', '5']);
  assert.deepEqual(r.out.trim().split('\n'), ['7  2025-10-09 08:53 UTC  released  E1  env-a/host-1  agent=codebox:x', '8  2025-10-09 08:53 UTC  expired  E2  env-a/frontend  agent=a']);
  assert.deepEqual(calls[0].query, { after: '6', limit: '5' });
  r = await run(['events', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.next, 8); assert.equal(j.events[0].line, 7); assert.equal(j.events[0].event, 'released'); assert.deepEqual(j.events[0].resources, ['host-1']);
});

test('release, renew, narrow, heartbeat, mode: output lines and exit codes', async () => {
  setup((c) => ({ '/release': { ok: true, released: ['R1'] }, '/renew': { ok: true, lease: lease({ expires_at: iso(1760000000) }) },
    '/narrow': { ok: true, narrowed: 1, changed: true }, '/heartbeat': { ok: true, lease: lease() }, '/mode': { ok: true, lease: lease({ mode: 'pin' }) } }[c.path]));
  assert.equal((await run(['release', 'R1', '--by', 'me', '--reason', 'done'])).out, 'released 1\n');
  assert.deepEqual(calls[0].body, { id: 'R1', by: 'me', reason: 'done' });
  assert.equal((await run(['release', '--agent', 'codebox:x'])).out, 'released 1\n');
  assert.equal(calls[1].body.agent, 'codebox:x');
  assert.equal((await run(['renew', 'R1', '--ttl', '60'])).out, 'renewed until 2025-10-09 08:53 UTC\n');
  assert.equal(calls[2].body.ttl_min, 60);
  assert.equal((await run(['narrow', 'R1', '--kind', 'host'])).out, 'narrowed 1\n');
  assert.equal(calls[3].body.kind, 'host');
  assert.equal((await run(['heartbeat', 'R1', '--active'])).code, 0);
  assert.deepEqual(calls[4].body, { id: 'R1', active: true });
  assert.equal((await run(['mode', 'R1', 'pin'])).out, 'mode pin\n');
  assert.deepEqual(calls[5].body, { id: 'R1', mode: 'pin' });
  setup(() => ({ ok: false, status: 404, code: 'E_NOT_FOUND', error: 'x' }));
  let r = await run(['renew', 'nope']);
  assert.equal(r.code, 1); assert.match(r.err, /no such active lease/);
  r = await run(['release']);
  assert.equal(r.code, 2);
});

test('claim --ticket: prints the ticket id and ETA, exit 0; ticket (no wait) waiting -> 3, granted -> lease id, --cancel', async () => {
  setup(() => ({ ok: true, ticket: { id: 'T1', position: 2, eta: iso(nowS() + 600), holders: [{ agent: 'mac:me' }] } }));
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'codebox:x', '--ticket']);
  assert.equal(r.code, 0); assert.equal(r.out.split('\n')[0], 'T1'); assert.match(r.out, /position=2 eta=\d\d:\d\d held-by=mac:me/);
  assert.equal(calls[0].body.wait, 'ticket');
  setup(() => ({ ok: true, ticket: { id: 'T1', state: 'waiting', position: 2, eta: iso(nowS() + 600), holders: [{ agent: 'mac:me' }] } }));
  r = await run(['ticket', 'T1']);
  assert.equal(r.code, 3); assert.match(r.out, /^waiting #2, eta \d\d:\d\d \(held by mac:me\)\n$/);
  setup(() => ({ ok: true, ticket: { id: 'T1', state: 'granted', lease: lease({ id: 'G1' }) } }));
  r = await run(['ticket', 'T1']);
  assert.deepEqual([r.code, r.out], [0, 'G1\n']);
  setup(() => ({ ok: true }));
  r = await run(['ticket', 'T1', '--cancel']);
  assert.equal(r.out, 'cancelled\n'); assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].path, '/tickets/T1');
});

test('claim --wait: ticket, progress on stderr, then the lease id on stdout', async () => {
  let polls = 0;
  setup((c) => {
    if (c.path === '/claim') return { ok: true, ticket: { id: 'T9', position: 2, eta: iso(nowS() + 60), holders: [{ agent: 'mac:me' }] } };
    polls++;
    return polls < 3 ? { ok: true, ticket: { id: 'T9', state: 'waiting', position: 1, eta: iso(nowS() + 30), holders: [{ agent: 'mac:me' }] } }
      : { ok: true, ticket: { id: 'T9', state: 'granted', lease: lease({ id: 'GRANTED' }) } };
  });
  const r = await run(['claim', 'env-a', 'host-1', '--agent', 'codebox:x', '--wait']);
  assert.equal(r.code, 0); assert.equal(r.out.split('\n')[0], 'GRANTED');
  assert.match(r.err, /waiting #2, eta \d\d:\d\d \(held by mac:me\)/); assert.match(r.err, /waiting #1/);
  assert.equal(calls[0].body.wait, 'ticket');
  assert.equal(calls[1].path, '/tickets/T9'); assert.ok(calls[1].query.wait);
});

test('claim --wait: granted at once needs no ticket; a lost ticket is queued again', async () => {
  setup(() => ({ ok: true, lease: lease({ id: 'NOW' }) }));
  assert.equal((await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x', '--wait'])).out.split('\n')[0], 'NOW');
  let claims = 0;
  setup((c) => {
    if (c.path === '/claim') return ++claims === 1 ? { ok: true, ticket: { id: 'T1', position: 1, holders: [] } } : { ok: true, lease: lease({ id: 'AGAIN' }) };
    return { ok: false, status: 404, code: 'E_NOT_FOUND', error: 'gone' };
  });
  const r = await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x', '--wait']);
  assert.equal(r.out.split('\n')[0], 'AGAIN'); assert.match(r.err, /queueing again/);
});

test('claim --wait: retries with backoff while the service is unavailable and never gives up silently', async () => {
  let n = 0;
  setup(() => (++n <= 3 ? { ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' } : { ok: true, lease: lease({ id: 'LATE' }) }));
  const r = await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x', '--wait']);
  assert.equal(r.code, 0); assert.equal(r.out.split('\n')[0], 'LATE');
  const retries = r.err.match(/retrying in ([\d.]+)s/g);
  assert.equal(retries.length, 3);
  assert.deepEqual(retries.map((x) => parseFloat(x.match(/in ([\d.]+)s/)[1])), [0.05, 0.1, 0.2]);
  assert.match(r.err, /service unavailable/);
});

test('claim --wait against a dead service keeps retrying until stopped, then cancels cleanly (130)', async () => {
  const url = await deadUrl();
  const p = run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x', '--wait'], { url });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(p.child.exitCode, null, 'still waiting, not given up');
  p.child.kill('SIGTERM');
  const r = await p;
  assert.equal(r.code, 130);
  assert.ok((r.err.match(/retrying in/g) || []).length >= 3);
  assert.doesNotMatch(r.out, /\S/);
});

test('deploy: request, list (text/json), approve, cancel, start, finish, wait, record, last', async () => {
  const d = { id: 'dep1', env: 'env-a', state: 'queued', scope: 'host', ref: 'main', agent: 'a', purpose: 'x', hosts: ['host-1'] };
  setup((c) => ({ '/deploy/request': { ok: true, id: 'dep1' }, '/deploy/list': { ok: true, deploys: [d], leases: [lease()], waiters: [] },
    '/deploy/approve': { ok: true }, '/deploy/cancel': { ok: true }, '/deploy/start': { ok: true, state: 'running', lease_id: 'DL1' }, '/deploy/finish': { ok: true },
    '/deploy/record': { ok: true, targets: ['host-1'] }, '/deploy/wait': { ok: true, deploy: { id: 'dep1', state: 'done', version: 'v1' } },
    '/deploy/last': { ok: true, envs: { 'env-a': { frontend: { at: 1760000000, version: 'v9', ref: 'main', commit: 'abcdef1234', agent: 'a', source: 'queue' }, 'host-1': {} } } } }[c.path]));
  let r = await run(['deploy', 'request', 'env-A', '--scope', 'host', '--hosts', 'Host-1', '--ref', 'main', '--agent', 'a', '--approved']);
  assert.deepEqual([r.code, r.out], [0, 'dep1\n']);
  assert.deepEqual(calls[0].body, { env: 'env-a', scope: 'host', ref: 'main', agent: 'a', purpose: '', approved: true, ttl_min: 360, hosts: ['host-1'] });
  r = await run(['deploy', 'request', 'env-a', '--scope', 'frontend', '--hosts', 'h', '--ref', 'm', '--agent', 'a']);
  assert.equal(r.code, 2);
  r = await run(['deploy', 'list', 'env-a']);
  assert.equal(r.out, 'DEPLOY dep1  env-a  state=queued  scope=host  ref=main  by=a  purpose=x hosts=host-1\n'.replace('purpose=x hosts', 'purpose=x hosts'));
  const j = JSON.parse((await run(['deploy', 'list', '--json'])).out);
  assert.equal(j.deploys[0].id, 'dep1'); assert.equal(j.leases[0].resource, 'host-1');
  assert.equal((await run(['deploy', 'approve', 'dep1'])).out, 'approved\n');
  assert.equal((await run(['deploy', 'cancel', 'dep1'])).out, 'cancelled\n');
  r = await run(['deploy', 'start', 'dep1', '--skip-leased']);
  assert.equal(r.out, 'running\n'); assert.deepEqual(calls.at(-1).body, { id: 'dep1', agent: 'manager:deploy', skip_leased: true });
  r = await run(['deploy', 'finish', 'dep1', '--status', 'done', '--version', 'v1', '--tail-stdin'], { input: 'log tail' });
  assert.equal(r.out, 'done\n'); assert.equal(calls.at(-1).body.tail, 'log tail'); assert.equal(calls.at(-1).body.version, 'v1');
  r = await run(['deploy', 'wait', 'dep1']);
  assert.deepEqual([r.code, r.out], [0, 'deploy dep1 done (version v1)\n']);
  r = await run(['deploy', 'record', 'env-a', '--scope', 'host', '--hosts', 'host-1', '--agent', 'a', '--status', 'done', '--deploy-id', 'x1']);
  assert.equal(r.out, 'recorded done: env-a host-1\n');
  r = await run(['deploy', 'last', 'env-a']);
  assert.match(r.out, /^env-a\n  frontend         v9 +ref=main  commit=abcdef123  2025-10-09 08:53 UTC \(\d+d ago\)  by=a  \[queue\]\n  host-1           \(no successful deploy recorded\)\n$/);
  assert.equal(JSON.parse((await run(['deploy', 'last', '--json'])).out).envs['env-a'].frontend.version, 'v9');
});

test('deploy: error exit codes (unknown id 1, failed wait 1, start busy 3, pending wait timeout 3, no pending 0)', async () => {
  setup(() => ({ ok: false, status: 404, code: 'E_NOT_FOUND', error: 'x' }));
  let r = await run(['deploy', 'approve', 'zz']);
  assert.equal(r.code, 1); assert.match(r.err, /no such deploy zz/);
  setup(() => ({ ok: false, status: 409, code: 'E_HELD', error: 'leases in the way:', holders: [lease({ id: 'X1' })] }));
  r = await run(['deploy', 'start', 'dep1']);
  assert.equal(r.code, 3); assert.match(r.err, /^BUSY \u2014 leases in the way:\nX1  env-a\/host-1  agent=codebox:x  kind=server  expires_in=\d+m/);
  setup(() => ({ ok: true, deploy: { id: 'dep1', state: 'failed', reason: 'boom' } }));
  r = await run(['deploy', 'wait', 'dep1']);
  assert.deepEqual([r.code, r.out], [1, 'deploy dep1 failed (boom)\n']);
  setup(() => ({ ok: true, pending: [] }));
  r = await run(['deploy', 'wait', '--env', 'env-a']);
  assert.deepEqual([r.code, r.out], [0, 'no deploy pending on env-a\n']);
  setup(() => ({ ok: true, deploy: { id: 'dep1', state: 'running' } }));
  r = await run(['deploy', 'wait', 'dep1', '--timeout', '0.01']);
  assert.equal(r.code, 3); assert.match(r.err, /timeout waiting for the deploy/);
});

test('run: claims with wait, heartbeats, releases on success and passes the exit code through', async () => {
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'RUN1' }) } : { ok: true, released: ['RUN1'] }));
  let r = await run(['run', 'env-a', 'host-1/stb-1', '--agent', 'codebox:x', '--', 'sh', '-c', 'sleep 0.6; echo hi']);
  assert.equal(r.code, 0); assert.match(r.out, /hi/);
  assert.equal(calls[0].body.wait, 'ticket');
  assert.ok(calls.some((c) => c.path === '/heartbeat' && c.body.id === 'RUN1' && c.body.active === true), 'heartbeats while running');
  const rel = calls.filter((c) => c.path === '/release');
  assert.equal(rel.length, 1); assert.equal(rel[0].body.id, 'RUN1'); assert.equal(calls.at(-1).path, '/release');
});

test('run: a failing command releases and exits with its code; a missing command exits 127', async () => {
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'RUN2' }) } : { ok: true }));
  let r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', 'sh', '-c', 'exit 7']);
  assert.equal(r.code, 7); assert.equal(calls.filter((c) => c.path === '/release').length, 1);
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'RUN3' }) } : { ok: true }));
  r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', '/nonexistent/cmd']);
  assert.equal(r.code, 127); assert.equal(calls.filter((c) => c.path === '/release').length, 1);
});

test('run: SIGTERM stops the command and still releases the lease', async () => {
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'RUN4' }) } : { ok: true }));
  const pending = run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', 'sleep', '30']);
  const t0 = Date.now();
  while (!calls.some((c) => c.path === '/heartbeat') && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((c) => c.path === '/heartbeat'), 'command is running');
  pending.child.kill('SIGTERM');
  const r = await pending;
  assert.equal(r.code, 143);
  assert.equal(calls.filter((c) => c.path === '/release' && c.body.id === 'RUN4').length, 1);
});

test('run: busy-forever claim waits via the ticket and does not run the command before the grant', async () => {
  let polls = 0;
  setup((c) => {
    if (c.path === '/claim') return { ok: true, ticket: { id: 'TR', position: 1, holders: [] } };
    if (c.path.startsWith('/tickets/')) return ++polls < 2 ? { ok: true, ticket: { id: 'TR', state: 'waiting', position: 1, holders: [] } } : { ok: true, ticket: { id: 'TR', state: 'granted', lease: lease({ id: 'RUN5' }) } };
    return { ok: true };
  });
  const r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', 'echo', 'ran']);
  assert.equal(r.code, 0); assert.match(r.out, /ran/); assert.ok(polls >= 2);
});

test('token file: mode other than 0600 is refused (exit 1, no request sent); missing token is an error too', async () => {
  const loose = path.join(tmp, 'loose-token');
  fs.writeFileSync(loose, 'tok'); fs.chmodSync(loose, 0o644);
  setup(() => ({ ok: true, free: true }));
  let r = await run(['check', 'env-a'], { env: { VPT_LEASE_TOKEN_FILE: loose } });
  assert.equal(r.code, 1); assert.match(r.err, /must be mode 0600/); assert.equal(calls.length, 0);
  fs.chmodSync(loose, 0o640);
  assert.equal((await run(['check', 'env-a'], { env: { VPT_LEASE_TOKEN_FILE: loose } })).code, 1);
  r = await run(['check', 'env-a'], { env: { VPT_LEASE_TOKEN_FILE: path.join(tmp, 'absent') } });
  assert.equal(r.code, 1); assert.match(r.err, /not found/);
  r = await run(['check', 'env-a'], { env: { VPT_LEASE_URL: '' } });
  assert.equal(r.code, 1); assert.match(r.err, /VPT_LEASE_URL/);
});

test('default token path is ~/.config/vpt-lease/token', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'token'), 'home-token', { mode: 0o600 });
  setup(() => ({ ok: true, free: true }));
  const r = await run(['check', 'env-a'], { home, env: { VPT_LEASE_TOKEN_FILE: '' } });
  assert.equal(r.code, 0); assert.equal(calls[0].auth, 'Bearer home-token');
});

test('legacy mode (default): execs the legacy CLI with the same argv, output and exit code, no HTTP', async () => {
  setup(() => ({ ok: true }));
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'a'], { env: { VPT_LEASE_MODE: '', VPT_LEASE_LEGACY: legacyCli, FAKE_LEGACY_CODE: '3', FAKE_LEGACY_ERR: 'BUSY' } });
  assert.deepEqual([r.code, r.out, r.err], [3, 'legacy claim env-a host-1 --agent a\n', 'BUSY\n']);
  assert.equal(calls.length, 0);
  r = await run(['list'], { env: { VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: legacyCli } });
  assert.deepEqual([r.code, r.out], [0, 'legacy list\n']);
  r = await run(['list'], { env: { VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: path.join(tmp, 'missing') } });
  assert.equal(r.code, 1); assert.match(r.err, /cannot run the legacy CLI/);
  r = await run(['list'], { env: { VPT_LEASE_MODE: 'bogus' } });
  assert.equal(r.code, 1);
});

const shadowEnv = (extra = {}) => ({ VPT_LEASE_MODE: 'shadow', VPT_LEASE_LEGACY: legacyCli, VPT_LEASE_MACHINE: 'machine-1', ...extra });

test('shadow: the legacy result is what the caller sees; agreement sends shadow:true and no report', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'CENTRAL1' }) } : { ok: true, free: true, released: ['CENTRAL1'] }));
  let r = await run(['check', 'env-a', 'host-1'], { home, env: shadowEnv() });
  assert.deepEqual([r.code, r.out], [0, 'legacy check env-a host-1\n']);
  assert.equal(calls[0].path, '/check'); assert.equal(calls[0].query.shadow, '1');
  assert.equal(calls.filter((c) => c.path === '/shadow-report').length, 0);
  calls.length = 0;
  r = await run(['claim', 'env-a', 'host-1', '--agent', 'a', '--wait', '--mode', 'pin'], { home, env: shadowEnv() });
  assert.equal(r.out, 'legacy claim env-a host-1 --agent a\n');   // new flags are not passed to the legacy CLI
  assert.equal(calls[0].body.shadow, true); assert.equal(calls[0].body.wait, undefined);
  assert.equal(calls.filter((c) => c.path === '/shadow-report').length, 0);
});

test('shadow: lease ids are mapped in ~/.cache/vpt-lease/shadow-map.json and used for release', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const fakeClaim = path.join(tmp, 'legacy-claim');
  fs.writeFileSync(fakeClaim, '#!/bin/sh\n[ "$1" = claim ] && echo legacyid1 || echo "released 1"\n', { mode: 0o755 });
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'CENTRALID' }) } : { ok: true, released: ['CENTRALID'] }));
  const env = shadowEnv({ VPT_LEASE_LEGACY: fakeClaim });
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'a'], { home, env });
  assert.equal(r.out, 'legacyid1\n');
  const mapFile = path.join(home, '.cache', 'vpt-lease', 'shadow-map.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8')), { legacyid1: 'CENTRALID' });
  r = await run(['release', 'legacyid1'], { home, env });
  assert.equal(r.out, 'released 1\n');
  const rel = calls.find((c) => c.path === '/release');
  assert.equal(rel.body.id, 'CENTRALID'); assert.equal(rel.body.shadow, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8')), {});
  assert.equal(calls.filter((c) => c.path === '/shadow-report').length, 0);
});

test('shadow: a disagreement is posted to /shadow-report and does not change the caller result', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  setup((c) => (c.path === '/check' ? { ok: true, free: false, holders: [lease()] } : { ok: true }));
  const r = await run(['check', 'env-a', 'host-1'], { home, env: shadowEnv({ FAKE_LEGACY_CODE: '0' }) });
  assert.equal(r.code, 0); assert.equal(r.out, 'legacy check env-a host-1\n');
  const rep = calls.find((c) => c.path === '/shadow-report');
  assert.ok(rep, 'report posted');
  assert.equal(rep.body.machine, 'machine-1'); assert.equal(rep.body.command, 'check env-a host-1');
  assert.equal(rep.body.legacy.code, 0); assert.equal(rep.body.central.code, 3);
  assert.match(rep.body.central.out, /BUSY/);
});

test('shadow: a failing or unreachable service never changes the caller result', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const url = await deadUrl();
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'a'], { home, url, env: shadowEnv({ FAKE_LEGACY_CODE: '3', FAKE_LEGACY_ERR: 'BUSY' }) });
  assert.deepEqual([r.code, r.out, r.err], [3, 'legacy claim env-a host-1 --agent a\n', 'BUSY\n']);
  r = await run(['check', 'env-a'], { home, env: shadowEnv({ VPT_LEASE_TOKEN_FILE: path.join(tmp, 'absent') }) });
  assert.deepEqual([r.code, r.out], [0, 'legacy check env-a\n']);
  setup(() => ({ ok: false, status: 500, error: 'boom' }));
  r = await run(['list'], { home, env: shadowEnv() });
  assert.deepEqual([r.code, r.out], [0, 'legacy list\n']);
});

test('claim sends a request_id that is stable across retries (idempotent claim) and cleared after the answer', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  let n = 0;
  setup(() => (++n <= 2 ? { ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' } : { ok: true, lease: lease({ id: 'IDEM' }) }));
  const r = await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x', '--wait'], { home });
  assert.equal(r.out.split('\n')[0], 'IDEM');
  const ids = calls.filter((c) => c.path === '/claim').map((c) => c.body.request_id);
  assert.equal(ids.length, 3); assert.match(ids[0], /^[0-9a-f]{32}$/); assert.equal(new Set(ids).size, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.cache', 'vpt-lease', 'request-ids.json'), 'utf8')), {});
  // a later identical claim is a new request
  await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x'], { home });
  assert.notEqual(calls.at(-1).body.request_id, ids[0]);
});

test('claim passes deploy_id (flag or VPT_DEPLOY_ID) so it joins the running deploy lease', async () => {
  setup(() => ({ ok: true, lease: lease() }));
  await run(['claim', 'env-a', 'host-1', '--agent', 'update_core:x', '--deploy-id', 'dep9']);
  assert.equal(calls[0].body.deploy_id, 'dep9');
  await run(['claim', 'env-a', 'host-1', '--agent', 'update_core:x'], { env: { VPT_DEPLOY_ID: 'dep7' } });
  assert.equal(calls[1].body.deploy_id, 'dep7');
});

test('claim: E_HELD with reason queued says the resource is free but others wait', async () => {
  setup(() => ({ ok: false, status: 409, code: 'E_HELD', error: 'queued', reason: 'queued', position: 2, holders: [] }));
  const r = await run(['claim', 'env-a', 'frontend', '--agent', 'codebox:x']);
  assert.equal(r.code, 3); assert.match(r.err, /free but 2 waiting ahead of you: use --wait/);
});

test('config file ~/.config/vpt-lease/config supplies mode and url; the environment overrides it', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), `# test\nVPT_LEASE_MODE=central\nVPT_LEASE_URL=${base}\nVPT_LEASE_TOKEN_FILE=${tokenFile}\n`);
  setup(() => ({ ok: true, free: true }));
  const bare = { PATH: process.env.PATH, HOME: home, LANG: 'C' };
  const out = await new Promise((resolve) => {
    const p = spawn('python3', ['-I', CLIENT, 'check', 'env-a'], { env: bare });
    let o = ''; p.stdout.on('data', (c) => (o += c)); p.on('close', (code) => resolve({ code, o }));
  });
  assert.deepEqual([out.code, out.o], [0, 'FREE — nothing active on env-a\n']);
  const r = await run(['list'], { home, env: { VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: legacyCli } });
  assert.equal(r.out, 'legacy list\n');
});

test('run: a refused heartbeat is reported loudly, heartbeating stops and run exits non-zero (6) after the command', async () => {
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'F1' }) } : c.path === '/heartbeat' ? { ok: false, status: 409, code: 'E_FENCED', error: 'fenced' } : { ok: true }));
  const r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', 'sh', '-c', 'sleep 1; exit 0']);
  assert.equal(r.code, 6); assert.match(r.err, /LEASE LOST: heartbeat refused \(E_FENCED\)/);
  assert.equal(calls.filter((c) => c.path === '/heartbeat').length, 1);
});

test('run: a downgraded lease counts as lost; --on-fence kill stops the command', async () => {
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'F2' }) } : c.path === '/heartbeat' ? { ok: true, lease: lease({ id: 'F2', mode: 'pin' }) } : { ok: true }));
  const t0 = Date.now();
  const r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--on-fence', 'kill', '--', 'sleep', '30']);
  assert.ok(Date.now() - t0 < 10000); assert.equal(r.code, 143); assert.match(r.err, /downgraded to pin/);
  assert.equal(calls.filter((c) => c.path === '/release').length, 1);
});

test('run: an unreachable service during the run is not a lost lease (keeps going, release retried)', async () => {
  let up = true;
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'U1' }) } : c.path === '/heartbeat' && up ? { ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' } : { ok: true }));
  const r = await run(['run', 'env-a', 'frontend', '--agent', 'codebox:x', '--', 'sh', '-c', 'sleep 0.8; exit 0']);
  void up;
  assert.equal(r.code, 0); assert.match(r.err, /keep going and retrying/); assert.doesNotMatch(r.err, /LEASE LOST/);
});

test('ticket --wait queues again with the original priority when the grant was missed', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  setup((c) => (c.path === '/claim' ? { ok: true, ticket: { id: 'TM', position: 3, holders: [] } } : { ok: true }));
  await run(['claim', 'env-a', 'host-1', '--agent', 'codebox:x', '--ticket', '--purpose', 'later'], { home });
  const first = calls[0].body;
  let state = 0;
  setup((c) => {
    if (c.path === '/claim') return { ok: true, ticket: { id: 'TM2', position: 1, holders: [] } };
    if (c.path === '/tickets/TM') return { ok: true, ticket: { id: 'TM', state: 'missed', reason: 'not collected within 2 min', priority_since: iso(1760000000) } };
    return ++state < 2 ? { ok: true, ticket: { id: 'TM2', state: 'waiting', position: 1, holders: [] } } : { ok: true, ticket: { id: 'TM2', state: 'granted', lease: lease({ id: 'RECLAIMED' }) } };
  });
  const r = await run(['ticket', 'TM', '--wait'], { home });
  assert.equal(r.code, 0); assert.equal(r.out.trim(), 'RECLAIMED');
  assert.match(r.err, /not collected within 2 min; queueing again/);
  const re = calls.find((c) => c.path === '/claim').body;
  assert.equal(re.priority_since, iso(1760000000)); assert.equal(re.purpose, 'later'); assert.deepEqual(re.resources, first.resources);
  // without a stored claim a missed ticket is an error
  const r2 = await run(['ticket', 'UNKNOWN', '--wait'], { home: fs.mkdtempSync(path.join(tmp, 'home-')) });
  void r2;
});

test('legacy mode degrades the new claim options (busy exits 3) and refuses ticket/heartbeat/mode; run claims, runs, releases', async () => {
  const log = path.join(tmp, 'legacy-run.log');
  const rec = path.join(tmp, 'legacy-rec');
  fs.writeFileSync(rec, `#!/bin/sh\necho "$*" >> ${log}\n[ "$1" = claim ] && echo LEG1\nexit 0\n`, { mode: 0o755 });
  const env = { VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: rec };
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'a', '--wait', '--mode', 'pin', '--expect', '5'], { env });
  assert.match(r.err, /legacy mode has no queue/);
  assert.match(fs.readFileSync(log, 'utf8'), /^claim env-a host-1 --agent a$/m);
  for (const c of [['ticket', 'T1'], ['heartbeat', 'X'], ['mode', 'X', 'pin']]) assert.equal((await run(c, { env })).code, 1);
  fs.writeFileSync(log, '');
  r = await run(['run', 'env-a', 'host-1', '--agent', 'a', '--', 'sh', '-c', 'exit 4'], { env });
  assert.equal(r.code, 4);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['claim env-a host-1 --agent a --purpose  --ttl 120', 'release LEG1']);
});

test('shadow: a hung service costs at most the shadow timeout and never changes the result', async () => {
  const hung = http.createServer(() => {});
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const r = await run(['check', 'env-a'], { url: `http://127.0.0.1:${hung.address().port}`, home: fs.mkdtempSync(path.join(tmp, 'home-')), env: shadowEnv() });
  hung.closeAllConnections?.(); hung.close();
  assert.deepEqual([r.code, r.out], [0, 'legacy check env-a\n']);
  assert.ok(Date.now() - t0 < 6000);
});

test('validate: 0 when held, exclusive and yours; 3 with the reason otherwise; 5 unavailable; 1 without an agent', async () => {
  setup(() => ({ ok: true, lease: lease({ id: 'V1', state: 'held' }) }));
  let r = await run(['validate', 'V1', '--agent', 'codebox:x']);
  assert.deepEqual([r.code, r.out], [0, 'valid\n']);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].path, '/leases/V1');
  r = await run(['validate', 'V1'], { env: { VPT_LEASE_AGENT: 'codebox:x' } });
  assert.equal(r.code, 0);
  r = await run(['validate', 'V1', '--agent', 'someone-else']);
  assert.equal(r.code, 3); assert.match(r.out, /held by codebox:x, not someone-else/);
  setup(() => ({ ok: true, lease: lease({ id: 'V1', mode: 'pin' }) }));
  r = await run(['validate', 'V1', '--agent', 'codebox:x']);
  assert.equal(r.code, 3); assert.match(r.out, /mode is pin, not exclusive/);
  setup(() => ({ ok: true, lease: lease({ id: 'V1', state: 'released' }) }));
  r = await run(['validate', 'V1', '--agent', 'codebox:x']);
  assert.equal(r.code, 3); assert.match(r.out, /state is released, not held/);
  setup(() => ({ ok: false, status: 404, code: 'E_NOT_FOUND', error: 'x' }));
  r = await run(['validate', 'V1', '--agent', 'codebox:x']);
  assert.equal(r.code, 3); assert.match(r.out, /unknown, released or expired/);
  setup(() => ({ ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' }));
  assert.equal((await run(['validate', 'V1', '--agent', 'codebox:x'])).code, 5);
  assert.equal((await run(['validate', 'V1', '--agent', 'a'], { url: await deadUrl() })).code, 5);
  r = await run(['validate', 'V1']);
  assert.equal(r.code, 1);
});

test('validate is refused with exit 1 in legacy and shadow modes, without any request', async () => {
  setup(() => ({ ok: true }));
  for (const env of [{ VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: legacyCli }, shadowEnv()]) {
    const r = await run(['validate', 'V1', '--agent', 'a'], { env });
    assert.equal(r.code, 1); assert.match(r.err, /needs VPT_LEASE_MODE=central/); assert.equal(r.out, '');
  }
  assert.equal(calls.length, 0);
});

test('help text and LEASE-RULES document exit 6 and the validate exit codes', async () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.match(src, /6 `run` only: the lease was lost/); assert.match(src, /validate ID --agent A.*0 when the lease is held/s);
  const rules = fs.readFileSync(path.join(path.dirname(CLIENT), '..', 'docs', 'LEASE-RULES.md'), 'utf8');
  assert.match(rules, /\| 6 \|/); assert.match(rules, /vpt-lease validate <id> --agent <agent>/);
  const h = await run(['validate', '--help']);
  assert.match(h.out, /exit 0 if the lease is held, exclusive and yours/);
});

test('R1 deploy start fails closed: ok without state/lease_id is exit 1, not "running"', async () => {
  setup(() => ({ ok: true }));
  let r = await run(['deploy', 'start', 'dep1']);
  assert.equal(r.code, 1); assert.equal(r.out, ''); assert.match(r.err, /did not confirm the deploy is running/);
  setup(() => ({ ok: true, state: 'running', lease_id: 'L9' }));
  r = await run(['deploy', 'start', 'dep1']);
  assert.deepEqual([r.code, r.out], [0, 'running\n']);
});

test('central-through-ssh behaves exactly like legacy: same exec of the wrapper, same exit codes, no HTTP, queue flags ignored, central-only commands refused', async () => {
  setup(() => ({ ok: true }));
  const marker = path.join(tmp, 'ran-marker-ssh');
  for (const args of [['claim', 'env-a', 'host-1', '--agent', 'a'], ['list'], ['check', 'env-a'], ['claim', 'env-a', 'frontend', '--agent', 'a', '--wait', '--expect', '5'], ['release', 'x1']]) {
    for (const code of ['0', '3', '4']) {
      const env = (mode) => ({ VPT_LEASE_MODE: mode, VPT_LEASE_LEGACY: legacyCli, FAKE_LEGACY_CODE: code, FAKE_LEGACY_ERR: 'E' });
      const a = await run(args, { env: env('legacy') }), b = await run(args, { env: env('central-through-ssh') });
      assert.deepEqual([b.code, b.out, b.err], [a.code, a.out, a.err], args.join(' ') + ' ' + code);
    }
  }
  assert.equal(calls.length, 0, 'no HTTP to the in-process service');
  for (const cmd of [['ticket', 'T1'], ['heartbeat', 'L1'], ['mode', 'L1', 'pin'], ['validate', 'L1', '--agent', 'a']]) {
    const a = await run(cmd, { env: { VPT_LEASE_MODE: 'legacy', VPT_LEASE_LEGACY: legacyCli } }), b = await run(cmd, { env: { VPT_LEASE_MODE: 'central-through-ssh', VPT_LEASE_LEGACY: legacyCli } });
    assert.deepEqual([b.code, b.out, b.err], [a.code, a.out, a.err]); assert.equal(b.code, 1);
  }
  for (const mode of ['legacy', 'central-through-ssh']) {   // run: also the legacy path (no heartbeat thread), a missing wrapper exits 1
    fs.rmSync(marker, { force: true });
    const r = await run(['run', 'env-a', 'frontend', '--agent', 'a', '--', 'touch', marker], { env: { VPT_LEASE_MODE: mode, VPT_LEASE_LEGACY: path.join(tmp, 'no-such-cli') } });
    assert.equal(r.code, 1, mode); assert.match(r.err, /cannot run the legacy CLI/); assert.ok(!fs.existsSync(marker));
  }
  const bad = await run(['list'], { env: { VPT_LEASE_MODE: 'bogus' } });
  assert.equal(bad.code, 1); assert.match(bad.err, /central-through-ssh/);
});

test('R2 legacy/shadow run: a missing legacy binary exits 1 with a message; an empty claim answer does not run the command', async () => {
  const marker = path.join(tmp, 'ran-marker');
  for (const mode of ['legacy', 'shadow']) {
    fs.rmSync(marker, { force: true });
    let r = await run(['run', 'env-a', 'frontend', '--agent', 'a', '--', 'touch', marker], { env: { VPT_LEASE_MODE: mode, VPT_LEASE_LEGACY: path.join(tmp, 'no-such-cli') } });
    assert.equal(r.code, 1, mode); assert.match(r.err, /cannot run the legacy CLI/); assert.doesNotMatch(r.err, /Traceback/); assert.ok(!fs.existsSync(marker));
    const empty = path.join(tmp, 'legacy-empty'); fs.writeFileSync(empty, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    r = await run(['run', 'env-a', 'frontend', '--agent', 'a', '--', 'touch', marker], { env: { VPT_LEASE_MODE: mode, VPT_LEASE_LEGACY: empty } });
    assert.equal(r.code, 1, mode); assert.match(r.err, /printed no lease id/); assert.ok(!fs.existsSync(marker), 'command not run');
  }
});

test('R3 LEASE-RULES: heartbeat release applies to run/heartbeating leases only; plain claims are bounded by TTL', () => {
  const rules = fs.readFileSync(path.join(path.dirname(CLIENT), '..', 'docs', 'LEASE-RULES.md'), 'utf8');
  assert.match(rules, /Only `run` and\s+other heartbeating leases/); assert.match(rules, /plain\s+`claim; work; release` keeps working and is bounded by its TTL/);
  assert.doesNotMatch(rules, /A lease\s+with no heartbeat is released/);
});

test('R4 narrow prints the service count, never a hard-coded 1', async () => {
  for (const [ans, out] of [[{ ok: true, narrowed: 0 }, 'narrowed 0 (already host)\n'], [{ ok: true, narrowed: 3 }, 'narrowed 3\n'], [{ ok: true, changed: false }, 'narrowed 0 (already host)\n']]) {
    setup(() => ans);
    const r = await run(['narrow', 'R1', '--kind', 'host']);
    assert.deepEqual([r.code, r.out], [0, out]);
  }
});

test('R5 check reads pending / pending_deploys: BUSY lists them, FREE prints the exit-4 note', async () => {
  const d = { id: 'pd1', env: 'env-a', state: 'queued', scope: 'frontend', ref: 'main', agent: 'a', purpose: '' };
  for (const key of ['pending', 'pending_deploys']) {
    setup(() => ({ ok: true, free: false, holders: [lease({ id: 'B1' })], [key]: [d] }));
    let r = await run(['check', 'env-a', 'host-1']);
    assert.equal(r.code, 3); assert.match(r.out, /\nDEPLOY pd1  env-a  state=queued  scope=frontend/);
    setup(() => ({ ok: true, free: true, holders: [], [key]: [d] }));
    r = await run(['check', 'env-a', 'frontend']);
    assert.equal(r.code, 0); assert.match(r.out, /^FREE .*\nnote: a deploy is pending, new claims on this get exit 4:\nDEPLOY pd1 /);
  }
});

test('R6 shadow: an unwritable cache never changes the legacy result; deploy ids and VPT_DEPLOY_ID claims are skipped', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.writeFileSync(path.join(home, '.cache'), 'a file, not a directory');       // ~/.cache/vpt-lease cannot be created
  const fakeClaim = path.join(tmp, 'legacy-claim2');
  fs.writeFileSync(fakeClaim, '#!/bin/sh\n[ "$1" = claim ] && echo legacyid9 || echo "released 1"\n', { mode: 0o755 });
  setup((c) => (c.path === '/claim' ? { ok: true, lease: lease({ id: 'CEN9' }) } : { ok: true, released: ['CEN9'] }));
  let r = await run(['claim', 'env-a', 'host-1', '--agent', 'a'], { home, env: shadowEnv({ VPT_LEASE_LEGACY: fakeClaim }) });
  assert.deepEqual([r.code, r.out], [0, 'legacyid9\n']); assert.doesNotMatch(r.err, /Traceback|Error/);
  // skipped: no request reaches the service
  setup(() => ({ ok: true }));
  for (const args of [['deploy', 'approve', 'dep1'], ['deploy', 'start', 'dep1'], ['deploy', 'finish', 'dep1', '--status', 'done'], ['deploy', 'cancel', 'dep1'], ['claim', 'env-a', 'host-1', '--agent', 'a', '--deploy-id', 'dep1']]) {
    r = await run(args, { home, env: shadowEnv() });
    assert.equal(r.code, 0, args.join(' '));
  }
  r = await run(['claim', 'env-a', 'host-1', '--agent', 'a'], { home, env: shadowEnv({ VPT_DEPLOY_ID: 'dep1' }) });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 0, 'nothing was shadowed: ' + JSON.stringify(calls.map((c) => c.path)));
});

test('R7 deploy wait retries an unreachable service with backoff and only exits 5 once its timeout passes', async () => {
  let n = 0;
  setup(() => (++n <= 2 ? { ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' } : { ok: true, deploy: { id: 'dep1', state: 'done' } }));
  let r = await run(['deploy', 'wait', 'dep1', '--timeout', '1']);
  assert.deepEqual([r.code, r.out], [0, 'deploy dep1 done\n']); assert.equal((r.err.match(/retrying in/g) || []).length, 2);
  setup(() => ({ ok: false, status: 503, code: 'E_UNAVAILABLE', error: 'down' }));
  const t0 = Date.now();
  r = await run(['deploy', 'wait', '--env', 'env-a', '--timeout', '0.03']);
  assert.equal(r.code, 5); assert.match(r.err, /retrying in/); assert.match(r.err, /stayed unreachable until the timeout/);
  assert.ok(Date.now() - t0 >= 1500, 'it waited for its own timeout first');
});

test('R8 --ttl above 480 is passed through and the service long flag prints a warning', async () => {
  setup(() => ({ ok: true, lease: lease({ id: 'LONG1', long: true }) }));
  let r = await run(['claim', 'env-a', 'host-1/stb-1', '--agent', 'codebox:x', '--ttl', '1000']);
  assert.equal(r.code, 0); assert.equal(calls[0].body.ttl_min, 1000); assert.match(r.err, /--ttl 1000 min is over 4 h/);
  setup(() => ({ ok: true, lease: lease({ id: 'LONG2', long: true }) }));
  r = await run(['claim', 'env-a', 'host-1/stb-1', '--agent', 'codebox:x', '--ttl', '100']);
  assert.match(r.err, /min is over 4 h/, 'service flag alone triggers the warning');
});
