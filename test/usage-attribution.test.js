import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIngester, defaults, OPENCODE_SQL, normalizeMinimaxModel } from '../usage/ingest.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const servers = [];
after(() => servers.forEach((x) => { x.closeAllConnections(); x.close(); }));
const lf = () => new Promise((ok) => {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(207, { 'content-type': 'application/json' }); res.end('{"successes":[],"errors":[]}'); }); });
  servers.push(srv); srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`));
});
async function setup() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'usage-attr-'));
  const stateDir = join(dir, 'state');
  const cfg = { ...defaults({ GHOSTY_STATE_DIR: stateDir }), langfuseUrl: await lf(), publicKey: 'pk', secretKey: 'sk', stateDir, now: () => NOW, paceMs: 0,
    claudeDir: join(dir, 'c'), codexDir: join(dir, 'x'), minimaxDb: join(dir, 'none-mm.sqlite'), opencodeDb: join(dir, 'none-oc.sqlite') };
  Object.assign(cfg, { offsetsFile: join(stateDir, 'usage-offsets.json'), ledgerFile: join(stateDir, 'usage-ledger.jsonl'), summaryFile: join(stateDir, 'usage-summary.json'), stallsFile: join(stateDir, 'stalls.jsonl'), evalStateFile: join(stateDir, 'lfeval-state.json') });
  await fs.mkdir(stateDir, { recursive: true });
  return { dir, cfg, stateDir };
}
const hooks = { projectOf: async () => 'demo', tmuxPanes: async () => [] };
const ledger = async (cfg) => (await fs.readFile(cfg.ledgerFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const started = (name, provider, model, cwd, ts) => JSON.stringify({ kind: 'session.started', name, provider, model, cwd, started_by: 'cbsession', ts, prompt_ref: null, handover_ref: null }) + '\n';
function minimaxDb(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, parent_session_id TEXT, workspace_dir TEXT);
    CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER);
    INSERT INTO local_runtime_sessions VALUES ('s1', NULL, '/work/mm-one'), ('s2', NULL, '/work/mm-two');`);
  const ins = db.prepare('INSERT INTO local_runtime_token_usage VALUES (NULL,?,?,?,?,?,?)');
  for (const r of rows) ins.run(...r);
  db.close();
}

test('minimax: model from the launch (prefix stripped), default only when unknown, source marked', async () => {
  const { dir, cfg, stateDir } = await setup();
  cfg.minimaxDb = join(dir, 'mm.sqlite');
  minimaxDb(cfg.minimaxDb, [['s1', NOW - 60000, 10, 5, 100, 0], ['s2', NOW - 50000, 10, 5, 100, 0]]);
  await fs.writeFile(join(stateDir, 'session-history.jsonl'), started('mm-a', 'minimax', 'minimax/MiniMax-M3.1-Flash-Preview', '/work/mm-one', NOW - 3600000));
  const ing = createIngester(cfg, hooks); await ing.init(false);
  assert.equal(await ing.tick(), 2);
  const [a, b] = await ledger(cfg);
  assert.deepEqual([a.model, a.model_source, a.label], ['MiniMax-M3.1-Flash-Preview', 'launch', 'mm-a']);
  assert.deepEqual([b.model, b.model_source], ['MiniMax-M3', 'default']);
  assert.equal(normalizeMinimaxModel('minimax/X'), 'X');
});

test('no session-history file: behaviour unchanged (default model, cwd-name label)', async () => {
  const { dir, cfg } = await setup();
  cfg.minimaxDb = join(dir, 'mm.sqlite');
  minimaxDb(cfg.minimaxDb, [['s1', NOW - 60000, 10, 5, 100, 0]]);
  const ing = createIngester(cfg, hooks); await ing.init(false);
  await ing.tick();
  const [a] = await ledger(cfg);
  assert.deepEqual([a.model, a.label], ['MiniMax-M3', 'mm-one']);
});

