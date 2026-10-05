// manager-wakes.js: splitting a (synthetic) Claude transcript into wakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitWakes, parseJsonl, summarizeWakes, wakesOfDay, classifyTrigger, findManagerTranscripts, computeWakes, writeWakesFile, createWakesView } from '../manager-wakes.js';

const PRICES = { models: { 'claude-test-1': { input: 10, output: 50, cache_write: 12.5, cache_write_1h: 20, cache_read: 1 } } };
const T = (m, s = 0) => new Date(Date.UTC(2026, 0, 1, 10, m, s)).toISOString();
const user = (at, content, extra = {}) => ({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra });
const owner = (at, text) => user(at, text, { origin: { kind: 'human' }, promptSource: 'typed' });
const notif = (at, body, extra = {}) => user(at, `<task-notification>\n${body}\n</task-notification>`, { origin: { kind: 'task-notification' }, ...extra });
const asst = (at, id, blocks, usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }) =>
  ({ type: 'assistant', timestamp: at, message: { id, model: 'claude-test-1', role: 'assistant', content: blocks, usage } });
const tool = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });

const transcript = () => [
  { type: 'custom-title', title: 'x' },
  owner(T(0), 'please   check\nthe queue'),
  asst(T(0, 5), 'm1', [text('Checking the queue now.\nMore detail'), tool('t1', 'Bash', { command: 'curl -s localhost/api/alert -d {}' })]),
  asst(T(0, 5), 'm1', [text('Checking the queue now.\nMore detail'), tool('t1', 'Bash', { command: 'curl -s localhost/api/alert -d {}' })]),   // same message written twice
  user(T(0, 6), [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  asst(T(0, 9), 'm2', [text('Alert sent.'), tool('t2', 'Bash', { command: 'curl localhost/api/send/foo -d x' })]),
  notif(T(5), '<task-id>b1</task-id>\n<summary>Monitor event: stall</summary>\n<event>session foo asks something</event>'),
  asst(T(5, 3), 'm3', [text('Nothing to do.'), tool('t3', 'Bash', { command: 'echo "{}" >> ~/.local/state/ghosty/manager-actions.jsonl' })]),
  notif(T(10), '<task-id>b1</task-id>\n<summary>m</summary>\n<event>[Monitor expired after 30m with no events delivered.]</event>'),
  asst(T(10, 2), 'm4', [text('Re-arming.'), tool('t4', 'Monitor', {})]),
  user(T(60), 'Manager hourly sweep: look around', { isMeta: true, promptSource: 'scheduled' }),
  asst(T(60, 4), 'm5', [text('Sweep done, all quiet.')]),
  notif(T(65), '<task-id>a0123456789abcdef</task-id>\n<tool-use-id>tX</tool-use-id>\n<status>completed</status>\n<summary>worker finished</summary>'),
  asst(T(65, 2), 'm6', [text('Reviewing worker.'), tool('t5', 'Write', { file_path: '/x' })]),
  user(T(69), '', { origin: { kind: 'human' } }),   // empty prompt: no wake
  user(T(70), 'hello', { origin: { kind: 'peer', body: 'deploy is stuck' }, isMeta: true }),
  { type: 'future-record-type', timestamp: T(71), x: 1 },
  asst(T(71, 1), 'm7', [tool('t6', 'Agent', { prompt: 'p' }), tool('t7', 'Bash', { command: 'mcode exec "do it"' })]),
];

test('splits into wakes with trigger, summary, counts, decision and times', () => {
  const w = splitWakes(transcript(), { prices: PRICES });
  assert.deepEqual(w.map((x) => x.trigger), ['owner', 'monitor_event', 'monitor_expired', 'sweep', 'subagent_done', 'peer_message']);
  assert.equal(w[0].triggerSummary, 'please check the queue');
  assert.equal(w[0].start, T(0)); assert.equal(w[0].end, T(0, 9)); assert.equal(w[0].durationSec, 9);
  assert.equal(w[0].alertsSent, 1); assert.equal(w[0].sendsToSessions, 1); assert.equal(w[0].tools.Bash, 2);
  assert.equal(w[0].decision, 'Alert sent.');
  assert.equal(w[1].triggerSummary, 'session foo asks something');
  assert.equal(w[2].triggerSummary, '[Monitor expired after 30m with no events delivered.]');
  assert.equal(w[5].workersStarted, 2);   // Agent + mcode exec
  assert.equal(w[5].triggerSummary, 'deploy is stuck');
});

test('the agent action log does not count as a file write; real writes do', () => {
  const w = splitWakes(transcript(), { prices: PRICES });
  assert.equal(w[1].fileWrites, 0); assert.equal(w[1].nothing, true);
  assert.equal(w[3].nothing, true);
  assert.equal(w[4].fileWrites, 1); assert.equal(w[4].nothing, false);
});

test('pricing: tokens summed per message id (duplicate lines once), usd from the shared price table', () => {
  const w = splitWakes(transcript(), { prices: PRICES });
  assert.deepEqual(w[0].tokens, { input: 200, output: 20, cache_read: 2000, cache_write: 0 });   // m1 once + m2
  // 200*10 + 20*50 + 2000*1 = 2000+1000+2000 = 5000 per million
  assert.equal(w[0].usd, 0.005);
  const u = splitWakes([owner(T(0), 'x'), asst(T(0, 1), 'a', [text('y')], { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 } })], { prices: PRICES });
  assert.equal(u[0].usd, 32.5);
  const unknown = splitWakes([owner(T(0), 'x'), { ...asst(T(0, 1), 'a', [text('y')]), message: { ...asst(T(0, 1), 'a', [text('y')]).message, model: 'mystery' } }], { prices: PRICES });
  assert.equal(unknown[0].usd, null);
});

test('bad lines, unknown records and tool results never start a wake', () => {
  const recs = parseJsonl('not json\n\n42\n' + JSON.stringify(owner(T(0), 'hi')) + '\n{"type":"user"}\n' + JSON.stringify(user(T(1), [{ type: 'tool_result', content: 'x' }])) + '\n');
  const w = splitWakes(recs, { prices: PRICES });
  assert.equal(w.length, 1);
  assert.equal(classifyTrigger(user(T(0), 'x', { isSidechain: true, origin: { kind: 'human' } })), null);
  assert.equal(classifyTrigger(user(T(0), 'meta', { isMeta: true })), null);
  assert.deepEqual(splitWakes([], {}), []);
  assert.deepEqual(splitWakes([null, 3, 'x', {}], {}), []);
});

test('summary: by trigger, usd, top 5, share that did nothing; day filter', () => {
  const w = splitWakes(transcript(), { prices: PRICES });
  const s = summarizeWakes(w);
  assert.equal(s.count, 6); assert.equal(s.byTrigger.owner, 1); assert.equal(s.nothing, 3);
  assert.equal(s.nothingShare, 0.5); assert.equal(s.top.length, 5); assert.equal(s.top[0].trigger, 'owner');
  assert.equal(wakesOfDay(w, '2026-01-01').length, 6); assert.equal(wakesOfDay(w, '2026-01-02').length, 0);
});

test('finds the transcript through the ledger label, writes the day file idempotently, serves the cached view', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghosty-wakes-'));
  const stateDir = join(root, 'state'), claudeDir = join(root, 'projects');
  const sid = '11111111-2222-3333-4444-555555555555', other = '99999999-2222-3333-4444-555555555555';
  mkdirSync(stateDir); mkdirSync(join(claudeDir, '-proj'), { recursive: true });
  writeFileSync(join(stateDir, 'usage-ledger.jsonl'),
    [{ agent: 'claude', session: sid, label: 'manager', subagent: false }, { agent: 'claude', session: other, label: 'builder', subagent: false }, { agent: 'claude', session: other, label: 'manager', subagent: true }]
      .map((r) => JSON.stringify(r)).join('\n') + '\nbad\n');
  writeFileSync(join(claudeDir, '-proj', `${sid}.jsonl`), transcript().map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(claudeDir, '-proj', `${other}.jsonl`), '');
  const pricesFile = join(root, 'prices.json'); writeFileSync(pricesFile, JSON.stringify(PRICES));
  assert.deepEqual((await findManagerTranscripts({ stateDir, claudeDir })).map((x) => x.session), [sid]);
  const { wakes } = await computeWakes({ stateDir, claudeDir, day: '2026-01-01', pricesFile });
  assert.equal(wakes.length, 6);
  const f = await writeWakesFile(stateDir, wakes); const a = readFileSync(f, 'utf8');
  await writeWakesFile(stateDir, wakes); assert.equal(readFileSync(f, 'utf8'), a);
  assert.equal(a.trim().split('\n').length, 6);
  let t = 0; const view = createWakesView({ stateDir, claudeDir, pricesFile, now: () => t });
  const v1 = await view('2026-01-01'); assert.equal(v1.summary.count, 6);
  writeFileSync(join(claudeDir, '-proj', `${sid}.jsonl`), '');
  t = 30000; assert.equal((await view('2026-01-01')).summary.count, 6);   // cached
  t = 61000; assert.equal((await view('2026-01-01')).summary.count, 0);
});

test('writeWakesFile with a day keeps other days; startWakesLogger refreshes today', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeWakesFile, startWakesLogger } = await import('../manager-wakes.js');
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-wk-'));
  await writeWakesFile(dir, [{ start: '2026-10-04T10:00:00Z', n: 1 }]);
  await writeWakesFile(dir, [{ start: '2026-10-05T10:00:00Z', n: 2 }], '2026-10-05');
  await writeWakesFile(dir, [{ start: '2026-10-05T11:00:00Z', n: 3 }], '2026-10-05');
  const rows = readFileSync(join(dir, 'manager-wakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n);
  assert.deepEqual(rows, [1, 3]);
  const lg = startWakesLogger({ stateDir: dir, claudeDir: join(dir, 'none'), intervalMs: 1e9, now: () => Date.parse('2026-10-06T12:00:00Z') });
  await lg.run(); lg.stop();
  assert.deepEqual(readFileSync(join(dir, 'manager-wakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n), [1, 3]);
});
