// central-through-ssh: scripts/vpt-lease forwards every call over ssh to the registry host's central client. Here ssh is a
// fake executable on PATH that records its argv and runs the forwarded remote command locally against a fake central client.
// No network, no live registry. Scratch dirs live under the home directory, never /tmp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vpt-lease');
const tmp = fs.mkdtempSync(path.join(os.homedir(), 'vpt-lease-ssh-test-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const sshLog = path.join(tmp, 'ssh.log'), remoteLog = path.join(tmp, 'remote.log'), order = path.join(tmp, 'order.log');

// fake ssh: logs argv as JSON, FAKE_SSH_EXIT=255 simulates a connect failure, otherwise runs the remote command string with sh
fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${sshLog}" "$@"
[ -n "$FAKE_SSH_EXIT" ] && { echo "ssh: connect failed" >&2; exit "$FAKE_SSH_EXIT"; }
for last; do :; done
exec sh -c "$last"
`, { mode: 0o755 });
// fake central client (the remote vpt-lease): logs its args and env marks, canned output per subcommand
const fakeRemote = path.join(tmp, 'fake-remote');
fs.writeFileSync(fakeRemote, `#!/bin/sh
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({args: process.argv.slice(3), mode: process.env.VPT_LEASE_MODE, fwd: process.env.VPT_LEASE_FORWARDED}) + "\\n")' "${remoteLog}" -- "$@"
echo "$1" >> "${order}"
case "$1" in
  claim) echo "L-42"; exit \${FAKE_CLAIM_CODE:-0};;
  heartbeat) echo ok; exit \${FAKE_HB_CODE:-0};;
  release) echo "released 1"; exit 0;;
  deploy) cat; exit 0;;
  *) echo "out:$*"; exit \${FAKE_CODE:-0};;
esac
`, { mode: 0o755 });
const localCmd = path.join(tmp, 'local-cmd');
fs.writeFileSync(localCmd, `#!/bin/sh\necho local-cmd >> "${order}"\nsleep \${LOCAL_SLEEP:-0}\nexit \${LOCAL_EXIT:-0}\n`, { mode: 0o755 });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
const reset = () => { for (const f of [sshLog, remoteLog, order]) fs.rmSync(f, { force: true }); };

