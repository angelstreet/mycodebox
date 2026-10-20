// The integration lane against real throwaway git repos (a bare remote + clones); CI, deploys and notify are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIntegrationLane, validateConfig, normalizeRemoteUrl, FINAL } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { git, commit } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

const mk = (w, o = {}) => {
  const stateDir = o.stateDir || tmp('lane-state-');
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
    assert.match(git(w.remote, 'log', '-1', '--format=%s', 'main').trim(), new RegExp(`; resolved VERSION\\.txt \\(${resolver}\\)$`), resolver);
  }
});

test('clean merge of a changed VERSION.txt: main keeps the target file, the merge still has two parents', async () => {
  const w = makeWorld(); w.branch('feat', { 'VERSION.txt': 'current:fix/branch-label-2026.10.20-1\n', 'new.js': 'x\n' });
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(w.show('main', 'VERSION.txt'), '1\n');       // the target's label, never the branch's
  assert.equal(w.show('main', 'new.js'), 'x\n');
  assert.match(git(w.remote, 'log', '-1', '--format=%s', 'main').trim(), /; resolved VERSION\.txt \(take-target\)$/);
  assert.equal(git(w.remote, 'rev-list', '--parents', '-n', '1', r.sha).trim().split(' ').length, 3);   // amended, still a merge
});

test('clean merge that leaves VERSION.txt alone: the target file is untouched and nothing is resolved', async () => {
  for (const [i, moved] of [[0, false], [1, true]]) {   // main itself may have moved its own file: that is the target's version too
    const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
    if (moved) w.moveMain({ 'VERSION.txt': '5\n', 'other.js': 'o\n' });
    const { lane } = mk(w);
    const r = await go(lane, { branch: 'feat' });
    assert.equal(r.state, 'merged', `${i}: ${JSON.stringify(r)}`);
    assert.equal(w.show('main', 'VERSION.txt'), moved ? '5\n' : '1\n', `case ${i}`);
    assert.equal(w.show('main', 'new.js'), 'x\n');
    assert.doesNotMatch(git(w.remote, 'log', '-1', '--format=%s', 'main').trim(), /resolved/, `case ${i}`);
  }
});

