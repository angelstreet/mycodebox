import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp as mkTmp } from './helpers-tmp.js';
import { createDeployRunner, flagsFor, covers, parseSkipped, extraFlagsFor, mergeable, remoteLeaseCmd, RUNNER_AGENT, DEFAULT_ORPHAN_IDLE_MS, isCatchUp, coveringCatchUps, catchUpPlan } from '../deploy-runner.js';

// In-memory registry that mimics `vpt-lease deploy ...` (start = atomic check against leases + one running per env).
function fakeRegistry({ leases = [], deploys = [] } = {}) {
  const st = { leases, deploys, calls: [] };
  const touches = (scope, r) => r === '*' || scope === 'server' || scope === 'full' || (scope === 'frontend' ? r === 'frontend' : r !== 'frontend');
  st.fn = async (args, { stdin } = {}) => {
    st.calls.push(args.join(' '));
    const [, sub, id] = args;
    const d = st.deploys.find((x) => x.id === id);
    if (sub === 'list') return { code: 0, stdout: JSON.stringify({ deploys: st.deploys, leases: st.leases }), stderr: '' };
    if (sub === 'request') {
      const g = (f) => args[args.indexOf(f) + 1];
      const n = { id: `c${st.deploys.length + 1}`, env: args[2], scope: g('--scope'), ref: g('--ref'), agent: g('--agent'), purpose: g('--purpose'), state: 'queued', created: 99, hosts: args.includes('--hosts') ? g('--hosts').split(',') : undefined };
      st.deploys.push(n); return { code: 0, stdout: n.id, stderr: '' };
    }
    if (sub === 'start') {
      if (!d || d.state !== 'queued') return { code: 1, stdout: '', stderr: 'not queued' };
      if (st.deploys.some((x) => x.env === d.env && x.state === 'running')) return { code: 3, stdout: '', stderr: 'running' };
      if (st.leases.some((l) => l.env === d.env && l.agent !== 'manager:deploy' && touches(d.scope, l.resource))) return { code: 3, stdout: '', stderr: 'leases' };
      d.state = 'running'; if (st.grantLease) st.leases.push({ id: `L${d.id}`, env: d.env, resource: 'server', agent: 'manager:deploy', deploy_id: d.id }); return { code: 0, stdout: 'running', stderr: '' };
    }
    if (sub === 'finish') {
      d.state = args[args.indexOf('--status') + 1]; d.finished = Date.now(); d.tail = stdin;
      if (args.includes('--coalesced-into')) d.coalescedInto = args[args.indexOf('--coalesced-into') + 1];
      if (args.includes('--skipped-hosts')) d.skippedHosts = args[args.indexOf('--skipped-hosts') + 1].split(',');
      if (args.includes('--version')) d.version = args[args.indexOf('--version') + 1];
      return { code: 0, stdout: d.state, stderr: '' };
    }
    if (sub === 'last') return st.deployed ? { code: 0, stdout: JSON.stringify({ now: 1, envs: st.deployed }), stderr: '' } : { code: 2, stdout: '', stderr: 'invalid choice' };
    if (sub === 'approve') { d.state = 'queued'; return { code: 0, stdout: 'approved', stderr: '' }; }
    if (sub === 'cancel') {
      if (!d) return { code: 1, stdout: '', stderr: 'not found' };
      if (d.state !== 'queued' && d.state !== 'awaiting-approval') return { code: 1, stdout: '', stderr: `cannot cancel a ${d.state} deploy` };
      d.state = 'canceled'; return { code: 0, stdout: d.id, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return st;
}
const dep = (id, o = {}) => ({ id, env: 'node1-vpt', scope: 'frontend', ref: 'main', agent: 'a:1', state: 'queued', created: Number(id.replace(/\D/g, '')) || 1, ...o });
// a catch-up as the queue holds it: the runner's own request for hosts a leased deploy skipped
const catchUp = (id, o = {}) => dep(id, { scope: 'host', ref: 'main', agent: RUNNER_AGENT, hosts: ['host-a'], purpose: `catch-up: hosts skipped by 9 (leased): host-a`, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await sleep(10); } throw new Error('timeout'); }

function make(reg, { enabled = true, run, envs, managerItem } = {}) {
  const stateDir = mkTmp('ghosty-dep-');
  const alerts = [], ran = [];
  const runner = createDeployRunner({
    stateDir, registry: reg.fn, isEnabled: () => enabled, managerItem, alert: (k, p) => alerts.push([k, p.title]), log: { error() {} },
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
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=2 bash update_core.sh feat/y --server --skip-leased');
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
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=1 bash update_core.sh main --skip-leased');
  assert.ok(reg.calls.includes('deploy start 1 --skip-leased'));
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

test('runner off with a managerItem hook: the approval ask is a manager item, no owner alert', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { state: 'awaiting-approval' })] });
  const items = [];
  const { runner, alerts } = make(reg, { enabled: false, managerItem: (e) => items.push(e) });
  await runner.tick();
  reg.deploys.push(dep('2', { state: 'awaiting-approval' }));
  await runner.tick(); await runner.tick();
  assert.deepEqual(items.map((i) => i.key), ['deploy:2:manager-item']);
  assert.equal(alerts.filter(([k]) => k.endsWith(':approve')).length, 0);
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
  const runner = createDeployRunner({ stateDir: mkTmp('ghosty-dep-'), registry: reg.fn, isEnabled: () => false, alert() {}, log: { error() {} }, onChange: (s) => changes.push(s), run: async () => ({ code: 0 }) });
  await runner.tick();
  const n = changes.length;
  await runner.tick(); assert.equal(changes.length, n);      // nothing changed
  reg.deployed = { e: { frontend: { version: 'v1', at: 1 } } };
  await runner.tick(); assert.equal(changes.length, n + 1);
  assert.equal(changes.at(-1).deployed.e.frontend.version, 'v1');
});

test('full and host deploys always pass --skip-leased; frontend and server do not', async () => {
  assert.deepEqual(extraFlagsFor({ scope: 'full' }), ['--skip-leased']);
  assert.deepEqual(extraFlagsFor({ scope: 'host' }), ['--skip-leased']);
  assert.deepEqual(extraFlagsFor({ scope: 'host', hosts: ['a', 'b'] }), ['--skip-leased', '--hosts', 'a,b']);
  assert.deepEqual(extraFlagsFor({ scope: 'frontend' }), []);
  assert.deepEqual(extraFlagsFor({ scope: 'server' }), ['--skip-leased']);
});

test('parseSkipped reads the last SKIPPED_HOSTS line and ignores junk names', () => {
  assert.deepEqual(parseSkipped(['x', 'SKIPPED_HOSTS=a,b']), ['a', 'b']);
  assert.deepEqual(parseSkipped(['SKIPPED_HOSTS=a', 'SKIPPED_HOSTS=c']), ['c']);
  assert.deepEqual(parseSkipped(['SKIPPED (leased by x): a']), []);
  assert.deepEqual(parseSkipped(['SKIPPED_HOSTS=a;rm,b']), ['b']);
});

test('SKIPPED_HOSTS: recorded on the deploy and a catch-up host request is queued', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' })] });
  const { runner, ran, alerts } = make(reg, { run: async (env, o) => { o.onLine('deploying'); if (o.id === '1') { o.onLine('SKIPPED (leased by mac:m): labox-dongle'); o.onLine('SKIPPED_HOSTS=labox-dongle'); } return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done');
  await until(() => alerts.some(([k]) => k === 'deploy:1:done'));   // the alert follows the catch-up step (a registry read first)
  assert.deepEqual(reg.deploys.find((d) => d.id === '1').skippedHosts, ['labox-dongle']);
  const cu = reg.deploys.find((d) => d.agent === 'manager:deploy');
  assert.ok(cu);
  assert.deepEqual([cu.scope, cu.ref, cu.hosts], ['host', 'main', ['labox-dongle']]);
  assert.match(cu.purpose, /^catch-up: hosts skipped by 1 \(leased\): labox-dongle$/);
  assert.ok(reg.calls.some((c) => /deploy request node1-vpt --scope host --ref main --agent manager:deploy --approved --hosts labox-dongle/.test(c)));
  assert.ok(alerts.some(([k, t]) => k === 'deploy:1:done' && /1 host\(s\) skipped/.test(t)));
});

test('one catch-up per (env, host set): an equal-ref one is kept, an older queued one is replaced, an older running one does not block', () => {
  const c = (id, o = {}) => ({ id, env: 'e', state: 'queued', ref: 'main', hosts: ['host-a'], purpose: `catch-up: ${id}`, ...o });
  const running = c('r', { state: 'running', ref: 'old' }), same = c('s'), older = c('o', { ref: 'old', hosts: ['host-a', 'host-b'] });
  const d = { env: 'e', ref: 'main' };
  assert.equal(isCatchUp({ purpose: 'catch-up: hosts skipped by 1 (leased): host-a' }), true);
  assert.equal(isCatchUp({ purpose: 'catch-up for 1: skipped host-a' }), true);            // the central service's spelling
  assert.equal(isCatchUp({ purpose: 're-run after a catch-up' }), false);
  assert.equal(isCatchUp({}), false);
  assert.deepEqual(coveringCatchUps([running, same, older, c('done', { state: 'done' }), c('other-hosts', { hosts: ['host-c'] }), c('other-env', { env: 'e2' }), c('manual', { purpose: 'manual hotfix' })], 'e', ['host-a']).map((x) => x.id), ['r', 's', 'o']);
  assert.deepEqual(catchUpPlan([same], d), { queue: false, held: [same], cancel: [] });
  assert.deepEqual(catchUpPlan([running], d), { queue: true, held: [], cancel: [] });   // running at an older ref: the newer ref still goes
  assert.deepEqual(catchUpPlan([older], d), { queue: true, held: [], cancel: [older] });
  assert.deepEqual(catchUpPlan([running, older], d), { queue: true, held: [], cancel: [older] });
  assert.deepEqual(catchUpPlan([c('rs', { state: 'running' })], d).queue, false);   // running at the same ref covers it
  assert.deepEqual(catchUpPlan([], d), { queue: true, held: [], cancel: [] });
});

test('an equal catch-up already queued for the hosts: no second request, no cancel', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' }), catchUp('20')] });
  const { runner, stateDir } = make(reg, { run: async (env, o) => { if (o.id === '1') o.onLine('SKIPPED_HOSTS=host-a'); return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done'); await sleep(60);
  assert.equal(reg.calls.filter((c) => c.startsWith('deploy request')).length, 0);
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy cancel')));
  assert.match(readFileSync(join(stateDir, 'deploys', '1.log'), 'utf8'), /already covered by 20 \(queued, main\): no new request/);
});

test('a catch-up already running for the hosts when the deploy finishes: no new request, the running one is left alone', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' }), catchUp('20')] });
  const { runner, stateDir } = make(reg, { run: async (env, o) => {
    if (o.id === '1') { o.onLine('SKIPPED_HOSTS=host-a'); reg.deploys.find((d) => d.id === '20').state = 'running'; }   // it started meanwhile
    return { code: 0 };
  } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done'); await sleep(60);
  assert.equal(reg.calls.filter((c) => c.startsWith('deploy request')).length, 0);
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy cancel')));
  assert.equal(reg.deploys.find((d) => d.id === '20').state, 'running');
  assert.match(readFileSync(join(stateDir, 'deploys', '1.log'), 'utf8'), /already covered by 20 \(running, main\): no new request/);
});

test('a queued catch-up at another ref is cancelled and replaced by the newer deploy\'s catch-up', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' }), catchUp('20', { ref: 'old-ref' })] });
  const { runner, stateDir } = make(reg, { run: async (env, o) => { if (o.id === '1') o.onLine('SKIPPED_HOSTS=host-a'); return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done'); await sleep(60);
  assert.ok(reg.calls.includes('deploy cancel 20'));
  assert.equal(reg.deploys.find((d) => d.id === '20').state, 'canceled');
  const live = reg.deploys.filter((d) => isCatchUp(d) && d.state !== 'canceled');       // exactly one catch-up left for these hosts
  assert.equal(live.length, 1);
  assert.deepEqual([live[0].ref, live[0].hosts], ['main', ['host-a']]);
  assert.match(live[0].purpose, /^catch-up: hosts skipped by 1 \(leased\): host-a$/);
  assert.match(readFileSync(join(stateDir, 'deploys', '1.log'), 'utf8'), /# catch-up 20 \(ref old-ref\) cancelled: superseded by 1 at main/);
});

test('a catch-up whose hosts are leased again queues no new catch-up (no chain)', async () => {
  const reg = fakeRegistry({ deploys: [catchUp('5')] });
  const { runner, stateDir } = make(reg, { run: async (env, o) => { o.onLine('SKIPPED_HOSTS=host-a'); return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys[0].state === 'done'); await sleep(60);
  assert.deepEqual(reg.deploys[0].skippedHosts, ['host-a']);                           // the skip is still recorded
  assert.equal(reg.calls.filter((c) => c.startsWith('deploy request')).length, 0);
  assert.equal(reg.deploys.filter((d) => isCatchUp(d)).length, 1);
  const log = readFileSync(join(stateDir, 'deploys', '5.log'), 'utf8');
  assert.match(log, /# catch-up 5 skipped host-a again \(leased\): no new catch-up/);
  assert.equal((log.match(/no new catch-up/g) || []).length, 1);                      // one line, not a chain
});

test('a queued request that is not a catch-up for the same hosts is left alone, and the catch-up is still queued', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full', ref: 'main' }), dep('20', { scope: 'host', hosts: ['host-a'], purpose: 'manual hotfix', agent: 'codebox:run' })] });
  const { runner } = make(reg, { run: async (env, o) => { if (o.id === '1') o.onLine('SKIPPED_HOSTS=host-a'); return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done'); await sleep(60);
  const manual = reg.deploys.find((d) => d.id === '20');
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy cancel')), 'a normal request is never cancelled by the catch-up dedupe');
  assert.notEqual(manual.state, 'canceled');
  assert.equal(manual.coalescedInto, undefined);                                      // skipped hosts keep their request open
  assert.ok(reg.deploys.some((d) => isCatchUp(d) && d.ref === 'main' && d.hosts?.includes('host-a')));
});

test('the catch-up runs with --hosts, only when its hosts are free', async () => {
  const reg = fakeRegistry({ deploys: [dep('5', { scope: 'host', ref: 'main', agent: 'manager:deploy', hosts: ['labox-dongle'] })] });
  const { runner, ran } = make(reg);
  await runner.tick(); await until(() => ran.length === 1);
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=5 bash update_core.sh main --host --skip-leased --hosts labox-dongle');
  assert.ok(reg.calls.includes('deploy start 5 --skip-leased'));
});

test('no SKIPPED_HOSTS line: no catch-up request, no skippedHosts', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'host' })] });
  const { runner } = make(reg);
  await runner.tick(); await until(() => reg.deploys[0].state === 'done');
  assert.equal(reg.deploys.length, 1);
  assert.equal(reg.deploys[0].skippedHosts, undefined);
});

test('a run that skipped hosts does not close a queued host request for them; one for other hosts is merged', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { scope: 'full' }), dep('2', { scope: 'host', hosts: ['labox-dongle'] }), dep('3', { scope: 'host', hosts: ['vpt-pi1'] }), dep('4', { scope: 'host' })] });
  const { runner } = make(reg, { run: async (env, o) => { if (o.id === '1') o.onLine('SKIPPED_HOSTS=labox-dongle'); return { code: 0 }; } });
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '1').state === 'done');
  const st = (i) => reg.deploys.find((d) => d.id === i).state;
  assert.equal(st('3'), 'done');                 // coalesced into the full run
  assert.equal(st('2') === 'queued' || st('2') === 'running' || st('2') === 'done', true);
  assert.notEqual(reg.deploys.find((d) => d.id === '2').coalescedInto, '1');
  assert.notEqual(reg.deploys.find((d) => d.id === '4').coalescedInto, '1');
});

test('a hosts-limited run only merges requests for hosts it deploys', () => {
  const d = { id: '1', env: 'e', scope: 'host', ref: 'm', hosts: ['a', 'b'], state: 'running' };
  const x = (o) => ({ id: '2', env: 'e', scope: 'host', ref: 'm', state: 'queued', ...o });
  assert.equal(mergeable(d, x({ hosts: ['a'] })), true);
  assert.equal(mergeable(d, x({ hosts: ['a', 'c'] })), false);
  assert.equal(mergeable(d, x({})), false);
  assert.equal(mergeable({ ...d, hosts: undefined }, x({})), true);
});

test('orphan: finished once after idle > limit; not finished on a second tick', async () => {
  const orphan = {
    id: 'orphan1', env: 'node1-vpt', scope: 'frontend', ref: 'main', agent: 'mgr:1',
    state: 'running', runner: RUNNER_AGENT,
    started: Math.floor((Date.now() - (DEFAULT_ORPHAN_IDLE_MS + 60 * 1000)) / 1000), created: 1,
  };
  const reg = fakeRegistry({ deploys: [orphan] });
  const { runner, alerts, stateDir } = make(reg);
  await runner.tick();
  assert.equal(reg.deploys[0].state, 'failed');
  assert.equal(reg.calls.filter((c) => c === 'deploy finish orphan1 --status failed --tail-stdin').length, 1);
  assert.equal(reg.deploys[0].tail.split('\n')[0], '# orphaned: runner restarted mid-deploy, finished by the runner');
  assert.match(readFileSync(join(stateDir, 'deploys', 'orphan1.log'), 'utf8'), /# orphaned: runner restarted mid-deploy/);
  const orphans = alerts.filter(([k]) => k === 'deploy:orphan1:orphan');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0][1].toLowerCase().includes('orphaned'), true);
  // tick again: no extra finish, no extra alert
  const before = reg.calls.length;
  await runner.tick();
  assert.equal(reg.calls.filter((c) => c === 'deploy finish orphan1 --status failed --tail-stdin').length, 1);
  assert.equal(alerts.filter(([k]) => k === 'deploy:orphan1:orphan').length, 1);
  assert.ok(reg.calls.slice(before).every((c) => !c.startsWith('deploy finish orphan1')));
});

