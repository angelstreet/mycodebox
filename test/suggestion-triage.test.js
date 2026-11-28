// Opus triages improvement suggestions (owner 2026-11-27, suggestion-triage.js): worthy -> yes without the owner, unworthy -> no, doubt or an owner
// floor -> a row for the owner that never holds the session; every verdict recorded in manager-asks.jsonl. Opus is a fake here: no model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
const OPUS = ['1: YES - cheap test, closes a real race', '2: DOUBT proposed yes - large scope, product choice', '3: NO - churn with no value',
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
  assert.equal(two.answer, 'owner'); assert.equal(two.proposed, 'yes');
  // the owner row: 4 columns, with Opus's proposed answer
  const row = r.owner[0].rows.find((x) => x.includes('2. rework'));
  assert.equal(row.split('|').length - 2, 4);
  assert.match(row, /Opus in doubt: large scope/); assert.match(row, /\| yes \|$/);
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
  assert.ok(r.ledger.ownerItems().some((i) => i.session === 's1' && i.n === 2 && i.proposed === 'yes'));
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

test('the claude binary is found outside the service PATH (spawn claude ENOENT, 2026-11-27)', async () => {
  const { claudeBin, claudeOpus } = await import('../suggestion-triage.js');
  assert.equal(claudeBin({ env: { CLAUDE_BIN: '/x/claude' }, home: '/h', exists: () => true }), '/x/claude');
  assert.equal(claudeBin({ env: {}, home: '/h', exists: (p) => p === '/h/.local/bin/claude' }), '/h/.local/bin/claude');
  assert.equal(claudeBin({ env: {}, home: '/h', exists: () => false }), 'claude');
  // a failing claude: its own words are in the error (the limit message is printed on stdout)
  const dir = tmp('triage-bin-'), bin = join(dir, 'claude');
  (await import('node:fs')).writeFileSync(bin, '#!/bin/sh\necho "You have hit your weekly limit"\nexit 1\n', { mode: 0o755 });
  const r = await claudeOpus('x', { bin, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10000 });
  assert.deepEqual(r, { ok: false, error: 'exit 1: You have hit your weekly limit' });
});

test('a list repeated with notes is the same items, so "yes 1 2 3, no 4" reads one way (2026-11-27)', () => {
  const dir = tmp('triage-dup-');
  const ledger = createSuggestions({ stateDir: dir, now: () => t0 });
  const first = ['Suggestions:', 'Worth doing:',
    '1. Add a dashboard view for items parked with the owner. Today they appear only as a manager event.',
    '2. Show a "triaging" state on the dashboard while the Opus call runs (up to about 3 minutes).',
    'Smaller:', '3. Send Opus the session\'s closing text around each suggestion, not just the line.',
    '4. Move the claude -p --model opus call into one shared helper. Two files build it.', '',
    `STATUS: needs-manager: ${ASK_WORDS} — should I do 1 2?`].join('\n');
  ledger.observe('s1', first, { at: t0 + 1 });
  const again = ['Suggestions:',
    '1. Add a dashboard view for items parked with the owner — built and merged (int-1a2b3c).',
    '2. Show a "triaging" state on the dashboard while the Opus call runs — built and merged (int-1a2b3c).',
    '3. Send Opus the session\'s closing text around each suggestion — built and merged (int-1a2b3c).',
    '4. Move the claude -p --model opus call into one shared helper — not built (your answer was no).', '',
    `STATUS: needs-manager: ${ASK_WORDS} — should I do 1 2 3?`].join('\n');
  ledger.observe('s1', again, { at: t0 + 2 });
  assert.equal(ledger.get('s1').items.length, 4);
  // the restated "built and merged" items are closed by the session's own report; only 4 ("not built") is open
  assert.deepEqual(ledger.get('s1').items.map((i) => `${i.n}:${i.answer || 'open'}`), ['1:built', '2:built', '3:built', '4:open']);
  const r = ledger.ownerMessage('s1', 'yes 1 2 3, no 4', { by: 'manager', via: 'send' });
  assert.equal(r.numbering, undefined);
  assert.deepEqual(r.answered.map((i) => `${i.n}:${i.answer}`), ['4:no']);
  // two different items that share a short opening are still two items
  ledger.observe('s2', ['Suggestions:', '1. Add a test. For the parser', '2. Add a test. For the lexer', '', `STATUS: needs-manager: ${ASK_WORDS} — should I do 1?`].join('\n'), { at: t0 + 3 });
  assert.equal(ledger.get('s2').items.length, 2);
});

// ---- coc-daily-20261127, 2026-11-27: the first live triage sent 6 rows to the owner and only item 1 was real. The turns below are the session's own
// lines (ledger items 1-5 for its first list, then the stop excerpts of 08:49, 08:53, 09:04 and 09:08 UTC; the top of the 08:53 / 09:08 lists was cut
// off in the excerpt and is restated from the first list). ----
const COC = {
  first: ['Suggestions:', 'Worth doing:',
    "1. The fleet's model choice during the free plan's quota window — the fleet plays --model_choice flash, and when the quota is out (a 5 h window) the runs now stop at step 0 with the reason named: the village does not play in that window at all. Putting the fleet back on auto (Haiku on the owner's Anthropic key) spends money.",
    "2. The Town Hall panel, the largest number left in the owner's rule — 31 of the 100 runs of the window never read the panel and 593 steps name it (the read step is 643 of the 3 132 steps), while 42 runs sat at the cap with a free builder.",
    '3. The resource checker judges the crashed runs as played runs — the 6 crashes of the last 24 h had steps, so coc_resource_check.py measured the owner\'s rule on them and the lane counted 3 of them as played turns.',
    'Smaller:',
    '4. The words "unlimited free plan" (shared/src/lib/ai/usages.py, scripts/agent/flash_run_log.py, TASK-164) describe the price (0) but the plan has a 5 h quota window — one clause would stop the next reader from reading "unlimited" as "never throttled".',
    '5. A CoC host with no data directory refuses every run with the raw OS error ("Permission denied: \'/var/lib/vpt\'"); a check that names it ("this host has no CoC data directory") would say what to do — that is what cost the A57 its 09:27 run and its trace.',
    'Recommendation: 1 2 3. Should I do them?', '', 'STATUS: needs-owner: improvement suggestions above, nothing built — should I do 1 2 3?'].join('\n'),
  t0849: ['    Suggestions: none left except 1 — the fleet\'s model choice during the free plan\'s quota window (auto → Haiku on the owner\'s Anthropic key), which spends',
    '    money, is held by the owner and not filed, and is recorded in TASK-209 as an open owner item.',
    '    STATUS: done — the 24 h measured (83 runs, 6 api_error crashes) · closing review: docs TASK-209 · leftovers none · unverified none · bugs: fixed the api_error crash'].join('\n'),
  t0853: ['    Suggestions:',
    "    1. The fleet's model choice during the free plan's quota window — auto → Haiku on the owner's Anthropic key, an owner",
    '       decision** (held as an open owner item in TASK-209, not filed).',
    "    2. The Town Hall panel, the largest number left in the owner's rule — 42 runs sat at the cap with a free builder, 31 of 100 runs never read the panel and",
    '       593 steps name it. Built and merged on the manager\'s order (int-1a21c2ed95c7fdbb0): the th_zoom meta line now says whether the pinch that finds the',
    '       panel fires on each phone, so the next session can change the read step with the number behind it. Nothing left to build here.',
    '    3. The resource checker judged the crashed runs as played runs — the 6 api_error runs of the 24 h sat in the statistics of the owner\'s rule. Built and',
    '       merged (int-1a21c2ed95c7fdbb0): the report now carries crashed, crashed_by_stop and its own line ("6 of the 91 run(s) that played ended in a crash").',
    '    4. The words "unlimited free plan" (shared/src/lib/ai/usages.py, scripts/agent/flash_run_log.py, TASK-164) described the price ($0) and were read as',
    '       "never throttled". **Built and merged**: the price is 0 **and** the quota window exists, in all three places.',
    '    5. A CoC host with no data directory refused every run with the bare OS error ("Permission denied: \'/var/lib/vpt\'") and left no trace (the A57\'s run of',
    '       09:27 on 2026-11-26). Built and merged: the refusal now names the directory and what to do with it.',
    '    6. The same item as 1 (the fleet\'s model choice during the quota window) — listed separately in the reflection because it was the line "none left except',
    '       1". Not built, held by the owner, not filed.',
    '    Recommendation: 1 (and 6 is the same item) — it is the only one left. Should I do 1?',
    '    STATUS: needs-owner: improvement suggestions above, nothing built — should I do 1?'].join('\n'),
  t0904: ['    Suggestions: none left except 1 (held by the owner) — the fleet\'s model choice during the free plan\'s quota window (auto → Haiku on the owner\'s Anthropic',
    '    key); it spends money, the owner decides, it is already an open owner item in TASK-209 and it is not filed.',
    '    STATUS: done — the 24 h measured · closing review: docs TASK-209 · leftovers none · unverified none · bugs: fixed the api_error crash'].join('\n'),
  t0908: ['    Suggestions:',
    "    1. The fleet's model choice during the free plan's quota window — auto → Haiku on the owner's Anthropic key. Not built, held by the owner.",
    "    2. The Town Hall panel, the largest number left in the owner's rule. Built and merged on the manager's order (int-1a21c2ed95c7fdbb0).",
    '    3. The resource checker judges the crashed runs as played runs — the 6 api_error runs of the 24 h sat in the statistics of the owner\'s rule. Built and',
    '       merged (int-1a21c2ed95c7fdbb0): the report carries crashed, crashed_by_stop and its own line ("6 of the 91 run(s) that played ended in a crash").',
    '    4. The words "unlimited free plan" (shared/src/lib/ai/usages.py, scripts/agent/flash_run_log.py, TASK-164) described the price ($0) and were read as',
    '       "never throttled". **Built and merged**: the price is 0 **and** the quota window exists, in all three places.',
    '    5. A CoC host with no data directory refuses every run with the raw OS error ("Permission denied: \'/var/lib/vpt\'") and leaves no trace (the A57\'s run of',
    '       09:27 on 2026-11-26). Built and merged: the refusal now names the directory and what to do with it.',
    '    6. "none left except 1" — the fleet\'s model choice during the free plan\'s quota window — the same item as 1, listed twice by me across the two lists. Not',
    '       built, held by the owner, not filed.',
    '    7. The resource checker judged the crashed runs as played runs — the same item as 3, in the wording of my second list. Built and merged.',
    '    8. A CoC host with no data directory refused every run with the raw OS error — the same item as 5, in the wording of my second list. Built and merged.',
    '    9. The Town Hall panel (the wording of my second list) — the same item as 2. Built and merged.',
    '    10. The quota-window wording (the wording of my second list) — the same item as 4. Built and merged.',
    '    Recommendation: 1 is the only one left to answer. Should I do 1?',
    '    STATUS: needs-owner: improvement suggestions above, nothing built — should I do 1?'].join('\n'),
};

test('coc-daily-20261127 transcript: only item 1 stays open and reaches the owner; references and built items never do', async () => {
  const r = rig({ reply: { ok: true, text: '1: DOUBT proposed yes - spends money on the owner\'s key\n2: YES - x\n3: YES - x\n4: YES - x\n5: YES - x' } });
  let t = t0;
  for (const turn of [COC.first, COC.t0849, COC.t0853, COC.t0904, COC.t0908]) r.ledger.observe('coc', turn, { at: (t += 60000) });
  const items = r.ledger.get('coc').items;
  assert.equal(items.length, 5, items.map((i) => `${i.n}. ${i.text.slice(0, 50)}`).join('\n'));   // no new item from "none left except 1", "the same item as N" or a reworded built line
  assert.deepEqual(items.map((i) => `${i.n}:${i.answer || 'open'}`), ['1:open', '2:built', '3:built', '4:built', '5:built']);
  await r.tri.triage('coc');
  assert.equal(r.prompts.length, 1);
  assert.doesNotMatch(r.prompts[0], /^\d+\. .*(?:none left except|same item as)/m);
  // item 1 reaches the owner on Opus's doubt (its "spends money" lies past the 300 characters the ledger keeps, as live)
  assert.deepEqual(r.ledger.ownerItems().map((i) => [i.session, i.n, i.proposed]), [['coc', 1, 'yes']]);
  assert.equal(r.owner[0].rows.length, 1);
});

test('an item the session calls built is never the owner\'s, and the floor reads only the item\'s own words', () => {
  // the triage's last guard: a built or reference item that reached it anyway is a "no", whatever Opus or a floor word says
  const ds = decide([{ n: 1, text: 'Buy a paid Sentry plan — built and merged (int-1)' }, { n: 2, text: 'none left except 1 — spends money on the owner\'s key' }, { n: 3, text: 'buy a paid Sentry plan' }],
    { 1: { verdict: 'doubt', proposed: 'yes', why: '' }, 2: { verdict: 'doubt', proposed: 'no', why: '' }, 3: { verdict: 'yes', proposed: 'yes', why: '' } });
  assert.deepEqual(ds.map((d) => `${d.n}:${d.decision}`), ['1:no', '2:no', '3:owner']);
  // the coc-daily items 4 and 5 talk about a price and a cost, they spend nothing
  assert.equal(floorOf(COC.first.split('\n')[6]), null);
  assert.equal(floorOf(COC.first.split('\n')[7]), null);
  assert.equal(floorOf(COC.first.split('\n')[2]), 'money');
  // context never makes a floor: the triage reads floors from the item text only, the closing text goes to Opus as data
  const items = [{ n: 1, text: 'add a regression test for the parser' }];
  assert.equal(decide(items, { 1: { verdict: 'yes', proposed: 'yes', why: '' } })[0].decision, 'yes');
});

test('the live coc-daily ledger of 2026-11-27 is cleaned at start: built / duplicate items closed, the proposed-no item 1 hidden but kept', () => {
  const dir = tmp('triage-reconcile-');
  const rec = JSON.parse(readFileSync(new URL('./fixtures/coc-daily-20261127-suggestions.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, 'suggestions.json'), JSON.stringify({ since: 1, s: { 'coc-daily-20261127': rec } }));
  assert.deepEqual(rec.items.filter((i) => i.answer === 'owner').map((i) => i.n), [1, 4, 5, 6, 9, 10]);   // as the first live triage left it
  const ledger = createSuggestions({ stateDir: dir, now: () => t0, log: { log() {}, error() {} } });
  assert.deepEqual(ledger.ownerItems().map((i) => i.n), []);   // item 1 is Opus-proposed no: hidden (owner 2026-11-27)
  assert.deepEqual(ledger.chipItems(), []);
  const kept = ledger.get('coc-daily-20261127').items.find((i) => i.n === 1);
  assert.equal(kept.answer, 'no'); assert.equal(kept.via, 'hide-no'); assert.equal(kept.proposed, 'no'); assert.match(kept.why, /spends money/);
  const by = Object.fromEntries(ledger.get('coc-daily-20261127').items.map((i) => [i.n, i.answer]));
  assert.deepEqual([by[4], by[5], by[6], by[9], by[10]], ['built', 'built', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal(ledger.reconcile(), 0, 'idempotent');
});

// ---- owner 2026-11-27: "in suggestions i dont want to see the ones Opus said no" ----
test('an item Opus proposes no is answered no and hidden, only recorded; a proposed-yes or unclear one shows', async () => {
  const r = rig({ reply: { ok: true, text: '1: YES - ok\n2: DOUBT proposed no - not worth it\n3: DOUBT proposed yes - maybe\n4: DOUBT proposed no - skip, money anyway\n5: DOUBT - cannot tell\n6: NO - x' } });
  r.ledger.observe('s1', LIST);
  await r.tri.triage('s1');
  const by = Object.fromEntries(r.ledger.get('s1').items.map((i) => [i.n, i]));
  assert.equal(by[2].answer, 'no'); assert.equal(by[2].by, 'opus');   // told no like any no
  assert.equal(by[4].answer, 'no');   // a floor item Opus proposes no is a no too
  assert.equal(by[3].answer, 'owner'); assert.equal(by[3].proposed, 'yes');
  assert.equal(by[5].answer, 'owner');   // no stated proposal = no clear answer: the owner sees it
  assert.deepEqual(r.ledger.chipItems().map((i) => i.n).sort(), [3, 5]);
  assert.deepEqual(r.ledger.ownerItems().map((i) => i.n).sort(), [3, 5]);
  assert.deepEqual(r.owner[0].ds.map((d) => d.n).sort(), [3, 5]);
  assert.match(r.sent[0].text, /NO, do not build: 2\. rework/);
  assert.doesNotMatch(r.sent[0].text, /With the owner, NOT for you:[^.]*2\./);
  // recorded in manager-asks.jsonl
  const rec = asks(r.dir).find((a) => a.point === 'suggestion-triage' && a.n === 2);
  assert.equal(rec.verdict, 'no'); assert.equal(rec.opus, 'doubt'); assert.equal(rec.proposed, 'no'); assert.equal(rec.source, 'opus');
});

test('already parked proposed-no items disappear at start, the record stays, an unclear one and a dismissed one are untouched', () => {
  const dir = tmp('triage-hide-');
  const item = (n, extra) => ({ n, text: `item ${n}`, at: t0, ...extra });
  const park = (n, proposed, why) => item(n, { answer: 'owner', by: 'opus', via: 'triage', answeredAt: t0, proposed, why });
  writeFileSync(join(dir, 'suggestions.json'), JSON.stringify({ since: 1, s: { s1: { asked: { sig: 'x', at: t0 }, items: [park(1, 'no', 'large scope'), park(2, 'yes', 'worth a look'), park(3, 'no', 'Opus gave no verdict for this item'), item(4, { answer: 'no', by: 'owner', via: 'dashboard', answeredAt: t0 })] } } }));
  const ledger = createSuggestions({ stateDir: dir, now: () => t0, log: { log() {}, error() {} } });
  assert.equal(ledger.reconcile(), 0);   // already done when the ledger opened
  assert.deepEqual(ledger.ownerItems().map((i) => i.n), [2, 3]);
  const one = ledger.get('s1').items.find((i) => i.n === 1);
  assert.equal(one.answer, 'no'); assert.equal(one.via, 'hide-no'); assert.equal(one.why, 'large scope');
  assert.equal(ledger.get('s1').items.find((i) => i.n === 4).by, 'owner');
  assert.equal(ledger.reconcile(), 0, 'idempotent');
  assert.match(readFileSync(join(dir, 'suggestions.jsonl'), 'utf8'), /hide-no/);   // the actions log keeps the record
});

test('the triage record names the Claude account Opus answered on, also on an error (2026-11-28)', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const stateDir = mkdtempSync(join(tmpdir(), 'triage-acct-'));
  const items = [{ n: 1, text: 'Add a unit test for the parser' }];
  const mk = (r) => createSuggestionTriage({ stateDir, ledger: { openOf: () => items }, ask: async () => r, apply: async () => {}, send: async () => {} });
  await mk({ ok: false, error: "exit 1: You've hit your weekly limit", account: 'team1' }).triage('s1');
  await mk({ ok: true, text: '1: YES - cheap', account: 'team2' }).triage('s1');
  const recs = readFileSync(join(stateDir, 'manager-asks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((x) => [x.verdict, x.account]), [['error', 'team1'], ['yes', 'team2']]);
});

// 2026-11-28: "Show why a session is needs-manager on its dashboard card. The state frame drops `managerAsk`, ..." went to the owner
// as "owner floor ("drops")". The data floor is real data deletion, not a UI or journal sense of drop / remove.
test('floorOf: drop / remove / delete in a UI or journal sense is not the data floor; real data deletion still is', () => {
  for (const t of [
    'Show why a session is needs-manager on its dashboard card. The state frame drops `managerAsk`, so the card says needs-manager without the reason',
    'When the done check drops a finding because main changed meanwhile, also count it in /api/done-check',
    'The journal already records these drops',
    'remove the duplicate chip from the phone summary bar',
    'drop the hedge word list now that the strict none rule covers it',
    'delete the dead code path in stall.js',
  ]) assert.equal(floorOf(t), null, t);
  for (const [t, f] of [
    ['drop the users table after the migration', 'deleting data'],
    ['delete old recordings older than 30 days to free the disk', 'deleting data'],
    ['purge the manager-events history', 'deleting data'],
    ['wipe the backups on node1', 'deleting data'],
  ]) assert.equal(floorOf(t), f, t);
  for (const t of ['remove the stale sessions from the dashboard', 'drop the old branches on origin', 'rm -rf the old capture folder'])
    assert.match(floorOf(t) || '', /deleting data|owner floor/, t);
  for (const t of ['force-push main to fix history', 'kill the prod server', 'git reset --hard on main']) assert.match(floorOf(t) || '', /owner floor/, `the other hard floors still apply: ${t}`);
});
