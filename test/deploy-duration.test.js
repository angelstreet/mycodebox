// A deploy's lease deadline and hold clock follow progress (each finished host), with a hard ceiling; a deploy cut short
// queues a catch-up for the hosts it had not finished (owner 2026-11-01, deploys a56db33f / d726cee5 hit the 10/11 min cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseService } from '../lease-service.js';
import { createDeployRunner, followDetached, isHostDone, leaseCheckHosts } from '../deploy-runner.js';
import { tmp } from './helpers-tmp.js';

const MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await sleep(10); } throw new Error('timeout'); }
const prog = (host, phase, state, role = 'host') => `VPT_PROGRESS ${JSON.stringify({ host, role, phase, state, ts: '2026-11-01T12:00:00Z', detail: '' })}`;

function lease() {
  const clock = { t: Date.UTC(2026, 10, 1, 12, 0, 0), m: 5000 };
  const svc = createLeaseService({ dir: tmp('lease-dur-'), now: () => clock.t, config: { mono: () => clock.m, envs: ['env-a'] } });
  const advance = async (ms) => { clock.t += ms; clock.m += ms; await svc.tick(); };
  return { svc, advance, clock };
}
const startDeploy = async (svc) => {
  const q = await svc.deploy.request({ env: 'env-a', scope: 'host', hosts: ['host-1', 'host-2'], ref: 'r', agent: 'a', approved: true });
  const st = await svc.deploy.start({ id: q.id, agent: 'manager:deploy' });
  assert.ok(st.ok, JSON.stringify(st));
  return st.deploy.id;
};
const deployLease = async (svc, id) => Object.values((await svc.list({ env: 'env-a' })).leases).find((l) => l.deploy_id === id);

test('without progress the deploy lease still lapses at deployLeaseMin', async () => {
  const { svc, advance } = lease();
  const id = await startDeploy(svc);
  await advance(13 * MIN);
  assert.equal(await deployLease(svc, id), undefined);
});

test('each progress report renews the deploy lease: a 30 min rollout of healthy hosts keeps it', async () => {
  const { svc, advance } = lease();
  const id = await startDeploy(svc);
  for (let i = 0; i < 6; i++) { await advance(5 * MIN); const r = await svc.deploy.progress({ id }); assert.ok(r.ok, JSON.stringify(r)); }
  assert.ok(await deployLease(svc, id), 'still held after 30 min of progress');
});

test('the renewal never passes the hard ceiling (45 min from the start)', async () => {
  const { svc, advance } = lease();
  const id = await startDeploy(svc);
  for (let i = 0; i < 8; i++) { await advance(5 * MIN); await svc.deploy.progress({ id }); }   // 40 min
  await advance(4 * MIN); await svc.deploy.progress({ id });                                    // 44 min: renewed, but only to 45
  assert.ok(await deployLease(svc, id));
  await advance(2 * MIN);
  assert.equal(await deployLease(svc, id), undefined, 'gone at the ceiling although progress was reported');
});

test('releaseHosts (rolling) renews too; progress on unknown or finished deploy is refused', async () => {
  const { svc, advance } = lease();
  const id = await startDeploy(svc);
  await advance(10 * MIN);
  await svc.deploy.releaseHosts({ id, hosts: ['host-1'] });
  await advance(10 * MIN);
  assert.ok(await deployLease(svc, id), 'host-2 is still held 20 min in');
  assert.equal((await svc.deploy.progress({ id: 'nope' })).code, 'E_NOT_FOUND');
  await svc.deploy.finish({ id, status: 'done' });
  assert.equal((await svc.deploy.progress({ id })).code, 'E_INVALID');
});

test('progress line parsing', () => {
  assert.deepEqual(isHostDone(prog('Host-A', 'health', 'ok')), { host: 'host-a', role: 'host' });
  assert.deepEqual(isHostDone(prog('host-a', 'health', 'skipped'))?.host, 'host-a');
  assert.equal(isHostDone(prog('host-a', 'health', 'start')), null);
  assert.equal(isHostDone(prog('host-a', 'restart', 'ok')), null);
  assert.deepEqual(leaseCheckHosts('=== Lease check (node1-vpt: server frontend Host-A vpt-pi1) [skip-leased] ==='), ['server', 'frontend', 'host-a', 'vpt-pi1']);
  assert.deepEqual(leaseCheckHosts('holding lease x'), []);
});

// ---- hold clock follows progress ----------------------------------------------------------------------------------
const follow = (dir, opts) => followDetached(dir, 'd1', { onLine: () => {}, pollMs: 10, pid: process.pid, ...opts });
function fakeKill(dir) {
  const orig = process.kill; const killed = [];
  process.kill = (pid, sig) => { if (pid < 0) { killed.push(sig); writeFileSync(join(dir, 'd1.exit'), '143'); return true; } return orig(pid, sig); };
  return { killed, restore: () => { process.kill = orig; } };
}

