// Independent Phase 1 review: regression floors for T03 (launch/resume/park: no bypass, validated argv/cwd),
// T04 (loopback listener, reporter loopback + token) and T17 (forbidden topics never auto-answered).
// T21 additions live in safe-restart.test.js (same fake-command harness). No server import, no tmux, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchConfig, launchWarnings, managerCommand } from '../launch-config.js';
import { resumeCommand, createParking } from '../parking.js';
import { sessionDirectory } from '../session-directory.js';
import { isLoopback, createReporter } from '../reporter.js';
import { createAlertApi } from '../api-extras.js';
import { classifyStall, applyJev, wouldSend, forbiddenMatch } from '../stall.js';

const ROOT = new URL('..', import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');
// Flags that switch off a CLI's permission or sandbox checks (Claude, Codex) — none may appear in a default.
const BYPASS_RE = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|bypassPermissions|danger-full-access|--yolo|--full-auto|approval_policy\s*=\s*"?never|(?:--ask-for-approval|-a)[= ]never/;
const FLAGS = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--permission-mode bypassPermissions',
  '--permission-mode=bypassPermissions', '--sandbox danger-full-access', '-a never', '--ask-for-approval=never', '--full-auto'];

const tmp = (t, prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(d, { recursive: true, force: true })); return realpathSync(d); };

// ---------------------------------------------------------------------------
// T03 — launch defaults, resume reconstruction, cwd validation
// ---------------------------------------------------------------------------

test('T03: no default agent, manager or resume command carries a permission or sandbox bypass', () => {
  for (const env of [{}, { HOME: '/home/user', PATH: '/usr/bin' }]) {
    for (const [agent, cmd] of Object.entries(launchConfig(env).commands)) assert.doesNotMatch(cmd, BYPASS_RE, agent);
    assert.doesNotMatch(managerCommand(env), BYPASS_RE);
    assert.deepEqual(launchWarnings(env), []);
    assert.doesNotMatch(resumeCommand({ base: launchConfig(env).commands.claude, args: '', name: 'x', sessionId: 'abc' }), BYPASS_RE);
  }
  assert.equal(launchConfig({}).commands.claude, 'claude');
  assert.equal(launchConfig({}).commands.codex, 'codex');
});

test('T03: resume never restores a saved process flag; only model, remote-control name and the id come back', () => {
  for (const flag of FLAGS) {
    const args = `/home/user/.local/bin/claude ${flag} --model opus --remote-control X -n X --allowedTools Bash`;
    const cmd = resumeCommand({ base: 'claude', args, name: 'X', sessionId: 'abc' });
    assert.equal(cmd, "claude --model opus --remote-control 'X' -n 'X' --resume abc", flag);
    assert.doesNotMatch(cmd, BYPASS_RE, flag);
  }
  // the saved model value is reduced to a plain token: no shell metacharacters or second option survive
  assert.equal(resumeCommand({ base: 'claude', args: 'claude --model opus;echo --remote-control X', name: 'X', sessionId: 'abc' }),
    "claude --model opus --remote-control 'X' -n 'X' --resume abc");
  assert.equal(resumeCommand({ base: 'claude', args: 'claude --model $(id)', sessionId: 'abc' }), 'claude --resume abc');
  assert.equal(resumeCommand({ base: 'claude', args: 'claude --model "opus --dangerously-skip-permissions"', sessionId: 'abc' }), 'claude --resume abc');
});

test('T03: a saved remote-control name is single-quoted for the shell', () => {
  const name = `n'$(touch /tmp/pwned)\`id\`;x`;
  const cmd = resumeCommand({ base: 'claude', args: 'claude --remote-control n', name, sessionId: 'abc' });
  const quoted = `'n'\\''$(touch /tmp/pwned)\`id\`;x'`;
  assert.equal(cmd, `claude --remote-control ${quoted} -n ${quoted} --resume abc`);
});

test('T03: a resume id must be a plain token (no options, paths, whitespace, control characters or non-strings)', () => {
  for (const id of ['', ' abc', 'abc ', '../x', 'a/b', '-x', '--resume', '--permission-mode=bypassPermissions', 'a b', 'a\tb', 'ab\u0000', 'a;b', 'a|b', '$(x)', '`x`', 123, null, {}, ['abc']]) {
    assert.throws(() => resumeCommand({ base: 'claude', sessionId: id }), (e) => e.status === 400 && /invalid resume session id/.test(e.message), JSON.stringify(id));
  }
  for (const id of ['abc', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'A_b-1']) {
    assert.equal(resumeCommand({ base: 'claude', sessionId: id }), `claude --resume ${id}`);
  }
});

