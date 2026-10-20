import test from 'node:test';
import assert from 'node:assert/strict';
import { decidedItems, decidedSummary, revertOf, revertPlan, correctionDraft, failedCount } from '../decided.js';
import * as dv from '../public/decided-view.js';

const T0 = Date.parse('2026-10-14T10:00:00Z');
const iso = (min) => new Date(T0 + min * 60e3).toISOString();
const ans = (id, min, session, answer, extra = {}) => ({ type: 'answer', id, session, at: iso(min), answer, case: 'continue', source: 'rule', ...extra });
const stall = (id, session, extra = {}) => ({ type: 'stall', id, session, at: iso(-1), case: 'continue', question: 'Shall I continue?', excerpt: 'Shall I continue?', ...extra });
const recs = [
  stall('a1', 'api-worker'), ans('a1', 1, 'api-worker', { text: 'Yes, continue.' }),
  stall('a2', 'docs-bot'), ans('a2', 2, 'docs-bot', { key: '2' }, { case: 'menu_recommended' }),
  stall('a3', 'api-worker'), ans('a3', 3, 'api-worker', { text: 'Merge: yes ...' }, { source: 'manager_decision', merge_decision_id: 'merge-a3', decision_ids: ['merge-a3', 'push-a3', 'deploy-a3'], decided: ['merge', 'push', 'deploy'] }),
  ans('a4', 4, 'x', { text: 'Yes, continue.' }),   // cancelled below
  { type: 'answer_cancelled', id: 'a4', session: 'x', reason: 'pane changed', at: iso(4) },
  ans('a5', 5, 'ai-s', { text: 'Use the cache.' }, { source: 'ai' }),
  ans('a6', 6, 'info-s', { text: 'It is at /data/fake.' }, { source: 'manager_decision' }),
  { type: 'answer_cancelled', id: 'zz', session: 'x', reason: 'send failed: boom', at: iso(7) },
];
const journal = [
  { decision_id: 'merge-a3', kind: 'merge', chosen: 'merge', branch: 'feat', target: 'main', rationale: 'merges cleanly, tests green', evidence: ['merge-tree clean', 'tests: green'] },
  { decision_id: 'push-a3', kind: 'push', chosen: 'push', branch: 'main', dest: 'main', remote_sha: 'abcdef0123456789aa', rationale: 'lands the merge', evidence: ['1 commit'] },
  { decision_id: 'deploy-a3', kind: 'deploy', chosen: 'deploy', env: 'env-a', scope: 'full', ref: 'main', rollback: 'Rollback: request a deploy of main@abc to env-a (full).', rationale: 'tests green', evidence: ['env env-a'] },
  { decision_id: 'merge-nope', kind: 'merge', chosen: 'escalate', branch: 'q', target: 'main' },
];

test('decidedItems: newest first, cancelled excluded, each answer joined to its journal records', () => {
  const items = decidedItems({ recs, journal });
  const ids = items.map((i) => i.id);
  assert.deepEqual([...ids].sort(), ['a1', 'a2', 'a3:deploy', 'a3:merge', 'a3:push', 'a5', 'a6']);
  assert.deepEqual([ids[0], ids[1], ids.at(-2), ids.at(-1)], ['a6', 'a5', 'a2', 'a1']);   // newest first
  assert.ok(!items.some((i) => i.id === 'a4'));
  assert.equal(items[0].id, 'a6');
  for (const i of items) assert.deepEqual(Object.keys(i), ['id', 'at', 'session', 'kind', 'what', 'why', 'evidence', 'revert', 'url', 'productVisible']);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by.a1.kind, 'continue'); assert.equal(by.a1.what, "answered 'Yes, continue.' to api-worker");
  assert.equal(by.a2.kind, 'menu'); assert.equal(by.a2.what, 'answered option 2 to docs-bot');
  assert.equal(by.a5.kind, 'ai_reply'); assert.equal(by.a6.kind, 'info');
  assert.equal(by['a3:merge'].what, 'approved the merge of feat into main for api-worker');
  assert.equal(by['a3:merge'].why, 'merges cleanly, tests green'); assert.deepEqual(by['a3:merge'].evidence, ['merge-tree clean', 'tests: green']);
  assert.equal(by['a3:push'].what, 'approved pushing main to origin/main for api-worker');
  assert.equal(by['a3:deploy'].what, 'approved requesting the deploy of main to env-a (full) for api-worker');
  assert.equal(by.a1.url, '/?s=api-worker');
});

