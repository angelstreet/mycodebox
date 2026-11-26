// Manager cost section of the daily report (manager-cost.js) and the context-cap restart (scripts/manager-context-cap.js,
// through scripts/manager-fresh.sh). Throwaway state dirs and fake tmux/curl only: never the live manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { splitWakes } from '../manager-wakes.js';
import { costStats, costWindows, costCrossed, costFinding, costLines, percentile, COST_DEFAULTS } from '../manager-cost.js';
import { capConfig, lastContext, readTail, findTranscript, decide, decisionLine, run, DEFAULT_CAP } from '../scripts/manager-context-cap.js';
import { run as dailyRun } from '../scripts/daily-checks.js';
import { managerCommand } from '../launch-config.js';
import { tmp } from './helpers-tmp.js';

const DAY = 86400000, NOW = Date.UTC(2026, 10, 25, 6);
const wake = (agoMs, { usd = 0.3, ctxMax = 200000, nothing = false } = {}) => ({ start: new Date(NOW - agoMs).toISOString(), usd, ctxMax, nothing });
const many = (n, agoMs, o) => Array.from({ length: n }, (_, i) => wake(agoMs + i * 1000, o));

// ---- wakes carry calls and the largest context -----------------------------------------------------------------------
test('a wake records its model calls and its largest context (input + cache read + cache written)', () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
  const asst = (s, id, usage) => ({ type: 'assistant', timestamp: at(s), message: { id, model: 'm', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } });
  const recs = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'go' }, origin: { kind: 'human' } },
    asst(1, 'a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90 }),
    asst(2, 'b', { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 50 } }),
    asst(2, 'b', { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 50 } }),
  ];
  const [w] = splitWakes(recs, {});
  assert.equal(w.calls, 2, 'a message written twice is one call');
  assert.equal(w.ctxMax, 5100);
});

// ---- cost section ----------------------------------------------------------------------------------------------------
test('costStats: cost per wake, context percentiles without context-less wakes, idle share', () => {
  const s = costStats([wake(0, { usd: 0.2, ctxMax: 100 }), wake(0, { usd: 0.4, ctxMax: 300, nothing: true }), wake(0, { usd: 0, ctxMax: 0, nothing: true }), { start: 'x', nothing: false }]);
  assert.equal(s.wakes, 4); assert.equal(s.usdPerWake, 0.15); assert.equal(s.ctxMedian, 300); assert.equal(s.ctxP90, 300);
  assert.equal(s.idle, 2); assert.equal(s.idleShare, 0.5);
  assert.deepEqual(costStats([]), { wakes: 0, usd: 0, usdPerWake: null, ctxMedian: null, ctxP90: null, idle: 0, idleShare: null });
  assert.equal(percentile([], 0.9), null); assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
});

test('costWindows: last 24 h against the 7 days before; a young log is averaged over the days it covers', () => {
  const w = [...many(30, 3600000), ...many(40, 2 * DAY), ...many(20, 3 * DAY - 30000), wake(9 * DAY)];
  const { today, week } = costWindows(w, NOW);
  assert.equal(today.wakes, 30); assert.equal(week.wakes, 60);
  assert.equal(week.days, 2, 'the log starts under 3 days ago: 2 days before the last 24 h'); assert.equal(week.wakesPerDay, 30);
  assert.equal(costWindows(many(5, 1000), NOW).week.days, 0);
});

