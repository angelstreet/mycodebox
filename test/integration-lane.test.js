// The integration lane against real throwaway git repos (a bare remote + clones); CI, deploys and notify are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIntegrationLane, validateConfig, normalizeRemoteUrl, FINAL } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';

const mk = (w, o = {}) => {
  const stateDir = o.stateDir || mkdtempSync(join(tmpdir(), 'lane-state-'));
  const events = [];
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg(o.cfg) } }, notify: (r, e) => events.push({ id: r.id, state: r.state, ...e }),
    pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)), ...o.lane });
  lane.start();
  return { lane, stateDir, events };
};
const go = async (lane, input, ms = 30000) => { const q = lane.enqueue({ repo: 'env-a', ...input }); return lane.wait(q.id, ms); };

test('clean merge: merged, pushed to the bare remote, every transition notified', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { lane, events } = mk(w);
  const r = await go(lane, { branch: 'feat', session: 's1' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(w.main(), r.sha);
  assert.equal(w.show('main', 'new.js'), 'x\n');
  assert.deepEqual(r.steps.map((s) => s.name).slice(0, 4), ['fetch', 'resolve', 'evaluate', 'worktree']);
  assert.ok(r.steps.every((s) => s.startedAt && s.endedAt));
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'queued'); assert.ok(kinds.includes('running')); assert.equal(kinds.at(-1), 'final');
  assert.equal(events.at(-1).final, true); assert.equal(events.at(-1).state, 'merged');
});

test('red tests: returned with the output tail, target untouched', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const before = w.main();
  const { lane } = mk(w, { cfg: { test: 'echo BOOM-line; echo second >&2; exit 2' } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /tests red \(exit 2\)/);
  assert.match(r.tail, /BOOM-line/); assert.match(r.tail, /second/);
  assert.equal(w.main(), before);
});

test('test timeout is a return, not a hang', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { lane } = mk(w, { cfg: { test: 'sleep 30', testTimeoutMin: 0.01 } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /timed out/);
});

test('conflict outside convention files: returned with the file list (floor and merge step)', async () => {
  const w = makeWorld(); w.branch('feat', { 'src.js': 'export const a = 1;\n' }); w.moveMain({ 'src.js': 'export const a = 2;\n' });
  const before = w.main();
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /conflicts outside convention: src\.js/);
  assert.equal(w.main(), before);
  // with a permissive evaluation the merge step itself reports the files
  const m = mk(w, { lane: { mergeEval: async () => ({ verdict: 'merge', reasons: [] }) } });
  const r2 = await go(m.lane, { branch: 'feat' });
  assert.equal(r2.state, 'returned'); assert.match(r2.reason, /merge conflict outside convention files: src\.js/); assert.deepEqual(r2.conflicts, ['src.js']);
  assert.equal(w.main(), before);
});

test('VERSION.txt conflict: take-target keeps the target file, max-plus-one bumps', async () => {
  for (const [resolver, want] of [['take-target', '3\n'], ['max-plus-one', '4\n']]) {
    const w = makeWorld(); w.branch('feat', { 'VERSION.txt': '2\n', 'new.js': 'n\n' }); w.moveMain({ 'VERSION.txt': '3\n' });
    const { lane } = mk(w, { cfg: { conventionResolver: resolver } });
    const r = await go(lane, { branch: 'feat' });
    assert.equal(r.state, 'merged', `${resolver}: ${JSON.stringify(r)}`);
    assert.equal(w.show('main', 'VERSION.txt'), want, resolver);
    assert.equal(w.show('main', 'new.js'), 'n\n');
  }
});

test('sensitive file: returned by the merge floor, nothing merged', async () => {
  const w = makeWorld(); w.branch('feat', { 'config/credentials.txt': 'x\n' });
  const before = w.main();
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /merge evaluation:.*credentials\.txt/);
  assert.equal(w.main(), before);
});

test('branch missing, or the target itself: returned / refused', async () => {
  const w = makeWorld();
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'nope' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /does not exist/);
  assert.throws(() => lane.enqueue({ repo: 'env-a', branch: 'main' }), /is the target/);
  assert.throws(() => lane.enqueue({ repo: 'env-a', branch: '--upload-pack=x' }), /invalid branch/);
  assert.throws(() => lane.enqueue({ repo: 'env-a', branch: 'a..b' }), /invalid branch/);
  assert.throws(() => lane.enqueue({ repo: 'other', branch: 'x' }), /not configured/);
  assert.throws(() => lane.enqueue({ repo: 'env-a', branch: 'x', deploy: 'full' }), /no deploy configured/);
});