test('revert texts per kind', () => {
  const by = Object.fromEntries(decidedItems({ recs, journal }).map((i) => [i.id, i]));
  assert.deepEqual(by['a3:merge'].revert, { label: 'Revert merge', text: 'Revert the merge the manager approved: git revert -m 1 the merge commit of feat on main, run the tests, push.' });
  assert.deepEqual(by['a3:push'].revert, { label: 'Revert push', text: 'Revert the commits the manager approved pushing to main (abcdef012345..): git revert, run the tests, push.' });
  assert.deepEqual(by['a3:deploy'].revert, { label: 'Roll back', text: 'Rollback: request a deploy of main@abc to env-a (full).' });
  assert.deepEqual(by.a1.revert, { label: 'Correct', text: 'Correction to the answer the manager gave you ("Yes, continue."): ' });
  assert.equal(correctionDraft('x'), 'Correction to the answer the manager gave you ("x"): ');
  assert.equal(revertOf('deploy', {}, '').text, 'Rollback: request a deploy of the previous release.');
});

test('since / until bound the window', () => {
  assert.equal(decidedItems({ recs, journal, since: iso(2.5) }).length, 5);   // a3 (x3), a5, a6
  assert.equal(decidedItems({ recs, journal, since: iso(0), until: iso(1.5) }).length, 1);
  assert.deepEqual(decidedItems({ recs: [], journal: [] }), []);
});

test('decidedSummary: counts, kinds and a deterministic paragraph', () => {
  const items = decidedItems({ recs, journal });
  const s = decidedSummary(items, { hours: 1 });
  assert.equal(s.count, 7);
  assert.deepEqual(s.byKind, { merge: 1, push: 1, deploy: 1, menu: 1, continue: 1, ai_reply: 1, info: 1 });
  assert.equal(s.text, 'In the last hour the manager decided 7 things for you: 1 merge (api-worker), 1 push (api-worker), 1 deploy of env-a, 1 menu pick, 1 continue, 1 AI reply, 1 information answer. Nothing failed.');
  assert.ok(s.text.length <= 600);
  assert.equal(decidedSummary([], { hours: 1 }).text, 'Nothing was decided for you in the last hour.');
  assert.equal(decidedSummary([], { hours: 24 }).text, 'Nothing was decided for you in the last 24 hours.');
  assert.match(decidedSummary(items, { hours: 24, failed: 2 }).text, /2 replies could not be sent\.$/);
  assert.equal(failedCount(recs), 1);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...items.find((x) => x.kind === 'merge'), id: `m${i}`, session: `session-${i}` }));
  const big = decidedSummary(many, { hours: 24 });
  assert.match(big.text, /40 merges \(session-0, session-1, session-2 and 37 more\)/);
  assert.ok(big.text.length <= 600);
});

test('revertPlan: sends with by owner for merge / push / deploy when stopped; 409 otherwise; drafts for the rest', () => {
  const by = Object.fromEntries(decidedItems({ recs, journal }).map((i) => [i.id, i]));
  const ok = revertPlan(by['a3:merge'], { exists: true, state: 'done', draft: false });   // the server sends it as the real actor (default owner)
  assert.deepEqual(ok, { status: 200, send: by['a3:merge'].revert.text });
  assert.equal(revertPlan(by['a3:push'], { exists: true, state: 'done' }).send, by['a3:push'].revert.text);
  assert.equal(revertPlan(by['a3:push'], { exists: true, state: 'waiting' }).status, 409, 'a waiting prompt is not a finished turn');
  assert.match(revertPlan(by['a3:push'], { exists: true, state: 'done', menu: true }).error, /menu/);
  assert.deepEqual(revertPlan(by['a3:push'], { exists: true, state: 'done', reverted: true }), { status: 409, error: 'already reverted' });
  assert.deepEqual(revertPlan(by['a3:deploy'], { exists: false }), { status: 409, error: 'the session no longer exists' });
  assert.equal(revertPlan(by['a3:deploy'], { exists: true, state: 'working' }).status, 409);
  assert.equal(revertPlan(by['a3:deploy'], { exists: true, state: 'done', draft: true }).status, 409);
  assert.equal(revertPlan(null).status, 404);
  assert.deepEqual(revertPlan(by.a1, { exists: false }), { status: 200, draft: by.a1.revert.text, label: 'Correct' });   // a draft, not sent, whatever the session does
});

test('decided-view: grouped by hour, revert asks a second tap, correct is a draft', () => {
  const items = decidedItems({ recs, journal });
  const groups = dv.groupByHour(items);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), items.length);
  const html = dv.viewHtml({ items, summary: { text: 'In the last hour the manager decided 7 things.' } });
  assert.match(html, /decided 7 things/); assert.match(html, /data-dv-act="a3:merge"/); assert.match(html, /Revert merge/); assert.match(html, />Correct</);
  assert.match(dv.viewHtml({ items, summary: {} }, 'a3:merge'), /Tap again to confirm/);
  assert.ok(dv.SENDS.includes('deploy') && !dv.SENDS.includes('continue'));
  assert.match(dv.viewHtml({ items: [], summary: {} }), /Nothing was decided/);
  assert.match(dv.itemHtml({ ...items[0], what: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);   // escaped
});

