import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock Jev (the VPT server's /server/ai/decide): always says "continue".
let jevCalls = 0;
const jev = http.createServer((req, res) => {
  jevCalls++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ success: true, cost: 0.00002, ms: 5, model: 'typesafe/jev-1.13',
    answers: { choice: { choice: 'continue', confidence: 0.9, probabilities: { continue: 0.95, take_recommended: 0.01, ask_owner: 0.04 } } } }));
});
await new Promise((r) => jev.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'ghosty-mgr-'));
Object.assign(process.env, {
  GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: `http://127.0.0.1:${jev.address().port}/server/ai/decide`,
  JEV_API_KEY: 'test', JEV_DAILY_USD: '0.00001',   // the first call spends it
});
const m = await import('../manager.js');
const pushes = [];
await m.initManager({ onOwnerNeeded: (s, st) => pushes.push([s, st.case]) });
await m.setManagerConfig({ aiTriage: 'off' });   // these tests are about the rules + Jev; the AI reviewer has its own tests (triage.test.js)

const RULE = '─'.repeat(40);
const pane = (body, prompt = '❯ ') => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, prompt, RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, ...extra });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);   // a line may be mid-write
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
// Log writes are async (Jev round trip, appendFile): wait for the record instead of a fixed sleep.
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = records().find(pred); if (r) return r; await settle(20); }
  throw new Error('timed out waiting for a log record');
}

test('a stall is logged once after it settles, then its outcome when work resumes', async () => {
  const p = pane('Phase 1 is done.\nShall I continue with phase 2?');
  tick('s1', 'working', ['busy'], 0);                 // seen before: later stalls count
  tick('s1', 'done', p, 1000);
  tick('s1', 'done', p, 1500);
  assert.equal(records().length, 0, 'not settled yet');
  tick('s1', 'done', p, 2100);
  tick('s1', 'done', p, 3000);
  await until((r) => r.type === 'stall' && r.session === 's1');
  const stalls = records().filter((r) => r.type === 'stall' && r.session === 's1');
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].case, 'continue');
  assert.deepEqual(stalls[0].wouldSend, { text: 'Yes, continue.' });
  assert.deepEqual(pushes.at(-1), ['s1', 'continue']);

  const after = [...p.slice(0, -4), '❯ yes', '⏺ Working on phase 2', '✶ Thinking…', RULE, '❯ ', RULE, 'x'];
  tick('s1', 'working', after, 9000);
  await until((r) => r.type === 'outcome' && r.session === 's1');
  const out = records().find((r) => r.type === 'outcome' && r.id === stalls[0].id);
  assert.equal(out.via, 'terminal');
  assert.equal(out.reply, 'yes');
  assert.equal(out.kind, 'continue');
});

test('ambiguous stall goes to Jev; the forbidden gate still wins', async () => {
  tick('s2', 'working', ['busy'], 0);
  const p = pane('Branch is ready.\nNext step: deploy it to the hosts.');
  tick('s2', 'done', p, 1000); tick('s2', 'done', p, 2500);
  await until((r) => r.type === 'stall' && r.session === 's2');
  const r = records().find((x) => x.type === 'stall' && x.session === 's2');
  assert.equal(r.source, 'jev');
  assert.equal(r.jev.choice, 'continue');
  assert.equal(r.wouldSend, null);
  assert.match(r.why, /forbidden: deploy/);
});

test('daily Jev budget stops calls', async () => {
  const before = jevCalls;
  tick('s3', 'working', ['busy'], 0);
  const p = pane('All good.\nNext is the cleanup of the cache code.');
  tick('s3', 'done', p, 1000); tick('s3', 'done', p, 2500);
  await until((r) => r.type === 'stall' && r.session === 's3');
  const r = records().find((x) => x.type === 'stall' && x.session === 's3');
  assert.equal(jevCalls, before);
  assert.equal(r.jev.skipped, 'daily budget reached');
  assert.equal(r.wouldSend, null, 'without Jev an ambiguous stall stays with the owner');
});

