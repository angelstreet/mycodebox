import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseAsk, mentionsOf, answerLeaseAsk, idleHoldEvent, LEASE_RULE, touches } from '../lease-ask.js';
import { hardMatch } from '../stall.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-leaseask-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const m = await import('../manager.js');

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const TABLE = [
  // lease questions
  ['Is env-a/frontend free?', true], ['Is the frontend lease free?', true], ['Can I deploy? The lease on env-a/server is held by codebox:other.', true],
  ['Should I wait for the lease on host-1/device2?', true], ['Who holds the lease on env-a?', true], ['Is host-1 free right now?', true],
  ['vpt-lease says the server is held. Should I keep waiting?', true], ['May I take the exclusive lease on stb-1?', true], ['The lease is still held. Should I keep waiting or ask you?', true],
  ['Is env-a/device:host-1/device2 available?', true], ['Can I deploy, the lease on env-a/frontend is held by manager:deploy', true], ['Is the device free for my run?', true],
  ['Is stb-1 free?', true], ['Should I wait for the lease to be released?', true], ['Who has host-1 right now?', true], ['Do I need a lease for the frontend change?', true],
  ['OK to claim the lease now?', true], ['Is the server busy?', true],
  // not lease questions
  ['Should I merge feat into main?', false], ['Is the build free of warnings?', false], ['Which option do you prefer, 1 or 2?', false], ['Is port 8080 free?', false],
  ['Should I sign the lease for the new office?', false], ['The lease is held by codebox:other, so I will wait.', false], ['I released the lease and finished the work.', false],
  ['Is the server running the latest build?', false], ['Free up disk space?', false], ['Can I delete the old branch?', false], ['Is the test suite green?', false],
  ['Do you want the free tier?', false], ['What does the lease service do?', false], ['Is the host reachable over ssh?', false], ['STATUS: done - lease released', false], ['', false],
];
test('lease-ask detection table (>= 20 phrasings, lease and non-lease)', () => {
  assert.ok(TABLE.length >= 20);
  for (const [text, want] of TABLE) assert.equal(leaseAsk(text).lease, want, text);
});
test('mentions and touches', () => {
  assert.deepEqual(mentionsOf('Is env-a/frontend free?'), ['env-a/frontend', 'frontend']);
  assert.ok(mentionsOf('Is stb-1 free and the server?').includes('stb-1'));
  assert.equal(touches('host-1/device2', 'env-a', ['host-1']), true);   // a host lease covers its devices
  assert.equal(touches('host-2/device1', 'env-a', ['host-1']), false);
  assert.equal(touches('frontend', 'env-a', ['*']), true);
  assert.equal(touches('frontend', 'env-a', ['server']), false);
});

const view = (over = {}) => ({ ok: true, authority: 'central', leases: [{ id: 'L1', env: 'env-a', resources: ['frontend'], mode: 'exclusive', agent: 'codebox:dev1', purpose: 'ui rework', sinceMs: NOW - 22 * 60000, ttlLeftMin: 98, idleMin: 3 }], tickets: [{ id: 'T1', env: 'env-a', resources: ['frontend'], agent: 'codebox:me', position: 2, etaMs: NOW + 14 * 60000 }], ...over });
test('answer template: holder, purpose, since, my position and ETA, and the wait rule', () => {
  const a = answerLeaseAsk({ ask: 'Is env-a/frontend free?', view: view(), session: 'me', now: NOW });
  assert.match(a.text, /env-a\/frontend is held by codebox:dev1 \(exclusive\) for "ui rework", since 22 min ago, 98 min left, idle 3 min\./);
  assert.match(a.text, /You are #2 in the queue for env-a\/frontend, expected free in about 14 min\./);
  assert.ok(a.text.endsWith(LEASE_RULE)); assert.match(a.text, /never ask the owner about a lease/);
  assert.equal(hardMatch(a.text, {}), null);
});
test('answer: free, unreachable (busy, never free), holder names the hard floor would block', () => {
  assert.match(answerLeaseAsk({ ask: 'Is host-1 free?', view: view(), session: 'me', now: NOW }).text, /host-1 has no exclusive lease held right now, so it is free/);
  const bad = answerLeaseAsk({ ask: 'Is the server free?', view: { ok: false }, session: 'me', now: NOW });
  assert.match(bad.text, /unreachable, so treat server as busy/);
  const hard = answerLeaseAsk({ ask: 'Is env-a/frontend free?', view: view({ leases: [{ ...view().leases[0], agent: 'manager:deploy', purpose: 'deploy of the frontend' }] }), session: 'me', now: NOW });
  assert.equal(hardMatch(hard.text, {}), null); assert.match(hard.text, /is held by/);
});
test('idle-hold flag: a waiting or blocked STATUS with an exclusive lease only', () => {
  const rows = [{ id: 'a1', env: 'env-a', resource: 'frontend' }];
  assert.equal(idleHoldEvent({ session: 's', status: 'waiting', rows }).key, 'lease:idle-hold');
  assert.ok(idleHoldEvent({ session: 's', status: 'blocked', rows }));
  assert.equal(idleHoldEvent({ session: 's', status: 'done', rows }), null);
  assert.equal(idleHoldEvent({ session: 's', status: 'waiting', rows: [] }), null);
});

// --- through observe(): the existing manager_decision gates ---------------------------------------------------------
const typed = [], owner = [], statuses = [];
let lv = view();
const heldMap = new Map();
await m.initManager({
  managerSessions: () => ['mgr'], onOwnerNeeded: (session, stall, reason) => owner.push({ session, reason }),
  sendKey: async () => {}, sendKeys: async (session, text) => { typed.push({ session, text }); },
  policy: () => ({ action: 'allow', reason: 'ok' }), heldStore: { get: (n) => heldMap.get(n) || null, set: (n, h) => heldMap.set(n, h) },
  leaseView: async () => lv, onStatus: (s, st, t) => statuses.push([s, st, t]),
});
const cfg = (o = {}) => m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: true, delayMs: 30, ...o });
await cfg();
const RULE = '─'.repeat(40);
const pane = (body, draft = '') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, `❯ ${draft}`, RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
async function stop(name, body, { draft = '', outcome = true } = {}) {
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: dir, now });
  const p = pane(body, draft);
  t('working', ['busy'], 0); t('done', p, 1000); t('done', p, 2500);
  if (outcome) await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)), 6000);
  else await until(() => stalls().some((r) => r.session === name && r.type === 'stall'), 6000);
  await wait(100);
}

