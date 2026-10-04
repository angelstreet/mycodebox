import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManagerLine, langfuseEvents, createIngester, defaults, priceFor, costOf, buildSummary, genIdOf, traceIdOf } from '../usage/ingest.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const prices = JSON.parse(await fs.readFile(new URL('../usage/prices.json', import.meta.url), 'utf8'));

const servers = [];
after(() => servers.forEach((x) => { x.closeAllConnections(); x.close(); }));

function mockLangfuse() {
  const batches = [];
  const reg = (x) => servers.push(x);
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      batches.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(b) });
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ successes: [], errors: [] }));
    });
  });
  reg(srv);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, batches, url: `http://127.0.0.1:${srv.address().port}` })));
}

const claudeLine = (id, ts, usage, extra = {}) => JSON.stringify({
  type: 'assistant', sessionId: 'sess-aaa', cwd: '/work/demo-repo', timestamp: ts,
  message: { id, model: 'claude-opus-5-5', usage: { output_tokens_details: {}, ...usage }, content: [] }, ...extra,
}) + '\n';

async function fixture(lf) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'usage-test-'));
  const cfg = {
    ...defaults({}), langfuseUrl: lf.url, publicKey: 'pk', secretKey: 'sk',
    claudeDir: join(dir, 'claude'), codexDir: join(dir, 'codex'), minimaxDb: join(dir, 'none.sqlite'),
    stateDir: join(dir, 'state'), now: () => NOW, paceMs: 0,
  };
  Object.assign(cfg, { offsetsFile: join(cfg.stateDir, 'usage-offsets.json'), ledgerFile: join(cfg.stateDir, 'usage-ledger.jsonl'), summaryFile: join(cfg.stateDir, 'usage-summary.json'), stallsFile: join(cfg.stateDir, 'stalls.jsonl'), evalStateFile: join(cfg.stateDir, 'lfeval-state.json') });
  await fs.mkdir(join(cfg.claudeDir, 'proj'), { recursive: true });
  await fs.mkdir(join(cfg.codexDir, '2026/10/03'), { recursive: true });
  return { dir, cfg };
}
const hooks = { projectOf: async (cwd) => (cwd === '/work/demo-repo' ? 'demo-repo' : null), tmuxPanes: async () => [] };
const gens = (batches) => batches.flatMap((b) => b.body.batch).filter((e) => e.type === 'generation-create').map((e) => e.body);

test('cost: opus 5.5 with 5m and 1h cache writes', () => {
  const c = costOf(priceFor(prices, 'claude-opus-5-5'), { input: 1000, output: 2000, cache_read: 10000, cache_write_5m: 1000, cache_write_1h: 1000 });
  // 1000*4 + 2000*20 + 10000*0.2 + 1000*5 + 1000*8 = 4000+40000+2000+5000+8000 = 59000 per 1M
  assert.equal(c.total, 0.059);
  assert.equal(costOf(priceFor(prices, 'some-unknown-model'), { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }), null);
  assert.equal(priceFor(prices, 'claude-opus-5-5').input, 4);   // longest prefix wins over claude-opus-5
  assert.equal(priceFor(prices, 'claude-opus-5').input, 5);
});

test('claude transcript: dedupes message.id, ignores partial last line, upserts on replay', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  const f = join(cfg.claudeDir, 'proj', 'sess-aaa.jsonl');
  const u1 = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } };
  const u2 = { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
  const partial = claudeLine('msg_3', '2026-10-03T11:03:00Z', { input_tokens: 1, output_tokens: 1 });
  await fs.writeFile(f, claudeLine('msg_1', '2026-10-03T11:01:00Z', u1) + claudeLine('msg_1', '2026-10-03T11:01:01Z', u1) + claudeLine('msg_2', '2026-10-03T11:02:00Z', u2)
    + '{"type":"user","message":{"role":"user","content":"hello"}}\n' + partial.slice(0, 60));
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  assert.equal(await ing.tick(), 2);
  let g = gens(lf.batches);
  assert.equal(g.length, 2);
  assert.equal(lf.batches[0].auth, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
  const g1 = g.find((x) => x.id === genIdOf('claude:msg_1'));
  assert.deepEqual(g1.usageDetails, { input: 10, output: 100, cache_read: 1000, cache_creation: 500 });
  // 10*4 + 100*20 + 1000*0.2 + 500*5 = 40+2000+200+2500 = 4740 per 1M
  assert.equal(g1.costDetails.total, 0.00474);
  assert.equal(g1.model, 'claude-opus-5-5');
  assert.equal(g1.traceId, traceIdOf('claude', 'sess-aaa'));
  assert.equal(g1.metadata.project, 'demo-repo');
  assert.ok(!JSON.stringify(lf.batches).includes('hello'), 'no prompt text is sent');
  const trace = lf.batches[0].body.batch.find((e) => e.type === 'trace-create').body;
  assert.ok(trace.tags.includes('agent:claude') && trace.tags.includes('project:demo-repo') && trace.tags.includes('model:claude-opus-5-5') && trace.tags.includes('day:2026-10-03'));

  // the partial line is completed later: exactly one new generation
  await fs.appendFile(f, partial.slice(60));
  lf.batches.length = 0;
  assert.equal(await ing.tick(), 1);
  assert.equal(gens(lf.batches).length, 1);
  assert.equal(gens(lf.batches)[0].id, genIdOf('claude:msg_3'));
  // nothing new -> nothing sent
  lf.batches.length = 0;
  assert.equal(await ing.tick(), 0);
  assert.equal(lf.batches.length, 0);

  // restart: offsets persisted, no resend
  const ing2 = createIngester(cfg, hooks);
  await ing2.init(false);
  assert.equal(await ing2.tick(), 0);
  const s = await ing2.summary();
  assert.equal(s.perAgent.claude.turns, 3);
  assert.equal(s.perProject['demo-repo'].output, 151);
  assert.equal(s.total.cache_read, 3000);
  assert.equal(s.perDay['2026-10-03'].turns, 3);
});

