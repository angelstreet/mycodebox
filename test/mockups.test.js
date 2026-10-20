// Round 9 item 7: mockup-first default. A mockup in the feed (kind mockup, link, deadlineAt), the manager answer, the owner's object tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { createPush } from '../push.js';
import { TOKEN_HEADER } from '../reporter.js';
import { tmp } from './helpers-tmp.js';

const dir = tmp('ghosty-mockups-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const { mockupRule, createMockups, OBJECT_TEXT } = await import('../mockups.js');
const m = await import('../manager.js');
const { makeRepo } = await import('./helpers-git.js');

test('mockupRule: a mockup approval ask is answered; menus, other topics and a zero window are not', () => {
  const ask = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  const r = mockupRule(ask('Shall I show you the mockup before I build the settings page?'));
  assert.match(r, /^Proceed: post the mockup to the feed \(.*10 min to object\) and build; the owner reviews at the end\.$/);
  assert.ok(mockupRule(ask('Do you want to approve the mockup before I implement it?')));
  assert.match(mockupRule(ask('Want me to show the mockup first?'), { windowMin: 25 }), /25 min/);
  assert.equal(mockupRule(ask('Shall I show you the mockup?'), { windowMin: 0 }), null);
  assert.equal(mockupRule(ask('Shall I show you the mockup?'), { enabled: false }), null);
  assert.equal(mockupRule(ask('Which mockup do you prefer?', { options: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }] })), null);
  assert.equal(mockupRule(ask('Shall I build the settings page?')), null);
  assert.equal(mockupRule(ask('The mockup is approved.')), null);
  assert.equal(mockupRule({ case: 'error', question: 'Shall I show you the mockup?' }), null);
});

test('POST /api/mockups logic: loopback + token, a feed record with kind mockup, link and deadlineAt; the object tap tells the session once', async () => {
  const push = createPush({ stateDir: tmp('mk-push-'), log: { error() {} } });
  const sent = [];
  let t = 1_700_000_000_000;
  const mk = createMockups({ file: join(dir, 'mockups.jsonl'), push, tokenOk: (x) => x === 'tok', now: () => t, windowMin: () => 10, send: async (s, text, by) => { sent.push({ s, text, by }); } });
  const H = { [TOKEN_HEADER]: 'tok' };
  const body = { session: 'ui-worker', title: 'Settings page', url: '/mockups/settings.html' };
  assert.equal((await mk.post({ remoteAddress: '203.0.113.9', headers: H, body })).status, 403);
  assert.equal((await mk.post({ remoteAddress: '127.0.0.1', headers: {}, body })).status, 401);
  for (const bad of [{ ...body, url: 'javascript:x' }, { ...body, title: '' }, { ...body, session: '../x' }]) assert.equal((await mk.post({ remoteAddress: '127.0.0.1', headers: H, body: bad })).status, 400);
  const ok = await mk.post({ remoteAddress: '127.0.0.1', headers: H, body });
  assert.equal(ok.status, 200); assert.equal(ok.body.deadlineAt, t + 10 * 60e3);
  const item = push.feedSince(0).find((i) => i.id === ok.body.feedId);
  assert.equal(item.kind, 'mockup'); assert.equal(item.url, '/mockups/settings.html'); assert.equal(item.deadlineAt, t + 600e3); assert.equal(item.mockupId, ok.body.id);
  assert.deepEqual(item.actions, [{ action: 'object', title: 'Object' }]);
  const custom = await mk.post({ remoteAddress: '::1', headers: H, body: { ...body, windowMin: 30 } });
  assert.equal(custom.body.deadlineAt, t + 30 * 60e3);
  const o = await mk.object(ok.body.id);
  assert.equal(o.status, 200); assert.deepEqual(sent, [{ s: 'ui-worker', text: OBJECT_TEXT, by: 'owner' }]); assert.equal(o.body.late, false);
  assert.equal((await mk.object(ok.body.id)).status, 409);
  assert.equal((await mk.object('nope')).status, 404);
  t += 3600e3;
  assert.equal((await mk.object(custom.body.id)).body.late, true);   // an objection after the window still reaches the session
});

test('server wiring: the routes exist and the object tap uses the guarded send', () => {
  const s = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(s.includes("p === '/api/mockups'")); assert.ok(s.includes('/^\\/api\\/mockups\\/([\\w-]{1,40})\\/object$/'));
  assert.match(s, /await assertAgentPane\(session, by\); await sendKeys\(session, text, true\)/);
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /action: 'object'/); assert.match(sw, /\/api\/mockups\/\$\{encodeURIComponent\(data\.mockupId\)\}\/object/);
});

// ---- manager level ----
const typed = [], owner = [];
await m.initManager({
  managerSessions: () => ['mgr'], onOwnerNeeded: (session, stall, reason) => owner.push({ session, reason }),
  sendKey: async () => {}, sendKeys: async (session, text) => { typed.push({ session, text }); },
  onMergeDecision: () => {}, policy: () => ({ action: 'allow', reason: 'ok' }), heldStore: { get: () => null, set: () => {} },
  decideContext: () => ({ deploys: { ok: true, deploys: [], deployed: {}, envs: [] }, leases: { ok: true, leases: [], waiters: [] }, envs: [] }),
  onDigest: () => {}, mergeJev: async () => ({ skipped: 'not configured' }),
});
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, delayMs: 30 });
const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
async function stop(name, body) {
  const cwd = makeRepo();
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: st === 'working', project: 'p', cwd, now });
  const p = pane(body);
  t('working', ['busy'], 0); t('done', p, 1000); t('done', p, 2500);
  await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
  await wait(150);
  return { typed: typed.filter((x) => x.session === name).map((x) => x.text), esc: stalls().find((r) => r.type === 'escalated' && r.session === name) };
}
test('manager: "show you the mockup before I build?" is answered; the setting turns it off; a hard topic in the ask still escalates', async () => {
  const a = await stop('mk1', 'The settings page layout is designed.\n\nShall I show you the mockup before I build it?');
  assert.equal(a.typed.length, 1, JSON.stringify(a.esc)); assert.match(a.typed[0], /^Proceed: post the mockup to the feed/);
  assert.equal(a.esc, undefined);
  const hard = await stop('mk2', 'Shall I show you the mockup before I build it, and delete the old page?');
  assert.deepEqual(hard.typed, []); assert.ok(hard.esc);
  const saved = await m.setManagerConfig({ mockupFirst: false });
  assert.equal(saved.mockupFirst, false);
  const off = await stop('mk3', 'The settings page layout is designed.\n\nShall I show you the mockup before I build it?');
  assert.ok(!off.typed.some((x) => /^Proceed: post the mockup/.test(x)));
  await m.setManagerConfig({ mockupFirst: true, mockupWindowMin: 20 });
  assert.equal(m.managerConfig().mockupWindowMin, 20);
  await assert.rejects(m.setManagerConfig({ mockupWindowMin: 5000 }), /mockupWindowMin/);
});
