// Second independent verification pass (adapters + worktrees after fixes). Defects: { todo: 'defect: ...' }.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdapter as claude } from '../orchestration/adapters/claude.js';
import { findBypass, normalizeError, parseRetryAfterMs } from '../orchestration/adapters/common.js';
import { createWorktrees } from '../orchestration/worktrees.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-verify2-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mk = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const root = mk('root');
const bin = path.join(mk('bin'), 'cli');
fs.writeFileSync(bin, `#!/bin/sh
if [ "$M" = bg ]; then (sleep 0.3; touch late.txt) </dev/null >/dev/null 2>&1 & echo '{"type":"result"}'; exit 0; fi
if [ "$M" = flood ]; then i=0; while [ $i -lt 50010 ]; do echo x; i=$((i+1)); done; echo '{"type":"result","is_error":false,"result":"END"}'; exit 0; fi
echo '{"type":"result"}'
`);
fs.chmodSync(bin, 0o755);
const adapter = () => claude({ bin, env: { PATH: process.env.PATH, HOME: tmp }, allowedRoots: [root] });

test('verify2: bypass guard variants (attached short, inline, settings JSON)', () => {
  for (const bad of [['-sdanger-full-access'], ['-s=danger-full-access'], ['-anever'], ['-a=never'], ['-csandbox_mode=danger-full-access'],
    ["-capproval_policy='never'"], ['--settings={"permissions":{"defaultMode":"bypassPermissions"}}'], ['--permission', 'full']]) {
    assert.ok(findBypass(['x', ...bad, 'p'], [bad.length + 1]).length, bad.join(' '));
  }
  assert.deepEqual(findBypass(['exec', '-s', 'workspace-write', '-cmodel_reasoning_effort="high"', 'p'], [4]), []);
});

test('verify2: error taxonomy variants', () => {
  const c = (s, extra = {}) => normalizeError({ exit: 1, stderr: s, ...extra });
  assert.equal(c('at f (/a.js:429:3)').class, 'crash');
  assert.equal(c('HTTP 429 Too Many Requests').class, 'rate_limit');
  assert.equal(c('Error: 429 rate_limit_error').class, 'rate_limit');
  assert.equal(c("Cannot find module 'auth'").class, 'crash');
  assert.equal(c('Invalid API key').class, 'auth');
  assert.equal(c('x').retryable, false); // plain non-zero exit
  assert.equal(normalizeError({ signal: 'SIGKILL' }).retryable, true); // OOM-style death
  assert.equal(parseRetryAfterMs('resets in 2 hours'), 7_200_000);
  assert.equal(parseRetryAfterMs('retry after 1.5 minutes'), 90_000);
});

test('verify2: descendants of a finished run are stopped, no writes after done', { todo: 'defect: finish() sweeps the process group only on cancel/timeout; same-group descendants outlive a normal exit' }, async () => {
  const cwd = mk('root/bg');
  const run = adapter().start({ run_id: 'bg', cwd, prompt: 'x', env: { M: 'bg' } });
  await run.done;
  await sleep(700);
  assert.ok(!fs.existsSync(path.join(cwd, 'late.txt')));
});

test('verify2: the event cap never drops the final result', { todo: 'defect: MAX_EVENTS drops later events including result; keep result/error or drop oldest unparsed' }, async () => {
  const run = adapter().start({ run_id: 'fl', cwd: mk('root/fl'), prompt: 'x', env: { M: 'flood' } });
  await run.done;
  assert.ok(run.events.some((e) => e.type === 'result' && e.text === 'END'));
});

// ---- worktrees ---------------------------------------------------------------------------------
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
function setup(name) {
  const dir = mk(name);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  const held = new Map();
  let g = 0;
  const leases = {
    acquire(resource, o) { if (held.has(resource)) return { ok: false, code: 'E_HELD' }; const lease = { resource, lease_id: `l${++g}`, token: g, ...o }; held.set(resource, lease); return { ok: true, lease }; },
    validate(l) { return held.get(l.resource)?.lease_id === l.lease_id ? { ok: true } : { ok: false, code: 'E_FENCED' }; },
    release(l) { if (held.get(l.resource)?.lease_id === l.lease_id) held.delete(l.resource); return { ok: true }; },
    renew(l) { return { ok: true, lease: l }; },
  };
  const wtRoot = path.join(tmp, `${name}-wt`);
  return { dir, sha: sh(dir, 'rev-parse', 'HEAD'), held, wtRoot, wt: createWorktrees({ root: wtRoot, repoAllowlist: [dir], leases }) };
}

test('verify2: HEAD on another branch with commits blocks removal', async () => {
  const s = setup('otherbranch');
  const a = await s.wt.create({ repo: s.dir, task_id: 'tb', base_sha: s.sha, owner: 'o' });
  sh(a.path, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(a.path, 'w.txt'), 'w');
  sh(a.path, 'add', '.');
  sh(a.path, 'commit', '-q', '-m', 'w');
  await assert.rejects(s.wt.remove(a.path, { retain: false, owner: 'o' }), { code: 'E_UNMERGED' });
  await assert.rejects(s.wt.remove(a.path, { retain: false, owner: 'o', merged_into: 'refs/heads/v2task/tb' }), { code: /^E_/ });
  assert.ok(fs.existsSync(a.path));
});

test('verify2: metadata lease must belong to this worktree', { todo: "defect: trustedMeta does not check m.lease.resource; a substituted lease releases another task's lease" }, async () => {
  const s = setup('leaseswap');
  const x = await s.wt.create({ repo: s.dir, task_id: 'tx', base_sha: s.sha, owner: 'ox' });
  const y = await s.wt.create({ repo: s.dir, task_id: 'ty', base_sha: s.sha, owner: 'oy' });
  const mf = path.join(fs.realpathSync(s.wtRoot), '.v2-meta', 'tx.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.lease = y.lease;
  m.owner = 'oy';
  fs.writeFileSync(mf, JSON.stringify(m));
  await assert.rejects(s.wt.remove(x.path, { retain: false, owner: 'oy' }));
  assert.ok(s.held.has('worktree:ty'));
});

test('verify2: a task id can be reused after removal merged into a non-HEAD target', { todo: 'defect: branch -d keeps the merged branch (not merged into repo HEAD); re-create fails with a raw git error instead of E_EXISTS or succeeding' }, async () => {
  const s = setup('reuse');
  sh(s.dir, 'branch', 'release');
  const z = await s.wt.create({ repo: s.dir, task_id: 'tz', base_sha: s.sha, owner: 'o' });
  fs.writeFileSync(path.join(z.path, 'f.txt'), 'f');
  sh(z.path, 'add', '.');
  sh(z.path, 'commit', '-q', '-m', 'f');
  sh(s.dir, 'checkout', '-q', 'release');
  sh(s.dir, 'merge', '-q', '--ff-only', 'v2task/tz');
  sh(s.dir, 'checkout', '-q', 'main');
  assert.equal((await s.wt.remove(z.path, { retain: false, owner: 'o', merged_into: 'release' })).removed, true);
  await s.wt.create({ repo: s.dir, task_id: 'tz', base_sha: s.sha, owner: 'o' }).then(() => {}, (e) => assert.equal(e.code, 'E_EXISTS'));
});
