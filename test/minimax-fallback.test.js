// Round 9 item 10: with no OpenRouter credit (or Jev down) the manager's AI triage and Jev-style choices go to MiniMax M3 via headless mcode.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFallbackDecider, parseChoice, parseExecOutput } from '../minimax-fallback.js';

const work = mkdtempSync(join(tmpdir(), 'fallback-'));
const LOG = join(work, 'calls.jsonl');
const FAKE = join(work, 'mcode');
// A fake `mcode`: logs its argv, then prints 0.6.5-shaped JSONL according to MCODE_FAKE_MODE.
writeFileSync(FAKE, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const mode = process.env.MCODE_FAKE_MODE || 'ok';
fs.appendFileSync(process.env.MCODE_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), mode, leaked: Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/.test(k)) }) + '\\n');
const prompt = args[args.length - 1];
const out = (o) => console.log(JSON.stringify(o));
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { out({ type: 'exec.failed', error: { message: 'plan usage limit reached' } }); process.exit(1); }
else {
  let text;
  if (mode === 'junk') text = 'I think you should continue.';
  else if (prompt.includes('Choices:')) text = JSON.stringify({ choice: mode === 'badchoice' ? 'nope' : 'ask_owner', confidence: 0.99, probabilities: { continue: 0.1, take_recommended: 0.1, ask_owner: 0.8 } });
  else text = JSON.stringify({ proposed_reply: 'Use Postgres.', reasoning: 'Already in the stack.', confidence: 0.9, owner_needed: false, owner_needed_why: '', options: [] });
  out({ type: 'exec.started', sessionId: 's1' });
  out({ type: 'item.completed', item: { type: 'agent_message', content: text } });
  out({ type: 'exec.completed', result: { type: 'exec.result', status: 'succeeded', output: text } });
}
`);
chmodSync(FAKE, 0o755);
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const decider = (mode, o = {}) => createFallbackDecider({ bin: FAKE, env: { PATH: process.env.PATH, HOME: work, MCODE_FAKE_MODE: mode, MCODE_FAKE_LOG: LOG, JEV_API_KEY: 'must-not-leak', OPENROUTER_TOKEN: 'x' }, ...o });   // leak-scan: allow (fake values)
const BODY = { state: '{"x":1}', questions: { choice: { type: 'choice', instructions: 'What next?', criteria: { continue: 'carry on', take_recommended: 'take it', ask_owner: 'owner decides' } } } };
const FACTS = { session: 's', agent: 'claude', project: 'p', priority: 'P2', state: 'done', case: 'owner_decision', source: 'rule', flags: [], text: 'Redis or Postgres for the cache?' };

test('parseExecOutput: 0.6.3 and 0.6.5 shapes, failures', () => {
  assert.equal(parseExecOutput('{"type":"item.completed","item":{"type":"agent_message","content":"hi"}}\n').text, 'hi');
  assert.equal(parseExecOutput('{"type":"exec.completed","result":"old"}\n').text, 'old');
  assert.equal(parseExecOutput('{"type":"exec.completed","result":{"status":"succeeded","output":"new"}}\n').text, 'new');
  assert.match(parseExecOutput('{"type":"exec.failed","error":{"message":"quota"}}\n').error, /quota/);
  assert.match(parseExecOutput('garbage\n').error, /no answer/);
});

test('parseChoice: only listed choices, probabilities normalised, confidence capped', () => {
  const keys = ['continue', 'take_recommended', 'ask_owner'];
  assert.equal(parseChoice('{"choice":"merge"}', keys), null);
  assert.equal(parseChoice('not json', keys), null);
  const a = parseChoice('```json\n{"choice":"continue","confidence":1,"probabilities":{"continue":3,"take_recommended":1,"ask_owner":0}}\n```', keys);
  assert.equal(a.choice, 'continue'); assert.ok(a.confidence <= 0.95); assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 0.2);
  const b = parseChoice('{"choice":"ask_owner","confidence":0.6}', keys);
  assert.equal(b.confidence, 0.6); assert.equal(b.probabilities.ask_owner, 0.6);
});

test('reviewer(): same prompt and parser, headless and sandboxed: smart permission, empty temp cwd, one step, 20 s, no secrets in the environment', async () => {
  const d = decider('ok');
  const r = await d.reviewer({ facts: FACTS });
  assert.equal(r.source, 'minimax-fallback'); assert.equal(r.cost, 0);
  assert.equal(r.ai.proposed_reply, 'Use Postgres.'); assert.equal(r.ai.owner_needed, false);
  const c = calls().at(-1);
  assert.ok(c.args.includes('exec'));
  assert.equal(c.args[c.args.indexOf('--permission') + 1], 'smart'); assert.ok(!c.args.includes('full'));
  assert.equal(c.args[c.args.indexOf('--max-steps') + 1], '1');
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'minimax/MiniMax-M3');
  assert.equal(c.args[c.args.indexOf('--timeout') + 1], '20s');
  assert.match(c.args.at(-1), /Redis or Postgres/);
  assert.match(c.args[c.args.indexOf('--system-prompt') + 1], /operations supervisor/);
  assert.deepEqual(c.cwdFiles, [], 'an empty directory');
  assert.ok(c.cwd.startsWith(tmpdir()) || c.cwd.startsWith('/tmp'), 'not the repo');
  assert.ok(!existsSync(c.args[c.args.indexOf('--cwd') + 1]), 'removed afterwards');
  assert.deepEqual(c.leaked, [], 'no key / token variables reach mcode');
  const bad = await decider('junk').reviewer({ facts: FACTS });
  assert.ok(bad.error && !bad.ai, 'an answer that is not JSON never becomes a proposal');
});

test('choice(): a Jev-shaped reply; an invalid choice, a failure and a hang are errors (the hang is killed at the timeout)', async () => {
  const ok = await decider('ok').choice(BODY);
  assert.equal(ok.success, true); assert.equal(ok.answers.choice.choice, 'ask_owner'); assert.ok(ok.answers.choice.confidence <= 0.95); assert.equal(ok.cost, 0); assert.equal(ok.source, 'minimax-fallback');
  assert.match((await decider('badchoice').choice(BODY)).error, /not a valid choice/);
  assert.match((await decider('fail').choice(BODY)).error, /plan usage limit/);
  assert.match((await decider('ok').choice({ state: 'x' })).error, /no choice/);
  const t0 = Date.now();
  const h = await decider('hang', { timeoutMs: 400 }).choice(BODY);
  assert.match(h.error, /timeout/); assert.ok(Date.now() - t0 < 3000);
  const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith('mcode-fallback-'));
  assert.deepEqual(leftover, [], 'temp dirs are cleaned up, also after a kill');
});

test('three failures in a row pause the fallback; a missing binary is an error, not a throw', async () => {
  const d = decider('fail');
  for (let i = 0; i < 3; i++) await d.choice(BODY);
  const n = calls().length;
  assert.match((await d.choice(BODY)).error, /paused/);
  assert.equal(calls().length, n, 'no process started while paused');
  const none = await createFallbackDecider({ bin: join(work, 'no-such-mcode'), env: { PATH: process.env.PATH } }).choice(BODY);
  assert.match(none.error, /cannot run mcode|ENOENT/);
});

// ---- the manager: credits down -> fallback; switch off; cap; a 402 found by the call itself ----
let primary = 0, primaryMode = 'ok';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    primary += 1;
    res.setHeader('content-type', 'application/json');
    if (primaryMode === '402') return res.end(JSON.stringify({ success: false, error: 'OpenRouter 402: insufficient credits' }));
    if (req.url === '/server/ai/complete') return res.end(JSON.stringify({ success: true, content: JSON.stringify({ proposed_reply: 'primary', reasoning: 'r', confidence: 0.9, owner_needed: false }), usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    res.end(JSON.stringify({ success: true, cost: 0, ms: 1, answers: { choice: { choice: 'continue', confidence: 0.9, probabilities: { continue: 0.9, take_recommended: 0.05, ask_owner: 0.05 } } } }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const dir = mkdtempSync(join(tmpdir(), 'ghosty-fb-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide`, JEV_API_KEY: 'test-key' });
