// TASK-44 manager fixes: safe defaults, no repeat logging across restarts, outcome attribution, alert API, actor field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReporter } from '../reporter.js';
import { createAlerts } from '../push.js';
import { actorOf, createAlertApi, ALERT_MAX_PER_HOUR } from '../api-extras.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-fixes-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
await m.initManager({ onOwnerNeeded: () => {} });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const of = (type, s) => records().filter((r) => r.type === type && r.session === s);
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = records().find(pred); if (r) return r; await settle(20); }
  throw new Error('timed out waiting for a log record');
}
const mk = (mod) => (name, state, plain, now, extra = {}) => mod.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, ...extra });
const tick = mk(m);

// ---- 1. safe defaults ----
test('defaults: aiAutoCases is empty (the owner picks), like autoCases; owner_decision is never a default', () => {
  const c = m.managerConfig();
  assert.deepEqual(c.aiAutoCases, []);
  assert.deepEqual(c.autoCases, []);
  assert.ok(!c.aiAutoCases.includes('owner_decision'));
  assert.equal(c.autoSend, false);
  assert.equal(c.aiTriage, 'simulate');
});

// ---- 2. repeat logging across restarts ----
const STOP = pane('Cache layer is in.\nNext I\'ll wire it into the reader.');
const REPAINT = pane('Cache layer is in.\nNext I\'ll wire it into the reader.\n');   // same words, an extra blank line

test('the same stop after a service restart is not logged again; a new stop and a stop after real work are', async () => {
  tick('q1', 'working', ['busy'], 0);
  tick('q1', 'done', STOP, 1000); tick('q1', 'done', STOP, 2500);
  await until((r) => r.type === 'stall' && r.session === 'q1');
  await settle();
  assert.equal(of('stall', 'q1').length, 1);
  assert.ok(existsSync(join(dir, 'last-stops.json')), 'the last stop key is persisted');

  // restart: a fresh module instance reads the same state dir
  const m2 = await import('../manager.js?restart=1');
  await m2.initManager({ onOwnerNeeded: () => {} });
  const t2 = mk(m2);
  t2('q1', 'working', ['busy'], 0, { realWork: false });                 // seen, but a flicker: no real work
  t2('q1', 'done', REPAINT, 1000); t2('q1', 'done', REPAINT, 2500);
  await settle();
  assert.equal(of('stall', 'q1').length, 1, 'same stop, after a restart: still one record');

  // real work, then the same words again: a new stop
  t2('q1', 'working', ['busy'], 5000, { realWork: true });
  t2('q1', 'done', STOP, 6000); t2('q1', 'done', STOP, 7500);
  await until(() => of('stall', 'q1').length === 2);
  assert.equal(of('stall', 'q1').length, 2);

  // another restart + a different stop: logged
  const m3 = await import('../manager.js?restart=2');
  await m3.initManager({ onOwnerNeeded: () => {} });
  const t3 = mk(m3);
  const other = pane('Reader is wired.\nNext I\'ll add the tests.');
  t3('q1', 'working', ['busy'], 0);
  t3('q1', 'done', other, 1000); t3('q1', 'done', other, 2500);
  await until(() => of('stall', 'q1').length === 3);
  assert.equal(of('stall', 'q1').length, 3);
});

test('a repeated stop of one session does not suppress the same words in another session', async () => {
  tick('q2', 'working', ['busy'], 0);
  tick('q2', 'done', STOP, 1000); tick('q2', 'done', STOP, 2500);
  await until((r) => r.type === 'stall' && r.session === 'q2');
  assert.equal(of('stall', 'q2').length, 1);
});

