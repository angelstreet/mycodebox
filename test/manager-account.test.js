// The manager starts on the active Claude account (owner 2026-11-26). Temp GHOSTY_STATE_DIR, fake config dirs, no real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'claude --dangerously-skip-permissions --model sonnet --remote-control manager -n manager';

test('manager launch command per active account', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-acct-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgDir = (id) => join(dir, 'cfg', id);
  for (const id of ['team1', 'team2', 'nologin']) mkdirSync(cfgDir(id), { recursive: true });
  for (const id of ['team1', 'team2']) writeFileSync(join(cfgDir(id), '.credentials.json'), '{}');
  const command = (active, env = {}) => {
    writeFileSync(join(dir, 'claude-accounts.json'), JSON.stringify({ active, accounts: ['default', 'team1', 'team2', 'nologin'].map((id) => ({ id, ...(id === 'default' ? {} : { configDir: cfgDir(id) }) })) }));
    return execFileSync(process.execPath, ['scripts/manager-command.js'], { env: { HOME: dir, GHOSTY_STATE_DIR: dir, ...env }, encoding: 'utf8' });
  };
  assert.equal(command('default'), BASE);
  for (const id of ['team1', 'team2']) assert.equal(command(id), `CLAUDE_CONFIG_DIR='${cfgDir(id)}' GHOSTY_CLAUDE_ACCOUNT=${id} ${BASE}`);
  assert.equal(command('nologin'), BASE, 'an account without a login is not used');
  assert.match(command('team1', { AGENT_CMD_CLAUDE: 'CLAUDE_CONFIG_DIR=/x claude' }), /^CLAUDE_CONFIG_DIR=\/x claude --model/, 'an override with its own dir wins');
});

test('MANAGER_FRESH_ACCOUNT wins over the active account', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-acct-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'team2')); writeFileSync(join(dir, 'team2', '.credentials.json'), '{}');
  writeFileSync(join(dir, 'claude-accounts.json'), JSON.stringify({ active: 'default', accounts: [{ id: 'team2', configDir: join(dir, 'team2') }] }));
  const out = execFileSync(process.execPath, ['scripts/manager-command.js'], { env: { HOME: dir, GHOSTY_STATE_DIR: dir, MANAGER_FRESH_ACCOUNT: 'team2' }, encoding: 'utf8' });
  assert.equal(out, `CLAUDE_CONFIG_DIR='${join(dir, 'team2')}' GHOSTY_CLAUDE_ACCOUNT=team2 ${BASE}`);
});