test('hold clock restarts at each finished host; stalls still time out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'));
  writeFileSync(join(dir, 'd1.run'), 'holding lease abc on e (server) for the deploy\n');
  const k = fakeKill(dir);
  try {
    const p = follow(dir, { timeoutMs: 150, maxMs: 60000, holdCeilingMs: 60000 });
    for (let i = 0; i < 4; i++) { await sleep(80); appendFileSync(join(dir, 'd1.run'), prog(`h${i}`, 'health', 'ok') + '\n'); }
    assert.deepEqual(k.killed, [], '320 ms of hold with a host finishing every 80 ms is alive');
    const r = await p;
    assert.equal(r.timedOut, 'hold');
  } finally { k.restore(); }
});

test('hard ceiling kills a deploy that keeps reporting progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'));
  writeFileSync(join(dir, 'd1.run'), 'holding lease abc on e (server) for the deploy\n');
  const k = fakeKill(dir);
  try {
    const p = follow(dir, { timeoutMs: 150, maxMs: 60000, holdCeilingMs: 300 });
    const feed = setInterval(() => appendFileSync(join(dir, 'd1.run'), prog('h', 'health', 'ok') + '\n'), 50);
    const r = await p; clearInterval(feed);
    assert.equal(r.timedOut, 'ceiling');
  } finally { k.restore(); }
});

// ---- catch-up for hosts a cut-short deploy had not finished ---------------------------------------------------------
function reg() {
  const st = { deploys: [{ id: '1', env: 'node1-vpt', scope: 'full', ref: 'main', agent: 'a:1', state: 'queued', created: 1 }], calls: [] };
  st.fn = async (args, { stdin } = {}) => {
    st.calls.push(args.join(' '));
    const [, sub, id] = args; const d = st.deploys.find((x) => x.id === id);
    if (sub === 'list') return { code: 0, stdout: JSON.stringify({ deploys: st.deploys, leases: [] }), stderr: '' };
    if (sub === 'start') { d.state = 'running'; return { code: 0, stdout: 'running', stderr: '' }; }
    if (sub === 'finish') { d.state = args[args.indexOf('--status') + 1]; if (args.includes('--skipped-hosts')) d.skippedHosts = args[args.indexOf('--skipped-hosts') + 1].split(','); d.tail = stdin; return { code: 0, stdout: d.state, stderr: '' }; }
    if (sub === 'request') { const g = (f) => args[args.indexOf(f) + 1]; st.deploys.push({ id: `c${st.deploys.length + 1}`, env: args[2], scope: g('--scope'), ref: g('--ref'), agent: g('--agent'), purpose: g('--purpose'), state: 'queued', created: 99, hosts: g('--hosts').split(',') }); return { code: 0, stdout: 'c', stderr: '' }; }
    if (sub === 'last') return { code: 2, stdout: '', stderr: 'invalid choice' };
    if (sub === 'approve') { d.state = 'queued'; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  return st;
}
function runner(r, run) {
  return createDeployRunner({ stateDir: mkdtempSync(join(tmpdir(), 'dd-st-')), registry: r.fn, isEnabled: () => true, alert: () => {}, log: { error() {}, warn() {}, info() {}, log() {} }, run });
}

for (const [name, result] of [['update_core lease guard (exit 6)', { code: 6 }], ['hold timeout', { code: 143, timedOut: 'hold' }], ['ceiling', { code: 143, timedOut: 'ceiling' }]]) {
  test(`cut short by ${name}: the unfinished hosts get a catch-up request`, async () => {
    const r = reg();
    const rn = runner(r, async (env, o) => {
      o.onLine('=== Lease check (node1-vpt: server frontend host-a host-b host-c) [skip-leased] ===');
      for (const l of [prog('host-a', 'health', 'ok'), prog('host-b', 'rsync', 'start')]) o.onLine(l);
      return result;
    });
    await rn.tick();
    await until(() => r.deploys.some((d) => d.id !== '1'));
    const c = r.deploys.find((d) => d.id !== '1');
    assert.deepEqual(c.hosts, ['host-b', 'host-c']);
    assert.equal(c.scope, 'host');
    assert.equal(r.deploys[0].state, 'failed');
  });
}

test('a finished deploy (exit 0) and a plain failure queue no catch-up; progress is reported for the lease', async () => {
  const r = reg();
  const rn = runner(r, async (env, o) => {
    o.onLine('=== Lease check (node1-vpt: server host-a host-b) ===');
    o.onLine(prog('host-a', 'health', 'ok'));
    await sleep(20);
    return { code: 1 };
  });
  await rn.tick();
  await until(() => r.deploys[0].state === 'failed');
  assert.equal(r.deploys.length, 1);
  assert.ok(r.calls.some((c) => c === 'deploy progress 1'), r.calls.join('\n'));
});