// ---- 3. outcome attribution ----
const closing = 'Merged the cache layer.\nShall I continue with the reader?';
const stopPane = (old = []) => [...old, ...closing.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const movedOn = (p, below = []) => [...p.slice(0, -4), ...below, '✶ Thinking…', RULE, '❯ ', RULE, 'x'];

test('outcome: an OLD prompt above the stall text is not its outcome (kind unknown)', async () => {
  const p = stopPane(['❯ merge to main', '⏺ Merged.', '']);
  tick('o1', 'working', ['busy'], 0);
  tick('o1', 'done', p, 1000); tick('o1', 'done', p, 2500);
  const st = await until((r) => r.type === 'stall' && r.session === 'o1');
  tick('o1', 'working', movedOn(p), 9000, { realWork: true });
  const o = await until((r) => r.type === 'outcome' && r.id === st.id);
  assert.equal(o.kind, 'unknown');
  assert.equal(o.reply, null);
  assert.equal(o.via, 'unknown');
});

test('outcome: a prompt BELOW the stall text is accepted', async () => {
  const p = stopPane(['❯ merge to main', '⏺ Merged.', '']);
  tick('o2', 'working', ['busy'], 0);
  tick('o2', 'done', p, 1000); tick('o2', 'done', p, 2500);
  const st = await until((r) => r.type === 'stall' && r.session === 'o2');
  tick('o2', 'working', movedOn(p, ['❯ yes', '⏺ On it']), 9000, { realWork: true });
  const o = await until((r) => r.type === 'outcome' && r.id === st.id);
  assert.equal(o.reply, 'yes');
  assert.equal(o.kind, 'continue');
  assert.equal(o.via, 'terminal');
});

test('outcome: closing text no longer on screen -> unknown, even with a prompt on screen', async () => {
  const p = stopPane();
  tick('o3', 'working', ['busy'], 0);
  tick('o3', 'done', p, 1000); tick('o3', 'done', p, 2500);
  const st = await until((r) => r.type === 'stall' && r.session === 'o3');
  tick('o3', 'working', ['❯ merge to main', '⏺ other work', '✶ Thinking…', RULE, '❯ ', RULE, 'x'], 9000, { realWork: true });
  const o = await until((r) => r.type === 'outcome' && r.id === st.id);
  assert.equal(o.kind, 'unknown');
});

test('outcome: the reporter prompt older than the stall is not its outcome; one after it is', async () => {
  let clock = 0;
  const rp = createReporter({ stateDir: dir, now: () => clock });
  const live = (name) => ({ turnForStop: (since) => rp.turnForStop(name, since), promptSince: (since) => rp.promptSince(name, since) });
  const ev = (name, event, extra = {}) => rp.ingest({ v: 1, event, session: name, sessionId: 'sid', ...extra });
  const p = stopPane(['❯ merge to main', '⏺ Merged.', '']);
  // old prompt (before the stall), then the stall
  clock = 100; ev('o4', 'prompt', { text: 'merge to main' });
  tick('o4', 'working', ['busy'], 0, { rep: live('o4') });
  clock = 1000; tick('o4', 'done', p, 1000, { rep: live('o4') }); clock = 2500; tick('o4', 'done', p, 2500, { rep: live('o4') });
  const st = await until((r) => r.type === 'stall' && r.session === 'o4');
  clock = 9000; tick('o4', 'working', movedOn(p), 9000, { rep: live('o4'), realWork: true });
  const o = await until((r) => r.type === 'outcome' && r.id === st.id);
  assert.equal(o.kind, 'unknown');
  assert.equal(o.reply, null);

  // a fresh stop and a prompt submitted after it
  const p2 = pane('Reader is wired.\nShall I add the tests?');
  clock = 10000; tick('o4', 'done', p2, 10000, { rep: live('o4') }); clock = 11500; tick('o4', 'done', p2, 11500, { rep: live('o4') });
  const st2 = await until((r) => r.type === 'stall' && r.session === 'o4' && r.id !== st.id);
  clock = 12000; ev('o4', 'prompt', { text: 'yes, add the tests' });
  clock = 13000; tick('o4', 'working', [...p2.slice(0, -4), '✶ Thinking…', RULE, '❯ ', RULE, 'x'], 13000, { rep: live('o4'), realWork: false });
  const o2 = await until((r) => r.type === 'outcome' && r.id === st2.id);
  assert.equal(o2.via, 'reporter');
  assert.equal(o2.reply, 'yes, add the tests');
});

// ---- 5. actor field ----
test('actorOf: default owner, trimmed, max 40 chars, only a string', () => {
  assert.equal(actorOf({}), 'owner');
  assert.equal(actorOf(undefined), 'owner');
  assert.equal(actorOf({ by: 'manager-agent' }), 'manager-agent');
  assert.equal(actorOf({ by: '  owner ' }), 'owner');
  assert.equal(actorOf({ by: 'x'.repeat(40) }).length, 40);
  for (const bad of ['x'.repeat(41), '', '   ', 5, {}, ['a'], true]) assert.throws(() => actorOf({ by: bad }), (e) => e.status === 400, String(bad));
});

test('labels record who labelled: default owner, manager-agent when passed, bad by rejected', async () => {
  const st = await until((r) => r.type === 'stall' && r.session === 'q2');
  const a = await m.labelStall({ id: st.id, label: 'legit' });
  assert.equal(a.by, 'owner');
  const b = await m.labelStall({ id: st.id, label: 'no_reason', by: 'manager-agent' });
  assert.equal(b.by, 'manager-agent');
  assert.equal(records().filter((r) => r.type === 'label' && r.id === st.id).at(-1).by, 'manager-agent');
  await assert.rejects(m.labelStall({ id: st.id, label: 'legit', by: 'x'.repeat(41) }), /by must be/);
});

// ---- 4. alert API ----
const TOKEN = 'tok';
function alertApi(over = {}) {
  const pushed = [];
  const { alert } = createAlerts({ push: { notify: async (n) => { pushed.push(n); } }, defaultDebounceMs: 60000, now: over.now || Date.now, log: { error() {} } });
  const api = createAlertApi({ alert, tokenOk: (t) => t === TOKEN, now: over.now || Date.now, maxPerHour: over.max });
  const call = (body, { addr = '127.0.0.1', token = TOKEN } = {}) => api.handle({ remoteAddress: addr, headers: token == null ? {} : { 'x-ghosty-reporter-token': token }, readBody: async () => body });
  return { call, pushed };
}

test('alert API: loopback + token only', async () => {
  const { call, pushed } = alertApi();
  const body = { title: 'Deploy waiting', body: 'qualiai needs approval' };
  assert.equal((await call(body, { addr: '100.64.0.5' })).status, 403);
  assert.equal((await call(body, { addr: '::ffff:10.0.0.2' })).status, 403);
  assert.equal((await call(body, { token: null })).status, 401);
  assert.equal((await call(body, { token: 'nope' })).status, 401);
  assert.equal(pushed.length, 0);
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = await call({ ...body, title: `t ${addr}` }, { addr });
    assert.equal(r.status, 200, addr);
  }
  assert.equal(pushed.length, 3);
});

