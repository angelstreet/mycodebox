// "STATUS: needs-manager: <what the manager must do>" (2026-10-20, TASK142): the agent hands the next step to the AI
// manager. Before this, ghosty parsed only needs-owner / blocked / waiting, so such a turn was classified as a plain
// 'done' -- blue LED, no manager event -- and the session waited ~20 min until the owner noticed.
// The stop must reach the manager exactly once per stop, never the owner (no push, no ask popup, no NEEDS YOU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';

const dir = tmp('ghosty-needsmgr-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const sent = [], pushes = [], items = [];
await m.initManager({ onOwnerNeeded: (s) => pushes.push(s), onManagerItem: (it) => items.push(it), sendKeys: async (name, text) => { sent.push({ name, text }); }, sendKey: async () => {} });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: true });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'stalls.jsonl')) ? readFileSync(join(dir, 'stalls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, cwd: '/nonexistent' });
async function stop(name, body, until) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(body), 1000); tick(name, 'done', pane(body), 2500);
  const end = Date.now() + 4000;
  while (Date.now() < end) { const e = log().find((r) => until(r) && r.session === name); if (e) return e; await wait(25); }
  throw new Error(`no event for ${name}`);
}
const NEEDS_MANAGER = 'please verify and request fix/needs-manager-status with --approved-by manager';

test('a STATUS needs-manager stop is a manager item: escalated to the manager, never the owner', async () => {
  const e = await stop('nm1', `Branch pushed, tests green.\nSTATUS: needs-manager: ${NEEDS_MANAGER}`, (r) => r.type === 'escalated');
  assert.equal(e.target, 'manager', 'escalatedTo is the manager');
  assert.equal(e.case, 'needs_manager');
  assert.equal(e.kind, 'manager-item');

  assert.equal(pushes.length, 0, 'no owner push');
  assert.deepEqual(sent, [], 'nothing is typed into the pane');
  assert.equal(m.toOwnerCase({ case: 'needs_manager', question: NEEDS_MANAGER }), false, 'never an owner ask');

  assert.equal(items.length, 1, 'exactly one manager item for the stop');
  assert.deepEqual(
    { session: items[0].session, kind: items[0].kind, case: items[0].case },
    { session: 'nm1', kind: 'manager-item', case: 'needs_manager' });
  assert.equal(items[0].question, NEEDS_MANAGER, 'the body carries the STATUS text');
});

test('the manager item is raised once per stop, and a needs-owner / done stop still goes to the owner', async () => {
  // a second sighting of the same stop (same pane, same text) must not raise a second item
  tick('nm1', 'done', pane(`Branch pushed, tests green.\nSTATUS: needs-manager: ${NEEDS_MANAGER}`), 3000);
  tick('nm1', 'done', pane(`Branch pushed, tests green.\nSTATUS: needs-manager: ${NEEDS_MANAGER}`), 3600);
  await wait(200);
  assert.equal(items.filter((i) => i.session === 'nm1').length, 1, 'still one manager item for the stop');

  // the other two verdicts are untouched: needs-owner is the owner's, done is nobody's
  const o = await stop('nm2', 'Tests pass.\nSTATUS: needs-owner: shall I rotate the API key?', (r) => r.type === 'escalated');
  assert.notEqual(o.target, 'manager', 'needs-owner still goes to the owner');
  assert.equal(m.toOwnerCase({ case: 'owner_decision', question: 'shall I rotate the API key?' }), true);
  assert.equal(items.filter((i) => i.session === 'nm2').length, 0, 'no manager item for a needs-owner stop');

  const d = await stop('nm3', 'Everything is merged and clean.\nSTATUS: done', (r) => r.type === 'stall' || r.type === 'escalated');
  assert.notEqual(d.type, 'escalated', 'a plain done is not escalated at all');
  assert.equal(items.filter((i) => i.session === 'nm3').length, 0, 'and raises no manager item');
  assert.equal(m.toOwnerCase({ case: 'done', question: 'all clean.' }), false);
});