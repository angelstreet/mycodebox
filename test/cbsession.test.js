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
fs.writeFileSync(path.join(home, 'handover.md'), '# h\n');
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, MCODE_NODE_DIR: '/opt/fake-node/bin', GHOSTY_STATE_DIR: path.join(home, 'state') } });
const launch = (name) => fs.readFileSync(path.join(home, 'handovers', `${name}.launch.sh`), 'utf8');

test('dry run per provider writes the launch file and starts nothing', () => {
  let r = run('-x', '-n', 'cb-claude', '-d', work, '-m', 'haiku', '-t', 'do it');
  assert.equal(r.status, 0, r.stderr);
  const c = launch('cb-claude');
  assert.match(c, /--dangerously-skip-permissions --remote-control cb-claude -n cb-claude --model haiku/);
  assert.match(c, new RegExp(`cd ${work}`));
  assert.equal(fs.readFileSync(path.join(home, 'handovers', 'cb-claude.prompt.md'), 'utf8'), 'do it\n');
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
  assert.match(launch('cb-sub'), /env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \S+\/claude --dangerously/);
  const kd = path.join(home, '.config', 'anthropic'); fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, 'team.key'), 'sk-ant-secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(kd, 'team.workspace'), 'wrkspc_abc\n');
  r = run('-x', '-n', 'cb-team', '-d', work, '-b', 'team', '-t', 'x');
  assert.equal(r.status, 0, r.stderr);
  const sj = path.join(home, 'handovers', 'cb-team.settings.json');
  assert.match(launch('cb-team'), new RegExp(`claude --settings ${sj} --dangerously`));
  const st = JSON.parse(fs.readFileSync(sj, 'utf8'));
  assert.equal(st.apiKeyHelper, `cat "${path.join(kd, 'team.key')}"`);
  assert.equal(st.env.ANTHROPIC_CUSTOM_HEADERS, 'anthropic-workspace-id: wrkspc_abc');
  assert.ok(!launch('cb-team').includes('sk-ant-secret') && !fs.readFileSync(sj, 'utf8').includes('sk-ant-secret'));
  assert.equal(run('-x', '-n', 'cb-nokey', '-d', work, '-b', 'missing', '-t', 'x').status, 2);
  assert.equal(run('-x', '-n', 'cb-mmb', '-d', work, '-p', 'minimax', '-b', 'team', '-t', 'x').status, 2);
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
