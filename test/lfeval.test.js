import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredState, scoresOfStop, indexStops, scoreIdOf, stopObsIdOf, createEvalSync, DATASET } from '../usage/lfeval.js';
import { genIdOf, traceIdOf } from '../usage/lf-common.js';

// Synthetic log only: no real stop content.
const NOW = Date.parse('2026-10-04T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const stall = (id, minAgo, extra = {}) => ({ type: 'stall', id, session: `sess-${id}`, agent: 'claude', state: 'done', at: iso(minAgo), case: 'continue', source: 'rule', excerpt: `synthetic closing text ${id}`, ...extra });
const jevStall = (id, minAgo, choice = 'continue', extra = {}) => stall(id, minAgo, { source: 'jev', jev: { choice, cost: 0.00002, model: 'typesafe/jev-1.13' }, ...extra });
const triage = (id, minAgo, extra = {}) => ({ type: 'triage', id, session: `sess-${id}`, at: iso(minAgo), case: 'owner_decision', mode: 'simulate', model: 'm', ai: { proposed_reply: 'Yes, continue.', reasoning: 'r', confidence: 0.9, owner_needed: false, owner_needed_why: '' }, cost: 0.001, ...extra });
const label = (id, label, extra = {}) => ({ type: 'label', id, by: 'owner', label, note: null, correctCase: null, at: iso(1), ...extra });
const verdict = (id, aiVerdict) => ({ type: 'label', id, by: 'owner', aiVerdict, at: iso(1) });
const outcome = (id, kind) => ({ type: 'outcome', id, session: `sess-${id}`, at: iso(2), kind, reply: 'x' });
const names = (st) => [...st.scores.values()].map((s) => `${s.body.name}=${s.body.value}@${s.body.observationId.slice(0, 4)}`);

test('score mapping: legit / no_reason / wrong_case, jev agreement, AI verdict', () => {
  const st = indexStops([jevStall('a', 30, 'continue'), outcome('a', 'continue')]).get('a');
  const sc = (label, aiVerdict) => scoresOfStop(st, { label, aiVerdict }).map((s) => [s.name, s.dataType, s.value]);
  assert.deepEqual(sc({ label: 'legit' }, null), [['stop_verdict', 'CATEGORICAL', 'legit'], ['stop_case_correct', 'BOOLEAN', 1], ['jev_agreed', 'BOOLEAN', 1]]);
  assert.deepEqual(sc({ label: 'no_reason' }, 'right').map((x) => x[0] + '=' + x[2]), ['stop_verdict=no_reason', 'stop_case_correct=1', 'ai_proposal_correct=1', 'jev_agreed=1']);
  // wrong_case: no verdict score, the case is wrong
  assert.deepEqual(sc({ label: 'wrong_case', correctCase: 'owner_decision' }, 'wrong').map((x) => x[0] + '=' + x[2]), ['stop_case_correct=0', 'ai_proposal_correct=0', 'jev_agreed=1']);
  // a normal label that also names the right case: the case was wrong
  assert.equal(sc({ label: 'legit', correctCase: 'done' }, null)[1][2], 0);
  // Jev said continue, the owner wrote something of their own: disagreed; no owner reply kind: no jev_agreed
  const s2 = indexStops([jevStall('b', 30, 'continue'), outcome('b', 'owner_specific')]).get('b');
  assert.equal(scoresOfStop(s2, {}).find((s) => s.name === 'jev_agreed').value, 0);
  const s3 = indexStops([jevStall('c', 30, 'continue'), outcome('c', 'unknown')]).get('c');
  assert.deepEqual(scoresOfStop(s3, {}), []);
});

test('scores attach to the stop\'s generations; a stop without one gets a manager.stop span; ids are deterministic', () => {
  const recs = [
    jevStall('a', 30, 'ask_owner'), triage('a', 30), label('a', 'legit'), verdict('a', 'wrong'), outcome('a', 'owner_specific'),
    stall('b', 20), label('b', 'no_reason'),
    jevStall('old', 60 * 24 * 40), label('old', 'legit'),   // generation outside the 14-day window was never sent
  ];
  const st = desiredState(recs, { now: NOW });
  const jevGen = genIdOf('manager:jev:a'), aiGen = genIdOf('manager:ai:a');
  const by = (name, stop) => [...st.scores.values()].filter((s) => s.body.name === name && s.body.metadata.stop_id === stop).map((s) => s.body.observationId).sort();
  assert.deepEqual(by('stop_verdict', 'a'), [aiGen, jevGen].sort(), 'verdict on both generations');
  assert.deepEqual(by('ai_proposal_correct', 'a'), [aiGen]);
  assert.deepEqual(by('jev_agreed', 'a'), [jevGen]);
  assert.deepEqual(by('stop_verdict', 'b'), [stopObsIdOf('b')], 'no generation: the stop span');
  assert.deepEqual(by('stop_verdict', 'old'), [stopObsIdOf('old')]);
  assert.deepEqual([...st.spans.values()].map((s) => s.body.metadata.stop_id).sort(), ['b', 'old']);
  const span = st.spans.get(`obs:${stopObsIdOf('b')}`).body;
  assert.equal(span.name, 'manager.stop');
  assert.deepEqual(Object.keys(span.metadata).sort(), ['agent', 'case', 'session', 'source', 'state', 'stop_id']);
  assert.ok(!JSON.stringify(span).includes('synthetic closing text'), 'no closing text on the span');
  const s = st.scores.get(`score:${scoreIdOf('stop_verdict', 'a', 'jev')}`).body;
  assert.equal(s.traceId, traceIdOf('manager', 'sess-a'));
  assert.equal(s.value, 'legit');
  assert.deepEqual(desiredState(recs, { now: NOW }).scores.keys().toArray?.() ?? [...desiredState(recs, { now: NOW }).scores.keys()], [...st.scores.keys()], 'same log, same ids');
});

test('unlabel removes the label scores (jev_agreed stays), the AI verdict survives an unlabel', () => {
  const recs = [jevStall('a', 30, 'continue'), outcome('a', 'continue'), label('a', 'legit', { aiVerdict: 'right' }), { type: 'unlabel', id: 'a', at: iso(0) }];
  const st = desiredState(recs, { now: NOW });
  assert.deepEqual([...st.scores.values()].map((s) => s.body.name).sort(), ['ai_proposal_correct', 'jev_agreed']);
  assert.equal(st.items.size, 0);
});

test('dataset item: input / expected output / metadata, deterministic id; unlabel archives', () => {
  const recs = [jevStall('a', 30, 'ask_owner', { state: 'waiting' }), outcome('a', 'owner_specific'), label('a', 'wrong_case', { correctCase: 'owner_decision' })];
  const it = desiredState(recs, { now: NOW }).items.get('item:a').body;
  assert.equal(it.id, 'a');
  assert.equal(it.datasetName, DATASET);
  assert.equal(it.status, 'ACTIVE');
  assert.deepEqual(it.input, { closing_text: 'synthetic closing text a', case_by_rules: 'continue', agent: 'claude', state: 'waiting' });
  assert.deepEqual(it.expectedOutput, { verdict: 'wrong_case', correct_case: 'owner_decision', owner_reply_kind: 'owner_specific' });
  assert.deepEqual(it.metadata, { session: 'sess-a', stop_id: 'a', at: iso(30), source: 'jev' });
  const gone = desiredState([...recs, { type: 'unlabel', id: 'a', at: iso(0) }], { now: NOW, previousItems: ['item:a'] }).items.get('item:a').body;
  assert.equal(gone.status, 'ARCHIVED');
  assert.equal(gone.input.closing_text, 'synthetic closing text a', 'archived with its input kept');
});

// ---- sync against a mock Langfuse ----
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
function mock({ traces = [] } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      calls.push({ method: req.method, url: req.url, body });
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url === '/api/public/ingestion') return send(207, { successes: [], errors: [] });
      if (req.method === 'GET' && req.url.startsWith('/api/public/traces/')) return traces.includes(req.url.split('/').pop()) ? send(200, {}) : send(404, {});
      if (req.method === 'DELETE') return send(200, {});
      send(200, { id: 'x' });
    });
  });
  servers.push(srv);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
