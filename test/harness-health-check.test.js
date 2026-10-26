// Pure parts of scripts/harness-health-check.js plus one end-to-end run against a throwaway state dir.
// No network: the sessions fetch is injected. Never reads the real ~/.local/state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  askStats, laneStats, ciStats, loadAvgs, memAvailableMb, diskPct, inWindow,
  fetchSessions, collect, summarize, prevLine, run, FINAL_STATES, MEM_MIN_MB,
} from '../scripts/harness-health-check.js';
import { tmp } from './helpers-tmp.js';

const NOW = Date.UTC(2026, 9, 21, 6, 0, 0);          // 2026-10-21 06:00 UTC
const ago = (ms) => new Date(NOW - ms).toISOString();
const win = { now: NOW, hours: 24 };
const line = (o) => JSON.stringify(o);

// ---- window -------------------------------------------------------------------------------------------------------
test('inWindow: inside, older, newer and unreadable timestamps', () => {
  assert.equal(inWindow(ago(3600000), NOW), true);
  assert.equal(inWindow(ago(25 * 3600000), NOW), false, 'yesterday is out');
  assert.equal(inWindow(ago(-3600000), NOW), false, 'the future is out');
  assert.equal(inWindow('not a date', NOW), false, 'a malformed timestamp is never in the window');
  assert.equal(inWindow(undefined, NOW), false);
});

// ---- owner asks --------------------------------------------------------------------------------------------------
test('askStats: only lines with a question are new asks, a later line with the same id answers them', () => {
  const r = askStats([
    line({ at: ago(3600000), id: 'a1', question: 'floor?', floor: 'money', state: 'open' }),
    line({ at: ago(3400000), id: 'a1', state: 'answered' }),
    line({ at: ago(3000000), id: 'a2', question: 'money?', floor: 'money' }),          // still open
    line({ at: ago(30 * 3600000), id: 'a3', question: 'old?', floor: 'money' }),          // outside the window
    line({ at: ago(1800000), id: 'a4', question: 'newer?', floor: 'money', state: 'superseded' }),
    line({ at: ago(60 * 3600000), id: 'a5', question: 'ancient?', floor: 'money' }),     // way out
    'not json',
  ], win);
  assert.equal(r.asked, 3, 'a1, a2, a4');
  assert.equal(r.answered, 1, 'only a1 closed');
  assert.equal(r.open, 2);
});

test('askStats: an answer line before its ask line does not close it, answered:true closes it too', () => {
  const r = askStats([
    line({ at: ago(3000000), id: 'b1', state: 'answered' }),           // resolution before the ask
    line({ at: ago(2000000), id: 'b1', question: 'q?', floor: 'money' }),
    line({ at: ago(3000000), id: 'b2', question: 'q?', floor: 'money' }),
    line({ at: ago(2000000), id: 'b2', answered: true }),               // after the ask -> closes it
  ], win);
  assert.equal(r.asked, 2);
  assert.equal(r.answered, 1, 'only the later answered:true line counts');
  assert.equal(r.open, 1, 'b1 is still open');
});

test('askStats: a superseded ask is closed, the newer question it was replaced by is the open one', () => {
  const r = askStats([
    line({ at: ago(3600000), id: 's1', question: 'old?', floor: 'money', state: 'open' }),
    line({ at: ago(3000000), id: 's1', state: 'superseded', by: 's2' }),
    line({ at: ago(2400000), id: 's2', question: 'replacement?', floor: 'money' }),
  ], win);
  assert.equal(r.asked, 2, 's1 and s2');
  assert.equal(r.answered, 0);
  assert.equal(r.superseded, 1, 's1 was replaced by s2');
  assert.equal(r.open, 1, 'only the replacement still waits for the owner');
});

test('askStats: an ask answered then superseded is counted once, as answered', () => {
  const r = askStats([
    line({ at: ago(3600000), id: 'd1', question: 'floor?', floor: 'money' }),
    line({ at: ago(3400000), id: 'd1', state: 'answered' }),
    line({ at: ago(3200000), id: 'd1', state: 'superseded', by: 'd2' }),
    line({ at: ago(3100000), id: 'd1', answered: true }),                  // a repeated resolution never double counts
  ], win);
  assert.equal(r.asked, 1);
  assert.equal(r.answered, 1);
  assert.equal(r.superseded, 0, 'answering wins over superseding, so asked = answered + superseded');
  assert.equal(r.open, 0);
});

