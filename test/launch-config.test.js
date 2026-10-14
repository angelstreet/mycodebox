import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchConfig, launchWarnings, managerCommand, hasBypass } from '../launch-config.js';
import { resumeCommand } from '../parking.js';

test('listener and create/manager/resume command defaults skip permission prompts (owner decision 2026-10-11)', () => {
  const { host, commands } = launchConfig({});
  assert.equal(host, '127.0.0.1');
  assert.equal(commands.claude, 'claude --dangerously-skip-permissions');
  assert.equal(commands.codex, 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(commands.minimax, 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode');
  assert.equal(managerCommand({}), 'claude --dangerously-skip-permissions --model opus --remote-control manager -n manager');
  // recorded process args never add a second bypass flag
  assert.equal(resumeCommand({ base: commands.claude, args: 'claude --dangerously-skip-permissions --permission-mode bypassPermissions --model opus', sessionId: 'fake-id' }), 'claude --dangerously-skip-permissions --model opus --resume fake-id');
  assert.deepEqual(launchWarnings({}), []);
});

test('explicit overrides win verbatim and only HOST draws a warning', () => {
  for (const flag of ['--dangerously-skip-permissions', '--yolo', '--sandbox danger-full-access', '-a never']) {
    const command = `custom ${flag} --secret synthetic-private-value`;
    const env = { HOST: '0.0.0.0', AGENT_CMD_CLAUDE: command };
    assert.equal(launchConfig(env).commands.claude, command);
    assert.equal(launchConfig(env).host, env.HOST);
    const warnings = launchWarnings(env);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^HOST overrides loopback/);
    assert.deepEqual(launchWarnings({ AGENT_CMD_CLAUDE: command }), []);
  }
  assert.equal(launchConfig({ AGENT_CMD_CLAUDE: '' }).commands.claude, '');
  assert.equal(launchConfig({ AGENT_CMD_CODEX: '' }).commands.codex, '');
  assert.equal(launchConfig({ AGENT_CMD_CODEX: 'codex' }).commands.codex, 'codex');
  assert.equal(managerCommand({ AGENT_CMD_CLAUDE: 'claude' }), 'claude --model opus --remote-control manager -n manager');
});

test('manager script command helper uses configured CLI without live operations', () => {
  const output = execFileSync(process.execPath, ['scripts/manager-command.js'], { env: { AGENT_CMD_CLAUDE: '/fake/claude' }, encoding: 'utf8' });
  assert.equal(output, '/fake/claude --model opus --remote-control manager -n manager');
});

test('server create/resume use the launch config and pre-accept folder trust (best effort)', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /const HOST = launch\.host/);
  assert.match(server, /const AGENT_CMDS = launch\.commands/);
  assert.match(server, /try \{ await trustFolder\(agent, dir\); \} catch/);
  assert.match(server, /try \{ await trustFolder\(trustAgent, r\.cwd\); \} catch/);
  assert.doesNotMatch(server, /dangerously-skip-permissions|dangerously-bypass/);   // the flags live only in launch-config
  const script = readFileSync(new URL('../scripts/manager-fresh.sh', import.meta.url), 'utf8');
  assert.match(script, /CMD=\$\(node "\$SCRIPT_DIR\/manager-command\.js"\)/);
  assert.doesNotMatch(script, /--dangerously/);
  assert.match(script, /trustFolder\('claude'/);
});

test('trustFolder pre-accepts claude and codex trust in temp config files, minimax is a no-op', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { trustFolder } = await import('../trust.js');
  const root = await mkdtemp(join(tmpdir(), 'trust-'));
  const keep = { c: process.env.CLAUDE_JSON_FILE, x: process.env.CODEX_CONFIG_FILE };
  try {
    process.env.CLAUDE_JSON_FILE = join(root, 'claude.json');
    process.env.CODEX_CONFIG_FILE = join(root, 'config.toml');
    await writeFile(process.env.CLAUDE_JSON_FILE, '{"projects":{}}');
    await writeFile(process.env.CODEX_CONFIG_FILE, '');
    await trustFolder('claude', '/fake/work');
    await trustFolder('codex', '/fake/work');
    await trustFolder('minimax', '/fake/work');
    assert.equal(JSON.parse(await readFile(process.env.CLAUDE_JSON_FILE, 'utf8')).projects['/fake/work'].hasTrustDialogAccepted, true);
    assert.match(await readFile(process.env.CODEX_CONFIG_FILE, 'utf8'), /trust_level = "trusted"/);
  } finally {
    for (const [k, v] of [['CLAUDE_JSON_FILE', keep.c], ['CODEX_CONFIG_FILE', keep.x]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});

test('hasBypass detects bypass forms and the adapter hard guard still refuses them', async () => {
  const { hasBypass } = await import('../launch-config.js');
  const { assertNoBypass } = await import('../orchestration/adapters/common.js');
  assert.equal(hasBypass('claude --dangerously-skip-permissions'), true);
  assert.equal(hasBypass('claude'), false);
  assert.throws(() => assertNoBypass(['claude', '--dangerously-skip-permissions']), /E_BYPASS|bypass/);
  assert.throws(() => assertNoBypass(['codex', '--dangerously-bypass-approvals-and-sandbox']), /bypass/);
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

test('hasBypass covers the forms the adapter hard guard refuses', () => {
  for (const c of ['mcode exec --permission full', 'codex -s danger-full-access', 'codex -sdanger-full-access',
    'claude --allow-dangerously-skip-permissions', 'claude --settings {"permissions":{"defaultMode":"bypassPermissions"}}']) {
    assert.equal(hasBypass(c), true, c);
  }
  for (const c of ['claude --permission-mode acceptEdits', 'mcode --permission smart', 'codex -s workspace-write']) {
    assert.equal(hasBypass(c), false, c);
  }
});
