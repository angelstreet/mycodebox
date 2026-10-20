import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, plan, scopeName, SLICES } from '../scripts/cgroup-placer.js';

test('isTest judges argv shape, not prompt text', () => {
  for (const c of ['npm test', '/usr/bin/node /usr/local/bin/npm test', 'npm ci --no-audit', 'npm run test',
    'node --test --test-timeout=300000 test/a.test.js', '/x/bin/node --test-coverage-functions=0 --test-force-exit /r/test/b.test.js',
    'sh -c npm ci --no-audit --no-fund && npm test', '/bin/bash -c source s.sh && eval \'cd w && npm test 2>&1 | tail -40\'',
    'python3 -m pytest -q', 'npx playwright test']) assert.equal(isTest(c), true, c);
  for (const c of ['claude --dangerously-skip-permissions', 'node server.js', 'npm start',
    'node /x/cli.js exec --prompt run npm test then commit', 'timeout 40m mcode exec --prompt npm test', 'bash -l', 'node --inspect app.js'])
    assert.equal(isTest(c), false, c);
});

test('plan: core, sessions, tests, orphans; tmux server and placed processes stay', () => {
  const src = '/system.slice/x.service';
  const procs = new Map([
    [10, { ppid: 1, cmd: 'tmux new-session -d', cg: src }],
    [20, { ppid: 10, cmd: 'bash', cg: src }], [21, { ppid: 20, cmd: 'claude', cg: src }],
    [30, { ppid: 10, cmd: 'bash', cg: src }], [31, { ppid: 30, cmd: 'claude', cg: `/${SLICES.sessions}/${scopeName('w 1')}` }],
    [32, { ppid: 31, cmd: 'bash -c npm test', cg: `/${SLICES.sessions}/${scopeName('w 1')}` }],
    [33, { ppid: 32, cmd: 'node --test a.test.js', cg: src }],
    [40, { ppid: 1, cmd: 'node local-stack.mjs up', cg: src }],
  ]);
  const panes = new Map([[20, 'manager'], [30, 'w 1']]);
  const got = Object.fromEntries(plan(procs, panes, new Set([10])).map((m) => [m.pid, `${m.slice}/${m.scope}`]));
  assert.deepEqual(got, {
    20: `${SLICES.core}/cb-manager.scope`, 21: `${SLICES.core}/cb-manager.scope`,
    30: `${SLICES.sessions}/cb-w_1.scope`,
    32: `${SLICES.tests}/cb-tests.scope`, 33: `${SLICES.tests}/cb-tests.scope`,
    40: `${SLICES.sessions}/cb-orphans.scope`,
  });
});

test('plan never moves an ancestor that lives outside the managed cgroups', () => {
  const procs = new Map([[5, { ppid: 1, cmd: 'sshd', cg: null, outside: true }], [6, { ppid: 5, cmd: 'npm test', cg: '/system.slice/x.service' }]]);
  assert.deepEqual(plan(procs, new Map()).map((m) => m.pid), [6]);
});
