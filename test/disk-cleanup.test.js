import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCleanup, planCleanup, isLive, truncateLog, protector, report, journalText, diskUsedPct, checkArgs } from '../scripts/disk-cleanup.js';

const OLDISO = new Date(Date.now() - 96 * 36e5).toISOString();
const ENV = { ...process.env, GIT_COMMITTER_DATE: OLDISO, GIT_AUTHOR_DATE: OLDISO };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const none = { sessions: new Set(), sessionsOk: true, branches: new Set(), worktrees: new Set(), leaseText: '' };
const OLD = (Date.now() - 96 * 36e5) / 1e3;
const age = (dir) => { for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.utimesSync(path.join(dir, f), OLD, OLD); fs.utimesSync(dir, OLD, OLD); };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-'));
  const origin = path.join(root, 'origin.git'), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  fs.mkdirSync(state);
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1'); fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\n');
  sh(repo, 'add', '.'); sh(repo, ...G, 'commit', '-qm', 'init'); sh(repo, 'push', '-q', 'origin', 'HEAD:main'); sh(repo, 'fetch', '-q');
  const wt = (name, branch) => { const p = path.join(root, name); sh(repo, 'worktree', 'add', '-q', '-b', branch, p, 'origin/main'); return p; };
  const policy = { repos: [repo], worktrees: { minAgeH: 24 }, caches: { idleDays: 3, names: ['node_modules'], maxDepth: 3 }, laneWorktrees: { minAgeH: 24 },
    logs: [{ file: 'big.log', maxMB: 1, keepMB: 0.1 }], never: [repo], parkedFiles: ['parked.json'] };
  return { root, repo, state, wt, policy };
}
const opts = (f, extra = {}) => ({ policy: f.policy, state: f.state, refs: none, cwds: new Set(), noFetch: true, ...extra });

test('default is a dry run: the switch is the state file, nothing else', () => {
  const f = fixture();
  assert.equal(isLive(f.state), false);
  fs.writeFileSync(path.join(f.state, 'disk-cleanup.json'), '{"live":"yes"}');
  assert.equal(isLive(f.state), false, 'only an explicit true counts');
  fs.writeFileSync(path.join(f.state, 'disk-cleanup.json'), '{"live":true}');
  assert.equal(isLive(f.state), true);
});

test('dry run lists everything with sizes and deletes nothing', async () => {
  const f = fixture();
  const a = f.wt('wt-a', 'feat/a');
  fs.mkdirSync(path.join(a, 'node_modules')); fs.writeFileSync(path.join(a, 'node_modules', 'x'), 'x'.repeat(5000)); age(a);
  fs.writeFileSync(path.join(f.state, 'big.log'), 'line\n'.repeat(400000));
  const res = await runCleanup({ live: false, ...opts(f) });
  assert.equal(res.freed, 0);
  const steps = res.plan.items.map((i) => i.step).sort();
  assert.deepEqual(steps, ['log', 'worktree'], steps.join());   // the idle worktree is removed whole, so its node_modules is not a separate item
  assert.ok(fs.existsSync(a) && fs.existsSync(path.join(a, 'node_modules')));
  assert.equal(fs.statSync(path.join(f.state, 'big.log')).size, 2000000);
  assert.match(report(res.plan, res), /DRY RUN[\s\S]*WOULD free/);
});