test('R8-10: an answer that follows its id\'s last cancellation (held, then sent) stays; one that came before it is gone', () => {
  const r = [
    stall('h1', 's'), { type: 'answer_cancelled', id: 'h1', session: 's', reason: 'held: quota', at: iso(1) }, ans('h1', 2, 's', { text: 'Yes, continue.' }),
    ans('h2', 3, 's', { text: 'Yes, continue.' }), { type: 'answer_cancelled', id: 'h2', session: 's', reason: 'pane changed', at: iso(4) },
  ];
  assert.deepEqual(decidedItems({ recs: r, journal: [] }).map((i) => i.id), ['h1']);
});

test('round 9: productVisible, product-visible picks first and named in the summary', async () => {
  const { productVisible } = await import('../decided.js');
  assert.equal(productVisible({ kind: 'menu', pick: 'Use the dark theme for the page' }), true);
  assert.equal(productVisible({ kind: 'menu', pick: 'Rename the helper function' }), false);
  assert.equal(productVisible({ kind: 'merge', what: 'approved the merge of the button branch' }), false);
  const at = (m) => `2026-10-14T10:0${m}:00.000Z`;
  const recs = [
    { type: 'stall', id: 'p1', question: 'Which colour for the button?', excerpt: 'x' }, { type: 'answer', id: 'p1', at: at(1), session: 's1', case: 'menu_recommended', answer: { key: '1' }, decision_ids: ['menu-p1'] },
    { type: 'stall', id: 'p2', question: 'Which helper name?', excerpt: 'x' }, { type: 'answer', id: 'p2', at: at(5), session: 's2', case: 'menu_recommended', answer: { key: '1' }, decision_ids: ['menu-p2'] },
  ];
  const journal = [
    { decision_id: 'menu-p1', kind: 'menu', question: 'Which colour for the button?', option: 'Blue', key: 1, rationale: 'r', evidence: [] },
    { decision_id: 'menu-p2', kind: 'menu', question: 'Which helper name?', option: 'syncer', key: 1, rationale: 'r', evidence: [] },
  ];
  const items = decidedItems({ recs, journal });
  assert.deepEqual(items.map((i) => i.id), ['p1', 'p2']);   // p1 is older but product-visible
  assert.equal(items[0].productVisible, true);
  const sum = decidedSummary(items);
  assert.match(sum.text, /1 product-visible pick: "Blue" \(s1\), 1 menu pick/);
});

test('finding 5/22: a lane verdict is a decided item on its own; its revert is a lane revert, no session needed', () => {
  const lane = { decision_id: 'lane-merge-int-1', kind: 'merge', chosen: 'merge', source: 'integration-lane', ts: iso(5), session: 'gone-s', branch: 'feat', target: 'main', request: 'int-1', rationale: 'floor passed', evidence: ['x'] };
  const esc = { ...lane, decision_id: 'lane-merge-int-2', chosen: 'escalate' };
  const dep = { decision_id: 'lane-deploy-int-1', kind: 'deploy', chosen: 'deploy', source: 'integration-lane', ts: iso(6), session: 'gone-s', env: 'live', scope: 'self', ref: 'main', rollback: 'checkout the previous sha' };
  const items = decidedItems({ recs: [], journal: [lane, esc, dep] });
  assert.deepEqual(items.map((i) => i.id).sort(), ['lane-deploy-int-1', 'lane-merge-int-1']);
  const m = items.find((i) => i.kind === 'merge');
  assert.deepEqual(m.revert.lane, { request: 'int-1' });
  assert.deepEqual(revertPlan(m, { exists: false }), { status: 200, lane: { request: 'int-1' } });
  assert.equal(revertPlan(m, { exists: false, reverted: true }).status, 409);
  // a hand-off answer carrying the lane id shows once, under the answer's id
  const withAnswer = decidedItems({ recs: [ans('h1', 5, 'gone-s', { text: 'queued' }, { case: 'merge_wait', source: 'manager_decision', decision_ids: ['lane-merge-int-1'] })], journal: [lane] });
  assert.deepEqual(withAnswer.map((i) => i.id), ['h1']);
  // a hand-off whose verdict was escalate decided nothing
  assert.deepEqual(decidedItems({ recs: [ans('h2', 5, 's', { text: 'queued' }, { case: 'merge_wait', source: 'manager_decision', decision_ids: ['lane-merge-int-2'] })], journal: [esc] }), []);
});
