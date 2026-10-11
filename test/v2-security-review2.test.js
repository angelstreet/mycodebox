// Independent re-verification of the Phase 1 fix commit (F1-F8): adversarial probes beyond the fix tests, plus the
// root cause of the manager-wakes flake. Temp dirs, fake binaries, no server import, no tmux, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyStall, wouldSend, forbiddenMatch } from '../stall.js';
import { launchWarnings } from '../launch-config.js';
import { createParking } from '../parking.js';
import { writeWakesFile, startWakesLogger } from '../manager-wakes.js';

const tmp = (t, prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

// ---- F1 ------------------------------------------------------------------------------------------------------------
const RULE = '─'.repeat(60);
const pane = (body) => ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)),
  '', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc'];
const classify = (q, pre = 'Everything else is ready.') => classifyStall({ plain: pane(`${pre}\n${q}`), raw: null, state: 'done' });

test('F1: routine continue questions in everyday wording still auto-answer (no false positives on the common path)', () => {
  for (const q of ['Shall I continue with phase 2?', 'Should I continue and update the README?', 'Shall I continue and bump the version in package.json?',
    'Shall I continue and add the live-reload hook?', 'Should I continue and fix the failing test?', 'Shall I continue with the fee calculation?',
    'Shall I continue and restart the test run?', 'Shall I continue and release the mutex in the worker?', 'Should I continue and promote the constant to a module-level export?',
    'Shall I continue and drop the unused import?', 'Shall I continue and rebase the helper onto the new base class?', 'Shall I continue and ship the fix in this branch?']) {
    const s = classify(q);
    assert.equal(s.forbidden, null, q);
    assert.deepEqual(wouldSend(s).send, { text: 'Yes, continue.' }, q);
  }
  // narrative context counts too: a sentence before the question that names a forbidden topic still blocks (unchanged behaviour)
  assert.ok(classify('Shall I continue with the tests?', 'The staging rollout finished earlier today.').forbidden);
  assert.equal(classify('Shall I continue?', 'I restarted the dev server and it works.').forbidden, null);
});

test('F1 residual: still-unrecognised deploy / money / credential / deletion phrasings', () => {
  for (const q of ['Shall I continue and publish the package to npm?', 'Shall I continue and push the release tag?', 'Shall I continue and apply the terraform plan?',
    'Shall I continue and email the client?', 'Shall I continue and refund the order?', 'Shall I continue and transfer the funds?', 'Shall I continue and revoke the token?',
    'Shall I continue and rotate the signing key?', 'Shall I continue and rm the build directory?', 'Shall I continue and hard-reset the branch?',
    'Shall I continue and kill the production pods?', 'Shall I continue and upgrade the live database?', 'Shall I continue and restart ghosty?']) {
    const s = classify(q);
    assert.ok(s.forbidden, `${q} -> forbidden`);
    assert.equal(wouldSend(s).send, null, `${q} -> not sent`);
  }
});

test('F1 tuning: over-broad matches escalate harmless questions (safe direction, but every one costs an owner tap)', () => {
  for (const q of ['Shall I continue and charge ahead with the fee calculation?', 'Shall I continue and go live-reload?', 'Shall I continue with the rebase onto feature/main-menu?',
    'Shall I continue and release the lock on the live session?', 'Shall I continue and promote the helper to a shared module in staging/?']) {
    assert.equal(forbiddenMatch(q), null, q);
  }
});

// ---- F2 ------------------------------------------------------------------------------------------------------------
test('F2 ruling: a bad saved priority is refused before the validate hook, tmux or start; a good one reaches start intact', async (t) => {
  const root = tmp(t, 'rv2-prio-');
  const file = join(root, 'parked.json');
  const log = [];
  const tmux = { exists: async () => false, create: async (n) => log.push(['create', n]) };
  const rec = (priority) => ({ session: 'S', cwd: root, sessionId: 'abc', claudeName: 'S', args: '', parkedAt: 1, priority });
  writeFileSync(file, JSON.stringify({ parked: { S: rec('P7') } }));
  let validated = 0;
  await assert.rejects(createParking({ file, tmux }).resume('S', { base: 'claude', validate: async () => { validated++; }, start: async () => log.push('start') }), /invalid saved priority/);
  assert.equal(validated, 0, 'the record is rejected before any hook runs');
  assert.deepEqual(log, []);
  writeFileSync(file, JSON.stringify({ parked: { S: rec('P0') } }));
  let seen = null;
  await createParking({ file, tmux }).resume('S', { base: 'claude', start: async (n, r) => { seen = r.priority; } });
  assert.equal(seen, 'P0');
});

// ---- F3 ------------------------------------------------------------------------------------------------------------
function freshRun(t, { env = {}, pane = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rv2-fresh-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); const home = join(dir, 'home'); mkdirSync(bin); mkdirSync(home);
  const fake = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = process.env.FAKE_DIR; const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2);
