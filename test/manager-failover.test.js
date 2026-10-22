import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orchestrator-failover');
const home = tmp('mfo-');
const rl = path.join(home, 'rl.json'), state = path.join(home, 'state'), log = path.join(home, 'log.md');
// a fake tmux that records any call: --dry must never call it
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
const calls = path.join(home, 'tmux-calls');
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 1\n`, { mode: 0o755 });
const reading = (h, w, at = Date.now()) => fs.writeFileSync(rl, JSON.stringify({ at, rate_limits: { five_hour: { used_percentage: h, resets_at: 1792684800 }, seven_day: { used_percentage: w, resets_at: 1792850400 } } }));
const run = (...a) => spawnSync('bash', [SCRIPT, '--dry', ...a], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAILOVER_RL: rl, FAILOVER_STATE: state, FAILOVER_LOG: log } });
const noTmux = () => assert.equal(fs.existsSync(calls), false, 'dry must not call tmux');

test('below the limit: no action', () => {
  reading(7, 90); fs.writeFileSync(state, 'claude\n');
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no action \(5h 7%, week 90%, state claude\)/);
  noTmux();
});

test('>= 97 %: standby message, hard floors and no-typing rules, state claude -> minimax', () => {
  reading(7, 97); fs.writeFileSync(state, 'claude\n');
  const r = run();
  assert.match(r.stdout, /DRY: would start\/wake mm-manager.*claude -> minimax/);
  assert.match(r.stdout, /tmux session manager/);
  assert.match(r.stdout, /hard floors \(deploys, merges to main, deletions, credentials, money, customers, sudoers\/units, force-push, destructive migrations\) stay owner-only/);
  assert.match(r.stdout, /Never type into a working session, never send Esc or Ctrl-C/);
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n', 'dry writes no state');
  assert.equal(fs.existsSync(log), false);
  noTmux();
});

test('already minimax and still limited: idempotent, nothing re-sent', () => {
  reading(98, 90); fs.writeFileSync(state, 'minimax\n');
  assert.match(run().stdout, /no action/);
  noTmux();
});

test('missing, stale or broken quota file: unknown, no action', () => {
  fs.writeFileSync(state, 'claude\n');
  fs.rmSync(rl, { force: true });
  assert.match(run().stdout, /quota unknown.*no action/);
  reading(99, 99, Date.now() - 3600e3);
  assert.match(run().stdout, /quota unknown.*no action/);
  fs.writeFileSync(rl, '{nope');
  assert.match(run().stdout, /quota unknown.*no action/);
  noTmux();
});

test('back under 90 % while minimax: handback, state minimax -> claude', () => {
  reading(5, 80); fs.writeFileSync(state, 'minimax\n');
  assert.match(run().stdout, /DRY: would ask mm-manager for a handback note and tell manager to read it.*minimax -> claude/);
  reading(5, 93);
  assert.match(run().stdout, /no action/, 'week still above 90 %: no handback');
  noTmux();
});

test('stale minimax state with Claude fine is reset, not handed back', () => {
  reading(5, 80); fs.writeFileSync(state, 'minimax\n');
  const old = new Date(Date.now() - 48 * 3600e3); fs.utimesSync(state, old, old);
  assert.match(run().stdout, /reset to claude, no handback/);
  noTmux();
});