test('askStats: a resolution line before its question line does not close it', () => {
  const r = askStats([
    line({ at: ago(3600000), id: 'e1', state: 'superseded', by: 'e0' }),   // belongs to an earlier question
    line({ at: ago(3400000), id: 'e1', state: 'answered' }),
    line({ at: ago(3000000), id: 'e1', question: 'q?', floor: 'money' }),
  ], win);
  assert.equal(r.asked, 1);
  assert.equal(r.answered, 0, 'no line after the ask resolves it');
  assert.equal(r.superseded, 0);
  assert.equal(r.open, 1, 'e1 stays open until a LATER line closes it');
});

// ---- owner asks: the limit is a per-session budget -------------------------------------------------------------
test('askStats: the ask limit is per session, parallel topic sessions do not share one budget', () => {
  const sessions = ['topic-1', 'topic-2', 'topic-3', 'topic-4', 'topic-5', 'topic-6'];
  const r = askStats(Array.from({ length: 8 }, (_, i) =>
    line({ at: ago(3600000), id: `p${i}`, session: sessions[i % sessions.length], question: 'ok?', floor: 'money' })), win);
  assert.equal(r.asked, 8, 'the fleet total is still the fleet total');
  assert.equal(r.worstSession.count, 2, 'no session asked more than twice');
  assert.equal(r.bySession['topic-1'], 2);
  const s = summarize({ ...base, asked: r.asked, answered: r.answered, open: r.open, bySession: r.bySession, worstSession: r.worstSession }, null);
  assert.deepEqual(s.findings.map((f) => f.key), [], '8 asks from 6 sessions is no session over the limit');
  assert.match(s.summary, /8 owner asks/, 'the fleet total stays in the summary line');
  assert.match(s.report, /\| owner asks \| 8 \(0 answered, 8 open\) \|/, 'and in the table row');
});

test('summarize: one session over the ask limit is a finding that names the session and its count', () => {
  const r = askStats(Array.from({ length: 4 }, (_, i) =>
    line({ at: ago(3600000), id: `q${i}`, session: 'topic-busy', question: 'ok?', floor: 'money' })), win);
  assert.equal(r.worstSession.session, 'topic-busy');
  assert.equal(r.worstSession.count, 4);
  const s = summarize({ ...base, asked: r.asked, answered: r.answered, open: r.open, bySession: r.bySession, worstSession: r.worstSession }, null);
  const f = s.findings.find((x) => x.key === 'harness-health:owner-asks');
  assert.ok(f, 'the finding fires');
  assert.match(f.title, /4 new owner asks in 24 h from session topic-busy/);
  assert.match(f.body, /4 of them from session topic-busy/);
  assert.match(f.body, /a session stopped waiting/, 'the wording of the single-session case stays');
  assert.match(s.report, /\| owner asks \| 4 \(0 answered, 4 open\) \|/, 'the fleet total stays in the table row');
});

// ---- lane --------------------------------------------------------------------------------------------------------
test('laneStats: latest record per id wins and only its final state counts', () => {
  const r = laneStats([
    line({ id: 'i1', state: 'queued', updatedAt: ago(30 * 3600000) }),
    line({ id: 'i1', state: 'merged', updatedAt: ago(2 * 3600000) }),
    line({ id: 'i2', state: 'returned', updatedAt: ago(3 * 3600000), reason: 'needs a hand' }),
    line({ id: 'i3', state: 'merged', updatedAt: ago(25 * 3600000) }),     // finished before the window
    line({ id: 'i4', state: 'running', updatedAt: ago(3600000) }),          // not final yet
    line({ id: 'i5', state: 'deployed', updatedAt: ago(3600000), approvalRefused: { by: 'x', at: ago(3600000) } }),
    'garbage',
  ], win);
  assert.equal(r.total, 4, 'i1, i2, i4, i5');
  assert.equal(r.states.merged, 1);
  assert.equal(r.states.returned, 1);
  assert.equal(r.states.deployed, 1);
  assert.equal(r.states.running, undefined, 'a non-final state is not counted in the state buckets');
  assert.equal(r.approvalRefused, 1);
  assert.equal(r.merges, 2, 'merged + deployed');
  assert.deepEqual(Object.keys(r.states), [...FINAL_STATES]);
});

