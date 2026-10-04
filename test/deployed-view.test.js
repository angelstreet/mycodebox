import test from 'node:test';
import assert from 'node:assert/strict';
import { deployedView, agoText, targetLabel } from '../public/deployed.js';

const NOW = 1_800_000_000_000;
const sec = NOW / 1000;
const ent = (o = {}) => ({ at: sec - 3600, ref: 'main', commit: 'abcdef1234567890', version: 'main-1', agent: 'mac:t', status: 'done', ...o });

test('agoText buckets', () => {
  assert.equal(agoText(sec - 10, sec), '10s ago');
  assert.equal(agoText(sec - 600, sec), '10m ago');
  assert.equal(agoText(sec - 7200, sec), '2h ago');
  assert.equal(agoText(sec - 3 * 86400, sec), '3d ago');
  assert.equal(agoText(sec + 50, sec), '0s ago');
});

test('rows: frontend and server first, commit shortened, time ago and who', () => {
  const v = deployedView({ 'node1-vpt': { h1: ent(), server: ent({ version: 'main-2' }), frontend: ent({ version: 'main-3', at: sec - 60 }) } }, NOW);
  assert.equal(v[0].env, 'node1-vpt');
  assert.deepEqual(v[0].rows.map((r) => r.targets[0]), ['frontend', 'server', 'h1']);
  const f = v[0].rows[0];
  assert.deepEqual([f.version, f.ref, f.commit, f.ago, f.by, f.failed], ['main-3', 'main', 'abcdef123', '60s ago', 'mac:t', null]);
});

test('identical hosts fold into one row, different ones do not', () => {
  const v = deployedView({ e: { a: ent(), b: ent({ at: sec - 10 }), c: ent({ version: 'old' }), frontend: ent(), server: ent() } }, NOW);
  const hosts = v[0].rows.filter((r) => !['frontend', 'server'].includes(r.targets[0]));
  assert.deepEqual(hosts.map((r) => r.targets), [['a', 'b'], ['c']]);
  assert.equal(hosts[0].ago, '10s ago');
  assert.equal(v[0].rows.filter((r) => r.targets[0] === 'frontend' || r.targets[0] === 'server').length, 2);   // generic targets never fold
});

test('failed attempt shows when newer, hidden when older than the deployed one', () => {
  const failed = (at) => ({ at, ref: 'feat/x', version: 'v9', agent: 'manager:deploy', status: 'failed' });
  const v = deployedView({ e: { server: ent({ lastAttempt: failed(sec - 60) }), frontend: ent({ lastAttempt: failed(sec - 7200) }) } }, NOW);
  const byT = Object.fromEntries(v[0].rows.map((r) => [r.targets[0], r]));
  assert.deepEqual(byT.server.failed, { ago: '60s ago', version: 'v9', ref: 'feat/x', by: 'manager:deploy' });
  assert.equal(byT.frontend.failed, null);
});

test('never deployed but failed: row without version, backfill flagged', () => {
  const v = deployedView({ e: { frontend: { lastAttempt: { at: sec - 5, version: 'v1', ref: 'x', agent: 'a' } }, server: ent({ source: 'backfill' }) } }, NOW);
  const byT = Object.fromEntries(v[0].rows.map((r) => [r.targets[0], r]));
  assert.equal(byT.frontend.deployed, false);
  assert.equal(byT.frontend.failed.ago, '5s ago');
  assert.equal(byT.server.backfill, true);
});

test('empty / missing input and label', () => {
  assert.deepEqual(deployedView(null, NOW), []);
  assert.deepEqual(deployedView({ e: {} }, NOW), [{ env: 'e', rows: [] }]);
  assert.equal(targetLabel(['a', 'b']), 'a, b');
  assert.equal(targetLabel(['a', 'b', 'c', 'd']), 'a, b +2');
});