test('target moves during the run: re-merged from the new target, tests run again', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  let runs = 0;
  const run = async () => { runs++; if (runs === 1) w.moveMain({ 'other.js': 'o\n' }); return { code: 0, out: 'ok' }; };
  const evals = [];
  const mergeEval = async (o) => { evals.push(o.remote); return { verdict: 'merge', reasons: [] }; };   // the floor runs again on the moved target, with the lane's remote
  const { lane } = mk(w, { cfg: { test: 'fake' }, lane: { run, mergeEval } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(runs, 2); assert.deepEqual(evals, ['origin', 'origin']);
  assert.equal(w.show('main', 'new.js'), 'x\n'); assert.equal(w.show('main', 'other.js'), 'o\n');
  assert.equal(w.main(), r.sha);
});

test('push is a compare-and-swap: a target rewound after the fetch is not clobbered, the merge is rebuilt on it', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' }); w.moveMain({ 'o.js': 'o\n' });
  const rewound = execFileSync('git', ['-C', w.remote, 'rev-parse', 'main~1']).toString().trim();
  const seen = []; let runs = 0;
  const run = async () => { runs++; if (runs === 1) execFileSync('git', ['-C', w.remote, 'update-ref', 'refs/heads/main', rewound]); else seen.push(w.main()); return { code: 0, out: 'ok' }; };
  const { lane } = mk(w, { cfg: { test: 'fake' }, lane: { run } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(runs, 2); assert.deepEqual(seen, [rewound]);   // the first push did not land on the rewound target
  assert.equal(execFileSync('git', ['-C', w.remote, 'rev-parse', `${r.sha}^1`]).toString().trim(), rewound);
});

test('target keeps moving: returned after three attempts', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  let n = 0;
  const run = async () => { w.moveMain({ [`m${++n}.js`]: 'm\n' }); return { code: 0, out: '' }; };
  const { lane } = mk(w, { cfg: { test: 'fake' }, lane: { run } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /target keeps moving/); assert.equal(n, 3);
});

test('CI red: merged_ci_red, no deploy, merge stays on the target', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const deploys = { request: async () => { throw new Error('must not deploy'); }, wait: async () => ({}) };
  const { lane, events } = mk(w, { cfg: { ci: 'github', deploy: { env: 'env-a', defaultScope: 'server' } }, lane: { ci: { status: async () => 'failure' }, deploys } });
  const r = await go(lane, { branch: 'feat', deploy: 'server' });
  assert.equal(r.state, 'merged_ci_red'); assert.equal(w.main(), r.sha);
  assert.equal(events.at(-1).state, 'merged_ci_red');
});

test('CI pending then green + deploy requested: deployed with the version; argv shape', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const seq = ['missing', 'pending', 'success']; const asked = [], reqs = [];
  const deploys = { request: async (o) => { reqs.push(o); return { id: 'd1' }; }, wait: async (id) => { asked.push(id); return { ok: true, version: 'v9' }; } };
  const { lane } = mk(w, { cfg: { ci: 'github', deploy: { env: 'env-a', defaultScope: 'server' } }, lane: { ci: { status: async (sha) => { asked.push(sha); return seq.shift() || 'success'; } }, deploys } });
  const r = await go(lane, { branch: 'feat', deploy: true });
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.equal(r.deployed.version, 'v9');
  assert.deepEqual(reqs, [{ env: 'env-a', scope: 'server', ref: r.sha, sha: r.sha, agent: `integration:${r.id}` }]);
  assert.equal(asked.filter((x) => x === r.sha).length, 3);
});

test('deploy failure: deploy_failed; no CI configured deploys right after the push', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const deploys = { request: async () => ({ id: 'd2' }), wait: async () => ({ ok: false, reason: 'lease denied' }) };
  const { lane } = mk(w, { cfg: { deploy: { env: 'env-a', defaultScope: 'full' } }, lane: { deploys } });
  const r = await go(lane, { branch: 'feat', deploy: 'frontend' });
  assert.equal(r.state, 'deploy_failed'); assert.match(r.reason, /lease denied/);
});

