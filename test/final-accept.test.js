// Accepted final (final-accept.js, 2026-11-26): once the manager accepted a partial / failed result, the done-check, the status-format check and the
// time-box wake send the session nothing and no new `asks` event is raised, until a new owner / manager task message reopens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { hashToken } from '../lease-routes.js';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createFinalAccept, isTaskMessage } from '../final-accept.js';
import { createDoneCheck } from '../done-check.js';

const stateDir = tmp('ghosty-final-');
Object.assign(process.env, { GHOSTY_STATE_DIR: stateDir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const manager = await import('../manager.js');
const { createRemoteStops, PREFIX } = await import('../remote-stops.js');

const store = createFinalAccept({ stateDir });
const asks = [], items = [], typed = [];
await manager.initManager({
  finalAccepted: (n) => store.has(n),
  onOwnerNeeded: (s) => asks.push(s), onManagerItem: (it) => items.push(it.session),
  sendKey: async (n) => { typed.push(n); }, sendKeys: async (n) => { typed.push(n); },
});
await manager.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, delayMs: 100 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCKED = 'STATUS: blocked — row 2 has no passing review because the reviewer cannot sign in; the manager accepted the partial result as final';

test('the record is explicit: only the owner or the manager writes it; only their task text reopens', () => {
  const s = createFinalAccept({ stateDir: tmp('ghosty-final-store-') });
  assert.throws(() => s.accept('a', { by: 'integration' }), /only the owner or the manager/);
  assert.equal(s.has('a'), false);
  assert.equal(s.has('constructor'), false);
  s.accept('a', { by: 'manager-agent', note: 'row 2 stays failed' });
  assert.equal(s.get('a').by, 'manager-agent');
  assert.equal(createFinalAccept({ stateDir: join(s.file, '..') }).has('a'), true, 'survives a restart');
  assert.equal(s.reopen('a', { by: 'owner', why: 'new task' }), true);
  assert.equal(s.reopen('a'), false);
  assert.match(readFileSync(join(s.file, '..', 'accepted-final.jsonl'), 'utf8'), /"accepted".*\n.*"reopened"/);
  for (const by of ['owner', 'manager-agent', 'owner-via-task44']) assert.equal(isTaskMessage(by, 'now fix row 2'), true, by);
  for (const by of ['harness', 'integration', 'lease-nudge', 'claude-accounts']) assert.equal(isTaskMessage(by, 'now fix row 2'), false, by);
  for (const text of ['', '  ', '/exit', '/compact']) assert.equal(isTaskMessage('owner', text), false, text);
});

test('done-check, status-format check and time-box wake: silent for an accepted session, live again after a reopen', async () => {
  const entry = { goal: 'ship it', parts: ['a works', 'b is reviewed'], timeBoxMs: 3600e3, at: new Date(Date.now() - 2 * 3600e3).toISOString() };
  const doneText = 'Verification:\n1. pass — int-1a1cc905977d8c7a9\n2. fail — the review cannot sign in\nSTATUS: done — partial, accepted';
  const run = async (name) => {
    const sent = [], events = [], asked = [], dir = tmp('ghosty-final-dc-');
    let t = Date.now();
    const w = createDoneCheck({
      stateDir: dir, git: async () => { throw new Error('no repo'); }, log: { error() {} }, now: () => t, mode: () => 'live', blockedMode: () => 'live', timeBoxMode: () => 'live',
      pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), finalAccepted: (n) => store.has(n),
      listDone: async () => [{ name: `${name}-done`, cwd: '/nowhere', text: doneText }],
      listBlocked: async () => [{ name: `${name}-blocked`, text: BLOCKED }],
      listSessions: async () => [{ name: `${name}-blocked`, working: false, text: BLOCKED }],
      goalEntryOf: () => entry, draftNow: async () => false,
      goalGate: { forget: async () => {}, evaluate: async (s) => { asked.push(s.name); return null; }, sent: async () => {} },
      send: async (n, x) => { sent.push([n, x]); }, record: async (e) => { events.push(e.key); },
    });
    const tick = async () => { for (let i = 0; i < 4; i++) { await w.tick(); t += 31 * 60e3; } };
    return { sent, events, asked, tick, dir };
  };

  const open = await run('open');
  await open.tick();
  const all = open.sent.map((x) => x[1]).join('\n');
  assert.match(all, /Time box reached/, 'control: the time box wakes an open session');
  assert.match(all, /lacks tried: and need:/, 'control: the status-format check pushes it');
  assert.match(all, /closing review/, 'control: the done-check pushes it');
  assert.ok(open.events.includes('time-box:open-blocked'));

  store.accept('acc-done', { by: 'manager-agent' });
  store.accept('acc-blocked', { by: 'manager-agent' });
  const acc = await run('acc');
  await acc.tick();
  assert.deepEqual(acc.sent, []);
  assert.deepEqual(acc.events, []);
  assert.deepEqual(acc.asked, [], 'the goal question is not asked either');
  const journal = existsSync(join(acc.dir, 'done-check.jsonl')) ? readFileSync(join(acc.dir, 'done-check.jsonl'), 'utf8') : '';
  assert.doesNotMatch(journal, /"verification"|"accepted"/, 'acceptance records no row as passed');

  store.reopen('acc-blocked', { by: 'manager-agent', why: 'one more task' });
  await acc.tick();
  assert.ok(acc.sent.length, 'reopened: checked again');
  assert.deepEqual([...new Set(acc.sent.map((x) => x[0]))], ['acc-blocked'], 'the other one stays quiet');
});

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => manager.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
async function stopOn(name, text, at) {
  tick(name, 'working', ['busy'], at); tick(name, 'done', pane(text), at + 1000); tick(name, 'done', pane(text), at + 2500);
  await wait(500);
}

test('manager: an accepted session raises no ask, no manager item and gets no auto answer; a reopened one does again', async () => {
  const OWNER_ASK = 'STATUS: needs-owner: the reviewer sign-in needs a credential, 1 = give it / 2 = leave';
  await stopOn('ctl', OWNER_ASK, 0);
  assert.deepEqual(asks, ['ctl'], 'control: an open session asks');

  store.accept('fin', { by: 'manager-agent' }); manager.quietAccepted('fin');
  await stopOn('fin', OWNER_ASK, 10_000);
  await stopOn('fin', 'STATUS: needs-manager: accept row 2 as partial?', 20_000);
  await stopOn('fin', 'I fixed the first file.\nShall I continue with the rest?', 30_000);
  assert.deepEqual(asks, ['ctl']);
  assert.deepEqual(items, []);
  assert.deepEqual(typed, []);
  assert.equal(manager.autoOf('fin'), null);
  assert.equal(manager.canType('fin'), false, 'no own-job wake either');
  await wait(300);
  assert.match(readFileSync(join(stateDir, 'stalls.jsonl'), 'utf8'), /"final_accepted_quiet".*"session":"fin"/);

  store.reopen('fin', { by: 'owner', why: 'new task' });
  await stopOn('fin', `${OWNER_ASK} (after the new task)`, 40_000);
  assert.deepEqual(asks, ['ctl', 'fin']);
});

test('Mac stop hook: no check answers the stop of an accepted session', async (t) => {
  const dir = tmp('ghosty-final-mac-'), token = 'tok-final-0123456789abcdef';   // leak-scan: allow (fake test token)
  writeFileSync(join(dir, 'clients.json'), JSON.stringify({ clients: [{ name: 'mac-a', sha256: hashToken(token), remote: true }] }));
  let accepted = false;
  const remote = createRemoteStops({ manager, dir, stateDir, blockedMode: () => 'live', finalAccepted: () => accepted, graceMs: 500, pollWaitMs: 200 });
  const server = http.createServer((req, res) => { remote.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const answerTo = async (n) => {
    const posted = await (await fetch(`${base}/stops`, { method: 'POST', headers, body: JSON.stringify({ machine: 'mac-test', project: 'demo', session_id: `sid-${n}-aaaaaaaa`, session_name: `m${n}`, text: BLOCKED }) })).json();
    return (await fetch(`${base}/stops/${posted.id}/answer?wait=2`, { headers })).json();
  };
  assert.match(String((await answerTo(1)).answer), /lacks tried: and need:/, 'control: an open session is answered');
  accepted = true;
  assert.equal((await answerTo(2)).answer, undefined);
});
