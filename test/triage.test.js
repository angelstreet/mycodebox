import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Mock VPT server: /server/ai/decide (Jev) and /server/ai/complete (the AI reviewer).
const calls = [];
let reviewer = { content: '' };
let jevChoice = 'ask_owner';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const body = JSON.parse(b || '{}');
    if (req.url === '/server/ai/complete') {
      calls.push({ url: req.url, key: req.headers['x-api-key'], body });
      if (reviewer.status) { res.statusCode = reviewer.status; return res.end(JSON.stringify({ success: false, error: 'boom' })); }
      return res.end(JSON.stringify({ success: true, content: typeof reviewer.content === 'string' ? reviewer.content : JSON.stringify(reviewer.content), usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, model: 'mock-model' }));
    }
    res.end(JSON.stringify({ success: true, cost: 0, ms: 1, model: 'mock', answers: { choice: { choice: jevChoice, confidence: 0.7, probabilities: { continue: 0.1, take_recommended: 0.2, ask_owner: 0.7 } } } }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'ghosty-triage-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide`, JEV_API_KEY: 'test-key' });
const m = await import('../manager.js');
const tri = await import('../triage.js');
const keys = [], texts = [], pushes = [];
await m.initManager({
  onOwnerNeeded: (s, st, why) => pushes.push({ s, case: st.case, why, ai: st.aiLine }),
  sendKey: async (s, k) => { keys.push([s, k]); },
  sendKeys: async (s, t) => { texts.push([s, t]); },
  context: () => ({ priority: 'P1', quota: 'Claude Max 5h 37% / week 16%', leases: 'none', deploys: 'none queued' }),
});

const RULE = '─'.repeat(40);
const pane = (body, prompt = '❯ ') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, prompt, RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stall(name, plain, state = 'done') {
  tick(name, 'working', ['busy'], 0);
  tick(name, state, plain, 1000);
  tick(name, state, plain, 2500);
  for (let i = 0; i < 60 && !records().some((r) => r.session === name && (r.type === 'triage' || r.type === 'escalated')); i++) await sleep(25);
  await sleep(30);
}
const sent = (n) => [...keys, ...texts].filter((x) => x[0] === n);
const ans = (o) => ({ proposed_reply: 'Use Postgres.', reasoning: 'It is already in the stack. Low risk.', confidence: 0.9, owner_needed: false, owner_needed_why: '', ...o });
const EITHER = 'Design is ready.\nDo you want Redis or Postgres for the cache?';
const DEPLOY = 'The run is going.\nDo you want to deploy once the run ends, or will you run it yourself?';
const triageOf = (n) => records().filter((r) => r.type === 'triage' && r.session === n);
const reset = () => { calls.length = 0; keys.length = 0; texts.length = 0; pushes.length = 0; reviewer = { content: ans() }; };

test('reviewer request: usage text.plan on the same server as Jev, key header, the facts and the never-list', async () => {
  reset();
  assert.equal(tri.reviewerUrl('http://10.0.0.5:5109/server/ai/decide'), 'http://10.0.0.5:5109/server/ai/complete');
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });
  await stall('rq1', pane(EITHER));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.key, 'test-key');
  assert.equal(c.body.usage, 'text.plan');
  assert.ok(c.body.max_tokens > 0 && c.body.timeout_s > 0);
  assert.match(c.body.system, /NEVER/);
  assert.match(c.body.system, /deploy/);
  assert.match(c.body.system, /"proposed_reply"/);
  assert.match(c.body.prompt, /Redis or Postgres/);
  assert.match(c.body.prompt, /Session: rq1 \(claude, project p\), priority P1/);
  assert.match(c.body.prompt, /Stop case chosen by the rules: owner_decision/);
  assert.match(c.body.prompt, /Plans' quota: Claude Max 5h 37%/);
  assert.doesNotMatch(c.body.prompt, /Leases now/, 'lease and deploy state only for deploy stops');
});

test('simulate: the proposal is logged and shown, nothing is ever typed, the push carries it', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: true, autoCases: ['continue'], aiMinConfidence: 0.1 });
  await stall('sim1', pane(EITHER));
  const t = triageOf('sim1');
  assert.equal(t.length, 1);
  assert.equal(t[0].ai.proposed_reply, 'Use Postgres.');
  assert.equal(t[0].mode, 'simulate');
  assert.ok(t[0].cost > 0 && t[0].ms >= 0 && t[0].costEstimated === true);
  assert.equal(t[0].id, records().find((r) => r.type === 'stall' && r.session === 'sim1').id);
  const v = m.triageOf('sim1');
  assert.equal(v.state, 'done');
  assert.equal(v.ai.proposed_reply, 'Use Postgres.');
  assert.equal(v.jev, null, 'a rule-classified stop has no Jev call');
  await sleep(200);
  assert.equal(sent('sim1').length, 0);
  assert.equal(pushes.at(-1).s, 'sim1');
  assert.match(pushes.at(-1).ai, /proposes "Use Postgres\."/);
  assert.equal(m.autoOf('sim1'), null);
});

