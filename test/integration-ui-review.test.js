// The UI review gate of the lane: real throwaway git repos, a stand-in reviewer script committed on main, fake deploys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIntegrationLane, validateConfig } from '../integration-lane.js';
import { createNightlyUiReview, parseUiReview, touchesVisual } from '../ui-review-lane.js';
import { createIntegrationNotify, integrationText } from '../integration-notify.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

// Fails when the reviewed tree holds the word BROKEN under frontend/src (pre-merge) or LIVEONLY (after the deploy); CANNOT = no answer.
const GATE = `import sys, pathlib
a = sys.argv[1:]
get = lambda k: a[a.index(k) + 1] if k in a else None
mode, out = a[0], pathlib.Path(get('--out'))
text = ''.join(p.read_text() for p in pathlib.Path(get('--tree') or '.').rglob('*.tsx'))
bad = 'LIVEONLY' if mode == 'live' else 'BROKEN\\n'
if 'CANNOT' in text:
    print('ui-review-gate: cannot uir-1 the preview did not start'); sys.exit(3)
if bad in text:
    (out / 'table.md').write_text('### incidents: FAIL\\n| layout.nothing_cut | FAIL | pill cut by td |\\n')
    print('ui-review-gate: fail uir-1 1 of 1 page(s) got worse: incidents'); sys.exit(1)
print('ui-review-gate: pass uir-1 1 page(s) no worse'); sys.exit(0)
`;
const world = () => makeWorld({ base: { 'src.js': 'a\n', 'VERSION.txt': '1\n', 'scripts/review/ui_review_gate.py': GATE, 'frontend/src/App.tsx': 'ok\n' } });
const uiCfg = (w, extra = {}) => ({ paths: ['^frontend/src/'], from: w.lane, ...extra });
const mk = (w, o = {}) => {
  const stateDir = tmp('lane-state-');
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg({ uiReview: uiCfg(w, o.ui), ...o.cfg }) } },
    pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)), ...o.lane });
  lane.start();
  return lane;
};
const go = async (lane, input) => { const q = lane.enqueue({ repo: 'env-a', ...input }); return lane.wait(q.id, 60000); };
const steps = (r) => r.steps.map((s) => s.name);

test('config: a good block is kept, a bad one is reported and dropped without losing the repo', () => {
  const good = validateConfig({ repos: { a: { clone: '/tmp/x', uiReview: { paths: ['^frontend/'], from: '/tmp/y' } } } });
  assert.equal(good.repos.a.uiReview.ref, 'origin/main');
  const bad = validateConfig({ repos: { a: { clone: '/tmp/x', uiReview: { paths: ['('], from: '/tmp/y' } } } });
  assert.ok(bad.repos.a && !bad.repos.a.uiReview);
  assert.match(bad.errors.join(), /uiReview: invalid path pattern/);
  assert.match(parseUiReview({ paths: ['x'], from: 'rel' }).error, /absolute/);
});

test('visual paths: tests and docs in them do not count', () => {
  const cfg = { paths: ['^frontend/src/'] };
  assert.equal(touchesVisual(cfg, ['backend_server/a.py', 'frontend/src/x.test.tsx', 'frontend/src/README.md']), false);
  assert.equal(touchesVisual(cfg, ['backend_server/a.py', 'frontend/src/x.tsx']), true);
});

test('a graphical change that gets worse is returned with the table; nothing is merged', async () => {
  const w = world(); w.branch('feat', { 'frontend/src/Page.tsx': 'BROKEN\n' });
  const before = w.main();
  const r = await go(mk(w), { branch: 'feat', session: 's1' });
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.equal(r.outcome, 'ui_review');
  assert.equal(w.main(), before, 'main did not move');
  assert.ok(!steps(r).includes('push'));
  const said = integrationText(r);
  assert.match(said, /UI review before the merge/);
  assert.match(said, /pill cut by td/);
  assert.match(said, /Full table and frames: /);
});

test('a pass merges; a backend-only change is never reviewed', async () => {
  const w = world();
  w.branch('good', { 'frontend/src/Page.tsx': 'fine\n' });
  w.branch('back', { 'backend/x.py': 'BROKEN\n' });
  const lane = mk(w);
  const a = await go(lane, { branch: 'good', session: 's1' });
  assert.equal(a.state, 'merged'); assert.equal(a.uiReview.verdict, 'pass'); assert.ok(steps(a).indexOf('ui-review') < steps(a).indexOf('push'));
  const b = await go(lane, { branch: 'back', session: 's2' });
  assert.equal(b.state, 'merged'); assert.ok(!steps(b).includes('ui-review'));
});

