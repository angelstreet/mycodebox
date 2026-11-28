import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cbsession');
const home = tmp('cbs-');
const work = path.join(home, 'work'); fs.mkdirSync(work);
fs.writeFileSync(path.join(home, 'handover.md'), '# h\nGoal: do it.\nDone when:\n1. the check passes with a run id\n');
const runEnv = (extra, ...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, MCODE_NODE_DIR: '/opt/fake-node/bin', GHOSTY_STATE_DIR: path.join(home, 'state'), ...extra } });
const run = (...args) => runEnv({}, ...args);
const API_OK = { CBSESSION_API_INTERACTIVE: '1' };   // -b NAME is refused without it (interactive Claude Code on an API key)
const launch = (name) => fs.readFileSync(path.join(home, 'handovers', `${name}.launch.sh`), 'utf8');

test('dry run per provider writes the launch file and starts nothing', () => {
  let r = run('-x', '-n', 'cb-claude', '-d', work, '-m', 'haiku', '-t', 'do it');
  assert.equal(r.status, 0, r.stderr);
  const c = launch('cb-claude');
  assert.match(c, /--dangerously-skip-permissions --remote-control cb-claude -n cb-claude --model haiku/);
  assert.match(c, new RegExp(`cd ${work}`));
  const pr = fs.readFileSync(path.join(home, 'handovers', 'cb-claude.prompt.md'), 'utf8');
  assert.ok(pr.startsWith('Ship rule (owner 2026-11-11)'), 'the ship rule comes first');
  assert.match(pr, /\n\ndo it\n/, 'then the text');
  assert.match(pr, /found-bug --title/, 'then the found-bugs rule footer');
  r = run('-x', '-n', 'cb-codex', '-d', work, '-p', 'codex', '-m', 'gpt-x', '-t', 'x');
  assert.match(launch('cb-codex'), /codex --dangerously-bypass-approvals-and-sandbox -m gpt-x/);
  r = run('-x', '-n', 'cb-mm', '-d', work, '-p', 'minimax', '-t', 'x');
  assert.match(launch('cb-mm'), /export PATH=\/opt\/fake-node\/bin:\S+\/\.local\/bin:\$PATH\n/);
  assert.match(launch('cb-mm'), /command -v mcode >\/dev\/null \|\| \{ echo .*exit 127; \}\nmcode -m minimax\/MiniMax-M3 /);
  r = run('-x', '-n', 'cb-oc', '-d', work, '-p', 'opencode', '-m', 'p/m', '-t', 'x');
  assert.match(launch('cb-oc'), /opencode -m p\/m --prompt/);
  r = run('-x', '-n', 'cb-h', '-d', work, '-H', path.join(home, 'handover.md'));
  assert.match(fs.readFileSync(path.join(home, 'handovers', 'cb-h.prompt.md'), 'utf8'), /Read the handover: .*handover\.md/);
});