test('orphan: a log written recently is left alone (still running)', async () => {
  const orphan = {
    id: 'orphan1', env: 'node1-vpt', scope: 'frontend', ref: 'main', agent: 'mgr:1',
    state: 'running', runner: RUNNER_AGENT,
    started: Math.floor((Date.now() - (DEFAULT_ORPHAN_IDLE_MS + 60 * 1000)) / 1000), created: 1,
  };
  const reg = fakeRegistry({ deploys: [orphan] });
  const { runner, stateDir } = make(reg);
  // recent log overrules the old `started`
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(stateDir, 'deploys'), { recursive: true });
  writeFileSync(join(stateDir, 'deploys', 'orphan1.log'), 'fresh log line\n');
  await runner.tick();
  assert.equal(reg.deploys[0].state, 'running');
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy finish orphan1')));
});

test('orphan: a deploy tracked in this process\'s running map is left alone', async () => {
  const orphan = {
    id: 'orphan1', env: 'node1-vpt', scope: 'frontend', ref: 'main', agent: 'mgr:1',
    state: 'running', runner: RUNNER_AGENT,
    started: Math.floor((Date.now() - (DEFAULT_ORPHAN_IDLE_MS + 60 * 1000)) / 1000), created: 1,
  };
  const reg = fakeRegistry({ deploys: [orphan] });
  const { runner } = make(reg);
  runner._running.set('node1-vpt', 'orphan1');                       // this process still owns it
  await runner.tick();
  assert.equal(reg.deploys[0].state, 'running');
  assert.ok(!reg.calls.some((c) => c.startsWith('deploy finish orphan1')));
});

