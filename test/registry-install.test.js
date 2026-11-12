// bug-73b62192: scripts/registry-install.sh against a fake registry host (a local dir behind a fake ssh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers-tmp.js';

const ROOT = path.resolve(import.meta.dirname, '..');
function fakeHost() {
  const home = tmp('reg-home-'), bin = tmp('reg-bin-');
  fs.mkdirSync(path.join(home, 'mycodebox-lease/scripts'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do case "$1" in -o) shift 2;; *) shift;; esac; done\nshift\nHOME=' + home + ' exec sh -c "$*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'vpt-lease'), '#!/bin/sh\n[ "$1" = deploy ] && { [ -n "$FAKE_RUNNING" ] && echo "DEPLOY x state=running"; exit 0; }\nexit 0\n', { mode: 0o755 });
  return { home, bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REGISTRY_SSH: 'fake' } };
}
const run = (h, args = [], more = {}) => spawnSync('sh', [path.join(ROOT, 'scripts/registry-install.sh'), ...args], { env: { ...h.env, ...more }, encoding: 'utf8' });

test('dry run lists the registry files that differ from the repo; matching files are left alone', () => {
  const h = fakeHost();
  const dir = path.join(h.home, 'mycodebox-lease');
  fs.writeFileSync(path.join(dir, 'lease-service.js'), '// old\n');
  for (const f of ['lease-routes.js', 'catchup-supersede.js', 'lease-equivalence.js', 'scripts/lease-serve.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const r = run(h, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changed: lease-service\.js$/m);
  fs.copyFileSync(path.join(ROOT, 'lease-service.js'), path.join(dir, 'lease-service.js'));
  assert.match(run(h, ['--dry-run']).stdout, /already match/);
});

test('a running deploy defers the install (exit 3) and touches nothing', () => {
  const h = fakeHost();
  const dir = path.join(h.home, 'mycodebox-lease');
  fs.writeFileSync(path.join(dir, 'lease-service.js'), '// old\n');
  const r = run(h, [], { FAKE_RUNNING: '1' });
  assert.equal(r.status, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'lease-service.js'), 'utf8'), '// old\n');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.bak-')), []);
});

test('the lane installs the registry after a change to its files', () => {
  const lane = fs.readFileSync(path.join(ROOT, 'integration-lane.js'), 'utf8');
  assert.match(lane, /registry-install\.sh/);
  assert.match(lane, /REGISTRY_FILES = \[[^\]]*'lease-service\.js'/);
});

// the first real lane run (int-1a1cf2811c80e4cd2) rolled back because the registry was still starting: the round trip retries
function installable(failFirst) {
  const h = fakeHost();
  const dir = path.join(h.home, 'mycodebox-lease');
  fs.mkdirSync(path.join(h.home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(h.home, 'bin/mycodebox-lease-serve.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'lease-service.js'), '// old\n');
  for (const f of ['lease-routes.js', 'catchup-supersede.js', 'lease-equivalence.js', 'scripts/lease-serve.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const cnt = path.join(h.home, 'claims');
  fs.writeFileSync(path.join(h.bin, 'vpt-lease'), `#!/bin/sh
case "$1" in deploy) exit 0;; check|release) exit 0;;
claim) n=$(cat ${cnt} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${cnt}; [ $n -le ${failFirst} ] && exit 1; echo abc12345; exit 0;; esac
exit 0
`, { mode: 0o755 });
  return { h, dir };
}
test('install: the round trip retries while the registry starts, then keeps the new file', () => {
  const { h, dir } = installable(2);
  const r = run(h, [], { REGISTRY_RETRY_SLEEP: '0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(dir, 'lease-service.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'lease-service.js'), 'utf8'));
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length, 1);
});
test('install: a round trip that never works rolls the files back (exit 1)', () => {
  const { h, dir } = installable(1e6);
  const r = run(h, [], { REGISTRY_RETRY_SLEEP: '0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rolled back/);
  assert.equal(fs.readFileSync(path.join(dir, 'lease-service.js'), 'utf8'), '// old\n');
});

// the lane's minimal PATH has no ~/.local/bin: the client is found in ~/bin, and without it the install fails closed before touching anything
function minimalPath(h, where) {
  const only = tmp('reg-only-ssh-');
  fs.copyFileSync(path.join(h.bin, 'ssh'), path.join(only, 'ssh')); fs.chmodSync(path.join(only, 'ssh'), 0o755);
  if (where) { fs.mkdirSync(path.join(h.home, 'bin'), { recursive: true }); fs.copyFileSync(path.join(h.bin, 'vpt-lease'), path.join(h.home, where)); fs.chmodSync(path.join(h.home, where), 0o755); }
  return { PATH: `${only}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: h.home };   // node is for the fake remote side only
}
test('install: with a minimal PATH the client is found in ~/bin (first two lane runs rolled back on this)', () => {
  const { h, dir } = installable(0);
  const r = run(h, [], { ...minimalPath(h, 'bin/vpt-lease'), REGISTRY_RETRY_SLEEP: '0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(dir, 'lease-service.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'lease-service.js'), 'utf8'));
});
test('install: no vpt-lease client at all fails closed and touches nothing', () => {
  const { h, dir } = installable(0);
  const r = run(h, [], { ...minimalPath(h, null), REGISTRY_RETRY_SLEEP: '0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /client not found/);
  assert.equal(fs.readFileSync(path.join(dir, 'lease-service.js'), 'utf8'), '// old\n');
});
