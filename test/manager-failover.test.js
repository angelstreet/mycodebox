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

test('stale minimax state with the week at 90 % (not yet back) is still reset', () => {
  reading(1, 90); fs.writeFileSync(state, 'minimax\n');
  const old = new Date(Date.now() - 48 * 3600e3); fs.utimesSync(state, old, old);
  assert.match(run().stdout, /reset to claude, no handback/);
  noTmux();
});

// ---- real (non-dry) passes with a fake tmux that answers: no double promotion, no reset of a working standby ----
const live = (paneText, tag) => {
  const h = tmp('mfl-'), b = path.join(h, 'bin'); fs.mkdirSync(b);
  const c = path.join(h, 'calls');
  fs.writeFileSync(path.join(b, 'tmux'), `#!/bin/sh\necho "$@" >> ${c}\ncase "$1" in capture-pane) printf '%s\\n' "${paneText}";; esac\nexit 0\n`, { mode: 0o755 });
  const st = path.join(h, 'state'), lg = path.join(h, 'log.md');
  const env = { PATH: `${b}:${process.env.PATH}`, HOME: h, FAILOVER_RL: rl, FAILOVER_STATE: st, FAILOVER_LOG: lg };
  const calls_ = () => (fs.existsSync(c) ? fs.readFileSync(c, 'utf8') : '');
  return { h, st, lg, env, calls: calls_, run: () => spawnSync('bash', [SCRIPT, '--once'], { encoding: 'utf8', env }), tag };
};
test('a second watcher on the same state file exits and promotes nothing', async () => {
  reading(98, 90);
  const L = live('idle');
  fs.writeFileSync(L.st, 'claude\n');
  const { spawn } = await import('node:child_process');
  const holder = spawn('flock', [`${L.st}.lock`, 'sleep', '30']);
  await new Promise((r) => setTimeout(r, 500));
  const r = L.run();
  holder.kill();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /another watcher holds .*lock: exiting/);
  assert.equal(fs.readFileSync(L.st, 'utf8'), 'claude\n');
  assert.equal(L.calls(), '', 'no tmux call, no standby message');
});
test('without a competing watcher the same pass promotes once and writes the state atomically (no temp file left)', () => {
  reading(98, 90);
  const L = live('idle');
  fs.writeFileSync(L.st, 'claude\n');
  const r = L.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(L.st, 'utf8'), 'minimax\n');
  assert.equal((L.calls().match(/send-keys -t =mm-manager:0 -l/g) || []).length, 1);
  assert.deepEqual(fs.readdirSync(L.h).filter((f) => f.startsWith('state.tmp')), []);
});
test('stale minimax state is kept while the standby pane shows it is working', () => {
  reading(5, 80);
  const L = live('doing things  esc to interrupt');
  fs.writeFileSync(L.st, 'minimax\n');
  const old = new Date(Date.now() - 48 * 3600e3); fs.utimesSync(L.st, old, old);
  const r = L.run();
  assert.match(r.stdout, /still working: kept minimax/);
  assert.equal(fs.readFileSync(L.st, 'utf8'), 'minimax\n');
  assert.ok(Date.now() - fs.statSync(L.st).mtimeMs < 60e3, 'mtime refreshed');
  assert.doesNotMatch(L.calls(), /send-keys/);
});
test('stale minimax state with an idle standby pane is reset', () => {
  reading(5, 80);
  const L = live('idle prompt');
  fs.writeFileSync(L.st, 'minimax\n');
  const old = new Date(Date.now() - 48 * 3600e3); fs.utimesSync(L.st, old, old);
  assert.match(L.run().stdout, /reset to claude, no handback/);
  assert.equal(fs.readFileSync(L.st, 'utf8'), 'claude\n');
});