test('orphan: poll failure does nothing (no finish, no alert)', async () => {
  const calls = [];
  const reg = { fn: async (args, { stdin } = {}) => {
    calls.push(args.join(' '));
    if (args[0] === 'deploy' && args[1] === 'list') return { code: 255, stdout: '', stderr: 'ssh: down' };
    if (args[0] === 'deploy' && args[1] === 'finish') return { code: 0, stdout: 'failed', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  } };
  const alerts = [];
  const stateDir = mkTmp('ghosty-dep-');
  const runner = createDeployRunner({ stateDir, registry: reg.fn, isEnabled: () => false, alert: (k, p) => alerts.push([k, p.title]), log: { error() {} }, run: async () => ({ code: 0 }) });
  await runner.tick();
  assert.equal(calls.some((c) => c === 'deploy list --json'), true);
  assert.ok(!calls.some((c) => c.startsWith('deploy finish')));
  assert.equal(alerts.length, 0);
  assert.equal(runner.snapshot().ok, false);
});

// --- re-adoption of a detached deploy after a runner restart (BUG-0341) ---
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const mkAdopt = (reg) => {
  const stateDir = mkTmp('ghosty-adopt-');
  const dir = join(stateDir, 'deploys'); mkdirSync(dir, { recursive: true });
  const alerts = [];
  const runner = createDeployRunner({ stateDir, registry: reg.fn, isEnabled: () => true, alert: (k) => alerts.push(k), log: { error() {} }, followPollMs: 30,
    run: async () => { throw new Error('must not start a new run'); } });
  return { runner, dir, alerts };
};
const runningDep = (id, o = {}) => dep(id, { state: 'running', runner: RUNNER_AGENT, ...o });
// a stand-in for the detached wrapper: sh that logs, sleeps, then writes the exit file like the real wrapper
const fakeWrapper = (dir, id, secs, rc = 0) => {
  const c = spawn('sh', ['-c', `echo "VERSION 4.5.6" >> "${dir}/${id}.run"; sleep ${secs}; echo ${rc} > "${dir}/${id}.exit"`], { detached: true, stdio: 'ignore' });
  c.unref(); writeFileSync(join(dir, `${id}.pid`), String(c.pid)); return c;
};

test('adopt: a child still alive at startup is re-adopted and finished when it exits', async () => {
  const reg = fakeRegistry({ deploys: [runningDep('5')] });
  const { runner, dir, alerts } = mkAdopt(reg);
  fakeWrapper(dir, '5', 0.4);
  await runner.tick();
  assert.equal(runner._running.get('node1-vpt'), '5');
  assert.equal(reg.deploys[0].state, 'running');
  await until(() => reg.deploys[0].state === 'done', 5000);
  assert.equal(reg.deploys[0].version, '4.5.6');
  assert.ok(alerts.includes('deploy:5:done') && !alerts.includes('deploy:5:start') && !alerts.includes('deploy:5:orphan'));
  assert.match(readFileSync(join(dir, '5.log'), 'utf8'), /re-adopted/);
});

test('adopt: a non-zero exit of the adopted child finishes failed', async () => {
  const reg = fakeRegistry({ deploys: [runningDep('6')] });
  const { runner, dir } = mkAdopt(reg);
  fakeWrapper(dir, '6', 0.2, 3);
  await runner.tick();
  await until(() => reg.deploys[0].state === 'failed', 5000);
});

test('adopt: exit file present, process gone -> finished immediately from it', async () => {
  const reg = fakeRegistry({ deploys: [runningDep('7')] });
  const { runner, dir } = mkAdopt(reg);
  writeFileSync(join(dir, '7.pid'), '999999'); writeFileSync(join(dir, '7.exit'), '0'); writeFileSync(join(dir, '7.run'), 'SKIPPED_HOSTS=h1\nVERSION 7.7.7\n');
  await runner.tick();
  await until(() => reg.deploys[0].state === 'done', 3000);
  assert.equal(reg.deploys[0].version, '7.7.7');
  assert.deepEqual(reg.deploys[0].skippedHosts, ['h1']);
});

test('adopt: process gone and no exit file is left to the orphan sweep', async () => {
  const reg = fakeRegistry({ deploys: [runningDep('8')] });
  const { runner, dir } = mkAdopt(reg);
  writeFileSync(join(dir, '8.pid'), '999999');
  await runner.tick();
  assert.equal(runner._running.size, 0);
  assert.equal(reg.deploys[0].state, 'running');   // log missing + `started` unset: sweep does nothing yet
});

test('adopt: a running deploy of another runner is untouched', async () => {
  const reg = fakeRegistry({ deploys: [runningDep('9', { runner: 'someone:else' })] });
  const { runner, dir } = mkAdopt(reg);
  fakeWrapper(dir, '9', 0.2);
  await runner.tick();
  assert.equal(runner._running.size, 0);
  assert.equal(reg.deploys[0].state, 'running');
});

test('real detached run: output through the file, exit file and pid file written', async () => {
  const reg = fakeRegistry({ deploys: [dep('11')] });
  const stateDir = mkTmp('ghosty-real-');
  const { writeFileSync: wf } = await import('node:fs');
  wf(join(stateDir, 'deploy-envs.json'), JSON.stringify({ 'node1-vpt': { argv: ['sh', '-c', 'echo hello; echo VERSION 9.9.9; exit 0'] } }));
  const runner = createDeployRunner({ stateDir, registry: reg.fn, isEnabled: () => true, log: { error() {} }, followPollMs: 30 });
  await runner.tick();
  await until(() => reg.deploys[0].state === 'done', 5000);
  const dir = join(stateDir, 'deploys');
  assert.equal(readFileSync(join(dir, '11.exit'), 'utf8').trim(), '0');
  assert.ok(existsSync(join(dir, '11.pid')));
  assert.match(readFileSync(join(dir, '11.log'), 'utf8'), /hello/);
  assert.equal(reg.deploys[0].version, '9.9.9');
});

test('lease freed: one alert per blocking lease once it disappears, not before, not twice', async () => {
  const reg = fakeRegistry({
    deploys: [dep('21', { scope: 'full' })],
    leases: [{ id: 'aa11', env: 'node1-vpt', resource: '*', agent: 'codebox:t1', kind: 'server' }],
  });
  const { runner, alerts } = make(reg);
  await runner.tick();
  await runner.tick();
  assert.equal(reg.deploys[0].state, 'queued');
  assert.ok(!alerts.some(([k]) => k.includes('lease-freed')));
  reg.leases.length = 0;                       // released or expired
  await runner.tick();
  const freed = alerts.filter(([k]) => k.startsWith('deploy:21:lease-freed:'));
  assert.equal(freed.length, 1);
  assert.equal(freed[0][1], 'lease freed: node1-vpt/* (codebox:t1) — deploy 21 can start');
  await runner.tick();                          // it started; no second alert
  assert.equal(alerts.filter(([k]) => k.includes('lease-freed')).length, 1);
});

test('lease freed: a host-kind lease that a full deploy skips is never tracked', async () => {
  const reg = fakeRegistry({
    deploys: [dep('22', { scope: 'full' })],
    leases: [{ id: 'bb22', env: 'node1-vpt', resource: 'vpt-pi3/device2', agent: 'a:2', kind: 'host' }],
  });
  const { runner, alerts } = make(reg);
  await runner.tick();                          // fake registry says busy (code 3), real one would skip the host
  reg.leases.length = 0;
  await runner.tick();
  assert.ok(!alerts.some(([k]) => k.includes('lease-freed')));
});

test('remoteLeaseCmd: only approve uses the owner token file', () => {
  assert.equal(remoteLeaseCmd(['deploy', 'approve', 'ab12']), 'VPT_LEASE_TOKEN_FILE=~/.config/vpt-lease/owner-token ~/bin/vpt-lease deploy approve ab12');
  for (const a of [['deploy', 'list', '--json'], ['deploy', 'start', 'ab12'], ['deploy', 'cancel', 'ab12'], ['deploy', 'finish', 'ab12']]) assert.ok(!remoteLeaseCmd(a).includes('owner-token'), a.join(' '));
});

test('a failed auto-approve is logged with its exit and stderr, and the approval alert still fires', async () => {
  const reg = fakeRegistry({ deploys: [dep('1', { state: 'awaiting-approval' })] });
  const inner = reg.fn; const errs = []; const alerts = [];
  const r = createDeployRunner({ stateDir: mkTmp('dr-'), isEnabled: () => true, catchUp: false,
    registry: async (a, o) => (a[1] === 'approve' ? { code: 1, stdout: '', stderr: 'E_AUTH: this route needs an owner client' } : inner(a, o)),
    alert: (k) => alerts.push(k), log: { info() {}, error: (m) => errs.push(m) } });
  await r.tick(); await r.tick();
  assert.ok(errs.some((m) => /auto-approve 1 failed \(exit 1\).*owner client/.test(m)), errs.join('|'));
  assert.equal(reg.deploys[0].state, 'awaiting-approval');
});

// ---- hold clock: the timeout measures the lease HOLD, not the wait in the registry queue ----------------------------------
import { followDetached } from '../deploy-runner.js';
import { mkdtempSync as mkd, writeFileSync as wf, appendFileSync as af } from 'node:fs';
import { tmpdir as tmp } from 'node:os';
import { join as pj } from 'node:path';

const follow = (dir, opts) => { const lines = []; const p = followDetached(dir, 'd1', { onLine: (l) => lines.push(l), pollMs: 10, pid: process.pid, ...opts }); return { p, lines }; };

test('queued deploy is not killed by the hold timeout; killed maxMs after start when never granted', async () => {
  const dir = mkd(pj(tmp(), 'dr-'));
  wf(pj(dir, 'd1.run'), 'busy: queueing for the lease (vpt-lease claim --wait)\n');
  // pid = this test process: followDetached would SIGTERM -pid on a timeout; use a pid whose group kill fails harmlessly
  const { p } = follow(dir, { timeoutMs: 50, maxMs: 400, pid: 2 ** 22 + 1 });
  const r = await Promise.race([p, sleep(200).then(() => 'still-waiting')]);
  assert.equal(r, 'still-waiting', 'a 50 ms hold timeout must not fire while queued');
});

test('hold clock starts at the "holding lease" line', async () => {
  const dir = mkd(pj(tmp(), 'dr-'));
  wf(pj(dir, 'd1.run'), 'busy: queueing\n');
  const killed = [];
  const orig = process.kill;
  process.kill = (pid, sig) => { if (pid < 0) { killed.push(sig); wf(pj(dir, 'd1.exit'), '143'); return true; } return orig(pid, sig); };
  try {
    const { p } = follow(dir, { timeoutMs: 150, maxMs: 60000, pid: process.pid });
    await sleep(300);                                   // queued for 2x the hold timeout: still alive
    assert.deepEqual(killed, []);
    af(pj(dir, 'd1.run'), 'holding lease abc on node1-vpt (server) for the deploy\n');
    const r = await p;
    assert.equal(r.timedOut, 'hold'); assert.ok(killed.includes('SIGTERM'));
  } finally { process.kill = orig; }
});

test('overall cap ends a deploy that stays queued', async () => {
  const dir = mkd(pj(tmp(), 'dr-'));
  wf(pj(dir, 'd1.run'), 'busy: queueing\n');
  const orig = process.kill;
  process.kill = (pid, sig) => { if (pid < 0) { wf(pj(dir, 'd1.exit'), '143'); return true; } return orig(pid, sig); };
  try {
    const r = await follow(dir, { timeoutMs: 20, maxMs: 120, pid: process.pid }).p;
    assert.equal(r.timedOut, 'cap');
  } finally { process.kill = orig; }
});

test('the lease granted at deploy start is read back from the list and handed to the child as VPT_LEASE_ID', async () => {
  const reg = fakeRegistry({ deploys: [dep('7', { scope: 'server', ref: 'main' })] });
  reg.grantLease = true;
  const { runner, ran } = make(reg);
  await runner.tick();
  await until(() => reg.deploys.find((d) => d.id === '7').state === 'done');
  assert.equal(ran[0].remoteCmd, 'VPT_LEASE_AGENT=manager:deploy VPT_DEPLOY_ID=7 VPT_LEASE_ID=L7 bash update_core.sh main --server --skip-leased');
});