// ---- lane: a return that was re-requested and landed is resolved ------------------------------------------------
test('laneStats: a return that the requester re-requested and that landed is resolved, not counted', () => {
  const r = laneStats([
    line({ id: 'j1', repo: 'fake-repo', branch: 'feature/x', state: 'returned', createdAt: ago(6 * 3600000), updatedAt: ago(6 * 3600000) }),
    line({ id: 'j2', repo: 'fake-repo', branch: 'feature/x', state: 'merged', createdAt: ago(4 * 3600000), updatedAt: ago(3 * 3600000) }),
  ], win);
  assert.equal(r.states.returned, 0, 'the later request landed, so the return needs no hand');
  assert.equal(r.returnedResolved, 1);
  assert.equal(r.states.merged, 1, 'the landed request is still a merge');
  assert.equal(r.total, 2);
});

test('laneStats: a return with no later request for the same branch is counted', () => {
  const r = laneStats([
    line({ id: 'k1', repo: 'fake-repo', branch: 'feature/y', state: 'returned', createdAt: ago(6 * 3600000), updatedAt: ago(6 * 3600000) }),
    line({ id: 'k2', repo: 'fake-repo', branch: 'feature/other', state: 'merged', createdAt: ago(4 * 3600000), updatedAt: ago(3 * 3600000) }),
  ], win);
  assert.equal(r.states.returned, 1, 'a merge of another branch does not resolve the return');
  assert.equal(r.returnedResolved, 0);
});

test('laneStats: a merge that predates the return does not resolve it', () => {
  const r = laneStats([
    line({ id: 'l1', repo: 'fake-repo', branch: 'feature/z', state: 'merged', createdAt: ago(9 * 3600000), updatedAt: ago(8 * 3600000) }),
    line({ id: 'l2', repo: 'fake-repo', branch: 'feature/z', state: 'returned', createdAt: ago(6 * 3600000), updatedAt: ago(6 * 3600000) }),
  ], win);
  assert.equal(r.states.returned, 1, 'only a LATER request can resolve a return');
  assert.equal(r.returnedResolved, 0);
});

// ---- CI ----------------------------------------------------------------------------------------------------------
test('ciStats: red minutes run to the next green, clipped to the window', () => {
  const r = ciStats([
    line({ at: ago(40 * 60000), type: 'start', red: { runId: 1 } }),   // red 40 min before now, green 10 min ago
    line({ at: ago(10 * 60000), type: 'green' }),
    line({ at: ago(5 * 60000), type: 'start', red: { runId: 2 } }),    // still open -> counted up to now
  ], win);
  assert.equal(r.redTransitions, 2);
  assert.equal(r.greenTransitions, 1);
  assert.equal(r.redMinutes, 35, '30 min closed streak + 5 min still open');
});

test('ciStats: a streak that opened before the window only counts from the window start', () => {
  const r = ciStats([
    line({ at: ago(50 * 3600000), type: 'start', red: { runId: 1 } }),  // 26 h ago
    line({ at: ago(2 * 3600000), type: 'green' }),                      // 2 h ago -> 22 h of red
  ], win);
  assert.equal(r.redTransitions, 0, 'the red tick itself is outside the window');
  assert.equal(r.greenTransitions, 1);
  assert.equal(r.redMinutes, 22 * 60);
});

test('ciStats: an unrelated journal line is ignored', () => {
  const r = ciStats([line({ at: ago(60000), dry: true, type: 'none' }), line({ at: ago(60000), run: 5 })], win);
  assert.deepEqual(r, { redTransitions: 0, greenTransitions: 0, redMinutes: 0 });
});

