import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const NOW = 1791201600000;
const tempDir = (t) => { const d = mkdtempSync(join(tmpdir(), 'mycodebox-restart-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const snapshot = (patch = {}) => ({
  ok: true, error: '', at: NOW, deploys: [], enabled: false, running: {}, envs: ['test'], ...patch,
});
const deploy = (state, o = {}) => ({ id: 'test-deploy', env: 'test', state, ...o });

function invoke(t, responses, args = [], sudoCode = 0, { dir = tempDir(t), env = {} } = {}) {
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
  // like the live API, a snapshot asked for later is stamped later (only where a test waits past the 60 s freshness window)
  const body = process.env.FAKE_FRESH && r.body && typeof r.body === 'object' ? { ...r.body, at: r.body.at + Number(read('elapsed', 0)) } : r.body;
  process.stdout.write(typeof body === 'string' ? body : JSON.stringify(body));
  if (args.includes('--write-out')) process.stdout.write('\\n' + (r.http || 200));
  process.exit(r.code || 0);
}
if (command === 'date') console.log(args[0] === '+%s%3N' ? ${NOW} + Number(read('elapsed', 0)) : Math.floor((${NOW} + Number(read('elapsed', 0))) / 1000));
if (command === 'sleep') {
  write('elapsed', Number(read('elapsed', 0)) + Number(args[0]) * 1000);
  // a fake review that "finishes" after N polls: stop that process (this test's own) and wait until its command line is gone
  if (process.env.FAKE_REVIEW_PID && Number(read('elapsed', 0)) >= Number(process.env.FAKE_REVIEW_ENDS_S) * 1000) {
    try { process.kill(Number(process.env.FAKE_REVIEW_PID)); } catch {}
    const gone = () => { try { return !fs.readFileSync('/proc/' + process.env.FAKE_REVIEW_PID + '/cmdline').length; } catch { return true; } };
    while (!gone()) {}
  }
}
if (command === 'sudo') { const n = Number(read('sudos', 0)); write('sudos', n + 1); process.exit(Array.isArray(input.sudoCode) ? input.sudoCode[Math.min(n, input.sudoCode.length - 1)] : input.sudoCode); }
if (command === 'systemctl') console.log('0');
`;
  for (const command of ['curl', 'sudo', 'systemctl', 'date', 'sleep']) {
    writeFileSync(join(dir, command), fake, { mode: 0o755 });
  }
  const result = spawnSync('/bin/bash', [resolve('scripts/safe-restart.sh'), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, LANG: 'C.UTF-8', GHOSTY_STATE_DIR: dir, FAKE_DIR: dir,
      GHOSTY_URL: 'http://localhost:7777', ...env }, encoding: 'utf8', timeout: 60000,   // several fake commands start per wait loop; 5 s was too tight under a loaded run
  });
  assert.ifError(result.error);
  let calls = [];
  try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}
const restarts = (r) => r.calls.filter(([c, ...a]) => c === 'sudo' && a.includes('ghosty-sessions'));
const usageRestarts = (r) => r.calls.filter(([c, ...a]) => c === 'sudo' && a.includes('ghosty-usage'));
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

test('an awaiting-approval request does not block, even with the runner on (approval needs the restart)', (t) => {
  const r = invoke(t, [response(snapshot({ enabled: true, deploys: [deploy('awaiting-approval')] })), response(snapshot({ enabled: true, deploys: [deploy('awaiting-approval')] }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(restarts(r).length, 1);
});

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
// bug-cdbffcbb: the lease registry was unreachable ~15 min after a deploy; the snapshot said ok:false + the cause and the guard
// gave up at once with a generic message. It must name the cause and, under --wait, retry (never treat unknown as idle).
const UNAVAIL = 'UNAVAILABLE - the lease service cannot be reached ([Errno 111] Connection refused).';
test('registry unavailable: names the cause, does not restart, no wait means no retry', (t) => {
  const r = invoke(t, [response(snapshot({ ok: false, error: UNAVAIL }))]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lease registry unavailable.*Connection refused/);
  assert.equal(restarts(r).length, 0);
  assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 0);
});
test('registry unavailable under --wait is retried until it recovers, then rechecked', (t) => {
  const r = invoke(t, [response(snapshot({ ok: false, error: UNAVAIL })), response(snapshot({ ok: false, error: UNAVAIL })), response()], ['--wait', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter(([c]) => c === 'sleep').length, 2);
  assert.equal(restarts(r).length, 1);
});
test('registry unavailable for the whole --wait: refuses and still names the cause', (t) => {
  const r = invoke(t, [response(snapshot({ ok: false, error: UNAVAIL }))], ['--wait', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Connection refused/);
  assert.match(r.stderr, /registry/);
  assert.equal(restarts(r).length, 0);
  assert.ok(r.calls.filter(([c]) => c === 'sleep').length >= 3);
});
test('a stale snapshot with a registry error is still unknown, never retried', (t) => {
  const r = invoke(t, [response(snapshot({ ok: false, error: UNAVAIL, at: NOW - 120000 }))], ['--wait', '1']);
  assert.notEqual(r.status, 0);
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
  assert.equal(usageRestarts(r).length, 0, 'no usage tailer restart after a failed main restart');
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
    for (const state of ['starting', 'RUNNING', '', null]) {
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
  assert.deepEqual(script.match(/systemctl [\w-]+ [^\n;|]*/g).map((m) => m.trim()), ['systemctl restart ghosty-sessions', 'systemctl try-restart ghosty-usage']);
  assert.match(script, /sudo -n systemctl restart ghosty-sessions/);
});
test('F5: an approved deploy is busy (exit 1, waitable) whether or not the runner is on', (t) => {
  for (const enabled of [false, true]) {
    const r = invoke(t, [response(snapshot({ enabled, deploys: [deploy('approved')] }))]);
    assert.equal(r.status, 1, `enabled=${enabled}`);
    assert.match(r.stderr, /deploy work is running or can start automatically/);
    assert.equal(restarts(r).length, 0);
  }
  const waited = invoke(t, [response(snapshot({ deploys: [deploy('approved')] })), response()], ['--wait', '1']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.calls.filter(([c]) => c === 'sleep').length, 1);
});

// ---- Q199 (owner 2026-10-20): a deploy blocked by a lease or a ticket cannot start before the restart: not pending ----
test('Q199: a blocked queued deploy does not block the restart, with the runner on or off', (t) => {
  for (const enabled of [false, true]) {
    const body = snapshot({ enabled, deploys: [deploy('queued', { blocked: true })] });
    const r = invoke(t, [response(body), response(body)]);
    assert.equal(r.status, 0, `enabled=${enabled}: ${r.stderr}`);
    assert.equal(r.calls.filter(([c]) => c === 'curl').length, 2);
    assert.deepEqual(restarts(r), [['sudo', '-n', 'systemctl', 'restart', 'ghosty-sessions']]);
  }
});

test('Q199: an unblocked queued deploy with the runner on is still busy', (t) => {
  for (const blocked of [false, undefined]) {
    const r = invoke(t, [response(snapshot({ enabled: true, deploys: [deploy('queued', blocked === undefined ? {} : { blocked })] }))]);
    assert.equal(r.status, 1, `blocked=${blocked}`);
    assert.match(r.stderr, /deploy work is running or can start automatically/);
    assert.equal(restarts(r).length, 0);
  }
});

test('Q199: a blocked approved deploy does not block the restart; an unblocked one does', (t) => {
  for (const enabled of [false, true]) {
    const r = invoke(t, [response(snapshot({ enabled, deploys: [deploy('approved', { blocked: true })] }))]);
    assert.equal(r.status, 0, `enabled=${enabled}: ${r.stderr}`);
    assert.equal(restarts(r).length, 1);
  }
  for (const enabled of [false, true]) {
    const r = invoke(t, [response(snapshot({ enabled, deploys: [deploy('approved', { blocked: false })] }))]);
    assert.equal(r.status, 1, `enabled=${enabled}`);
    assert.equal(restarts(r).length, 0);
  }
});

test('Q199: a running deploy is busy even when it carries blocked', (t) => {
  const r = invoke(t, [response(snapshot({ enabled: true, deploys: [deploy('running', { blocked: true })] }))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deploy work is running or can start automatically/);
  assert.equal(restarts(r).length, 0);
});

test('Q199: a non-boolean blocked is an invalid snapshot (exit 2), never read as idle', (t) => {
  for (const blocked of ['true', 1, 0, null, [], {}, '']) {
    for (const state of ['queued', 'approved', 'done']) {
      const r = invoke(t, [response(snapshot({ enabled: true, deploys: [deploy(state, { blocked })] }))]);
      assert.equal(r.status, 2, `${JSON.stringify(blocked)} on ${state}`);
      assert.match(r.stderr, /NOT restarting: invalid, unsuccessful, or stale deploy snapshot/);
      assert.equal(restarts(r).length, 0);
    }
  }
});

test('Q199: one blocked queued deploy beside a running one is still refused', (t) => {
  const r = invoke(t, [response(snapshot({ enabled: true, deploys: [deploy('queued', { id: 'a', blocked: true }), deploy('running', { id: 'b' })] }))]);
  assert.equal(r.status, 1);
  assert.equal(restarts(r).length, 0);
});

// Token audit 2026-11-28: usage/ changes merged with --deploy server stayed dormant because the usage tailer is its own unit.
test('a successful restart also restarts the usage tailer, after the main service', (t) => {
  const r = invoke(t, [response()]);
  assert.equal(r.status, 0, r.stderr);
  const sudo = r.calls.filter(([c]) => c === 'sudo');
  assert.deepEqual(sudo, [['sudo', '-n', 'systemctl', 'restart', 'ghosty-sessions'], ['sudo', '-n', 'systemctl', 'try-restart', 'ghosty-usage']]);
});

// exit 5 = what `systemctl try-restart` returns for a unit that does not exist (checked on codebox 2026-11-28): an install without the
// optional usage unit, or any usage-restart failure, only warns; the dashboard restart already succeeded and the script exits 0.
test('a failed usage tailer restart (or no such unit) only warns: exit 0, dashboard restarted', (t) => {
  const r = invoke(t, [response()], [], [0, 5]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(restarts(r).length, 1);
  assert.equal(usageRestarts(r).length, 1);
  assert.match(r.stdout, /restarted via systemctl/);
  assert.match(r.stderr, /usage tailer restart failed \(ghosty-sessions was restarted\)/);
});

// A restart throws a running UI review away (2026-11-28: one review started over 5 times). The guard waits for it, with a limit.
async function fakeReview(t, outDir) {
  const p = spawn('python3', ['-c', 'import time; print(1, flush=True); time.sleep(90)', '/somewhere/scripts/review/ui_review_gate.py', 'live', '--out', outDir], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => p.kill('SIGKILL'));
  await new Promise((r) => p.stdout.once('data', r));
  return p;
}
const sleeps = (r) => r.calls.filter(([c]) => c === 'sleep').length;

test('a running UI review is waited for, then the restart goes ahead after a fresh idle check', async (t) => {
  const dir = tempDir(t);
  const p = await fakeReview(t, join(dir, 'integration', 'ui-review', 'int-x', 'live'));
  const r = invoke(t, [response()], [], 0, { dir, env: { FAKE_REVIEW_PID: String(p.pid), FAKE_REVIEW_ENDS_S: '45' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /a UI review is running, waiting up to 10 min/);
  assert.doesNotMatch(r.stderr, /going ahead/);
  assert.equal(sleeps(r), 3);
  assert.equal(r.calls.filter(([c]) => c === 'curl').length, 5, 'idle is read again after every wait, and twice before the restart');
  assert.equal(restarts(r).length, 1);
});

test('the UI review wait has a limit: a review that never ends does not hold the restart', async (t) => {
  const dir = tempDir(t);
  await fakeReview(t, join(dir, 'integration', 'ui-review', 'int-x', 'pre-merge'));
  const r = invoke(t, [response()], [], 0, { dir, env: { GHOSTY_REVIEW_WAIT_MIN: '2', FAKE_FRESH: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sleeps(r), 8);
  assert.match(r.stderr, /still running after 2 min: going ahead/);
  assert.equal(restarts(r).length, 1);
});

test('the UI review wait never gets past the deploy guard, and does not use up the --wait time', async (t) => {
  const dir = tempDir(t);
  await fakeReview(t, join(dir, 'integration', 'ui-review', 'int-x', 'live'));
  const busy = response(snapshot({ running: { test: 'test-deploy' } }));
  // idle (review wait), then a deploy runs: still refused without --wait
  const refused = invoke(t, [response(), busy], [], 0, { dir, env: { GHOSTY_REVIEW_WAIT_MIN: '1' } });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(restarts(refused).length, 0);
  // 8 review polls (2 min) are longer than --wait 1: a deploy seen afterwards still gets its minute
  const dir2 = tempDir(t);
  await fakeReview(t, join(dir2, 'integration', 'ui-review', 'int-x', 'live'));
  const ok = invoke(t, [...Array(8).fill(response()), busy, response()], ['--wait', '1'], 0, { dir: dir2, env: { GHOSTY_REVIEW_WAIT_MIN: '2', FAKE_FRESH: '1' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(restarts(ok).length, 1);
});

test('a review of another state dir, or GHOSTY_REVIEW_WAIT_MIN=0, does not delay the restart', async (t) => {
  const dir = tempDir(t);
  await fakeReview(t, join(tempDir(t), 'integration', 'ui-review', 'int-x', 'live'));
  const other = invoke(t, [response()], [], 0, { dir });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(sleeps(other), 0);
  await fakeReview(t, join(dir, 'integration', 'ui-review', 'int-y', 'live'));
  const off = invoke(t, [response()], [], 0, { dir, env: { GHOSTY_REVIEW_WAIT_MIN: '0' } });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(sleeps(off), 0);
});

for (const bad of ['-1', '61', 'abc', '1.5']) {
  test(`rejects GHOSTY_REVIEW_WAIT_MIN=${bad}`, (t) => {
    const r = invoke(t, [response()], [], 0, { env: { GHOSTY_REVIEW_WAIT_MIN: bad } });
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
  });
}
