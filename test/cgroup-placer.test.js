import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, isLaneHeavy, isStaleScopeError, plan, scopeName, SLICES, sourceOf, blind, LANE_SCOPE, DEFAULT_SOURCE } from '../scripts/cgroup-placer.js';

test('isTest judges argv shape, not prompt text', () => {
  for (const c of ['npm test', '/usr/bin/node /usr/local/bin/npm test', 'npm ci --no-audit', 'npm run test',
    'node --test --test-timeout=300000 test/a.test.js', '/x/bin/node --test-coverage-functions=0 --test-force-exit /r/test/b.test.js',
    'sh -c npm ci --no-audit --no-fund && npm test', '/bin/bash -c source s.sh && eval \'cd w && npm test 2>&1 | tail -40\'',
    'python3 -m pytest -q', 'npx playwright test', 'node node_modules/.bin/tsc --noEmit -p .', '/usr/local/bin/vpt-tsc ./node_modules/.bin/tsc --noEmit', 'tesseract a.png out -l deu']) assert.equal(isTest(c), true, c);
  for (const c of ['claude --dangerously-skip-permissions', 'node server.js', 'npm start',
    'node /x/cli.js exec --prompt run npm test then commit', 'timeout 40m mcode exec --prompt npm test', 'bash -l', 'node --inspect app.js', 'claude --prompt run tsc --noEmit'])
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

test('sourceOf: the cgroup of the tmux server, an override wins, a fallback when nothing is readable', () => {
  const cg = { 10: '/system.slice/ghosty-base-session.service', 11: '/codebox.slice/codebox-core.slice/x.scope' };
  assert.equal(sourceOf([10], (p) => cg[p] || ''), 'system.slice/ghosty-base-session.service');
  assert.equal(sourceOf([11, 10], (p) => cg[p] || ''), 'system.slice/ghosty-base-session.service', 'a tmux pid already inside a codebox slice is not the source');
  assert.equal(sourceOf([], () => ''), DEFAULT_SOURCE);
  process.env.CGROUP_SOURCE = 'system.slice/forced.service';
  try { assert.equal(sourceOf([10], (p) => cg[p] || ''), 'system.slice/forced.service'); } finally { delete process.env.CGROUP_SOURCE; }
});

test('blind: panes exist but none of their processes is in the watched cgroups', () => {
  assert.equal(blind(new Map([[20, 'a']]), new Map([[99, {}]])), true);
  assert.equal(blind(new Map([[20, 'a']]), new Map([[20, {}]])), false);
  assert.equal(blind(new Map(), new Map()), false);
});

test('plan: the lane service keeps its server, only its test-shaped processes go to cb-lane.scope; ghosty is core', () => {
  const lane = '/system.slice/ghosty-sessions.service';
  const procs = new Map([
    [1000, { ppid: 1, cmd: 'node /home/x/ghosty-sessions/server.js', cg: lane, lane: true }],
    [1001, { ppid: 1000, cmd: 'git status', cg: lane, lane: true }],
    [1100, { ppid: 1, cmd: 'node scripts/test-run.js', cg: lane, lane: true }],
    [1101, { ppid: 1100, cmd: 'node --test --test-timeout=300000 a.test.js', cg: lane, lane: true }],
    [1102, { ppid: 1101, cmd: 'node server.js', cg: lane, lane: true }],
    [20, { ppid: 10, cmd: 'bash', cg: '/system.slice/x.service' }],
  ]);
  const got = Object.fromEntries(plan(procs, new Map([[20, 'ghosty']]), new Set()).map((m) => [m.pid, `${m.slice}/${m.scope}`]));
  assert.deepEqual(got, { 1101: `${SLICES.tests}/${LANE_SCOPE}`, 1102: `${SLICES.tests}/${LANE_SCOPE}`, 20: `${SLICES.core}/cb-ghosty.scope` });
  procs.get(1101).cg = `/${SLICES.tests}/${LANE_SCOPE}`; procs.get(1102).cg = `/${SLICES.tests}/${LANE_SCOPE}`;
  procs.delete(20);
  assert.deepEqual(plan(procs, new Map(), new Set()).map((m) => m.pid), [], 'already placed: nothing moves again');
});

test('plan: the lane\'s UI review (vite, esbuild, headless chrome) goes to cb-lane.scope, the dashboard server and git stay', () => {
  const lane = '/system.slice/ghosty-sessions.service';
  const procs = new Map([
    [1000, { ppid: 1, cmd: 'node /home/x/ghosty-sessions/server.js', cg: lane, lane: true }],
    [1001, { ppid: 1000, cmd: 'node /home/x/virtualpytest/frontend/node_modules/.bin/vite --config /tmp/ui-review-gate-ab/base/frontend/vite.config.ts', cg: lane, lane: true }],
    [1002, { ppid: 1001, cmd: '/home/x/virtualpytest/frontend/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.25.12 --ping', cg: lane, lane: true }],
    [1003, { ppid: 1000, cmd: '/home/x/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell --type=renderer', cg: lane, lane: true }],
    [1004, { ppid: 1000, cmd: 'git status', cg: lane, lane: true }],
  ]);
  const got = Object.fromEntries(plan(procs, new Map(), new Set()).map((m) => [m.pid, `${m.slice}/${m.scope}`]));
  assert.deepEqual(got, { 1001: `${SLICES.tests}/${LANE_SCOPE}`, 1002: `${SLICES.tests}/${LANE_SCOPE}`, 1003: `${SLICES.tests}/${LANE_SCOPE}` });
  assert.equal(isLaneHeavy('node server.js'), false); assert.equal(isLaneHeavy('claude --dangerously-skip-permissions'), false);
});

test('isStaleScopeError: the failed-scope answer is recognised, other errors are not', () => {
  assert.equal(isStaleScopeError({ stderr: 'Call failed: Unit cb-tests.scope was already loaded or has a fragment file.' }), true);
  assert.equal(isStaleScopeError(new Error('Access denied')), false);
});