test('live: removes a merged idle worktree, keeps dirty / unpushed / precious / busy / young ones', async () => {
  const f = fixture();
  const gone = f.wt('wt-gone', 'feat/gone'); age(gone);
  const dirty = f.wt('wt-dirty', 'feat/dirty'); fs.writeFileSync(path.join(dirty, 'new.txt'), 'x'); age(dirty);
  const unpushed = f.wt('wt-unpushed', 'feat/unpushed'); fs.writeFileSync(path.join(unpushed, 'u.txt'), 'u'); sh(unpushed, 'add', '.'); sh(unpushed, ...G, 'commit', '-qm', 'u'); age(unpushed);
  const env = f.wt('wt-env', 'feat/env'); fs.writeFileSync(path.join(env, '.env'), 'SECRET=1'); age(env);   // gitignored .env: git worktree remove would delete it
  const used = f.wt('wt-used', 'feat/used'); age(used);
  const young = f.wt('wt-young', 'feat/young');
  const res = await runCleanup({ live: true, ...opts(f, { cwds: new Set([used]) }) });
  assert.ok(!fs.existsSync(gone), 'merged idle worktree removed');
  for (const p of [dirty, unpushed, env, used, young]) assert.ok(fs.existsSync(p), `${p} kept`);
  assert.equal(fs.readFileSync(path.join(env, '.env'), 'utf8'), 'SECRET=1');
  assert.ok(res.done.some((d) => d.path === gone));
  assert.equal(sh(f.repo, 'branch', '--list', 'feat/gone'), '', 'merged branch deleted');
  assert.ok(fs.readFileSync(path.join(f.state, 'worktree-prune.jsonl'), 'utf8').includes(gone), 'prune log has the tip sha');
});

test('live: caches of idle worktrees go, of a busy or young one stay; logs keep their tail', async () => {
  const f = fixture();
  const idle = f.wt('wt-idle', 'feat/idle'); fs.writeFileSync(path.join(idle, 'w.txt'), 'w'); // dirty: stays as a worktree, cache still goes
  fs.mkdirSync(path.join(idle, 'node_modules')); fs.writeFileSync(path.join(idle, 'node_modules', 'x'), 'x'); age(idle);
  const busyWt = f.wt('wt-busy', 'feat/busy'); fs.mkdirSync(path.join(busyWt, 'node_modules')); fs.writeFileSync(path.join(busyWt, 'node_modules', 'x'), 'x'); age(busyWt);
  const log = path.join(f.state, 'big.log'); fs.writeFileSync(log, Array.from({ length: 300000 }, (_, i) => `row ${i}`).join('\n') + '\n');
  await runCleanup({ live: true, ...opts(f, { cwds: new Set([busyWt]) }) });
  assert.ok(!fs.existsSync(path.join(idle, 'node_modules')));
  assert.ok(fs.existsSync(path.join(idle, 'w.txt')), 'the worktree itself stays');
  assert.ok(fs.existsSync(path.join(busyWt, 'node_modules')));
  const t = fs.readFileSync(log, 'utf8');
  assert.ok(t.length < 120000 && t.endsWith('row 299999\n') && t.startsWith('row '), 'tail kept at a line boundary');
});

test('never touches a protected path or one named in the parked files', async () => {
  const f = fixture();
  const parked = f.wt('wt-parked', 'feat/parked'); age(parked);
  fs.writeFileSync(path.join(f.state, 'parked.json'), JSON.stringify({ cwd: parked }));
  const prot = protector(f.policy, f.state);
  assert.match(prot(f.repo), /protected/);
  assert.match(prot(parked), /parked/);
  const res = await runCleanup({ live: true, ...opts(f) });
  assert.ok(fs.existsSync(parked));
  assert.ok(res.plan.skipped.some((s) => s.path === parked));
});

test('lane merge worktrees: finished and idle are removed, open requests stay', async () => {
  const f = fixture();
  const dir = path.join(f.state, 'integration', 'wt');
  fs.mkdirSync(dir, { recursive: true });
  const lane = path.join(f.root, 'lane-clone'); sh(f.root, 'clone', '-q', path.join(f.root, 'origin.git'), lane);   // the lane's own clone, not one of the repos
  const mk = (id) => { const p = path.join(dir, id); sh(lane, 'worktree', 'add', '-q', '--detach', p, 'origin/main'); fs.utimesSync(p, OLD, OLD); return p; };
  const done = mk('int-done'), open = mk('int-open');
  fs.writeFileSync(path.join(f.state, 'integration', 'requests.jsonl'), `${JSON.stringify({ id: 'int-done', state: 'merged' })}\n${JSON.stringify({ id: 'int-open', state: 'merging' })}\n`);
  const P = await planCleanup(opts(f));
  assert.deepEqual(P.items.filter((i) => i.step === 'lane').map((i) => i.path), [done]);
  const res = await runCleanup({ live: true, ...opts(f) });
  assert.ok(!fs.existsSync(done) && fs.existsSync(open), JSON.stringify(res.refused));
});