test('an ambiguous stop carries Jev\'s probabilities to the reviewer and to the card', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });
  await stall('jv1', pane('The module is renamed.\nIs the new naming fine for you?'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.prompt, /Jev's read: ask_owner — .*ask_owner 70%/);
  assert.equal(m.triageOf('jv1').jev, 'ask_owner 70 %');
});

test('one reviewer call per stop: the cache answers a repeat', async () => {
  reset();
  const before = calls.length;
  const stopId = records().find((r) => r.type === 'stall' && r.session === 'sim1').id;
  const again = await m.triageStop({ name: 'sim1', id: stopId, final: { case: 'owner_decision', question: 'x?' }, stall: { excerpt: 'x' }, state: 'done', agent: 'claude' });
  assert.equal(calls.length, before);
  assert.equal(again.ai.proposed_reply, 'Use Postgres.');
});

test('no reviewer call for a plain finished turn, background work, or a stop the auto-answer handles', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: true, autoCases: ['continue'], minConfidence: 0.5, delayMs: 60000 });
  await stall('plain1', pane('Refactor is finished and tested. Nothing left.'));
  await sleep(100);
  assert.equal(calls.length, 0, 'plain done without a question');
  await stall('cont1', pane('Step 1 is done.\nShall I continue with step 2?'));
  await sleep(100);
  assert.equal(calls.length, 0, 'the auto-answer will handle it');
  assert.ok(m.autoOf('cont1'));
  m.cancelAuto('cont1');
  await m.setManagerConfig({ autoSend: false });
  assert.equal(m.toOwnerCase({ case: 'background_wait', question: 'x?' }), false);
  assert.equal(m.toOwnerCase({ case: 'done', question: 'all done.' }), false);
  assert.equal(m.toOwnerCase({ case: 'done', question: 'ok?' }), true);
  assert.equal(m.toOwnerCase({ case: 'waiting_deploy', question: '' }), true);
});

test('deploy stops get the leases and the deploy queue in the prompt', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });
  await stall('dep1', pane(DEPLOY));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.prompt, /Leases now: none/);
  assert.match(calls[0].body.prompt, /Deploy queue: none queued/);
  assert.match(calls[0].body.prompt, /forbidden topic: "deploy"/);
});

test('malformed answers are handled: fenced JSON, text around JSON, garbage, wrong types', () => {
  const P = tri.parseReviewerAnswer;
  assert.equal(P('```json\n{"proposed_reply":"ok","reasoning":"r","confidence":0.8,"owner_needed":false}\n```').ai.proposed_reply, 'ok');
  assert.equal(P('Sure! {"proposed_reply":"ok","reasoning":"r","confidence":0.8,"owner_needed":false} hope that helps').ai.confidence, 0.8);
  assert.ok(P('I think you should continue').error);
  assert.ok(P('').error);
  assert.ok(P('[1,2]').error);
  assert.ok(P('{"proposed_reply": "x"').error, 'truncated JSON');
  const a = P('{"proposed_reply":"ok","reasoning":"One. Two. Three. Four.","confidence":"high","owner_needed":"no"}').ai;
  assert.equal(a.confidence, 0);
  assert.equal(a.owner_needed, true, 'anything but an explicit false means the owner');
  assert.equal(a.reasoning, 'One. Two. Three.');
  assert.equal(P('{"proposed_reply":"","reasoning":"r","confidence":0.9,"owner_needed":false}').ai.owner_needed, true, 'no reply = owner');
  assert.equal(P('{"proposed_reply":"x","confidence":7,"owner_needed":false}').ai.confidence, 1);
  const f = P('{"proposed_reply":"Yes, go ahead and deploy.","reasoning":"r","confidence":0.99,"owner_needed":false}').ai;
  assert.equal(f.owner_needed, true);
  assert.equal(f.forbidden, 'deploy');
  assert.ok(P('{"proposed_reply":"' + 'x'.repeat(900) + '","owner_needed":false,"confidence":1}').ai.proposed_reply.length <= 300);
});

test('a malformed or failing reviewer never breaks the stop: error is logged, the owner still gets it', async () => {
  reset(); reviewer = { content: 'no json at all' };
  await m.setManagerConfig({ aiTriage: 'simulate' });
  await stall('bad1', pane(EITHER));
  assert.match(triageOf('bad1')[0].error, /not JSON/);
  assert.equal(m.triageOf('bad1').state, 'error');
  assert.equal(pushes.at(-1).s, 'bad1');
  reset(); reviewer = { status: 500 };
  await stall('bad2', pane(EITHER));
  assert.ok(triageOf('bad2')[0].error);
  assert.equal(pushes.at(-1).s, 'bad2');
});

