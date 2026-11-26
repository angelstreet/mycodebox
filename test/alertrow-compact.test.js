import test from 'node:test';
import assert from 'node:assert/strict';
import { shortRef, leaseHostSummary } from '../public/platforms.js';

const L = (resource, env = 'node1-vpt') => ({ env, resource });

test('shortRef cuts a commit id to 7 characters and leaves branch names alone', () => {
  assert.equal(shortRef('f38c64b4333f3c1ac80356e96fbc87dbca078d3b'), 'f38c64b');
  assert.equal(shortRef('ABCDEF0123456'), 'ABCDEF0');
  assert.equal(shortRef('main'), 'main');
  assert.equal(shortRef('feat/deadbeefcafe'), 'feat/deadbeefcafe');
  assert.equal(shortRef(undefined), '');
});

test('leaseHostSummary groups leases per host in first-seen order', () => {
  assert.equal(leaseHostSummary([L('vpt-mf1/device2'), L('vpt-mf1/device3'), L('vpt-pi1/device6')]), 'mf1 ×2 · pi1');
  assert.equal(leaseHostSummary([L('*', 'stage-env')]), 'stage-env');
  assert.equal(leaseHostSummary([]), '');
});