let stdin = ''; if (args.includes('@-')) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify([cmd, ...args, ...(stdin ? [stdin] : [])]) + '\\n');
if (cmd === 'curl' && !args.includes('POST')) process.stdout.write(JSON.stringify({ status: { manager: { state: 'done', stall: {} } } }));
if (cmd === 'tmux' && args[0] === 'display') console.log('4242');
if (cmd === 'tmux' && args[0] === 'capture-pane') process.stdout.write(process.env.FAKE_PANE || '');
if (cmd === 'pgrep') process.exit(1);
`;
  for (const c of ['tmux', 'curl', 'pgrep', 'sleep', 'git']) writeFileSync(join(bin, c), fake, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [resolve('scripts/manager-fresh.sh')], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8', FAKE_DIR: dir, FAKE_PANE: pane, GHOSTY_URL: 'http://localhost:1', ...env },
    encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(r.error);
  let calls = [];
  try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ...r, calls, kicks: calls.filter(([c, ...a]) => c === 'curl' && a.includes('@-') && /Fresh start of the AI manager/.test(a.at(-1))), tmux: calls.filter(([c]) => c === 'tmux') };
}

test('F3: the executable check sees through env/exec wrappers', (t) => {
  for (const cmd of ['env FOO=1 no-such-agent-xyz', 'exec no-such-agent-xyz']) {
    const r = freshRun(t, { env: { AGENT_CMD_CLAUDE: cmd } });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, /manager command not found/);
    assert.deepEqual(r.tmux, [], cmd);
  }
});
test('F3: a quoted path with spaces fails closed before tmux (word-split check cannot resolve it)', (t) => {
  const r = freshRun(t, { env: { AGENT_CMD_CLAUDE: '"/opt/no such dir/claude" --model opus' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /manager command not found/);
  assert.deepEqual(r.tmux, []);
});
test('F3: an empty command aborts before tmux', (t) => {
  const r = freshRun(t, { env: { AGENT_CMD_CLAUDE: '' } });
  assert.equal(r.status, 1);
  assert.deepEqual(r.tmux, []);
});

// ---- F6 ------------------------------------------------------------------------------------------------------------
test('F6: more spellings of the known bypass switches are flagged; harmless config keys are not', () => {
  for (const flag of ['-a=never', '--ask-for-approval "never"', '--permission-mode "bypassPermissions"', '--sandbox=danger-full-access', '--config=approval_policy=never',
    `-c 'sandbox_mode = "danger-full-access"'`, '--dangerously-skip-permissions=true', '--yolo --model o3']) {
    assert.equal(launchWarnings({ AGENT_CMD_CODEX: `codex ${flag}` }).length, 1, flag);
  }
  for (const ok of ['codex -c approval_policy=untrusted', 'codex -c sandbox_mode=read-only', 'claude --permission-mode acceptEdits', 'mcode --permission smart', 'claude --allowedTools Bash']) {
    assert.deepEqual(launchWarnings({ AGENT_CMD_CODEX: ok }), [], ok);
  }
});
test('F6: legacy Codex spellings', () => {
  for (const flag of ['--approval-mode full-auto', `-c 'sandbox_permissions=["disk-full-write-access"]'`]) {
    assert.equal(launchWarnings({ AGENT_CMD_CODEX: `codex ${flag}` }).length, 1, flag);
  }
});

// ---- manager-wakes flake --------------------------------------------------------------------------------------------
// startWakesLogger() fires run() without awaiting it; the test then awaits its own run(). Both runs write the same
// <file>.tmp and rename it: the loser's rename fails with ENOENT (swallowed by log.error) and, when the second open
// truncates the tmp between the first writer's write and rename, the renamed file is momentarily EMPTY — exactly the
// [] !== [1, 3] seen once in a loaded full-suite run. Pre-existing (manager-wakes.js unchanged since bc8429b).
test('manager-wakes: an overlapping first run and a second run never race on the same tmp file', async (t) => {
  const errors = [];
  for (let i = 0; i < 60; i++) {
    const dir = tmp(t, 'rv2-wakes-');
    await writeWakesFile(dir, [{ start: '2026-10-04T10:00:00Z', n: 1 }]);
    await writeWakesFile(dir, [{ start: '2026-10-05T11:00:00Z', n: 3 }], '2026-10-05');
    const lg = startWakesLogger({ stateDir: dir, claudeDir: join(dir, 'none'), intervalMs: 1e9, now: () => Date.parse('2026-10-06T12:00:00Z'), log: { error: (...a) => errors.push(a.join(' ')) } });
    await lg.run(); lg.stop();
    const rows = readFileSync(join(dir, 'manager-wakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n);
    assert.deepEqual(rows, [1, 3], `iteration ${i}`);
    await new Promise((r) => setTimeout(r, 2));   // let the stray constructor run settle before the dir goes away
  }
  assert.deepEqual(errors, [], 'no writer may lose its rename');
});