test('budget: over the daily calls / dollars the reviewer is skipped and says so', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', aiDailyCalls: 0, aiDailyUsd: 1 });
  await stall('bud1', pane(EITHER));
  assert.equal(calls.length, 0);
  assert.equal(triageOf('bud1')[0].skipped, 'AI daily budget reached');
  assert.equal(m.triageOf('bud1').state, 'skipped');
  assert.equal(pushes.at(-1).s, 'bud1');
  await m.setManagerConfig({ aiDailyCalls: 300 });
  const b = m.managerConfig().aiBudget;
  assert.ok(b.calls >= 4 && b.cost > 0 && b.dailyCalls === 300 && b.dailyUsd === 1);
  await m.setManagerConfig({ aiDailyUsd: 0.0001 });
  await stall('bud2', pane(EITHER));
  assert.equal(triageOf('bud2')[0].skipped, 'AI daily budget reached');
  await m.setManagerConfig({ aiDailyUsd: 1 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'ai-budget.json'), 'utf8')).calls, b.calls);
});

test('aiTriage off: no call, nothing logged, the stop still reaches the owner', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'off' });
  await stall('off1', pane(EITHER));
  assert.equal(calls.length, 0);
  assert.equal(triageOf('off1').length, 0);
  assert.equal(m.triageOf('off1'), null);
  assert.equal(pushes.at(-1).s, 'off1');
  await assert.rejects(m.setManagerConfig({ aiTriage: 'maybe' }), /aiTriage/);
  await assert.rejects(m.setManagerConfig({ aiAutoCases: ['permission'] }), /aiAutoCases/);
});

const AUTO = (extra = {}) => m.setManagerConfig({ aiTriage: 'auto', autoSend: true, autoCases: [], aiMinConfidence: 0.85, delayMs: 120, maxPerSessionPerHour: 4, aiDailyCalls: 300, aiDailyUsd: 1, aiAutoCases: ['owner_decision', 'continue', 'stopped_short', 'menu_recommended'], ...extra });

test('auto: a confident owner-free proposal goes through the countdown and is typed, logged as source ai', async () => {
  reset(); await AUTO();
  await stall('au1', pane(EITHER));
  assert.ok(m.autoOf('au1'), 'countdown pill');
  assert.equal(m.autoOf('au1').answer, 'Use Postgres.');
  assert.equal(sent('au1').length, 0, 'nothing before the delay');
  await sleep(300);
  assert.deepEqual(texts.filter((x) => x[0] === 'au1'), [['au1', 'Use Postgres.']]);
  const a = records().find((r) => r.type === 'answer' && r.session === 'au1');
  assert.equal(a.source, 'ai');
});

test('auto: the owner can cancel the countdown like any auto answer', async () => {
  reset(); await AUTO({ delayMs: 400 });
  await stall('au2', pane(EITHER));
  assert.ok(m.cancelAuto('au2'));
  await sleep(500);
  assert.equal(sent('au2').length, 0);
});

