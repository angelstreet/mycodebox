import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerStopTriage, ownerKeeps, labPublish, parseVerdict, FILE_NAME } from '../owner-stop-triage.js';
import { isOwnersTurn } from '../public/ask-model.js';

const TECH = 'should I retry the flaky edge with a 2 s wait or raise its timeout to 20 s? I recommend the wait.';
const PUBLISH = 'reply with stb-orchtnet to confirm publishing the node settings_profile_menu_language and the edge a8a95b81 to production, with the 10 changes above excluded.';
const tick = () => new Promise((r) => setImmediate(r));

function harness({ reply = { ok: true, text: 'MANAGER - a retry choice with a recommendation' }, second, mode = 'live', timeoutMs = 240000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-stop-'));
  const calls = { ask: 0, second: 0, manager: [], decided: [] };
  const t = createOwnerStopTriage({ stateDir: dir, mode: () => mode, timeoutMs,
    askSecond: second === undefined ? null : async () => { calls.second++; return typeof second === 'function' ? second() : second; },
    ask: async () => { calls.ask++; return typeof reply === 'function' ? reply() : reply; },
    toManager: (e) => calls.manager.push(e), decided: (e) => calls.decided.push(e), log: { error() {} } });
  const lines = () => (existsSync(join(dir, FILE_NAME)) ? readFileSync(join(dir, FILE_NAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { t, calls, lines, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a technical stop goes to the manager: the owner alert is dropped, Decided for you gets the question, then the answer', async () => {
  const h = harness();
  try {
    h.t.check('s1', { question: TECH });
    let resumed = 0;
    assert.equal(h.t.takeAlert('s1', () => resumed++), true);        // held while Opus answers
    assert.equal(h.t.stateOf('s1'), 'pending');
    await tick(); await tick();
    assert.equal(h.t.stateOf('s1'), 'manager');
    assert.equal(resumed, 0);                                         // the owner never hears of it
    assert.equal(h.t.takeAlert('s1', () => resumed++), true);
    assert.equal(h.calls.manager.length, 1);
    assert.equal(h.calls.manager[0].question, TECH);
    assert.deepEqual(h.calls.decided.map((d) => [d.kind, d.question]), [['routed', TECH]]);
    assert.equal(h.t.managerAnswered('s1', 'use the 2 s wait'), true);
    assert.equal(h.t.managerAnswered('s1', 'again'), false);          // once
    assert.equal(h.calls.decided[1].answer, 'use the 2 s wait');
    const recs = h.lines();
    assert.deepEqual(recs.map((r) => r.verdict), ['manager', 'manager-answered']);
    assert.equal(recs[0].question, TECH);                             // the question text is kept for the counter
    assert.equal(recs[0].source, 'opus');
    h.t.check('s1', { question: TECH });
    assert.equal(h.calls.ask, 1);                                     // the same question is checked once
  } finally { h.cleanup(); }
});

test('floor and owner-reserved approvals reach the owner without asking Opus (a tool\'s person-only confirm included)', async () => {
  const h = harness();
  try {
    for (const [name, q] of [['conf', 'reply with yes-go to confirm the run on stb3'], ['money', 'should I buy the $20 plan?'],
      ['del', 'can I delete the old recordings on vpt-pi1?'], ['plug', 'please replug the S7 cable'], ['names', 'approve the rename of the scripts to the new naming convention?'],
      ['userok', 'the backend needs user_ok for this step']]) {
      h.t.check(name, { question: q });
      assert.equal(h.t.takeAlert(name, () => {}), false, name);
      assert.equal(h.t.stateOf(name), null, name);
    }
    assert.equal(h.calls.ask, 0);
    assert.equal(h.calls.manager.length, 0);
    const recs = h.lines();
    assert.equal(recs.length, 6);
    assert.ok(recs.every((r) => r.verdict === 'owner' && ['floor', 'reserved'].includes(r.source)));
    assert.equal(recs.find((r) => r.session === 'conf').what, 'human confirmation');
    assert.equal(ownerKeeps(TECH), null);
  } finally { h.cleanup(); }
});

test('it fails toward the owner: OWNER, DOUBT, an error, a throw, an unreadable reply, a timeout', async () => {
  const replies = { owner: { ok: true, text: 'OWNER - product direction' }, doubt: { ok: true, text: 'DOUBT - unclear scope' }, err: { ok: false, error: 'exit 1: limit' },
    throws: () => { throw new Error('spawn ENOENT'); }, garbage: { ok: true, text: 'MANAGER - fine\nOWNER - or not' }, empty: { ok: true, text: 'I think the manager could' } };
  for (const [k, reply] of Object.entries(replies)) {
    const h = harness({ reply });
    try {
      h.t.check('s', { question: TECH });
      let resumed = 0;
      assert.equal(h.t.takeAlert('s', () => resumed++), true, k);
      await tick(); await tick();
      assert.equal(resumed, 1, `${k}: the held alert reaches the owner`);
      assert.equal(h.t.takeAlert('s', () => {}), false, k);
      assert.equal(h.calls.manager.length, 0, k);
      assert.equal(h.lines()[0].verdict, 'owner', k);
    } finally { h.cleanup(); }
  }
  const h = harness({ reply: () => new Promise(() => {}), timeoutMs: 20 });   // Opus never answers
  try {
    h.t.check('s', { question: TECH });
    let resumed = 0;
    h.t.takeAlert('s', () => resumed++);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(resumed, 1);
    assert.equal(h.lines()[0].source, 'timeout');
  } finally { h.cleanup(); }
});

test('switch off: the old flow, nothing asked, nothing held, nothing recorded', async () => {
  const h = harness({ mode: 'off' });
  try {
    h.t.check('s', { question: TECH });
    assert.equal(h.t.takeAlert('s', () => {}), false);
    await tick();
    assert.equal(h.calls.ask, 0);
    assert.deepEqual(h.lines(), []);
  } finally { h.cleanup(); }
});

test('a new turn drops the check: its held alert is not sent later', async () => {
  let release;
  const h = harness({ reply: () => new Promise((r) => { release = r; }) });
  try {
    h.t.check('s', { question: TECH });
    let resumed = 0;
    h.t.takeAlert('s', () => resumed++);
    await tick();                                                     // Opus is asked
    h.t.clear('s');
    release({ ok: true, text: 'OWNER - x' });
    await tick(); await tick();
    assert.equal(resumed, 0);
    assert.equal(h.t.takeAlert('s', () => {}), false);
  } finally { h.cleanup(); }
});

test('parseVerdict and the NEEDS YOU predicate', () => {
  assert.deepEqual(parseVerdict('MANAGER - retry choice'), { verdict: 'manager', opus: 'manager', why: 'retry choice' });
  assert.equal(parseVerdict('**DOUBT** - x').verdict, 'owner');
  assert.equal(parseVerdict('').opus, 'unparsed');
  const st = { name: 's', state: 'done', stall: { status: 'needs-owner', case: 'owner_decision', question: TECH } };
  assert.equal(isOwnersTurn(st), true);
  assert.equal(isOwnersTurn({ ...st, ownerStop: 'pending' }), false);
  assert.equal(isOwnersTurn({ ...st, ownerStop: 'manager' }), false);
});

test('Opus hesitates: Fable decides; Fable MANAGER -> the manager, anything else from Fable -> the owner', async () => {
  const doubt = { ok: true, text: 'DOUBT - could be product scope' };
  const cases = [['manager', { ok: true, text: 'MANAGER - a test-step choice' }, 'manager', 'fable'], ['owner', { ok: true, text: 'OWNER - product scope' }, 'owner', 'fable'],
    ['doubt', { ok: true, text: 'DOUBT - unsure' }, 'owner', 'fable'], ['error', { ok: false, error: 'limit' }, 'owner', 'error'], ['unparsed', { ok: true, text: 'hmm' }, 'owner', 'unparsed']];
  for (const [k, second, verdict, source] of cases) {
    const h = harness({ reply: doubt, second });
    try {
      h.t.check('s', { question: TECH });
      let resumed = 0;
      h.t.takeAlert('s', () => resumed++);
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(h.calls.second, 1, k);
      const r = h.lines()[0];
      assert.deepEqual([r.verdict, r.source, r.opus], [verdict, source, 'doubt'], k);
      assert.equal(resumed, verdict === 'owner' ? 1 : 0, k);
      assert.equal(h.calls.manager.length, verdict === 'manager' ? 1 : 0, k);
    } finally { h.cleanup(); }
  }
  for (const reply of [{ ok: true, text: 'OWNER - product direction' }, { ok: true, text: 'MANAGER - retry' }]) {   // Fable only on a DOUBT
    const h = harness({ reply, second: { ok: true, text: 'MANAGER - x' } });
    try { h.t.check('s', { question: TECH }); for (let i = 0; i < 5; i++) await tick(); assert.equal(h.calls.second, 0); } finally { h.cleanup(); }
  }
});

test('a dev -> prod userinterface publish goes to the manager with no model call, its confirm phrase included (owner 2026-11-28, Q310)', async () => {
  const q310 = 'Publish the 2 menu-language items of stb-orchtnet to production? The server only accepts this confirmation from a person.';
  const h = harness();
  try {
    for (const [name, q] of [['ui-audit', PUBLISH], ['q310', q310], ['plain', 'publish the dev userinterface web-rougetel to prod with the 3 edges that passed?']]) {
      h.t.check(name, { question: q });
      assert.equal(h.t.stateOf(name), 'manager', name);
      assert.equal(h.t.takeAlert(name, () => { throw new Error('the owner must not hear of it'); }), true, name);
    }
    assert.equal(h.calls.ask, 0);
    assert.deepEqual(h.calls.manager.map((m) => m.source), ['lab-publish', 'lab-publish', 'lab-publish']);
    assert.equal(h.calls.decided[0].question, PUBLISH);
    assert.ok(h.lines().every((r) => r.verdict === 'manager' && r.source === 'lab-publish'));
  } finally { h.cleanup(); }
  // other publishing, or a publish that also touches another floor, stays the owner's
  for (const q of ['publish the video to YouTube?', 'publish the package to npm?', 'publish the new app version to production?',
    'publish the edges to production and delete the old recordings on vpt-pi1?', 'publish the nodes to production and tell the customer?',
    'reply with yes-go to confirm the run on stb3']) assert.equal(labPublish(q), null, q);
  assert.ok(labPublish(PUBLISH));
});
