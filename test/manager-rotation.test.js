// The manager moves to another Claude account, and the early "all accounts nearly used up" alert (owner 2026-11-26).
// Temp state dir and fake config dirs; restart() is a stub: never the live manager, never a real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAccounts, rateFile, weekLeft } from '../claude-accounts.js';
import { createManagerRotation, RETRY_MS, BUSY_RETRY_MS } from '../manager-rotation.js';

const NOW = Date.parse('2026-11-26T11:00:00Z');
const WEEK_RESET = (NOW + 2 * 86400e3) / 1000;

async function setup(t, { week = {}, logins = ['team1', 'team2'], exit = () => 0, set = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-rot-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = ['default', 'team1', 'team2'].map((id) => ({ id, label: id, ...(id === 'default' ? {} : { configDir: join(dir, id) }) }));
  for (const id of ['team1', 'team2']) { mkdirSync(join(dir, id)); if (logins.includes(id)) writeFileSync(join(dir, id, '.credentials.json'), '{}'); }
  writeFileSync(join(dir, 'claude-accounts.json'), JSON.stringify({ accounts, active: 'default', ...set }));
  const clock = { t: NOW };
  const usage = (id, pct) => writeFileSync(rateFile(dir, id), JSON.stringify({ at: clock.t, rate_limits: { seven_day: { used_percentage: pct, resets_at: WEEK_RESET } } }));
  for (const [id, pct] of Object.entries(week)) usage(id, pct);
  const m = createClaudeAccounts({ file: join(dir, 'claude-accounts.json'), stateDir: dir, home: dir, now: () => clock.t });
  await m.refresh();
  const restarts = [], alerts = [], records = [];
  const rot = createManagerRotation({ accounts: m, now: () => clock.t, restart: async (s, env) => { restarts.push([s, env]); return exit(restarts.length); }, alert: async (key, a) => alerts.push({ key, ...a }), record: async (e) => records.push(e) });
  const tick = async (row, opts) => { const r = await rot.tick('manager', { agent: 'claude', claudeAccount: 'default', state: 'idle', ...row }, opts); await r.job; return r; };
  return { m, usage, clock, tick, restarts, alerts, records };
}

test('limit stop: the account is marked and the manager restarts on the next one, with no owner action', async (t) => {
  const e = await setup(t);
  assert.equal((await e.tick({ state: 'waiting', stall: { draft: true } }, { limitStop: true })).to, 'team1');
  const [session, env] = e.restarts[0];
  assert.equal(session, 'manager');
  assert.equal(env.MANAGER_FRESH_ACCOUNT, 'team1'); assert.equal(env.MANAGER_FRESH_LIMIT, '1'); assert.equal(env.MANAGER_FRESH_SESSION, 'manager');
  assert.equal(e.m.states().default.exhausted, true);
  assert.equal(e.alerts.length, 0);
  assert.match(e.records[0].title, /restarted on team1/);
  assert.equal((await e.tick({}, { limitStop: true })).action, 'cooldown', 'the same stop does not restart twice');
});

test('past 95 % while idle: restart without the limit-stop path; busy or with a draft: left alone', async (t) => {
  const e = await setup(t, { week: { default: 94 } });
  assert.equal((await e.tick({})).action, 'none');
  e.usage('default', 96); await e.m.refresh();
  assert.equal((await e.tick({ state: 'working' })).action, 'busy');
  assert.equal((await e.tick({ stall: { draft: true } })).action, 'busy');
  assert.equal((await e.tick({ claudeAccount: null })).action, 'none', 'a dead manager is manager-watch\'s');
  assert.equal(e.restarts.length, 0);
  assert.equal((await e.tick({ state: 'done' })).to, 'team1');
  assert.equal(e.restarts[0][1].MANAGER_FRESH_LIMIT, '');
  assert.equal((await e.tick({ claudeAccount: 'team1' })).action, 'none');
});

test('an account without a login is skipped; a not-idle exit retries soon, a failure alerts and waits', async (t) => {
  const e = await setup(t, { week: { default: 99 }, logins: ['team2'], exit: (n) => (n === 1 ? 3 : n === 2 ? 1 : 0) });
  assert.equal((await e.tick({})).to, 'team2');
  assert.equal(e.alerts.length, 0, 'exit 3 is silent');
  e.clock.t += BUSY_RETRY_MS;
  await e.tick({});
  assert.match(e.alerts[0].title, /switch to team2 failed/);
  e.clock.t += RETRY_MS - 1;
  assert.equal((await e.tick({})).action, 'cooldown');
  e.clock.t += 1;
  assert.equal((await e.tick({})).action, 'restart');
});

test('no account free: one alert with the next reset, then it restarts by itself once one frees up', async (t) => {
  const e = await setup(t, { week: { team1: 100, team2: 97 } });
  const r = await e.tick({}, { limitStop: true });
  assert.equal(r.action, 'no-account');
  assert.equal(r.reset, NOW + 3600e3, 'the stop with no known reset blocks for an hour: the earliest');
  await e.tick({}, { limitStop: true });
  assert.equal(e.alerts.length, 1);
  assert.match(e.alerts[0].title, /Every Claude account is used up: manager waits/);
  assert.match(e.alerts[0].body, /Next reset: 26 Nov.*13:00 Paris/);
  assert.equal(e.restarts.length, 0);
  e.clock.t += 3600e3 + 1; await e.m.refresh();
  assert.equal((await e.tick({}, { limitStop: true })).to, 'default', 'its own window is back');
});

test('switch off or paused manager: alert, no restart', async (t) => {
  const e = await setup(t, { week: { default: 99 }, set: { autoSwapSessions: false } });
  assert.equal((await e.tick({})).action, 'off');
  assert.match(e.alerts[0].body, /automatic switch is off/);
  const p = await setup(t, { week: { default: 99 } });
  assert.equal((await p.tick({}, { paused: true })).action, 'off');
  assert.equal(e.restarts.length + p.restarts.length, 0);
});

test('weekLeft: a 5 h block keeps its week, a weekly block leaves nothing', () => {
  const week = (p) => [{ name: 'week', usedPercent: p }];
  assert.equal(weekLeft([{ windows: week(45) }, { windows: [] }], NOW), 145);
  assert.equal(weekLeft([{ exhausted: true, reset: NOW + 3600e3, windows: week(45) }, { exhausted: true, reset: NOW + 86400e3, windows: week(10) }, { exhausted: true, reset: null }], NOW), 50);
});

test('early alert: once, while a spare account is still free, persisted, and re-armed after resets', async (t) => {
  const e = await setup(t, { week: { default: 80 } });   // 15 + 95 + 95
  assert.equal(await e.m.earlyAlert(), null);
  e.usage('team1', 100); await e.m.refresh();            // 15 + 0 + 95 = 110
  assert.equal(await e.m.earlyAlert(), null);
  e.usage('default', 90); await e.m.refresh();           // 5 + 0 + 95 = 100: team2 is the last switch and it is still ahead
  const a = await e.m.earlyAlert();
  assert.equal(a.left, 100); assert.equal(a.nextReset, WEEK_RESET * 1000);
  assert.equal(e.m.states().team2.exhausted, false);
  assert.equal(await e.m.earlyAlert(), null, 'once');
  const again = createClaudeAccounts({ file: join(a.accounts[1].configDir, '..', 'claude-accounts.json'), stateDir: join(a.accounts[1].configDir, '..'), now: () => e.clock.t });
  await again.refresh();
  assert.equal(await again.earlyAlert(), null, 'a server restart does not repeat it');
  e.usage('team1', 0); await e.m.refresh();              // 195: re-armed
  await e.m.earlyAlert();
  e.usage('team1', 100); await e.m.refresh();
  assert.equal((await e.m.earlyAlert()).left, 100);
});
