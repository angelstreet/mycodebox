import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchConfig, launchWarnings, managerCommand } from '../launch-config.js';
import { resumeCommand } from '../parking.js';

test('listener and create/manager/resume command defaults preserve CLI checks', () => {
  const { host, commands } = launchConfig({});
  assert.equal(host, '127.0.0.1');
  assert.equal(commands.claude, 'claude');
  assert.equal(commands.codex, 'codex');
  assert.equal(managerCommand({}), 'claude --model opus --remote-control manager -n manager');
  assert.equal(resumeCommand({ base: commands.claude, args: 'claude --dangerously-skip-permissions --permission-mode bypassPermissions --model opus', sessionId: 'fake-id' }), 'claude --model opus --resume fake-id');
  assert.deepEqual(launchWarnings({}), []);
});

test('explicit overrides survive while unsafe diagnostics redact contents', () => {
  for (const flag of ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--permission-mode=bypassPermissions', '--sandbox danger-full-access', '-a never']) {
    const command = `custom ${flag} --secret synthetic-private-value`;
    const env = { HOST: '0.0.0.0', AGENT_CMD_CLAUDE: command };
    assert.equal(launchConfig(env).commands.claude, command);
    assert.equal(launchConfig(env).host, env.HOST);
    const warnings = launchWarnings(env);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /AGENT_CMD_CLAUDE/);
    assert.ok(warnings.every(w => !w.includes('synthetic-private-value') && !w.includes(command)));
  }
  assert.equal(launchConfig({ AGENT_CMD_CLAUDE: '' }).commands.claude, '');
});

test('manager script command helper uses configured CLI without live operations', () => {
  const output = execFileSync(process.execPath, ['scripts/manager-command.js'], { env: { AGENT_CMD_CLAUDE: '/fake/claude' }, encoding: 'utf8' });
  assert.equal(output, '/fake/claude --model opus --remote-control manager -n manager');
});

test('server create/resume and manager restart use audited config without implicit trust', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /const HOST = launch\.host/);
  assert.match(server, /const AGENT_CMDS = launch\.commands/);
  assert.doesNotMatch(server, /trustFolder|dangerously-skip-permissions|dangerously-bypass/);
  const script = readFileSync(new URL('../scripts/manager-fresh.sh', import.meta.url), 'utf8');
  assert.match(script, /CMD=\$\(node "\$SCRIPT_DIR\/manager-command\.js"\)/);
  assert.doesNotMatch(script, /dangerously/);
});

test('resume rejects shell and option injection in saved conversation ids', () => {
  for (const sessionId of ['fake;echo nope', '$(echo nope)', '--permission-mode=bypassPermissions', 'fake\ncommand', undefined]) {
    assert.throws(() => resumeCommand({ base: 'claude', sessionId }), /invalid resume session id/);
  }
});

test('directory validation rejects traversal and symlink escapes', async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sessionDirectory } = await import('../session-directory.js');
  const root = await mkdtemp(join(tmpdir(), 'launch-path-'));
  try {
    const home = join(root, 'home');
    const outside = join(root, 'outside');
    await mkdir(home); await mkdir(outside);
    await symlink(outside, join(home, 'escape'));
    assert.equal(await sessionDirectory(home, home), home);
    for (const cwd of [join(home, '..', 'outside'), join(home, 'escape')]) {
      await assert.rejects(sessionDirectory(cwd, home), /under \$HOME/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
