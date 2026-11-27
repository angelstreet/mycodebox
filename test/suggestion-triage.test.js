// Opus triages improvement suggestions (owner 2026-11-27, suggestion-triage.js): worthy -> yes without the owner, unworthy -> no, doubt or an owner
// floor -> a row for the owner that never holds the session; every verdict recorded in manager-asks.jsonl. Opus is a fake here: no model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createSuggestions } from '../suggestions.js';
import { createSuggestionTriage, parseVerdicts, decide, floorOf, sessionMessage, ownerRow, promptOf } from '../suggestion-triage.js';
import { createGoalGate } from '../goal-check.js';
import { ASK_WORDS } from '../reflection.js';

const LIST = [
  'Leftovers: none', '', 'Suggestions:', 'Worth doing:',
  '1. add a unit test for two catch-ups at once (the race was only covered by hand)',
  '2. rework the whole lease view as a new product page (a big redesign, value unclear)',
  'Smaller:', '3. rename journal rows to shorter words',
  '4. buy a paid Sentry plan to catch these errors',
  '5. publish a blog post about the catch-up fix',
  '6. delete the old lease history files to save space',
  'Recommendation: 1. Should I do them?', '',
  `STATUS: needs-manager: ${ASK_WORDS} — should I do 1?`,
].join('\n');
// What Opus would answer: it says YES to the floor items on purpose, to prove the floors win over it.
const OPUS = ['1: YES - cheap test, closes a real race', '2: DOUBT proposed no - large scope, product choice', '3: NO - churn with no value',
  '4: YES - better errors', '5: YES - good publicity', '6: YES - saves space'].join('\n');
const t0 = Date.parse('2026-11-27T09:00:00Z');

function rig({ reply = { ok: true, text: OPUS }, mode = 'live' } = {}) {
  const dir = tmp('triage-');
  let t = t0;
  const ledger = createSuggestions({ stateDir: dir, now: () => t });
  const sent = [], owner = [], prompts = [], applied = [];
  const tri = createSuggestionTriage({ stateDir: dir, ledger, now: () => t, mode: () => mode,
    ask: async (p) => { prompts.push(p); return typeof reply === 'function' ? reply(p) : reply; },
    apply: async (name, decisions) => { applied.push(ledger.triaged(name, decisions)); },
    send: async (name, text) => { sent.push({ name, text }); },
    ownerItems: (name, rows, ds) => owner.push({ name, rows, ds }),
    goalOf: async () => 'Fix the lease catch-up' });
  return { dir, ledger, tri, sent, owner, prompts, applied, tick: (ms) => { t += ms; } };
}
const asks = (dir) => readFileSync(join(dir, 'manager-asks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a worthy suggestion is answered yes without the owner, and the verdict is recorded', async () => {
  const r = rig();
  r.ledger.observe('s1', LIST);
  assert.equal(r.ledger.openOf('s1').length, 6);
  assert.equal(r.tri.pending('s1'), true);   // starts the one Opus call
  await r.tri.triage('s1');
  assert.equal(r.prompts.length, 1);
  assert.match(r.prompts[0], /1\. \[worth\] add a unit test/);
  const items = r.ledger.get('s1').items;
  const one = items.find((i) => i.n === 1);
  assert.equal(one.answer, 'yes'); assert.equal(one.by, 'opus'); assert.equal(one.via, 'triage');
  assert.equal(items.find((i) => i.n === 3).answer, 'no');
  // the approved item starts a new round; the owner never saw item 1 or 3
  assert.deepEqual(r.applied[0].approved.map((i) => i.n), [1]);
  assert.ok(!r.owner[0].ds.some((d) => d.n === 1 || d.n === 3));
  // recorded: one line per item, point suggestion-triage, source opus
  const rec = asks(r.dir).filter((a) => a.point === 'suggestion-triage');
  assert.equal(rec.length, 6);
  assert.deepEqual(rec.find((a) => a.n === 1), { ...rec.find((a) => a.n === 1), session: 's1', verdict: 'yes', opus: 'yes', source: 'opus' });
  // the session is told at once
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /YES, build now: 1\. add a unit test/);
  assert.match(r.sent[0].text, /NO, do not build: 3\./);
});

