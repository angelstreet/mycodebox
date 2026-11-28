// Exercise /api/quota and /api/health on an isolated server: temp HOME/state, empty fake tmux, no login or live panes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmp } from './helpers-tmp.js';
import { waitServer } from './helpers/wait-server.js';

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});

test('week 95% remains usable in both quota and health while marked/99% accounts are exhausted', async (t) => {
  const dir = tmp('claude-api-'), state = join(dir, 'state'), home = join(dir, 'home');
  mkdirSync(state); mkdirSync(home);
  const now = Date.now(), until = now + 86400e3;
  const accounts = ['default', 'team1', 'team2'].map((id) => {
    if (id === 'default') return { id };
    const configDir = join(home, id); mkdirSync(configDir); writeFileSync(join(configDir, '.credentials.json'), '{}');
    return { id, configDir };
  });
  writeFileSync(join(state, 'claude-accounts.json'), JSON.stringify({ accounts, marks: { default: { until, at: now, reason: 'synthetic limit stop' } } }));
  for (const [id, five, week] of [['default', 0, 100], ['team1', 94, 99], ['team2', 52, 95]]) {
    writeFileSync(join(state, id === 'default' ? 'claude-rate-limits.json' : `claude-rate-limits.${id}.json`), JSON.stringify({ at: now,
      rate_limits: { five_hour: { used_percentage: five, resets_at: until / 1000 }, seven_day: { used_percentage: week, resets_at: until / 1000 } } }));
  }
  const tmux = join(dir, 'tmux'); writeFileSync(tmux, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state,
    GHOSTY_DISK_GUARD: 'off', TMUX_BIN: tmux, TLS_KEY: join(dir, 'none.pem'), TLS_CERT: join(dir, 'none.pem'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  t.after(async () => { if (child.exitCode == null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  await waitServer(base, () => log);
  // Wait for the real startup quota poll, which refreshes accounts before publishing its plan.
  let plan;
  const deadline = Date.now() + 30000;
  do {
    const res = await fetch(`${base}/api/quota`); assert.equal(res.status, 200);
    const quota = await res.json(); plan = quota.plans?.find((p) => p.plan === 'claude');
    if (plan?.accounts) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.ok(plan?.accounts, log);
  assert.equal(plan.accounts.find((a) => a.id === 'team2').exhausted, false);
  assert.equal(plan.account, 'team2');
  assert.deepEqual(plan.accounts.map((a) => a.exhausted), [true, true, false]);
  const healthRes = await fetch(`${base}/api/health`); assert.equal(healthRes.status, 200);
  assert.deepEqual((await healthRes.json()).claudeAccounts, { total: 3, usable: 1, allUsedUp: false });
});