test('findings: each threshold, the minimum number of wakes, and one finding for the whole section', () => {
  const base = many(140, 2 * DAY, { usd: 0.3, ctxMax: 200000 });   // 140 wakes over 2 covered days -> 70 a day
  const quiet = costWindows([...many(60, 1000), ...base], NOW);
  assert.deepEqual(costCrossed(quiet), []); assert.equal(costFinding(quiet), null);
  const ctx = costWindows([...many(60, 1000, { ctxMax: 500000 }), ...base], NOW);
  assert.deepEqual(costCrossed(ctx).map((c) => c.what), ['context']);
  const idle = costWindows([...many(60, 1000, { nothing: true }), ...base], NOW);
  assert.deepEqual(costCrossed(idle).map((c) => c.what), ['idle']);
  const dear = costWindows([...many(60, 1000, { usd: 0.5 }), ...base], NOW);
  assert.deepEqual(costCrossed(dear).map((c) => c.what), ['cost-per-wake']);
  const busy = costWindows([...many(150, 1000), ...base], NOW);
  assert.deepEqual(costCrossed(busy).map((c) => c.what), ['wakes']);
  const few = costWindows([...many(COST_DEFAULTS.minWakes - 1, 1000, { ctxMax: 900000, nothing: true }), ...base], NOW);
  assert.deepEqual(costCrossed(few), [], 'too few wakes to judge');
  assert.deepEqual(costCrossed(ctx, { p90CtxMax: 600000 }), [], 'thresholds can be overridden');
  const all = costWindows([...many(150, 1000, { ctxMax: 500000, nothing: true, usd: 0.6 }), ...base], NOW);
  const f = costFinding(all);
  assert.equal(f.key, 'manager-cost'); assert.equal(f.priority, 'default');
  assert.match(f.title, /context, idle, cost-per-wake, wakes/); assert.match(f.body, /p90 context 500k is over 400k/);
});

