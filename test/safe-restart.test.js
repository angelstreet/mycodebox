import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const NOW = 1791201600000;
const snapshot = (patch = {}) => ({
  ok: true, error: '', at: NOW, deploys: [], enabled: false, running: {}, envs: ['test'], ...patch,
});
const deploy = (state) => ({ id: 'test-deploy', env: 'test', state });

function invoke(t, responses, args = [], sudoCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mycodebox-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'input.json'), JSON.stringify({ responses, sudoCode }));
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(path.join(dir, 'input.json')));
const read = (file, fallback) => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return fallback; } };
const write = (file, value) => fs.writeFileSync(path.join(dir, file), String(value));
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify([command, ...args]) + '\\n');
if (command === 'curl') {
  const n = Number(read('polls', 0)); write('polls', n + 1);
  const r = input.responses[Math.min(n, input.responses.length - 1)];
  process.stdout.write(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  if (args.includes('--write-out')) process.stdout.write('\\n' + (r.http || 200));
  process.exit(r.code || 0);
}
if (command === 'date') console.log(args[0] === '+%s%3N' ? ${NOW} + Number(read('elapsed', 0)) : Math.floor((${NOW} + Number(read('elapsed', 0))) / 1000));
if (command === 'sleep') write('elapsed', Number(read('elapsed', 0)) + Number(args[0]) * 1000);
if (command === 'sudo') process.exit(input.sudoCode);
if (command === 'systemctl') console.log('0');
`;
  for (const command of ['curl', 'sudo', 'systemctl', 'date', 'sleep']) {
    writeFileSync(join(dir, command), fake, { mode: 0o755 });
  }
  const result = spawnSync('/bin/bash', [resolve('scripts/safe-restart.sh'), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, LANG: 'C.UTF-8', GHOSTY_STATE_DIR: dir, FAKE_DIR: dir,
      GHOSTY_URL: 'http://localhost:7777' }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  let calls = [];
  try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}
const restarts = (r) => r.calls.filter(([c]) => c === 'sudo');
const response = (body = snapshot()) => ({ body });

for (const [name, body] of [
  ['empty object', {}], ['null', null], ['invalid JSON', '{'], ['failed snapshot', snapshot({ ok: false })],
  ['error despite ok', snapshot({ error: 'poll failed' })], ['stale', snapshot({ at: NOW - 60001 })],
  ['future', snapshot({ at: NOW + 1001 })], ['missing timestamp', snapshot({ at: null })],
  ['boolean timestamp', snapshot({ at: true })], ['invalid running id', snapshot({ running: { test: 1 } })],
  ['invalid envs', snapshot({ envs: {} })],
  ['duplicate JSON keys', JSON.stringify(snapshot()).replace('\"ok\":true', '\"ok\":false,\"ok\":true')],
  ['missing enabled', snapshot({ enabled: null })], ['wrong running shape', snapshot({ running: [] })],
  ['wrong deploy shape', snapshot({ deploys: {} })], ['unknown state', snapshot({ deploys: [deploy('unknown')] })],
  ['null record', snapshot({ deploys: [null] })], ['missing id', snapshot({ deploys: [{ state: 'done', env: 'test' }] })],
  ['duplicate id', snapshot({ deploys: [deploy('done'), deploy('done')] })],
]) test(`refuses ${name}`, (t) => {
  const r = invoke(t, [response(body)]);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
});

for (const [name, r] of [
  ['unreachable', { code: 7, body: '' }], ['timeout', { code: 28, body: snapshot() }],
  ['HTTP redirect', { http: 302, body: snapshot() }], ['HTTP error', { http: 503, body: snapshot() }],
]) test(`refuses ${name}`, (t) => {
  const result = invoke(t, [r]);
  assert.notEqual(result.status, 0);
  assert.equal(restarts(result).length, 0);
});

for (const patch of [
  { running: { test: 'test-deploy' } }, { deploys: [deploy('running')] },
  { enabled: true, deploys: [deploy('queued')] },
  { enabled: true, deploys: [deploy('awaiting-approval')] },
]) test(`blocks work ${JSON.stringify(patch)}`, (t) => {
  const r = invoke(t, [response(snapshot(patch))]);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
});

for (const state of ['done', 'failed', 'cancelled', 'queued', 'awaiting-approval']) {
  test(`disabled runner permits ${state} after recheck`, (t) => {
    const r = invoke(t, [response(snapshot({ deploys: [deploy(state)] }))]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.filter(([c]) => c === 'curl').length, 2);
    assert.deepEqual(restarts(r), [['sudo', '-n', 'systemctl', 'restart', 'ghosty-sessions']]);
  });
}

test('second snapshot blocks a newly running deploy', (t) => {
  const r = invoke(t, [response(), response(snapshot({ deploys: [deploy('running')] }))]);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
});
test('second snapshot error fails closed', (t) => {
  const r = invoke(t, [response(), { body: '', code: 7 }]);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
});
test('wait polls until safe then rechecks', (t) => {
  const r = invoke(t, [response(snapshot({ deploys: [deploy('running')] })), response()], ['--wait', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 1);
  assert.equal(r.calls.filter(([c]) => c === 'curl').length, 3);
  assert.equal(restarts(r).length, 1);
});
test('wait expires without restart', (t) => {
  const r = invoke(t, [response(snapshot({ deploys: [deploy('running')] }))], ['--wait', '1']);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
  assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 4);
});
test('wait never retries unknown status as idle', (t) => {
  const r = invoke(t, [{ body: '', code: 28 }], ['--wait', '1']);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 0);
  assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 0);
});
for (const args of [['--unknown'], ['--wait', '-1'], ['--wait', '1.5'], ['--wait', 'abc'], ['--wait', '1', 'extra'], ['--wait', '999999999999999999999']]) {
  test(`rejects arguments ${args.join(' ')}`, (t) => {
    const r = invoke(t, [response()], args);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 0);
  });
}
test('bare --wait keeps the ten minute default', (t) => {
  const r = invoke(t, [response()], ['--wait']);
  assert.equal(r.status, 0, r.stderr);
});
test('restart failure does not fall back to PID operations', (t) => {
  const r = invoke(t, [response()], [], 1);
  assert.notEqual(r.status, 0);
  assert.equal(restarts(r).length, 1);
  assert.equal(r.calls.filter(([c]) => c === 'systemctl').length, 0);
});

test('freshness cutoff is inclusive and enabled idle runner can restart', (t) => {
  const r = invoke(t, [response(snapshot({ at: NOW - 60000, enabled: true }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(restarts(r).length, 1);
});

// ---- Independent Phase 1 review additions (T21): refuse with a reason, never retry unknown, never kill ----
test('T21: unreachable API refuses with a visible reason and runs nothing, even when asked to wait', (t) => {
  for (const args of [[], ['--wait', '5']]) {
    const r = invoke(t, [{ code: 7, body: '' }], args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /NOT restarting: deploy API unavailable/);
    assert.equal(r.calls.filter(([c]) => c !== 'curl' && c !== 'date').length, 0, 'no sleep, sudo or systemctl');
  }
});
test('T21: a stale or malformed snapshot while waiting is unknown, not busy: no retry, exit 2', (t) => {
  for (const body of [snapshot({ at: NOW - 60001 }), snapshot({ at: '1791201600000' }), snapshot({ at: 1e400 }), '', snapshot({ ok: 'true' })]) {
    const r = invoke(t, [response(body)], ['--wait', '1']);
    assert.equal(r.status, 2, JSON.stringify(body));
    assert.match(r.stderr, /NOT restarting: invalid, unsuccessful, or stale deploy snapshot/);
    assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 0);
    assert.equal(restarts(r).length, 0);
  }
});
test('T21: a state outside the known vocabulary is refused whether or not the runner is on', (t) => {
  for (const enabled of [false, true]) {
    for (const state of ['approved', 'starting', 'RUNNING', '', null]) {
      const r = invoke(t, [response(snapshot({ enabled, deploys: [deploy(state)] }))]);
      assert.equal(r.status, 2, `${state} enabled=${enabled}`);
      assert.equal(restarts(r).length, 0);
    }
  }
});
test('T21: --wait 0 refuses busy work at once; --wait=N is not a form the script accepts', (t) => {
  const busy = invoke(t, [response(snapshot({ running: { test: 'test-deploy' } }))], ['--wait', '0']);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /NOT restarting: deploy work is running or can start automatically/);
  assert.equal(busy.calls.filter(([c]) => c === 'sleep').length, 0);
  assert.equal(restarts(busy).length, 0);
  const form = invoke(t, [response()], ['--wait=5']);
  assert.equal(form.status, 2);
  assert.equal(form.calls.length, 0);
});
test('T21: the script owns no kill path and restarts only through systemctl', () => {
  const script = readFileSync(resolve('scripts/safe-restart.sh'), 'utf8');
  assert.match(script, /^set -euo pipefail$/m);
  assert.doesNotMatch(script, /\b(?:kill|pkill|killall|pgrep|fuser|pidof)\b|\.pid\b/);
  assert.deepEqual(script.match(/systemctl \w+[^\n;]*/g), ['systemctl restart ghosty-sessions']);
  assert.match(script, /sudo -n systemctl restart ghosty-sessions/);
});
