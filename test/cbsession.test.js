import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cbsession');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-'));
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
  assert.match(launch('cb-mm'), /PATH=\/opt\/fake-node\/bin:\$PATH mcode -m minimax\/MiniMax-M3\.1-Flash-Preview/);
  r = run('-x', '-n', 'cb-oc', '-d', work, '-p', 'opencode', '-m', 'p/m', '-t', 'x');
  assert.match(launch('cb-oc'), /opencode -m p\/m --prompt/);
  r = run('-x', '-n', 'cb-h', '-d', work, '-H', path.join(home, 'handover.md'));
  assert.match(fs.readFileSync(path.join(home, 'handovers', 'cb-h.prompt.md'), 'utf8'), /Read the handover: .*handover\.md/);
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
  assert.match(s, /\$\{MCODE_NODE_DIR:-\$HOME\/\.local\/node-v24\.21\.0-linux-x64\/bin\}/);
});
