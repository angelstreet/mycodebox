// TASK-47 G2: router shadow. One Jev call (3 questions) per new distinct stop, logged and graded, and NOTHING else changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEAM = 'team-shadow';
const seen = { shadow: [], manager: [], outcome: [] };
let n = 0, mode = 'ok', outcomeStatus = 200;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const body = b ? JSON.parse(b) : {};
    if (u.pathname === '/server/ai/decide') {
      if (body.questions?.case) {
        seen.shadow.push(body);
        if (mode === 'http500') { res.statusCode = 500; return res.end(JSON.stringify({ success: false, error: 'boom' })); }
        if (mode === 'garbage') return res.end('not json');
        if (mode === 'hang') return;   // never answers
        return res.end(JSON.stringify({ success: true, cost: 0.00004, ms: 9, model: 'jev', decision_id: `sh-${++n}`, answers: {
          case: { type: 'choice', choice: 'owner_decision', confidence: 0.9, probabilities: { owner_decision: 0.92, done: 0.03 } },
          owner: { type: 'noul', noul: 0.85 },
          wake: { type: 'choice', choice: 'wake_cheap', confidence: 0.8, probabilities: { wake_cheap: 0.82, wake_opus: 0.05 } } } }));
      }
      seen.manager.push(body);
      return res.end(JSON.stringify({ success: true, cost: 0.00002, ms: 5, model: 'jev', decision_id: `mg-${++n}`,
        answers: { choice: { choice: 'continue', confidence: 0.9, probabilities: { continue: 0.95, take_recommended: 0.01, ask_owner: 0.04 } } } }));
    }
    const m = u.pathname.match(/^\/server\/ai\/decisions\/([^/]+)\/outcome$/);
    if (m) { seen.outcome.push({ id: m[1], body }); res.statusCode = outcomeStatus; return res.end(JSON.stringify({ success: outcomeStatus === 200 })); }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
test.after(() => srv.closeAllConnections?.() || srv.close());