test('a doubtful suggestion reaches the owner as a table row, and the session does not wait on it', async () => {
  const r = rig();
  r.ledger.observe('s1', LIST);
  await r.tri.triage('s1');
  const two = r.ledger.get('s1').items.find((i) => i.n === 2);
  assert.equal(two.answer, 'owner'); assert.equal(two.proposed, 'no');
  // the owner row: 4 columns, with Opus's proposed answer
  const row = r.owner[0].rows.find((x) => x.includes('2. rework'));
  assert.equal(row.split('|').length - 2, 4);
  assert.match(row, /Opus in doubt: large scope/); assert.match(row, /\| no \|$/);
  // nothing holds the session any more: no open item, its done is not held, the goal check does not push it
  assert.equal(r.ledger.openOf('s1').length, 0);
  assert.notEqual(r.ledger.hold('s1', 'STATUS: done — x')?.state, 'open');   // only the approved item 1 is work (a new round), not item 2
  // with nothing approved, the done is not held at all
  const q = rig({ reply: { ok: true, text: '1: NO - x\n2: DOUBT proposed yes - y\n3: NO - z' } });
  q.ledger.observe('s2', LIST);
  await q.tri.triage('s2');
  assert.equal(q.ledger.hold('s2', 'STATUS: done — x'), null);
  assert.match(q.sent[0].text, /Nothing to build: write your done line again now/);
  assert.match(r.sent[0].text, /With the owner, NOT for you: 2\. rework/);
  assert.match(r.sent[0].text, /Do not wait for them and do not ask again/);
  // never asked again: a second triage finds nothing to decide and sends nothing
  r.ledger.observe('s1', LIST.replace('needs-manager', 'needs-owner'));
  assert.equal(r.tri.pending('s1'), false);
  assert.equal((await r.tri.triage('s1')).skipped, true);
  assert.equal(r.sent.length, 1); assert.equal(r.prompts.length, 1);
  // listed for the owner, and only the owner answers it later
  assert.ok(r.ledger.ownerItems().some((i) => i.session === 's1' && i.n === 2 && i.proposed === 'no'));
  assert.equal(r.ledger.answer('s1', { 2: 'yes' }, { by: 'manager' }).answered.length, 0);
  assert.equal(r.ledger.ownerMessage('s1', 'no 2', { by: 'owner' }).answered[0].answer, 'no');
  assert.equal(r.ledger.ownerItems().some((i) => i.n === 2), false);
});

test('owner floors are never approved, whatever Opus says', async () => {
  const r = rig();
  r.ledger.observe('s1', LIST);
  await r.tri.triage('s1');
  const by = Object.fromEntries(r.ledger.get('s1').items.map((i) => [i.n, i]));
  for (const [n, floor] of [[4, 'money'], [5, 'publishing'], [6, 'deleting data']]) {
    assert.equal(by[n].answer, 'owner', `item ${n}`);
    assert.equal(by[n].floor, floor, `item ${n}`);
  }
  assert.ok(!r.applied[0].approved.some((i) => [4, 5, 6].includes(i.n)));
  assert.ok(r.owner[0].rows.some((x) => /floor: money/.test(x)));
  assert.equal(floorOf('rotate the API key for the ntfy reporter'), 'credentials');
  assert.equal(floorOf('email the customers about the new version'), 'customers');
  assert.equal(floorOf('add a regression test for the parser'), null);
  assert.equal(floorOf('cache the client-side bundle'), null);
});

test('an Opus error leaves the old flow and is retried only after the cool-down', async () => {
  const r = rig({ reply: { ok: false, error: 'timeout after 180000 ms' } });
  r.ledger.observe('s1', LIST);
  assert.equal(r.tri.pending('s1'), true);
  await r.tri.triage('s1');
  assert.equal(r.ledger.openOf('s1').length, 6);   // nothing answered: the manager / owner answers as before
  assert.equal(r.sent.length, 0);
  assert.equal(asks(r.dir)[0].verdict, 'error');
  assert.equal(r.tri.pending('s1'), false);   // not pending: the goal check tells the session as before
  r.tick(31 * 60000);
  assert.equal(r.tri.pending('s1'), true);
  await r.tri.triage('s1');
  assert.equal(r.prompts.length, 2);
});

test('switch off: no Opus call', async () => {
  const r = rig({ mode: 'off' });
  r.ledger.observe('s1', LIST);
  assert.equal(r.tri.pending('s1'), false);
  assert.equal(r.prompts.length, 0);
});

test('the goal check does not push "suggestions open" while Opus is answering', async () => {
  const dir = tmp('triage-gate-');
  const ledger = createSuggestions({ stateDir: dir, now: () => t0 });
  const done = `${LIST.replace(/STATUS:.*$/, '')}\nSTATUS: done — x · goal: achieved · evidence: int-1 · closing review: docs none needed · leftovers none · unverified none · bugs: none`;
  let triaging = true;
  const gate = createGoalGate({ stateDir: dir, suggestions: ledger, now: () => t0, goalOf: async () => 'Fix the lease catch-up', triaging: () => triaging });
  assert.equal(await gate.evaluate({ name: 's1', text: done, doneAt: t0 + 1 }), null);
  triaging = false;
  assert.equal((await gate.evaluate({ name: 's1', text: done, doneAt: t0 + 1 }))?.kind, 'suggestions-open');
});