async function setup(recs, lf) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'lfeval-'));
  const cfg = { langfuseUrl: lf.url, publicKey: 'pk', secretKey: 'sk', stallsFile: join(dir, 'stalls.jsonl'), evalStateFile: join(dir, 'lfeval-state.json'), now: () => NOW, backfillDays: 14 };
  const write = (r) => fs.writeFile(cfg.stallsFile, r.map((x) => JSON.stringify(x)).join('\n') + '\n');
  await write(recs);
  return { cfg, write, append: (r) => fs.appendFile(cfg.stallsFile, r.map((x) => JSON.stringify(x)).join('\n') + '\n') };
}
const events = (calls, type) => calls.filter((c) => c.url === '/api/public/ingestion').flatMap((c) => c.body.batch).filter((e) => !type || e.type === type);

test('sync: backfill sends scores, span (+ trace when missing), dataset; replay and state loss only re-send the same ids', async () => {
  const lf = await mock();
  const f = await setup([jevStall('a', 30, 'ask_owner'), outcome('a', 'owner_specific'), label('a', 'legit'), stall('b', 20), label('b', 'no_reason')], lf);
  const sync = createEvalSync(f.cfg, { log: () => {} });
  const r = await sync.sync();
  assert.equal(r.scores, 5);   // a: verdict, case, jev_agreed (jev gen); b: verdict, case (span)
  assert.equal(r.spans, 1);
  assert.equal(r.items, 2);
  assert.deepEqual(events(lf.calls, 'trace-create').map((e) => e.body.name), ['manager:sess-b']);
  assert.ok(lf.calls.some((c) => c.method === 'POST' && c.url === '/api/public/v2/datasets' && c.body.name === DATASET));
  const items = lf.calls.filter((c) => c.url === '/api/public/dataset-items').map((c) => c.body.id).sort();
  assert.deepEqual(items, ['a', 'b']);
  // nothing changed: nothing sent
  lf.calls.length = 0;
  assert.equal((await createEvalSync(f.cfg, { log: () => {} }).sync()).skipped, 'nothing new');
  assert.equal(lf.calls.length, 0);
  // forced pass with the same state: the diff is empty
  assert.deepEqual((await sync.sync({ force: true })).scores, 0);
  // state file lost: everything is re-sent with the same ids (Langfuse upserts)
  const first = events(lf.calls, 'score-create').map((e) => e.body.id);
  assert.equal(first.length, 0, 'the diff pass sent nothing');
  await fs.rm(f.cfg.evalStateFile);
  await createEvalSync(f.cfg, { log: () => {} }).sync();
  const again = events(lf.calls, 'score-create').map((e) => e.body.id).sort();
  assert.equal(again.length, 5);
  assert.deepEqual(again, [...new Set(again)], 'distinct deterministic ids');
  assert.ok(again.includes(scoreIdOf('jev_agreed', 'a', 'jev')));
});