const dir = mkdtempSync(join(tmpdir(), 'ghosty-shadow-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', VPT_TEAM_ID: TEAM, JEV_API_KEY: 'k', JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide` });
const m = await import('../manager.js');
const sc = await import('../scorecard.js');
const pushes = [], sent = [];
const init = (extra = {}) => m.initManager({ onOwnerNeeded: (s, st, why) => pushes.push([s, st.case, why]),
  sendKey: async (s, k) => sent.push([s, 'key', k]), sendKeys: async (s, t) => sent.push([s, 'keys', t]), ...extra });
await init();
await m.setManagerConfig({ aiTriage: 'off', autoSend: true, autoCases: ['continue'], delayMs: 0, routerShadow: true });

const RULE = '─'.repeat(40);
const pane = (body, prompt = '❯ ') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, prompt, RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, ...extra });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await sleep(20); } throw new Error('timed out'); }
const T = {
  question: 'Phase 1 is done.\nShall I continue with phase 2?',
  decision: 'Which database should we use?\nI need you to choose: Postgres or SQLite.',
  ambiguous: 'All good.\nNext is the cleanup of the cache code.',
};
async function stop(name, text, t0 = Date.now()) {
  tick(name, 'working', ['busy'], t0);
  const p = pane(text);
  tick(name, 'done', p, t0 + 1000); tick(name, 'done', p, t0 + 2500);
  tick(name, 'done', p, t0 + 3500);   // a repaint of the same stop
  const st = await until((r) => r.type === 'stall' && r.session === name);
  return { st, p, t0 };
}

test('one shadow call per stop id, with the benchmark questions, logged under the manager usage', async () => {
  const before = seen.shadow.length;
  const { st } = await stop('a1', T.decision);
  const rr = await until((r) => r.type === 'router' && r.id === st.id);
  await sleep(150);
  assert.equal(seen.shadow.length - before, 1, 'repaint / extra ticks never re-ask');
  const b = seen.shadow.at(-1);
  assert.equal(b.usage, 'text.decision.manager'); assert.equal(b.profile, 'jev'); assert.equal(b.log, true); assert.equal(b.team_id, TEAM);
  assert.deepEqual(Object.keys(b.questions), ['case', 'owner', 'wake']);
  assert.equal(b.questions.case.type, 'choice'); assert.equal(b.questions.owner.type, 'noul');
  assert.equal(Object.keys(b.questions.case.criteria).length, 10);
  assert.deepEqual(Object.keys(b.questions.wake.criteria), ['ignore', 'rules_handle', 'wake_cheap', 'wake_opus']);
  assert.match(b.state, /closing_text/);
  assert.equal(b.refs.source, 'ghosty-router'); assert.equal(b.refs.point, 'stop'); assert.equal(b.refs.stall_id, st.id);
  assert.equal(b.refs.rule_case, st.case); assert.equal(typeof b.refs.escalated, 'boolean');
  assert.equal(rr.router.case, 'owner_decision'); assert.equal(rr.router.owner, 0.85); assert.equal(rr.router.wake, 'wake_cheap');
  assert.equal(rr.router.caseConf, 0.92); assert.equal(rr.router.wakeConf, 0.82); assert.match(rr.router.decision_id, /^sh-/);
  assert.equal(records().filter((r) => r.type === 'router' && r.id === st.id).length, 1);
});

// What a stop did to the owner and the session, with ids and times stripped.
const view = (name) => records().filter((r) => r.session === name && r.type !== 'router').map((r) => ({ type: r.type, case: r.case, source: r.source, wouldSend: r.wouldSend, why: r.why, reason: r.reason, answer: r.answer }));

test('behaviour is identical with the shadow on and off: same log, same pushes, same keys typed', async () => {
  const run = async (suffix, on) => {
    await m.setManagerConfig({ routerShadow: on });
    const out = {};
    for (const [k, text] of Object.entries(T)) {
      const name = `${k}-${suffix}`;
      const pBefore = pushes.length, sBefore = sent.length;
      await stop(name, text);
      await sleep(250);   // let the auto-answer (delay 0) and the shadow settle
      out[k] = { view: view(name), pushes: pushes.slice(pBefore).map(([, c, w]) => [c, w]), sent: sent.slice(sBefore).map(([, kind, v]) => [kind, v]) };
    }
    return out;
  };
  const shadowBefore = seen.shadow.length;
  const off = await run('off', false);
  assert.equal(seen.shadow.length, shadowBefore, 'switch off = no call');
  assert.equal(records().filter((r) => r.type === 'router' && /-off$/.test(r.session || '')).length, 0);
  const on = await run('on', true);
  assert.equal(seen.shadow.length - shadowBefore, 3, 'one call per new stop with the switch on');
  assert.deepEqual(on, off);
  assert.ok(off.question.sent.length >= 1 || off.question.view.some((v) => v.type === 'answer'), 'the auto-answer path was really exercised');
  assert.ok(off.decision.pushes.length >= 1, 'the escalation path was really exercised');
});

test('failures never throw and never change the stop: error / bad json / http 500 are logged on the router record', async () => {
  for (const [md, name] of [['http500', 'f1'], ['garbage', 'f2']]) {
    mode = md;
    const pBefore = pushes.length;
    const { st } = await stop(name, T.decision);
    const rr = await until((r) => r.type === 'router' && r.id === st.id);
    assert.ok(rr.router.error, `${md}: error recorded`);
    assert.equal(rr.router.case, undefined);
    assert.equal(pushes.length - pBefore, 1, `${md}: the owner is still pushed`);
  }
  mode = 'ok';
});

test('the outcome is posted once, with the stop outcome kind and by owner-reply', async () => {
  const { st, p, t0 } = await stop('o1', T.decision);
  const rr = await until((r) => r.type === 'router' && r.id === st.id);
  const id = rr.router.decision_id;
  const after = [...p.slice(0, -4), '❯ use postgres please', '⏺ Working on it', '✶ Thinking…', RULE, '❯ ', RULE, 'x'];
  tick('o1', 'working', after, t0 + 9000);
  await until((r) => r.type === 'outcome' && r.id === st.id);
  await m.flushOutcomes(); await sleep(100);
  const posted = seen.outcome.filter((o) => o.id === id);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.team_id, TEAM);
  assert.deepEqual(posted[0].body.outcome, { label: 'owner_specific', by: 'owner-reply', stall_id: st.id });
  tick('o1', 'working', after, t0 + 12000); await m.flushOutcomes(); await sleep(50);
  assert.equal(seen.outcome.filter((o) => o.id === id).length, 1, 'never twice');
});

test('a hanging Jev never blocks the stop flow', async () => {
  mode = 'hang';
  const pBefore = pushes.length;
  const { st } = await stop('h1', T.decision);
  await sleep(100);
  assert.equal(pushes.length - pBefore, 1, 'pushed while the shadow call is still open');
  assert.ok(!records().some((r) => r.type === 'router' && r.id === st.id), 'no router record yet');
  mode = 'ok';
});

test('no OpenRouter credit: the shadow is skipped (logged), the flow is untouched', async () => {
  await init({ credits: () => ({ ok: true, balance: 0 }) });
  const before = seen.shadow.length;
  const { st } = await stop('c1', T.decision);
  const rr = await until((r) => r.type === 'router' && r.id === st.id);
  assert.equal(rr.router.skipped, 'no OpenRouter credit');
  assert.equal(seen.shadow.length, before);
  await init({ credits: () => ({ ok: true, balance: 5 }) });
});

// ---- scorecard ----
test('scorecard router section: decisions, rule vs Jev case, owner flagged but not escalated, wake_opus vs rule', () => {
  const day = Date.parse('2026-10-04T00:00:00Z'), at = (h) => new Date(day + h * 3600e3).toISOString();
  const stall = (id, kase, h = 1) => ({ type: 'stall', id, at: at(h), case: kase, session: 's' });
  const router = (id, ruleCase, j, escalated = false) => ({ type: 'router', id, at: at(1), rule_case: ruleCase, escalated, router: j });
  const recs = [
    stall('a', 'done'), router('a', 'done', { case: 'owner_decision', owner: 0.9, wake: 'wake_opus' }),   // rules: done (not escalated); Jev: owner, opus
    { type: 'outcome', id: 'a', at: at(2), kind: 'owner_specific', via: 'terminal' },
    stall('b', 'continue'), router('b', 'continue', { case: 'continue', owner: 0.1, wake: 'rules_handle' }),
    { type: 'outcome', id: 'b', at: at(2), kind: 'continue', via: 'terminal' },
    stall('c', 'owner_decision'), router('c', 'owner_decision', { case: 'owner_decision', owner: 0.8, wake: 'wake_opus' }, true), { type: 'escalated', id: 'c', at: at(1), case: 'owner_decision' },
    stall('d', 'continue'), router('d', 'continue', { error: 'http 500' }),
    stall('e', 'continue'), router('e', 'continue', { skipped: 'daily budget reached' }),
    stall('f', 'continue'), router('f', 'continue', { case: 'owner_decision', owner: 0.75, wake: 'wake_cheap' }),
    { type: 'label', id: 'f', at: at(3), label: 'wrong_case', correctCase: 'continue' },
  ];
  const r = sc.buildScorecard({ stallRecs: recs, from: day, to: day + 86400e3 }).router;
  assert.equal(r.decisions, 4); assert.equal(r.errors, 1); assert.equal(r.skipped, 1);
  // graded: a (rules done: owner typed own thing -> fits; Jev owner_decision fits), b (both fit), f (label: continue; rules right, Jev wrong)
  assert.deepEqual(r.graded, { n: 3, ruleCaseRight: 3, jevCaseRight: 2 });
  assert.deepEqual(r.owner, { flagged: 3, flaggedNotEscalated: 2, confirmed: 1, known: 1 });   // a is confirmed; f's wrong_case label says nothing about the owner
  assert.deepEqual(r.wake, { jevOpus: 2, ruleOpus: 1 });
  const none = sc.buildScorecard({ stallRecs: [], from: day, to: day + 86400e3 }).router;
  assert.equal(none.decisions, 0);
});
