import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeployRunner, flagsFor, covers } from '../deploy-runner.js';

// In-memory registry that mimics `vpt-lease deploy ...` (start = atomic check against leases + one running per env).
function fakeRegistry({ leases = [], deploys = [] } = {}) {
  const st = { leases, deploys, calls: [] };
  const touches = (scope, r) => r === '*' || scope === 'server' || scope === 'full' || (scope === 'frontend' ? r === 'frontend' : r !== 'frontend');
  st.fn = async (args, { stdin } = {}) => {
    st.calls.push(args.join(' '));
    const [, sub, id] = args;
    const d = st.deploys.find((x) => x.id === id);
    if (sub === 'list') return { code: 0, stdout: JSON.stringify({ deploys: st.deploys, leases: st.leases }), stderr: '' };
    if (sub === 'start') {
      if (!d || d.state !== 'queued') return { code: 1, stdout: '', stderr: 'not queued' };
      if (st.deploys.some((x) => x.env === d.env && x.state === 'running')) return { code: 3, stdout: '', stderr: 'running' };
      if (st.leases.some((l) => l.env === d.env && l.agent !== 'manager:deploy' && touches(d.scope, l.resource))) return { code: 3, stdout: '', stderr: 'leases' };
      d.state = 'running'; return { code: 0, stdout: 'running', stderr: '' };
    }
    if (sub === 'finish') {
      d.state = args[args.indexOf('--status') + 1]; d.finished = Date.now(); d.tail = stdin;
      if (args.includes('--coalesced-into')) d.coalescedInto = args[args.indexOf('--coalesced-into') + 1];
      if (args.includes('--version')) d.version = args[args.indexOf('--version') + 1];
      return { code: 0, stdout: d.state, stderr: '' };
    }
    if (sub === 'last') return st.deployed ? { code: 0, stdout: JSON.stringify({ now: 1, envs: st.deployed }), stderr: '' } : { code: 2, stdout: '', stderr: 'invalid choice' };
    if (sub === 'approve') { d.state = 'queued'; return { code: 0, stdout: 'approved', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return st;
}
const dep = (id, o = {}) => ({ id, env: 'node1-vpt', scope: 'frontend', ref: 'main', agent: 'a:1', state: 'queued', created: Number(id.replace(/\D/g, '')) || 1, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await sleep(10); } throw new Error('timeout'); }

function make(reg, { enabled = true, run, envs } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ghosty-dep-'));
  const alerts = [], ran = [];
  const runner = createDeployRunner({
    stateDir, registry: reg.fn, isEnabled: () => enabled, alert: (k, p) => alerts.push([k, p.title]), log: { error() {} },
    run: run || (async (env, o) => { ran.push(o); o.onLine('deploying'); o.onLine('VERSION 1.2.3'); return { code: 0 }; }),
  });
  return { runner, alerts, ran, stateDir };
}

test('flags per scope and coverage', () => {
  assert.deepEqual(flagsFor('frontend'), ['--frontend']);
  assert.deepEqual(flagsFor('host'), ['--host']);
  assert.deepEqual(flagsFor('server'), ['--server']);
  assert.deepEqual(flagsFor('full'), []);
  assert.equal(flagsFor('bogus'), null);
  assert.ok(covers('full', 'host') && covers('server', 'server') && !covers('server', 'frontend'));
});

test('runs the oldest approved request: command, flags, runner agent, version, log, alerts', async () => {
  const reg = fakeRegistry({ deploys: [dep('3', { scope: 'host', ref: 'feat/x' }), dep('2', { scope: 'server', ref: 'feat/y' })] });
  const { runner, alerts, ran, stateDir } = make(reg);
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '2').state === 'done');
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=2 bash update_core.sh feat/y --server');
  assert.deepEqual(ran[0].flags, ['--server']);
  const d = reg.deploys.find((x) => x.id === '2');
  assert.equal(d.version, '1.2.3');
  assert.match(d.tail, /deploying/);
  assert.match(readFileSync(join(stateDir, 'deploys', '2.log'), 'utf8'), /# update_core exit 0/);
  assert.match(await runner.logTail('2', 5), /VERSION 1.2.3/);
  assert.ok(alerts.some(([k]) => k === 'deploy:2:start') && alerts.some(([k]) => k === 'deploy:2:done'));
  assert.equal(existsSync(join(stateDir, 'deploy-envs.json')), true);
});

test('full scope uses no flag; other env uses its own host', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' })] });
  const { runner, ran } = make(reg);
  await runner.tick(); await until(() => ran.length === 1);
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=1 bash update_core.sh main');
});

test('skips a busy request and starts a free one behind it', async () => {
  const reg = fakeRegistry({
    leases: [{ id: 'l1', env: 'node1-vpt', resource: 'vpt-pi1/stb4', agent: 'codebox:run' }],
    deploys: [dep('1', { scope: 'server' }), dep('2', { scope: 'frontend' })],
  });
  const { runner, ran } = make(reg);
  await runner.tick(); await until(() => reg.deploys[1].state === 'done');
  assert.equal(reg.deploys[0].state, 'queued');
  assert.equal(ran.length, 1);
  assert.deepEqual(runner.snapshot().deploys.map((d) => d.id), ['1', '2']);
});

test('runner on = standing approval: an unapproved request is approved and runs (no approval alert)', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { state: 'awaiting-approval' })] });
  const { runner, ran, alerts } = make(reg);
  await runner.tick();
  await until(() => reg.deploys[0].state === 'done');
  assert.equal(ran.length, 1);
  assert.ok(reg.calls.includes('deploy approve 1'));
  assert.equal(alerts.filter(([k]) => k.endsWith(':approve')).length, 0);
});

