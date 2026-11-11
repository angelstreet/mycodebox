// The website repo (AngelStreetCorp/virtualpytest-website) as a lane repository: key `website`, target master, its own
// test, NO deploy scope (Vercel deploys from master). config/integration-repos/website.json is the entry that is copied
// into <state>/integration.json; this test reads that very file, so a change to it is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationLane, validateConfig } from '../integration-lane.js';
import { git, commit } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

const ENTRY = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'integration-repos', 'website.json'), 'utf8'));
const WEBSITE_ORIGIN = 'git@github.com:AngelStreetCorp/virtualpytest-website.git';

test('the website entry is valid: target master, its tests, no deploy, no CI wait', () => {
  const { repos, errors } = validateConfig({ repos: { website: ENTRY } });
  assert.deepEqual(errors, []);
  const r = repos.website;
  assert.equal(r.target, 'master');
  assert.equal(r.deploy, null);                     // a deploy scope would ask node1 to deploy a static site
  assert.equal(r.ci, null);
  assert.match(r.test, /pytest tests/);             // learn_fit + JSON lint live in tests/
  assert.deepEqual(r.conventions, []);              // the website has no VERSION.txt
  assert.ok(r.testTimeoutMin >= 5, 'the playwright test takes ~100 s');
});

// a website-shaped world: bare remote whose branch is master, a dev clone and the lane clone
function world() {
  const root = tmp('lane-web-'), remote = join(root, 'website.git'), dev = join(root, 'dev'), laneDir = join(root, 'lane');
  mkdirSync(remote);
  git(remote, 'init', '-q', '--bare', '-b', 'master');
  git(root, 'clone', '-q', remote, dev);
  git(dev, 'checkout', '-q', '-b', 'master');
  commit(dev, { 'index.html': '<h1>hi</h1>\n', 'tests/test_site.py': 'def test_ok():\n    pass\n' }, 'base');
  git(dev, 'push', '-q', 'origin', 'master');
  git(root, 'clone', '-q', remote, laneDir);
  const branch = (b, files) => { git(dev, 'checkout', '-q', '-B', b, 'origin/master'); commit(dev, files, `work on ${b}`); git(dev, 'push', '-q', '-f', 'origin', b); git(dev, 'checkout', '-q', 'master'); };
  return { root, remote, dev, laneDir, branch, master: () => git(remote, 'rev-parse', 'master').trim() };
}
const mkLane = (w, test) => {
  const lane = createIntegrationLane({ stateDir: tmp('lane-state-'), config: { repos: { website: { ...ENTRY, clone: w.laneDir, test, settleMs: 0 } } },
    notify: () => {}, pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  lane.start();
  return lane;
};

test('a website branch is merged and pushed to master by the lane, with no deploy', async () => {
  const w = world(); w.branch('feat/page', { 'learn/x.html': 'x\n' });
  const lane = mkLane(w, 'test -f learn/x.html && test -f tests/test_site.py');   // the test runs on the merged tree
  const q = lane.enqueue({ repo: 'website', branch: 'feat/page', session: 's1' });
  const r = await lane.wait(q.id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(w.master(), r.sha);
  assert.equal(git(w.remote, 'show', 'master:learn/x.html'), 'x\n');
  assert.ok(!r.deploy && !r.deployRequestId, 'no deploy requested');
});

test('a red website test returns the request and master does not move', async () => {
  const w = world(); w.branch('feat/bad', { 'learn/y.html': 'y\n' });
  const before = w.master();
  const lane = mkLane(w, 'echo lesson too tall >&2; exit 1');
  const q = lane.enqueue({ repo: 'website', branch: 'feat/bad', session: 's1' });
  const r = await lane.wait(q.id, 30000);
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.equal(w.master(), before);
});

test('a session in a website worktree resolves to the website key from its origin URL', async () => {
  const w = world();
  git(w.laneDir, 'remote', 'set-url', 'origin', WEBSITE_ORIGIN);
  const lane = mkLane(w, null);
  assert.equal(await lane.repoForUrl(WEBSITE_ORIGIN), 'website');
  assert.equal(await lane.repoForUrl('https://github.com/AngelStreetCorp/virtualpytest-website'), 'website');
  assert.equal(await lane.repoForUrl('git@github.com:AngelStreetCorp/virtualpytest.git'), null);
});
