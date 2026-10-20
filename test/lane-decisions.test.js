// Lane decisions (delivery-gate review findings 5, 6, 22, 24): verdict + deploy journal records, the repo opt-out in the lane's
// own evaluation, the lane revert, no redeploy of an already-merged branch, the self deploy pinned to the tested merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createIntegrationLane, createDefaultGit } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { git } from './helpers-git.js';

const until = async (fn) => { const end = Date.now() + 30000; while (Date.now() < end) { if (fn()) return; await tick(); } throw new Error('timed out'); };
const tick = () => new Promise((r) => setTimeout(r, 1));
const tmp = () => mkdtempSync(join(homedir(), 'tmp-lane-dec-'));
const BASE = { 'server.js': 'export const up = 1;\n', 'VERSION.txt': '1\n', 'package.json': '{"type":"module"}\n' };
function mk(w, { key = 'env-a', cfg = {}, lane = {} } = {}) {
  const journal = [], launches = [];
  const l = createIntegrationLane({ stateDir: tmp(), config: { repos: { [key]: w.cfg(cfg) } }, journal: (j) => journal.push(j), pollMs: 1, sleep: tick,
    restart: async (o) => { launches.push(o); return { ok: true }; }, health: async () => true, ...lane }).start();
  return { lane: l, journal, launches, go: async (input) => l.wait(l.enqueue({ repo: key, ...input }).id, 60000) };
}
const selfWorld = () => {
  const w = makeWorld({ name: 'self-repo', base: BASE });
  w.live = join(w.root, 'live'); git(w.root, 'clone', '-q', w.remote, w.live);
  w.liveHead = () => git(w.live, 'rev-parse', 'HEAD').trim();
  return w;
};
const selfCfg = (w) => ({ deploy: { kind: 'self', liveCheckout: w.live, restartWaitMin: 0 } });

test('finding 5: a lane verdict and a self deploy are journaled as decision records', async () => {
  const w = selfWorld(); w.branch('feat', { 'a.js': 'x\n' });
  const m = mk(w, { key: 'me', cfg: selfCfg(w) });
  const r = await m.go({ branch: 'feat', session: 's1' });
  assert.equal(r.state, 'deployed', JSON.stringify(r));
  const mj = m.journal.find((j) => j.kind === 'merge'), dj = m.journal.find((j) => j.kind === 'deploy');
  assert.equal(mj.decision_id, `lane-merge-${r.id}`); assert.equal(mj.chosen, 'merge'); assert.equal(mj.request, r.id); assert.equal(mj.session, 's1'); assert.equal(mj.source, 'integration-lane'); assert.equal(mj.branch, 'feat');
  assert.equal(dj.decision_id, `lane-deploy-${r.id}`); assert.equal(dj.chosen, 'deploy'); assert.equal(dj.sha, r.sha); assert.equal(dj.scope, 'self'); assert.ok(dj.rollback);
  // an escalated verdict is journaled too
  w.branch('bad', { 'b.js': 'y\n' });
  const e = mk(w, { key: 'me', cfg: selfCfg(w), lane: { mergeEval: async () => ({ verdict: 'escalate', reasons: ['too risky'] }) } });
  const x = await e.go({ branch: 'bad' });
  assert.equal(x.state, 'returned'); assert.equal(e.journal.length, 1); assert.equal(e.journal[0].chosen, 'escalate'); assert.deepEqual(e.journal[0].reasons, ['too risky']);
});

test('finding 6: the per-repo mergeOptOut reaches the lane evaluation', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const before = w.main();
  const m = mk(w, { lane: { mergeEval: undefined, mergeOptOut: () => ['demo-repo'] } });
  const r = await m.go({ branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /opted out of manager merge decisions/); assert.equal(w.main(), before);
  const ok = mk(w, { lane: { mergeEval: undefined, mergeOptOut: () => [] } });
  assert.equal((await ok.go({ branch: 'feat' })).state, 'merged');
});

test('finding 22: a lane revert undoes the merge commit through the lane (no session needed)', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const m = mk(w);
  const r = await m.go({ branch: 'feat', session: 'gone' });
  assert.equal(r.state, 'merged'); assert.equal(w.show('main', 'new.js'), 'x\n');
  const q = m.lane.revert(r.id, { by: 'owner' });
  const v = await m.lane.wait(q.id, 60000);
  assert.equal(v.state, 'merged', JSON.stringify(v)); assert.equal(v.revertOf, r.mergeSha);
  assert.throws(() => git(w.root, '--git-dir', w.remote, 'show', 'main:new.js'), /exists on disk|does not exist|fatal/);
  assert.equal(git(w.remote, 'rev-list', '--parents', '-n1', 'main').trim().split(' ').length, 2, 'a plain revert commit');
  assert.throws(() => m.lane.revert(v.id), /no merge commit of its own/);
  assert.throws(() => m.lane.revert('int-nope'), /unknown request/);
});

test('finding 24: re-requesting an already-merged branch does not redeploy unless --deploy is explicit', async () => {
  const w = selfWorld(); w.branch('feat', { 'a.js': 'x\n' });
  const m = mk(w, { key: 'me', cfg: selfCfg(w) });
  const first = await m.go({ branch: 'feat' });
  assert.equal(first.state, 'deployed');
  await until(() => m.launches.length === 1);
  const again = await m.go({ branch: 'feat' });
  assert.equal(again.state, 'merged', JSON.stringify(again)); assert.equal(again.alreadyMerged, true); await new Promise((r) => setTimeout(r, 100)); assert.equal(m.launches.length, 1, 'no second restart');
  assert.equal(m.journal.filter((j) => j.kind === 'deploy').length, 1);
  // the first restart has finished (else the forced deploy coalesces onto it): then --deploy launches a new one
  mkdirSync(dirname(first.selfDeploy.exit), { recursive: true }); writeFileSync(first.selfDeploy.exit, '0\n');
  const forced = await m.go({ branch: 'feat', deploy: true });
  assert.equal(forced.state, 'deployed'); await until(() => m.launches.length === 2);
});

test('finding 24: the self deploy pulls exactly the tested merge, not a newer main; a rewritten main is refused', async () => {
  const w = selfWorld(); w.branch('feat', { 'a.js': 'x\n' });
  const real = createDefaultGit();
  let moved = false;
  const wrapped = async (args, o) => { if (!moved && o?.cwd === w.live && args[0] === 'fetch') { moved = true; w.moveMain({ 'later.js': 'untested\n' }); } return real(args, o); };
  const m = mk(w, { key: 'me', cfg: selfCfg(w), lane: { git: wrapped } });
  const r = await m.go({ branch: 'feat' });
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.ok(moved);
  assert.equal(w.liveHead(), r.sha, 'the live checkout is at the tested merge'); assert.notEqual(w.main(), r.sha, 'main moved on');
  // origin/main rewound past the tested merge: refused, nothing restarted
  const w2 = selfWorld(); const base = w2.main(); w2.branch('feat', { 'a.js': 'x\n' });
  let rewound = false;
  const wrap2 = async (args, o) => { if (!rewound && o?.cwd === w2.live && args[0] === 'fetch') { rewound = true; git(w2.dev, 'push', '-q', '-f', 'origin', `${base}:main`); } return real(args, o); };
  const m2 = mk(w2, { key: 'me', cfg: selfCfg(w2), lane: { git: wrap2 } });
  const r2 = await m2.go({ branch: 'feat' });
  assert.equal(r2.state, 'deploy_failed'); assert.match(r2.reason, /could not fast-forward/); assert.equal(m2.launches.length, 0); assert.equal(w2.liveHead(), base);
});
