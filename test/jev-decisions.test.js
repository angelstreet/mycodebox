import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock VPT server: decide, the decision log (summary / list / outcome), each switchable.
const TEAM = 'team-test-1';
const seen = { decide: [], outcome: [] };
let n = 0, summaryStatus = 404, outcomeStatus = 404, jevFail = false;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const body = b ? JSON.parse(b) : {};
    if (u.pathname === '/server/ai/decide') {
      seen.decide.push({ key: req.headers['x-api-key'], body });
      if (jevFail) return res.end(JSON.stringify({ success: false, error: 'OpenRouter 402: insufficient credits', answers: {}, decision_id: null }));
      return res.end(JSON.stringify({ success: true, cost: 0.00002, ms: 7, model: 'jev', decision_id: `dec-${++n}`,
        answers: { choice: { choice: 'ask_owner', confidence: 0.7, probabilities: { continue: 0.1, take_recommended: 0.2, ask_owner: 0.7 } } } }));
    }
    if (u.pathname === '/server/ai/decisions/summary') { res.statusCode = summaryStatus; return res.end(JSON.stringify(summaryStatus === 200 ? { success: true, days: [], usages: [] } : { success: false, error: 'not found' })); }
    const m = u.pathname.match(/^\/server\/ai\/decisions\/([^/]+)\/outcome$/);
    if (m) {
      seen.outcome.push({ id: m[1], key: req.headers['x-api-key'], body });
      res.statusCode = outcomeStatus; return res.end(JSON.stringify(outcomeStatus === 200 ? { success: true } : { success: false, error: 'not found' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'ghosty-jevdec-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', VPT_TEAM_ID: TEAM, JEV_API_KEY: 'k-test',
  JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide` });
const m = await import('../manager.js');
const d = await import('../decisions.js');
const v = await import('../public/jev-view.js');
await m.initManager({});
await m.setManagerConfig({ aiTriage: 'off' });

const RULE = '─'.repeat(40);
const pane = (body, prompt = '❯ ') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, prompt, RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await sleep(20); } throw new Error('timed out'); }
const AMBIG = 'All good.\nNext is the cleanup of the cache code.';
async function stop(name) {
  const t0 = Date.now();   // real clock: the tab data groups the log by day
  tick(name, 'working', ['busy'], t0);
  const p = pane(AMBIG);
  tick(name, 'done', p, t0 + 1000); tick(name, 'done', p, t0 + 2500);
  return until((r) => r.type === 'stall' && r.session === name);
}

test('jev() logs the call in the product: log, team, refs, usage; decision_id stays on the stall record', async () => {
  const st = await stop('j1');
  const c = seen.decide.at(-1);
  assert.equal(c.key, 'k-test');
  assert.equal(c.body.log, true);
  assert.equal(c.body.team_id, TEAM);
  assert.deepEqual(c.body.refs, { source: 'ghosty-manager', session: 'j1', stall_id: st.id, case: 'done' });   // the rules' case before Jev
  assert.equal(c.body.usage, 'text.decision', 'the server has no decision log yet: the generic key');
  assert.equal(c.body.profile, 'jev');
  assert.equal(st.jev.decision_id, 'dec-1');
});

test('jevUsage config pins the usage key; invalid values are refused', async () => {
  await m.setManagerConfig({ jevUsage: 'text.decision.manager' });
  await stop('j2');
  assert.equal(seen.decide.at(-1).body.usage, 'text.decision.manager');
  await assert.rejects(m.setManagerConfig({ jevUsage: 'text.plan' }), /jevUsage/);
  await m.setManagerConfig({ jevUsage: 'auto' });
  assert.equal((await m.jevUsageNow()), 'text.decision', 'auto: still the generic key while the summary 404s');
});

test('the owner reply is written back as an outcome; queued while the endpoint is missing, sent once it answers', async () => {
  const st = records().find((r) => r.type === 'stall' && r.session === 'j1');
  tick('j1', 'working', [...pane(AMBIG).slice(0, -4), '❯ do the cache cleanup but keep the old API', '⏺ working', '✶ Thinking…', RULE, '❯ ', RULE, 'x'], Date.now() + 9000);
  await until((r) => r.type === 'outcome' && r.id === st.id);
  for (let i = 0; i < 100 && seen.outcome.length < 1; i++) await sleep(20);
  assert.equal(seen.outcome[0].id, 'dec-1');
  assert.equal(seen.outcome[0].key, 'k-test');
  assert.deepEqual(seen.outcome[0].body, { team_id: TEAM, outcome: { label: 'ask_owner', by: 'owner-reply', stall_id: st.id } });
  await sleep(50);
  assert.equal(JSON.parse(readFileSync(join(dir, 'decision-outcomes.json'), 'utf8')).length, 1, 'kept for a retry');
  outcomeStatus = 200;
  await m.flushOutcomes();
  assert.equal(seen.outcome.length, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'decision-outcomes.json'), 'utf8')).length, 0);
});

test('an owner label is written back with by:owner (legit -> ask_owner, no_reason -> continue)', async () => {
  const st2 = records().find((r) => r.type === 'stall' && r.session === 'j2');
  seen.outcome.length = 0;
  await m.labelStall({ id: st2.id, label: 'no_reason' });
  for (let i = 0; i < 100 && !seen.outcome.length; i++) await sleep(20);
  assert.deepEqual(seen.outcome[0], { id: 'dec-2', key: 'k-test', body: { team_id: TEAM, outcome: { label: 'continue', by: 'owner', stall_id: st2.id } } });
  seen.outcome.length = 0;
  await m.labelStall({ id: st2.id, label: 'wrong_case', correctCase: 'menu_recommended' });
  for (let i = 0; i < 100 && !seen.outcome.length; i++) await sleep(20);
  assert.equal(seen.outcome[0].body.outcome.label, 'take_recommended');
  seen.outcome.length = 0;
  await m.labelStall({ id: st2.id, aiVerdict: 'right' });   // not a label of the stop: nothing to write
  await sleep(100);
  assert.equal(seen.outcome.length, 0);
});

test('a failing Jev (402) is on the stall record and shows in the tab data; nothing breaks', async () => {
  jevFail = true;
  const st = await stop('j3');
  assert.match(st.jev.error, /402/);
  assert.equal(st.jev.decision_id, undefined);
  const tab = await m.jevAiTab();
  assert.equal(tab.manager.health.state, 'failing');
  assert.match(tab.manager.health.error, /402/);
  assert.equal(tab.product.available, false, 'the server has no decision log: not available');
  assert.equal(tab.logged, true);
  jevFail = false;
});

test('with the decision log answering, auto switches to text.decision.manager', async () => {
  let t = 0, ok = false;
  const calls = [];
  const c = d.createDecisionsClient({ jevUrl: 'http://h:1/server/ai/decide', apiKey: 'k', teamId: TEAM, now: () => t,
    fetchFn: async (u) => { calls.push(String(u)); return ok ? { ok: true, status: 200, json: async () => ({ success: true, days: [], usages: [] }) } : { ok: false, status: 404, json: async () => ({ success: false }) }; } });
  assert.equal(await c.available(), false);
  t += 30e3; ok = true; assert.equal(await c.available(), false, 'a no is cached for a minute');
  t += 31e3; assert.equal(await c.available(), true);
  t += 60e3; assert.equal(await c.available(), true, 'a yes is cached for 5 minutes');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^http:\/\/h:1\/server\/ai\/decisions\/summary\?team_id=team-test-1$/);
  // unconfigured (no team): never calls
  const u = d.createDecisionsClient({ jevUrl: 'http://h:1/x', apiKey: 'k', teamId: '', fetchFn: async () => { throw new Error('called'); } });
  assert.equal(u.configured, false);
  assert.equal((await u.summary()).ok, false);
  assert.equal((await u.list()).ok, false);
});

test('outcome mapping', () => {
  assert.equal(d.outcomeFromReplyKind('continue'), 'continue');
  assert.equal(d.outcomeFromReplyKind('take_recommended'), 'take_recommended');
  assert.equal(d.outcomeFromReplyKind('owner_specific'), 'ask_owner');
  assert.equal(d.outcomeFromReplyKind('unknown'), null);
  assert.equal(d.outcomeFromLabel({ label: 'legit' }), 'ask_owner');
  assert.equal(d.outcomeFromLabel({ label: 'no_reason' }), 'continue');
  assert.equal(d.outcomeFromLabel({ label: 'wrong_case', correctCase: 'stopped_short' }), 'continue');
  assert.equal(d.outcomeFromLabel({ label: 'wrong_case', correctCase: 'permission' }), 'ask_owner');
  assert.equal(d.outcomeFromLabel({ label: 'wrong_case' }), null);
});

test('retry queue: retry keeps, sent removes, 400 drops, newest per decision wins, old ones expire', async () => {
  const file = join(dir, 'q.json');
  let t = 1000; const res = new Map(); const sent = [];
  const q = d.createOutcomeQueue({ file, now: () => t, maxAgeMs: 5000, send: async (id, o) => { sent.push([id, o.label]); return res.get(id) || 'retry'; } });
  await q.add('a', { label: 'continue' });
  await q.add('b', { label: 'ask_owner' });
  assert.equal(q.size(), 2);
  await q.add('a', { label: 'ask_owner' });           // replaces a's queued outcome
  assert.deepEqual(q.items().map((i) => [i.decision_id, i.outcome.label]).sort(), [['a', 'ask_owner'], ['b', 'ask_owner']]);
  res.set('a', 'sent'); res.set('b', 'drop');
  await q.flush();
  assert.equal(q.size(), 0);
  // survives a restart
  res.clear(); await q.add('c', { label: 'continue' });
  const q2 = d.createOutcomeQueue({ file, now: () => t, maxAgeMs: 5000, send: async () => 'retry' });
  await q2.flush(); assert.equal(q2.size(), 1);
  t += 6000; await q2.flush(); assert.equal(q2.size(), 0, 'expired');
});

const NOW = Date.parse('2026-10-04T12:00:00Z');
const jevRec = (id, at, jev, extra = {}) => ({ type: 'stall', id, session: 'sess-' + id, case: 'continue', at, excerpt: 'closing text ' + id, jev, ...extra });

test('tab data: per-day local streams, health, remote present and missing', () => {
  const recs = [
    jevRec('a', '2026-10-04T08:00:00Z', { error: '402 credits', ms: 5 }),
    jevRec('b', '2026-10-04T09:00:00Z', { error: '402 credits', ms: 5 }),
    jevRec('c', '2026-10-03T09:00:00Z', { choice: 'continue', confidence: 0.9, cost: 0.00002, ms: 9 }),
    jevRec('s', '2026-10-04T09:30:00Z', { skipped: 'daily budget reached' }),
    { type: 'triage', id: 'a', at: '2026-10-04T08:00:01Z', ai: { proposed_reply: 'x' }, cost: 0.01 },
    { type: 'triage', id: 'b', at: '2026-10-04T09:00:01Z', error: 'boom', cost: 0 },
    { type: 'triage', id: 'c', at: '2026-10-04T09:00:02Z', skipped: 'not configured' },
  ];
  const t = d.tabData({ recs, remote: { ok: false, error: 'http 404' }, now: NOW });
  assert.equal(t.manager.days.length, 14);
  const day = (s, x) => s.days.find((e) => e.day === x);
  assert.deepEqual(day(t.manager, '2026-10-04'), { day: '2026-10-04', calls: 2, failed: 2, cost: 0 });
  assert.equal(day(t.manager, '2026-10-03').calls, 1);
  assert.equal(t.manager.total.calls, 3);
  assert.equal(t.manager.health.state, 'failing');
  assert.equal(t.manager.health.streak, 2);
  assert.equal(t.manager.health.error, '402 credits');
  assert.deepEqual(day(t.reviewer, '2026-10-04'), { day: '2026-10-04', calls: 2, failed: 1, cost: 0.01 });
  assert.equal(t.product.available, false);
  assert.equal(d.tabData({ recs: [], remote: undefined, now: NOW }).manager.health.state, 'none');

  const remote = { ok: true, ...d.normalizeSummary({ days: d.lastDays(14, NOW), usages: [{ usage_key: 'text.decision.sherlock', calls: 5, failed: 1, cost: 0.0001, last_at: '2026-10-04T10:00:00Z', with_outcome: 2, per_day: { '2026-10-04': 3 } }] }) };
  const r = d.tabData({ recs, remote, now: NOW });
  assert.equal(r.product.available, true);
  assert.equal(r.product.usages[0].days.at(-1).calls, 3);
  assert.equal(r.product.usages[0].days.length, 14);
});

test('tab html: error shown prominently, not-available text, product rows', () => {
  const recs = [jevRec('a', '2026-10-04T08:00:00Z', { error: 'OpenRouter 402: insufficient credits' })];
  const html = v.jevTabHtml(d.tabData({ recs, remote: { ok: false, error: 'http 404' }, now: NOW }), '2026-10-04');
  assert.match(html, /Manager Jev is failing/);
  assert.match(html, /OpenRouter 402: insufficient credits/);
  assert.match(html, /not available until the server is updated/);
  assert.match(html, /AI reviewer: no calls/);
  const withRemote = v.jevTabHtml(d.tabData({ recs, remote: { ok: true, ...d.normalizeSummary({ usages: [{ usage_key: 'text.decision.sherlock', calls: 5, failed: 0, cost: 0, per_day: {} }] }) }, now: NOW }), '2026-10-04');
  assert.match(withRemote, /text\.decision\.sherlock/);
  assert.doesNotMatch(withRemote, /not available until/);
  assert.match(v.jevTabHtml(null), /loading/);
});

const srvRows = [
  { id: 'r1', created_at: '2026-10-04T10:00:00Z', usage_key: 'text.decision.manager', model: 'jev', ok: true, ms: 9, cost: 0.00002, answers: { choice: { choice: 'continue', confidence: 0.9 } }, refs: { source: 'ghosty-manager', session: 'sess-a', stall_id: 'a', case: 'continue' }, outcome: { label: 'continue', by: 'owner' }, outcome_at: '2026-10-04T10:05:00Z' },
  { id: 'r2', created_at: '2026-10-04T09:00:00Z', usage_key: 'text.decision.sherlock', model: 'jev', ok: true, ms: 12, cost: 0.00003, answers: { verdict: { choice: 'BUG', probabilities: { BUG: 0.6, VALID_FAIL: 0.4 } } }, refs: { script_result_id: 'abcdef123456' }, outcome: { label: 'VALID_FAIL', by: 'human' } },
  { id: 'r3', created_at: '2026-10-04T08:00:00Z', usage_key: 'text.decision.manager', ok: false, error: '402', answers: {}, refs: { source: 'ghosty-manager', session: 'sess-b', stall_id: 'b', case: 'continue' }, outcome: null },
];
const stalls = [jevRec('a', '2026-10-04T10:00:00Z', { choice: 'continue', confidence: 0.9, decision_id: 'r1' })];

test('decisions page from the server: all uses, view rows, agreement, filters', async () => {
  const calls = [];
  const client = { configured: true, teamId: TEAM, list: async (f) => { calls.push(f); return { ok: true, rows: srvRows }; } };
  const p = await d.decisionsPage({ client, recs: stalls, f: { usage: 'text.decision.', ok: 'true', hasOutcome: 'true', limit: 50 } });
  assert.equal(p.source, 'server');
  assert.deepEqual(calls[0], { usage: 'text.decision.', ok: 'true', hasOutcome: 'true', limit: 50, offset: undefined, since: undefined });
  assert.equal(p.rows.length, 3);
  const [r1, r2, r3] = p.rows;
  assert.deepEqual([r1.pick, r1.confidence, r1.agree, r1.session, r1.manager], ['continue', 0.9, true, 'sess-a', true]);
  assert.match(r1.stop.excerpt, /closing text a/);
  assert.deepEqual([r2.pick, r2.confidence, r2.agree, r2.manager], ['BUG', 0.6, false, false]);
  assert.match(r2.about, /script_result_id abcdef12/);
  assert.deepEqual([r3.ok, r3.outcome, r3.agree], [false, null, null]);
  // confidence filter is applied here (the server has none)
  const hi = await d.decisionsPage({ client, recs: stalls, f: { minConf: '0.8' } });
  assert.deepEqual(hi.rows.map((r) => r.id), ['r1']);
  const html = v.decisionsHtml(p, { live: (n) => n === 'sess-a' });
  assert.match(html, /decision log \(all uses\)/);
  assert.match(html, /agrees/); assert.match(html, /differs from Jev/); assert.match(html, /no outcome yet/); assert.match(html, /data-dsession="sess-a"/);
  assert.match(html, /session not running/);
});

test('decisions page when the endpoint is missing: the manager\'s own calls, labelled, filterable', async () => {
  const recs = [
    jevRec('a', '2026-10-04T10:00:00Z', { choice: 'continue', confidence: 0.9, ms: 5, cost: 0.00002, decision_id: 'dd1' }),
    jevRec('b', '2026-10-04T09:00:00Z', { error: '402 credits', ms: 3 }),
    jevRec('c', '2026-10-04T08:00:00Z', { choice: 'ask_owner', confidence: 0.6, ms: 4 }),
    jevRec('s', '2026-10-04T07:00:00Z', { skipped: 'daily budget reached' }),
    { type: 'outcome', id: 'a', at: '2026-10-04T10:02:00Z', via: 'terminal', kind: 'continue', reply: 'yes' },
    { type: 'label', id: 'c', label: 'legit', at: '2026-10-04T08:30:00Z' },
  ];
  const client = { configured: true, teamId: TEAM, list: async () => ({ ok: false, status: 404, error: 'not found' }) };
  const p = await d.decisionsPage({ client, recs, f: {}, usageNow: 'text.decision' });
  assert.equal(p.source, 'local');
  assert.match(p.note, /no decision log yet/);
  assert.deepEqual(p.rows.map((r) => r.stallId), ['a', 'b', 'c']);
  assert.deepEqual(p.rows.map((r) => r.agree), [true, null, true]);
});

test('local page filters: use, ok/failed, with/without outcome, minimum confidence, paging', async () => {
  const recs = [
    jevRec('a', '2026-10-04T10:00:00Z', { choice: 'continue', confidence: 0.9 }),
    jevRec('b', '2026-10-04T09:00:00Z', { error: 'x' }),
    jevRec('c', '2026-10-04T08:00:00Z', { choice: 'ask_owner', confidence: 0.6 }),
    { type: 'label', id: 'c', label: 'no_reason', at: '2026-10-04T08:30:00Z' },
  ];
  const client = { configured: false, teamId: '' };
  const ids = async (f) => (await d.decisionsPage({ client, recs, f })).rows.map((r) => r.stallId).join('');
  assert.equal(await ids({}), 'abc');
  assert.equal(await ids({ ok: 'false' }), 'b');
  assert.equal(await ids({ ok: 'true' }), 'ac');
  assert.equal(await ids({ hasOutcome: 'true' }), 'c');
  assert.equal(await ids({ hasOutcome: 'false' }), 'ab');
  assert.equal(await ids({ minConf: '0.8' }), 'a');
  assert.equal(await ids({ usage: 'text.decision.sherlock' }), '', 'a use the manager never made');
  const p = await d.decisionsPage({ client, recs, f: { limit: 2 } });
  assert.deepEqual([p.rows.length, p.more, p.source], [2, true, 'local']);
  assert.match(p.note, /VPT_TEAM_ID not set/);
  assert.equal((await d.decisionsPage({ client, recs, f: { limit: 2, offset: 2 } })).rows[0].stallId, 'c');
});

test('an older server that does not know text.decision.manager gets the generic key instead', async () => {
  await m.setManagerConfig({ jevUsage: 'text.decision.manager' });
  const before = seen.decide.length;
  const orig = srv.listeners('request')[0];
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b || '{}'); seen.decide.push({ body }); res.setHeader('content-type', 'application/json');
      if (body.usage === 'text.decision.manager') return res.end(JSON.stringify({ success: false, error: "Unknown usage 'text.decision.manager'", answers: {} }));
      res.end(JSON.stringify({ success: true, decision_id: 'dec-x', answers: { choice: { choice: 'continue', confidence: 0.9 } } }));
    });
  });
  const st = await stop('j9');
  assert.deepEqual(seen.decide.slice(before).map((c) => c.body.usage), ['text.decision.manager', 'text.decision']);
  assert.equal(st.jev.choice, 'continue');
  srv.removeAllListeners('request'); srv.on('request', orig);
  await m.setManagerConfig({ jevUsage: 'auto' });
});

test.after(() => { srv.closeAllConnections(); srv.close(); });