function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-I', CLIENT, ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, LANG: 'C',
      VPT_LEASE_MODE: 'central-through-ssh', VPT_LEASE_SSH_TARGET: '<registry-host>', VPT_LEASE_REMOTE_CMD: fakeRemote,
      VPT_LEASE_TEST_FAST: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.stdin.end(input ?? '');
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('argv is quoted per argument, ssh never prompts and keeps alive, the remote side is forced to central and marked forwarded', async () => {
  reset();
  const weird = "it's a $(touch " + path.join(tmp, 'pwned') + ") \"x\" ; y";
  const r = await run(['list', 'env-a', weird, '--json']);
  assert.equal(r.code, 0); assert.equal(r.out, `out:list env-a ${weird} --json\n`);
  assert.ok(!fs.existsSync(path.join(tmp, 'pwned')), 'no shell injection');
  const ssh = JSON.parse(lines(sshLog)[0]);
  assert.deepEqual(ssh.slice(0, 8), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4']);
  assert.equal(ssh[8], '<registry-host>');
  assert.match(ssh[9], /^VPT_LEASE_MODE=central VPT_LEASE_FORWARDED=1 .*fake-remote list env-a /);
  const rem = JSON.parse(lines(remoteLog)[0]);
  assert.deepEqual(rem.args, ['list', 'env-a', weird, '--json']); assert.deepEqual([rem.mode, rem.fwd], ['central', '1']);
});

test('every command is forwarded unchanged, including central-only ones the legacy path refused', async () => {
  reset();
  const cmds = [['claim', 'env-a', 'host-1', '--agent', 'a', '--wait', '--expect', '5'], ['release', 'L1'], ['renew', 'L1', '--ttl', '30'], ['list'], ['check', 'env-a'],
    ['events', '--after', '3'], ['ticket', 'T1', '--wait'], ['heartbeat', 'L1', '--active'], ['mode', 'L1', 'pin'], ['validate', 'L1', '--agent', 'a'],
    ['deploy', 'request', 'env-a', '--scope', 'server', '--ref', 'r', '--agent', 'a'], ['narrow', 'L1', '--kind', 'host']];
  for (const c of cmds) assert.equal((await run(c)).code, 0, c.join(' '));
  assert.deepEqual(lines(remoteLog).map((l) => JSON.parse(l).args), cmds);
});

test('the remote exit code passes through exactly; ssh exit 255 is UNAVAILABLE (5), never free', async () => {
  for (const code of ['0', '1', '3', '4', '5']) {
    reset();
    const r = await run(['check', 'env-a'], { env: { FAKE_CODE: code } });
    assert.equal(r.code, Number(code), 'exit ' + code);
  }
  reset();
  const down = await run(['check', 'env-a'], { env: { FAKE_SSH_EXIT: '255' } });
  assert.equal(down.code, 5); assert.match(down.err, /UNAVAILABLE/); assert.match(down.err, /busy, not free/); assert.equal(lines(remoteLog).length, 0);
  const other = await run(['claim', 'env-a', 'x', '--agent', 'a', '--wait'], { env: { FAKE_SSH_EXIT: '255' } });
  assert.equal(other.code, 5);
});

test('stdin passes through to the remote client', async () => {
  reset();
  const r = await run(['deploy', 'finish', 'd1', '--status', 'done', '--tail-stdin'], { input: 'line one\nline two\n' });
  assert.equal(r.code, 0); assert.equal(r.out, 'line one\nline two\n');
});

test('--wait, --ticket, --expect reach the remote client (not ignored as in the legacy path)', async () => {
  reset();
  const r = await run(['claim', 'env-a', 'host-1', '--agent', 'a', '--wait', '--ticket', '--expect', '9']);
  assert.equal(r.code, 0); assert.doesNotMatch(r.err, /no queue|ignored/);
  assert.deepEqual(JSON.parse(lines(remoteLog)[0]).args, ['claim', 'env-a', 'host-1', '--agent', 'a', '--wait', '--ticket', '--expect', '9']);
});

test('run: claim --wait and release go over ssh, the command runs locally between them; its exit code passes through', async () => {
  for (const code of ['0', '7']) {
    reset();
    const r = await run(['run', 'env-a', 'host-1', '--agent', 'codebox:x', '--purpose', 'p', '--expect', '5', '--', localCmd], { env: { LOCAL_EXIT: code } });
    assert.equal(r.code, Number(code), r.err);
    assert.deepEqual(lines(order), ['claim', 'local-cmd', 'release']);
    const remote = lines(remoteLog).map((l) => JSON.parse(l).args);
    assert.deepEqual(remote[0], ['claim', 'env-a', 'host-1', '--agent', 'codebox:x', '--purpose', 'p', '--ttl', '120', '--mode', 'exclusive', '--wait', '--heartbeat-s', '300', '--expect', '5']);
    assert.deepEqual(remote.at(-1), ['release', 'L-42', '--agent', 'codebox:x', '--by', 'codebox:x', '--reason', 'run-finished']);
    assert.ok(!JSON.stringify(remote).includes('local-cmd'), 'the command is never sent to the registry host');
    assert.match(r.err, /lease L-42 held/);
  }
});

test('run: heartbeats go over ssh while the command runs and all end before the release; a refused heartbeat exits 6', async () => {
  reset();
  const r = await run(['run', 'env-a', 'host-1', '--agent', 'codebox:x', '--', localCmd], { env: { LOCAL_SLEEP: '1' } });
  assert.equal(r.code, 0);
  const subs = lines(order);
  assert.equal(subs[0], 'claim'); assert.equal(subs.at(-1), 'release');
  assert.ok(subs.filter((s) => s === 'heartbeat').length >= 1, 'heartbeat over ssh');
  assert.ok(!subs.slice(subs.indexOf('release')).includes('heartbeat'), 'no heartbeat after the release');
  reset();
  const lost = await run(['run', 'env-a', 'host-1', '--agent', 'codebox:x', '--', localCmd], { env: { LOCAL_SLEEP: '1', FAKE_HB_CODE: '1' } });
  assert.equal(lost.code, 6); assert.match(lost.err, /LEASE LOST/); assert.equal(lines(order).at(-1), 'release');
});

test('run: a busy or unreachable claim exits with that code and never runs the command or releases', async () => {
  for (const [env, code] of [[{ FAKE_CLAIM_CODE: '3' }, 3], [{ FAKE_SSH_EXIT: '255' }, 5]]) {
    reset();
    const r = await run(['run', 'env-a', 'host-1', '--agent', 'a', '--', localCmd], { env });
    assert.equal(r.code, code); assert.ok(!lines(order).includes('local-cmd')); assert.ok(!lines(order).includes('release'));
  }
});

test('no recursion: a forwarded call refuses to forward again, and the remote command runs with mode central', async () => {
  reset();
  const r = await run(['list'], { env: { VPT_LEASE_FORWARDED: '1' } });
  assert.equal(r.code, 1); assert.match(r.err, /already forwarded/); assert.equal(lines(sshLog).length, 0);
  const rr = await run(['run', 'env-a', 'x', '--agent', 'a', '--', localCmd], { env: { VPT_LEASE_FORWARDED: '1' } });
  assert.equal(rr.code, 1); assert.equal(lines(sshLog).length, 0);
  await run(['list']);
  const rem = JSON.parse(lines(remoteLog)[0]); assert.deepEqual([rem.mode, rem.fwd], ['central', '1']);
});

test('no VPT_LEASE_SSH_TARGET: VPT_LEASE_LEGACY (an ssh wrapper to the registry host) is the transport, same forwarding and exit codes', async () => {
  reset();
  const wrapper = path.join(tmp, 'wrapper');
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${path.join(tmp, 'wrapper.log')}"\n[ "$1" = ticket ] && { echo "T-1 pos=1"; exit 3; }\nexit 5\n`, { mode: 0o755 });
  const env = { VPT_LEASE_SSH_TARGET: '', VPT_LEASE_LEGACY: wrapper };
  const r = await run(['ticket', 'T1', '--wait'], { env });
  assert.equal(r.code, 3); assert.equal(r.out, 'T-1 pos=1\n');
  assert.match(fs.readFileSync(path.join(tmp, 'wrapper.log'), 'utf8'), /ticket T1 --wait/);
  assert.equal(lines(sshLog).length, 0);
  assert.equal((await run(['list'], { env })).code, 5);
});
