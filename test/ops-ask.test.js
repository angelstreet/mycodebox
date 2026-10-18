// Round 12 (d): a lease or deploy stop is a manager item, never an owner item (ops-ask.js, manager.js escalate, NEEDS YOU strip).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opsAsk, isLeaseOrDeployAsk } from '../ops-ask.js';
import { isOwnersTurn, buildQueue } from '../public/ask-model.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-opsask-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [], items = [];
await m.initManager({ onOwnerNeeded: (s) => pushes.push(s), onManagerItem: (it) => items.push(it) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: false });

test('detection: lease and deploy asks, hard floor, mixed and unrelated questions', () => {
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  assert.equal(opsAsk({ case: 'waiting_deploy', question: 'waits for deploy d-42', deployHint: { id: 'd-42' } }), 'deploy');
  assert.equal(opsAsk(od('deploy main to env-a once the lease frees? [1 yes 2 wait]', { status: 'needs-owner' })), 'lease');
  assert.equal(opsAsk(od('lease on env-a/server is held by codebox:other', { status: 'blocked' })), 'lease');
  assert.equal(opsAsk(od('Should I deploy to env-a?')), 'deploy');
  assert.equal(opsAsk(od('Should I restart the backend service via update_core?')), 'deploy');
  assert.equal(opsAsk(od('Is the deploy queue empty, may I approve my deploy?')), 'deploy');
  // hard floor stays with the owner
  assert.equal(opsAsk(od('Deploy main to env-a and drop the old table?')), null);
  assert.equal(opsAsk({ case: 'waiting_deploy', question: 'waits for a deploy; also delete the old branch' }), null);
  assert.equal(opsAsk(od('Should I deploy with sudo?')), null);
  assert.equal(opsAsk(od('Deploy and use the api key from the vault?')), null);
  assert.equal(opsAsk(od('Run the migrations on deploy?')), null);
  assert.equal(opsAsk(od('Should I restart the ghosty service?')), null);
  // unrelated or mixed
  assert.equal(opsAsk(od('Which database should I use, A or B?')), null);
  assert.equal(opsAsk(od('Should I deploy? Also which color for the button?')), null);
  assert.equal(opsAsk(od('Should I sign the lease for the new office?')), null);
  assert.equal(opsAsk({ case: 'permission', question: 'deploy?' }), null);
  assert.equal(isLeaseOrDeployAsk(null), false);
});

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'stalls.jsonl')) ? readFileSync(join(dir, 'stalls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function stop(name, body) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(body), 1000); tick(name, 'done', pane(body), 2500);
  const end = Date.now() + 4000;
  while (Date.now() < end) { const e = log().find((r) => r.type === 'escalated' && r.session === name); if (e) return e; await wait(25); }
  throw new Error(`no escalation for ${name}`);
}

test('waiting_deploy and a lease needs-owner become manager items: record, event hook, no owner push', async () => {
  const a = await stop('wd', 'Queued the deploy.\nSTATUS: waiting: deploy d-42');
  assert.equal(a.target, 'manager'); assert.equal(a.kind, 'deploy');
  const b = await stop('lq', 'Everything is ready.\nSTATUS: needs-owner: deploy main to env-a once the lease frees? [1 yes 2 wait]');
  assert.equal(b.target, 'manager');
  assert.deepEqual(pushes, []);
  assert.deepEqual(items.map((i) => i.session).sort(), ['lq', 'wd']);
  assert.equal(m.stallOf('lq').escalatedTo, 'manager');
});

test('a hard-floor deploy question and an unrelated question stay owner items', async () => {
  const a = await stop('hf', 'Ready.\nSTATUS: needs-owner: deploy main to env-a and drop the old table?');
  assert.notEqual(a.target, 'manager');
  const b = await stop('pq', 'The schema change is ready.\nShould I rename the column or keep both?\nSTATUS: needs-owner: rename or keep both?');
  assert.notEqual(b.target, 'manager');
  assert.ok(pushes.includes('hf') && pushes.includes('pq'), JSON.stringify(pushes));
  assert.equal(m.stallOf('pq').escalatedTo, 'owner');
  assert.equal(items.length, 2);
});

test('NEEDS YOU skips manager items (isOwnersTurn / buildQueue)', () => {
  const st = (escalatedTo, state = 'waiting') => ({ state, triage: { state: 'done' }, stall: { case: 'owner_decision', question: 'q?', escalatedTo } });
  assert.equal(isOwnersTurn(st('owner')), true);
  assert.equal(isOwnersTurn(st('manager')), false);
  assert.equal(isOwnersTurn(st('manager', 'done')), false);
  assert.equal(isOwnersTurn(st(null, 'done')), true);
  assert.deepEqual(buildQueue({ a: st('manager'), b: st('owner') }, {}, [{ name: 'a' }, { name: 'b' }]).map((x) => x.name), ['b']);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /escalatedTo !== 'manager' && \(stateOf/);   // the strip itself filters the same way
});