test('sync: a log tail without label / outcome / triage lines is skipped; a label change replaces scores; unlabel deletes + archives', async () => {
  const lf = await mock({ traces: [traceIdOf('manager', 'sess-b')] });
  const f = await setup([stall('b', 20), label('b', 'legit', { correctCase: 'done' })], lf);
  const sync = createEvalSync(f.cfg, { log: () => {} });
  await sync.sync();
  assert.equal(events(lf.calls, 'trace-create').length, 0, 'trace already exists in Langfuse');
  lf.calls.length = 0;
  await f.append([stall('c', 5)]);
  assert.equal((await sync.sync()).skipped, 'nothing new');
  assert.equal(lf.calls.length, 0);
  // relabel legit -> wrong_case: stop_verdict is deleted, stop_case_correct stays false
  await f.append([label('b', 'wrong_case', { correctCase: 'done' })]);
  let r = await sync.sync();
  assert.equal(r.deleted, 1);
  assert.equal(lf.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)[0], `/api/public/scores/${scoreIdOf('stop_verdict', 'b', 'stop')}`);
  // unlabel: the other score is deleted and the item archived
  lf.calls.length = 0;
  await f.append([{ type: 'unlabel', id: 'b', at: iso(0) }]);
  r = await sync.sync();
  assert.equal(r.deleted, 1);
  const arch = lf.calls.find((c) => c.url === '/api/public/dataset-items');
  assert.equal(arch.body.status, 'ARCHIVED');
  assert.equal(arch.body.id, 'b');
});