test('alert API: goes through alert() (title, body, url, priority, tag) and is debounced like any alert', async () => {
  const { call, pushed } = alertApi();
  const r = await call({ title: 'Needs you', body: 'Approve deploy 3f2a', url: '/?s=qualiai', priority: 'high', tag: 'dep-3f2a' });
  assert.deepEqual(r, { status: 200, body: { ok: true, sent: true } });
  assert.deepEqual(pushed[0], { title: 'Needs you', body: 'Approve deploy 3f2a', url: '/?s=qualiai', tag: 'dep-3f2a', priority: 'high' });
  const again = await call({ title: 'Needs you', body: 'Approve deploy 3f2a', tag: 'dep-3f2a' });
  assert.deepEqual(again.body, { ok: true, sent: false, debounced: true });
  assert.equal(pushed.length, 1);
  const other = await call({ title: 'Needs you', body: 'another', tag: 'dep-other' });
  assert.equal(other.body.sent, true);
});

test('alert API: validation', async () => {
  const { call } = alertApi();
  const ok = { title: 't', body: 'b' };
  for (const bad of [{}, { title: 't' }, { body: 'b' }, { ...ok, title: 'x'.repeat(121) }, { ...ok, body: 'x'.repeat(1001) }, { ...ok, priority: 'critical' },
    { ...ok, url: 'javascript:alert(1)' }, { ...ok, tag: 5 }, { ...ok, title: 5 }]) {
    assert.equal((await call(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('alert API: at most 10 per hour, the window slides', async () => {
  let t = 1e12;
  const { call } = alertApi({ now: () => t });
  assert.equal(ALERT_MAX_PER_HOUR, 10);
  for (let i = 0; i < 10; i++) assert.equal((await call({ title: `a${i}`, body: 'b' })).status, 200);
  const r = await call({ title: 'a11', body: 'b' });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /10 alerts per hour/);
  t += 3600e3 + 1;
  assert.equal((await call({ title: 'a12', body: 'b' })).status, 200);
});
