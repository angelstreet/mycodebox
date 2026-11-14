// Docs-only fast path (owner 2026-11-14): a merge whose files are all docs waits for neither CI nor a deploy, and a self deploy
// pulls the live checkout without restarting the service. Real throwaway git repos; CI, deploys and the restart are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createIntegrationLane } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { git } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

const tick = () => new Promise((r) => setTimeout(r, 1));
const lane = (w, cfg, extra = {}) => {
  const l = createIntegrationLane({ stateDir: tmp('lane-docs-'), config: { repos: { r: w.cfg(cfg) } }, notify: () => {}, pollMs: 1, sleep: tick, ...extra });
  l.start(); return l;
};
const go = async (l, input) => l.wait(l.enqueue({ repo: 'r', ...input }).id, 60000);
const noDeploy = { request: async () => { throw new Error('a docs-only merge must not deploy'); }, wait: async () => ({}) };
const noCi = { status: async () => { throw new Error('a docs-only merge must not wait for CI'); } };

test('docs-only with --deploy: merged at once, no deploy requested, no CI watched, the reason says why', async () => {
  const w = makeWorld(); w.branch('docs/x', { 'docs/GUIDE.md': '# g\n', 'README.md': 'r\n', 'VERSION.txt': '2\n' });
  const l = lane(w, { ci: 'github', deploy: { env: 'env-a', defaultScope: 'full' } }, { deploys: noDeploy, ci: noCi });
  const r = await go(l, { branch: 'docs/x', deploy: 'host' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(r.docsOnly, true);
  assert.match(r.reason, /docs-only: deploy host skipped/);
  assert.equal(w.main(), r.sha, 'the merge is on the target');
});

test('a code file next to the docs: the deploy runs as before', async () => {
  const w = makeWorld(); w.branch('feat', { 'docs/GUIDE.md': '# g\n', 'new.js': 'x\n' });
  let asked = 0;
  const l = lane(w, { deploy: { env: 'env-a', defaultScope: 'full' } }, { deploys: { request: async () => { asked++; return { id: 'd1' }; }, wait: async () => ({ ok: true, version: 'v1' }) } });
  const r = await go(l, { branch: 'feat', deploy: 'host' });
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.equal(asked, 1); assert.equal(r.docsOnly, undefined);
});

test('self deploy of a docs-only merge: the live checkout is pulled, nothing restarts', async () => {
  const w = makeWorld({ name: 'self-docs', base: { 'server.js': 'export const up = 1;\n', 'VERSION.txt': '1\n', 'package.json': '{"type":"module"}\n' } });
  const live = join(w.root, 'live'); git(w.root, 'clone', '-q', w.remote, live);
  w.branch('docs/y', { 'docs/NOTE.md': 'n\n', 'AGENTS.md': 'a\n' });
  const launches = [];
  const l = lane(w, { deploy: { kind: 'self', liveCheckout: live, restartWaitMin: 0 } }, { restart: async (o) => { launches.push(o); return { ok: true }; }, health: async () => true });
  const r = await go(l, { branch: 'docs/y' });
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.equal(r.docsOnly, true);
  assert.equal(r.selfDeploy.restart, 'skipped'); assert.match(r.selfDeploy.note, /docs-only: pulled, no restart/);
  assert.equal(git(live, 'rev-parse', 'HEAD').trim(), r.sha, 'the live checkout was pulled');
  await tick(); assert.equal(launches.length, 0, 'no restart launched');
  assert.ok(!r.steps.some((s) => s.name === 'deploy-syntax'), 'no syntax check for docs');
});