test('T03: sessionDirectory rejects prefix siblings, files, missing dirs, traversal, symlink escapes and non-strings', async (t) => {
  const root = tmp(t, 'v2sec-dir-');
  const home = join(root, 'home'); mkdirSync(join(home, 'proj'), { recursive: true });
  mkdirSync(join(root, 'home2')); mkdirSync(join(root, 'outside'));
  writeFileSync(join(home, 'file.txt'), 'x');
  symlinkSync(join(root, 'outside'), join(home, 'escape'));
  symlinkSync(join(home, 'proj'), join(home, 'inside-link'));
  assert.equal(await sessionDirectory(home, home), home);
  assert.equal(await sessionDirectory(join(home, 'proj'), home), join(home, 'proj'));
  assert.equal(await sessionDirectory(join(home, 'proj', '..', 'proj'), home), join(home, 'proj'));
  assert.equal(await sessionDirectory(join(home, 'inside-link'), home), join(home, 'proj'));   // canonical path, not the link
  const rejects = async (cwd, re) => assert.rejects(sessionDirectory(cwd, home), (e) => e.status === 400 && re.test(e.message), String(cwd));
  await rejects(join(root, 'home2'), /under \$HOME/);              // "/home2".startsWith("/home") is not containment
  await rejects(join(root, 'outside'), /under \$HOME/);
  await rejects(join(home, '..', 'outside'), /under \$HOME/);
  await rejects(join(home, 'escape'), /under \$HOME/);
  await rejects(join(home, 'file.txt'), /existing directory/);
  await rejects(join(home, 'missing'), /existing directory/);
  for (const bad of [undefined, null, '', 123, {}, [home]]) await rejects(bad, /existing directory/);
});

test('T03: a tampered parked record cannot escape $HOME, start before validation, or resume without a cwd', async (t) => {
  const root = tmp(t, 'v2sec-park-');
  const home = join(root, 'home'); mkdirSync(join(home, 'work'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(home, 'escape'));
  const file = join(root, 'state', 'parked.json');
  const log = [];
  const tmux = { exists: async () => false, create: async (n, cwd) => log.push(['create', n, cwd]) };
  const start = async (n, r, cmd) => log.push(['start', n, cmd]);
  const validate = async (r) => { r.cwd = await sessionDirectory(r.cwd, home); };
  const save = (parked) => { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(file, JSON.stringify({ parked })); };
  const claude = (over) => ({ session: 'S', cwd: join(home, 'work'), sessionId: 'abc', claudeName: 'S', args: 'claude --dangerously-skip-permissions --model opus', parkedAt: 1, ...over });
  for (const [why, rec] of [
    ['cwd outside home', claude({ cwd: join(root, 'outside') })],
    ['cwd symlink escape', claude({ cwd: join(home, 'escape') })],
    ['cwd traversal', claude({ cwd: join(home, 'work', '..', '..', 'outside') })],
    ['cwd missing', claude({ cwd: join(home, 'gone') })],
    ['minimax record without cwd', { session: 'S', agent: 'minimax', cwd: null, args: '', parkedAt: 1 }],
    ['saved id is an option', claude({ sessionId: '--permission-mode=bypassPermissions' })],
    ['saved id is a shell fragment', claude({ sessionId: 'abc;id' })],
  ]) {
    save({ S: rec });
    const p = createParking({ file, tmux });
    await assert.rejects(p.resume('S', { base: 'claude', start, validate }), (e) => e.status === 400, why);
    assert.deepEqual(log, [], why);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).parked.S, `${why}: the record is kept, nothing was consumed`);
  }
  // the honest record resumes into the canonical folder with a clean command
  save({ S: claude() });
  const out = await createParking({ file, tmux }).resume('S', { base: 'claude', start, validate });
  assert.deepEqual(log, [['create', 'S', join(home, 'work')], ['start', 'S', 'claude --model opus --resume abc']]);
  assert.doesNotMatch(out.cmd, BYPASS_RE);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).parked, {});
});

test('T03: prototype-named sessions are not parked records', async (t) => {
  const root = tmp(t, 'v2sec-proto-');
  const file = join(root, 'parked.json');
  writeFileSync(file, JSON.stringify({ parked: {} }));
  const log = [];
  const p = createParking({ file, tmux: { exists: async () => false, create: async () => log.push('create') } });
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(p.resume(name, { base: 'claude', start: async () => log.push('start') }), (e) => e.status === 400 || e.status === 404, name);
  }
  assert.deepEqual(log, []);
});

