import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-mgrsess-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
const m = await import('../manager.js');
const pushes = [];
await m.initManager({ managerSessions: () => ['mgr'], onOwnerNeeded: (s) => pushes.push(s) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a manager session is never escalated, a normal one is', async () => {
  const p = pane('Which database should I use, A or B?');
  for (const n of ['mgr', 'worker']) { tick(n, 'working', ['busy'], 0); tick(n, 'done', p, 1000); tick(n, 'done', p, 2500); }
  await wait(600);
  assert.deepEqual(pushes, ['worker']);
  assert.equal(m.isManagerSession('mgr'), true);
  assert.equal(m.isManagerSession('worker'), false);
});
