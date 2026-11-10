import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { plan, apply, writePlan, inUse, dirtyFiles } from '../scripts/worktree-prune.js';

const OLDISO = new Date(Date.now() - 72 * 36e5).toISOString();
const ENV = { ...process.env, GIT_COMMITTER_DATE: OLDISO, GIT_AUTHOR_DATE: OLDISO };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const none = { sessions: new Set(), sessionsOk: true, branches: new Set(), worktrees: new Set(), leaseText: '' };
const OLD = Date.now() - 48 * 36e5;
const age = (dir) => { for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.utimesSync(path.join(dir, f), OLD / 1e3, OLD / 1e3); fs.utimesSync(dir, OLD / 1e3, OLD / 1e3); };

// origin (bare) + main clone `repo`; worktrees are added as siblings.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-prune-'));
  const origin = path.join(root, 'origin.git'), repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  sh(repo, 'add', '.'); sh(repo, ...G, 'commit', '-qm', 'init'); sh(repo, 'push', '-q', 'origin', 'HEAD:main');
  sh(repo, 'fetch', '-q');
  const wt = (name, branch) => { const p = path.join(root, name); sh(repo, 'worktree', 'add', '-q', '-b', branch, p, 'origin/main'); return p; };
  return { root, repo, wt };
}
const run = (f, extra = {}) => plan([f.repo], { refs: none, cwds: new Set(), state: f.root, ...extra });
const by = (p, name) => p.items.find((i) => path.basename(i.path) === name);

test('clean merged idle worktree is REMOVE; shared checkout, dirty, ahead, used, young, demo, open-integration are KEEP', async () => {
  const f = fixture();
  const w = {};
  for (const n of ['merged', 'dirty', 'ahead', 'used', 'young', 'demo-x', 'queued']) w[n] = f.wt(n, `b/${n}`);
  fs.writeFileSync(path.join(w.dirty, 'x.txt'), 'u');
  fs.writeFileSync(path.join(w.ahead, 'y.txt'), 'y'); sh(w.ahead, 'add', '.'); sh(w.ahead, ...G, 'commit', '-qm', 'y');
  fs.mkdirSync(path.join(w.merged, 'node_modules')); fs.writeFileSync(path.join(w.merged, 'node_modules', 'z'), 'z');
  for (const n of Object.keys(w)) if (n !== 'young') age(w[n]);
  fs.writeFileSync(path.join(w.young, 'now.txt'), 'n');
  const refs = { ...none, branches: new Set(['b/queued']) };
  const p = await run(f, { refs, cwds: new Set([path.join(w.used, 'sub')]) });
  assert.equal(by(p, 'repo').verdict, 'keep');
  assert.equal(by(p, 'repo').why, 'shared checkout');
  assert.equal(by(p, 'merged').verdict, 'remove', by(p, 'merged').why);
  assert.match(by(p, 'dirty').why, /uncommitted/);
  assert.match(by(p, 'ahead').why, /1 commit\(s\) ahead/);
  assert.match(by(p, 'used').why, /in use/);
  assert.match(by(p, 'young').why, /uncommitted|changed/);
  assert.match(by(p, 'demo-x').why, /owner/);
  assert.match(by(p, 'queued').why, /integration/);
});

test('a squash-merged branch (commits ahead but patch-equivalent) is REMOVE; an unpushed branch with new commits is not', async () => {
  const f = fixture();
  const w = f.wt('sq', 'b/sq');
  fs.writeFileSync(path.join(w, 'n.txt'), 'n'); sh(w, 'add', '.'); sh(w, ...G, 'commit', '-qm', 'n');
  sh(f.repo, 'cherry-pick', '--no-edit', 'b/sq'); sh(f.repo, 'push', '-q', 'origin', 'HEAD:main'); sh(f.repo, 'fetch', '-q');
  age(w);
  assert.equal(by(await run(f), 'sq').verdict, 'remove');
});

test('apply refuses a bad sha, a stale plan and a plan whose item changed; removes exactly the plan, logs sha, deletes merged branch', async () => {
  const f = fixture();
  const a = f.wt('gone', 'b/gone'), b = f.wt('later', 'b/later');
  age(a); age(b);
  const p = await run(f);
  const file = path.join(f.root, 'plan.json'), log = path.join(f.root, 'prune.jsonl');
  const sha = writePlan([f.repo], p, file);
  await assert.rejects(apply(file, 'bad', { logFile: log, refs: none, cwds: new Set(), state: f.root }), /sha does not match/);
  await assert.rejects(apply(file, sha, { logFile: log, now: Date.now() + 25 * 36e5, refs: none, cwds: new Set(), state: f.root }), /older than 24 h/);
  fs.writeFileSync(path.join(b, 'late.txt'), 'x');                    // b became dirty after the review
  await assert.rejects(apply(file, sha, { logFile: log, refs: none, cwds: new Set(), state: f.root }), /changed since the dry run/);
  fs.rmSync(path.join(b, 'late.txt')); age(b);
  const head = sh(a, 'rev-parse', 'HEAD');
  const r = await apply(file, sha, { logFile: log, refs: none, cwds: new Set(), state: f.root });
  assert.equal(r.removed.length, 2);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
  assert.equal(sh(f.repo, 'branch', '--list', 'b/gone'), '');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.branch === 'b/gone').sha, head);
});

test('inUse matches the dir and its subdirs only; untracked caches do not make a worktree dirty', () => {
  assert.ok(inUse('/w/a', new Set(['/w/a/x'])));
  assert.equal(inUse('/w/a', new Set(['/w/ab'])), null);
  const f = fixture(), w = f.wt('c', 'b/c');
  fs.mkdirSync(path.join(w, 'node_modules')); fs.writeFileSync(path.join(w, 'node_modules', 'q'), 'q');
  fs.mkdirSync(path.join(w, 'dist')); fs.writeFileSync(path.join(w, 'dist', 'q'), 'q');
  assert.deepEqual(dirtyFiles(w), []);
  fs.writeFileSync(path.join(w, 'real.txt'), 'r');
  assert.deepEqual(dirtyFiles(w), ['real.txt']);
});
