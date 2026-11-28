// Real account and parking stores, fake terminal IO and clock. Never contact a provider or a live session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createClaudeAccounts, rateFile, scanClaudeLimit, accountsHealth } from '../claude-accounts.js';
import { createClaudeRotation, RETRY_MS, START_MS, CONTINUE_MS } from '../claude-rotation.js';
import { createParking } from '../parking.js';

const NOW = Date.parse('2026-11-28T13:30:00Z');
const STOP = ["  ⎿  You've hit your weekly limit · resets 2pm (UTC)", '❯ '];
async function rig({ rates = {}, marks = {}, ids = ['default', 'team1', 'team2'], noLogin = [], settings = {} } = {}) {
  const dir = tmp('claude-rotation-');
  const clock = { t: NOW }, log = [], timers = [], notices = [], records = [];
  const accounts = ids.map((id) => ({ id, ...(id === 'default' ? {} : { configDir: join(dir, id) }) }));
  for (const a of accounts.filter((a) => a.configDir)) {
    mkdirSync(a.configDir);
    if (!noLogin.includes(a.id)) writeFileSync(join(a.configDir, '.credentials.json'), '{}');
  }
  const file = join(dir, 'claude-accounts.json');
  writeFileSync(file, JSON.stringify({ accounts, marks, ...settings }));
  const usage = (id, five, week, reset5 = NOW + 3600e3, resetW = NOW + 86400e3) => writeFileSync(rateFile(dir, id), JSON.stringify({ at: clock.t,
    rate_limits: { five_hour: { used_percentage: five, resets_at: reset5 / 1000 }, seven_day: { used_percentage: week, resets_at: resetW / 1000 } } }));
  for (const [id, args] of Object.entries(rates)) usage(id, ...args);
  const m = createClaudeAccounts({ file, stateDir: dir, home: dir, now: () => clock.t });
  await m.refresh();
  let alive = true, exists = true, paused = false, fail = false, leases = [];
  const parking = createParking({ file: join(dir, 'parked.json'), sleep: async () => {}, tmux: {
    exists: async () => exists, kill: async () => { exists = false; log.push('kill'); },
    create: async () => { exists = true; log.push('create'); },
    sendText: async (_name, text) => log.push(text), sendEnter: async () => { alive = false; log.push('Enter'); },
  } });
  const makeRotation = () => createClaudeRotation({ file: join(dir, 'claude-limit-stops.json'), accounts: m, now: () => clock.t, notice: (e) => notices.push(e), record: (e) => records.push(e),
    isPaused: () => paused, schedule: (fn, ms) => timers.push({ fn, ms }), sendContinue: async (name) => log.push(`${name}: continue+Enter`),
    swap: async (name, account, opts) => {
      assert.equal(opts.limitStop, true);
      if (fail) throw new Error('synthetic park refusal');
      log.push('Escape');
      await parking.park(name, { claude: { pid: 9, info: { status: 'idle', sessionId: 'same-conversation', cwd: dir }, args: 'claude --model opus' }, state: 'idle', busy: [], leases }, { claudeAlive: async () => alive });
      await parking.resume(name, { base: m.commandFor('claude', account), start: async (_n, rec, cmd) => { log.push(cmd); alive = true; } });
    } });
  let rot = makeRotation();
  const tick = (opts = {}, row = {}) => rot.tick('stopped', { agent: 'claude', claudeAccount: 'default', ...row }, { limitStop: scanClaudeLimit(STOP), lines: STOP, paused, ...opts });
  return { dir, clock, m, usage, tick, log, notices, records, timers,
    restart: () => { rot = makeRotation(); }, pause: (v) => { paused = v; }, fail: (v) => { fail = v; }, lease: (v) => { leases = v; } };
}

test('usage stop switches to the account at week 95%, resumes the same conversation and sends continue once', async () => {
  const e = await rig({ rates: { default: [0, 100], team1: [94, 99], team2: [52, 95] } });
  assert.deepEqual(await e.tick(), { action: 'swap', to: 'team2' });
  assert.match(e.log.find((l) => l.includes('--resume')), /GHOSTY_CLAUDE_ACCOUNT=team2 claude.*--resume same-conversation/);
  assert.deepEqual(e.log.slice(0, 5), ['Escape', '/exit', 'Enter', 'kill', 'create']);
  assert.deepEqual(JSON.parse(readFileSync(join(e.dir, 'parked.json'))).parked, {});
  assert.equal(e.timers.length, 1); assert.equal(e.timers[0].ms, CONTINUE_MS);
  await e.timers[0].fn();
  assert.equal(e.log.at(-1), 'stopped: continue+Enter');
  assert.equal((await e.tick()).action, 'starting');
  e.clock.t += START_MS;
  assert.equal((await e.tick()).action, 'handled');
  assert.equal(e.timers.length, 1); assert.equal(e.records.length, 1);
  assert.equal(accountsHealth(e.dir, { now: () => e.clock.t }).allUsedUp, false);
});

