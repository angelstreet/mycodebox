// The VPT server's JEV_ENABLED=false: every Jev use treats the 'disabled' reply as "Jev off", not an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevSwitch, isDisabledReply } from '../jev-switch.js';
import { runShadow } from '../router-shadow.js';
import { createWakeAnnotator, wakeFacts } from '../wake-shadow.js';

const OFF = { success: false, error: 'jev_disabled', disabled: true, answers: {}, decision_id: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('switch: disabled reply caches for 5 minutes, one probe, any good reply clears it', () => {
  let t = 1000;
  const sw = createJevSwitch({ now: () => t });
  assert.equal(sw.off(), false);
  assert.equal(sw.seen(OFF), true);
  assert.equal(sw.off(), true);
  t += 4 * 60 * 1000; assert.equal(sw.off(), true);
  t += 61 * 1000; assert.equal(sw.off(), false, 'probe again after 5 minutes');
  sw.seen({ error: 'jev_disabled' }); assert.equal(sw.off(), true);
  sw.seen({ success: true }); assert.equal(sw.off(), false);
  assert.equal(isDisabledReply({ success: false, error: 'boom' }), false);
  assert.equal(isDisabledReply(null), false);
});

test('router shadow: disabled is skipped, not an error', async () => {
  const r = await runShadow({ facts: { session: 's', agent: 'claude', excerpt: 'x', stallId: 'a', ruleCase: 'done' }, usage: 'u', teamId: 't', post: async () => ({ r: { status: 200 }, j: OFF }) });
  assert.deepEqual(r, { skipped: 'jev_disabled' });
});

test('wake annotator: skipped jev_disabled, no onError (no 402 cool-down), rule default kept', async () => {
  const errors = [];
  const a = createWakeAnnotator({ call: async () => OFF, onError: (k) => errors.push(k) });
  const cls = { kind: 'asks', session: 'web' };
  const out = await a(wakeFacts({ cls, event: { key: 'web:asks', title: 'x', body: 'b', priority: 'high' }, priority: 'P1', stall: { case: 'owner_decision' } }));
  assert.equal(out.skipped, 'jev_disabled');
  assert.ok(out.ruleDefault);
  assert.equal(out.error, undefined);
  assert.deepEqual(errors, []);
});

// ---- manager end to end against a mock server that answers disabled ----
let calls = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/server/ai/decide')) { calls++; return res.end(JSON.stringify(OFF)); }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
test.after(() => srv.closeAllConnections?.() || srv.close());
const dir = mkdtempSync(join(tmpdir(), 'ghosty-jevoff-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', VPT_TEAM_ID: 'team-x', JEV_API_KEY: 'k', JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide` });
const m = await import('../manager.js');
await m.initManager({ onOwnerNeeded: () => {}, sendKey: async () => {}, sendKeys: async () => {} });
await m.setManagerConfig({ aiTriage: 'off', autoSend: false, delayMs: 0, routerShadow: true });
const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
async function until(pred, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await sleep(20); } throw new Error('timed out'); }
async function stop(name, text) {
  const t0 = Date.now(); tick(name, 'working', ['busy'], t0);
  const p = pane(text); tick(name, 'done', p, t0 + 1000); tick(name, 'done', p, t0 + 2500); tick(name, 'done', p, t0 + 3500);
  return until((r) => r.type === 'stall' && r.session === name);
}

test('manager: disabled = skipped on the router record, no error, not counted, one probe in 5 minutes', async () => {
  const s1 = await stop('d1', 'All good.\nNext is the cleanup of the cache code.');   // ambiguous: asks Jev too
  const rr = await until((r) => r.type === 'router' && r.id === s1.id);
  assert.equal(rr.router.skipped, 'jev_disabled'); assert.equal(rr.router.error, undefined);
  assert.equal(s1.jev?.error, undefined);
  const afterFirst = calls;
  assert.ok(afterFirst >= 1 && afterFirst <= 2, `at most one probe per path, got ${afterFirst}`);
  const s2 = await stop('d2', 'Which database should we use?\nI need you to choose: Postgres or SQLite.');
  const r2 = await until((r) => r.type === 'router' && r.id === s2.id);
  assert.equal(r2.router.skipped, 'jev_disabled');
  assert.equal(calls, afterFirst, 'no further call while the answer is cached');
  const budgetFile = join(dir, 'jev-budget.json');
  assert.ok(!existsSync(budgetFile) || JSON.parse(readFileSync(budgetFile, 'utf8')).calls === 0, 'not counted against the Jev budget');
});

// ---- jev-ask ----
test('jev-ask: server disabled -> rule default, source rule, jev: disabled', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = await new Promise((resolve) => {
    const c = spawn('node', [join(here, '..', 'scripts', 'jev-ask.js'), 'stop', '--facts', JSON.stringify({ session: 's1', agent: 'claude', case: 'owner_decision' })], {
      env: { ...process.env, JEV_URL: `http://127.0.0.1:${srv.address().port}`, JEV_API_KEY: 'k', VPT_TEAM_ID: 't', GHOSTY_STATE_DIR: mkdtempSync(join(tmpdir(), 'ja-')) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = ''; c.stdout.on('data', (d) => (s += d)); c.on('close', (code) => resolve({ code, s }));
  });
  assert.equal(out.code, 0);
  const rec = JSON.parse(out.s.trim());
  assert.equal(rec.source, 'rule'); assert.equal(rec.jev, 'disabled'); assert.equal(rec.pick, rec.ruleDefault);
});
