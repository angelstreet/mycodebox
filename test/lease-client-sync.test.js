// lease-client-sync: the installed vpt-lease copies follow scripts/vpt-lease of the deployed main (owner 2026-11-11, bug-fb46a741).
// Temp dirs, a fake git and a fake ssh that runs the remote script locally in a fake remote home; never the real ~/bin or a real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLeaseClientSync, readClientConfig, remoteInstallScript, sha256 } from '../lease-client-sync.js';
import { tmp } from './helpers-tmp.js';

const GOOD = '#!/usr/bin/env python3\nprint("new client")\n';
function setup({ branch = 'main', dirty = false, local = 'old', remote = 'old', cfg = 'VPT_LEASE_MODE=central-through-ssh\nVPT_LEASE_SSH_TARGET=<registry-host>\n', client = GOOD } = {}) {
  const root = tmp('lcs-root-'), home = tmp('lcs-home-'), rhome = tmp('lcs-rhome-'), state = tmp('lcs-state-');
  fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, 'scripts', 'vpt-lease'), client);
  fs.mkdirSync(path.join(home, 'bin')); fs.mkdirSync(path.join(home, '.config', 'vpt-lease'), { recursive: true });
  if (local != null) fs.writeFileSync(path.join(home, 'bin', 'vpt-lease'), local);
  fs.writeFileSync(path.join(home, '.config', 'vpt-lease', 'config'), cfg);
  if (remote != null) { fs.mkdirSync(path.join(rhome, 'bin')); fs.writeFileSync(path.join(rhome, 'bin', 'vpt-lease'), remote); }
  const calls = [];
  const exec = async (cmd, args, { input } = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return args.includes('symbolic-ref') ? { code: 0, stdout: `${branch}\n`, stderr: '' } : { code: dirty ? 1 : 0, stdout: '', stderr: '' };
    if (cmd === 'ssh') { const r = spawnSync('sh', ['-c', args.at(-1)], { input, env: { ...process.env, HOME: rhome } }); return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) }; }
    const r = spawnSync(cmd, args, { input }); return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const events = [];
  const s = createLeaseClientSync({ root, stateDir: state, home, exec, record: async (e) => { events.push(e); }, log: { log() {}, error() {} }, now: () => new Date('2026-11-11T08:00:00Z'), enabled: () => true });
  return { s, root, home, rhome, state, calls, events };
}
const read = (f) => fs.readFileSync(f, 'utf8');

test('old local and registry copies are replaced with the repo client, each with a backup, and journaled', async () => {
  const h = setup();
  const r = await h.s.sync();
  assert.deepEqual(r.results.map((x) => [x.target, x.state]), [['local', 'installed'], ['registry', 'installed']]);
  assert.equal(read(path.join(h.home, 'bin', 'vpt-lease')), GOOD);
  assert.equal(read(path.join(h.rhome, 'bin', 'vpt-lease')), GOOD);
  assert.equal(read(path.join(h.home, 'bin', 'vpt-lease.bak-20261111T080000')), 'old');
  assert.equal(read(path.join(h.rhome, 'bin', 'vpt-lease.bak-20261111T080000')), 'old');
  assert.equal(fs.statSync(path.join(h.rhome, 'bin', 'vpt-lease')).mode & 0o777, 0o755);
  assert.equal(read(path.join(h.state, 'lease-client-sync.jsonl')).trim().split('\n').length, 2);
  const again = await h.s.sync();
  assert.deepEqual(again.results.map((x) => x.state), ['same', 'same'], 'idempotent');
});

test('never from a worktree branch or a modified client; off switch; no ssh target = local only', async () => {
  for (const o of [{ branch: 'feat/x' }, { dirty: true }]) {
    const h = setup(o);
    assert.ok((await h.s.sync()).skipped);
    assert.equal(read(path.join(h.home, 'bin', 'vpt-lease')), 'old');
  }
  const h = setup({ cfg: 'VPT_LEASE_MODE=central\n' });
  const r = await h.s.sync();
  assert.deepEqual(r.results.map((x) => x.target), ['local']);
  assert.ok(!h.calls.some((c) => c[0] === 'ssh'));
});

test('a client that does not parse is never installed anywhere; the failure is a manager event', async () => {
  const h = setup({ client: 'def broken(:\n' });
  const r = await h.s.sync();
  assert.deepEqual(r.results.map((x) => x.state), ['failed', 'failed']);
  assert.equal(read(path.join(h.home, 'bin', 'vpt-lease')), 'old');
  assert.equal(read(path.join(h.rhome, 'bin', 'vpt-lease')), 'old');
  assert.deepEqual(fs.readdirSync(path.join(h.rhome, 'bin')), ['vpt-lease'], 'no stray .new file');
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].key, 'lease:client-sync');
});

test('config parsing keeps only the transport keys; remote paths are quoted', () => {
  assert.deepEqual(readClientConfig('VPT_LEASE_MODE=central-through-ssh\nVPT_LEASE_TOKEN=secret\nVPT_LEASE_SSH_TARGET="reg"\n# x\n'), { VPT_LEASE_MODE: 'central-through-ssh', VPT_LEASE_SSH_TARGET: 'reg' });
  assert.match(remoteInstallScript('~/bin/vpt-lease', 'S'), /t="\$HOME"\/'bin\/vpt-lease'/);
  assert.equal(sha256('x').length, 64);
});
