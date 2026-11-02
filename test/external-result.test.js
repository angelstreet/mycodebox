import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExternalResult, externalResultText } from '../external-result.js';
import { classifyKey } from '../manager-events.js';
import { tmp } from './helpers-tmp.js';

const req = (o = {}) => ({ id: 'int-abc1', origin: 'external', externalLabel: 'mac-1', branch: 'claude/x', target: 'main', state: 'deployed', sha: 'a'.repeat(40), deployed: { version: 'v9', env: 'prod', scope: 'frontend' }, ...o });

test('text: id, label, branch, state, sha, deploy version, next step', () => {
  const t = externalResultText(req());
  for (const w of ['int-abc1', 'mac-1', 'claude/x', 'deployed', 'aaaaaaaaaaaa', 'v9', 'Next:']) assert.match(t, new RegExp(w));
  assert.match(externalResultText(req({ state: 'returned', reason: 'tests red' })), /fix it on the branch/);
  assert.equal(externalResultText(req({ state: 'running' })), null);
});

test('relay: file + manager event once per state; internal requests ignored', async () => {
  const stateDir = tmp('extres-'); const events = [];
  const x = createExternalResult({ stateDir, managerEvent: (e) => events.push(e) });
  assert.equal((await x.relay(req({ origin: undefined }))).relayed, false);
  assert.equal((await x.relay(req({ state: 'running' }))).relayed, false);
  assert.equal((await x.relay(req())).relayed, true);
  assert.equal((await x.relay(req())).dup, true);
  assert.equal(events.length, 1);
  assert.equal(classifyKey(events[0].key).kind, 'external-result');
  assert.match(readFileSync(join(stateDir, 'integration', 'external-results', 'int-abc1.txt'), 'utf8'), /deployed/);
  assert.equal((await x.relay(req({ state: 'returned', reason: 'r' }))).relayed, true, 'a later final state is relayed too');
});

test('sweep: owner push after 10 min without ack, once; ack stops it', async () => {
  const stateDir = tmp('extres-'); let t = Date.now(); const pushes = [];
  const x = createExternalResult({ stateDir, now: () => t, ownerPush: (i) => pushes.push(i) });
  await x.relay(req()); await x.relay(req({ id: 'int-abc2' }));
  assert.deepEqual(x.sweep(), [], 'too early');
  assert.equal(x.ack('int-abc2'), true);
  t += 11 * 60000;
  assert.deepEqual(x.sweep(), ['int-abc1']);
  assert.deepEqual(x.sweep(), [], 'pushed once');
  assert.equal(pushes.length, 1); assert.equal(pushes[0].priority, 'high');
  assert.equal(x.ack('nope'), false);
  assert.ok(existsSync(join(x.dir, 'int-abc1.pushed')));
});