test('union conflict: both sides entries are kept and the merge goes through', async () => {
  const base = { 'src.js': 'export const a = 0;\n', 'VERSION.txt': '1\n', 'docs/release_note/README.md': '# Release notes\n- base\n' };
  const w = makeWorld({ base });
  w.branch('feat', { 'docs/release_note/README.md': '# Release notes\n- base\n- branch entry\n' });
  w.moveMain({ 'docs/release_note/README.md': '# Release notes\n- base\n- target entry\n' });
  const { lane } = mk(w, { cfg: { unionFiles: ['docs/release_note/README.md'] } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  const notes = w.show('main', 'docs/release_note/README.md');
  assert.match(notes, /- target entry/); assert.match(notes, /- branch entry/);   // nothing is dropped
  assert.doesNotMatch(notes, /<<<<<<<|>>>>>>>/, 'no conflict markers are left behind');
  assert.match(git(w.remote, 'log', '-1', '--format=%s', 'main').trim(), /; resolved docs\/release_note\/README\.md \(union\)$/);
});

test('regenerate conflict: the target version is taken, the generator runs and its output is staged', async () => {
  // a tiny stand-in for scripts/gen_docs_index.py: rewrite the index from the docs it finds, plus one sibling file
  const gen = `import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('docs/agent', { recursive: true });
const files = readdirSync('docs').filter((f) => f.endsWith('.md')).sort();
writeFileSync('docs/agent/INDEX.json', JSON.stringify({ files }) + '\\n');
writeFileSync('docs/agent/INDEX.md', '# Index\\n\\n' + files.map((f) => '- ' + f).join('\\n') + '\\n');
`;
  const w = makeWorld({ base: { 'src.js': 'export const a = 0;\n', 'VERSION.txt': '1\n', 'gen.mjs': gen, 'docs/a.md': '# a\n', 'docs/agent/INDEX.json': '{"files":["a.md"]}\n' } });
  w.branch('feat', { 'docs/b.md': '# b\n', 'docs/agent/INDEX.json': '{"files":["a.md","b.md"]}\n' });
  w.moveMain({ 'docs/c.md': '# c\n', 'docs/agent/INDEX.json': '{"files":["a.md","c.md"]}\n' });
  const { lane } = mk(w, { cfg: { regenerate: [{ files: ['docs/agent/INDEX.json'], cmd: 'node gen.mjs' }] } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  // the generator ran in the merge worktree: the index lists the merged docs, not either side's hand-written value
  assert.deepEqual(JSON.parse(w.show('main', 'docs/agent/INDEX.json')), { files: ['a.md', 'b.md', 'c.md'] });
  assert.match(w.show('main', 'docs/agent/INDEX.md'), /- c\.md/);   // a generated sibling the command rewrites is staged too
  assert.match(git(w.remote, 'log', '-1', '--format=%s', 'main').trim(), /; resolved docs\/agent\/INDEX\.json \(regenerate\)$/);
});

test('a conflict outside union and regenerate files still returns the request', async () => {
  const w = makeWorld({ base: { 'src.js': 'export const a = 0;\n', 'VERSION.txt': '1\n', 'docs/release_note/README.md': '# Release notes\n- base\n' } });
  w.branch('feat', { 'src.js': 'export const a = 1;\n', 'docs/release_note/README.md': '# Release notes\n- base\n- branch entry\n' });
  w.moveMain({ 'src.js': 'export const a = 2;\n', 'docs/release_note/README.md': '# Release notes\n- base\n- target entry\n' });
  const before = w.main();
  const { lane } = mk(w, { cfg: { unionFiles: ['docs/release_note/README.md'], regenerate: [{ files: ['docs/agent/INDEX.json'], cmd: 'node gen.mjs' }] } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.match(r.reason, /conflicts outside convention: src\.js/);   // the floor sees only src.js as unresolvable
  assert.equal(w.main(), before);
  // the union file does not rescue a merge that also conflicts elsewhere (floor bypassed, merge step decides)
  const m = mk(w, { cfg: { unionFiles: ['docs/release_note/README.md'] }, lane: { mergeEval: async () => ({ verdict: 'merge', reasons: [] }) } });
  const r2 = await go(m.lane, { branch: 'feat' });
  assert.equal(r2.state, 'returned'); assert.deepEqual(r2.conflicts, ['docs/release_note/README.md', 'src.js']);
  assert.equal(w.main(), before);
});

test('sensitive file: returned by the merge floor, nothing merged', async () => {
  const w = makeWorld(); w.branch('feat', { 'config/credentials.txt': 'x\n' });
  const before = w.main();
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned'); assert.match(r.reason, /merge evaluation:.*credentials\.txt/);
  assert.equal(w.main(), before);
});

test('the floor judges the exact commit that is merged, not a same-named local branch of the lane clone', async () => {
  const w = makeWorld(); w.branch('feat', { 'config/credentials.txt': 'x\n' });
  git(w.lane, 'fetch', '-q', 'origin'); git(w.lane, 'checkout', '-q', '-b', 'feat', 'origin/main'); commit(w.lane, { 'harmless.js': 'ok\n' }, 'local');
  const before = w.main();
  const { lane } = mk(w);
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned', JSON.stringify(r)); assert.match(r.reason, /credentials\.txt/); assert.equal(w.main(), before);
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
  const lane = createIntegrationLane({ stateDir: tmp('lane-state-'), run,
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
  const stateDir = tmp('lane-state-');
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
  const stateDir = tmp('lane-state-');
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
    shared: { clone: '/x', unionFiles: ['docs/release_note/README.md'], regenerate: [{ files: ['docs/agent/INDEX.json'], cmd: 'python3 scripts/gen_docs_index.py' }] },
    badRel: { clone: '/x', unionFiles: ['/etc/passwd', '../out.md'] }, badRegen: { clone: '/x', regenerate: [{ files: ['a.json'] }, { files: [], cmd: 'x' }, 'nope'] },
    bad1: { clone: 'relative' }, bad2: { clone: '/x', ci: 'jenkins' }, bad3: { clone: '/x', conventionResolver: 'ours' }, 'bad key!': { clone: '/x' } } });
  assert.deepEqual(Object.keys(repos), ['ok', 'shared', 'badRel', 'badRegen']); assert.equal(errors.length, 9);   // 2 dropped union paths + 3 bad regenerate entries + 4 pre-existing
  assert.deepEqual(repos.ok, { key: 'ok', clone: '/srv/lane/demo', remote: 'origin', target: 'main', test: 'npm test', testTimeoutMin: 30, ci: 'github',
    ciTimeoutMin: 60, deploy: { env: 'env-a', defaultScope: 'full' }, conventions: ['VERSION.txt'], conventionResolver: 'take-target', unionFiles: [], regenerate: [] });
  assert.deepEqual(repos.shared.unionFiles, ['docs/release_note/README.md']);
  assert.deepEqual(repos.shared.regenerate, [{ files: ['docs/agent/INDEX.json'], cmd: 'python3 scripts/gen_docs_index.py' }]);
  assert.deepEqual(repos.badRel.unionFiles, [], 'an escaping path is dropped, the repo still works');
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

test('push landed but the follow-up fetch fails: verified with ls-remote, reported merged (not returned)', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { createDefaultGit } = await import('../integration-lane.js');
  const real = createDefaultGit(); let pushed = false, fails = 0;
  const git = async (args, o) => {
    if (args.includes('push')) pushed = true;
    if (pushed && args.includes('fetch') && fails < 2) { fails++; return { code: 1, out: '', err: 'network down' }; }
    return real(args, o);
  };
  const { lane } = mk(w, { lane: { git } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(r.pushed, true); assert.equal(w.main(), r.sha); assert.ok(fails >= 1);
});

test('push landed, remote unreadable for a while: the request keeps running, then settles merged', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { createDefaultGit } = await import('../integration-lane.js');
  const real = createDefaultGit(); let pushed = false, down = 4;
  const git = async (args, o) => {
    if (args.includes('push')) pushed = true;
    if (pushed && down > 0 && (args.includes('fetch') || args.includes('ls-remote'))) { down--; return { code: 1, out: '', err: 'network down' }; }
    return real(args, o);
  };
  const { lane } = mk(w, { lane: { git } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); assert.equal(down, 0);
});

test('the test command runs with a scrubbed environment: service secrets stay out, PATH/HOME/NODE_* and the temp state dir stay in', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  process.env.LANGFUSE_SECRET_KEY = 'fake-secret'; process.env.JEV_TOKEN = 'fake-jev'; process.env.NODE_LANE_MARK = 'kept';
  try {
    const { lane } = mk(w, { cfg: { test: 'env; exit 1' } });
    const r = await go(lane, { branch: 'feat' });
    assert.equal(r.state, 'returned');
    assert.doesNotMatch(r.tail, /LANGFUSE_|JEV_|fake-secret|fake-jev/);
    assert.match(r.tail, /^PATH=/m); assert.match(r.tail, /^NODE_LANE_MARK=kept$/m); assert.match(r.tail, /^CI=1$/m);
    assert.match(r.tail, /^GHOSTY_STATE_DIR=.*integration\/tmp\//m);
  } finally { delete process.env.LANGFUSE_SECRET_KEY; delete process.env.JEV_TOKEN; delete process.env.NODE_LANE_MARK; }
});

test('package-lock.json in the merge: the lane runs npm ci before the test command; a failed install returns', async () => {
  const { createDefaultRun } = await import('../integration-lane.js');
  const real = createDefaultRun();
  for (const installOk of [true, false]) {
    const w = makeWorld(); w.branch('feat', { 'package-lock.json': '{}\n' });
    const calls = [];
    const run = (cmd, o) => { calls.push({ cmd, cwd: o.cwd }); return cmd.startsWith('npm ci') ? Promise.resolve({ code: installOk ? 0 : 1, out: 'npm ERR! fake' }) : real(cmd, o); };
    const { lane } = mk(w, { cfg: { test: 'true' }, lane: { run } });
    const r = await go(lane, { branch: 'feat' });
    assert.deepEqual(calls.map((c) => c.cmd), installOk ? ['npm ci --no-audit --no-fund', 'true'] : ['npm ci --no-audit --no-fund']);
    assert.equal(calls[0].cwd, calls.at(-1).cwd);
    if (installOk) { assert.equal(r.state, 'merged', JSON.stringify(r)); assert.ok(r.steps.some((s) => s.name === 'install')); }
    else { assert.equal(r.state, 'returned'); assert.match(r.reason, /npm ci .*failed \(exit 1\)/); assert.match(r.tail, /npm ERR! fake/); }
  }
  // no lockfile: no install step
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const calls = [];
  const { lane } = mk(w, { cfg: { test: 'true' }, lane: { run: (cmd, o) => { calls.push(cmd); return real(cmd, o); } } });
  assert.equal((await go(lane, { branch: 'feat' })).state, 'merged'); assert.deepEqual(calls, ['true']);
});

test('red node tests: the reason names the failing tests and the tail keeps the failing block, not only the last lines', async () => {
  const w = makeWorld();
  w.branch('feat', { 't/x.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fine', () => {});\n"
    + "test('the widget counts', () => { assert.equal(1 + 1, 3); });\ntest('other breaks', () => { throw new Error('other-boom'); });\n" });
  const noisy = 'node --test t/x.test.js; rc=$?; i=0; while [ $i -lt 120 ]; do echo trailing noise $i; i=$((i+1)); done; exit $rc';
  const { lane } = mk(w, { cfg: { test: noisy } });
  const r = await go(lane, { branch: 'feat' });
  assert.equal(r.state, 'returned');
  assert.match(r.reason, /^tests red \(exit 1\): 2 failing: the widget counts; other breaks$/);
  assert.deepEqual(r.failing, ['the widget counts', 'other breaks']);
  assert.match(r.tail, /^✖ failing tests:/); assert.match(r.tail, /2 !== 3/); assert.match(r.tail, /other-boom/);
  assert.match(r.tail, /ℹ fail 2/); assert.doesNotMatch(r.tail, /node:internal/);
});

test('floor: a test file named *deploy* merges; real infra paths return needs_approval and raise a manager item', async () => {
  const w = makeWorld(); w.branch('t', { 'test/foo-deploy.test.js': 'x\n', 'docs/deploy.md': 'd\n' });
  const items = [];
  const { lane } = mk(w, { lane: { mergeEval: undefined, managerItem: (i) => items.push(i) } });
  assert.equal((await go(lane, { branch: 't' })).state, 'merged');
  assert.equal(items.length, 0);
  w.branch('infra', { 'scripts/deploy.sh': 'echo\n', 'ok.js': 'y\n' });
  const before = w.main();
  const r = await go(lane, { branch: 'infra' });
  assert.equal(r.state, 'returned'); assert.equal(r.outcome, 'needs_approval');
  assert.deepEqual(r.infraPaths, ['scripts/deploy.sh']);
  assert.equal(w.main(), before);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'merge'); assert.equal(items[0].branch, 'infra'); assert.deepEqual(items[0].paths, ['scripts/deploy.sh']);
  assert.match(items[0].diffStat, /scripts\/deploy\.sh/);
});

test('floor: a manager approval skips only the infra reason, is recorded and journaled', async () => {
  const w = makeWorld(); w.branch('infra', { 'scripts/deploy.sh': 'echo\n' });
  const journal = [];
  const { lane } = mk(w, { lane: { mergeEval: undefined, journal: (j) => journal.push(j) } });
  const r = await go(lane, { branch: 'infra', approvedBy: 'manager' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(r.approvedBy, 'manager'); assert.ok(r.approvedAt);
  const appr = journal.filter((j) => j.approvedBy); assert.equal(appr.length, 1); assert.equal(appr[0].kind, 'merge'); assert.equal(appr[0].request, r.id);
  // never a secret, a unit or red tests
  for (const [name, files] of [['sec', { 'scripts/deploy.sh': 'a\n', '.env': 'K=1\n' }], ['unit', { 'scripts/deploy.sh': 'a\n', 'systemd/x.service': '[Unit]\n' }], ['mig', { 'scripts/deploy.sh': 'a\n', 'migrations/1.sql': 'select 1;\n' }]]) {
    w.branch(name, files); const m = w.main();
    const x = await go(lane, { branch: name, approvedBy: 'manager' });
    assert.equal(x.state, 'returned', name); assert.notEqual(x.outcome, 'needs_approval', name); assert.equal(w.main(), m);
  }
  const red = mk(w, { cfg: { test: 'exit 2' }, lane: { mergeEval: undefined } });
  w.branch('red', { 'scripts/deploy.sh': 'b\n' });
  assert.equal((await go(red.lane, { branch: 'red', approvedBy: 'manager' })).state, 'returned');
});

test('floor: an additive migration merges with --approved-by manager --migration-applied, and is journaled', async () => {
  const w = makeWorld();
  w.branch('add-mig', { 'db/migrations/002.sql': 'CREATE TABLE tasks (id serial PRIMARY KEY);\n', 'new.js': 'x\n' });
  const journal = [];
  const { lane } = mk(w, { lane: { mergeEval: undefined, journal: (j) => journal.push(j) } });
  const r = await go(lane, { branch: 'add-mig', approvedBy: 'manager', migrationApplied: true });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(w.main(), r.sha);
  assert.equal(r.migrationApplied, true); assert.ok(r.migrationAppliedAt);
  const mig = journal.filter((j) => j.decision_id === `lane-migration-${r.id}`);
  assert.equal(mig.length, 1, JSON.stringify(journal.map((j) => j.decision_id)));
  assert.equal(mig[0].kind, 'merge'); assert.equal(mig[0].chosen, 'approve'); assert.equal(mig[0].migrationApplied, true);
  assert.match(mig[0].question, /Merge additive migration db\/migrations\/002\.sql already applied in the target DB\?/);
  assert.match(mig[0].rationale, /Q199/); assert.match(mig[0].rationale, /--migration-applied/);
});

test('floor: an additive migration without the attestation, and a destructive one with it, both return', async () => {
  const w = makeWorld();
  w.branch('add-noatt', { 'db/migrations/002.sql': 'CREATE TABLE tasks (id serial PRIMARY KEY);\n' });
  w.branch('add-plain', { 'db/migrations/003.sql': 'CREATE TABLE tasks2 (id int);\n' });
  w.branch('drop', { 'db/migrations/004.sql': 'ALTER TABLE tasks DROP COLUMN name;\n' });
  w.branch('alter-type', { 'db/migrations/005.sql': 'ALTER TABLE tasks ALTER COLUMN name TYPE varchar(9);\n' });
  w.branch('upd', { 'db/migrations/006.sql': "UPDATE tasks SET name = 'x';\n" });
  w.branch('del', { 'db/migrations/007.sql': 'DELETE FROM tasks;\n' });
  w.branch('alembic', { 'alembic/versions/008.py': 'op.add_column("tasks", sa.Column("n", sa.Integer()))\nop.drop_column("tasks", "old")\n' });
  const { lane } = mk(w, { lane: { mergeEval: undefined } });
  const before = w.main();
  // approved, but the manager never attested that the objects are already in the target DB
  const noAtt = await go(lane, { branch: 'add-noatt', approvedBy: 'manager' });
  assert.equal(noAtt.state, 'returned');
  assert.match(noAtt.reason, /additive migration needs --migration-applied/);
  // neither approval nor attestation
  const plain = await go(lane, { branch: 'add-plain' });
  assert.equal(plain.state, 'returned');
  assert.match(plain.reason, /additive migration needs --approved-by manager --migration-applied/);
  assert.notEqual(plain.outcome, 'needs_approval');
  // destructive: the attestation does not help, and the reason names what it found
  for (const [name, why] of [['drop', /migration is destructive: DROP COLUMN in db\/migrations\/004\.sql/], ['alter-type', /migration is destructive: ALTER \.\.\. TYPE in db\/migrations\/005\.sql/],
    ['upd', /migration is destructive: UPDATE in db\/migrations\/006\.sql/], ['del', /migration is destructive: DELETE in db\/migrations\/007\.sql/], ['alembic', /migration is destructive: drop_column in alembic\/versions\/008\.py/]]) {
    const x = await go(lane, { branch: name, approvedBy: 'manager', migrationApplied: true });
    assert.equal(x.state, 'returned', name);
    assert.match(x.reason, why, name);
  }
  assert.equal(w.main(), before);
});

test('a v2/task/<id> branch merges only with the owner grant for its exact SHA (taskGrant)', async () => {
  const w = makeWorld(); w.branch('v2/task/t-1', { 'new.js': 'x\n' }); w.branch('feat', { 'other.js': 'y\n' });
  const before = w.main();
  const asked = [];
  const none = mk(w);   // no store wired: refused
  const r0 = await go(none.lane, { branch: 'v2/task/t-1' });
  assert.equal(r0.state, 'returned'); assert.match(r0.reason, /no integration grant/); assert.equal(w.main(), before);
  const denied = mk(w, { lane: { taskGrant: (id, sha) => { asked.push([id, sha]); return false; } } });
  assert.equal((await go(denied.lane, { branch: 'v2/task/t-1' })).state, 'returned');
  assert.equal(asked[0][0], 't-1'); assert.match(asked[0][1], /^[0-9a-f]{40}$/);
  assert.equal((await go(denied.lane, { branch: 'feat' })).state, 'merged', 'other branches are not gated');
  const granted = mk(w, { lane: { taskGrant: (id, sha) => id === 't-1' && sha === asked[0][1] } });
  assert.equal((await go(granted.lane, { branch: 'v2/task/t-1' })).state, 'merged');
});
