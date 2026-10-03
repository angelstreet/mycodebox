import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byPriority, prioRank, DEFAULT_PRIORITY } from '../public/prio.js';
import { createSessionMeta } from '../session-meta.js';
import { readClaude, createQuotaAlerts } from '../quota.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-p5-'));

// ---- priority ----
test('priority: default P2, sorts P0 first, unknown value counts as P2', () => {
  assert.equal(DEFAULT_PRIORITY, 'P2');
  const names = [['a', 'P2'], ['b', 'P0'], ['c', 'P1'], ['d', undefined], ['e', 'P0']];
  const sorted = [...names].sort((x, y) => byPriority(x[1], y[1]) || x[0].localeCompare(y[0])).map((x) => x[0]);
  assert.deepEqual(sorted, ['b', 'e', 'c', 'a', 'd']);
  assert.equal(prioRank('P9'), prioRank('P2'));
});

test('priority: new session is P2, persists across a restart, bad values rejected', () => {
  const file = join(dir, 'prio', 'sessions.json');
  const m = createSessionMeta({ file });
  m.sync(['s1']);
  assert.equal(m.priority('s1'), 'P2');
  assert.deepEqual(m.set('s1', { priority: 'P0' }), { priority: 'P0' });
  assert.deepEqual(m.set('s1', { priority: 'P0' }), {});   // unchanged: nothing reported
  assert.throws(() => m.set('s1', { priority: 'P3' }), /P0, P1 or P2/);
  assert.throws(() => m.set('s1', {}), /required/);
  const again = createSessionMeta({ file });                  // "restart"
  assert.equal(again.priority('s1'), 'P0');
  assert.equal(again.priority('never-seen'), 'P2');
});

test('priority: entries of sessions gone for more than 7 days are dropped', () => {
  const file = join(dir, 'prune', 'sessions.json');
  let t = 1e12;
  const m = createSessionMeta({ file, now: () => t });
  m.sync(['keep', 'gone']);
  m.set('gone', { priority: 'P1' });
  t += 6 * 86400e3; m.sync(['keep']);
  assert.ok('gone' in m.snapshot());                          // 6 days: still remembered
  t += 2 * 86400e3; m.sync(['keep']);
  assert.ok(!('gone' in m.snapshot()));
  assert.ok('keep' in JSON.parse(readFileSync(file, 'utf8')));
});