test('truncated file is re-read from the start; replay uses the same generation ids', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  const f = join(cfg.claudeDir, 'proj', 'sess-aaa.jsonl');
  const u = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  await fs.writeFile(f, claudeLine('msg_a', '2026-10-03T11:00:00Z', u) + claudeLine('msg_b', '2026-10-03T11:01:00Z', u));
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  await ing.tick();
  await fs.writeFile(f, claudeLine('msg_c', '2026-10-03T11:02:00Z', u));   // shorter than the saved offset
  lf.batches.length = 0;
  assert.equal(await ing.tick(), 1);
  assert.equal(gens(lf.batches)[0].id, genIdOf('claude:msg_c'));
});

test('failed send keeps offsets so the next pass retries', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  const f = join(cfg.claudeDir, 'proj', 'sess-aaa.jsonl');
  await fs.writeFile(f, claudeLine('msg_x', '2026-10-03T11:00:00Z', { input_tokens: 1, output_tokens: 1 }));
  const good = cfg.langfuseUrl;
  cfg.langfuseUrl = 'http://127.0.0.1:1';
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  await assert.rejects(ing.tick());
  cfg.langfuseUrl = good;
  assert.equal(await ing.tick(), 1);
});

test('codex rollout: one generation per token_usage_record, cached tokens split out', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  const rec = (resp, ts, usage) => JSON.stringify({ timestamp: ts, ordinal: 1, type: 'token_usage_record', payload: { session_id: 'codex-sess-1', response_id: resp, usage } }) + '\n';
  await fs.writeFile(join(cfg.codexDir, '2026/10/03/rollout-x.jsonl'),
    JSON.stringify({ timestamp: '2026-10-03T10:00:00Z', type: 'session_meta', payload: { session_id: 'codex-sess-1', cwd: '/work/demo-repo' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-10-03T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: '/work/demo-repo' } }) + '\n'
    + rec('resp_1', '2026-10-03T10:00:05Z', { input_tokens: 20000, cached_input_tokens: 15000, cache_write_input_tokens: 0, output_tokens: 300 })
    + rec('resp_2', '2026-10-03T10:00:09Z', { input_tokens: 21000, cached_input_tokens: 20000, cache_write_input_tokens: 0, output_tokens: 100 })
    + JSON.stringify({ timestamp: '2026-10-03T10:00:10Z', type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n');
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  assert.equal(await ing.tick(), 2);
  const g = gens(lf.batches);
  const g1 = g.find((x) => x.id === genIdOf('codex:resp_1'));
  assert.deepEqual(g1.usageDetails, { input: 5000, output: 300, cache_read: 15000, cache_creation: 0 });
  // 5000*10 + 300*50 + 15000*1 = 50000+15000+15000 = 80000 per 1M
  assert.equal(g1.costDetails.total, 0.08);
  assert.equal(g1.model, 'gpt-6-astra');
  assert.equal(g1.metadata.agent, 'codex');
  const s = await ing.summary();
  assert.equal(s.perAgent.codex.turns, 2);
  assert.equal(s.perModel['gpt-6-astra'].output, 400);
  // second turn: 1000*10 + 100*50 + 20000*1 = 35000 per 1M -> 0.035
  assert.equal(s.perAgent.codex.cost, 0.115);
});

test('summary: totals by day and outlier rule (>3x project median per active hour, >= 3 sessions)', () => {
  const mk = (trace, ts, cost) => ({ id: `x:${trace}:${ts}`, agent: 'claude', trace, label: trace, project: 'p', model: 'm', ts,
    usage: { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: { total: cost } });
  const t = NOW - 3600000;
  // 3 sessions, one active slot each (0.1 h floor not hit: 1 slot = 5 min = 0.083 -> floored to 0.1 h)
  const recs = [mk('a', t, 1), mk('b', t, 1.2), mk('c', t, 10), mk('old', NOW - 5 * 86400000, 50)];
  const s = buildSummary(recs, NOW, 14);
  assert.deepEqual(s.outliers.map((o) => o.session), ['c']);
  assert.equal(s.outliers[0].ratio, 8.3);
  assert.equal(s.perDay['2026-09-28'].cost, 50);
  assert.equal(buildSummary([mk('c', t, 10), mk('a', t, 1)], NOW).outliers.length, 0);   // < 3 sessions: no outliers
});

test('minimax runtime sqlite: rows become generations, subagent sessions roll up to the root', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const lf = await mockLangfuse();
  const { dir, cfg } = await fixture(lf);
  cfg.minimaxDb = join(dir, 'runtime-state.sqlite');
  const db = new DatabaseSync(cfg.minimaxDb);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, parent_session_id TEXT, workspace_dir TEXT);
    CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_name TEXT, framework_type TEXT, turn_id TEXT, model TEXT, ts INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, raw TEXT);
    INSERT INTO local_runtime_sessions VALUES ('mvs_root', NULL, '/work/demo-repo'), ('mvs_child', 'mvs_root', '/work/demo-repo');`);
  const ins = db.prepare('INSERT INTO local_runtime_token_usage VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('mvs_root', 'mavis', 'pi-agent', 't1', null, NOW - 60000, 100, 10, 0, 5000, 0, 0, '{}');
  ins.run('mvs_child', 'worker', 'pi-agent', 't2', null, NOW - 30000, 50, 20, 0, 1000, 0, 0, '{}');
  db.close();
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  assert.equal(await ing.tick(), 2);
  const g = gens(lf.batches);
  assert.equal(new Set(g.map((x) => x.traceId)).size, 1);
  assert.equal(g[0].model, 'MiniMax-M3');
  assert.equal(g[0].costDetails, undefined);          // no known price -> cost unknown, not guessed
  assert.equal((await ing.summary()).perAgent.minimax.unpriced, 2);
});

test('streamed message: output_tokens grows across lines with the same message.id; the largest wins, also across passes', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  const f = join(cfg.claudeDir, 'proj', 'sess-aaa.jsonl');
  const u = (out) => ({ input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
  await fs.writeFile(f, claudeLine('msg_s', '2026-10-03T11:00:00Z', u(1)) + claudeLine('msg_s', '2026-10-03T11:00:01Z', u(393)) + claudeLine('msg_s', '2026-10-03T11:00:02Z', u(5)));
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  assert.equal(await ing.tick(), 1);
  assert.equal(gens(lf.batches)[0].usageDetails.output, 393);
  // a later, larger line for an already-sent message is re-sent as an update (same generation id, original start time)
  await fs.appendFile(f, claudeLine('msg_s', '2026-10-03T11:00:05Z', u(500)));
  lf.batches.length = 0;
  assert.equal(await ing.tick(), 1);
  const g = gens(lf.batches)[0];
  assert.equal(g.id, genIdOf('claude:msg_s'));
  assert.equal(g.usageDetails.output, 500);
  assert.equal(g.startTime, '2026-10-03T11:00:00.000Z');
  const s = await ing.summary();
  assert.equal(s.total.turns, 1);
  assert.equal(s.total.output, 500);
  // restart keeps the last version per id
  const ing2 = createIngester(cfg, hooks);
  await ing2.init(false);
  assert.equal((await ing2.summary()).total.output, 500);
});

const mgrLines = () => [
  { type: 'stall', id: 'st-1', session: 'vpt-jev', project: 'virtualpytest', at: '2026-10-03T11:00:00.000Z', case: 'done', excerpt: 'SECRET closing text', jev: { choice: 'continue', confidence: 0.9, cost: 0.00002, ms: 640, model: 'typesafe/jev-1.13', decision_id: 'd1' } },
  { type: 'stall', id: 'st-2', session: 'vpt-jev', at: '2026-10-03T11:05:00.000Z', case: 'done', jev: { error: 'OpenRouter 402: insufficient credits', ms: 400 } },
  { type: 'stall', id: 'st-3', session: 'vpt-jev', at: '2026-10-03T11:06:00.000Z', jev: { skipped: 'daily budget reached' } },
  { type: 'stall', id: 'st-4', session: 'vpt-jev', at: '2026-10-03T11:07:00.000Z', jev: null },
  { type: 'triage', id: 'st-1', session: 'vpt-jev', at: '2026-10-03T11:00:02.000Z', case: 'owner_decision', mode: 'simulate', ai: { proposed_reply: 'SECRET reply' }, cost: 0.0045, costEstimated: true, ms: 2100, model: 'anthropic/claude-sonnet', tin: 1000, tout: 100 },
  { type: 'triage', id: 'st-2', session: 'vpt-jev', at: '2026-10-03T11:05:03.000Z', error: 'reviewer 402', cost: 0, ms: 300 },
  { type: 'triage', id: 'st-3', session: 'vpt-jev', at: '2026-10-03T11:06:03.000Z', skipped: 'not configured' },
].map((o) => JSON.stringify(o) + '\n').join('');

test('manager records: jev results and reviewer calls become records, skipped calls and texts do not', () => {
  const L = mgrLines().trim().split('\n').map((l) => parseManagerLine(JSON.parse(l)));
  assert.deepEqual(L.map((r) => r && r.id), ['manager:jev:st-1', 'manager:jev:st-2', null, null, 'manager:ai:st-1', 'manager:ai:st-2', null]);
  assert.equal(L[0].cost.total, 0.00002);
  assert.equal(L[1].cost.total, 0, 'a failed call costs nothing and is not "unpriced"');
  assert.equal(L[4].costEstimated, true);
  assert.deepEqual([L[4].usage.input, L[4].usage.output], [1000, 100]);
  assert.doesNotMatch(JSON.stringify(L), /SECRET/);
});

test('AI reviewer generation: prompt name + version always; proposal as output only on opt-in (LFEVAL_SEND_AI_OUTPUT=1)', async () => {
  const rec = { type: 'triage', id: 'st-p', session: 'vpt-jev', at: '2026-10-03T11:00:02.000Z', case: 'owner_decision', mode: 'simulate', src: 'jev', flags: ['mentions a deploy'],
    prompt: { name: 'ghosty-ai-reviewer', version: 7 }, ai: { proposed_reply: 'Yes, continue.', reasoning: 'only asks to carry on', confidence: 0.9, owner_needed: false, owner_needed_why: '' }, cost: 0.001, model: 'm', tin: 5, tout: 5 };
  const off = parseManagerLine(rec);
  assert.deepEqual(off.prompt, { name: 'ghosty-ai-reviewer', version: 7 });
  assert.equal(off.output, undefined);
  assert.equal(off.extra.judgeable, undefined);
  const on = parseManagerLine(rec, { sendAiOutput: true });
  assert.deepEqual(on.input, { case: 'owner_decision', source: 'jev', mode: 'simulate', flags: ['mentions a deploy'] });
  assert.equal(on.output.proposed_reply, 'Yes, continue.');
  assert.equal(on.extra.judgeable, 'yes');
  const ev = langfuseEvents([{ ...on, trace: 't1', label: 'vpt-jev' }], new Map([['t1', { first: on.ts, models: new Set(['m']), days: new Set() }]]), 0).find((e) => e.type === 'generation-create').body;
  assert.equal(ev.promptName, 'ghosty-ai-reviewer');
  assert.equal(ev.promptVersion, 7);
  assert.equal(ev.output.reasoning, 'only asks to carry on');
  const plain = langfuseEvents([{ ...off, trace: 't1', label: 'vpt-jev' }], new Map([['t1', { first: off.ts, models: new Set(['m']), days: new Set() }]]), 0).find((e) => e.type === 'generation-create').body;
  assert.equal(plain.output, undefined);
  assert.equal(plain.promptVersion, 7);
});

test('manager calls reach Langfuse: one generation per call under the session trace, failures ERROR, replays upsert, summary has a manager agent', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  await fs.mkdir(cfg.stateDir, { recursive: true });
  await fs.writeFile(cfg.stallsFile, mgrLines());
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  assert.equal(await ing.tick(), 4);
  const g = gens(lf.batches);
  const by = Object.fromEntries(g.map((x) => [x.name + ':' + (x.level || 'ok') + ':' + x.metadata.case, x]));
  assert.equal(g.length, 4);
  const jev = by['manager.jev:ok:done'];
  assert.equal(jev.model, 'typesafe/jev-1.13');
  assert.equal(jev.costDetails.total, 0.00002);
  assert.equal(jev.id, genIdOf('manager:jev:st-1'));
  assert.equal(jev.traceId, traceIdOf('manager', 'vpt-jev'));
  const err = g.find((x) => x.name === 'manager.jev' && x.level === 'ERROR');
  assert.equal(err.statusMessage, 'OpenRouter 402: insufficient credits');
  const rev = by['manager.ai-review:ok:owner_decision'];
  assert.deepEqual([rev.usageDetails.input, rev.usageDetails.output, rev.metadata.costEstimated, rev.model], [1000, 100, true, 'anthropic/claude-sonnet']);
  assert.equal(g.filter((x) => x.name === 'manager.ai-review' && x.level === 'ERROR').length, 1);
  const traces = lf.batches.flatMap((b) => b.body.batch).filter((e) => e.type === 'trace-create').map((e) => e.body);
  assert.equal(traces.length, 1);
  assert.ok(traces[0].tags.includes('agent:manager') && traces[0].tags.includes('session:vpt-jev'));
  const s = await ing.summary();
  assert.equal(s.perAgent.manager.turns, 4);
  assert.equal(s.perAgent.manager.unpriced, 0);
  assert.equal(s.perAgent.manager.cost, 0.00452);
  assert.equal(s.perModel['typesafe/jev-1.13'].agent, 'manager');
  // incremental: only new lines are read; a rewind (--backfill style replay) re-sends the same ids
  lf.batches.length = 0;
  assert.equal(await ing.tick(), 0);
  await fs.appendFile(cfg.stallsFile, JSON.stringify({ type: 'stall', id: 'st-9', session: 'vpt-x', at: '2026-10-03T11:30:00.000Z', jev: { choice: 'ask_owner', cost: 0.00002 } }) + '\n');
  assert.equal(await ing.tick(), 1);
  const ing2 = createIngester(cfg, hooks);
  await ing2.init(true);
  lf.batches.length = 0;
  assert.equal(await ing2.tick(), 5);
  assert.equal(gens(lf.batches).find((x) => x.name === 'manager.jev' && !x.level && x.metadata.decision === 'continue').id, jev.id, 'deterministic ids');
});

test('buildSummary: perDayModel splits each UTC day by model', () => {
  const mk = (ts, model, input) => ({ ts, model, agent: 'claude', label: 'x', trace: 't', project: 'p',
    usage: { input, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost: { total: 1 } });
  const s = buildSummary([mk(NOW - 1000, 'a', 5), mk(NOW - 1000, 'b', 7), mk(NOW - 86400000, 'a', 3)], NOW);
  assert.deepEqual(Object.keys(s.perDayModel), ['2026-10-02', '2026-10-03']);
  assert.equal(s.perDayModel['2026-10-03'].a.total, 5);
  assert.equal(s.perDayModel['2026-10-03'].b.total, 7);
  assert.equal(s.perDayModel['2026-10-02'].a.total, 3);
});

test('tailer eval pass: labels in stalls.jsonl become scores + a dataset item; own state file, tailer offsets untouched', async () => {
  const lf = await mockLangfuse();
  const { cfg } = await fixture(lf);
  await fs.mkdir(cfg.stateDir, { recursive: true });
  const L = [...mgrLines().trim().split('\n').map((l) => JSON.parse(l)), { type: 'label', id: 'st-1', by: 'owner', label: 'legit', at: '2026-10-03T11:30:00.000Z' }];
  await fs.writeFile(cfg.stallsFile, L.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const before = await fs.readFile(cfg.stallsFile, 'utf8');
  const ing = createIngester(cfg, hooks);
  await ing.init(false);
  await ing.tick();
  const r = await ing.evalPass();
  assert.equal(r.scores, 4, 'verdict + case on the jev and the ai generation');
  assert.equal(r.items, 1);
  const sc = lf.batches.flatMap((b) => b.body?.batch || []).filter((e) => e.type === 'score-create').map((e) => e.body);
  assert.deepEqual(sc.map((s) => s.observationId).sort(), [genIdOf('manager:ai:st-1'), genIdOf('manager:ai:st-1'), genIdOf('manager:jev:st-1'), genIdOf('manager:jev:st-1')].sort());
  assert.ok(lf.batches.some((b) => b.url === '/api/public/dataset-items' && b.body.id === 'st-1'));
  assert.ok((await fs.stat(cfg.evalStateFile)).isFile());
  assert.equal(await fs.readFile(cfg.stallsFile, 'utf8'), before, 'the log is only read');
  assert.equal((await ing.evalPass()).skipped, 'nothing new');
});
