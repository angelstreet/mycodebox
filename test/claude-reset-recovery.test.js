// Regression: a 13:45 fallback mark must not hide a 14:00 refill or be recreated by the old pane stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createClaudeAccounts, accountsHealth, rateFile } from '../claude-accounts.js';
import { createClaudeRotation } from '../claude-rotation.js';
import { createManagerRotation } from '../manager-rotation.js';

const STOP = Date.parse('2026-11-28T13:45:00Z');
const RESET = Date.parse('2026-11-28T14:00:00Z');
const AFTER = Date.parse('2026-11-28T14:03:00Z');
const LINE = "You've hit your weekly limit · resets 2pm (UTC)";
async function rig() {
  const dir = tmp('claude-reset-'), file = join(dir, 'claude-accounts.json');
  writeFileSync(file, JSON.stringify({ accounts: [{ id: 'default' }] }));
  const clock = { t: STOP };
  const make = () => createClaudeAccounts({ file, stateDir: dir, home: dir, now: () => clock.t });
  let accounts = make(); await accounts.refresh();
  const usage = (pct, at, reset) => writeFileSync(rateFile(dir, 'default'), JSON.stringify({ at, rate_limits: { seven_day: { used_percentage: pct, resets_at: reset / 1000 } } }));
  return { dir, file, clock, usage, get accounts() { return accounts; }, restart: () => { accounts = make(); },
    health: () => accountsHealth(dir, { now: () => clock.t }),
    storedMarks: () => JSON.parse(readFileSync(file)).marks };
}

for (const source of ['fresh-reading', 'expired-window']) test(`reset clears a fallback mark in both health and account view (${source})`, async () => {
  const e = await rig();
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: STOP, reason: 'synthetic usage stop' });
  assert.equal(e.accounts.config().marks.default.until, STOP + 3600e3);
  if (source === 'fresh-reading') e.usage(0, AFTER, RESET + 7 * 86400e3);
  else e.usage(100, STOP - 20 * 60e3, RESET); // no new turn needed: the recorded reset itself is evidence
  e.clock.t = AFTER;
  assert.equal(e.health().usable.length, 1, 'health must apply reset evidence even before the next quota poll');
  await e.accounts.refresh();
  assert.equal(e.accounts.view().accounts[0].exhausted, false);
  assert.equal(e.storedMarks().default, undefined);
});

test('an old stop cannot re-mark an account after a fresh refill, including a fresh manager/controller', async () => {
  const e = await rig();
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: STOP });
  e.clock.t = AFTER; e.usage(0, AFTER, RESET + 7 * 86400e3);
  await e.accounts.refresh(); e.restart(); await e.accounts.refresh();
  const restarted = [];
  const row = { agent: 'claude', claudeAccount: 'default', lastActivity: STOP, state: 'idle' };
  // A fresh manager after a service restart sees the old terminal line for the first time.
  const manager = createManagerRotation({ accounts: e.accounts, now: () => e.clock.t, restart: async (_n, env) => { restarted.push(env); return 0; }, alert: async () => {} });
  const r = await manager.tick('manager', row, { limitStop: true }); await r.job;
  assert.equal(e.storedMarks().default, undefined, 'old manager output cannot resurrect a cleared mark');
  assert.equal(e.health().usable.length, 1);
  const swaps = [];
  const ordinary = createClaudeRotation({ accounts: e.accounts, now: () => e.clock.t, swap: async (_n, to) => swaps.push(to), sendContinue: async () => {}, schedule: () => {} });
  await ordinary.tick('stopped', row, { limitStop: true, lines: [LINE] });
  assert.equal(e.storedMarks().default, undefined, 'old ordinary output cannot resurrect it either');
  assert.deepEqual(swaps, ['default'], 'the stopped conversation can now recover on the refilled account');
});

test('an old stop cannot re-mark after an expired-window refill even if its raw reading predates the mark', async () => {
  const e = await rig();
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: STOP });
  e.usage(100, STOP - 20 * 60e3, RESET); e.clock.t = AFTER;
  await e.accounts.refresh(); e.restart();
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: STOP });
  assert.equal(e.health().usable.length, 1);
  assert.equal(e.storedMarks().default, undefined);
});

test('a genuinely new limit stop after the healthy reading still marks the account', async () => {
  const e = await rig();
  e.clock.t = AFTER; e.usage(0, AFTER, RESET + 7 * 86400e3); await e.accounts.refresh();
  e.clock.t += 60e3;
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: e.clock.t });
  assert.equal(e.health().usable.length, 0);
  assert.equal(e.accounts.view().accounts[0].exhausted, true);
  await e.accounts.markExhausted('default', { confirmed: true, observedAt: STOP });
  assert.equal(e.health().usable.length, 0, 'an old pane must not erase a newer genuine stop from another session');
});

test('a waiting manager sees a fresh refill on its next tick, with no periodic quota poll or manual clear', async () => {
  const e = await rig(), calls = [];
  const manager = createManagerRotation({ accounts: e.accounts, now: () => e.clock.t, restart: async (_n, env) => { calls.push(env); return 0; }, alert: async () => {} });
  const row = { agent: 'claude', claudeAccount: 'default', lastActivity: STOP, state: 'idle' };
  assert.equal((await manager.tick('manager', row, { limitStop: true })).action, 'no-account');
  e.clock.t = AFTER; e.usage(0, AFTER, RESET + 7 * 86400e3);
  const result = await manager.tick('manager', row, { limitStop: true }); await result.job;
  assert.equal(result.action, 'restart');
  assert.equal(result.to, 'default');
  assert.equal(calls.length, 1);
  assert.equal(e.storedMarks().default, undefined);
  assert.equal(e.health().usable.length, 1);
});