// ---- pause / resume ----
const gdir = mkdtempSync(join(tmpdir(), 'ghosty-p5mgr-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: gdir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const mgr = await import('../manager.js');
const meta = createSessionMeta({ file: join(gdir, 'sessions.json') });
const keys = [], texts = [];
// Same wiring as server.js setSessionMeta (that function lives in the server module, which starts listening on import).
const sendKey = async (s, k) => { keys.push([s, k]); };
const sendKeys = async (s, t, enter) => { texts.push([s, t, enter]); };
await mgr.initManager({ onOwnerNeeded: () => {}, sendKey, sendKeys, paused: (n) => meta.isPaused(n) });
await mgr.setManagerConfig({ enabled: true, autoSend: true, autoCases: ['continue', 'menu_recommended'], minConfidence: 0.8, delayMs: 150, maxPerSessionPerHour: 4 });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => mgr.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTINUE = 'Step 1 is done.\nShall I continue with step 2?';
const records = () => (existsSync(mgr.LOG_FILE) ? readFileSync(mgr.LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
async function stall(name) { tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(CONTINUE), 1000); tick(name, 'done', pane(CONTINUE), 2500); await sleep(40); }
const pause = async (n) => { meta.sync([n]); if (meta.set(n, { paused: true }).paused) { mgr.cancelAuto(n, 'paused by owner'); await mgr.logEvent({ type: 'pause', session: n, by: 'owner' }); await sendKey(n, 'Escape'); } };
const resume = async (n) => { if (meta.set(n, { paused: false }).paused === false) { await mgr.logEvent({ type: 'resume', session: n, by: 'owner' }); await sendKeys(n, 'continue', true); } };

test('pause: a session paused before the stall is never auto-answered', async () => {
  meta.sync(['pz1']);
  await pause('pz1');
  assert.deepEqual(keys.filter((k) => k[0] === 'pz1'), [['pz1', 'Escape']]);
  await stall('pz1');
  assert.equal(mgr.autoOf('pz1'), null);
  await sleep(300);
  assert.equal(texts.filter((t) => t[0] === 'pz1').length, 0);
});

test('pause: cancels a pending auto answer and nothing is typed afterwards', async () => {
  meta.sync(['pz2']);
  await stall('pz2');
  assert.ok(mgr.autoOf('pz2'), 'an answer is pending before the pause');
  await pause('pz2');
  assert.equal(mgr.autoOf('pz2'), null);
  await sleep(350);
  assert.equal(texts.filter((t) => t[0] === 'pz2').length, 0);
  assert.ok(records().some((r) => r.type === 'answer_cancelled' && r.session === 'pz2' && /paused/.test(r.reason)));
});

test('pause: a timer that fires after the hold was set is blocked at fire time', async () => {
  meta.sync(['pz3']);
  await stall('pz3');
  assert.ok(mgr.autoOf('pz3'));
  meta.set('pz3', { paused: true });   // hold set without the cancel call: fire() must still refuse
  await sleep(350);
  assert.equal(texts.filter((t) => t[0] === 'pz3').length, 0);
  assert.ok(records().some((r) => r.type === 'answer_cancelled' && r.session === 'pz3' && /paused/.test(r.reason)));
});

test('resume: sends "continue" + Enter, clears the hold, logs pause and resume', async () => {
  await resume('pz1');
  assert.deepEqual(texts.filter((t) => t[0] === 'pz1'), [['pz1', 'continue', true]]);
  assert.equal(meta.isPaused('pz1'), false);
  const ev = records().filter((r) => (r.type === 'pause' || r.type === 'resume') && r.session === 'pz1');
  assert.deepEqual(ev.map((r) => [r.type, r.by]), [['pause', 'owner'], ['resume', 'owner']]);
  await resume('pz1');   // not paused any more: nothing more is typed
  assert.equal(texts.filter((t) => t[0] === 'pz1').length, 1);
});

test('pause persists across a restart', () => {
  const again = createSessionMeta({ file: join(gdir, 'sessions.json') });
  assert.equal(again.isPaused('pz2'), true);
  assert.equal(again.isPaused('pz1'), false);
});

// ---- quota ----
test('claude: reads the status-line hook file; missing file says how to enable it', async () => {
  const f = join(dir, 'claude-rate-limits.json');
  const now = Date.now();
  writeFileSync(f, JSON.stringify({ at: now, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: Math.floor(now / 1000) + 3600 }, seven_day: { used_percentage: 41.2, resets_at: Math.floor(now / 1000) + 86400 } } }));
  const c = await readClaude({ claudeFile: f }, now);
  assert.deepEqual(c.windows.map((w) => [w.name, w.usedPercent]), [['5h', 23.5], ['week', 41.2]]);
  assert.equal(c.stale, false);
  const miss = await readClaude({ claudeFile: join(dir, 'absent.json') }, now);
  assert.deepEqual(miss.windows, []);
  assert.match(miss.note, /claude-statusline-ratelimits/);
});

test('quota alert: fires once at 80 %, stays quiet while high, re-arms under 70 %', () => {
  const calls = [];
  const qa = createQuotaAlerts((key, body, debounce) => calls.push([key, body.title, debounce]));
  const plans = (pct) => [{ plan: 'codex', label: 'Codex', windows: [{ name: '5h', usedPercent: pct, resetsAt: 1791100000 }] }];
  qa.check(plans(10));                       // seeds
  qa.check(plans(79.9)); assert.equal(calls.length, 0);
  qa.check(plans(80));   assert.equal(calls.length, 1);
  assert.match(calls[0][1], /Codex 5h quota at 80%/);
  assert.equal(calls[0][2], 0);              // no debounce swallowing the edge
  qa.check(plans(95)); qa.check(plans(85)); assert.equal(calls.length, 1);
  qa.check(plans(75));                       // between 70 and 80: still disarmed
  qa.check(plans(82));   assert.equal(calls.length, 1);
  qa.check(plans(69));                       // back under 70: re-armed
  qa.check(plans(81));   assert.equal(calls.length, 2);
});

test('quota alert: a window already high at start is not announced; null percent is ignored', () => {
  const calls = [];
  const qa = createQuotaAlerts((k) => calls.push(k));
  qa.check([{ plan: 'codex', label: 'C', windows: [{ name: '5h', usedPercent: 90 }] }, { plan: 'minimax', label: 'M', windows: [{ name: '5h', usedPercent: null }] }]);
  qa.check([{ plan: 'codex', label: 'C', windows: [{ name: '5h', usedPercent: 91 }] }]);
  assert.equal(calls.length, 0);
});