function ocDb(path, msgs) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT, token TEXT); INSERT INTO credential VALUES ('c', 'FAKE-SECRET');`);
  const ins = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  for (const m of msgs) ins.run(m.id, 'ses_1', m.t, m.t, JSON.stringify(m.data));
  db.close();
}
const asst = (provider, cost, extra = {}) => ({ role: 'assistant', path: { cwd: '/work/oc-repo' }, cost, tokens: { total: 0, input: 100, output: 20, reasoning: 5, cache: { write: 7, read: 900 } },
  modelID: 'some-model', providerID: provider, time: { created: 1, completed: 2 }, ...extra });

test('opencode: assistant rows ingested incrementally, cost only when metered and > 0', async () => {
  const { dir, cfg, stateDir } = await setup();
  cfg.opencodeDb = join(dir, 'opencode.db');
  ocDb(cfg.opencodeDb, [
    { id: 'm1', t: NOW - 5 * 3600000, data: asst('openrouter', 0.5) },
    { id: 'm2', t: NOW - 4 * 3600000, data: asst('opencode', 0.7) },          // not metered -> unknown
    { id: 'm3', t: NOW - 3 * 3600000, data: asst('openrouter', 0) },          // zero is unknown
    { id: 'm4', t: NOW - 2 * 3600000, data: { role: 'user', text: 'hello' } },
    { id: 'm5', t: NOW - 1 * 3600000, data: asst('openrouter', 0.1, { time: { created: 1 } }) },   // old, never completed: still taken after 1h grace
  ]);
  await fs.writeFile(join(stateDir, 'session-history.jsonl'), started('oc-sess', 'opencode', null, '/work/oc-repo', NOW - 6 * 3600000));
  const ing = createIngester(cfg, hooks); await ing.init(false);
  assert.equal(await ing.tick(), 4);
  let rows = await ledger(cfg);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['opencode:m1'].model, 'openrouter/some-model');
  assert.deepEqual(by['opencode:m1'].usage, { input: 100, output: 25, cache_read: 900, cache_write_5m: 7, cache_write_1h: 0 });
  assert.equal(by['opencode:m1'].cost.total, 0.5);
  assert.equal(by['opencode:m2'].cost, null);
  assert.equal(by['opencode:m3'].cost, null);
  assert.equal(by['opencode:m1'].agent, 'opencode');
  assert.equal(by['opencode:m1'].label, 'oc-sess');
  assert.ok(!JSON.stringify(rows).includes('FAKE-SECRET') && !JSON.stringify(rows).includes('hello'));
  assert.equal(await ing.tick(), 0);   // cursor remembered
  const w = new DatabaseSync(cfg.opencodeDb); w.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m6', 's', NOW - 1000, 0, JSON.stringify(asst('openrouter', 0.2))); w.close();
  assert.equal(await ing.tick(), 1);
});

test('opencode: a message still streaming holds the cursor, then is ingested once complete', async () => {
  const { dir, cfg } = await setup();
  cfg.opencodeDb = join(dir, 'opencode.db');
  ocDb(cfg.opencodeDb, [{ id: 'a', t: NOW - 1000, data: asst('openrouter', 0, { time: { created: 1 } }) }]);
  const ing = createIngester(cfg, hooks); await ing.init(false);
  assert.equal(await ing.tick(), 0);
  const w = new DatabaseSync(cfg.opencodeDb); w.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(asst('openrouter', 0)), 'a'); w.close();
  assert.equal(await ing.tick(), 1);
});

test('opencode SQL reads only the message table', () => {
  const tables = [...OPENCODE_SQL.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(tables, ['message']);
  assert.ok(!/\bdata\s*(,|FROM)|SELECT\s+\*/i.test(OPENCODE_SQL.replace(/json_extract\(data[^)]*\)/g, '')), 'raw data column is never selected');
  assert.ok(!/account|credential/i.test(OPENCODE_SQL));
});

test('label: short-lived session keeps its own name from session-history (claude, tmux gone)', async () => {
  const { cfg, stateDir } = await setup();
  await fs.mkdir(join(cfg.claudeDir, 'p'), { recursive: true });
  const line = JSON.stringify({ type: 'assistant', sessionId: 'sess-1', cwd: '/work/short', timestamp: new Date(NOW - 7200000).toISOString(),
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }) + '\n';
  await fs.writeFile(join(cfg.claudeDir, 'p', 'sess-1.jsonl'), line);
  await fs.writeFile(join(stateDir, 'session-history.jsonl'), started('quick-fix', 'claude', 'claude-opus-5-5', '/work/short', NOW - 8000000));
  const ing = createIngester(cfg, hooks); await ing.init(false);
  await ing.tick();
  assert.equal((await ledger(cfg))[0].label, 'quick-fix');
});