test('a disabled session is not logged; stalls present at startup are not logged', async () => {
  await m.setManagerConfig({ session: 's4', sessionEnabled: false });
  tick('s4', 'working', ['busy'], 0);
  const p = pane('Shall I continue?');
  tick('s4', 'done', p, 1000); tick('s4', 'done', p, 3000);
  tick('s5', 'done', p, 1000); tick('s5', 'done', p, 3000);   // first sight already stopped
  await settle();
  assert.equal(records().filter((x) => x.session === 's4' || x.session === 's5').length, 0);
  assert.deepEqual(m.managerConfig().disabledSessions, ['s4']);
});

test.after(() => jev.close());

test('logOwnerChoice: records the popup choice and validates required fields', async () => {
  // log a stall first so requireKnown passes
  tick('s1', 'working', ['busy'], 0);
  const p = pane('Shall I continue?');
  tick('s1', 'done', p, 1000); tick('s1', 'done', p, 3000);
  await settle();
  const stalls = records().filter((r) => r.type === 'stall');
  assert.ok(stalls.length >= 1);
  const id = stalls[0].id;
  // missing id -> 400
  await assert.rejects(() => m.logOwnerChoice({ session: 's1', owner: 'yes' }), /id required/);
  // missing owner -> 400
  await assert.rejects(() => m.logOwnerChoice({ id, session: 's1' }), /owner required/);
  // missing session -> 400
  await assert.rejects(() => m.logOwnerChoice({ id, owner: 'yes' }), /session required/);
  // happy path: records the choice
  const rec = await m.logOwnerChoice({
    id, session: 's1', kind: 'yesno', owner: 'yes', ai: 'yes', aiConfidence: 0.92,
    jev: 'continue', jevProbabilities: { continue: 0.7, take_recommended: 0.2, ask_owner: 0.1 },
    ownerText: 'Yes, continue with the API change',
  });
  assert.equal(rec.kind, 'yesno');
  assert.equal(rec.ownerText, undefined, 'ownerText is kept only for a Reply');
  assert.equal(rec.type, 'choice');
  assert.equal(rec.owner, 'yes');
  assert.equal(rec.ai, 'yes');
  assert.equal(rec.agreeAi, true);
  assert.equal(rec.jev, 'continue');
  assert.equal(rec.agreeJev, true);   // jev said continue, owner picked Yes
  // the record was appended to the log
  const all = records();
  const found = all.find((r) => r.type === 'choice' && r.id === id && r.session === 's1');
  assert.ok(found, 'choice record was appended to stalls.jsonl');
  assert.equal(found.ai, 'yes');
  assert.equal(found.agreeAi, true);
});

test('logOwnerChoice: ownerText is capped at 200 characters', async () => {
  tick('s1', 'working', ['busy'], 0);
  const p = pane('Shall I continue?');
  tick('s1', 'done', p, 1000); tick('s1', 'done', p, 3000);
  await settle();
  const id = records().find((r) => r.type === 'stall').id;
  const big = 'x'.repeat(500);
  const rec = await m.logOwnerChoice({ id, session: 's1', owner: 'reply', ownerText: big, ai: null });
  assert.ok(rec.ownerText.length <= 200);
});

test('logOwnerChoice: agreeAi null without an AI pick; agreeJev for ask_owner = not the AI highlight', async () => {
  const a = await m.logOwnerChoice({ id: 'x1', session: 's1', kind: 'menu', owner: 'o1', ai: null, jev: 'ask_owner' });
  assert.equal(a.agreeAi, null); assert.equal(a.ai, null); assert.equal(a.agreeJev, true);
  const b = await m.logOwnerChoice({ id: 'x2', session: 's1', kind: 'menu', owner: 'o2', ai: 'o2', jev: 'ask_owner' });
  assert.equal(b.agreeAi, true); assert.equal(b.agreeJev, false);
  const c = await m.logOwnerChoice({ id: 'x3', session: 's1', kind: 'yesno', owner: 'no', ai: 'yes', jev: null });
  assert.equal(c.agreeAi, false); assert.equal(c.agreeJev, null);
});