test('truncateLog keeps a whole-line tail and is a no-op under the cap', () => {
  const f = fixture(); const file = path.join(f.state, 'x.log');
  fs.writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
  assert.equal(truncateLog(file, 1000), 0);
  assert.ok(truncateLog(file, 8) > 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'cccc\n');
});

test('sweep: min-age-h 2 removes a 3 h idle merged worktree the 24 h default keeps; worktrees only', async () => {
  const f = fixture();
  const a = f.wt('wt-s', 'feat/s');
  fs.mkdirSync(path.join(a, 'node_modules')); fs.writeFileSync(path.join(a, 'node_modules', 'x'), 'x');
  const T = (Date.now() - 3 * 36e5) / 1e3;
  for (const e of [...fs.readdirSync(a).filter((n) => n !== '.git').map((n) => path.join(a, n)), a]) fs.utimesSync(e, T, T);
  fs.writeFileSync(path.join(f.state, 'big.log'), 'line\n'.repeat(400000));
  const keep = await planCleanup(opts(f));
  assert.equal(keep.items.filter((i) => i.step === 'worktree').length, 0, '24 h default keeps it');
  const P = await planCleanup(opts(f, { minAgeH: 2, worktreesOnly: true }));
  assert.deepEqual(P.items.map((i) => i.step), ['worktree'], 'no log / cache / lane item in sweep mode');
});

test('sweep live: removes idle merged worktree without force, spares dirty and in-use ones, journal text lists it', async () => {
  const f = fixture();
  const ok = f.wt('wt-ok', 'feat/ok'), dirty = f.wt('wt-dirty', 'feat/dirty'), live = f.wt('wt-live', 'feat/live');
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'wip');
  const T = (Date.now() - 3 * 36e5) / 1e3;
  for (const d of [ok, dirty, live]) for (const e of [...fs.readdirSync(d).filter((n) => n !== '.git').map((n) => path.join(d, n)), d]) fs.utimesSync(e, T, T);
  const res = await runCleanup({ live: true, ...opts(f, { minAgeH: 2, worktreesOnly: true, cwds: new Set([live]) }) });
  assert.ok(!fs.existsSync(ok), 'idle merged clean one is removed');
  assert.ok(fs.existsSync(dirty), 'dirty one stays');
  assert.ok(fs.existsSync(live), 'one with a live cwd stays');
  const j = journalText({ res, before: 88, after: 79 });
  assert.match(j, /before: 88% after: 79%/);
  assert.ok(j.includes(`removed ${path.basename(ok)}`) || j.split('\n').some((l) => l.startsWith('removed ') && l.endsWith('wt-ok')), j);
});

test('diskUsedPct: percent in use, null when unreadable', () => {
  assert.equal(diskUsedPct('/', () => ({ blocks: 100, bavail: 12 })), 88);
  assert.equal(diskUsedPct('/', () => { throw new Error('x'); }), null);
});

test('tsc incremental cache and the generated API spec do not keep a merged worktree; a .env beside them still does', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.repo, '.gitignore'), '*.tsbuildinfo\nfrontend/public/docs/\n');
  fs.mkdirSync(path.join(f.repo, 'frontend')); fs.writeFileSync(path.join(f.repo, 'frontend', 'k.txt'), 'k');
  sh(f.repo, 'add', '.'); sh(f.repo, ...G, 'commit', '-qm', 'ignore'); sh(f.repo, 'push', '-q', 'origin', 'HEAD:main'); sh(f.repo, 'fetch', '-q');
  const put = (wt, rel) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), 'x'); };
  const ts = f.wt('wt-ts', 'feat/ts'); put(ts, 'frontend/.tsbuildinfo'); put(ts, 'frontend/public/docs/api/specs/server-all.yaml'); age(ts);
  const env = f.wt('wt-ts-env', 'feat/ts-env'); put(env, 'frontend/.tsbuildinfo'); put(env, '.env'); age(env);
  const doc = f.wt('wt-doc', 'feat/doc'); put(doc, 'frontend/public/docs/notes.md'); age(doc);   // any other ignored docs file stays precious
  const res = await runCleanup({ live: true, ...opts(f) });
  assert.ok(!fs.existsSync(ts), JSON.stringify(res.plan.skipped));
  assert.ok(fs.existsSync(env) && fs.existsSync(doc));
  assert.match(res.plan.skipped.find((s) => s.path === env).why, /ignored non-cache file: \.env/);
});

