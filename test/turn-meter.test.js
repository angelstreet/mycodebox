import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusLine, stripSeparator } from '../stall.js';
import { createReporter } from '../reporter.js';
import { createManagerEvents } from '../manager-events.js';
import { createTurnMeter, normalizeUsage, ledgerTokens, formatDuration, formatTokens, statusMeterLine, buildLastTurn, verdictOf, clipInfo, INFO_MAX } from '../turn-meter.js';

test('separator stripping: em dash, en dash, hyphen, colon, middle dot; text that merely starts with a dash stays', () => {
  for (const sep of ['—', '–', ':', '·', ' — ', '- ', ': ', '· ']) {
    assert.equal(statusLine([`STATUS: done ${sep}branch x pushed`]).text, 'branch x pushed', JSON.stringify(sep));
  }
  assert.equal(statusLine(['STATUS: done — branch x pushed (abc123), tsc+lint pass, left: 23 tables']).text, 'branch x pushed (abc123), tsc+lint pass, left: 23 tables');
  assert.equal(statusLine(['STATUS: waiting: deploy d-12 --server']).text, 'deploy d-12 --server');
  assert.equal(statusLine(['STATUS: handoff: lease -> task58-b by 14:30']).text, 'lease -> task58-b by 14:30');
  assert.equal(statusLine(['**STATUS: needs-owner:** ship it? [1 yes, 2 no]']).text, 'ship it? [1 yes, 2 no]');
  assert.equal(statusLine(['STATUS: done']).text, '');
  assert.equal(statusLine(['STATUS: done —']).text, '');
  assert.equal(statusLine(['STATUS: done']).kind, 'done');
  assert.equal(stripSeparator('--flag stays'), '--flag stays');
});

test('formatting: duration, tokens, the line; every unknown part is left out', () => {
  assert.equal(formatDuration(241000), '4m 01s');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(3720000), '1h 02m');
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(-5), null);
  assert.equal(formatTokens(1_300_000), '1.3M tok');
  assert.equal(formatTokens(812_000), '812k tok');
  assert.equal(formatTokens(950), '950 tok');
  assert.equal(formatTokens(undefined), null);
  const tokens = { in: 10, out: 20, cacheRead: 1_299_000, cacheWrite: 970, total: 1_300_000 };
  assert.equal(statusMeterLine({ status: 'done', elapsedMs: 241000, tokens, info: 'branch x pushed' }), 'STATUS: done · 4m 01s · 1.3M tok · branch x pushed');
  assert.equal(statusMeterLine({ status: 'done', tokens, info: 'x' }), 'STATUS: done · 1.3M tok · x');
  assert.equal(statusMeterLine({ status: 'done', elapsedMs: 5000 }), 'STATUS: done · 5s');
  assert.equal(statusMeterLine({ status: 'done' }), 'STATUS: done');
  assert.equal(statusMeterLine({ elapsedMs: 5000 }), null, 'no verdict, no line');
  assert.ok(clipInfo('x'.repeat(500)).length <= INFO_MAX);
  assert.ok(statusMeterLine({ status: 'done', info: 'y'.repeat(900) }).length < 230);
});

test('usage normalising: reporter and ledger shapes, nothing invented', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6, model: 'm' }), { in: 3, out: 4, cacheRead: 5, cacheWrite: 6, total: 18 });
  assert.deepEqual(normalizeUsage({ input: 1, output: 2, cache_read: 3, cache_write_5m: 4, cache_write_1h: 5 }), { in: 1, out: 2, cacheRead: 3, cacheWrite: 9, total: 15 });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ input_tokens: 0, output_tokens: 0 }), null);
});