// ---- box ----------------------------------------------------------------------------------------------------------
test('box parsers: loadavg, meminfo and the df disk formula', () => {
  assert.deepEqual(loadAvgs('0.52 0.71 0.68 2/1400 12345\n'), { load1: 0.52, load5: 0.71, load15: 0.68 });
  assert.equal(loadAvgs('').load1, null);
  assert.equal(memAvailableMb('MemTotal:  100 kB\nMemAvailable:  2097152 kB\n'), 2048);
  assert.equal(memAvailableMb('nope'), null);
  // used/(used+avail): 900 of 1000 blocks used, 100 available -> 90 %
  assert.equal(diskPct({ blocks: 1000, bfree: 100, bavail: 100 }), 90);
  assert.equal(diskPct({ blocks: 1000, bfree: 900, bavail: 90 }), 53, 'df counts reserved blocks as available');
  assert.equal(diskPct({ blocks: 1000, bfree: 200, bavail: 200 }), 80);
assert.equal(diskPct(null), null);
assert.equal(diskPct({ blocks: 0 }), null);
});

// ---- sessions (best effort, injected fetch) -----------------------------------------------------------------------
const jsonFetch = (body, ok = true) => async () => ({ ok, json: async () => body });

test('fetchSessions: counts sessions and the needs-you states, never throws', async () => {
  const r = await fetchSessions(jsonFetch({
    sessions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    status: { a: { state: 'working' }, b: { state: 'waiting' }, c: { state: 'asks' } },
  }), 'http://127.0.0.1:1/api/sessions');
  assert.equal(r.sessions, 3);
  assert.equal(r.needsYou, 2, 'waiting + asks');
});

test('fetchSessions: an error, a non-200 or a changed shape gives null, never a fabricated zero', async () => {
  for (const f of [async () => { throw new Error('ECONNREFUSED'); }, jsonFetch({}, false), jsonFetch({ nope: 1 })]) {
    assert.deepEqual(await fetchSessions(f, 'http://127.0.0.1:1/api/sessions'), { sessions: null, needsYou: null });
  }
});

// ---- summarize (pure) ----------------------------------------------------------------------------------------------
const base = { date: '2026-10-21', asked: 0, answered: 0, open: 0, decisions: 0,
  bySession: {}, worstSession: null,
  states: Object.fromEntries(FINAL_STATES.map((s) => [s, 0])), total: 0, approvalRefused: 0, returnedResolved: 0, merges: 0,
  ci: { redTransitions: 0, greenTransitions: 0, redMinutes: 0 },
  box: { load1: 0.5, load5: 0.5, load15: 0.5, memAvailableMb: 8192, diskPct: 83 }, sessions: 4, needsYou: 0, notFound: [] };

test('summarize: a healthy day is one line, a markdown table and no finding', () => {
  const r = summarize({ ...base, asked: 1, states: { ...base.states, merged: 5, returned: 1 } }, null);
  assert.equal(r.summary, '5 merges, 1 returned, 1 owner asks, CI red 0 min, disk 83 %');
  assert.match(r.report, /\| metric \| today \(24 h\) \| previous day \|/);
  assert.match(r.report, /\| disk \/ \| 83 % \| n\/a \|/);
  assert.match(r.report, /No regression above the thresholds\./);
  assert.deepEqual(r.findings, []);
});

test('summarize: every threshold raises exactly one normal finding', () => {
  const over = { ...base, asked: 4, worstSession: { session: 'topic-busy', count: 4 }, approvalRefused: 1,
    states: { ...base.states, returned: 6 },
    ci: { redTransitions: 2, greenTransitions: 1, redMinutes: 121 },
    box: { ...base.box, diskPct: 91, memAvailableMb: MEM_MIN_MB - 1 } };
  const r = summarize(over, null);
  assert.deepEqual(r.findings.map((f) => f.key), ['harness-health:owner-asks', 'harness-health:lane-returned',
    'harness-health:ci-red', 'harness-health:disk', 'harness-health:memory', 'harness-health:approval-refused']);
  assert.ok(r.findings.every((f) => f.priority === 'normal' && f.key && f.title && f.body.length <= 300));
});

test('summarize: at the threshold is still healthy, missing box numbers raise nothing', () => {
  const at = summarize({ ...base, asked: 3, worstSession: { session: 'topic-1', count: 3 },
    states: { ...base.states, returned: 5 },
    ci: { redTransitions: 0, greenTransitions: 0, redMinutes: 120 },
    box: { ...base.box, diskPct: 90, memAvailableMb: MEM_MIN_MB } }, null);
  assert.deepEqual(at.findings, [], 'the limits are strict: only above them');
  const unknown = summarize({ ...base, box: { load1: null, memAvailableMb: null, diskPct: null } }, null);
  assert.deepEqual(unknown.findings, [], 'n/a is not a regression');
  assert.match(unknown.summary, /disk n\/a %/);
});