test('sync: rejected events are not recorded as sent (retried next pass)', async () => {
  const lf = await mock();
  const f = await setup([stall('b', 20), label('b', 'legit')], lf);
  let reject = true;
  const fetchFn = async (url, o) => {
    const res = await fetch(url, o);
    if (reject && url.endsWith('/api/public/ingestion')) { const j = await res.json(); const ids = JSON.parse(o.body).batch.map((e) => e.id); return new Response(JSON.stringify({ successes: [], errors: ids.map((id) => ({ id, status: 400, message: 'bad' })) }), { status: 207 }); }
    return res;
  };
  const sync = createEvalSync(f.cfg, { fetchFn, log: () => {} });
  assert.equal((await sync.sync()).scores, 0);
  reject = false;
  assert.equal((await sync.sync({ force: true })).scores, 2);
});

test('judge: scores a new AI proposal on its generation, once, capped per day, failures retried', async () => {
  const { createJudge, parseJudge, judgeMessages } = await import('../usage/judge.js');
  const lf = await mock();
  const f = await setup([triage('a', 30, { src: 'rule', flags: ['mentions a deploy'] }), triage('b', 20), triage('old', 60 * 30)], lf);
  const cfg = { ...f.cfg, judgeStateFile: join(tmpdir(), `judge-${Date.now()}.json`), jevUrl: 'http://127.0.0.1:5555/server/ai/decide', jevApiKey: 'vpt-key', judgeMaxPerDay: 1 };
  const asked = [];
  let fail = false;
  const fetchFn = async (url, init) => {
    if (url.startsWith(lf.url)) return fetch(url, init);
    if (fail) throw new Error('down');
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [String(k).toLowerCase(), v]));
    asked.push({ url, headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, content: '{"reasoning":"safe","score":0.9}', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, model: 'mock-judge' }), { status: 200 });
  };
  const judge = createJudge(cfg, { fetchFn, log: () => {} });
  const first = await judge();
  assert.deepEqual([first.judged, first.skipped, first.rows.length], [1, 1, 1], 'cap of 1 per day; the 30-hour-old proposal is out of range');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'http://127.0.0.1:5555/server/ai/complete');
  assert.equal(asked[0].headers['x-api-key'], 'vpt-key');
  assert.equal(asked[0].body.usage, 'text.plan');
  assert.match(asked[0].body.prompt, /mentions a deploy/);
  assert.ok(!JSON.stringify(asked[0].body).includes('synthetic closing text'));
  const sc = events(lf.calls, 'score-create')[0].body;
  assert.deepEqual([sc.name, sc.value, sc.comment, sc.observationId], ['ai_proposal_judge', 0.9, 'safe', genIdOf('manager:ai:a')]);
  assert.equal((await judge()).judged, 0, 'a judged stop is not judged again; the cap is reached');
  // a failing endpoint counts against the cap, writes an error row, and is retried at most once an hour
  cfg.judgeMaxPerDay = 5; fail = true;
  const t0 = Date.now(); cfg.now = () => t0;
  const failed = await judge();
  assert.equal(failed.judged, 0);
  const failRow = failed.rows.filter((r) => r.error);
  assert.equal(failRow.length, 1);
  assert.equal(failRow[0].trace, traceIdOf('manager', 'sess-b'));
  assert.equal(failRow[0].usage.input, 0);
  assert.equal(JSON.parse(await fs.readFile(cfg.judgeStateFile, 'utf8')).calls, 2, 'the failed call counted against the cap');
  fail = false;
  assert.equal((await judge()).judged, 0, 'within the hour the failed stop is not retried');
  cfg.now = () => t0 + 3600e3 + 1000;
  assert.equal((await judge()).judged, 1);
  assert.equal(parseJudge('```json\n{"reasoning":"x","score":2}\n```'), null);
  assert.equal(parseJudge('{"reasoning":"x","score":0.25}').score, 0.25);
  assert.equal(judgeMessages(triage('z', 1)).length, 2);
  assert.equal(await createJudge({ ...cfg, jevApiKey: '' })().then((r) => r.skipped), 'no JEV_URL / JEV_API_KEY');
});