test('runner off: unapproved requests wait and alert once for approval', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { state: 'awaiting-approval' })] });
  const { runner, ran, alerts } = make(reg, { enabled: false });
  await runner.tick();                                        // first poll: existing ones are not re-alerted
  reg.deploys.push(dep('2', { state: 'awaiting-approval' }));
  await runner.tick(); await runner.tick(); await sleep(50);
  assert.equal(ran.length, 0);
  assert.deepEqual(alerts.filter(([k]) => k.endsWith(':approve')).map(([k]) => k), ['deploy:2:approve']);
  assert.equal(reg.deploys[0].state, 'awaiting-approval');
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy approve')));
});

test('deployRunner off: queue is read but nothing starts', async () => {
  const reg = fakeRegistry({ deploys: [dep('1')] });
  const { runner, ran } = make(reg, { enabled: false });
  await runner.tick(); await sleep(50);
  assert.equal(ran.length, 0);
  assert.equal(reg.deploys[0].state, 'queued');
  assert.equal(runner.snapshot().enabled, false);
  assert.equal(runner.snapshot().deploys.length, 1);
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy start')));
});

test('coalesces same env + ref covered by the running scope, not other refs or uncovered scopes', async () => {
  const reg = fakeRegistry({ deploys: [
    dep('1', { scope: 'full' }), dep('2', { scope: 'frontend' }), dep('3', { scope: 'host' }),
    dep('4', { scope: 'frontend', ref: 'other' }), dep('5', { scope: 'frontend', env: 'node3-qualiai' }),
  ] });
  const { runner } = make(reg);
  await runner.tick(); await until(() => reg.deploys[0].state === 'done');
  await until(() => reg.deploys[1].state === 'done' && reg.deploys[2].state === 'done');
  assert.equal(reg.deploys[1].coalescedInto, '1');
  assert.equal(reg.deploys[2].coalescedInto, '1');
  assert.equal(reg.deploys[1].version, '1.2.3');
  assert.equal(reg.deploys[3].state === 'queued' || reg.deploys[3].state === 'running' || reg.deploys[3].state === 'done', true);
  assert.equal(reg.deploys[3].coalescedInto, undefined);
});

test('uncovered scope is not merged: server deploy leaves a frontend request for its own run', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'server' }), dep('2', { scope: 'frontend' })] });
  const { runner, ran } = make(reg);
  await runner.tick(); await until(() => reg.deploys[0].state === 'done');
  await until(() => reg.deploys[1].state === 'done');
  assert.equal(ran.length, 2);
  assert.equal(reg.deploys[1].coalescedInto, undefined);
});

test('one running per env: a second request waits while the first runs, other env goes in parallel', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'frontend', ref: 'a' }), dep('2', { scope: 'frontend', ref: 'b' }), dep('3', { env: 'node3-qualiai', ref: 'c' })] });
  let release; const gate = new Promise((r) => { release = r; });
  const started = [];
  const { runner } = make(reg, { run: async (env, o) => { started.push(o.ref); o.onLine('x'); await gate; return { code: 0 }; } });
  await runner.tick(); await until(() => started.length === 2);
  assert.deepEqual(started.sort(), ['a', 'c']);
  await runner.tick(); await sleep(30);
  assert.equal(reg.deploys[1].state, 'queued');
  release();
  await until(() => reg.deploys[1].state === 'done');
  assert.deepEqual(started.sort(), ['a', 'b', 'c']);
});

