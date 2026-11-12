// The deploy gate on a real lease server process-shape (HTTP, real clock): LEASE_TUNE shrinks the 10 min window and the 30 min starvation
// guard to well under a second. A blocked strict catch-up gates lower-priority claims only for the window, then chained P1 claims on two
// devices keep its host busy until the guard closes the gate and the deploy wins the next gap (manager 2026-11-11, vpt-pi1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startLeaseServer } from '../scripts/lease-serve.js';
import { tmp } from './helpers-tmp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('real server, real clock: window then starvation guard, and the blocked deploy starts in the gap', async () => {
  const dir = tmp('lease-starve-');
  const tok = (name, ...a) => execFileSync(process.execPath, ['scripts/lease-token.js', 'add', name, '--dir', dir, ...a], { encoding: 'utf8' }).trim().split('\n')[0];
  const agentTok = tok('agents'), runnerTok = tok('runner', '--exempt', 'deploy:*');
  const s = startLeaseServer({ dir, port: 0, envs: ['lab'], tune: { deployGateMaxMs: 400, deployStarveMs: 1000, catchUpCooldownMs: 0 }, log: { log() {}, error() {} } });
  try {
    const port = await s.ready;
    const call = async (t, path, body) => (await fetch(`http://127.0.0.1:${port}/api/lease/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const P1 = (agent, dev) => call(agentTok, '/claim', { env: 'lab', resources: [`vpt-pi1/device${dev}`], agent, kind: 'host', priority: 'P1', ttl_min: 30 });
    const lane = { 3: (await P1('agent:p0', 3)).lease, 4: null };
    const t0 = Date.now();                                        // the deploy's own clock starts at the re-arm, before this point
    const r0 = await call(runnerTok, '/deploy/request', { env: 'lab', scope: 'host', ref: 'r', agent: 'deploy:t', hosts: ['vpt-pi1'], approved: true, purpose: 'catch-up for x' });
    assert.ok(r0.id, JSON.stringify(r0));
    await call(runnerTok, '/deploy/start', { id: r0.id, skip_leased: true });
    const fin = await call(runnerTok, '/deploy/finish', { id: r0.id, status: 'done', skipped_hosts: 'vpt-pi1' });
    const q = { id: fin.catchup }; assert.ok(q.id, JSON.stringify(fin));
    assert.equal((await call(runnerTok, '/deploy/start', { id: q.id })).code, 'E_HELD', 'blocked by the P1 lease on device3');
    await sleep(500);                                             // past the 400 ms window: lower-priority claims go ahead
    lane[4] = (await P1('agent:p99', 4)).lease; assert.ok(lane[4], 'P1 on device4 after the window');
    let n = 1, refusedAt = null, started = null;
    for (let step = 0; step < 40 && !started; step++) {
      await sleep(150);
      const dev = step % 2 ? 3 : 4, other = dev === 3 ? 4 : 3;
      if (lane[dev]) await call(agentTok, '/release', { id: lane[dev].id });
      const next = await P1(`agent:p${n++}`, dev);
      if (next.ok) { lane[dev] = next.lease; continue; }
      assert.equal(next.code, 'E_DEPLOY_PENDING', JSON.stringify(next)); refusedAt ??= Date.now() - t0; lane[dev] = null;
      if (!lane[other]) { const st = await call(runnerTok, '/deploy/start', { id: q.id }); if (st.ok) started = Date.now() - t0; }
      else await sleep(200);
    }
    assert.ok(refusedAt >= 1000, `new claims are refused only from the starvation point (+${refusedAt} ms)`);
    assert.ok(started, `the deploy started in a gap (refused at +${refusedAt} ms)`);
  } finally { await s.close(); }
});
