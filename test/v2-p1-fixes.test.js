// Phase 1 review fixes F1-F8: each finding has a test here (F5 also in safe-restart.test.js, F1 todo in v2-security-review.test.js).
// Fake tmux/curl/claude in a temp PATH, temp dirs only, no server import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyStall, wouldSend, forbiddenMatch } from '../stall.js';
import { hasBypass } from '../launch-config.js';
import { createParking } from '../parking.js';

const ROOT = new URL('..', import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const tmp = (t, prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(d, { recursive: true, force: true })); return realpathSync(d); };

// ---- F1: forbidden-topic paraphrases ------------------------------------------------------------------------------
const RULE = '─'.repeat(60);
const pane = (body) => ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)),
  '', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc'];
const classify = (q) => classifyStall({ plain: pane(`Everything else is ready.\n${q}`), raw: null, state: 'done' });

const FAMILIES = {
  redeploy: ['Shall I redeploy staging and continue?', 'Should I continue and re-deploy the host?', 'Shall I continue and Redeploy?'],
  'drop data': ['Shall I continue and drop the database?', 'Shall I continue and drop the old users table?', 'Should I continue and drop the db?', 'Shall I continue and drop the schema?'],
  'ship / release': ['Shall I continue and ship it to prod?', 'Shall I continue and release v2 to production?', 'Shall I continue and promote this to staging?',
    'Should I continue and roll out to live?', 'Shall I continue and go live?'],
  'restart service': ['Shall I continue and restart the ghosty service?', 'Should I continue and restart the web server?', 'Shall I continue and restart the daemon?'],
  'rebase main': ['Should I continue and rebase this onto main?', 'Should I continue and rebase on master?'],
  charge: ['Shall I continue and charge the card on file?', 'Should I continue and charge the customer account?', 'Shall I continue and use the card on file?'],
  'wipe / overwrite': ['Shall I continue and wipe the old data?', 'Should I continue and overwrite the production config?', 'Should I continue and overwriting the cache?'],
};
for (const [family, qs] of Object.entries(FAMILIES)) {
  test(`F1: ${family} paraphrases are forbidden and never sent by the rule path`, () => {
    for (const q of qs) {
      assert.ok(forbiddenMatch(q), `${q} -> forbiddenMatch`);
      const s = classify(q);
      assert.ok(s.forbidden, `${q} -> forbidden`);
      assert.equal(wouldSend(s).send, null, `${q} -> not sent`);
    }
  });
}
test('F1: routine continue-style questions are still auto-answerable (no new false positives)', () => {
  for (const q of ['Shall I continue?', 'Should I continue with the next phase?', 'Shall I continue and run the tests?', 'Should I continue and fix the lint?',
    'Should I proceed with the refactor?', 'Shall I continue and add the missing unit test?', 'Want me to continue and update the docs?']) {
    assert.equal(forbiddenMatch(q), null, q);
    const s = classify(q);
    assert.ok(!s.forbidden, `${q} -> not forbidden`);
    assert.ok(wouldSend(s).send, `${q} -> still sent`);
  }
});

