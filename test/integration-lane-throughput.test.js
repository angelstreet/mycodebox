// Lane throughput (owner 2026-11-01): the lane is free for the next request once a merge is pushed; the registry deploy
// (and CI) wait outside the lane, and a later request's deploy carries earlier merges of the same repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationLane, scopeCovers, scopeUnion } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(2); }
  throw new Error('condition not met in time');
}
const mk = (w, deploys, cfg = {}) => {
  const lane = createIntegrationLane({ stateDir: tmp('lane-tp-'), config: { repos: { 'env-a': w.cfg({ deploy: { env: 'env-a', defaultScope: 'server' }, ...cfg }) } },
    deploys, pollMs: 5, sleep: () => tick(1) });
  lane.start();
  return lane;
};

test('the next request is merged while the previous one still waits for its deploy', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  let release; const gate = new Promise((r) => { release = r; });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.sha); return { id: `d${asked.length}` }; }, wait: async () => { await gate; return { ok: true, version: 'v' }; } };
  const lane = mk(w, deploys, { deployCoalesceMs: 0 });
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'server' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'server' });
  await until(() => lane.get(b.id).sha);                         // b is pushed although a's deploy has not returned
  assert.equal(lane.get(a.id).state, 'running');
  assert.equal(lane.get(a.id).step, 'deploy');
  release();
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'deployed');
  assert.equal(asked.length, 2, 'coalescing off: one deploy each');
  assert.ok(asked[0] !== asked[1]);
  await lane.idle(); lane.stop();
});

test('a later request with an equal scope carries the earlier one: one deploy of the latest main', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o); return { id: `d${asked.length}` }; }, wait: async () => ({ ok: true, version: 'v1' }) };
  const lane = mk(w, deploys);
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'server' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'server' });
  await until(() => ['a', 'b'].every((k) => lane.get({ a: a.id, b: b.id }[k]).state === 'deployed'));
  assert.equal(asked.length, 1, 'one deploy');
  assert.equal(asked[0].sha, lane.get(b.id).sha, 'of the latest merge');
  assert.equal(lane.get(a.id).coveredBy, b.id);
  assert.equal(lane.get(a.id).deployed.version, 'v1');
  await lane.idle(); lane.stop();
});

test('a narrower later scope does not cover a wider earlier one', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.scope); return { id: `d${asked.length}` }; }, wait: async () => ({ ok: true, version: 'v' }) };
  const lane = mk(w, deploys);
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'full' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'frontend' });
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'deployed');
  assert.deepEqual(asked.sort(), ['frontend', 'full']);
  await lane.idle(); lane.stop();
});

test('if the covering request is returned, the earlier one deploys itself', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.sha); return { id: 'd1' }; }, wait: async () => ({ ok: true, version: 'v' }) };
  const lane = mk(w, deploys, { test: 'sh -c "test ! -f b.js"' });   // b's tests fail
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'server' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'server' });
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'returned');
  assert.equal(asked.length, 1);
  assert.equal(asked[0], lane.get(a.id).sha);
  assert.equal(lane.get(a.id).coveredBy, undefined);
  await lane.idle(); lane.stop();
});

// bug-51061123: a host deploy does not deploy the frontend or the server target; only full covers all three.
test('scope containment: only full covers other scopes', () => {
  for (const s of ['frontend', 'server', 'host', 'full']) assert.ok(scopeCovers(s, s));
  for (const a of ['frontend', 'server', 'host']) for (const b of ['frontend', 'server', 'host']) if (a !== b) assert.equal(scopeCovers(a, b), false, `${a} must not carry ${b}`);
  for (const b of ['frontend', 'server', 'host']) { assert.ok(scopeCovers('full', b)); assert.equal(scopeCovers(b, 'full'), false); }
  assert.equal(scopeUnion('frontend', 'host'), 'full');
  assert.equal(scopeUnion('server', 'frontend'), 'full');
  assert.equal(scopeUnion('host', 'full'), 'full');
  assert.equal(scopeUnion('server', 'server'), 'server');
});

test('a later host request does not carry an earlier frontend request (bug-51061123)', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.scope); return { id: `d${asked.length}` }; }, wait: async () => ({ ok: true, version: 'v' }) };
  const lane = mk(w, deploys);
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'frontend' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'host' });
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'deployed');
  assert.deepEqual(asked.sort(), ['frontend', 'host'], 'each target gets its own deploy');
  assert.equal(lane.get(a.id).coveredBy, undefined);
  await lane.idle(); lane.stop();
});

test('a later full request still carries an earlier frontend request', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.scope); return { id: `d${asked.length}` }; }, wait: async () => ({ ok: true, version: 'v' }) };
  const lane = mk(w, deploys);
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'frontend' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'full' });
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'deployed');
  assert.deepEqual(asked, ['full']);
  await lane.idle(); lane.stop();
});

test('host after server, host only, full after host: each scope deploys what it names (bug-51061123)', async () => {
  const w = makeWorld(); w.branch('a', { 'a.js': '1\n' }); w.branch('b', { 'b.js': '2\n' }); w.branch('c', { 'c.js': '3\n' });
  const asked = [];
  const deploys = { request: async (o) => { asked.push(o.scope); return { id: `d${asked.length}` }; }, wait: async () => ({ ok: true, version: 'v' }) };
  const lane = mk(w, deploys);
  const a = lane.enqueue({ repo: 'env-a', branch: 'a', deploy: 'server' });
  const b = lane.enqueue({ repo: 'env-a', branch: 'b', deploy: 'host' });
  await until(() => lane.get(a.id).state === 'deployed' && lane.get(b.id).state === 'deployed');
  assert.deepEqual(asked.slice().sort(), ['host', 'server'], 'host after server: server still deploys');
  assert.equal(lane.get(a.id).coveredBy, undefined);
  assert.equal(lane.get(b.id).deployed.scope, 'host', 'host only: scope host');
  const c = lane.enqueue({ repo: 'env-a', branch: 'c', deploy: 'full' });
  await until(() => lane.get(c.id).state === 'deployed');
  assert.equal(lane.get(c.id).deployed.scope, 'full');
  await lane.idle(); lane.stop();
});