test('report section: the five rows, the finding line, and how quality becomes real', () => {
  const win = costWindows([...many(60, 1000, { ctxMax: 500000 }), ...many(140, 2 * DAY)], NOW);
  const text = costLines(win).join('\n');
  assert.match(text, /^## Manager cost \(last 24 h against the 7 days before\)/);
  for (const row of ['| wakes | 60 | 70 a day |', '| cost per wake (API-equivalent) | $0.30 | $0.30 |', '| context, median | 500k | 200k |', '| context, p90 | 500k | 200k | 400k |', '| idle share | 0 % (0 wakes) | 0 % | 70 % |']) assert.ok(text.includes(row), row);
  assert.match(text, /Finding: p90 context 500k is over 400k\./);
  assert.match(text, /Quality becomes real only when the owner taps "wrong" on a bad manager action/);
  assert.match(costLines(costWindows([], NOW)).join('\n'), /No manager wake found/);
  assert.match(costLines(costWindows(many(3, 1000), NOW)).join('\n'), /fewer than 20 wakes/);
});

test('daily report: the Manager cost section is written, its finding wakes the manager once, and the switch turns it off', async () => {
  const home = tmp('daily-cost-');
  const dir = join(home, '.local/state/ghosty'), proj = join(home, '.claude/projects/-p'); mkdirSync(dir, { recursive: true }); mkdirSync(proj, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  writeFileSync(join(dir, 'usage-ledger.jsonl'), JSON.stringify({ agent: 'claude', session: sid, label: 'manager', subagent: false }) + '\n');
  const recs = [];
  for (let i = 0; i < 25; i++) {
    const at = new Date(NOW - 3600000 + i * 60000).toISOString();
    recs.push({ type: 'user', timestamp: at, message: { role: 'user', content: 'go' }, origin: { kind: 'human' } });
    recs.push({ type: 'assistant', timestamp: at, message: { id: `m${i}`, model: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 600000 } } });
  }
  writeFileSync(join(proj, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // the built-in installed-copies check reads this host's real /etc/systemd: stub it, it is not what this test is about
  const checks = [{ id: 'installed-copies', title: 'stub', command: [process.execPath, '-e', 'console.log(JSON.stringify({ summary: "stub", report: "stub", findings: [] }))'] }];
  writeFileSync(join(dir, 'daily-checks.json'), JSON.stringify({ checks }));
  const saved = process.env.CLAUDE_PROJECTS_DIR; delete process.env.CLAUDE_PROJECTS_DIR;
  try {
    let r = await dailyRun({ home, now: NOW, argv: [], out: () => {} });
    const report = readFileSync(r.reportPath, 'utf8');
    assert.match(report, /## Manager cost/); assert.match(report, /\| wakes \| 25 \|/); assert.match(report, /\| context, p90 \| 600k \|/);
    assert.ok(report.indexOf('## Manager cost') < report.indexOf('## Manager wake'));
    assert.deepEqual(r.events.map((e) => [e.key, e.priority]), [['daily:manager-cost', 'default']]);
    r = await dailyRun({ home, now: NOW + 1000, argv: [], out: () => {} });
    assert.equal(r.events.length, 0, 'debounced');
    writeFileSync(join(dir, 'daily-checks.json'), JSON.stringify({ checks, managerCost: false }));
    r = await dailyRun({ home, now: NOW + DAY, argv: [], out: () => {} });
    assert.doesNotMatch(readFileSync(r.reportPath, 'utf8'), /## Manager cost/); assert.equal(r.events.length, 0);
    writeFileSync(join(dir, 'daily-checks.json'), JSON.stringify({ checks, managerCost: { p90CtxMax: 900000, idleShareMax: 1 } }));
    r = await dailyRun({ home, now: NOW + 2000, argv: [], out: () => {} });
    assert.equal(r.events.length, 0, 'thresholds from the config');
  } finally { if (saved !== undefined) process.env.CLAUDE_PROJECTS_DIR = saved; }
});

// ---- context cap: pure parts -----------------------------------------------------------------------------------------
test('capConfig: default 300k and 2 a day, off with 0 or false, never more than 2 a day', () => {
  assert.deepEqual(capConfig(null), { cap: DEFAULT_CAP, maxPerDay: 2 });
  assert.deepEqual(capConfig({ contextCap: 250000, contextCapMaxPerDay: 1 }), { cap: 250000, maxPerDay: 1 });
  assert.equal(capConfig({ contextCap: 0 }).cap, 0); assert.equal(capConfig({ contextCap: false }).cap, 0); assert.equal(capConfig({ contextCap: 'x' }).cap, 0);
  assert.equal(capConfig({ contextCapMaxPerDay: 9 }).maxPerDay, 2); assert.equal(capConfig({ contextCapMaxPerDay: 0 }).maxPerDay, 0);
});

const line = (at, usage, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: 'x', model: 'm', usage }, ...extra });
test('lastContext: the last real model call; subagent, synthetic and torn lines are skipped', () => {
  const text = ['{"torn', line(1000, { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    line(2000, { input_tokens: 1, cache_read_input_tokens: 400000 }),
    line(3000, { input_tokens: 9, cache_read_input_tokens: 9 }, { isSidechain: true }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(4000).toISOString(), message: { model: '<synthetic>', usage: { input_tokens: 7 } } }),
    JSON.stringify({ type: 'user', timestamp: new Date(5000).toISOString(), message: { usage: { input_tokens: 7 } } })].join('\n');
  assert.deepEqual(lastContext(text), { ctx: 400001, at: 2000 });
  assert.equal(lastContext(''), null); assert.equal(lastContext('nothing here'), null);
});

test('readTail and findTranscript: the tail of a long transcript, found by the Claude session id', () => {
  const root = tmp('cap-tail-'); const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  mkdirSync(join(root, '-a')); mkdirSync(join(root, '-b'));
  const f = join(root, '-b', `${id}.jsonl`);
  writeFileSync(f, 'x'.repeat(5000) + '\n' + line(2000, { input_tokens: 3, cache_read_input_tokens: 7 }) + '\n');
  assert.equal(findTranscript(root, id), f); assert.equal(findTranscript(root, 'nope'), null); assert.equal(findTranscript(join(root, 'missing'), id), null);
  assert.deepEqual(lastContext(readTail(f, 400)), { ctx: 10, at: 2000 });
});

test('decide: fires only over the cap, when idle with no draft, under the daily limit, on a call newer than the last restart', () => {
  const now = Date.UTC(2026, 10, 25, 12), day = '2026-11-25';
  const over = { ctx: 512000, at: now - 1000 }, idle = { state: 'done', draft: false };
  const d = (o) => decide({ cap: 300000, maxPerDay: 2, context: over, session: idle, state: {}, now, ...o });
  assert.deepEqual([d({}).fire, d({}).n], [true, 1]);
  assert.match(d({}).why, /context 512k is over the 300k cap/);
  assert.equal(d({ cap: 0 }).fire, false); assert.equal(d({ context: null }).fire, false);
  assert.equal(d({ context: { ctx: 300000, at: now } }).fire, false, 'at the cap is not over it');
  for (const state of ['working', 'asks', undefined]) assert.equal(d({ session: { state } }).fire, false, `never while ${state}`);
  assert.match(d({ session: { state: 'working' } }).why, /not interrupted/);
  assert.equal(d({ session: { state: 'done', draft: true } }).fire, false, 'never over a draft');
  for (const state of ['idle', 'waiting']) assert.equal(d({ session: { state } }).fire, true);
  assert.equal(d({ state: { day, count: 1 } }).n, 2);
  const third = d({ state: { day, count: 2 } });
  assert.deepEqual([third.fire, third.limit], [false, true]); assert.match(third.why, /2 cap restart\(s\) already today/);
  assert.equal(d({ state: { day, count: 2, limitNoted: true } }).limit, false, 'the limit is journaled once a day');
  assert.equal(d({ state: { day: '2026-11-24', count: 2 } }).n, 1, 'a new UTC day starts at 0');
  assert.equal(d({ state: { lastAt: now } }).fire, false, 'the old transcript after a restart');
  assert.equal(d({ maxPerDay: 0 }).fire, false);
  assert.deepEqual(decisionLine({ session: 'manager', text: 't', now }), { at: '2026-11-25T12:00:00.000Z', kind: 'decision', session: 'manager', by: 'context-cap', decision: 't' });
});

// ---- context cap: run() with a fake dashboard and a fake restart -------------------------------------------------------
function capEnv({ ctx = 512000, cfg = null, session = 'manager' } = {}) {
  const home = tmp('cap-run-'); const stateDir = join(home, 'state'), claudeDir = join(home, 'projects');
  mkdirSync(stateDir); mkdirSync(join(claudeDir, '-p'), { recursive: true });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', now = Date.UTC(2026, 10, 25, 12);
  writeFileSync(join(claudeDir, '-p', `${id}.jsonl`), line(now - 5000, { input_tokens: 0, cache_read_input_tokens: ctx }) + '\n');
  if (cfg) writeFileSync(join(stateDir, 'manager.json'), JSON.stringify(cfg));
  const calls = [];
  const opts = (o = {}) => ({
    argv: o.argv || [], now: o.now ?? now, out: () => {}, env: { HOME: home, GHOSTY_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: claudeDir },
    fetchStatus: async () => ({ [session]: { state: o.state || 'done', stall: { draft: !!o.draft }, claudeSessionId: id } }),
    restart: (script, env) => { calls.push({ script, env }); return { status: o.exit ?? 0, stdout: '', stderr: 'boom' }; },
  });
  const actions = () => { try { return readFileSync(join(stateDir, 'manager-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  return { stateDir, calls, opts, actions, now, id, claudeDir };
}

test('run: over the cap and idle -> one restart through manager-fresh.sh, one decision line, counted', async () => {
  const e = capEnv();
  const r = await run(e.opts());
  assert.equal(r.ok, true); assert.equal(e.calls.length, 1);
  assert.match(e.calls[0].script, /scripts\/manager-fresh\.sh$/);
  assert.equal(e.calls[0].env.MANAGER_FRESH_WAIT_TRIES, '1', 'no 60 min wait: idle now or not at all');
  assert.equal(e.calls[0].env.MANAGER_FRESH_SESSION, 'manager');
  assert.match(e.calls[0].env.MANAGER_FRESH_REASON, /context cap restart: the context reached 512k, over the 300k cap/);
  const a = e.actions();
  assert.equal(a.length, 1); assert.equal(a[0].kind, 'decision'); assert.equal(a[0].by, 'context-cap'); assert.equal(a[0].session, 'manager');
  assert.match(a[0].decision, /restarted fresh through manager-fresh\.sh while idle \(restart 1 of 2 today\)/);
  assert.deepEqual(JSON.parse(readFileSync(join(e.stateDir, 'manager-context-cap.json'), 'utf8')), { day: '2026-11-25', count: 1, lastAt: e.now });
});

test('run: never while the manager works or holds a draft, never under the cap, never when switched off', async () => {
  for (const [o, cfg, ctx] of [[{ state: 'working' }], [{ draft: true }], [{}, null, 200000], [{}, { contextCap: 0 }], [{ argv: ['--dry-run'] }]]) {
    const e = capEnv({ cfg, ctx });
    await run(e.opts(o));
    assert.equal(e.calls.length, 0, JSON.stringify([o, cfg, ctx])); assert.deepEqual(e.actions(), []);
    assert.ok(!existsSync(join(e.stateDir, 'manager-context-cap.json')));
  }
});

test('run: at most 2 a day; the third is refused with one line that day; the next day starts again', async () => {
  const e = capEnv();
  const grow = (at) => writeFileSync(join(e.claudeDir, '-p', `${e.id}.jsonl`), line(at, { input_tokens: 0, cache_read_input_tokens: 512000 }) + '\n');
  await run(e.opts());
  grow(e.now + 3600000 - 1); await run(e.opts({ now: e.now + 3600000 }));
  assert.equal(e.calls.length, 2);
  for (const h of [2, 3]) { grow(e.now + h * 3600000 - 1); await run(e.opts({ now: e.now + h * 3600000 })); }
  assert.equal(e.calls.length, 2, 'no third restart');
  const a = e.actions();
  assert.equal(a.length, 3, 'two restarts and one refusal, not one refusal per run'); assert.match(a[2].decision, /not restarted again today/);
  grow(e.now + 86400000 - 1); await run(e.opts({ now: e.now + 86400000 }));
  assert.equal(e.calls.length, 3);
});

test('run: a session that stopped being idle (exit 3) costs nothing; a failed restart is counted and journaled', async () => {
  const busy = capEnv();
  const r = await run(busy.opts({ exit: 3 }));
  assert.equal(r.fire, false); assert.deepEqual(busy.actions(), []); assert.ok(!existsSync(join(busy.stateDir, 'manager-context-cap.json')));
  const failed = capEnv();
  await run(failed.opts({ exit: 1 }));
  assert.match(failed.actions()[0].decision, /FAILED \(exit 1\); it counts as restart 1 of 2 today/);
  assert.equal(JSON.parse(readFileSync(join(failed.stateDir, 'manager-context-cap.json'), 'utf8')).count, 1);
});

test('run: a model call from before the last fresh restart (any kind) never fires; a throw-away session has its own state', async () => {
  const e = capEnv();
  writeFileSync(join(e.stateDir, 'manager-fresh.last'), String(e.now - 1000));   // nightly restart after the 512k call
  await run(e.opts());
  assert.equal(e.calls.length, 0);
  const t = capEnv({ session: 'captest', ctx: 5000 });
  await run(t.opts({ argv: ['--session', 'captest', '--cap', '1000'] }));
  assert.equal(t.calls[0].env.MANAGER_FRESH_SESSION, 'captest');
  assert.ok(existsSync(join(t.stateDir, 'manager-context-cap.captest.json'))); assert.ok(!existsSync(join(t.stateDir, 'manager-context-cap.json')));
  assert.equal(t.actions()[0].session, 'captest');
  const bad = capEnv(); await run(bad.opts({ argv: ['--session', 'a b;rm'] })); assert.equal(bad.calls.length, 0);
});

// ---- manager-fresh.sh: the parameters the cap uses ----------------------------------------------------------------------
function freshRun({ env = {}, state = 'done', pane = 'bypass permissions on\n' } = {}) {
  const dir = tmp('cap-fresh-'); const bin = join(dir, 'bin'), home = join(dir, 'home'); mkdirSync(bin); mkdirSync(home);
  const fake = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = process.env.FAKE_DIR; const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2);
let stdin = ''; if (args.includes('@-')) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify([cmd, ...args, ...(stdin ? [stdin] : [])]) + '\\n');
if (cmd === 'curl' && !args.includes('POST')) process.stdout.write(JSON.stringify({ status: { [process.env.FAKE_SESSION]: { state: process.env.FAKE_STATE, stall: {} } } }));
if (cmd === 'tmux' && args[0] === 'display') console.log('4242');
if (cmd === 'tmux' && args[0] === 'capture-pane') process.stdout.write(process.env.FAKE_PANE || '');
if (cmd === 'ps') { console.log('claude'); process.exit(0); }
if (cmd === 'pgrep') {
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
  if (calls.some(([c, ...a]) => c === 'tmux' && a.includes('-l'))) { console.log('4243'); process.exit(0); }
  process.exit(1);
}
`;
  for (const c of ['tmux', 'curl', 'pgrep', 'ps', 'sleep', 'git', 'claude']) writeFileSync(join(bin, c), fake, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [resolve('scripts/manager-fresh.sh')], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8', FAKE_DIR: dir, FAKE_PANE: pane, FAKE_STATE: state, FAKE_SESSION: env.MANAGER_FRESH_SESSION || 'manager', GHOSTY_URL: 'http://localhost:1', ...env },
    encoding: 'utf8', timeout: 60000,
  });
  assert.ifError(r.error);
  let calls = []; try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch { /* none */ }
  return { ...r, calls, home, sent: calls.filter(([c, ...a]) => c === 'curl' && a.includes('@-')).map((c) => JSON.parse(c.at(-1)).keys) };
}

test('manager-fresh.sh: one idle try and a busy manager -> exit 3, no /exit, no launch, no sleep', () => {
  const r = freshRun({ state: 'working', env: { MANAGER_FRESH_WAIT_TRIES: '1' } });
  assert.equal(r.status, 3, r.stderr); assert.match(r.stdout, /never idle, not restarted/);
  assert.ok(!r.calls.some(([c, ...a]) => c === 'curl' && a.includes('POST')), 'no /exit sent');
  assert.ok(!r.calls.some(([c, ...a]) => c === 'tmux' && a.includes('-l')), 'nothing typed');
  assert.ok(!r.calls.some(([c, a]) => c === 'sleep' && a === '30'), 'one try does not wait 30 s');
});

test('manager-fresh.sh: the cap reason is named in the kickoff, which still points at the open items; the restart is stamped', () => {
  const r = freshRun({ env: { MANAGER_FRESH_WAIT_TRIES: '1', MANAGER_FRESH_REASON: 'context cap restart: the context reached 512k, over the 300k cap' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /^Fresh start of the AI manager \(context cap restart: the context reached 512k, over the 300k cap, short context on purpose\)/);
  assert.match(r.sent[0], /open items in manager-actions\.jsonl \/ manager-asks\.jsonl/);
  assert.match(readFileSync(join(r.home, '.local/state/ghosty/manager-fresh.last'), 'utf8'), /^\d{13}\n$/);
  assert.match(freshRun({}).sent[0], /^Fresh start of the AI manager \(nightly restart, short context on purpose\)/);
});

test('manager-fresh.sh: another session gets its own name, kickoff and stamp, and never the manager\'s', () => {
  const r = freshRun({ env: { MANAGER_FRESH_SESSION: 'captest', MANAGER_FRESH_KICK: 'Reply with the one word ok.' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.sent, ['Reply with the one word ok.']);
  assert.ok(r.calls.some(([c, ...a]) => c === 'curl' && a.some((x) => x.endsWith('/api/send/captest'))));
  assert.ok(!r.calls.some((c) => c.some((x) => /=manager\b|\/api\/send\/manager/.test(String(x)))), 'the manager session is never addressed');
  const typed = r.calls.find(([c, ...a]) => c === 'tmux' && a.includes('-l')).at(-1);
  assert.match(typed, /--remote-control captest -n captest$/);
  assert.ok(existsSync(join(r.home, '.local/state/ghosty/manager-fresh.captest.last')));
  assert.equal(freshRun({ env: { MANAGER_FRESH_SESSION: 'a b' } }).status, 1);
  assert.match(managerCommand({}), /--remote-control manager -n manager$/);
});

test('manager-watch.sh runs the context cap after its own checks and never nudges a manager it just restarted', () => {
  const src = readFileSync(resolve('scripts/manager-watch.sh'), 'utf8');
  const cap = src.indexOf('manager-context-cap.js'), working = src.indexOf('[ "$st" = working ] && exit 0'), nudge = src.indexOf('age=$(( now - last ))');
  assert.ok(working > 0 && cap > working && cap < nudge);
  assert.match(src, /manager-context-cap\.js" --dry-run/);
  assert.match(src, /\*"manager-context-cap: restarted "\*\) exit 0/);
});