test('reviewer exports a killed review left behind go after 24 h; young or in-use ones stay', async () => {
  const f = fixture();
  const dir = path.join(f.state, 'integration', 'ui-review', 'reviewer');
  const mk = (id, old) => { const p = path.join(dir, id); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'x'), 'x'); if (old) fs.utimesSync(p, OLD, OLD); return p; };
  const gone = mk('int-old', true), young = mk('int-young', false), used = mk('int-used', true);
  await runCleanup({ live: true, ...opts(f, { cwds: new Set([used]) }) });
  assert.ok(!fs.existsSync(gone));
  assert.ok(fs.existsSync(young) && fs.existsSync(used));
});

test('--help and a mistyped flag print usage and delete nothing, even with the live switch on', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'disk-cleanup.json'), '{"live":true}');
  const policyFile = path.join(f.root, 'policy.json'); fs.writeFileSync(policyFile, JSON.stringify(f.policy));
  const a = f.wt('wt-help', 'feat/help'); age(a);
  const script = fileURLToPath(new URL('../scripts/disk-cleanup.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--policy', policyFile, '--no-fetch', ...args],
    { encoding: 'utf8', env: { ...process.env, GHOSTY_STATE_DIR: f.state, GHOSTY_URL: 'http://127.0.0.1:9' }, timeout: 60000 });
  for (const flag of ['--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^usage:/); assert.doesNotMatch(r.stdout, /LIVE|freed/);
  }
  const bad = run('--dryrun');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /unknown argument: --dryrun/);
  assert.ok(fs.existsSync(a), 'nothing removed');
  assert.ok(!fs.existsSync(path.join(f.state, 'disk-cleanup')), 'no run report written');
  assert.deepEqual(checkArgs(['--sweep', '--above', '85', '--min-age-h', '2', '--journal', 'j.md']), {}, 'the sweep unit command line is accepted');
  assert.match(checkArgs(['--journal']).error, /needs a value/);
});

test('a node_modules reached through a symlink survives: removing the linking worktree and cleaning idle caches', async () => {
  const f = fixture();
  const live = path.join(f.repo, 'node_modules', 'ws'); fs.mkdirSync(live, { recursive: true }); fs.writeFileSync(path.join(live, 'index.js'), 'x');
  const gone = f.wt('wt-link', 'feat/link'); fs.symlinkSync(path.join(f.repo, 'node_modules'), path.join(gone, 'node_modules')); age(gone);
  // an idle worktree whose real node_modules another worktree links to
  const owner = f.wt('wt-owner', 'feat/owner'); fs.writeFileSync(path.join(owner, 'w.txt'), 'w');
  fs.mkdirSync(path.join(owner, 'node_modules')); fs.writeFileSync(path.join(owner, 'node_modules', 'x'), 'x'); age(owner);
  const user = f.wt('wt-user', 'feat/user'); fs.writeFileSync(path.join(user, 'w.txt'), 'w'); fs.mkdirSync(path.join(user, 'frontend')); fs.writeFileSync(path.join(user, 'frontend', 'f.js'), 'f');
  fs.symlinkSync(path.join(owner, 'node_modules'), path.join(user, 'frontend', 'node_modules'));
  const res = await runCleanup({ live: true, ...opts(f) });
  assert.ok(!fs.existsSync(gone), JSON.stringify(res.plan.skipped));
  assert.ok(fs.existsSync(path.join(live, 'index.js')), "the checkout's node_modules is untouched");
  assert.ok(fs.existsSync(path.join(owner, 'node_modules', 'x')), 'a linked-to cache stays');
  assert.match(res.plan.skipped.find((s) => s.path === path.join(owner, 'node_modules')).why, /symlink target of/);
});