test('judge: request goes to /server/ai/complete with X-API-Key and usage text.plan', async () => {
  const { createJudge } = await import('../usage/judge.js');
  const lf = await mock();
  const f = await setup([triage('a', 30, { src: 'rule', flags: ['mentions a deploy'] })], lf);
  const cfg = { ...f.cfg, judgeStateFile: join(tmpdir(), `judge-${Date.now()}-${Math.random()}.json`), jevUrl: 'http://127.0.0.1:5555/server/ai/decide', jevApiKey: 'vpt-key' };
  const asked = [];
  const fetchFn = async (url, init) => {
    if (url.startsWith(lf.url)) return fetch(url, init);
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [String(k).toLowerCase(), v]));
    asked.push({ url, headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, content: '{"reasoning":"r","score":0.7}', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, model: 'mock-judge' }), { status: 200 });
  };
  await createJudge(cfg, { fetchFn, log: () => {} })();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'http://127.0.0.1:5555/server/ai/complete', 'derived from JEV_URL origin');
  assert.equal(asked[0].headers['x-api-key'], 'vpt-key');
  assert.equal(asked[0].headers['content-type'], 'application/json');
  assert.equal(asked[0].body.usage, 'text.plan');
  assert.match(asked[0].body.system, /JSON object/);
  assert.ok(asked[0].body.max_tokens > 0 && asked[0].body.timeout_s > 0);
});

test('judge: skipped when JEV_URL or JEV_API_KEY is missing', async () => {
  const { createJudge } = await import('../usage/judge.js');
  const lf = await mock();
  const f = await setup([triage('a', 30)], lf);
  const asked = [];
  const fetchFn = async (url, init) => { if (url.startsWith(lf.url)) return fetch(url, init); asked.push(url); return { json: () => ({}) }; };
  // no JEV_URL
  let r = await createJudge({ ...f.cfg, judgeStateFile: join(tmpdir(), `judge-${Date.now()}-${Math.random()}.json`), jevApiKey: 'vpt-key' }, { fetchFn, log: () => {} })();
  assert.equal(r.skipped, 'no JEV_URL / JEV_API_KEY');
  // no JEV_API_KEY
  r = await createJudge({ ...f.cfg, judgeStateFile: join(tmpdir(), `judge-${Date.now()}-${Math.random()}.json`), jevUrl: 'http://127.0.0.1:5555/server/ai/decide' }, { fetchFn, log: () => {} })();
  assert.equal(r.skipped, 'no JEV_URL / JEV_API_KEY');
  assert.equal(asked.length, 0, 'no network call when the judge is skipped');
});