test('a review that cannot run is not a pass', async () => {
  const w = world(); w.branch('feat', { 'frontend/src/Page.tsx': 'CANNOT\n' });
  const r = await go(mk(w), { branch: 'feat', session: 's1' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /could not run, so nothing was merged/);
});

test('the branch under review cannot rewrite the reviewer', async () => {
  const w = world();
  w.branch('cheat', { 'scripts/review/ui_review_gate.py': 'print("ui-review-gate: pass uir-0 ok")\n', 'frontend/src/Page.tsx': 'BROKEN\n' });
  const r = await go(mk(w), { branch: 'cheat', session: 's1' });
  assert.equal(r.state, 'returned', JSON.stringify(r.uiReview));
});

test('only the manager waives it, and the request says so', async () => {
  const w = world(); w.branch('feat', { 'frontend/src/Page.tsx': 'BROKEN\n' }); w.branch('feat2', { 'frontend/src/Other.tsx': 'BROKEN\n' });
  const lane = mk(w, { lane: { managerSessions: () => ['manager'] } });
  const no = await go(lane, { branch: 'feat', session: 's1', approvedBy: 'manager' });
  assert.equal(no.state, 'returned');
  const yes = await go(lane, { branch: 'feat2', session: 'manager', approvedBy: 'manager' });
  assert.equal(yes.state, 'merged', JSON.stringify(yes)); assert.equal(yes.uiReview.verdict, 'waived');
});

test('before the reviewer is on main the gate stays out of the way', async () => {
  const w = makeWorld({ base: { 'VERSION.txt': '1\n', 'frontend/src/App.tsx': 'ok\n' } });
  w.branch('feat', { 'frontend/src/Page.tsx': 'BROKEN\n' });
  const r = await go(mk(w), { branch: 'feat', session: 's1' });
  assert.equal(r.state, 'merged'); assert.equal(r.uiReview.verdict, 'absent');
});

test('after a frontend deploy a worse live page hands the request back, and the merge stays', async () => {
  const w = world(); w.branch('feat', { 'frontend/src/Page.tsx': 'LIVEONLY\n' });
  const deploys = { request: async () => ({ id: 'd1' }), wait: async () => ({ ok: true, version: 'v1' }) };
  const lane = mk(w, { ui: { liveScopes: ['frontend'] }, cfg: { deploy: { env: 'env-a', defaultScope: 'frontend' } }, lane: { deploys, journal: () => {} } });
  const r = await go(lane, { branch: 'feat', session: 's1', deploy: 'frontend' });
  assert.equal(r.state, 'returned_after_deploy', JSON.stringify(r));
  assert.equal(w.main(), r.sha);
  assert.match(integrationText(r), /merged .* and deployed, then returned to you[\s\S]*pill cut by td/);
  assert.equal(existsSync(join(w.root, 'nothing')), false);
});

test('what the review sends back goes to the digest and the session, not to the owner', async () => {
  for (const state of ['returned', 'returned_after_deploy']) {
    const fed = [], digested = [], events = [];
    const notify = createIntegrationNotify({ feed: (i) => fed.push(i), digest: (i) => digested.push(i), managerEvent: async (e) => events.push(e),
      status: () => ({ state: 'idle' }), canSend: () => true });
    await notify({ id: `int-${state}`, state, outcome: 'ui_review', session: 's1', branch: 'b', target: 'main', reason: 'UI review' });
    assert.equal(fed.length, 0); assert.equal(digested.length, 1);
    assert.equal(events[0].handled, 'session');
  }
});

test('nightly: once a day after the hour, only a change or a broken run is reported', async () => {
  const stateDir = tmp('nightly-'), told = [], ran = [];
  let verdict = 'pass', now = Date.parse('2026-01-02T02:00:00Z');
  const n = createNightlyUiReview({ stateDir, config: () => ({ repos: { v: { uiReview: { repo: 'virtualpytest' } } } }),
    review: async (cfg, o) => { ran.push(o.mode); return { verdict, summary: 'x', table: '' }; }, event: (e) => told.push(e), now: () => now });
  assert.equal(await n.tick(), null, 'too early');
  now = Date.parse('2026-01-02T03:05:00Z'); await n.tick(); await n.tick();
  assert.deepEqual(ran, ['nightly']); assert.equal(told.length, 0);
  now = Date.parse('2026-01-03T04:00:00Z'); verdict = 'fail'; await n.tick();
  assert.equal(told.length, 1); assert.match(told[0].title, /new problems on key pages/);
  assert.equal(readFileSync(join(stateDir, 'integration', 'ui-review', 'nightly.day'), 'utf8'), '2026-01-03');
});
