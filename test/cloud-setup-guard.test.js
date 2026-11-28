// cloud-setup.sh --force must never run npm ci through a node_modules symlink (it would empty the linked live folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('cloud-setup refuses npm ci when node_modules is a symlink, and leaves the target alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-guard-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/cloud-setup.sh'), path.join(dir, 'scripts/cloud-setup.sh'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const live = path.join(dir, 'live-modules');
  fs.mkdirSync(path.join(live, 'ws'), { recursive: true });
  fs.symlinkSync(live, path.join(dir, 'node_modules'));
  // npm on PATH is a trap: reaching it fails the test.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho NPM_CALLED; exit 9\n', { mode: 0o755 });
  const r = spawnSync('bash', ['scripts/cloud-setup.sh', '--force'], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /symlink/);
  assert.doesNotMatch(r.stdout, /NPM_CALLED/);
  assert.ok(fs.existsSync(path.join(live, 'ws')));
  assert.ok(!fs.existsSync(path.join(live, '.cloud-setup')));
  fs.rmSync(dir, { recursive: true, force: true });
});