const m = await import('../manager.js');
let balance = 0;
await m.initManager({ onOwnerNeeded: () => {}, credits: () => ({ ok: true, balance }) });
m.setFallbackDecider(decider('ok'));
await m.setManagerConfig({ aiTriage: 'simulate', autoSend: false, routerShadow: false, wakeShadow: false });
test.after(() => srv.close());

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
async function stall(name, text, type = null) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(text), 1000); tick(name, 'done', pane(text), 2500);
  for (let i = 0; i < 120 && !records().some((r) => r.session === name && (type ? r.type === type : r.type === 'triage' || r.type === 'escalated')); i++) await sleep(25);
  await sleep(40);
}
const ASK = 'Design is ready.\nDo you want Redis or Postgres for the cache?';
const AMBIG = 'All good.\nNext is the cleanup of the cache code.';

test('no OpenRouter credit: the AI triage is read by MiniMax (source minimax-fallback), nothing is sent to the primary, and it is journalled', async () => {
  const before = primary, c0 = calls().length;
  await stall('fb1', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb1');
  assert.ok(t, 'a triage record'); assert.equal(t.source, 'minimax-fallback'); assert.equal(t.ai.proposed_reply, 'Use Postgres.'); assert.equal(t.cost, 0);
  assert.equal(primary, before, 'the primary was not called');
  assert.equal(calls().length, c0 + 1);
  const f = records().find((r) => r.type === 'fallback' && r.session === 'fb1');
  assert.equal(f.source, 'minimax-fallback'); assert.equal(f.for, 'triage'); assert.equal(f.ok, true); assert.equal(f.cap, 300);
});

test('no OpenRouter credit: an ambiguous stop is decided by the fallback (Jev-style choice) instead of skipped', async () => {
  await stall('fb2', AMBIG, 'stall');
  const s = records().find((r) => r.type === 'stall' && r.session === 'fb2');
  assert.equal(s.jev.choice, 'ask_owner'); assert.equal(s.jev.source, 'minimax-fallback');
  assert.ok(records().some((r) => r.type === 'fallback' && r.for === 'jev' && r.session === 'fb2'));
});

test('aiFallback "off" restores the old behaviour: skipped, no mcode process', async () => {
  await m.setManagerConfig({ aiFallback: 'off' });
  const c0 = calls().length;
  await stall('fb3', AMBIG, 'stall');
  const s = records().find((r) => r.type === 'stall' && r.session === 'fb3');
  assert.match(s.jev.skipped, /credit used up/);
  assert.equal(calls().length, c0);
  await assert.rejects(() => m.setManagerConfig({ aiFallback: 'gpt' }), /aiFallback must be/);
  await m.setManagerConfig({ aiFallback: 'minimax' });
});

test('the daily cap stops fallback calls', async () => {
  await m.setManagerConfig({ aiFallbackDailyCalls: 0 });
  const c0 = calls().length;
  await stall('fb4', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb4');
  assert.match(t.skipped, /daily cap/);
  assert.equal(calls().length, c0);
  await m.setManagerConfig({ aiFallbackDailyCalls: 300 });
});

test('credit is back: the primary is used again; a 402 found by the reviewer call itself still gets the stop read by the fallback', async () => {
  balance = 5; m.resetJevCooldown();
  const before = primary;
  await stall('fb5', ASK);
  assert.ok(primary > before, 'primary called');
  assert.equal(records().find((r) => r.type === 'triage' && r.session === 'fb5').ai.proposed_reply, 'primary');
  primaryMode = '402';
  await stall('fb6', ASK);
  const t = records().find((r) => r.type === 'triage' && r.session === 'fb6');
  assert.equal(t.source, 'minimax-fallback'); assert.equal(t.ai.proposed_reply, 'Use Postgres.');
  primaryMode = 'ok'; m.resetJevCooldown();
});
