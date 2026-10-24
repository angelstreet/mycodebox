import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { readMinimax } from '../quota.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orchestrator-failover');
const home = tmp('mfo-');
const rl = path.join(home, 'rl.json'), state = path.join(home, 'state'), log = path.join(home, 'log.md');
// a fake tmux that records any call: --dry must never call it
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
const calls = path.join(home, 'tmux-calls');
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 1\n`, { mode: 0o755 });
const reading = (h, w, at = Date.now()) => fs.writeFileSync(rl, JSON.stringify({ at, rate_limits: { five_hour: { used_percentage: h, resets_at: 1792684800 }, seven_day: { used_percentage: w, resets_at: 1792850400 } } }));
// a reading with a window left out: Claude Code omits a window when no limit is in effect for it (the weekly one
// right after its reset). null for a window omits it.
const partial = (h, w, at = Date.now()) => {
  const rate_limits = {};
  if (h !== null) rate_limits.five_hour = { used_percentage: h, resets_at: 1792684800 };
  if (w !== null) rate_limits.seven_day = { used_percentage: w, resets_at: 1792850400 };
  fs.writeFileSync(rl, JSON.stringify({ at, rate_limits }));
};
// the standby's own quota file (quota.js writes it), in the same shape; an unlimited window is recorded as 0 %
const mrl = path.join(home, 'mm-rl.json');
const standby = (h, w, at = Date.now()) => fs.writeFileSync(mrl, JSON.stringify({ at, rate_limits: { five_hour: { used_percentage: h, resets_at: 1792684800 }, seven_day: { used_percentage: w, resets_at: 1792850400 } } }));
standby(4, 0);
const run = (...a) => spawnSync('bash', [SCRIPT, '--dry', ...a], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAILOVER_RL: rl, FAILOVER_STANDBY_RL: mrl, FAILOVER_STATE: state, FAILOVER_LOG: log } });
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

// ---- a window left out of a reading is 0 % used, not a broken reading: the watcher must not go blind ----
test('the weekly window left out (right after the weekly reset): a healthy reading, not unknown', () => {
  partial(0, null); fs.writeFileSync(state, 'claude\n');
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no action \(5h 0%, week 0%, state claude\)/);
  assert.doesNotMatch(r.stdout, /quota unknown/);
  noTmux();
});

test('the weekly window left out while minimax: Claude is back, so the seat is handed back', () => {
  partial(0, null); fs.writeFileSync(state, 'minimax\n');
  const r = run();
  assert.match(r.stdout, /DRY: would ask mm-manager for a handback note and tell manager to read it/);
  assert.doesNotMatch(r.stdout, /quota unknown/);
  noTmux();
});

test('the 5 h window left out: same, no crash and no unknown', () => {
  partial(null, 40); fs.writeFileSync(state, 'claude\n');
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no action \(5h 0%, week 40%, state claude\)/);
  assert.doesNotMatch(r.stdout, /quota unknown/);
  partial(null, 40); fs.writeFileSync(state, 'minimax\n');
  assert.match(run().stdout, /DRY: would ask mm-manager for a handback note and tell manager to read it/);
  noTmux();
});

test('the standby with the weekly window left out: its headroom is read, so the seat can be handed over', () => {
  reading(99, 90); fs.writeFileSync(state, 'claude\n');
  fs.writeFileSync(mrl, JSON.stringify({ at: Date.now(), rate_limits: { five_hour: { used_percentage: 12, resets_at: 1792684800 } } }));
  const r = run();
  assert.match(r.stdout, /DRY: would start\/wake mm-manager.*claude -> minimax \(mm-manager at 5h 12%, week 0%\)/);
  assert.doesNotMatch(r.stdout, /quota unknown/);
  standby(4, 0);
  noTmux();
});

// ---- a window that is there but unusable is unknown, not 0 % headroom ----
test('the standby with a weekly window that is present but unusable: unknown, so the seat is not handed over', () => {
  reading(99, 90); fs.writeFileSync(state, 'claude\n');
  fs.writeFileSync(mrl, JSON.stringify({ at: Date.now(), rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1792684800 },
    seven_day: { used_percentage: null, resets_at: 1792850400 } } }));
  const r = run();
  assert.match(r.stdout, /mm-manager quota unknown.*not promoting/);
  assert.doesNotMatch(r.stdout, /standby message|claude -> minimax/, 'the seat is never handed over');
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n');
  noTmux();
  standby(4, 0);
});

// The standby's file comes from quota.js: a weekly window the API did not report must not look like headroom.
// The writer records it as present but unusable, so the watcher reads "unknown" and keeps the role with Claude.
test('the standby with a weekly window the API did not report: the writer leaves it unusable, so the seat is not handed over', async () => {
  reading(99, 90); fs.writeFileSync(state, 'claude\n');
  const now = Date.now();
  const cfg = {
    minimaxFile: mrl,
    minimaxLogin: async () => ({ accessToken: 'synthetic-token-for-tests', expiresAtMs: now + 3600e3 }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      model_remains: [{ model_name: 'general', end_time: now + 3600e3, weekly_end_time: now + 7 * 24 * 3600e3,
        current_interval_status: 1, current_interval_remaining_percent: 98,
        current_weekly_status: 1, current_weekly_remaining_percent: undefined, current_weekly_total_count: 0, current_weekly_usage_count: 0 }],
      base_resp: { status_code: 0, status_msg: 'success' } }) }),
  };
  await readMinimax(cfg, now);
  const r = run();
  assert.match(r.stdout, /mm-manager quota unknown.*not promoting/);
  assert.doesNotMatch(r.stdout, /standby message|claude -> minimax/, 'the seat is never handed over');
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n');
  assert.equal(JSON.parse(fs.readFileSync(mrl, 'utf8')).rate_limits.seven_day.used_percentage, null, 'the weekly window is present but unusable');
  noTmux();
  standby(4, 0);
});

// ---- the standby gate: Claude being out of quota says nothing about the seat we would hand over to ----
test('Claude limited and the standby still has headroom: promotes', () => {
  reading(99, 90); standby(12, 40); fs.writeFileSync(state, 'claude\n');
  const r = run();
  assert.match(r.stdout, /DRY: would start\/wake mm-manager.*claude -> minimax \(mm-manager at 5h 12%, week 40%\)/);
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n', 'dry writes no state');
  noTmux();
});

test('Claude limited but the standby is at/above the limit too: no seat to hand over to, so no promotion', () => {
  reading(99, 90); fs.writeFileSync(state, 'claude\n');
  standby(97, 10);
  assert.match(run().stdout, /mm-manager is out of quota too \(5h 97%, week 10%\): no seat left to hand over to/);
  standby(10, 97);
  assert.match(run().stdout, /mm-manager is out of quota too \(5h 10%, week 97%\)/, 'the weekly window alone is enough');
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n');
  assert.doesNotMatch(run().stdout, /standby message/, 'the standby message is never printed');
  noTmux();
});

test('Claude limited but the standby quota is missing, broken or stale: unknown is not healthy, no promotion', () => {
  reading(99, 90); fs.writeFileSync(state, 'claude\n');
  fs.rmSync(mrl, { force: true });
  assert.match(run().stdout, /mm-manager quota unknown \(missing or stale mm-rl\.json\): not promoting/);
  fs.writeFileSync(mrl, '{nope');
  assert.match(run().stdout, /mm-manager quota unknown.*not promoting/);
  standby(99, 99, Date.now() - 3600e3);
  assert.match(run().stdout, /mm-manager quota unknown.*not promoting/);
  assert.equal(fs.readFileSync(state, 'utf8'), 'claude\n');
  assert.doesNotMatch(run().stdout, /standby message/);
  noTmux();
});

test('Claude not limited: the standby is never consulted and nothing is promoted', () => {
  reading(7, 90); standby(99, 99); fs.writeFileSync(state, 'claude\n');   // a limited standby changes nothing here
  const r = run();
  assert.match(r.stdout, /no action \(5h 7%, week 90%, state claude\)/);
  assert.doesNotMatch(r.stdout, /mm-manager/, 'the standby quota is not even read');
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
  standby(4, 0);   // the shared standby fixture: headroom unless the test overrides it below
  const env = { PATH: `${b}:${process.env.PATH}`, HOME: h, FAILOVER_RL: rl, FAILOVER_STANDBY_RL: mrl, FAILOVER_STATE: st, FAILOVER_LOG: lg };
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
test('a real pass with the standby out of quota: nothing promoted, no tmux call at all', () => {
  reading(99, 90);
  const L = live('idle');
  standby(99, 50);   // after live(), which seeds a healthy standby
  fs.writeFileSync(L.st, 'claude\n');
  const r = L.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(L.lg, 'utf8'), /mm-manager is out of quota too \(5h 99%, week 50%\): no seat left to hand over to/);
  assert.equal(fs.readFileSync(L.st, 'utf8'), 'claude\n', 'state untouched');
  assert.doesNotMatch(L.calls(), /send-keys|has-session|load-buffer|paste-buffer/, 'the standby is never touched');
});