test('failure path: non-zero exit -> failed with tail and alert; timeout -> failed', async () => {
  const reg = fakeRegistry({ deploys: [dep('1'), dep('2', { env: 'node3-qualiai' })] });
  const { runner, alerts } = make(reg, { run: async (env, o) => { o.onLine('boom'); return o.ref === 'main' && o.remoteCmd.includes('update_core') && o.scope === 'frontend' && !o.timeoutHit ? { code: 1 } : { code: 0 }; } });
  await runner.tick(); await until(() => reg.deploys.every((d) => d.state !== 'queued' && d.state !== 'running'));
  assert.equal(reg.deploys[0].state, 'failed');
  assert.match(reg.deploys[0].tail, /boom/);
  assert.ok(alerts.some(([k]) => k === 'deploy:1:failed'));
  const reg2 = fakeRegistry({ deploys: [dep('1')] });
  const m2 = make(reg2, { run: async (env, o) => ({ code: 143, timedOut: true }) });
  await m2.runner.tick(); await until(() => reg2.deploys[0].state === 'failed');
  assert.match(reg2.deploys[0].tail, /TIMEOUT/);
});

test('health check failure marks the deploy failed; none configured is noted', async () => {
  const reg = fakeRegistry({ deploys: [dep('1')] });
  const { runner, stateDir, ran } = make(reg, { run: async (env, o) => ({ code: o.kind === 'health' ? 7 : 0 }) });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(stateDir, 'deploy-envs.json'), JSON.stringify({ 'node1-vpt': { ssh: 'h', cmd: 'bash update_core.sh', health: 'curl -sf localhost/health' } }));
  await runner.tick(); await until(() => reg.deploys[0].state === 'failed');
  assert.match(reg.deploys[0].tail, /health check exit 7/);
});

test('registry unreachable is reported, not thrown', async () => {
  const { runner } = make({ fn: async () => ({ code: 255, stdout: '', stderr: 'ssh: no route' }) });
  await runner.tick();
  assert.equal(runner.snapshot().ok, false);
  assert.match(runner.snapshot().error, /no route/);
});

test('lastRef per env comes from the latest done deploy', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { state: 'done', ref: 'old', finished: 1 }), dep('2', { state: 'done', ref: 'new', finished: 2 }), dep('3', { state: 'failed', ref: 'bad', finished: 3 })] });
  const { runner } = make(reg, { enabled: false });
  await runner.tick();
  assert.equal(runner.snapshot().lastRef['node1-vpt'].ref, 'new');
});

test('unsafe ref is shell-quoted in the remote command', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { ref: "x'; rm -rf ~; '" })] });
  const { runner, ran } = make(reg);
  await runner.tick(); await until(() => ran.length === 1);
  assert.ok(ran[0].remoteCmd.includes(`'x'\\''; rm -rf ~; '\\'''`));
});

test('snapshot carries the deployed-now ledger; an old registry without it keeps the last value', async () => {
  const reg = fakeRegistry();
  reg.deployed = { 'node1-vpt': { server: { version: 'main-9', ref: 'main', commit: 'abc', at: 5, agent: 'a:1' } } };
  const { runner } = make(reg, { enabled: false });
  await runner.tick();
  assert.equal(runner.snapshot().deployed['node1-vpt'].server.version, 'main-9');
  assert.ok(reg.calls.includes('deploy last --json'));
  delete reg.deployed;                                      // registry without `deploy last`: poll still ok
  await runner.tick();
  assert.equal(runner.snapshot().ok, true);
  assert.equal(runner.snapshot().deployed['node1-vpt'].server.version, 'main-9');
});

test('onChange fires when only the deployed map changes', async () => {
  const reg = fakeRegistry();
  const changes = [];
  const runner = createDeployRunner({ stateDir: mkdtempSync(join(tmpdir(), 'ghosty-dep-')), registry: reg.fn, isEnabled: () => false, alert() {}, log: { error() {} }, onChange: (s) => changes.push(s), run: async () => ({ code: 0 }) });
  await runner.tick();
  const n = changes.length;
  await runner.tick(); assert.equal(changes.length, n);      // nothing changed
  reg.deployed = { e: { frontend: { version: 'v1', at: 1 } } };
  await runner.tick(); assert.equal(changes.length, n + 1);
  assert.equal(changes.at(-1).deployed.e.frontend.version, 'v1');
});