test('deploy failure with the deploy adapter shape (error/tail): the text reaches reason; bad scopes are rejected early', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const deploys = { request: async () => ({ ok: true, id: 'd3' }), wait: async () => ({ ok: false, state: 'failed', tail: 'lease held by someone', error: 'deploy d3 failed' }) };
  const { lane } = mk(w, { cfg: { deploy: { env: 'env-a', defaultScope: 'full' } }, lane: { deploys } });
  assert.throws(() => lane.enqueue({ repo: 'env-a', branch: 'feat', deploy: 'prod' }), /scope must be one of/);
  const r = await go(lane, { branch: 'feat', deploy: 'host' });
  assert.equal(r.state, 'deploy_failed'); assert.match(r.reason, /deploy d3 failed/);
  const w2 = makeWorld(); w2.branch('feat', { 'new.js': 'x\n' });
  const d2 = { request: async () => ({ ok: false, error: 'deploy request needs a ref' }), wait: async () => ({}) };
  const m2 = mk(w2, { cfg: { deploy: { env: 'env-a', defaultScope: 'full' } }, lane: { deploys: d2 } });
  assert.match((await go(m2.lane, { branch: 'feat', deploy: true })).reason, /needs a ref/);
  assert.equal(validateConfig({ repos: { a: { clone: '/x', deploy: { env: 'e', defaultScope: 'nope' } } } }).errors.length, 1);
});

test('CI that never finishes: merged_ci_red with a timeout reason', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  let t = 0;
  const { lane } = mk(w, { cfg: { ci: 'github', ciTimeoutMin: 1 }, lane: { ci: { status: async () => 'pending' }, now: () => (t += 20000) } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged_ci_red'); assert.match(r.reason, /did not finish/);
});

const until = async (f, ms = 15000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 5)); assert.ok(f(), 'condition not reached'); };

test('queue: FIFO per repo, repos in parallel, cancel only while queued', async () => {
  const wa = makeWorld({ name: 'demo-a' }), wb = makeWorld({ name: 'demo-b' });
  for (const b of ['a1', 'a2', 'a3']) wa.branch(b, { [`${b}.js`]: '1\n' });
  wb.branch('b1', { 'b1.js': '1\n' });
  const open = []; const starts = [];
  const run = (cmd) => new Promise((resolve) => { starts.push(cmd); open.push({ cmd, go: () => resolve({ code: 0, out: '' }) }); });
  const release = (cmd) => open.splice(open.findIndex((x) => x.cmd === cmd), 1)[0].go();
  const lane = createIntegrationLane({ stateDir: mkdtempSync(join(tmpdir(), 'lane-state-')), run,
    config: { repos: { a: wa.cfg({ test: 'A' }), b: wb.cfg({ test: 'B' }) } } }).start();
  const a1 = lane.enqueue({ repo: 'a', branch: 'a1' }), a2 = lane.enqueue({ repo: 'a', branch: 'a2' }), a3 = lane.enqueue({ repo: 'a', branch: 'a3' });
  const b1 = lane.enqueue({ repo: 'b', branch: 'b1' });
  assert.deepEqual([a1.position, a2.position, a3.position, b1.position], [1, 2, 3, 1]);
  await until(() => starts.length >= 2);                      // A1 and B1 are testing at the same time
  assert.deepEqual([...starts].sort(), ['A', 'B']);
  assert.equal(lane.get(a2.id).state, 'queued');
  assert.throws(() => lane.cancel(a1.id), /only a queued/);
  assert.equal(lane.cancel(a3.id).state, 'cancelled');
  release('B'); await lane.wait(b1.id);
  assert.equal(lane.get(a2.id).state, 'queued');              // B finishing does not advance A
  assert.equal(lane.get(a2.id).position, 2);
  release('A');                                               // A1 done -> A2 starts (FIFO)
  await until(() => starts.length === 3);
  assert.equal(lane.get(a1.id).state, 'merged'); assert.equal(lane.get(a2.id).state, 'running');
  release('A'); const done = await lane.wait(a2.id);
  assert.equal(done.state, 'merged'); assert.equal(lane.get(a3.id).state, 'cancelled');
  assert.equal(wa.show('main', 'a1.js'), '1\n'); assert.equal(wa.show('main', 'a2.js'), '1\n');
  assert.throws(() => wa.show('main', 'a3.js'));
  assert.deepEqual(lane.list({ repo: 'a' }).map((x) => x.branch), ['a3', 'a2', 'a1']);   // newest first
});

test('restart: a request running at the crash is resumed in a fresh worktree', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const stateDir = mkdtempSync(join(tmpdir(), 'lane-state-'));
  const hang = mk(w, { stateDir, cfg: { test: 'fake' }, lane: { run: () => new Promise(() => {}) } });
  const q = hang.lane.enqueue({ repo: 'env-a', branch: 'feat', session: 's1' });
  await until(() => hang.lane.get(q.id).step === 'test');
  hang.lane.stop();                                     // "crash": the test never returns
  let ran = 0;
  const again = mk(w, { stateDir, cfg: { test: 'fake' }, lane: { run: async () => { ran++; return { code: 0, out: 'ok' }; } } });
  const r = await again.lane.wait(q.id, 30000);
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(ran, 1); assert.equal(r.resumed, 1);
  assert.ok(again.events.some((e) => e.kind === 'resumed'));
  assert.equal(w.main(), r.sha);
});