test('auto respects owner_needed, confidence, case list, draft, hourly cap', async () => {
  await AUTO();
  reset(); reviewer = { content: ans({ owner_needed: true, owner_needed_why: 'product call' }) };
  await stall('ag1', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag1').length, 0, 'owner_needed');
  assert.equal(pushes.at(-1).s, 'ag1');
  reset(); reviewer = { content: ans({ confidence: 0.84 }) };
  await stall('ag2', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag2').length, 0, 'below aiMinConfidence');
  reset();
  await AUTO({ aiAutoCases: ['continue'] });
  await stall('ag3', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag3').length, 0, 'owner_decision not in aiAutoCases');
  reset(); await AUTO();
  await stall('ag4', pane(EITHER, '❯ half typed text')); await sleep(300);
  assert.equal(sent('ag4').length, 0, 'draft in the input box');
  reset(); await AUTO({ maxPerSessionPerHour: 0 });
  await stall('ag5', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag5').length, 0, 'hourly cap');
  reset(); await AUTO({ autoSend: false });
  await stall('ag6', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag6').length, 0, 'master auto-answer switch off');
  reset(); await m.setManagerConfig({ aiTriage: 'simulate', autoSend: true });
  await stall('ag7', pane(EITHER)); await sleep(300);
  assert.equal(sent('ag7').length, 0, 'simulate never types, even with everything else on');
});

test('auto never sends a forbidden topic whatever the AI says: question, reply, or never-list cases', async () => {
  await AUTO();
  reset(); reviewer = { content: ans({ proposed_reply: 'I will run it myself.', confidence: 0.99 }) };
  await stall('af1', pane(DEPLOY)); await sleep(300);
  assert.equal(sent('af1').length, 0, 'the question is about a deploy');
  assert.ok(triageOf('af1')[0].ai, 'the AI still proposed; the owner sees it');
  assert.equal(m.autoOf('af1'), null);
  reset(); reviewer = { content: ans({ proposed_reply: 'Yes, deploy it now.', confidence: 0.99 }) };
  await stall('af2', pane(EITHER)); await sleep(300);
  assert.equal(sent('af2').length, 0, 'the reply itself is a deploy');
  assert.equal(triageOf('af2')[0].ai.owner_needed, true);
  for (const t of ['Please paste the API key for the staging service.', 'Delete the old branch?', 'Should I send the invoice to the customer?']) {
    reset(); reviewer = { content: ans({ confidence: 1 }) };
    const n = `af-${t.slice(0, 6).replace(/\W/g, '')}`;
    await stall(n, pane(`Done so far.\n${t}`)); await sleep(250);
    assert.equal(sent(n).length, 0, t);
  }
  // a reply typed while the forbidden topic appears at fire time: the re-check blocks it
  reset(); await AUTO({ delayMs: 250 });
  await stall('af3', pane(EITHER));
  assert.ok(m.autoOf('af3'));
  tick('af3', 'done', pane('Design is ready.\nDo you want Redis or Postgres for the cache? I would deploy the secret next.'), 4000);
  await sleep(450);
  assert.equal(sent('af3').length, 0, 'pane changed / forbidden at fire time');
  assert.throws(() => { throw new Error('guard'); });
});

test('config: AI defaults are simulate, 0.85, $1 and 300 calls', async () => {
  const fresh = JSON.parse(JSON.stringify(m.managerConfig()));
  assert.ok(fresh.aiModes.includes('auto'));
  assert.equal(tri.AI_MODES[0], 'off');
  assert.equal(fresh.aiMinConfidence, 0.85);
  assert.equal(fresh.aiDailyUsd, 1);
  assert.equal(fresh.aiDailyCalls, 300);
});

test('AI verdict: a stand-alone label does not label the stop; the deck shows the proposal; summary and report count it', async () => {
  reset();
  await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false });
  await stall('vd1', pane(EITHER));
  const id = records().find((r) => r.type === 'stall' && r.session === 'vd1').id;
  let deck = await m.reviewDeck();
  let card = deck.cards.find((c) => c.id === id);
  assert.equal(card.ai.proposed_reply, 'Use Postgres.');
  assert.equal(card.aiVerdict, null);
  await m.labelStall({ id, aiVerdict: 'right' });
  deck = await m.reviewDeck();
  card = deck.cards.find((c) => c.id === id);
  assert.ok(card, 'still unlabelled for the swipe review');
  assert.equal(card.aiVerdict, 'right');
  await assert.rejects(m.labelStall({ id, aiVerdict: 'maybe' }), /aiVerdict/);
  await assert.rejects(m.labelStall({ id }), /label must/);
  await m.labelStall({ id, aiVerdict: 'wrong' });                       // newest wins
  await m.labelStall({ id, label: 'legit', aiVerdict: 'wrong' });       // may ride on a normal label
  deck = await m.reviewDeck();
  assert.equal(deck.cards.find((c) => c.id === id), undefined, 'now labelled');
  await m.unlabelStall({ id });
  assert.equal((await m.reviewDeck()).cards.find((c) => c.id === id).aiVerdict, 'wrong', 'undo of the swipe keeps the AI rating');
  const id2 = records().find((r) => r.type === 'stall' && r.session === 'sim1').id;
  await m.labelStall({ id: id2, aiVerdict: 'right' });
  const s = await m.aiSummary();
  assert.equal(s.right, 1); assert.equal(s.wrong, 1); assert.equal(s.agreement, 0.5);
  assert.ok(s.proposals >= 2 && s.today.calls > 0);
  const out = spawnSync('node', ['scripts/stall-report.js', '--days', '3'], { env: { ...process.env, GHOSTY_STATE_DIR: dir }, encoding: 'utf8' });
  assert.match(out.stdout, /AI reviewer: \d+ proposals/);
  assert.match(out.stdout, /AI agreement: 1 right \/ 1 wrong = 50 %/);
  assert.equal(out.status, 0, out.stderr);
});

test('triage action is logged; dismiss hides the proposal', async () => {
  const id = records().find((r) => r.type === 'stall' && r.session === 'vd1').id;
  assert.ok(m.triageOf('vd1'));
  await assert.rejects(m.triageAction({ id, action: 'nuke' }), /action/);
  await m.triageAction({ id, action: 'sent', session: 'vd1' });
  assert.ok(records().some((r) => r.type === 'triage_action' && r.id === id && r.action === 'sent'));
  await m.triageAction({ id, action: 'dismissed', session: 'vd1' });
  assert.equal(m.triageOf('vd1'), null);
});

test.after(() => srv.close());