// ---- F2 + F4: parking resume ---------------------------------------------------------------------------------------
test('F2: a tampered saved priority fails before any tmux session exists and the record stays parked', async (t) => {
  const root = tmp(t, 'p1fix-prio-');
  const file = join(root, 'parked.json');
  const log = [];
  const tmux = { exists: async () => false, create: async (n) => log.push(['create', n]) };
  const rec = (priority) => ({ session: 'S', cwd: root, sessionId: 'abc', claudeName: 'S', args: 'claude --model opus', parkedAt: 1, priority });
  for (const bad of ['P9', 'p0', '', 0, true, {}, ['P0'], 'P0; rm']) {
    writeFileSync(file, JSON.stringify({ parked: { S: rec(bad) } }));
    await assert.rejects(createParking({ file, tmux }).resume('S', { base: 'claude', start: async () => log.push('start') }), (e) => e.status === 400, String(bad));
    assert.deepEqual(log, [], `${JSON.stringify(bad)}: no tmux session, no start`);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).parked.S, 'record kept');
  }
  for (const ok of ['P0', 'P1', 'P2', null, undefined]) {
    log.length = 0;
    writeFileSync(file, JSON.stringify({ parked: { S: rec(ok) } }));
    await createParking({ file, tmux }).resume('S', { base: 'claude', start: async () => log.push('start') });
    assert.deepEqual(log, [['create', 'S'], 'start'], String(ok));
  }
});
test('F4: the name is validated before lookup and prototype names are never records', async (t) => {
  const root = tmp(t, 'p1fix-name-');
  const file = join(root, 'parked.json');
  writeFileSync(file, JSON.stringify({ parked: {} }));
  const log = [];
  const p = createParking({ file, tmux: { exists: async () => false, create: async () => log.push('create') } });
  let validated = 0;
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(await p.get(name), null, `get ${name}`);
    await assert.rejects(p.resume(name, { base: 'claude', validate: async () => { validated++; } }), (e) => e.status === 404, name);
  }
  assert.equal(await p.get('__proto__'), null);
  await assert.rejects(p.resume('__proto__', { base: 'claude', validate: async () => { validated++; } }), (e) => e.status === 404);
  for (const name of ['a b', '../x', '', 'x'.repeat(41), 7, null, {}]) {
    await assert.rejects(p.resume(name, { base: 'claude' }), (e) => e.status === 400, String(name));
  }
  assert.equal(validated, 0);
  assert.deepEqual(log, []);
});

// ---- F3: manager-fresh script + unit ------------------------------------------------------------------------------
function freshRun(t, { env = {}, withClaude = true, pane = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p1fix-fresh-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); const home = join(dir, 'home'); mkdirSync(bin); mkdirSync(home);
  const fake = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = process.env.FAKE_DIR; const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2);
