// Cloud branches (owner 2026-11-28, security review): a request queued with `--mac cloud-<label>` carries code written on an
// Anthropic cloud VM; the lane must not install or test it on codebox before a manager approved that exact commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createIntegrationLane, isCloudRequest } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const mk = (w, cfg = {}) => {
  const items = [];
  const lane = createIntegrationLane({ stateDir: tmp('lane-cloud-'), config: { repos: { 'env-a': w.cfg(cfg) } }, notify: () => {},
    managerItem: (it) => items.push(it), journal: () => {}, managerSessions: () => ['manager'],
    pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  lane.start();
  return { lane, items };
};
const go = (lane, input) => lane.wait(lane.enqueue({ repo: 'env-a', ...input }).id, 30000);

test('isCloudRequest: only an external request with a cloud-* label', () => {
  assert.equal(isCloudRequest({ origin: 'external', externalLabel: 'cloud-fix-foo' }), true);
  assert.equal(isCloudRequest({ origin: 'external', externalLabel: 'mac' }), false);
  assert.equal(isCloudRequest({ externalLabel: 'cloud-x' }), false);
  assert.equal(isCloudRequest(null), false);
});

test('a cloud branch is returned for approval and none of its code runs; a manager approval merges it', async () => {
  const w = makeWorld();
  const marker = path.join(tmp('lane-cloud-marker-'), 'ran');
  w.branch('claude/fix-foo', { 'new.js': 'x\n' });
  const { lane, items } = mk(w, { test: `touch ${marker}` });
  const before = w.main();
  const r = await go(lane, { branch: 'claude/fix-foo', session: 'starter', external: 'cloud-fix-foo' });
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.equal(r.outcome, 'needs_approval');
  assert.match(r.reason || r.error || JSON.stringify(r), /cloud branch \(cloud-fix-foo\)/);
  assert.equal(fs.existsSync(marker), false, 'the test command of the branch did not run');
  assert.equal(w.main(), before, 'nothing merged');
  const it = items.find((i) => i.id === r.id);
  assert.ok(it, 'the manager got an item'); assert.match(it.text, /--approved-by manager/); assert.match(it.text, /git diff/);
  const ok = await go(lane, { branch: 'claude/fix-foo', session: 'manager', external: 'cloud-fix-foo', approvedBy: 'manager' });
  assert.equal(ok.state, 'merged', JSON.stringify(ok));
  assert.equal(fs.existsSync(marker), true, 'after the approval the test command ran (the gate, not the config, kept it from running)');
  lane.stop();
});

test('a Mac branch is not gated', async () => {
  const w = makeWorld(); w.branch('feat-mac', { 'new.js': 'x\n' });
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat-mac', session: 'starter', external: 'mac' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  lane.stop();
});