test('billing: sub drops env keys, -b NAME points apiKeyHelper at the key file', () => {
  let r = run('-x', '-n', 'cb-sub', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-sub'), /env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN (?:CLAUDE_CODE_SUBAGENT_MODEL=sonnet )?\S+\/claude --dangerously/);
  const kd = path.join(home, '.config', 'anthropic'); fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, 'team.key'), 'sk-ant-secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(kd, 'team.workspace'), 'wrkspc_abc\n');
  r = run('-x', '-n', 'cb-refused', '-d', work, '-b', 'team', '-t', 'x');
  assert.equal(r.status, 2, 'an interactive session on an API key is refused');
  assert.match(r.stderr, /refused: -b team would start an INTERACTIVE Claude Code session on an API key/);
  assert.match(r.stderr, /claude -p/);
  assert.ok(!fs.existsSync(path.join(home, 'handovers', 'cb-refused.launch.sh')), 'nothing written for a refused start');
  r = runEnv(API_OK, '-x', '-n', 'cb-team', '-d', work, '-b', 'team', '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  const sj = path.join(home, 'handovers', 'cb-team.settings.json');
  assert.match(launch('cb-team'), new RegExp(`claude --settings ${sj} --dangerously`));
  const st = JSON.parse(fs.readFileSync(sj, 'utf8'));
  assert.equal(st.apiKeyHelper, `cat "${path.join(kd, 'team.key')}"`);
  assert.equal(st.env.ANTHROPIC_CUSTOM_HEADERS, 'anthropic-workspace-id: wrkspc_abc');
  assert.ok(!launch('cb-team').includes('sk-ant-secret') && !fs.readFileSync(sj, 'utf8').includes('sk-ant-secret'));
  assert.equal(runEnv(API_OK, '-x', '-n', 'cb-nokey', '-d', work, '-b', 'missing', '-t', 'x').status, 2);
  assert.equal(runEnv(API_OK, '-x', '-n', 'cb-mmb', '-d', work, '-p', 'minimax', '-b', 'team', '-t', 'x').status, 2);
});

test('argument errors', () => {
  assert.equal(run('-x', '-n', 'bad name', '-d', work, '-t', 'x').status, 2);
  assert.equal(run('-x', '-n', 'ok', '-d', '/nonexistent-dir', '-t', 'x').status, 2);
  assert.equal(run('-x', '-n', 'ok', '-d', work, '-p', 'nope', '-t', 'x').status, 2);
  assert.equal(run('-x', '-n', 'ok', '-d', work).status, 2);
});

test('the script has no host name or hard-coded node dir without the override', () => {
  const s = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/(?<!my)codebox/i.test(s));
  assert.match(s, /\$\{MCODE_NODE_DIR:-/);
  assert.ok(!/node-v24\.\d+\.\d+/.test(s), 'no node version is hardcoded');
});

test('minimax: the newest ~/.local/node-v24* wins, MCODE_NODE_DIR overrides, a missing mcode fails loudly', () => {
  for (const v of ['v24.9.0', 'v24.22.1', 'v24.21.0']) fs.mkdirSync(path.join(home, '.local', `node-${v}-linux-x64`, 'bin'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state') };
  let r = spawnSync('bash', [SCRIPT, '-x', '-n', 'cb-mm2', '-d', work, '-p', 'minimax', '-t', 'x'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-mm2'), /node-v24\.22\.1-linux-x64\/bin:\S+\/\.local\/bin:\$PATH/);
  assert.ok(!launch('cb-mm2').includes('v24.21.0'));
  // a real start with no mcode anywhere refuses before it creates a tmux session
  r = spawnSync('bash', [SCRIPT, '-n', 'cb-mm3', '-d', work, '-p', 'minimax', '-t', 'x'], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mcode not found/);
  // the launch file itself fails loudly when run without mcode
  const out = spawnSync('bash', [path.join(home, 'handovers', 'cb-mm2.launch.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } });
  assert.equal(out.status, 127);
  assert.match(out.stderr, /mcode not found/);
});

test('every launcher exports the lease agent name for the MCP X-Agent-Name header (bug-c6a65805)', () => {
  const r = run('-x', '-n', 'cb-agentname', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-agentname'), /\nexport VPT_AGENT_NAME=[A-Za-z0-9_-]+:cb-agentname\n/);
});

test('no workers by default: prompt rule, -K opt-in, refusal from a session without -K', () => {
  let r = run('-x', '-n', 'cb-nw', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(home, 'handovers', 'cb-nw.prompt.md'), 'utf8'), /\*\*No workers\*\*/);
  assert.match(launch('cb-nw'), /export CBSESSION_PARENT=cb-nw\n/);
  assert.match(launch('cb-nw'), /CBSESSION_WORKERS_OK=\n/);
  r = run('-x', '-n', 'cb-w', '-d', work, '-K', '-t', 'x');
  assert.match(fs.readFileSync(path.join(home, 'handovers', 'cb-w.prompt.md'), 'utf8'), /\*\*Workers\*\*/);
  assert.match(launch('cb-w'), /export CBSESSION_WORKERS_OK=1\ncd /);
  const env = (extra) => ({ PATH: process.env.PATH, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state'), ...extra });
  const go = (extra, ...a) => spawnSync('bash', [SCRIPT, ...a], { encoding: 'utf8', env: env(extra) });
  r = go({ CBSESSION_PARENT: 'boss' }, '-x', '-n', 'cb-c1', '-d', work, '-t', 'x');
  assert.equal(r.status, 2); assert.match(r.stderr, /was not started with workers allowed/);
  assert.equal(go({ CBSESSION_PARENT: 'boss', CBSESSION_WORKERS_OK: '1' }, '-x', '-n', 'cb-c2', '-d', work, '-t', 'x').status, 0);
  assert.equal(go({ CBSESSION_PARENT: 'boss' }, '-x', '-A', '-n', 'cb-c3', '-d', work, '-t', 'x').status, 0);
});

test('a claude session starts on the active Claude account (the rotation reaches cbsession)', () => {
  // bug-6434d8a9: without this every session started here ran on the default account and burned its quota
  const state = path.join(home, 'state');
  const acct = path.join(home, '.claude-accounts', 'team1');
  fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(acct, '.credentials.json'), '{}');
  const accountsFile = path.join(state, 'claude-accounts.json');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(accountsFile, JSON.stringify({ active: 'team1', accounts: [{ id: 'default' }, { id: 'team1', configDir: acct }] }));
  let r = run('-x', '-n', 'cb-acct', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-acct'), new RegExp(`export CLAUDE_CONFIG_DIR=${acct}\\n`));
  assert.match(launch('cb-acct'), /export GHOSTY_CLAUDE_ACCOUNT=team1\n/);
  // the default account: nothing to export, as before
  fs.writeFileSync(accountsFile, JSON.stringify({ active: 'default', accounts: [{ id: 'default' }] }));
  r = run('-x', '-n', 'cb-def', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!launch('cb-def').includes('CLAUDE_CONFIG_DIR'), 'the default account needs no config dir');
  // an account without a login is not used: the session stays on the default account
  const noLogin = path.join(home, '.claude-accounts', 'nologin');
  fs.mkdirSync(noLogin, { recursive: true });
  fs.writeFileSync(accountsFile, JSON.stringify({ active: 'team1', accounts: [{ id: 'default' }, { id: 'team1', configDir: noLogin }] }));
  r = run('-x', '-n', 'cb-nologin', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!launch('cb-nologin').includes('CLAUDE_CONFIG_DIR'), 'no login, no account');
  // an API key is its own billing: no account either
  const kd = path.join(home, '.config', 'anthropic'); fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, 'acckey.key'), 'sk-ant-fake\n', { mode: 0o600 });
  fs.writeFileSync(accountsFile, JSON.stringify({ active: 'team1', accounts: [{ id: 'default' }, { id: 'team1', configDir: acct }] }));
  r = runEnv(API_OK, '-x', '-n', 'cb-key', '-d', work, '-b', 'acckey', '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!launch('cb-key').includes('CLAUDE_CONFIG_DIR'), 'the API key billing keeps the default account');
  // another provider is not a Claude session
  r = run('-x', '-n', 'cb-mmacct', '-d', work, '-p', 'minimax', '-t', 'x');
  assert.ok(!launch('cb-mmacct').includes('CLAUDE_CONFIG_DIR'));
  fs.rmSync(accountsFile, { force: true });
});

// The start report comes only once the agent is up: a startup prompt in those seconds was queued for the owner (2026-11-26).
test('a manager start is on record before the tmux session exists; an owner start writes nothing', () => {
  const bin = path.join(home, 'shim'); fs.mkdirSync(bin, { recursive: true });
  const seen = path.join(home, 'at-new-session.jsonl'), state = path.join(home, 'state-early'), children = path.join(state, 'manager-children.jsonl');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\n[ "$1" = new-session ] && cat "${children}" > "${seen}" 2>/dev/null\nexit 1\n`, { mode: 0o755 });
  const start = (name, by) => spawnSync('bash', [SCRIPT, '-n', name, '-d', work, '-p', 'codex', '-t', 'x'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GHOSTY_STATE_DIR: state, CBSESSION_BY: by } });
  start('cb-early', 'manager');
  assert.match(fs.readFileSync(seen, 'utf8'), /"session":"cb-early","by":"manager"/);
  start('cb-early-own', 'dashboard');
  assert.doesNotMatch(fs.readFileSync(children, 'utf8'), /cb-early-own/);
});

test('no -m: a Claude session starts on sonnet (owner 2026-11-28); -m wins; other providers get no default from it', () => {
  let r = run('-x', '-n', 'cb-default', '-d', work, '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-default'), /-n cb-default --model sonnet /);
  run('-x', '-n', 'cb-explicit', '-d', work, '-m', 'opus', '-t', 'x');
  assert.match(launch('cb-explicit'), /--model opus /);
  run('-x', '-n', 'cb-codex-default', '-d', work, '-p', 'codex', '-t', 'x');
  assert.doesNotMatch(launch('cb-codex-default'), /sonnet|--model| -m /);
});

test('token audit: -m fable starts on opus unless -F, subagents on sonnet unless haiku or overridden', () => {
  let r = run('-x', '-n', 'cb-fable', '-d', work, '-m', 'fable', '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /-m fable -> opus/);
  assert.match(launch('cb-fable'), /--model opus/);
  assert.match(launch('cb-fable'), /env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_SUBAGENT_MODEL=sonnet /);
  r = run('-x', '-n', 'cb-fable-ok', '-d', work, '-m', 'fable', '-F', '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch('cb-fable-ok'), /--model fable/);
  r = run('-x', '-n', 'cb-haiku-sub', '-d', work, '-m', 'haiku', '-t', 'x');
  assert.doesNotMatch(launch('cb-haiku-sub'), /CLAUDE_CODE_SUBAGENT_MODEL/);
  r = spawnSync('bash', [SCRIPT, '-x', '-n', 'cb-inherit', '-d', work, '-t', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state'), CBSESSION_SUBAGENT_MODEL: 'inherit' } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(launch('cb-inherit'), /CLAUDE_CODE_SUBAGENT_MODEL/);
});