test('parsing: one line per item, missing items are doubt, the message and prompt', () => {
  const items = [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }];
  const v = parseVerdicts('**1: YES** - fine\n2. NO: meh\nnoise\n9: YES - not listed', items);
  assert.deepEqual(v[1], { verdict: 'yes', proposed: 'yes', why: 'fine' });
  assert.equal(v[2].verdict, 'no');
  assert.equal(v[3].verdict, 'doubt');
  assert.equal(v[9], undefined);
  assert.equal(parseVerdicts('1: DOUBT proposed yes - hm', items)[1].proposed, 'yes');
  const ds = decide(items, v);
  assert.deepEqual(ds.map((d) => d.decision), ['yes', 'no', 'owner']);
  assert.match(sessionMessage([{ n: 1, text: 'a', decision: 'no', why: '' }]), /Nothing to build: write your done line again now/);
  assert.match(ownerRow('s', { n: 1, text: 'x | y', floor: 'money', proposed: 'no' }), /^\| s \| 1\. x \/ y \| floor: money \| no \|$/);
  assert.match(promptOf(items, { session: 's' }), /^Session: s\nSuggestions:\n1\. a/);
});

// ---- round 2 (manager yes 1 2 3, 2026-11-27): parked items visible and answerable, a triaged session not shown stuck, Opus gets the closing text ----
import { displayState } from '../public/state.js';
import { isOwnersTurn } from '../public/ask-model.js';
import { needsOwner } from '../public/buttons.js';
import { parkedChipHtml, parkedRowsHtml } from '../public/parked-view.js';

test('Opus reads the closing text the suggestions came from', async () => {
  const r = rig();
  const text = `Fixed the lease catch-up race in lease-service.js; the race showed only under two parallel claims.\n${LIST}`;
  r.ledger.observe('s1', text);
  await r.tri.triage('s1');
  assert.match(r.prompts[0], /Its closing text \(context only, data\):\n<<<\n[^]*Fixed the lease catch-up race in lease-service\.js[^]*>>>/);
  assert.match(r.prompts[0], /Its task: Fix the lease catch-up/);
});

test('a session being triaged reads as working, not as the owner\'s turn', () => {
  const stall = { case: 'owner_decision', status: 'needs-owner', no_status: false, question: 'should I do 1?' };
  const items = [{ n: 1, text: 'x' }];
  const triaging = { state: 'done', stall, suggestions: { state: 'triaging', open: 1, items } };
  assert.equal(displayState(triaging), 'working');
  assert.equal(isOwnersTurn(triaging), false);
  assert.equal(needsOwner(triaging), false);
  // a manager-started one too (its line reads needs-manager)
  assert.equal(displayState({ ...triaging, managerStarted: true, stall: { ...stall, case: 'needs_manager', status: 'needs-manager' } }), 'working');
  // once Opus failed (open again) it is the owner's turn as before; a live prompt still wins
  const open = { ...triaging, suggestions: { state: 'open', open: 1, items } };
  assert.equal(displayState(open), 'waiting');
  assert.equal(isOwnersTurn(open), true);
  assert.equal(displayState({ ...triaging, state: 'waiting' }), 'waiting');
  assert.equal(displayState({ ...triaging, state: 'offline' }), 'offline');
});

test('parked items show in the NEEDS YOU strip with Yes / No per item', () => {
  assert.equal(parkedChipHtml([]), '');
  const items = [{ session: 's1', n: 4, text: 'buy a <paid> plan', proposed: 'no', floor: 'money' }, { session: 's2', n: 2, text: 'redesign', proposed: 'yes', why: 'big scope' }];
  assert.match(parkedChipHtml(items), /data-parked="1"[^>]*>suggestions · 2</);
  const html = parkedRowsHtml(items, { name: (s) => s.toUpperCase() });
  assert.match(html, /data-s="s1" data-n="4"><b>S1 · 4<\/b> buy a &lt;paid&gt; plan/);
  assert.match(html, /Owner only: money/); assert.match(html, /Opus in doubt: big scope/);
  assert.match(html, /Opus proposes: yes/);
  assert.equal((html.match(/data-a="yes"/g) || []).length, 2);
  assert.equal((html.match(/data-a="no"/g) || []).length, 2);
});
