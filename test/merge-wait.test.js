import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-mergewait-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const sent = [], pushes = [], items = [], enq = [];
let repo = 'mycodebox';
const integration = { repoForCwd: async () => repo, enqueue: (r) => { enq.push(r); return { id: 'int-fake01', position: 1, repo: r.repo }; } };
await m.initManager({ onOwnerNeeded: (s) => pushes.push(s), onManagerItem: (it) => items.push(it), integration, sendKeys: async (name, text) => { sent.push({ name, text }); }, sendKey: async () => {} });
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

test('merge_wait with a lane repo: enqueues, tells the session the id, never asks the owner', async () => {
  await stop('mw1', 'Pushed v2/x.\nSTATUS: waiting — your merge decision on PR #22 (branch v2/x)', (r) => r.type === 'merge_handoff');
  assert.deepEqual(enq[0], { repo: 'mycodebox', branch: 'v2/x', session: 'mw1', by: 'manager' });
  await wait(50);
  assert.match(sent.find((x) => x.name === 'mw1').text, /queued integration int-fake01.*STATUS: waiting: integration int-fake01/);
  assert.equal(pushes.length, 0);
  assert.equal(items.length, 0);
  assert.ok(!log().some((r) => r.type === 'escalated' && r.session === 'mw1'));
  const ans = log().find((r) => r.type === 'answer' && r.session === 'mw1');   // finding 5: the hand-off is an answer joined to the lane's verdict record
  assert.equal(ans.case, 'merge_wait'); assert.deepEqual(ans.decision_ids, ['lane-merge-int-fake01']);
});

test('finding 6: autoSend off or an owner draft: nothing is enqueued, the stop goes on to the owner', async () => {
  repo = 'mycodebox';
  const n = enq.length;
  await m.setManagerConfig({ autoSend: false });
  try {
    const e = await stop('mw-off', 'Pushed v2/y.\nSTATUS: waiting — your merge decision on PR #30 (branch v2/y)', (r) => r.type === 'escalated' || r.type === 'merge_handoff');
    assert.notEqual(e.type, 'merge_handoff'); assert.equal(enq.length, n);
  } finally { await m.setManagerConfig({ autoSend: true }); }
});

test('merge_wait without a lane repo: the merge evaluation runs; its failure is a manager item of kind merge, not an owner ask', async () => {
  repo = null;
  const e = await stop('mw2', 'Done.\nSTATUS: needs-owner: merge PR #23?', (r) => r.type === 'escalated');
  assert.equal(e.target, 'manager');
  assert.equal(e.kind, 'merge');
  assert.equal(items.at(-1).kind, 'merge');
  assert.equal(pushes.length, 0);
  assert.equal(enq.length, 1);
  const journal = readFileSync(join(dir, 'manager-decisions.jsonl'), 'utf8');
  assert.ok(journal.includes('mw2'));
});

test('merge_wait with a hard word (force-push) still goes to the owner', async () => {
  repo = 'mycodebox';
  const e = await stop('mw3', 'Done.\nSTATUS: needs-owner: merge PR #24 and force-push main?', (r) => r.type === 'escalated');
  assert.notEqual(e.target, 'manager');
  assert.equal(enq.length, 1);
});