test('summarize: the lane row shows the resolved count and the finding counts only unresolved returns', () => {
  const at = summarize({ ...base, states: { ...base.states, returned: 5 }, returnedResolved: 3 }, null);
  assert.deepEqual(at.findings.map((f) => f.key), [], '5 unresolved returns is at the limit');
  assert.match(at.report, /\| lane returned \| 5 returned, 3 resolved \|/);
  const over = summarize({ ...base, states: { ...base.states, returned: 6 }, returnedResolved: 8 }, null);
  assert.deepEqual(over.findings.map((f) => f.key), ['harness-health:lane-returned']);
  assert.match(over.findings[0].body, /were not re-landed/);
});

test('summarize: the report compares against the previous day and names the missing sources', () => {
  const prev = { ...base, date: '2026-10-20', asked: 2, decisions: 4, states: { ...base.states, merged: 2 }, box: { ...base.box, diskPct: 60 } };
  const r = summarize({ ...base, asked: 1, answered: 0, open: 1, notFound: ['ci-watch.jsonl'] }, prev);
  assert.match(r.report, /\| owner asks \| 1 \(0 answered, 1 open\) \| 2 \(0 answered\) \|/);
  assert.match(r.report, /\| disk \/ \| 83 % \| 60 % \|/);
  assert.match(r.report, /not found \(counted as 0\): ci-watch\.jsonl/);
});

// ---- end to end ------------------------------------------------------------------------------------------------------
test('run: reads a fixture state dir, appends one line a day and compares with the previous line', async () => {
  const dir = tmp('harness-health-');
  mkdirSync(join(dir, 'integration'), { recursive: true });
  const fetchImpl = jsonFetch({ sessions: [{ name: 'a' }, { name: 'b' }], status: { a: { state: 'waiting' } } });
  const out = () => {};

  // Fixtures are written relative to the run's own `now`, otherwise day 2 measures day 1's window.
  const write = (now, { asks = 0, returned = 0, ci = false, refused = false } = {}) => {
    const at = (ms) => new Date(now - ms).toISOString();
    if (asks) writeFileSync(join(dir, 'manager-owner-asks.jsonl'),
      Array.from({ length: asks }, (_, i) => line({ at: at(3600000), id: `q${i}`, question: 'money?', floor: 'money' })).join('\n') + '\n');
    writeFileSync(join(dir, 'manager-decisions.jsonl'),
      Array.from({ length: 2 }, (_, i) => line({ at: at(3600000), id: `d${i}` })).join('\n') + '\n');
    if (returned) writeFileSync(join(dir, 'integration/requests.jsonl'),
      Array.from({ length: returned }, (_, i) => line({ id: `i${i}`, state: 'returned', updatedAt: at(3600000), ...(refused ? { approvalRefused: { by: 's', at: at(3600000) } } : {}) })).join('\n') + '\n');
    if (ci) writeFileSync(join(dir, 'ci-watch.jsonl'), line({ at: at(2 * 3600000), type: 'start', red: { runId: 1 } }) + '\n' + line({ at: at(3600000), type: 'green' }) + '\n');
  };

  // day 1: healthy; no ci-watch.jsonl at all, so the missing source is named instead of silently zero
  write(NOW, { asks: 2, returned: 1 });
  const d1 = await run({ stateDir: dir, now: NOW, out, fetchImpl });
  assert.deepEqual(d1.findings, []);
  assert.match(d1.summary, /^0 merges, 1 returned, 2 owner asks, CI red 0 min, disk \d+ %$/, 'the box is the live one');

  const file = join(dir, 'harness-health.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one line per run');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.date, '2026-10-21');
  assert.equal(rec.asked, 2);
  assert.equal(rec.decisions, 2);
  assert.equal(rec.states.returned, 1);
  assert.equal(rec.sessions, 2);
  assert.equal(rec.needsYou, 1);
  assert.ok(rec.notFound.includes('ci-watch.jsonl'), 'the missing source is named, not silently zero');

  // day 2: an hour of CI red in its own window, the server is down, and day 1 is the "previous" column
  const day2 = NOW + 86400000;
  write(day2, { asks: 2, returned: 1, ci: true });
  const down = async () => { throw new Error('down'); };
  const d2 = await run({ stateDir: dir, now: day2, out, fetchImpl: down });
  assert.deepEqual(d2.findings.map((f) => f.key), [], 'nothing above a threshold');
  assert.match(d2.summary, /CI red 60 min/, 'the streak inside day 2 only');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.match(d2.report, /\| owner asks \| 2 \(0 answered, 2 open\) \| 2 \(0 answered\) \|/, 'day 1 is the previous line');
  assert.match(d2.report, /\| sessions \(needs you\) \| n\/a \(n\/a\) \| 2 \(1\) \|/, 'the previous day had sessions');

  // day 3: an approval refusal is a finding, and the fetch failure still leaves sessions null
  write(NOW + 2 * 86400000, { asks: 1, returned: 1, refused: true });
  const d3 = await run({ stateDir: dir, now: NOW + 2 * 86400000, out, fetchImpl: down });
  assert.deepEqual(d3.findings.map((f) => f.key), ['harness-health:approval-refused']);
  const rec3 = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
  assert.equal(rec3.sessions, null, 'an unreachable server is null, not 0');
  assert.equal(rec3.approvalRefused, 1);
  assert.match(d3.report, /\| sessions \(needs you\) \| n\/a \(n\/a\) \|/);
});