test('a real stop overrides the preceding healthy reading and uses the named weekly reset', async () => {
  const e = await rig({ rates: { default: [99, 95] } });
  await e.tick();
  const a = e.m.view().accounts.find((a) => a.id === 'default');
  assert.equal(a.exhausted, true);
  assert.equal(a.mark.until, NOW + 86400e3, 'the 5h reset cannot release a weekly stop');
});

for (const first of ['default', 'team1']) test(`all accounts blocked: automatic resume at the earliest reset (${first}), without moving the mark`, async () => {
  const early = NOW + 60e3, late = NOW + 86400e3;
  const e = await rig({ rates: { default: [0, 100, late, first === 'default' ? early : late], team1: [0, 100, late, first === 'team1' ? early : late], team2: [0, 100, late, late] } });
  assert.deepEqual(await e.tick(), { action: 'no-account', reset: early });
  const until = e.m.config().marks.default.until;
  e.clock.t = early - 1;
  assert.equal((await e.tick()).action, 'no-account');
  assert.equal(e.m.config().marks.default.until, until);
  assert.equal(e.notices.length, 1); assert.equal(e.log.length, 0);
  e.clock.t = early;
  assert.deepEqual(await e.tick(), { action: 'swap', to: first });
  await e.timers[0].fn();
  assert.equal(e.log.at(-1), 'stopped: continue+Enter');
});

test('one configured account resumes on its own reset, including across a service restart', async () => {
  const e = await rig({ ids: ['default'], rates: { default: [100, 20, NOW + 60e3] } });
  assert.equal((await e.tick({ lines: ['5-hour limit reached'] })).action, 'no-account');
  e.clock.t += 60e3;
  await e.m.refresh(); // the service refreshes and removes expired account marks before its first pane tick
  e.restart();
  assert.equal((await e.tick({ lines: ['5-hour limit reached'] })).to, 'default');
});

test('a restart while waiting with no reading preserves the original fallback reset', async () => {
  const e = await rig({ ids: ['default'] });
  assert.equal((await e.tick()).reset, NOW + 3600e3);
  e.clock.t += 30 * 60e3;
  e.restart();
  assert.equal((await e.tick()).reset, NOW + 3600e3);
  e.clock.t += 30 * 60e3;
  assert.equal((await e.tick()).to, 'default');
});

test('a restart after swap still delivers a pending continue even after the launch grace elapsed', async () => {
  const e = await rig();
  await e.tick();
  e.timers.length = 0; // the old process and its timer are gone
  e.clock.t += START_MS + 1;
  e.restart();
  assert.equal((await e.tick({ limitStop: false }, { claudeAccount: 'team1' })).action, 'starting');
  assert.equal(e.timers.length, 1); assert.equal(e.timers[0].ms, 0);
  await e.timers[0].fn();
  assert.equal(e.log.at(-1), 'stopped: continue+Enter');
  await e.tick({ limitStop: false }, { claudeAccount: 'team1' });
  assert.equal(e.records.length, 1);
});

test('pause or switch off defers the switch; unpause or enabling it reconsiders the same stop', async () => {
  for (const off of ['pause', 'setting']) {
    const e = await rig({ settings: { autoSwapSessions: off !== 'setting' } });
    if (off === 'pause') e.pause(true);
    assert.equal((await e.tick()).action, 'off');
    assert.equal(e.log.length, 0);
    e.pause(false); await e.m.set({ autoSwapSessions: true });
    assert.equal((await e.tick()).action, 'swap');
    e.pause(true); await e.timers[0].fn();
    assert.ok(!e.log.some((s) => s.includes('continue')));
  }
});

test('park refusal backs off then retries; unlogged accounts and held leases never get used', async () => {
  const e = await rig({ noLogin: ['team1'] });
  e.lease([{ id: 'synthetic-lease' }]);
  assert.equal((await e.tick()).action, 'failed');
  assert.deepEqual(e.log, ['Escape']);
  assert.equal((await e.tick()).action, 'cooldown');
  e.lease([]); e.clock.t += RETRY_MS;
  assert.deepEqual(await e.tick(), { action: 'swap', to: 'team2' });
  assert.equal(e.timers.length, 1);
});

test('no stop never touches sessions; a subsequent genuine stop is handled', async () => {
  const e = await rig();
  assert.equal((await e.tick({ limitStop: false })).action, 'none');
  assert.equal(e.log.length, 0);
  await e.tick();
  await e.timers[0].fn();
  e.clock.t += START_MS;
  await e.tick({ limitStop: false });
  assert.equal((await e.tick({}, { claudeAccount: 'team1' })).to, 'team2');
});