test('ledger delta: only the session label inside the window', () => {
  const u = (n) => ({ input: n, output: n, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
  const rows = [{ label: 'a', ts: 100, usage: u(1) }, { label: 'a', ts: 200, usage: u(2) }, { label: 'b', ts: 200, usage: u(50) }, { label: 'a', ts: 900, usage: u(9) }, { label: 'a', ts: 150 }];
  assert.deepEqual(ledgerTokens(rows, 'a', 150, 300), { in: 2, out: 2, cacheRead: 0, cacheWrite: 0, total: 4 });
  assert.equal(ledgerTokens(rows, 'a', 300, 400), null);
  assert.equal(ledgerTokens(rows, 'zzz', 0, 1000), null);
});

test('verdict + lastTurn: missing values are omitted, nothing at all is null', () => {
  assert.deepEqual(verdictOf(['work', '', 'STATUS: blocked — lease held']), { status: 'blocked', info: 'lease held' });
  assert.equal(verdictOf(['no verdict here']), null);
  const lt = buildLastTurn({ at: 1, elapsedMs: 4000, tokens: null, verdict: { status: 'done', info: '' }, source: 'ledger' });
  assert.equal(lt.tokens, null);
  assert.equal(lt.line, 'STATUS: done · 4s');
  assert.equal(buildLastTurn({ verdict: null, tokens: null }), null);
  assert.equal(buildLastTurn({ elapsedMs: 3000, verdict: null }).line, null);
});

test('reporter: a turn is metered prompt -> turn end, tokens summed from the usage, a new prompt starts over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-tm-'));
  let clock = 5_000_000;
  const rep = createReporter({ stateDir: dir, now: () => clock });
  await rep.init();
  const ev = (event, extra = {}) => ({ v: 1, event, session: 's1', sessionId: 'sid', cwd: '/x', at: clock, ...extra });
  const use = (i, o, r, w) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w, model: 'm' });
  rep.ingest(ev('session.start'));
  rep.ingest(ev('prompt', { text: 'go', midTurn: false }));
  assert.equal(rep.meterOf('s1'), null, 'a running turn has no meter yet');
  clock += 1000;
  rep.ingest(ev('prompt', { text: 'also this', midTurn: true }));   // typed mid-turn: same turn
  clock += 120_000;
  rep.ingest(ev('turn.end', { text: 'sub', agentId: 'ag', usage: use(1, 2, 3, 4) }));   // a subagent's tokens belong to the turn
  clock += 119_000;
  rep.ingest(ev('turn.end', { text: 'done\nSTATUS: done — x', reason: 'answer', durationMs: 1, usage: use(10, 20, 1000, 100) }));
  const m = rep.meterOf('s1');
  assert.equal(m.elapsedMs, 240_000);
  assert.deepEqual(m.tokens, { in: 11, out: 22, cacheRead: 1003, cacheWrite: 104, total: 1140 });
  assert.match(m.text, /STATUS: done/);
  rep.ingest(ev('turn.end', { text: 'late subagent', agentId: 'ag', usage: use(500, 500, 0, 0) }));   // after the end: not added
  assert.equal(rep.meterOf('s1').tokens.total, 1140);
  clock += 10_000;
  rep.ingest(ev('prompt', { text: 'next', midTurn: false }));
  assert.equal(rep.meterOf('s1'), null);
  clock += 2000;
  rep.ingest(ev('turn.end', { text: 'ok', reason: 'answer' }));   // no usage reported: no tokens, never invented
  const m2 = rep.meterOf('s1');
  assert.equal(m2.elapsedMs, 2000);
  assert.equal(m2.tokens, null);
});

test('reporter: without a seen prompt the hook duration is the elapsed time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-tm-'));
  const rep = createReporter({ stateDir: dir, now: () => 9_000_000 });
  await rep.init();
  rep.ingest({ v: 1, event: 'turn.end', session: 's2', sessionId: 'x', text: 't', durationMs: 7000 });
  assert.equal(rep.meterOf('s2').elapsedMs, 7000);
});