let stdin = ''; if (args.includes('@-')) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify([cmd, ...args, ...(stdin ? [stdin] : [])]) + '\\n');
if (cmd === 'curl' && !args.includes('POST')) process.stdout.write(JSON.stringify({ status: { manager: { state: 'done', stall: {} } } }));
if (cmd === 'tmux' && args[0] === 'display') console.log('4242');
if (cmd === 'tmux' && args[0] === 'capture-pane') process.stdout.write(process.env.FAKE_PANE || '');
if (cmd === 'pgrep') {
  // Simulate: claude has exited (post-/exit) until the new launch command is typed into the pane,
  // then it is running so the readiness pgrep guard in the script can match the pane.
  const callsFile = path.join(dir, 'calls');
  if (fs.existsSync(callsFile)) {
    const calls = fs.readFileSync(callsFile, 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
    if (calls.some(([c, ...a]) => c === 'tmux' && a.includes('-l'))) process.exit(0);
  }
  process.exit(1);
}
`;
  for (const c of ['tmux', 'curl', 'pgrep', 'sleep', 'git', ...(withClaude ? ['claude'] : [])]) writeFileSync(join(bin, c), fake, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [resolve('scripts/manager-fresh.sh')], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8', FAKE_DIR: dir, FAKE_PANE: pane, GHOSTY_URL: 'http://localhost:1', ...env },
    encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(r.error);
  let calls = [];
  try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ...r, calls };
}
const kicks = (r) => r.calls.filter(([c, ...a]) => c === 'curl' && a.includes('@-') && /Fresh start of the AI manager/.test(a.at(-1)));
const tmuxCalls = (r) => r.calls.filter(([c]) => c === 'tmux');

test('F3: a missing launch executable aborts before tmux is touched', (t) => {
  for (const cmd of ['no-such-agent-xyz --foo', 'FOO=1 no-such-agent-xyz']) {
    const r = freshRun(t, { env: { AGENT_CMD_CLAUDE: cmd }, withClaude: false });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, /manager command not found: 'no-such-agent-xyz'/);
    assert.deepEqual(tmuxCalls(r), [], 'no tmux call at all');
    assert.equal(r.calls.filter(([c]) => c === 'curl').length, 0);
  }
});
test('F3: remote-control wait expiry exits non-zero and never types the kickoff', (t) => {
  const r = freshRun(t, { pane: '$ bash: claude: command not found\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /kickoff NOT sent/);
  assert.equal(kicks(r).length, 0);
  assert.ok(tmuxCalls(r).some(([, ...a]) => a.includes('-l')), 'the launch command itself was typed');
  assert.ok(tmuxCalls(r).filter(([, ...a]) => a.includes('capture-pane')).length >= 30, 'waited the full period');
});
test('F3: with the agent up the kickoff is sent once', (t) => {
  const r = freshRun(t, { pane: 'remote-control is active\n', env: { AGENT_CMD_CLAUDE: 'FOO=1 claude' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(r).length, 1);
});
test('F3: the timer unit loads the checkout .env like the dashboard unit', () => {
  assert.match(src('systemd/ghosty-manager-fresh.service'), /^EnvironmentFile=-\/home\/<user>\/ghosty-sessions\/\.env$/m);
  assert.match(src('systemd/ghosty-sessions.service'), /^EnvironmentFile=-\/home\/<user>\/ghosty-sessions\/\.env$/m);
});

// ---- F5: approved is busy (vocabulary: triage.js deploysLine + deploy-runner.js) ------------------------------------
test('F5: the idle check treats approved as busy and the vocabulary matches the deploy runner', () => {
  const script = src('scripts/safe-restart.sh');
  assert.match(script, /states = \{[^}]*"approved"[^}]*\}/);
  // Q199: approved stays busy unless the runner marked it blocked (lease/ticket); running is always busy
  assert.match(script, /item\["state"\] == "running" or \(not blocked and \(item\["state"\] == "approved"/);
  for (const s of ['awaiting-approval', 'queued', 'approved', 'running']) assert.ok(src('triage.js').includes(`'${s}'`), s);
});

// ---- F6: launch warnings ------------------------------------------------------------------------------------------
test('F6: more permission/sandbox bypass spellings are flagged', () => {
  for (const flag of ['--full-auto', '-c approval_policy=never', '-c approval_policy="never"', `-c 'approval_policy="never"'`, '--config approval_policy=never',
    '-c sandbox_mode=danger-full-access', `-c 'sandbox_mode="danger-full-access"'`, '--permission off', '--permission=off', '--permission-mode=bypassPermissions']) {
    assert.equal(hasBypass(`codex ${flag}`), true, flag);
  }
  for (const ok of ['codex', 'codex -c approval_policy=on-request', 'codex -c model=o3', 'mcode --permission ask', 'claude --permission-mode plan', 'codex --sandbox workspace-write', 'tool --full-automatic']) {
    assert.equal(hasBypass(ok), false, ok);
  }
});

// ---- F7: no real user/home in the example units -------------------------------------------------------------------
test('F7: systemd units carry placeholders and an example header, nothing machine-specific', () => {
  for (const f of readdirSync(new URL('systemd', ROOT)).filter((n) => n.endsWith('.service'))) {
    const s = src(`systemd/${f}`);
    assert.match(s, /^# EXAMPLE: copy/, f);
    assert.match(s, /^User=(?:<user>|root)$/m, f);   // root only where moving processes between units needs it
    assert.doesNotMatch(s, /\/home\/(?!<user>)/, f);
  }
});

// ---- F8: static no-bypass guard over every root module and script ---------------------------------------------------
test('F8: no root module or script names a bypass flag (launch-config.js is the one detector)', () => {
  const BYPASS = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|bypassPermissions|danger-full-access|--yolo|--full-auto|approval_policy\s*=\s*\\?"?never|(?:--ask-for-approval|-a)[= ]never|--permission[= ]off/;
  const roots = readdirSync(new URL('.', ROOT)).filter((f) => f.endsWith('.js') && f !== 'launch-config.js');
  const scripts = readdirSync(new URL('scripts', ROOT)).filter((f) => /\.(sh|js|py|mjs)$/.test(f)).map((f) => `scripts/${f}`);
  assert.ok(roots.includes('server.js') && roots.includes('trust.js') && scripts.length > 3);
  for (const f of [...roots, ...scripts]) assert.doesNotMatch(src(f), BYPASS, f);
});