test('run: an empty state dir counts 0 everywhere and still writes its line', async () => {
  const dir = tmp('harness-health-');
  const r = await run({ stateDir: dir, now: NOW, out: () => {}, fetchImpl: jsonFetch({ sessions: [], status: {} }) });
  assert.deepEqual(r.findings, []);
  const rec = JSON.parse(readFileSync(join(dir, 'harness-health.jsonl'), 'utf8').trim());
  assert.equal(rec.asked, 0);
  assert.equal(rec.total, 0);
  assert.equal(rec.sessions, 0);
  assert.deepEqual(rec.notFound.sort(), ['ci-watch.jsonl', 'integration/requests.jsonl', 'manager-decisions.jsonl', 'manager-owner-asks.jsonl']);
});

test('prevLine: the last well-formed line wins, a truncated write is skipped, no file is null', () => {
  const dir = tmp('harness-health-');
  const p = join(dir, 'harness-health.jsonl');
  assert.equal(prevLine(p), null);
  assert.equal(prevLine(join(dir, 'none.jsonl')), null);
  writeFileSync(p, `${line({ date: '2026-10-19', asked: 1 })}\n${line({ date: '2026-10-20', asked: 2 })}\n{"date":"2026-10-2\n`);
  assert.equal(prevLine(p).asked, 2, 'the torn last line is ignored');
});

test('collect: a malformed source file is counted as 0 and named, never thrown', () => {
  const dir = tmp('harness-health-');
  writeFileSync(join(dir, 'manager-owner-asks.jsonl'), 'not json\n{"no question":1}\n');
  writeFileSync(join(dir, 'manager-decisions.jsonl'), '');
  const c = collect({ stateDir: dir, now: NOW, box: { load1: 1, memAvailableMb: 4096, diskPct: 50 } });
  assert.equal(c.asked, 0);
  assert.equal(c.merges, 0);
  assert.deepEqual(c.notFound.sort(), ['ci-watch.jsonl', 'integration/requests.jsonl']);
  assert.equal(c.date, '2026-10-21');
});

test('collect: reads the real /proc and / for the box numbers', () => {
  const c = collect({ stateDir: tmp('harness-health-'), now: NOW });
  assert.ok(Number.isFinite(c.box.load1), '/proc/loadavg read');
  assert.ok(Number.isFinite(c.box.memAvailableMb) && c.box.memAvailableMb > 0, '/proc/meminfo read');
  assert.ok(Number.isFinite(c.box.diskPct), 'statfs(/) read');
  assert.ok(c.box.diskPct >= 0 && c.box.diskPct <= 100);
});