// Coalescing and the settle window (2026-10-20): a session that pushes commit after commit and re-requests its branch must not make
// the lane merge it several times in a row (one branch merged 3 times in 3 minutes, restarting the target CI each time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationLane, validateConfig, DEFAULT_SETTLE_MS } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { git } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

const mk = (w, o = {}) => {
  const stateDir = o.stateDir || tmp('lane-coalesce-');
  const events = [];
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg(o.cfg) } }, notify: (r, e) => events.push({ id: r.id, ...e }),
    pollMs: 5, sleep: () => new Promise((r) => setTimeout(r, 1)), ...o.lane });
  lane.start();
  return { lane, stateDir, events };
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(2); }
  throw new Error('condition not met in time');
}

test('two requests for the same branch while queued coalesce into one entry with the newest tip', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  const { lane, events } = mk(w, { cfg: { settleMs: 5000 } });       // long window: the first request stays queued
  const first = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', note: 'first note' });
  assert.equal(lane.get(first.id).state, 'queued');
  // the session pushes again and re-requests
  w.branch('feat', { 'a.js': '1\n', 'b.js': '2\n' });
  const tip = git(w.remote, 'rev-parse', 'feat').trim();
  const second = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', note: 'second note', sha: tip });

  assert.equal(second.id, first.id, 'the queued request is updated, not duplicated');
  assert.equal(second.coalesced, true);
  assert.equal(second.position, 1, 'the queue position is kept');
  assert.equal(lane.list({ repo: 'env-a' }).length, 1, 'one entry only');
  const r = lane.get(first.id);
  assert.equal(r.coalesced, 1);
  assert.equal(r.head, tip, 'the newest tip is recorded');
  assert.match(r.note, /first note/); assert.match(r.note, /second note/, 'the notes are merged');
  assert.ok(events.some((e) => e.kind === 'coalesced'));
  lane.stop();
});

test('a request for a branch whose request is running becomes a second entry, marked to follow it', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  let block = null;
  const run = (cmd) => block ? new Promise((resolve) => { block.push(resolve); }) : Promise.resolve({ code: 0, out: '' });
  const { lane } = mk(w, { cfg: { settleMs: 0 }, lane: { run } });
  const first = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1' });
  await until(() => { block = block || []; return lane.get(first.id).state === 'running'; });

  const second = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1' });
  assert.notEqual(second.id, first.id, 'a running request is never coalesced into');
  assert.equal(second.coalesced, undefined);
  assert.equal(lane.get(second.id).afterId, first.id, 'marked to start no earlier than the running one ends');
  assert.equal(lane.get(first.id).state, 'running');

  // the lane is serial per repo: the second entry starts only after the first finished
  block.forEach((go) => go({ code: 0, out: '' }));
  await until(() => ['running', 'merged'].includes(lane.get(second.id).state), 20000);
  assert.equal(lane.get(first.id).state, 'merged', 'the first request finished before the second started');
  assert.ok(lane.get(second.id).startedAt >= lane.get(first.id).startedAt);
  lane.stop();
});

test('a queued request waits out its settle window, and a coalesce restarts it', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  const { lane } = mk(w, { cfg: { settleMs: 700 } });
  const base = w.main();
  const q = lane.enqueue({ repo: 'env-a', branch: 'feat' });
  await tick(300);
  assert.equal(lane.get(q.id).state, 'queued', 'not picked while the window is open');
  assert.equal(w.main(), base, 'nothing merged yet');

  await tick(350);                                   // 650 ms in: the first window would have ended
  const again = lane.enqueue({ repo: 'env-a', branch: 'feat' });
  assert.equal(again.id, q.id);
  await tick(300);                                   // 300 ms into the restarted window
  assert.equal(lane.get(q.id).state, 'queued', 'a coalesce restarts the window');

  const r = await lane.wait(q.id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  lane.stop();
});

test('settleMs 0 picks a queued request at once', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  const { lane } = mk(w, { cfg: { settleMs: 0 } });
  const q = lane.enqueue({ repo: 'env-a', branch: 'feat' });
  assert.equal(lane.get(q.id).settleUntil, null, 'no settle window');
  const r = await lane.wait(q.id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  lane.stop();
});

test('different branches never coalesce', async () => {
  const w = makeWorld(); w.branch('one', { 'a.js': '1\n' }); w.branch('two', { 'b.js': '2\n' });
  const { lane } = mk(w, { cfg: { settleMs: 5000 } });
  const a = lane.enqueue({ repo: 'env-a', branch: 'one' }), b = lane.enqueue({ repo: 'env-a', branch: 'two' });
  const again = lane.enqueue({ repo: 'env-a', branch: 'two' });
  assert.notEqual(a.id, b.id);
  assert.equal(again.id, b.id, 'the second branch coalesces only with itself');
  assert.equal(lane.list({ repo: 'env-a' }).length, 2);
  assert.equal(lane.get(b.id).position, 2);
  lane.stop();
});

test('a coalesce keeps the wider deploy scope and takes the newest manager flags', async () => {
  const w = makeWorld(); w.branch('feat', { 'a.js': '1\n' });
  const { lane } = mk(w, { cfg: { settleMs: 5000, deploy: { env: 'env-a', defaultScope: 'full' } } });
  const first = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', deploy: 'frontend', note: 'n1' });
  const narrow = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', deploy: 'server', approvedBy: 'manager' });
  assert.equal(narrow.id, first.id);
  assert.equal(lane.get(first.id).deployScope, 'server', 'the wider scope wins');

  const wide = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', deploy: 'full', migrationApplied: true });
  assert.equal(wide.id, first.id);
  const r = lane.get(first.id);
  assert.equal(r.deployScope, 'full');
  assert.equal(r.deployExplicit, true);
  assert.equal(r.migrationApplied, true);
  assert.equal(r.approvedBy, undefined, 'the newest request did not carry an approval');

  const approved = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1', approvedBy: 'manager-2' });
  assert.equal(approved.id, first.id);
  assert.equal(lane.get(first.id).approvedBy, 'manager-2', 'the newest --approved-by wins');
  lane.stop();
});

test('settleMs config: global default, per repo override, invalid values dropped', () => {
  const g = validateConfig({ settleMs: 1500, repos: { a: { clone: '/x' }, b: { clone: '/x', settleMs: 0 } } });
  assert.equal(g.settleMs, 1500);
  assert.equal(g.repos.a.settleMs, undefined, 'absent stays absent (the global or the default applies)');
  assert.equal(g.repos.b.settleMs, 0, '0 is a valid value');
  const bad = validateConfig({ settleMs: -1, repos: { c: { clone: '/x', settleMs: 3_600_001 }, d: { clone: '/x', settleMs: 'x' } } });
  assert.deepEqual(Object.keys(bad.repos), []);
  assert.equal(bad.settleMs, null);
  assert.equal(bad.errors.length, 3);
  assert.equal(DEFAULT_SETTLE_MS, 60000);
});