test('T03: no bypass flag survives anywhere in the server, scripts or modules (launch-config detects them, nothing else names them)', () => {
  const files = ['server.js', 'parking.js', 'session-directory.js', 'manager.js', 'stall.js', 'deploy-runner.js', 'leases.js', 'handoffs.js',
    ...readdirSync(new URL('scripts', ROOT)).filter((f) => /\.(sh|js|py)$/.test(f)).map((f) => `scripts/${f}`),
    ...readdirSync(new URL('systemd', ROOT)).map((f) => `systemd/${f}`)];
  for (const f of files) assert.doesNotMatch(src(f), BYPASS_RE, f);
  const server = src('server.js');
  assert.match(server, /const AGENT_CMDS = launch\.commands/);
  assert.match(server, /const dir = await sessionDirectory\(cwd \|\| HOME, HOME\)/);
  assert.match(server, /validate: async \(r\) => \{ r\.cwd = await sessionDirectory\(r\.cwd, HOME\); \}/);
  assert.doesNotMatch(server, /trustFolder/);
  // every tmux call is an argv array; no shell string ever carries a session name or a command
  assert.doesNotMatch(server, /exec\(TMUX, `|exec\(`\$\{TMUX\}|shell:\s*true/);
  assert.match(server, /\['send-keys', '-t', `=\$\{real\}:`, '-l', '--', cmd\]/);
  assert.match(server, /\['new-session', '-d', '-s', real, '-c', dir/);
  // the manager restart takes its command from the shared helper, nothing hard-coded
  const fresh = src('scripts/manager-fresh.sh');
  assert.match(fresh, /CMD=\$\(node "\$SCRIPT_DIR\/manager-command\.js"\)/);
  assert.doesNotMatch(fresh, /claude --/);
});

test('T03: the manager command helper keeps an explicit override verbatim and its diagnostics name only the setting', () => {
  const run = (env) => spawnSync(process.execPath, ['scripts/manager-command.js'], { cwd: new URL('.', ROOT).pathname, env, encoding: 'utf8' });
  const clean = run({});
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'claude --model opus --remote-control manager -n manager');
  assert.equal(clean.stderr, '');
  const marker = 'synthetic-private-value-9f2a';
  const override = `/opt/wrap/claude --dangerously-skip-permissions --token ${marker}`;
  const r = run({ AGENT_CMD_CLAUDE: override, HOST: '192.0.2.10' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${override} --model opus --remote-control manager -n manager`);   // the owner's choice stands
  assert.match(r.stderr, /AGENT_CMD_CLAUDE/);
  assert.match(r.stderr, /HOST/);
  assert.ok(!r.stderr.includes(marker) && !r.stderr.includes('192.0.2.10') && !r.stderr.includes('/opt/wrap'), 'diagnostics never carry values');
});

// ---------------------------------------------------------------------------
// T04 — listener default, explicit HOST, reporter loopback + token
// ---------------------------------------------------------------------------

test('T04: loopback by default, an explicit tailnet HOST is honoured, warnings never carry the value', () => {
  assert.equal(launchConfig({}).host, '127.0.0.1');
  assert.equal(launchConfig({ HOST: '' }).host, '127.0.0.1');
  for (const h of ['127.0.0.1', '::1', 'localhost']) { assert.equal(launchConfig({ HOST: h }).host, h); assert.deepEqual(launchWarnings({ HOST: h }), []); }
  for (const h of ['192.0.2.10', '0.0.0.0', '::', 'fd7a:115c:a1e0::1']) {
    assert.equal(launchConfig({ HOST: h }).host, h, 'phone access over an explicit private address keeps working');
    const w = launchWarnings({ HOST: h });
    assert.equal(w.length, 1, h);
    assert.match(w[0], /HOST/);
    assert.ok(!w[0].includes(h), h);
  }
  const server = src('server.js');
  assert.match(server, /const HOST = launch\.host/);
  assert.match(server, /server\.listen\(PORT, HOST/);
  assert.match(server, /tlsServer\.listen\(TLS_PORT, HOST/);
  assert.doesNotMatch(server, /0\.0\.0\.0/);
  assert.doesNotMatch(src('launch-config.js'), /0\.0\.0\.0/);
  const unit = src('systemd/ghosty-sessions.service');
  assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(unit, /HOST=0\.0\.0\.0/);
});

test('T04: isLoopback accepts only loopback literals', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(a), a);
  for (const a of ['192.0.2.1', '198.51.100.7', '::ffff:192.0.2.1', '::ffff:198.51.100.7', 'fd7a:115c:a1e0::1', '0.0.0.0', '::', 'localhost',
    ' 127.0.0.1', '127.0.0.1 ', '127.0.0.1\n', '127.0.0.1:7777', '1127.0.0.1', '127.0.0.1.5', '', null, undefined, 127, {}]) {
    assert.ok(!isLoopback(a), JSON.stringify(a));
  }
});

test('T04: the alert channel needs loopback AND the token before it reads a body', async () => {
  const api = createAlertApi({ alert: () => true, tokenOk: (t) => t === 'good-token' });
  const body = { title: 't', body: 'b' };
  let read = 0;
  const call = (addr, headers) => api.handle({ remoteAddress: addr, headers, readBody: async () => { read++; return body; } });
  assert.equal((await call('192.0.2.1', { 'x-ghosty-reporter-token': 'good-token' })).status, 403, 'right token, wrong peer');
  assert.equal((await call('::ffff:198.51.100.7', { 'x-ghosty-reporter-token': 'good-token' })).status, 403);
  assert.equal((await call('127.0.0.1', { 'x-ghosty-reporter-token': 'bad' })).status, 401, 'right peer, wrong token');
  assert.equal((await call('127.0.0.1', {})).status, 401, 'right peer, no token');
  assert.equal((await call('127.0.0.1', { 'x-ghosty-reporter-token': ['good-token'] })).status, 401, 'array header is not a string');
  assert.equal(read, 0, 'no body is parsed for an unauthorized caller');
  assert.equal((await call('127.0.0.1', { 'x-ghosty-reporter-token': 'good-token' })).status, 200);
  assert.equal(read, 1);
});

test('T04: reporter token is created 0600, compared in full, and nothing matches before init', async (t) => {
  const dir = tmp(t, 'v2sec-rep-');
  const rep = createReporter({ stateDir: join(dir, 'state') });
  assert.equal(rep.tokenOk(''), false);
  assert.equal(rep.tokenOk(undefined), false);
  const file = await rep.init();
  const token = readFileSync(file, 'utf8').trim();
  assert.equal(token.length, 64);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(rep.tokenOk(token), true);
  for (const bad of [token.slice(0, -1), token + '0', token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(), ` ${token}`, '', null, 42]) {
    assert.equal(rep.tokenOk(bad), false, String(bad).slice(0, 8));
  }
  // a second reporter in the same state dir reuses the file instead of rotating it
  const again = createReporter({ stateDir: join(dir, 'state') });
  await again.init();
  assert.equal(again.tokenOk(token), true);
});

test('T04: server routes keep loopback + token on the reporter intake and the Origin check on every mutating request', () => {
  const server = src('server.js');
  const intake = server.indexOf("p === '/api/reporter/event'");
  assert.ok(intake > 0);
  const block = server.slice(intake, intake + 600);
  const loop = block.indexOf('isLoopback(req.socket.remoteAddress)');
  const tok = block.indexOf('reporter.tokenOk(req.headers[TOKEN_HEADER])');
  const ingest = block.indexOf('reporter.ingest(');
  assert.ok(loop > 0 && tok > loop && ingest > tok, 'peer check, then token, then ingest');
  assert.match(server, /p === '\/api\/alert'\)[\s\S]{0,300}alertApi\.handle\(\{ remoteAddress: req\.socket\.remoteAddress, headers: req\.headers/);
  assert.match(server, /if \(req\.method !== 'GET' && !originOk\(req\)\) return json\(res, 403/);
  assert.match(server, /if \(!originOk\(req\)\) \{ socket\.write\('HTTP\/1\.1 403 Forbidden/);
});

// ---------------------------------------------------------------------------
// T17 — forbidden topics are never auto-answered
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(60);
const pane = (body) => {
  const lines = ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`))];
  lines.push('', '✻ Baked for 3m 31s · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '                                   /rc');
  return lines;
};
const classify = (q) => classifyStall({ plain: pane(`Everything else is ready.\n${q}`), raw: null, state: 'done' });

const FORBIDDEN_QUESTIONS = [
  'Shall I continue and deploy it?', 'Shall I continue and DEPLOY it?', 'Shall I continue and re-deploy the host?',
  'Shall I continue and push this to main?', 'Shall I continue and merge the branch into main?', 'Shall I continue and git push?',
  'Shall I continue and force-push?', 'Shall I continue and reset --hard?', 'Shall I continue and delete the old rows?',
  'Shall I continue and remove the folder?', 'Shall I continue and rm -rf dist?', 'Shall I continue and truncate the table?',
  'Shall I continue and prune the images?', 'Shall I continue and run the migration?', 'Shall I continue and edit .env?',
  'Shall I continue and rotate the credentials?', 'Shall I continue and use the password?', 'Shall I continue and read the secret?',
  'Shall I continue and send the bearer header?', 'Shall I continue and paste the API key?', 'Shall I continue and add the ssh key?',
  'Shall I continue and pay the invoice?', 'Shall I continue and buy the domain?', 'Shall I continue and update billing?',
  'Shall I continue and add credit?', 'Shall I continue and mail the customer?', 'Shall I continue and run update_core?',
  'Shall I continue and systemctl restart the unit?', 'Shall I continue and pm2 restart api?', 'Shall I continue and restart the server?',
  'Shall I continue and start the rollout?',
];

test('T17: a forbidden topic blocks every answer source — rule, Jev continue, Jev take_recommended — in every case', () => {
  for (const q of FORBIDDEN_QUESTIONS) {
    const s = classify(q);
    assert.ok(s.forbidden, q);
    assert.equal(wouldSend(s).send, null, q);
    assert.match(wouldSend(s).why, /^forbidden: /, q);
    for (const choice of ['continue', 'take_recommended']) {
      const j = applyJev(s, choice);
      assert.ok(j.answer, `${choice} proposes an answer`);
      assert.equal(wouldSend(j).send, null, `${q} / ${choice}`);
      assert.match(wouldSend(j).why, /^forbidden: /, `${q} / ${choice}`);
    }
  }
  // the gate is on the stall itself, whatever the case or confidence claims
  for (const c of ['continue', 'menu_recommended', 'yesno', 'owner_decision', 'done']) {
    assert.equal(wouldSend({ case: c, answer: { text: 'Yes' }, forbidden: 'deploy', confidence: 1 }).send, null, c);
    assert.equal(wouldSend({ case: c, answer: { key: '1' }, forbidden: 'deploy' }).send, null, c);
  }
});

test('T17: the AI reviewer re-check catches a forbidden proposal text even when the question looked harmless', () => {
  for (const reply of ['Yes, deploy it.', 'Go ahead and delete the old table.', 'Use the password from .env.', 'Push it to main.', 'Pay the invoice now.', 'Reply to the customer.']) {
    assert.ok(forbiddenMatch(reply), reply);
  }
  for (const reply of ['Yes, continue.', 'Yes, go with your recommendation.', '1']) assert.equal(forbiddenMatch(reply), null, reply);
  // manager.js fire(): an AI answer is re-checked with forbiddenMatch and escalated, never typed
  const manager = src('manager.js');
  assert.match(manager, /forbiddenMatch\(auto\.answer\?\.text \|\| ''\)/);
  assert.match(manager, /!forbiddenMatch\(a\.proposed_reply\)/);
  assert.match(manager, /reason\.startsWith\('forbidden'\) \? humanWhy/);
});

// Rule-level filter gaps found during review: each of these is a deploy / delete / money question that classifies as
// `continue` and would be typed by the rule path (autoSend on, countdown elapsed) because FORBIDDEN_RE does not match.
test('T17: plain paraphrases of forbidden topics are recognised by the rule filter', { todo: 'defect: FORBIDDEN_RE misses redeploy / rebase onto main / drop the database / ship or release to production / restart the <name> service / charge the card / wipe or overwrite production — classified as continue and sent' }, () => {
  for (const q of ['Shall I redeploy staging and continue?', 'Should I continue and rebase this onto main?', 'Shall I continue and drop the database?',
    'Shall I continue and ship it to prod?', 'Shall I continue and release v2 to production?', 'Shall I continue and restart the ghosty service?',
    'Shall I continue and charge the card on file?', 'Shall I continue and wipe the old data?', 'Should I continue and overwrite the production config?']) {
    const s = classify(q);
    assert.ok(s.forbidden, `${q} -> forbidden`);
    assert.equal(wouldSend(s).send, null, `${q} -> not sent`);
  }
});