test('turn meter (Codex / MiniMax): ledger delta since the send, elapsed send -> stop; unknown stop time omits both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-tm-'));
  const ledgerFile = join(dir, 'usage-ledger.jsonl');
  const row = (label, ts, n) => JSON.stringify({ id: `codex:${ts}`, agent: 'codex', label, ts, usage: { input: n, output: n, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } });
  writeFileSync(ledgerFile, [row('cx', 1000, 7), row('cx', 61_000, 100), row('cx', 121_000, 200), row('other', 100_000, 9999), 'not json'].join('\n') + '\n');
  let clock = 200_000;
  const meter = createTurnMeter({ ledgerFile, now: () => clock, ttlMs: 0 });
  await meter.refresh();
  const plain = ['● did it', '', 'STATUS: done — pushed', ''];
  const lt = meter.compute({ name: 'cx', agent: 'codex', sentAt: 60_000, stopAt: 125_000, plain });
  assert.equal(lt.elapsedMs, 65_000);
  assert.equal(lt.tokens.total, 600);
  assert.equal(lt.line, 'STATUS: done · 1m 05s · 600 tok · pushed');
  assert.equal(lt.source, 'ledger');
  // stop predates ghosty (stopAt unknown): only the verdict
  const lt2 = meter.compute({ name: 'cx', agent: 'codex', sentAt: 60_000, stopAt: null, plain });
  assert.equal(lt2.elapsedMs, null);
  assert.equal(lt2.tokens, null);
  assert.equal(lt2.line, 'STATUS: done · pushed');
  // no send known: same
  assert.equal(meter.compute({ name: 'cx', agent: 'codex', sentAt: null, stopAt: 125_000, plain }).elapsedMs, null);
  // no ledger rows in the window: tokens omitted, elapsed kept
  const lt3 = meter.compute({ name: 'cx', agent: 'codex', sentAt: 130_000, stopAt: 140_000, plain });
  assert.equal(lt3.tokens, null);
  assert.equal(lt3.line, 'STATUS: done · 10s · pushed');
  // a missing ledger file is fine
  const none = createTurnMeter({ ledgerFile: join(dir, 'nope.jsonl'), now: () => clock, ttlMs: 0 });
  await none.refresh();
  assert.equal(none.compute({ name: 'cx', agent: 'codex', sentAt: 1, stopAt: 5001, plain }).tokens, null);
  // late ledger rows are picked up while the stop is fresh
  writeFileSync(ledgerFile, [row('cx', 61_000, 100), row('cx', 124_000, 50)].join('\n') + '\n');
  await meter.refresh();
  assert.equal(meter.compute({ name: 'cx', agent: 'codex', sentAt: 60_000, stopAt: 125_000, plain }).tokens.total, 300);
});

test('turn meter (Claude): reporter meter and its text give the line', () => {
  const meter = createTurnMeter({ ledgerFile: '/nonexistent', now: () => 1 });
  const claude = { endAt: 9, elapsedMs: 241_000, tokens: { in: 1, out: 2, cacheRead: 1_299_000, cacheWrite: 0, total: 1_300_003 }, text: 'closing\nSTATUS: done — branch x pushed (abc123), left: 23 tables' };
  const lt = meter.compute({ name: 'c1', agent: 'claude', claude, plain: ['stale pane'] });
  assert.equal(lt.line, 'STATUS: done · 4m 01s · 1.3M tok · branch x pushed (abc123), left: 23 tables');
  assert.equal(lt.source, 'reporter');
  assert.equal(meter.get('c1').status, 'done');
  // a Claude session with no reporter meter: verdict from the pane, no time and no tokens
  const lt2 = meter.compute({ name: 'c2', agent: 'claude', claude: null, sentAt: 1, stopAt: 5, plain: ['x', 'STATUS: blocked: lease held'] });
  assert.equal(lt2.line, 'STATUS: blocked · lease held');
});

test('manager event: carries the turn, and two sightings of one stop with different meters still dedupe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-tm-'));
  const ev = createManagerEvents({ stateDir: dir });
  const turn = (n) => ({ elapsedMs: n, tokens: null, status: 'needs-owner', info: 'ship it?', line: `STATUS: needs-owner · ${n}s · ship it?` });
  const e = (n) => ({ at: new Date(Date.UTC(2026, 9, 6, 12, 0, n)).toISOString(), key: 'sess:asks', title: 'sess asks you', body: `STATUS: needs-owner · ${n}s · ship it?\nthe question`, turn: turn(n) });
  assert.equal(await ev.record(e(1)), true);
  assert.equal(await ev.record(e(2)), false);
  const [rec] = await ev.tail({});
  assert.equal(rec.turn.line, 'STATUS: needs-owner · 1s · ship it?');
  assert.ok(rec.body.startsWith('STATUS: needs-owner'));
});