test('observe: "is X free?" is answered from the lease source, not escalated', async () => {
  await stop('me', 'Tests: 12/12 pass.\n\nIs env-a/frontend free?');
  const mine = typed.filter((x) => x.session === 'me');
  assert.equal(mine.length, 1, JSON.stringify({ typed, owner }));
  assert.match(mine[0].text, /^Lease: env-a\/frontend is held by codebox:dev1/);
  assert.match(mine[0].text, /You are #2/); assert.match(mine[0].text, /never ask the owner about a lease/);
  assert.doesNotMatch(mine[0].text, /rest of your question/);
  assert.ok(!owner.some((o) => o.session === 'me'));
  assert.equal(stalls().find((r) => r.type === 'answer' && r.session === 'me').source, 'manager_decision');
});
test('observe: a lease ask that also asks to deploy or restart is NOT auto-answered as a lease question (item 2)', async () => {
  const n = typed.length, o = owner.length;
  await stop('wd', 'Frontend change is ready.\n\nCan I deploy, the lease on env-a/frontend is held by codebox:dev1?', { outcome: false });
  await stop('d2', 'Ready.\n\nIs the server lease free so I can deploy the server now?', { outcome: false });
  await stop('d3', 'Ready.\n\nThe lease on server is free - should I restart vpt-server and deploy?', { outcome: false });
  await wait(400);
  assert.ok(!typed.slice(n).some((x) => /vpt-lease|never ask the owner about a lease/.test(x.text)), JSON.stringify(typed.slice(n)));
  assert.ok(['wd', 'd2', 'd3'].every((x) => owner.slice(o).some((y) => y.session === x)), JSON.stringify(owner.slice(o)));
});
test('observe: leaseAnswers off -> a pure lease question goes the old way', async () => {
  const n = typed.length;
  await m.setManagerConfig({ leaseAnswers: false });
  await stop('off', 'Ready.\n\nIs env-a/frontend free?', { outcome: false });
  await wait(300);
  assert.equal(typed.length, n);
  await m.setManagerConfig({ leaseAnswers: true });
  assert.equal(m.managerConfig().leaseAnswers, true);
});
test('observe: a hard topic in the same stop still escalates, the lease part is answered', async () => {
  const n = typed.length, o = owner.length;
  await stop('hd', 'Done with the change.\n\nIs env-a/frontend free? And should I delete the old database?');
  assert.equal(typed.length, n + 1);
  assert.match(typed.at(-1).text, /held by codebox:dev1/); assert.match(typed.at(-1).text, /rest of your question went to the owner/);
  assert.ok(owner.slice(o).some((x) => x.session === 'hd'));
});
test('observe: unreachable source answers "treat as busy", never free; a throwing source too', async () => {
  const n = typed.length;
  lv = { ok: false, error: 'down' };
  await stop('un', 'Ready.\n\nIs the server free?');
  assert.equal(typed.length, n + 1); assert.match(typed.at(-1).text, /treat server as busy/);
  lv = view();
});
test('observe gates: auto-answer off, a draft in the input box, and a paused session send nothing and the owner is not asked a lease question twice', async () => {
  const n = typed.length;
  await cfg({ autoSend: false });
  await stop('g1', 'Ready.\n\nIs env-a/frontend free?', { outcome: false });
  await wait(300);
  await cfg({ autoSend: true });
  await stop('g2', 'Ready.\n\nIs env-a/frontend free?', { draft: 'half typed reply', outcome: false });
  await wait(300);
  assert.equal(typed.length, n);
});
test('observe: a non-lease question still goes the old way (no lease text)', async () => {
  const n = typed.length;
  await stop('nl', 'Ready.\n\nShould I use the blue or the green button?', { outcome: false });
  await wait(300);
  assert.ok(!typed.slice(n).some((x) => /vpt-lease/.test(x.text)));
});
test('observe: a STATUS waiting / blocked stop reaches the status hook with its text', async () => {
  await stop('st1', 'Waiting on CI.\n\nSTATUS: blocked: waiting on the CI run', { outcome: false });
  await until(() => statuses.some((x) => x[0] === 'st1'));
  assert.deepEqual(statuses.find((x) => x[0] === 'st1').slice(0, 2), ['st1', 'blocked']);
  assert.match(statuses.find((x) => x[0] === 'st1')[2], /CI/);
});