test('restart after the push: the remote is read, nothing is pushed twice, CI continues', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const stateDir = mkdtempSync(join(tmpdir(), 'lane-state-'));
  const first = mk(w, { stateDir, cfg: { ci: 'github', test: 'fake' }, lane: { run: async () => ({ code: 0, out: 'ok' }), ci: { status: async () => 'pending' }, sleep: () => new Promise(() => {}) } });
  const q = first.lane.enqueue({ repo: 'env-a', branch: 'feat' });
  await until(() => first.lane.get(q.id).step === 'ci');
  first.lane.stop();
  const count = w.count(), sha = w.main();
  let ran = 0;
  const again = mk(w, { stateDir, cfg: { ci: 'github', test: 'fake' }, lane: { run: async () => { ran++; return { code: 0, out: '' }; }, ci: { status: async () => 'success' } } });
  const r = await again.lane.wait(q.id, 30000);
  assert.equal(r.state, 'merged'); assert.equal(ran, 0); assert.equal(w.count(), count); assert.equal(r.sha, sha);
  const lines = readFileSync(join(stateDir, 'integration', 'requests.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines.at(-1)).state, 'merged');     // append-only snapshots, the last line wins
});

test('a duplicate queued request returns the same id; final states are stable', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const run = () => new Promise(() => {});
  const { lane } = mk(w, { cfg: { test: 'fake' }, lane: { run } });
  const blocker = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'a' });
  await until(() => lane.get(blocker.id).step === 'test');
  const x = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'b' }), y = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'b' });
  assert.equal(x.id, y.id); assert.equal(y.duplicate, true);
  assert.deepEqual(FINAL.includes('queued'), false);
});

test('config validation and remote url normalisation', () => {
  const { repos, errors } = validateConfig({ repos: {
    ok: { clone: '/srv/lane/demo', test: 'npm test', ci: 'github', deploy: { env: 'env-a' }, extra: 1 },
    bad1: { clone: 'relative' }, bad2: { clone: '/x', ci: 'jenkins' }, bad3: { clone: '/x', conventionResolver: 'ours' }, 'bad key!': { clone: '/x' } } });
  assert.deepEqual(Object.keys(repos), ['ok']); assert.equal(errors.length, 4);
  assert.deepEqual(repos.ok, { key: 'ok', clone: '/srv/lane/demo', remote: 'origin', target: 'main', test: 'npm test', testTimeoutMin: 30, ci: 'github',
    ciTimeoutMin: 60, deploy: { env: 'env-a', defaultScope: 'full' }, conventions: ['VERSION.txt'], conventionResolver: 'take-target' });
  const n = normalizeRemoteUrl;
  assert.equal(n('git@host.example:org/demo-repo.git'), 'host.example/org/demo-repo');
  assert.equal(n('https://user:tok@host.example/org/Demo-Repo.git/'), 'host.example/org/demo-repo');
  assert.equal(n('ssh://git@host.example/org/demo-repo'), 'host.example/org/demo-repo');
});

test('repoForUrl / repoForCwd find the repository from an origin url', async () => {
  const w = makeWorld();
  const { lane } = mk(w);
  assert.equal(await lane.repoForUrl(w.remote), 'env-a');
  assert.equal(await lane.repoForUrl(`file://${w.remote}`), 'env-a');
  assert.equal(await lane.repoForCwd(w.dev), 'env-a');
  assert.equal(await lane.repoForUrl('https://host.example/org/other'), null);
  assert.equal(await lane.repoForCwd('/nonexistent'), null);
});

test('restart between the deploy request and the saved id: the existing deploy for integration:<id> is followed, not re-requested', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  let requested = 0; const waited = [];
  const deploys = { request: async () => { requested++; return { id: 'dNEW' }; }, find: async ({ agent }) => (/^integration:int-/.test(agent) ? 'dOLD' : null), wait: async (id) => { waited.push(id); return { ok: true, version: 'v1' }; } };
  const { lane } = mk(w, { cfg: { deploy: { env: 'env-a', defaultScope: 'server' } }, lane: { deploys } });
  const r = await go(lane, { branch: 'feat', deploy: true });
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.equal(requested, 0); assert.deepEqual(waited, ['dOLD']); assert.equal(r.deployed.id, 'dOLD');
});
